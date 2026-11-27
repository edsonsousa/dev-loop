"use strict";
// dev-loop UI: one page, tabs by #hash. Live data arrives by server-sent events; the rest by JSON from /api.

const ROLES = ["implementer", "gate-fix", "reviewer", "critic", "security", "refiner"];
const CONTEXT_CAP = 300000;
const MIN_N = 3; // below this many runs a group shows its value, never a trend or a delta
let live = { runs: [] };
const view = document.getElementById("view");

// ---------- helpers ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (v) => (v == null ? "–" : "$" + Number(v).toFixed(2));
const num = (v, d = 0) => (v == null ? "–" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: d }));
const pct = (v) => (v == null ? "–" : num(v) + "%");
const kTok = (v) => (v == null ? "–" : v >= 1e6 ? num(v / 1e6, 1) + "M" : num(v / 1000) + "k");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const roleColor = (r) => css(`--role-${r}`) || css("--axis");
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
function dur(sec) {
  if (sec == null || isNaN(sec)) return "–";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}` : m ? `${m}m${String(s).padStart(2, "0")}` : `${s}s`;
}
const ago = (iso) => (iso ? dur((Date.now() - ms(iso)) / 1000) : "–");
const day = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "–");
const status = (s, text) => `<span class="status ${esc(s)}">${esc(text ?? s)}</span>`;
const role = (r) => `<span class="role" style="--c:${roleColor(r)}">${esc(r)}</span>`;
const model = (m) => esc((m || "").replace(/^claude-/, ""));
const LABEL = { running: "rodando", approved: "aprovada", escalated: "escalada", done: "terminou", stale: "parado", stopped: "interrompido",
  "no record": "sem registro", approve: "approve", changes: "changes" };

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
function query() {
  const f = new FormData(document.getElementById("filters"));
  return new URLSearchParams([...f].filter(([, v]) => v)).toString();
}
function table(cols, rows, link) {
  if (!rows.length) return `<p class="empty">Nada para mostrar com esses filtros.</p>`;
  const head = cols.map((c) => `<th class="${c.n ? "n" : ""}">${esc(c.label)}</th>`).join("");
  const body = rows.map((r) => `<tr class="${link ? "link" : ""}" ${link ? `data-href="${esc(link(r))}"` : ""}>` +
    cols.map((c) => `<td class="${c.n ? "n" : ""}">${c.html ? c.html(r) : esc(c.f ? c.f(r[c.k], r) : r[c.k])}</td>`).join("") + "</tr>").join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
view.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-href]");
  if (tr && tr.dataset.href && !e.target.closest("a, input, button, summary")) location.hash = tr.dataset.href;
});

// ---------- charts (Vega-Lite, themed from the page's CSS) ----------
function theme() {
  const ink = css("--ink-2"), grid = css("--grid"), axis = css("--axis");
  return {
    background: null, font: "system-ui, -apple-system, Segoe UI, sans-serif",
    view: { stroke: null },
    axis: { labelColor: ink, titleColor: ink, gridColor: grid, domainColor: axis, tickColor: axis, labelFontSize: 11, titleFontWeight: 500 },
    legend: { labelColor: ink, titleColor: ink, orient: "top" },
    header: { labelColor: ink, titleColor: ink },
    bar: { cornerRadiusEnd: 4 }, line: { strokeWidth: 2 }, point: { size: 64, filled: true },
  };
}
const roleScale = () => ({ domain: ROLES, range: ROLES.map(roleColor) });
const outcomeScale = () => ({ domain: ["approved", "escalated"], range: [css("--good"), css("--serious")] });
function chart(id, spec) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!spec.data.values.length) { el.innerHTML = `<p class="empty">Sem dados.</p>`; return; }
  vegaEmbed(el, { $schema: "https://vega.github.io/schema/vega-lite/v6.json", ...(spec.facet ? {} : { width: "container" }), config: theme(), ...spec },
    { actions: false, renderer: "svg" }).catch((e) => (el.textContent = e.message));
}

// ---------- live ----------
function lanes(agents, start, end) {
  const span = Math.max(1, end - start);
  const rows = agents.map((a) => {
    const s = ms(a.started), e = a.status === "running" ? Date.now() : ms(a.last);
    const left = ((s - start) / span) * 100, width = Math.max(0.5, ((e - s) / span) * 100);
    return `<div class="lane"><span>${role(a.role)} <span class="muted">r${a.round}</span></span>
      <div class="bar-wrap"><div class="bar ${a.status}" style="--c:${roleColor(a.role)};left:${left}%;width:${width}%"
        title="${esc(a.role)} r${a.round}: ${dur((e - s) / 1000)}"></div></div></div>`;
  }).join("");
  return `<div class="lanes">${rows}</div><div class="axis"><span>${day(new Date(start).toISOString())}</span><span>${dur(span / 1000)}</span></div>`;
}
function ctx(a) {
  const p = Math.min(100, (a.context / CONTEXT_CAP) * 100);
  return `<span class="ctx ${p > 80 ? "hot" : ""}" title="${num(a.context)} de ${num(CONTEXT_CAP)} tokens"><span style="width:${p}%"></span></span> ${kTok(a.context)}`;
}
function liveRun(r, full) {
  const start = ms(r.started), end = r.status === "running" ? Date.now() : ms(r.last);
  const o = r.orchestrator?.last;
  const link = r.run_id ? `#/run/${r.run_id}` : `#/now/${encodeURIComponent(r.key)}`;
  const cols = [
    { label: "Papel", html: (a) => role(a.role) }, { label: "Rodada", k: "round", n: 1 },
    { label: "Modelo", html: (a) => model(a.model) }, { label: "Status", html: (a) => status(a.status, LABEL[a.status]) },
    { label: "Veredito", html: (a) => a.verdict ? status(a.verdict) + (a.blocking ? ` <span class="muted">${a.blocking} bloq.</span>` : "") : "" },
    { label: "Tempo", n: 1, f: (_, a) => dur(((a.status === "running" ? Date.now() : ms(a.last)) - ms(a.started)) / 1000) },
    { label: "Ferramentas", k: "tool_calls", n: 1 }, { label: "Contexto", html: ctx },
    { label: "Compact.", k: "compactions", n: 1 }, { label: "Custo", k: "usd", n: 1, f: usd },
    { label: "Agora", html: (a) => a.status === "running" && a.recent[0] ? `<code>${esc(a.recent[0].tool)}</code> ${esc(a.recent[0].target)}` : "" },
  ];
  const recent = full ? r.agents.filter((a) => a.recent.length).map((a) => `<details ${a.status === "running" ? "open" : ""}>
      <summary>${role(a.role)} r${a.round}: últimas ferramentas</summary>
      <ol class="recent">${a.recent.map((t) => `<li>${esc((t.at || "").slice(11, 19))} <b>${esc(t.tool)}</b> ${esc(t.target)}</li>`).join("")}</ol></details>`).join("") : "";
  return `<section class="card">
    <div class="run-head"><h3><a href="${link}">${esc(r.task || r.session)}</a></h3>
      <span class="muted">${esc(r.project)}</span>${status(r.status, LABEL[r.status])}
      <span>rodada ${r.round}</span><span>${dur((end - start) / 1000)}</span><span>${usd(r.usd)}</span>
      ${o ? `<span class="muted">orquestrador, há ${dur(r.orchestrator.quiet)}: <code>${esc(o.tool)}</code> ${esc(o.target)}</span>` : ""}</div>
    ${lanes(r.agents, start, end)}
    ${table(cols, r.agents)}${recent}</section>`;
}
function renderLive() {
  const running = live.runs.filter((r) => r.status === "running");
  const rest = live.runs.filter((r) => r.status !== "running");
  view.innerHTML = `<h1>Ao vivo</h1><p class="sub">Agentes do dev-loop das últimas 12 horas, em todas as sessões. Atualiza sozinho.</p>
    ${running.length ? running.map((r) => liveRun(r)).join("") : `<p class="card empty">Nenhuma tarefa rodando agora.</p>`}
    ${rest.length ? `<h2>Terminadas nas últimas 12 horas</h2>${rest.map((r) => liveRun(r)).join("")}` : ""}`;
}
function renderNow(key) {
  const r = live.runs.find((x) => x.key === key);
  view.innerHTML = r ? `<p><a href="#/live">← Ao vivo</a></p>${liveRun(r, true)}` : `<p class="empty">Esta tarefa saiu da janela ao vivo. <a href="#/runs">Ver tarefas</a></p>`;
}

// ---------- runs ----------
async function renderRuns() {
  const runs = await get("/api/runs?" + query());
  view.innerHTML = `<h1>Tarefas</h1><p class="sub">${runs.length} tarefas registradas. Clique numa para o detalhe.</p>
    <div class="card"><div id="c-runs" class="chart"></div></div>
    <div class="card">${table([
      { label: "Dia", k: "started", f: day }, { label: "Projeto", k: "project" },
      { label: "Tarefa", html: (r) => `<a href="#/run/${r.id}">${esc(r.task)}</a>` },
      { label: "Resultado", html: (r) => status(r.outcome, LABEL[r.outcome]) }, { label: "Rodadas", k: "rounds", n: 1 },
      { label: "Bloq.", k: "blocking", n: 1 }, { label: "Nits", k: "nits", n: 1 }, { label: "Gate falhou", k: "gate_failures", n: 1 },
      { label: "Minutos", k: "minutes", n: 1, f: (v) => num(v) }, { label: "Custo", k: "usd", n: 1, f: usd },
      { label: "Main depois", html: (r) => r.merged ? `${num(r.drift_lines)} linhas${r.post_merge_class ? " · " + esc(r.post_merge_class) : ""}` : `<span class="muted">não</span>` },
      { label: "Versão", k: "version" },
    ], runs, (r) => `#/run/${r.id}`)}</div>`;
  chart("c-runs", {
    title: { text: "Custo por tarefa", anchor: "start", color: css("--ink") }, height: 200,
    data: { values: runs.map((r) => ({ ...r, label: r.task })) },
    mark: { type: "bar", tooltip: true, width: { band: 0.6 }, maxBandSize: 48 },
    encoding: {
      x: { field: "label", type: "nominal", sort: { field: "started" }, title: null, axis: { labelAngle: -30 } },
      y: { field: "usd", type: "quantitative", title: "US$" },
      color: { field: "outcome", type: "nominal", scale: outcomeScale(), title: "Resultado" },
      tooltip: [{ field: "task" }, { field: "usd", format: "$.2f" }, { field: "rounds" }, { field: "outcome" }],
    },
  });
}

async function renderRun(id) {
  const d = await get(`/api/run/${id}`);
  const r = d.run, blocking = d.findings.filter((f) => f.blocking), nits = d.findings.filter((f) => !f.blocking);
  const lv = live.runs.find((x) => x.run_id === r.id);
  const files = JSON.parse(r.files || "[]"), sensitive = JSON.parse(r.sensitive || "[]");
  view.innerHTML = `<p><a href="#/runs">← Tarefas</a>${lv ? ` · <a href="#/now/${encodeURIComponent(lv.key)}">ao vivo</a>` : ""}</p>
    <h1>${esc(r.task)}</h1><p class="sub">${esc(r.title || "")} · ${esc(r.project)} · ${esc(r.branch || "")} · versão ${esc(r.version || "–")}</p>
    <div class="tiles">
      <div class="tile"><div class="k">Resultado</div><div class="v">${status(r.outcome, LABEL[r.outcome])}</div><div class="d">${esc(r.escalation || "")}</div></div>
      <div class="tile"><div class="k">Rodadas</div><div class="v">${num(r.rounds)}</div></div>
      <div class="tile"><div class="k">Custo estimado</div><div class="v">${usd(r.usd)}</div><div class="d">${kTok(r.tokens)} tokens</div></div>
      <div class="tile"><div class="k">Duração</div><div class="v">${dur(r.minutes * 60)}</div><div class="d">${day(r.started)}</div></div>
      <div class="tile"><div class="k">Bloqueantes / nits</div><div class="v">${blocking.length} / ${nits.length}</div>${blocking.some((f) => f.evidence != null) ? `<div class="d">${r.with_evidence} com evidência</div>` : ""}</div>
      <div class="tile"><div class="k">Mutação</div><div class="v">${r.mutation_score == null ? "–" : pct(r.mutation_score)}</div><div class="d">${r.mutation_survived ?? "–"} sobreviventes</div></div>
    </div>
    <div class="card"><div id="c-timeline" class="chart"></div></div>
    <div class="grid"><div class="card"><div id="c-rolecost" class="chart"></div></div>
      <div class="card"><h2 style="margin-top:0">Gates</h2>${table([
        { label: "Rodada", k: "round", n: 1 }, { label: "Comando", html: (g) => `<code>${esc(g.command)}</code>` },
        { label: "Resultado", html: (g) => status(g.passed ? "approved" : "escalated", g.passed ? "passou" : "falhou") },
        { label: "Segundos", k: "seconds", n: 1, f: (v) => num(v) }], d.gates)}</div></div>
    <div class="card"><h2 style="margin-top:0">Achados bloqueantes</h2>${table([
      { label: "Id", k: "finding_id" }, { label: "Papel", html: (f) => role(f.role) }, { label: "Rodada", k: "round", n: 1 },
      { label: "Desfecho", k: "outcome" }, { label: "Duplicata de", k: "duplicate_of" },
      { label: "Onde", html: (f) => f.file ? `<code>${esc(f.file)}${f.line ? ":" + f.line : ""}</code>` : "" },
      { label: "Problema", html: (f) => esc(f.issue) + (f.evidence ? `<details><summary>evidência</summary><div class="evidence">${esc(f.evidence)}</div></details>` : "") },
    ], blocking)}
    <details><summary>${nits.length} nits</summary>${table([{ label: "Id", k: "finding_id" }, { label: "Papel", html: (f) => role(f.role) }, { label: "Nit", k: "issue" }], nits)}</details></div>
    ${d.incidents.length ? `<div class="card"><h2 style="margin-top:0">Incidentes</h2>${table([
      { label: "Rodada", k: "round", n: 1 }, { label: "Papel", html: (i) => role(i.role) }, { label: "Tipo", k: "kind" },
      { label: "Detalhe", k: "detail" }, { label: "Ação", k: "action" }, { label: "Quando", html: (i) => esc((i.at || "").slice(11, 16)) },
    ], d.incidents)}</div>` : ""}
    <div class="card"><h2 style="margin-top:0">Agentes</h2>${agentTable(d.agents)}</div>
    <div class="card"><h2 style="margin-top:0">Depois da aprovação</h2>${postMerge(d.post_merge, r)}
      <details><summary>${files.length} arquivos${sensitive.length ? `, ${sensitive.length} sensíveis` : ""}</summary>
      <ul>${files.map((f) => `<li><code>${esc(f)}</code>${sensitive.includes(f) ? " · sensível" : ""}</li>`).join("")}</ul></details></div>`;
  chart("c-timeline", {
    title: { text: "Linha do tempo dos agentes", anchor: "start", color: css("--ink") },
    height: { step: 22 }, data: { values: d.agents.map((a) => ({ ...a, lane: `r${a.round} ${a.role}` })) },
    mark: { type: "bar", tooltip: true, cornerRadius: 4, height: 14 },
    encoding: {
      y: { field: "lane", type: "nominal", sort: { field: "started" }, title: null },
      x: { field: "started", type: "temporal", title: null, axis: { format: "%H:%M" } }, x2: { field: "ended" },
      color: { field: "role", type: "nominal", scale: roleScale(), title: "Papel" },
      tooltip: [{ field: "role" }, { field: "round" }, { field: "model" }, { field: "seconds", title: "segundos" }, { field: "usd", format: "$.2f" }],
    },
  });
  chart("c-rolecost", {
    title: { text: "Custo por papel", anchor: "start", color: css("--ink") }, height: { step: 24 },
    data: { values: Object.values(d.agents.reduce((m, a) => ((m[a.role] ??= { role: a.role, usd: 0 }).usd += a.usd || 0, m), {})) },
    mark: { type: "bar", tooltip: true },
    encoding: { y: { field: "role", type: "nominal", sort: "-x", title: null }, x: { field: "usd", type: "quantitative", title: "US$" },
      color: { field: "role", scale: roleScale(), legend: null }, tooltip: [{ field: "role" }, { field: "usd", format: "$.2f" }] },
  });
}
function postMerge(pm, r) {
  if (!pm) return `<p class="muted">Sem snapshot para comparar.</p>`;
  if (!pm.merged) return `<p class="muted">Os arquivos desta tarefa ainda não mudaram na ${esc(r.main_branch)} depois da base.</p>`;
  const commits = JSON.parse(pm.commits || "[]");
  return `<p>${num(pm.drift_files)} arquivos e ${num(pm.drift_lines)} linhas diferem entre o que o loop deixou e a ${esc(r.main_branch)}.
    ${pm.class ? `Classificado pela retro como <b>${esc(pm.class)}</b>: ${esc(pm.note)}` : `<span class="muted">A /dev-loop:retro ainda não classificou.</span>`}</p>
    <ul>${commits.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ul>`;
}
function agentTable(rows, withRun) {
  return table([
    ...(withRun ? [{ label: "Dia", k: "started", f: day }, { label: "Tarefa", html: (a) => a.run_id ? `<a href="#/run/${a.run_id}">${esc(a.task)}</a>` : `<span class="muted">${esc(a.task || "?")} (sem registro)</span>` }] : []),
    { label: "Rodada", k: "round", n: 1 }, { label: "Papel", html: (a) => role(a.role) }, { label: "Modelo", html: (a) => model(a.model) },
    { label: "Minutos", n: 1, f: (_, a) => num(a.minutes ?? a.seconds / 60, 1) }, { label: "Ferramentas", k: "tool_calls", n: 1 },
    { label: "Pico de contexto", n: 1, f: (_, a) => kTok(a.peak_context) }, { label: "Compact.", k: "compactions", n: 1 },
    { label: "Saída", n: 1, f: (_, a) => kTok(a.output) }, { label: "Custo", k: "usd", n: 1, f: usd },
  ], rows, withRun ? (a) => (a.run_id ? `#/run/${a.run_id}` : "") : null);
}

// ---------- quality ----------
const INDICATORS = [
  { k: "first_round", label: "Aprovada na 1ª rodada", f: pct, better: "up" },
  { k: "rounds", label: "Rodadas por tarefa", f: (v) => num(v, 2), better: "down" },
  { k: "escalated", label: "Escaladas", f: pct, better: "down" },
  { k: "escapes", label: "Escapes (bug ou design na main)", f: (v, g) => `${num(v)} / ${num(g.merged)}`, better: "down" },
  { k: "blocking_per_run", label: "Bloqueantes por tarefa", f: (v) => num(v, 1), better: null },
  { k: "duplicates", label: "Bloqueantes duplicados", f: pct, better: "down" },
  { k: "nits_per_run", label: "Nits por tarefa", f: (v) => num(v, 1), better: "down" },
  { k: "incidents_per_run", label: "Incidentes por tarefa", f: (v) => num(v, 1), better: "down" },
  { k: "gate_first_pass", label: "Gate passou na 1ª", f: pct, better: "up" },
  { k: "mutation", label: "Score de mutação", f: pct, better: "up" },
  { k: "weakening", label: "Enfraquecimentos por tarefa", f: (v) => num(v, 1), better: "down" },
  { k: "usd_per_approved", label: "US$ por tarefa aprovada", f: usd, better: "down" },
  { k: "minutes", label: "Minutos por tarefa", f: (v) => num(v), better: "down" },
];
// split groups: whole task, escalated with a split proposed, one slice of a split
const BY = { version: "versão do loop", week: "semana", split: "divisão (inteira · divisão proposta · fatia)" };
async function renderQuality(by) {
  by = ["week", "split"].includes(by) ? by : "version";
  const [q, filt] = await Promise.all([get(`/api/quality?by=${by}&` + query()), get("/api/filters")]);
  const g = q.groups, cur = g[g.length - 1], prev = g[g.length - 2];
  const tile = (ind) => {
    const v = cur?.[ind.k];
    let delta = `<span class="muted">n=${cur?.runs ?? 0}</span>`;
    if (cur && prev && cur.runs >= MIN_N && prev.runs >= MIN_N && v != null && prev[ind.k] != null && ind.k !== "escapes") {
      const diff = v - prev[ind.k], good = ind.better === "up" ? diff > 0 : ind.better === "down" && diff < 0;
      delta = `<span class="${good ? "up" : ""}">${diff >= 0 ? "▲" : "▼"} ${num(Math.abs(diff), 2)} vs ${esc(prev.grp)}</span> · n=${cur.runs}`;
    }
    return `<div class="tile"><div class="k">${esc(ind.label)}</div><div class="v">${v == null ? "–" : ind.f(v, cur)}</div><div class="d">${delta}</div></div>`;
  };
  const roles = q.roles.filter((r) => !cur || r.grp === cur.grp).map((r) => {
    const cost = q.role_cost.find((c) => c.grp === r.grp && c.role === r.role);
    const judged = r.fixed + r.false_positive;
    return { ...r, precision: judged ? (100 * r.fixed) / judged : null, usd: cost?.usd, per_fix: cost && r.fixed ? cost.usd / r.fixed : null };
  });
  view.innerHTML = `<h1>Qualidade</h1>
    <p class="sub">Indicadores por ${BY[by]}. Os blocos mostram o grupo mais recente (${esc(cur?.grp ?? "–")});
      a variação aparece só quando os dois grupos têm ${MIN_N} tarefas ou mais.
      Agrupar por <a href="#/quality/version">versão</a> · <a href="#/quality/week">semana</a> · <a href="#/quality/split">divisão</a></p>
    <div class="tiles">${INDICATORS.map(tile).join("")}</div>
    <div class="card"><div id="c-quality" class="chart"></div>
      <p class="note">Cada painel é um indicador; cada barra, um grupo. Grupos com menos de ${MIN_N} tarefas ficam claros.</p></div>
    <div class="card"><h2 style="margin-top:0">Papéis em ${esc(cur?.grp ?? "–")}</h2>
      <p class="note">Precisão: corrigidos ÷ (corrigidos + rejeições aceitas). Duplicatas e nits não contam como achados.</p>
      ${table([{ label: "Papel", html: (r) => role(r.role) }, { label: "Bloqueantes", k: "blocking", n: 1 }, { label: "Corrigidos", k: "fixed", n: 1 },
        { label: "Falsos positivos", k: "false_positive", n: 1 }, { label: "Duplicatas", k: "duplicate", n: 1 }, { label: "Nits", k: "nits", n: 1 },
        { label: "Precisão", k: "precision", n: 1, f: pct }, { label: "Custo", k: "usd", n: 1, f: usd }, { label: "US$ por correção", k: "per_fix", n: 1, f: usd }], roles)}</div>
    <div class="card"><h2 style="margin-top:0">Versões do loop</h2>
      <p class="note">A versão é um hash dos agentes e das skills. Dê um nome à versão de um experimento para compará-la com as outras.</p>
      ${table([{ label: "Versão", html: (v) => `<code>${esc(v.version)}</code>` }, { label: "Desde", k: "first_seen", f: day }, { label: "Tarefas", k: "runs", n: 1 },
        { label: "Nome", html: (v) => `<input class="label" data-version="${esc(v.version)}" value="${esc(v.label || "")}" placeholder="sem nome">` }], filt.versions)}</div>`;
  view.querySelectorAll("input.label").forEach((i) => i.addEventListener("change", async () => {
    await fetch("/api/label", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: i.dataset.version, label: i.value }) });
    loadFilters();
  }));
  const values = g.flatMap((grp) => INDICATORS.filter((i) => i.k !== "escapes" && grp[i.k] != null)
    .map((i) => ({ indicator: i.label, grp: grp.grp, since: grp.since, value: grp[i.k], runs: grp.runs, thin: grp.runs < MIN_N ? "menos de " + MIN_N : "ok" })));
  if (g.length < 2) {
    document.getElementById("c-quality").innerHTML = `<p class="empty">Os gráficos comparam grupos: aparecem quando houver 2 ou mais grupos com tarefas.</p>`;
    return;
  }
  chart("c-quality", {
    data: { values },
    facet: { field: "indicator", type: "nominal", title: null, header: { labelFontSize: 12, labelAnchor: "start" }, sort: INDICATORS.map((i) => i.label) },
    columns: 4, resolve: { scale: { y: "independent" }, axis: { x: "independent" } },
    spec: { width: 260, height: 90, mark: { type: "bar", tooltip: true, color: css("--accent"), width: { band: 0.6 } },
      encoding: { x: { field: "grp", type: "nominal", sort: { field: "since" }, title: null, axis: { labelAngle: 0, labelLimit: 120 } },
        y: { field: "value", type: "quantitative", title: null, axis: { format: ",.2~f", tickCount: 3 } },
        opacity: { field: "thin", type: "nominal", scale: { domain: ["ok", "menos de " + MIN_N], range: [1, 0.35] }, title: "Tarefas" },
        tooltip: [{ field: "indicator" }, { field: "grp", title: "grupo" }, { field: "value", format: ".2f" }, { field: "runs", title: "tarefas" }] } },
  });
}

// ---------- agents ----------
async function renderAgents() {
  const rows = await get("/api/agents?" + query());
  view.innerHTML = `<h1>Agentes</h1><p class="sub">${rows.length} agentes registrados.</p>
    <div class="grid"><div class="card"><div id="c-context" class="chart"></div></div><div class="card"><div id="c-minutes" class="chart"></div></div></div>
    <div class="card">${agentTable(rows, true)}</div>`;
  chart("c-context", {
    title: { text: "Pico de contexto por agente (compacta em 300k)", anchor: "start", color: css("--ink") }, height: { step: 28 },
    data: { values: rows },
    layer: [
      { mark: { type: "point", tooltip: true }, encoding: { y: { field: "role", type: "nominal", title: null },
        x: { field: "peak_context", type: "quantitative", title: "tokens", scale: { domain: [0, 320000] } },
        color: { field: "role", scale: roleScale(), legend: null },
        tooltip: [{ field: "task" }, { field: "role" }, { field: "round" }, { field: "peak_context", format: "," }, { field: "compactions" }] } },
      { mark: { type: "rule", color: css("--critical"), strokeDash: [4, 4] }, encoding: { x: { datum: 300000 } } },
    ],
  });
  chart("c-minutes", {
    title: { text: "Minutos por agente", anchor: "start", color: css("--ink") }, height: { step: 28 },
    data: { values: rows }, mark: { type: "tick", thickness: 3, tooltip: true },
    encoding: { y: { field: "role", type: "nominal", title: null }, x: { field: "minutes", type: "quantitative", title: "minutos" },
      color: { field: "role", scale: roleScale(), legend: null }, tooltip: [{ field: "task" }, { field: "role" }, { field: "round" }, { field: "minutes" }] },
  });
}

// ---------- routing, filters, stream ----------
async function loadFilters() {
  const f = await get("/api/filters"), form = document.getElementById("filters");
  const fill = (name, opts) => {
    const sel = form.elements[name], cur = sel.value;
    sel.innerHTML = sel.options[0].outerHTML + opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
    sel.value = cur;
  };
  fill("project", f.projects.map((p) => [p, p]));
  fill("version", f.versions.map((v) => [v.label || v.version, v.label ? `${v.label} (${v.version})` : v.version]));
}
async function route() {
  const [, tab = "live", arg] = location.hash.split("/");
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === (tab === "run" ? "runs" : tab === "now" ? "live" : tab)));
  document.getElementById("filters").style.visibility = tab === "live" || tab === "now" ? "hidden" : "visible";
  try {
    if (tab === "runs") await renderRuns();
    else if (tab === "run") await renderRun(Number(arg));
    else if (tab === "quality") await renderQuality(arg);
    else if (tab === "agents") await renderAgents();
    else if (tab === "now") renderNow(decodeURIComponent(arg || ""));
    else renderLive();
  } catch (e) {
    view.innerHTML = `<p class="empty">Erro ao carregar: ${esc(e.message)}</p>`;
  }
}
function connect() {
  const dot = document.getElementById("stream"), src = new EventSource("/api/stream");
  src.onopen = () => dot.classList.add("on");
  src.onerror = () => dot.classList.remove("on");
  src.onmessage = (e) => {
    live = JSON.parse(e.data);
    const n = live.runs.filter((r) => r.status === "running").length, pill = document.getElementById("live-count");
    pill.hidden = !n; pill.textContent = n;
    const tab = location.hash.split("/")[1] || "live";
    if (tab === "live" || tab === "now") route();
  };
}
document.getElementById("filters").addEventListener("change", route);
window.addEventListener("hashchange", route);
setInterval(() => { const t = location.hash.split("/")[1] || "live"; if ((t === "live" || t === "now") && live.runs.some((r) => r.status === "running")) route(); }, 5000);
loadFilters().then(route);
connect();
