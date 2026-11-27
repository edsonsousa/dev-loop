"""Run: python3 test_ingest.py"""
import json
import sqlite3
import subprocess
import tempfile
from pathlib import Path

import ingest

U = {"input_tokens": 1, "cache_creation_input_tokens": 10, "cache_read_input_tokens": 100, "output_tokens": 5}


def sh(cwd, *cmd):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True)


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    # A project where the loop changed a.txt, then main changed it again after approval.
    proj = tmp / "proj"
    proj.mkdir()
    sh(proj, "git", "init", "-q", "-b", "main")
    sh(proj, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base")
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=proj, capture_output=True, text=True).stdout.strip()
    (proj / "a.txt").write_text("loop\n")
    sh(proj, "git", "add", "a.txt")
    sh(proj, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "loop work")
    snap = subprocess.run(["git", "rev-parse", "HEAD"], cwd=proj, capture_output=True, text=True).stdout.strip()
    (proj / "a.txt").write_text("loop\nhuman fix\n")
    sh(proj, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "human fix")

    (proj / ".claude/dev-loop").mkdir(parents=True)
    run = {"task": "t1", "started": "2026-01-01T10:00:00Z", "ended": "2026-01-01T11:00:00Z", "base": base,
           "snapshot": snap, "outcome": "approved", "rounds": 1, "files": ["a.txt"],
           "gates": [{"round": 0, "command": "make", "passed": False}, {"round": 0, "command": "make", "passed": True}],
           "findings": [{"id": "R1", "role": "reviewer", "round": 1, "blocking": True, "outcome": "fixed"},
                        {"id": "S1", "role": "security", "round": 1, "blocking": True, "outcome": "fixed",
                         "duplicateOf": "R1"},
                        {"id": "C1-n1", "role": "critic", "round": 1, "blocking": False, "outcome": "nit"}],
           "incidents": [{"round": 1, "role": "critic", "agent": "a9", "kind": "stalled", "detail": "quiet 31 min",
                          "at": "2026-01-01T10:40:00Z", "action": "rerun"}]}
    (proj / ".claude/dev-loop/t1.run.json").write_text(json.dumps(run))

    # One dev-loop agent (its usage written twice for one message) and one unrelated agent.
    sub = tmp / "projects/-proj/session-1/subagents"
    sub.mkdir(parents=True)
    lines = [
        {"timestamp": "2026-01-01T10:05:00Z", "cwd": str(proj),
         "message": {"role": "user", "content": "Brief in .claude/dev-loop/t1.md"}},
        {"timestamp": "2026-01-01T10:05:10Z", "message": {"role": "assistant", "id": "m1", "usage": U,
                                                          "content": [{"type": "tool_use", "id": "x1"}]}},
        {"timestamp": "2026-01-01T10:05:10Z", "message": {"role": "assistant", "id": "m1", "usage": U}},
        {"type": "system", "subtype": "compact_boundary", "timestamp": "2026-01-01T10:06:00Z"},
        {"timestamp": "2026-01-01T10:07:00Z", "message": {"role": "assistant", "id": "m2", "usage": U}},
    ]
    (sub / "agent-a1.jsonl").write_text("\n".join(json.dumps(x) for x in lines))
    (sub / "agent-a1.meta.json").write_text(json.dumps(
        {"agentType": "dev-loop:reviewer", "description": "dev-loop r1 reviewer", "model": "claude-opus-5-5"}))
    (sub / "agent-a2.jsonl").write_text(json.dumps(lines[0]))
    (sub / "agent-a2.meta.json").write_text(json.dumps({"agentType": "Explore", "description": "look around"}))

    db = tmp / "h.db"
    for _ in range(2):  # a second ingest changes nothing
        con = ingest.connect(db)
        with con:
            for p in ingest.ingest_agents(con, tmp / "projects"):
                ingest.ingest_runs(con, Path(p))

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    a = dict(con.execute("SELECT * FROM agent_run").fetchone())
    assert con.execute("SELECT count(*) FROM agent_run").fetchone()[0] == 1, "only dev-loop agents"
    assert (a["input"], a["cache_write"], a["cache_read"], a["output"], a["api_calls"]) == (2, 20, 200, 10, 2), a
    assert (a["tool_calls"], a["compactions"], a["peak_context"], a["seconds"]) == (1, 1, 111, 120.0), a
    assert a["run_id"] == 1 and a["task"] == "t1", a

    s = dict(con.execute("SELECT * FROM run_summary").fetchone())
    assert (s["blocking"], s["nits"], s["gate_failures"]) == (2, 1, 1), s
    assert s["usd"] == round((2 * 4 + 20 * 5 + 200 * 0.2 + 10 * 20) / 1e6, 2), s
    assert (s["merged"], s["drift_lines"], s["incidents"]) == (1, 1, 1), s
    i = dict(con.execute("SELECT * FROM incident").fetchone())
    assert (i["role"], i["agent_id"], i["kind"], i["action"]) == ("critic", "a9", "stalled", "rerun"), i

    sec = dict(con.execute("SELECT * FROM role_value WHERE role = 'security'").fetchone())
    assert (sec["blocking"], sec["fixed"], sec["duplicate"]) == (1, 1, 1), sec
print("ok")
