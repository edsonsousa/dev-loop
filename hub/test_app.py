"""Run: python3 test_app.py   Checks the quality indicators on known runs and the live view on a growing transcript.

`python3 test_app.py --serve PORT` keeps the fixture database and serves the UI on it, to look at the charts.
"""
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import app
import ingest
import watch
from live import Live

U = {"input_tokens": 1, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 9000, "output_tokens": 100}


def fixture(db: Path) -> None:
    """Two loop versions, three runs each: v2 approves more often in round 1 and costs less."""
    ingest.connect(db).close()
    con = sqlite3.connect(db)
    with con:
        con.execute("INSERT INTO project (path, name) VALUES ('/p', 'proj')")
        con.execute("INSERT INTO loop_version VALUES ('aaaa1111', '2026-01-01', 'v1'), ('bbbb2222', '2026-02-01', NULL)")
        runs = [  # version, day, outcome, rounds, gate failed in round 0, mutation, usd for the implementer
            ("aaaa1111", "2026-01-05", "approved", 2, 1, 80.0, 4.0),
            ("aaaa1111", "2026-01-06", "escalated", 3, 0, 70.0, 6.0),
            ("aaaa1111", "2026-01-07", "approved", 1, 0, 90.0, 2.0),
            ("bbbb2222", "2026-02-05", "approved", 1, 0, 95.0, 2.0),
            ("bbbb2222", "2026-02-06", "approved", 1, 0, 85.0, 2.0),
            ("bbbb2222", "2026-02-07", "approved", 2, 0, 90.0, 2.0),
        ]
        for i, (v, d, outcome, rounds, gate_failed, mutation, cost) in enumerate(runs, 1):
            con.execute("""INSERT INTO run (id, project_id, task, started, ended, outcome, rounds, loop_version,
                           mutation_score) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)""",
                        (i, f"t{i}", f"{d}T10:00:00Z", f"{d}T11:00:00Z", outcome, rounds, v, mutation))
            con.execute("INSERT INTO gate_run VALUES (?, 0, 0, 'make', ?, 10)", (i, 0 if gate_failed else 1))
            # implementer on opus: `cost` USD through output tokens alone (20 USD per million)
            con.execute("""INSERT INTO agent_run (agent_id, run_id, project_id, task, round, role, model, started,
                           input, cache_write, cache_read, output) VALUES (?, ?, 1, ?, 0, 'implementer',
                           'claude-opus-5-5', ?, 0, 0, 0, ?)""", (f"a{i}", i, f"t{i}", f"{d}T10:00:00Z", cost * 50000))
        # run 2 escalated and proposed a split; runs 5 and 6 are its slices
        con.execute("UPDATE run SET split = 'after' WHERE id = 2")
        con.execute("UPDATE run SET parent = 't2' WHERE id IN (5, 6)")
        con.execute("INSERT INTO incident VALUES (1, 0, 1, 'critic', 'a9', 'stalled', 'quiet', '2026-01-05T10:30:00Z', 'rerun')")
        con.executemany("INSERT INTO finding (run_id, finding_id, role, round, blocking, outcome, duplicate_of, evidence) "
                        "VALUES (?, ?, ?, 1, ?, ?, ?, ?)", [
                            (1, "R1", "reviewer", 1, "fixed", None, "test fails"),
                            (1, "C1", "critic", 1, "rejected-upheld", None, ""),
                            (1, "S1", "security", 1, "fixed", "R1", "quote"),
                            (1, "R1-n1", "reviewer", 0, "nit", None, None),
                            (4, "R1", "reviewer", 1, "fixed", None, "x")])


def check_quality(store: app.Store) -> None:
    q = store.api("/api/quality", {"by": "version"})
    v1, v2 = q["groups"]
    assert (v1["grp"], v2["grp"]) == ("v1", "bbbb2222"), q["groups"]  # a label wins over the hash
    assert (v1["runs"], v1["first_round"], v1["escalated"], v1["rounds"]) == (3, 33.0, 33.0, 2.0), v1
    assert (v2["first_round"], v2["escalated"], v2["gate_first_pass"]) == (67.0, 0.0, 100.0), v2
    assert v1["gate_first_pass"] == 67.0 and v1["mutation"] == 80.0 and v2["mutation"] == 90.0, v1
    assert v1["usd_per_approved"] == 6.0 and v2["usd_per_approved"] == 2.0, (v1, v2)  # (4+6+2)/2 and 6/3
    assert v1["blocking_per_run"] == 1.0 and v1["duplicates"] == 33.0, v1  # 3 blocking, S1 duplicates R1
    assert v1["incidents_per_run"] == 0.3 and v2["incidents_per_run"] == 0.0, (v1, v2)
    roles = {r["role"]: r for r in q["roles"] if r["grp"] == "v1"}
    assert (roles["reviewer"]["fixed"], roles["reviewer"]["nits"]) == (1, 1), roles
    assert (roles["critic"]["false_positive"], roles["security"]["duplicate"], roles["security"]["fixed"]) == (1, 1, 0), roles
    weeks = store.api("/api/quality", {"by": "week"})["groups"]
    assert sum(w["runs"] for w in weeks) == 6, weeks
    split = {g["grp"]: g["runs"] for g in store.api("/api/quality", {"by": "split"})["groups"]}
    assert split == {"whole": 3, "split proposed": 1, "slice": 2}, split
    assert len(store.api("/api/runs", {"version": "v1"})) == 3
    assert len(store.api("/api/runs", {"since": "2026-02-01"})) == 3
    detail = store.api("/api/run/1", {})
    assert len(detail["findings"]) == 4 and detail["run"]["version"] == "v1", detail["run"]
    assert [i["kind"] for i in detail["incidents"]] == ["stalled"], detail["incidents"]


def check_live(root: Path) -> None:
    """A transcript that grows between polls, then finishes with a verdict."""
    sub = root / "-p/s1/subagents"
    sub.mkdir(parents=True)
    meta, jsonl = sub / "agent-x.meta.json", sub / "agent-x.jsonl"
    (root / "-p/s1.jsonl").write_text(json.dumps({"timestamp": "2026-01-01T10:00:00Z", "message": {
        "role": "assistant", "content": [{"type": "tool_use", "id": "o1", "name": "Bash", "input": {"command": "make test"}}]}}) + "\n")
    meta.write_text(json.dumps({"description": "dev-loop r1 reviewer", "model": "claude-opus-5-5", "agentType": "dev-loop:reviewer"}))
    first = [{"timestamp": "2026-01-01T10:00:00Z", "cwd": "/p", "message": {"role": "user", "content": "state .claude/dev-loop/t9.md"}},
             {"timestamp": "2026-01-01T10:00:05Z", "message": {"role": "assistant", "id": "m1", "usage": U, "content": [
                 {"type": "tool_use", "id": "u1", "name": "Read", "input": {"file_path": "/p/a.py"}}]}}]
    jsonl.write_text("\n".join(json.dumps(x) for x in first) + "\n" + '{"timestamp": "2026-01-01T10:00:0')  # half a line
    live = Live(root)
    prices = {"claude-opus-5-5": {"input": 4, "cache_write": 5, "cache_read": 0.2, "output": 20}}
    run = live.poll(prices)["runs"][0]
    a = run["agents"][0]
    assert (run["task"], a["role"], a["round"], a["status"], a["tool_calls"]) == ("t9", "reviewer", 1, "running", 1), a
    assert a["recent"][0] == {"at": "2026-01-01T10:00:05Z", "tool": "Read", "target": "/p/a.py"}, a["recent"]
    assert a["context"] == 10001 and run["orchestrator"]["last"]["target"] == "make test", (a, run)
    report = 'Done.\n```json\n{"verdict": "changes", "blocking": [{"id": "R1"}], "nits": []}\n```'
    with jsonl.open("a") as f:  # finishes the half line, then the handback
        f.write('6Z", "message": {"role": "assistant", "id": "m2", "usage": ' + json.dumps(U) + ', "content": [{"type": '
                '"tool_use", "id": "u2", "name": "SubagentHandback", "input": {"message": ' + json.dumps(report) + '}}]}}\n')
    meta.write_text(json.dumps({"description": "dev-loop r1 reviewer", "model": "claude-opus-5-5", "finished": True}))
    a = live.poll(prices)["runs"][0]["agents"][0]
    assert (a["status"], a["verdict"], a["blocking"], a["tool_calls"]) == ("done", "changes", 1, 2), a
    assert a["usd"] == round((2 * 4 + 2000 * 5 + 18000 * 0.2 + 200 * 20) / 1e6, 4), a


def check_untagged(root: Path) -> None:
    """An agent whose description loses the dev-loop tag after it was read drops out instead of breaking the poll."""
    agent(root / "-p/s3/subagents", "x", "critic", [("Read", "/p/a.py")])
    live = Live(root)
    assert len(live.poll({})["runs"]) == 1
    meta = root / "-p/s3/subagents/agent-x.meta.json"
    meta.write_text(json.dumps({"description": "something else"}))
    assert live.poll({})["runs"] == []


def check_status(root: Path) -> None:
    """No agent running and no run record: running while the task's state file changes, then no record."""
    state = root / ".claude/dev-loop/t9.md"
    state.parent.mkdir(parents=True)
    state.write_text("brief")
    r = {"cwd": str(root), "task": "t9", "running": 0}
    now = time.time()
    assert app.run_status(r, None, now) == "running"
    assert app.run_status(r, None, now + app.QUIET_TASK + 1) == "no record"
    assert app.run_status(r | {"running": 1}, None, now + 1e6) == "running"
    assert app.run_status(r, {"outcome": "approved"}, now) == "approved"
    assert app.run_status(r | {"task": None}, None, now) == "no record"


def agent(sub: Path, name: str, role: str, calls: list, stopped=False, age=0) -> None:
    """A running agent with these (tool, target) calls; `age` seconds since its transcript last changed."""
    sub.mkdir(parents=True, exist_ok=True)
    lines = [{"timestamp": "2026-01-01T10:00:00Z", "cwd": "/p", "message": {"role": "user", "content": ".claude/dev-loop/t9.md"}}]
    for i, (tool, target) in enumerate(calls):
        lines.append({"timestamp": "2026-01-01T10:01:00Z", "message": {"role": "assistant", "id": f"{name}{i}", "usage": U,
                      "content": [{"type": "tool_use", "id": f"{name}u{i}", "name": tool, "input": {"file_path": target}}]}})
    if stopped:
        lines.append({"timestamp": "2026-01-01T10:02:00Z", "message": {"role": "user", "content": [
            {"type": "text", "text": "[Request interrupted by user for tool use]"}]}})
    jsonl = sub / f"agent-{name}.jsonl"
    jsonl.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    (sub / f"agent-{name}.meta.json").write_text(json.dumps({"description": f"dev-loop r1 {role}", "model": "claude-opus-5-5"}))
    if age:
        t = time.time() - age
        os.utime(jsonl, (t, t))


def check_watch(root: Path) -> None:
    """One agent per kind of trouble, one healthy, one stopped; each event once."""
    sub = root / "-p/s2/subagents"
    agent(sub, "loop", "reviewer", [("Read", "/p/x.py")] * 5)
    agent(sub, "busy", "implementer", [("Read", f"/p/{i}.py") for i in range(6)])
    agent(sub, "quiet", "critic", [("Read", "/p/y.py")], age=31 * 60)
    agent(sub, "ok", "security", [("Read", "/p/a.py"), ("Grep", "/p")])
    agent(sub, "gone", "refiner", [("Read", "/p/z.py")] * 5, stopped=True)
    live = Live(root)
    run = live.poll({})["runs"][0]
    gone = next(a for a in run["agents"] if a["id"] == "agent-gone")
    assert gone["status"] == "stopped", gone
    limits = watch.LIMITS | {"maxToolCalls": 5}
    w = watch.Watch("/p", "t9", None, limits)
    got = {(e["agent"], e["kind"]) for e in w.events(run, time.time())}
    assert got == {("loop", "looping"), ("busy", "tool_calls"), ("quiet", "stalled")}, got
    assert w.events(run, time.time()) == [], "each event once"


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        db, transcripts = tmp / "h.db", tmp / "projects"
        transcripts.mkdir()
        fixture(db)
        store = app.Store(db, transcripts)
        check_quality(store)
        check_live(tmp / "live")
        check_watch(tmp / "watch")
        check_untagged(tmp / "untagged")
        check_status(tmp / "status")
        print("ok")
        if sys.argv[1:2] == ["--serve"]:
            sys.argv = ["app.py", "--db", str(db), "--transcripts", str(transcripts), "--port", sys.argv[2]]
            app.main()
