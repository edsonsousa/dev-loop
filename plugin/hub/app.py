"""dev-loop UI: live agents, run history, quality indicators. Standard library only.

Usage: python3 app.py [--db PATH] [--transcripts DIR] [--port 8766]
Listens on 127.0.0.1 only. The history is refreshed by itself when a run record or an agent changes.
"""
import argparse
import json
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import ingest
from live import Live

STATIC = Path(__file__).parent / "static"
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml"}
POLL, REFRESH = 2, 15  # seconds


# ---------- queries ----------

def filters(q: dict, alias: str = "s") -> tuple[str, list]:
    """WHERE clause for the project, since and version filters of the query string."""
    sql, args = [], []
    if q.get("project"):
        sql.append(f"{alias}.project = ?"); args.append(q["project"])
    if q.get("since"):
        sql.append(f"{alias}.day >= ?"); args.append(q["since"])
    if q.get("version"):
        sql.append(f"coalesce(lv.label, {alias}.loop_version, '') = ?"); args.append(q["version"])
    return (" WHERE " + " AND ".join(sql)) if sql else "", args


RUNS = """SELECT s.*, coalesce(lv.label, s.loop_version) AS version FROM run_summary s
          LEFT JOIN loop_version lv ON lv.version = s.loop_version"""

GROUP = {"version": "coalesce(lv.label, s.loop_version, 'no version')",
         "week": "date(s.day, '-6 days', 'weekday 1')",
         "split": "CASE WHEN s.parent IS NOT NULL THEN 'slice' WHEN s.split = 'after' THEN 'split proposed' ELSE 'whole' END"}

QUALITY = """
SELECT {g} AS grp, min(s.started) AS since, count(*) AS runs,
       round(100.0 * avg(s.outcome = 'approved' AND s.rounds <= 1), 0) AS first_round,
       round(avg(s.rounds), 2) AS rounds,
       round(100.0 * avg(s.outcome = 'escalated'), 0) AS escalated,
       sum(s.post_merge_class IN ('bug', 'design')) AS escapes, sum(coalesce(s.merged, 0)) AS merged,
       round(1.0 * sum(s.nits) / count(*), 1) AS nits_per_run,
       round(1.0 * sum(s.blocking) / count(*), 1) AS blocking_per_run,
       round(100.0 * sum(s.duplicates) / nullif(sum(s.blocking), 0), 0) AS duplicates,
       round(100.0 * avg(s.gate_first_pass), 0) AS gate_first_pass,
       round(avg(s.mutation_score), 1) AS mutation,
       round(avg(s.weakening_hits), 1) AS weakening,
       round(1.0 * sum(s.incidents) / count(*), 1) AS incidents_per_run,
       round(sum(s.usd) / nullif(sum(s.outcome = 'approved'), 0), 2) AS usd_per_approved,
       round(avg(s.minutes), 0) AS minutes
FROM run_summary s LEFT JOIN loop_version lv ON lv.version = s.loop_version {w}
GROUP BY grp ORDER BY since"""

ROLES = """
SELECT {g} AS grp, f.role,
       count(*) FILTER (WHERE f.blocking AND f.duplicate_of IS NULL) AS blocking,
       count(*) FILTER (WHERE f.outcome = 'fixed' AND f.duplicate_of IS NULL) AS fixed,
       count(*) FILTER (WHERE f.outcome = 'rejected-upheld') AS false_positive,
       count(*) FILTER (WHERE f.duplicate_of IS NOT NULL) AS duplicate,
       count(*) FILTER (WHERE NOT f.blocking) AS nits
FROM finding f JOIN run_summary s ON s.id = f.run_id LEFT JOIN loop_version lv ON lv.version = s.loop_version {w}
GROUP BY grp, f.role"""

ROLE_COST = """
SELECT {g} AS grp, c.role, round(sum(c.usd), 2) AS usd, count(*) AS agents
FROM agent_cost c JOIN run_summary s ON s.id = c.run_id LEFT JOIN loop_version lv ON lv.version = s.loop_version {w}
GROUP BY grp, c.role"""

AGENTS = """
SELECT c.agent_id, c.run_id, coalesce(s.task, c.task) AS task, c.project, c.round, c.role, c.model, c.started, round(c.seconds / 60.0, 1) AS minutes,
       c.tool_calls, c.compactions, c.peak_context, c.input + c.cache_write + c.cache_read + c.output AS tokens,
       c.output, c.usd, coalesce(lv.label, s.loop_version) AS version, date(c.started) AS day
FROM agent_cost c LEFT JOIN run_summary s ON s.id = c.run_id LEFT JOIN loop_version lv ON lv.version = s.loop_version"""


QUIET_TASK = 35 * 60  # the state file changes after every step; the longest step is a gate: heavy.sh waits 8, runs 20


def run_status(r: dict, known: dict | None, now: float) -> str:
    """running while an agent runs or the orchestrator keeps writing the task's state file; else its outcome."""
    if r["running"]:
        return "running"
    if known:
        return known["outcome"]
    try:
        state = Path(r["cwd"]) / ".claude/dev-loop" / f"{r['task']}.md"
        if r["task"] and now - state.stat().st_mtime < QUIET_TASK:
            return "running"
    except (OSError, TypeError):
        pass
    return "no record"


class Store:
    """The history database, read-only, plus the live state and its refresh threads."""

    def __init__(self, db: Path, transcripts: Path):
        self.db, self.transcripts = db, transcripts
        ingest.refresh(db, transcripts)
        self.live, self.live_json, self.seq = Live(transcripts), "{}", 0
        self.changed = threading.Condition()
        self.refreshed = time.time()

    def read(self, sql: str, args=()) -> list[dict]:
        con = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=10)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql, args)]
        finally:
            con.close()

    def write(self, sql: str, args=()) -> None:
        con = sqlite3.connect(self.db, timeout=10)
        with con:
            con.execute(sql, args)
        con.close()

    def prices(self) -> dict:
        return {r["model"]: r for r in self.read("SELECT * FROM price")}

    # Live: poll the transcripts; refresh the history when a run record or an agent changed since the last one.
    def loop(self) -> None:
        while True:
            try:
                state = self.live.poll(self.prices())
                runs = {(r["path"], r["task"]): r for r in self.read(
                    "SELECT p.path, r.task, r.id, r.outcome, r.ended FROM run r JOIN project p ON p.id = r.project_id")}
                for r in state["runs"]:
                    known = runs.get((r["cwd"], r["task"]))
                    r["run_id"], r["outcome"] = (known["id"], known["outcome"]) if known else (None, None)
                    r["status"] = run_status(r, known, time.time())
                text = json.dumps(state, sort_keys=True)
                if text != self.live_json:
                    with self.changed:
                        self.live_json, self.seq = text, self.seq + 1
                        self.changed.notify_all()
                if time.time() - self.refreshed > REFRESH and self.newest() > self.refreshed:
                    self.refreshed = time.time()
                    ingest.refresh(self.db, self.transcripts)
            except Exception as e:  # keep the live view going; the error shows in the server's output
                print("poll:", repr(e))
            time.sleep(POLL)

    def newest(self) -> float:
        paths = list(self.transcripts.glob("*/*/subagents/*.meta.json"))
        for r in self.read("SELECT path FROM project"):
            paths += Path(r["path"], ".claude/dev-loop").glob("*.run.json")
        return max((p.stat().st_mtime for p in paths if p.exists()), default=0)

    # API
    def api(self, path: str, q: dict):
        if path == "/api/live":
            return json.loads(self.live_json)
        if path == "/api/filters":
            return {"projects": [r["name"] for r in self.read("SELECT name FROM project ORDER BY name")],
                    "versions": self.read("""SELECT v.version, v.label, v.first_seen, count(r.id) AS runs
                                             FROM loop_version v LEFT JOIN run r ON r.loop_version = v.version
                                             GROUP BY v.version ORDER BY v.first_seen""")}
        if path == "/api/runs":
            w, a = filters(q)
            return self.read(RUNS + w + " ORDER BY s.started DESC", a)
        if path.startswith("/api/run/"):
            rid = int(path.rsplit("/", 1)[1])
            run = self.read("""SELECT r.*, p.name AS project, p.path, s.usd, s.tokens, s.minutes, s.blocking, s.nits,
                                      s.with_evidence, s.gate_first_pass, coalesce(lv.label, r.loop_version) AS version
                               FROM run r JOIN project p ON p.id = r.project_id JOIN run_summary s ON s.id = r.id
                               LEFT JOIN loop_version lv ON lv.version = r.loop_version WHERE r.id = ?""", (rid,))
            if not run:
                return None
            return {"run": run[0],
                    "gates": self.read("SELECT * FROM gate_run WHERE run_id = ? ORDER BY seq", (rid,)),
                    "findings": self.read("SELECT * FROM finding WHERE run_id = ? ORDER BY round, finding_id", (rid,)),
                    "incidents": self.read("SELECT * FROM incident WHERE run_id = ? ORDER BY seq", (rid,)),
                    "agents": self.read("SELECT * FROM agent_cost WHERE run_id = ? ORDER BY started", (rid,)),
                    "post_merge": (self.read("SELECT * FROM post_merge WHERE run_id = ?", (rid,)) or [None])[0]}
        if path == "/api/quality":
            g = GROUP.get(q.get("by"), GROUP["version"])
            w, a = filters(q)
            return {"groups": self.read(QUALITY.format(g=g, w=w), a),
                    "roles": self.read(ROLES.format(g=g, w=w), a),
                    "role_cost": self.read(ROLE_COST.format(g=g, w=w), a)}
        if path == "/api/agents":
            w, a = filters(q, "s")
            w = w.replace("s.project", "c.project").replace("s.day", "date(c.started)")
            return self.read(AGENTS + w + " ORDER BY c.started DESC", a)
        return None


class Handler(BaseHTTPRequestHandler):
    store: Store
    port: int

    def log_message(self, *args):  # quiet: the UI polls nothing, but SSE reconnects would fill the terminal
        pass

    def allowed(self) -> bool:
        """Only this machine's own pages: blocks DNS rebinding and requests from other sites."""
        host = self.headers.get("Host", "")
        ok = host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}")
        if not ok:
            self.send_error(403)
        return ok

    def send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.allowed():
            return
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/stream":
            return self.stream()
        if url.path.startswith("/api/"):
            try:
                data = self.store.api(url.path, q)
            except (ValueError, sqlite3.Error) as e:
                return self.send(400, json.dumps({"error": str(e)}).encode(), "application/json")
            if data is None:
                return self.send(404, b'{"error": "not found"}', "application/json")
            return self.send(200, json.dumps(data).encode(), "application/json")
        file = (STATIC / (url.path.lstrip("/") or "index.html")).resolve()
        if not file.is_relative_to(STATIC.resolve()) or not file.is_file():
            file = STATIC / "index.html"  # the page routes by #hash; any other path gets the page
        self.send(200, file.read_bytes(), TYPES.get(file.suffix, "application/octet-stream"))

    def do_POST(self):
        """The one write: a label for a loop version, to name an experiment."""
        if not self.allowed():
            return
        if urlparse(self.path).path != "/api/label" or self.headers.get("Content-Type") != "application/json" \
                or self.headers.get("Origin") not in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"):
            return self.send(403, b'{"error": "forbidden"}', "application/json")
        body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 4096)) or b"{}")
        label = (body.get("label") or "").strip()[:60] or None
        self.store.write("UPDATE loop_version SET label = ? WHERE version = ?", (label, str(body.get("version"))))
        self.send(200, b'{"ok": true}', "application/json")

    def stream(self):
        """Server-sent events: the live state each time it changes, and a heartbeat every 15 s."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        seen = -1
        try:
            while True:
                with self.store.changed:
                    if self.store.seq == seen:
                        self.store.changed.wait(15)
                    seq, text = self.store.seq, self.store.live_json
                self.wfile.write(f"data: {text}\n\n".encode() if seq != seen else b": ping\n\n")
                self.wfile.flush()
                seen = seq
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", type=Path, default=ingest.DEFAULT_DB)
    p.add_argument("--transcripts", type=Path, default=ingest.DEFAULT_TRANSCRIPTS)
    p.add_argument("--port", type=int, default=8766)
    args = p.parse_args()
    Handler.store, Handler.port = Store(args.db, args.transcripts), args.port
    threading.Thread(target=Handler.store.loop, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"dev-loop: http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
