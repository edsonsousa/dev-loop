"""Load dev-loop history into SQLite.

Usage: python3 ingest.py [--db PATH] [--transcripts DIR]

Sources, all re-read on every run (safe to run as often as you like):
  - <project>/.claude/dev-loop/*.run.json   written by /dev-loop:run, one per task
  - ~/.claude/projects/*/<session>/subagents/agent-*.{meta.json,jsonl}   the agents' transcripts
  - git in each project, for what reached the main branch after the loop
Agent rows are kept after Claude Code deletes old transcripts.
"""
import argparse
import json
import re
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_DB = Path.home() / ".local/share/dev-loop/history.db"
DEFAULT_TRANSCRIPTS = Path.home() / ".claude/projects"
TAG = re.compile(r"^dev-loop r(\d+) (\S+)")
TASK = re.compile(r"\.claude/dev-loop/([\w.-]+)\.md")


# Columns added after the first release: (table, column, type). New databases get them the same way.
COLUMNS = [("run", "loop_version", "TEXT"), ("run", "mutation_score", "REAL"), ("run", "mutation_survived", "INTEGER"),
           ("run", "scan_findings", "INTEGER"), ("run", "weakening_hits", "INTEGER"), ("finding", "evidence", "TEXT"),
           ("run", "parent", "TEXT"), ("run", "split", "TEXT")]


def connect(db: Path) -> sqlite3.Connection:
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db, timeout=10)
    con.executescript((HERE / "schema.sql").read_text())
    for table, column, kind in COLUMNS:
        if column not in {r[1] for r in con.execute(f"PRAGMA table_info({table})")}:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
    con.executescript((HERE / "views.sql").read_text())
    return con


def project_id(con, path: str) -> int:
    con.execute("INSERT OR IGNORE INTO project (path, name) VALUES (?, ?)", (path, Path(path).name))
    return con.execute("SELECT id FROM project WHERE path = ?", (path,)).fetchone()[0]


# ---------- agents ----------

def read_agent(jsonl: Path) -> dict:
    """Tokens, timing and tool use of one subagent transcript."""
    usage, tools, compactions = {}, set(), 0
    first = last = cwd = task = None
    for line in jsonl.open():
        d = json.loads(line)
        ts = d.get("timestamp")
        if ts:
            first = first or ts
            last = ts
        cwd = cwd or d.get("cwd")
        if d.get("type") == "system" and d.get("subtype") == "compact_boundary":
            compactions += 1
        m = d.get("message")
        if not isinstance(m, dict):
            continue
        if task is None and m.get("role") == "user":
            found = TASK.search(json.dumps(m.get("content")))
            task = found.group(1) if found else None
        if m.get("usage"):
            # A message is written once per content block, each with the same usage: keep one per id.
            usage[m.get("id") or d.get("uuid")] = m["usage"]
        if m.get("role") == "assistant" and isinstance(m.get("content"), list):
            tools |= {b.get("id") for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_use"}
    sums = {k: sum(u.get(f, 0) for u in usage.values()) for k, f in
            [("input", "input_tokens"), ("cache_write", "cache_creation_input_tokens"),
             ("cache_read", "cache_read_input_tokens"), ("output", "output_tokens")]}
    peak = max((u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                + u.get("cache_read_input_tokens", 0) for u in usage.values()), default=0)
    seconds = None
    if first and last:
        seconds = (parse_ts(last) - parse_ts(first)).total_seconds()
    return {**sums, "api_calls": len(usage), "tool_calls": len(tools - {None}), "compactions": compactions,
            "peak_context": peak, "started": first, "ended": last, "seconds": seconds, "cwd": cwd, "task": task}


def parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def ingest_agents(con, root: Path) -> set[str]:
    """Upsert every dev-loop subagent; return the project paths seen."""
    projects = set()
    for meta in root.glob("*/*/subagents/*.meta.json"):
        info = json.loads(meta.read_text())
        tag = TAG.match(info.get("description", ""))
        jsonl = meta.with_name(meta.name.replace(".meta.json", ".jsonl"))
        if not tag or not jsonl.exists():
            continue
        a = read_agent(jsonl)
        pid = project_id(con, a["cwd"]) if a["cwd"] else None
        if a["cwd"]:
            projects.add(a["cwd"])
        con.execute(
            """INSERT OR REPLACE INTO agent_run (agent_id, run_id, project_id, session, task, round, role, type, model,
               started, ended, seconds, tool_calls, api_calls, compactions, peak_context,
               input, cache_write, cache_read, output)
               VALUES (?, (SELECT run_id FROM agent_run WHERE agent_id = ?), ?, ?, ?, ?, ?, ?, ?,
                       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (jsonl.stem, jsonl.stem, pid, meta.parent.parent.name, a["task"], int(tag[1]), tag[2],
             info.get("agentType"), info.get("model"), a["started"], a["ended"], a["seconds"], a["tool_calls"],
             a["api_calls"], a["compactions"], a["peak_context"],
             a["input"], a["cache_write"], a["cache_read"], a["output"]))
    return projects


# ---------- runs ----------

def ingest_runs(con, project: Path) -> None:
    pid = project_id(con, str(project))
    for f in sorted((project / ".claude/dev-loop").glob("*.run.json")):
        r = json.loads(f.read_text())
        mutation, scan, weakening = r.get("mutation") or {}, r.get("scan") or {}, r.get("weakening")
        con.execute(
            """INSERT INTO run (project_id, task, title, started, ended, base, branch, main_branch, snapshot,
                                outcome, escalation, rounds, sensitive, files, loop_version, mutation_score,
                                mutation_survived, scan_findings, weakening_hits, parent, split)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (project_id, task, started) DO UPDATE SET
                 title = excluded.title, ended = excluded.ended, base = excluded.base, branch = excluded.branch,
                 main_branch = excluded.main_branch, snapshot = excluded.snapshot, outcome = excluded.outcome,
                 escalation = excluded.escalation, rounds = excluded.rounds, sensitive = excluded.sensitive,
                 files = excluded.files, loop_version = excluded.loop_version,
                 mutation_score = excluded.mutation_score, mutation_survived = excluded.mutation_survived,
                 scan_findings = excluded.scan_findings, weakening_hits = excluded.weakening_hits,
                 parent = excluded.parent, split = excluded.split""",
            (pid, r["task"], r.get("title"), r["started"], r.get("ended"), r.get("base"), r.get("branch"),
             r.get("mainBranch", "main"), r.get("snapshot"), r.get("outcome"), r.get("escalation"),
             r.get("rounds"), json.dumps(r.get("sensitive", [])), json.dumps(r.get("files", [])),
             r.get("loopVersion"), mutation.get("score"), mutation.get("survived"), scan.get("findings"),
             len(weakening) if isinstance(weakening, list) else None, r.get("parent"), r.get("split")))
        if r.get("loopVersion"):
            con.execute("""INSERT INTO loop_version (version, first_seen) VALUES (?, ?)
                           ON CONFLICT (version) DO UPDATE SET first_seen = min(first_seen, excluded.first_seen)""",
                        (r["loopVersion"], r["started"]))
        run_id = con.execute("SELECT id FROM run WHERE project_id = ? AND task = ? AND started = ?",
                             (pid, r["task"], r["started"])).fetchone()[0]
        con.execute("DELETE FROM gate_run WHERE run_id = ?", (run_id,))
        con.executemany(
            "INSERT INTO gate_run VALUES (?, ?, ?, ?, ?, ?)",
            [(run_id, i, g.get("round"), g.get("command"), int(bool(g.get("passed"))), g.get("seconds"))
             for i, g in enumerate(r.get("gates", []))])
        con.execute("DELETE FROM incident WHERE run_id = ?", (run_id,))
        con.executemany("INSERT INTO incident VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        [(run_id, i, x.get("round"), x.get("role"), x.get("agent"), x.get("kind"), x.get("detail"),
                          x.get("at"), x.get("action")) for i, x in enumerate(r.get("incidents") or [])])
        con.execute("DELETE FROM finding WHERE run_id = ?", (run_id,))
        con.executemany(
            """INSERT OR REPLACE INTO finding (run_id, finding_id, role, round, blocking, file, line, issue, outcome,
                                                closed_round, duplicate_of, evidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [(run_id, x["id"], x["role"], x.get("round"), int(bool(x.get("blocking"))), x.get("file"),
              x.get("line"), x.get("issue"), x.get("outcome"), x.get("closedRound"), x.get("duplicateOf"),
              x.get("evidence"))
             for x in r.get("findings", [])])
        # An agent belongs to the run of its project and task that was running when it started.
        con.execute(
            """UPDATE agent_run SET run_id = ? WHERE project_id = ? AND task = ?
               AND started >= ? AND (? IS NULL OR started <= ?)""",
            (run_id, pid, r["task"], r["started"], r.get("ended"), r.get("ended")))
        post_merge(con, project, run_id, r)


def git(project: Path, *args: str) -> str | None:
    out = subprocess.run(["git", "-C", str(project), *args], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else None


def post_merge(con, project: Path, run_id: int, r: dict) -> None:
    """Compare the code as the loop left it with what the main branch has now, for the run's files."""
    files, base, snap, main = r.get("files") or [], r.get("base"), r.get("snapshot"), r.get("mainBranch", "main")
    if not (files and base and snap) or git(project, "rev-parse", "--verify", "-q", snap) is None:
        return
    log = git(project, "log", "--format=%h %s", f"{base}..{main}", "--", *files) or ""
    commits = [line for line in log.splitlines() if line]
    drift_files = drift_lines = None
    if commits:
        # ponytail: also counts later, unrelated work on the same files; /dev-loop:retro sorts that out.
        stat = git(project, "diff", "--numstat", snap, main, "--", *files) or ""
        rows = [line.split("\t") for line in stat.splitlines() if line]
        drift_files = len(rows)
        drift_lines = sum(int(a) + int(d) for a, d, _ in rows if a.isdigit() and d.isdigit())
    con.execute(
        """INSERT INTO post_merge (run_id, checked, merged, commits, drift_files, drift_lines)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET checked = excluded.checked, merged = excluded.merged,
             commits = excluded.commits, drift_files = excluded.drift_files, drift_lines = excluded.drift_lines""",
        (run_id, datetime.now(timezone.utc).isoformat(timespec="seconds"), int(bool(commits)),
         json.dumps(commits), drift_files, drift_lines))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--transcripts", type=Path, default=DEFAULT_TRANSCRIPTS)
    p.add_argument("--project", type=Path, action="append", default=[],
                   help="also read this project's run records (projects with dev-loop agents are found by themselves)")
    args = p.parse_args()
    runs, agents = refresh(args.db, args.transcripts, [str(x.resolve()) for x in args.project])
    print(f"{args.db}: {runs} runs, {agents} agents")


def refresh(db: Path, transcripts: Path = DEFAULT_TRANSCRIPTS, extra=()) -> tuple[int, int]:
    con = connect(db)
    with con:
        projects = ingest_agents(con, transcripts) | set(extra)
        projects |= {row[0] for row in con.execute("SELECT path FROM project")}
        for project in sorted(projects):
            if Path(project, ".claude/dev-loop").is_dir():
                ingest_runs(con, Path(project))
    counts = tuple(con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("run", "agent_run"))
    con.close()
    return counts


if __name__ == "__main__":
    main()
