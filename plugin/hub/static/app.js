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
const num = (v, d = 0) => (v == null ? "–" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d }));
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
const day = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : "–");
const status = (s, text) => `<span class="status ${esc(s)}">${esc(text ?? s)}</span>`;
const role = (r) => `<span class="role" style="--c:${roleColor(r)}">${esc(r)}</span>`;
const model = (m) => esc((m || "").replace(/^claude-/, ""));
const LABEL = { running: "running", approved: "approved", escalated: "escalated", done: "done", stale: "stale", stopped: "stopped",
  "no record": "no record", approve: "approve", changes: "changes" };

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
  if (!rows.length) return `<p class="empty">Nothing to show with these filters.</p>`;
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
  if (!spec.data.values.length) { el.innerHTML = `<p class="empty">No data.</p>`; return; }
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
  return `<span class="ctx ${p > 80 ? "hot" : ""}" title="${num(a.context)} of ${num(CONTEXT_CAP)} tokens"><span style="width:${p}%"></span></span> ${kTok(a.context)}`;
}
function liveRun(r, full) {
  const start = ms(r.started), end = r.status === "running" ? Date.now() : ms(r.last);
  const o = r.orchestrator?.last;
  const link = r.run_id ? `#/run/${r.run_id}` : `#/now/${encodeURIComponent(r.key)}`;
  const cols = [
    { label: "Role", html: (a) => role(a.role) }, { label: "Round", k: "round", n: 1 },
    { label: "Model", html: (a) => model(a.model) }, { label: "Status", html: (a) => status(a.status, LABEL[a.status]) },
    { label: "Verdict", html: (a) => a.verdict ? status(a.verdict) + (a.blocking ? ` <span class="muted">${a.blocking} blocking</span>` : "") : "" },
    { label: "Time", n: 1, f: (_, a) => dur(((a.status === "running" ? Date.now() : ms(a.last)) - ms(a.started)) / 1000) },
    { label: "Tool calls", k: "tool_calls", n: 1 }, { label: "Context", html: ctx },
    { label: "Compactions", k: "compactions", n: 1 }, { label: "Cost", k: "usd", n: 1, f: usd },
    { label: "Now", html: (a) => a.status === "running" && a.recent[0] ? `<code>${esc(a.recent[0].tool)}</code> ${esc(a.recent[0].target)}` : "" },
  ];
  const recent = full ? r.agents.filter((a) => a.recent.length).map((a) => `<details ${a.status === "running" ? "open" : ""}>
      <summary>${role(a.role)} r${a.round}: latest tool calls</summary>
      <ol class="recent">${a.recent.map((t) => `<li>${esc((t.at || "").slice(11, 19))} <b>${esc(t.tool)}</b> ${esc(t.target)}</li>`).join("")}</ol></details>`).join("") : "";
  return `<section class="card">
    <div class="run-head"><h3><a href="${link}">${esc(r.task || r.session)}</a></h3>
      <span class="muted">${esc(r.project)}</span>${status(r.status, LABEL[r.status])}
      <span>round ${r.round}</span><span>${dur((end - start) / 1000)}</span><span>${usd(r.usd)}</span>
      ${o ? `<span class="muted">orchestrator, ${dur(r.orchestrator.quiet)} ago: <code>${esc(o.tool)}</code> ${esc(o.target)}</span>` : ""}</div>
    ${lanes(r.agents, start, end)}
    ${table(cols, r.agents)}${recent}</section>`;
}
function renderLive() {
  const running = live.runs.filter((r) => r.status === "running");
  const rest = live.runs.filter((r) => r.status !== "running");
  view.innerHTML = `<h1>Live</h1><p class="sub">dev-loop agents of the last 12 hours, in every session. Updates by itself.</p>
    ${running.length ? running.map((r) => liveRun(r)).join("") : `<p class="card empty">No task running now.</p>`}
    ${rest.length ? `<h2>Finished in the last 12 hours</h2>${rest.map((r) => liveRun(r)).join("")}` : ""}`;
}
function renderNow(key) {
  const r = live.runs.find((x) => x.key === key);
  view.innerHTML = r ? `<p><a href="#/live">← Live</a></p>${liveRun(r, true)}` : `<p class="empty">This task left the live window. <a href="#/runs">See runs</a></p>`;
}

// ---------- runs ----------
async function renderRuns() {
  const runs = await get("/api/runs?" + query());
  view.innerHTML = `<h1>Runs</h1><p class="sub">${runs.length} recorded runs. Click one for its detail.</p>
    <div class="card"><div id="c-runs" class="chart"></div></div>
    <div class="card">${table([
      { label: "Day", k: "started", f: day }, { label: "Project", k: "project" },
      { label: "Task", html: (r) => `<a href="#/run/${r.id}">${esc(r.task)}</a>` },
      { label: "Outcome", html: (r) => status(r.outcome, LABEL[r.outcome]) }, { label: "Rounds", k: "rounds", n: 1 },
      { label: "Blocking", k: "blocking", n: 1 }, { label: "Nits", k: "nits", n: 1 }, { label: "Gate failed", k: "gate_failures", n: 1 },
      { label: "Minutes", k: "minutes", n: 1, f: (v) => num(v) }, { label: "Cost", k: "usd", n: 1, f: usd },
      { label: "Main after", html: (r) => r.merged ? `${num(r.drift_lines)} lines${r.post_merge_class ? " · " + esc(r.post_merge_class) : ""}` : `<span class="muted">no</span>` },
      { label: "Version", k: "version" },
    ], runs, (r) => `#/run/${r.id}`)}</div>`;
  chart("c-runs", {
    title: { text: "Cost per run", anchor: "start", color: css("--ink") }, height: 200,
    data: { values: runs.map((r) => ({ ...r, label: r.task })) },
    mark: { type: "bar", tooltip: true, width: { band: 0.6 }, maxBandSize: 48 },
    encoding: {
      x: { field: "label", type: "nominal", sort: { field: "started" }, title: null, axis: { labelAngle: -30 } },
      y: { field: "usd", type: "quantitative", title: "USD" },
      color: { field: "outcome", type: "nominal", scale: outcomeScale(), title: "Outcome" },
      tooltip: [{ field: "task" }, { field: "usd", format: "$.2f" }, { field: "rounds" }, { field: "outcome" }],
    },
  });
}

async function renderRun(id) {
  const d = await get(`/api/run/${id}`);
  const r = d.run, blocking = d.findings.filter((f) => f.blocking), nits = d.findings.filter((f) => !f.blocking);
  const lv = live.runs.find((x) => x.run_id === r.id);
  const files = JSON.parse(r.files || "[]"), sensitive = JSON.parse(r.sensitive || "[]");
  view.innerHTML = `<p><a href="#/runs">← Runs</a>${lv ? ` · <a href="#/now/${encodeURIComponent(lv.key)}">live</a>` : ""}</p>
    <h1>${esc(r.task)}</h1><p class="sub">${esc(r.title || "")} · ${esc(r.project)} · ${esc(r.branch || "")} · version ${esc(r.version || "–")}</p>
    <div class="tiles">
      <div class="tile"><div class="k">Outcome</div><div class="v">${status(r.outcome, LABEL[r.outcome])}</div><div class="d">${esc(r.escalation || "")}</div></div>
      <div class="tile"><div class="k">Rounds</div><div class="v">${num(r.rounds)}</div></div>
      <div class="tile"><div class="k">Estimated cost</div><div class="v">${usd(r.usd)}</div><div class="d">${kTok(r.tokens)} tokens</div></div>
      <div class="tile"><div class="k">Duration</div><div class="v">${dur(r.minutes * 60)}</div><div class="d">${day(r.started)}</div></div>
      <div class="tile"><div class="k">Blocking / nits</div><div class="v">${blocking.length} / ${nits.length}</div>${blocking.some((f) => f.evidence != null) ? `<div class="d">${r.with_evidence} with evidence</div>` : ""}</div>
      <div class="tile"><div class="k">Mutation</div><div class="v">${r.mutation_score == null ? "–" : pct(r.mutation_score)}</div><div class="d">${r.mutation_survived ?? "–"} survivors</div></div>
    </div>
    <div class="card"><div id="c-timeline" class="chart"></div></div>
    <div class="grid"><div class="card"><div id="c-rolecost" class="chart"></div></div>
      <div class="card"><h2 style="margin-top:0">Gates</h2>${table([
        { label: "Round", k: "round", n: 1 }, { label: "Command", html: (g) => `<code>${esc(g.command)}</code>` },
        { label: "Outcome", html: (g) => status(g.passed ? "approved" : "escalated", g.passed ? "passed" : "failed") },
        { label: "Seconds", k: "seconds", n: 1, f: (v) => num(v) }], d.gates)}</div></div>
    <div class="card"><h2 style="margin-top:0">Blocking findings</h2>${table([
      { label: "Id", k: "finding_id" }, { label: "Role", html: (f) => role(f.role) }, { label: "Round", k: "round", n: 1 },
      { label: "Resolution", k: "outcome" }, { label: "Duplicate of", k: "duplicate_of" },
      { label: "Where", html: (f) => f.file ? `<code>${esc(f.file)}${f.line ? ":" + f.line : ""}</code>` : "" },
      { label: "Issue", html: (f) => esc(f.issue) + (f.evidence ? `<details><summary>evidence</summary><div class="evidence">${esc(f.evidence)}</div></details>` : "") },
    ], blocking)}
    <details><summary>${nits.length} nits</summary>${table([{ label: "Id", k: "finding_id" }, { label: "Role", html: (f) => role(f.role) }, { label: "Nit", k: "issue" }], nits)}</details></div>
    ${d.incidents.length ? `<div class="card"><h2 style="margin-top:0">Incidents</h2>${table([
      { label: "Round", k: "round", n: 1 }, { label: "Role", html: (i) => role(i.role) }, { label: "Kind", k: "kind" },
      { label: "Detail", k: "detail" }, { label: "Action", k: "action" }, { label: "When", html: (i) => esc((i.at || "").slice(11, 16)) },
    ], d.incidents)}</div>` : ""}
    <div class="card"><h2 style="margin-top:0">Agents</h2>${agentTable(d.agents)}</div>
    <div class="card"><h2 style="margin-top:0">After approval</h2>${postMerge(d.post_merge, r)}
      <details><summary>${files.length} files${sensitive.length ? `, ${sensitive.length} sensitive` : ""}</summary>
      <ul>${files.map((f) => `<li><code>${esc(f)}</code>${sensitive.includes(f) ? " · sensitive" : ""}</li>`).join("")}</ul></details></div>`;
  chart("c-timeline", {
    title: { text: "Agent timeline", anchor: "start", color: css("--ink") },
    height: { step: 22 }, data: { values: d.agents.map((a) => ({ ...a, lane: `r${a.round} ${a.role}` })) },
    mark: { type: "bar", tooltip: true, cornerRadius: 4, height: 14 },
    encoding: {
      y: { field: "lane", type: "nominal", sort: { field: "started" }, title: null },
      x: { field: "started", type: "temporal", title: null, axis: { format: "%H:%M" } }, x2: { field: "ended" },
      color: { field: "role", type: "nominal", scale: roleScale(), title: "Role" },
      tooltip: [{ field: "role" }, { field: "round" }, { field: "model" }, { field: "seconds", title: "seconds" }, { field: "usd", format: "$.2f" }],
    },
  });
  chart("c-rolecost", {
    title: { text: "Cost per role", anchor: "start", color: css("--ink") }, height: { step: 24 },
    data: { values: Object.values(d.agents.reduce((m, a) => ((m[a.role] ??= { role: a.role, usd: 0 }).usd += a.usd || 0, m), {})) },
    mark: { type: "bar", tooltip: true },
    encoding: { y: { field: "role", type: "nominal", sort: "-x", title: null }, x: { field: "usd", type: "quantitative", title: "USD" },
      color: { field: "role", scale: roleScale(), legend: null }, tooltip: [{ field: "role" }, { field: "usd", format: "$.2f" }] },
  });
}
function postMerge(pm, r) {
  if (!pm) return `<p class="muted">No snapshot to compare.</p>`;
  if (!pm.merged) return `<p class="muted">This run's files have not changed on ${esc(r.main_branch)} since the base.</p>`;
  const commits = JSON.parse(pm.commits || "[]");
  return `<p>${num(pm.drift_files)} files and ${num(pm.drift_lines)} lines differ between what the loop left and ${esc(r.main_branch)}.
    ${pm.class ? `Classified by the retro as <b>${esc(pm.class)}</b>: ${esc(pm.note)}` : `<span class="muted">/dev-loop:retro has not classified it yet.</span>`}</p>
    <ul>${commits.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ul>`;
}
function agentTable(rows, withRun) {
  return table([
    ...(withRun ? [{ label: "Day", k: "started", f: day }, { label: "Task", html: (a) => a.run_id ? `<a href="#/run/${a.run_id}">${esc(a.task)}</a>` : `<span class="muted">${esc(a.task || "?")} (no record)</span>` }] : []),
    { label: "Round", k: "round", n: 1 }, { label: "Role", html: (a) => role(a.role) }, { label: "Model", html: (a) => model(a.model) },
    { label: "Minutes", n: 1, f: (_, a) => num(a.minutes ?? a.seconds / 60, 1) }, { label: "Tool calls", k: "tool_calls", n: 1 },
    { label: "Peak context", n: 1, f: (_, a) => kTok(a.peak_context) }, { label: "Compactions", k: "compactions", n: 1 },
    { label: "Output", n: 1, f: (_, a) => kTok(a.output) }, { label: "Cost", k: "usd", n: 1, f: usd },
  ], rows, withRun ? (a) => (a.run_id ? `#/run/${a.run_id}` : "") : null);
}

// ---------- quality ----------
const INDICATORS = [
  { k: "first_round", label: "Approved in round 1", f: pct, better: "up" },
  { k: "rounds", label: "Rounds per run", f: (v) => num(v, 2), better: "down" },
  { k: "escalated", label: "Escalated", f: pct, better: "down" },
  { k: "escapes", label: "Escapes (bug or design on main)", f: (v, g) => `${num(v)} / ${num(g.merged)}`, better: "down" },
  { k: "blocking_per_run", label: "Blocking per run", f: (v) => num(v, 1), better: null },
  { k: "duplicates", label: "Duplicate blocking", f: pct, better: "down" },
  { k: "nits_per_run", label: "Nits per run", f: (v) => num(v, 1), better: "down" },
  { k: "incidents_per_run", label: "Incidents per run", f: (v) => num(v, 1), better: "down" },
  { k: "gate_first_pass", label: "Gate passed first time", f: pct, better: "up" },
  { k: "mutation", label: "Mutation score", f: pct, better: "up" },
  { k: "weakening", label: "Weakenings per run", f: (v) => num(v, 1), better: "down" },
  { k: "usd_per_approved", label: "USD per approved run", f: usd, better: "down" },
  { k: "minutes", label: "Minutes per run", f: (v) => num(v), better: "down" },
];
// split groups: whole task, escalated with a split proposed, one slice of a split
const BY = { version: "loop version", week: "week", split: "split (whole · split proposed · slice)" };
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
  view.innerHTML = `<h1>Quality</h1>
    <p class="sub">Indicators per ${BY[by]}. The tiles show the latest group (${esc(cur?.grp ?? "–")});
      the change shows only when both groups have ${MIN_N} runs or more.
      Group by <a href="#/quality/version">version</a> · <a href="#/quality/week">week</a> · <a href="#/quality/split">split</a></p>
    <div class="tiles">${INDICATORS.map(tile).join("")}</div>
    <div class="card"><div id="c-quality" class="chart"></div>
      <p class="note">Each panel is an indicator; each bar, a group. Groups with fewer than ${MIN_N} runs are faded.</p></div>
    <div class="card"><h2 style="margin-top:0">Roles in ${esc(cur?.grp ?? "–")}</h2>
      <p class="note">Precision: fixed ÷ (fixed + accepted rejections). Duplicates and nits do not count as findings.</p>
      ${table([{ label: "Role", html: (r) => role(r.role) }, { label: "Blocking", k: "blocking", n: 1 }, { label: "Fixed", k: "fixed", n: 1 },
        { label: "False positives", k: "false_positive", n: 1 }, { label: "Duplicates", k: "duplicate", n: 1 }, { label: "Nits", k: "nits", n: 1 },
        { label: "Precision", k: "precision", n: 1, f: pct }, { label: "Cost", k: "usd", n: 1, f: usd }, { label: "USD per fix", k: "per_fix", n: 1, f: usd }], roles)}</div>
    <div class="card"><h2 style="margin-top:0">Loop versions</h2>
      <p class="note">The version is a hash of the agents and skills. Name an experiment's version to compare it with the others.</p>
      ${table([{ label: "Version", html: (v) => `<code>${esc(v.version)}</code>` }, { label: "Since", k: "first_seen", f: day }, { label: "Runs", k: "runs", n: 1 },
        { label: "Name", html: (v) => `<input class="label" data-version="${esc(v.version)}" value="${esc(v.label || "")}" placeholder="unnamed">` }], filt.versions)}</div>`;
  view.querySelectorAll("input.label").forEach((i) => i.addEventListener("change", async () => {
    await fetch("/api/label", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: i.dataset.version, label: i.value }) });
    loadFilters();
  }));
  const values = g.flatMap((grp) => INDICATORS.filter((i) => i.k !== "escapes" && grp[i.k] != null)
    .map((i) => ({ indicator: i.label, grp: grp.grp, since: grp.since, value: grp[i.k], runs: grp.runs, thin: grp.runs < MIN_N ? "fewer than " + MIN_N : "ok" })));
  if (g.length < 2) {
    document.getElementById("c-quality").innerHTML = `<p class="empty">The charts compare groups: they show once 2 or more groups have runs.</p>`;
    return;
  }
  chart("c-quality", {
    data: { values },
    facet: { field: "indicator", type: "nominal", title: null, header: { labelFontSize: 12, labelAnchor: "start" }, sort: INDICATORS.map((i) => i.label) },
    columns: 4, resolve: { scale: { y: "independent" }, axis: { x: "independent" } },
    spec: { width: 260, height: 90, mark: { type: "bar", tooltip: true, color: css("--accent"), width: { band: 0.6 } },
      encoding: { x: { field: "grp", type: "nominal", sort: { field: "since" }, title: null, axis: { labelAngle: 0, labelLimit: 120 } },
        y: { field: "value", type: "quantitative", title: null, axis: { format: ",.2~f", tickCount: 3 } },
        opacity: { field: "thin", type: "nominal", scale: { domain: ["ok", "fewer than " + MIN_N], range: [1, 0.35] }, title: "Runs" },
        tooltip: [{ field: "indicator" }, { field: "grp", title: "group" }, { field: "value", format: ".2f" }, { field: "runs", title: "runs" }] } },
  });
}

// ---------- agents ----------
async function renderAgents() {
  const rows = await get("/api/agents?" + query());
  view.innerHTML = `<h1>Agents</h1><p class="sub">${rows.length} recorded agents.</p>
    <div class="grid"><div class="card"><div id="c-context" class="chart"></div></div><div class="card"><div id="c-minutes" class="chart"></div></div></div>
    <div class="card">${agentTable(rows, true)}</div>`;
  chart("c-context", {
    title: { text: "Peak context per agent (compacts at 300k)", anchor: "start", color: css("--ink") }, height: { step: 28 },
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
    title: { text: "Minutes per agent", anchor: "start", color: css("--ink") }, height: { step: 28 },
    data: { values: rows }, mark: { type: "tick", thickness: 3, tooltip: true },
    encoding: { y: { field: "role", type: "nominal", title: null }, x: { field: "minutes", type: "quantitative", title: "minutes" },
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
    view.innerHTML = `<p class="empty">Failed to load: ${esc(e.message)}</p>`;
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
