"""Watchdog for one dev-loop task: prints one JSON line per agent in trouble, for the orchestrator's Monitor.

  python3 watch.py --cwd <repo> --task <slug> [--round N]

Kinds, each printed once per agent:
  stalled     its transcript has not changed for `stallMinutes`. Commands run through heavy.sh have their own
              limits, so the default sits above waitMinutes + timeoutMinutes;
  looping     its last `repeat` tool calls are the same tool on the same target;
  tool_calls  more than `maxToolCalls` tool calls;
  compacted   `maxCompactions` compactions or more: its context keeps overflowing;
  budget      it cost more than `maxUsd`.
Limits come from `watch:` in <repo>/.claude/dev-loop.yml. The script exits when the agents it saw have all ended,
or prints {"kind": "no-agents"} and exits when none of the task's agents shows up within two minutes.
"""
import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

from ingest import DEFAULT_DB, DEFAULT_TRANSCRIPTS
from live import Live

LIMITS = {"stallMinutes": 30, "repeat": 5, "maxToolCalls": 150, "maxCompactions": 2, "maxUsd": 5.0}
ACTIVE = ("running", "stale")


def limits(cwd: str) -> dict:
    """The numbers under `watch:` in the project's settings, over the defaults."""
    out, inside = dict(LIMITS), False
    try:
        lines = (Path(cwd) / ".claude/dev-loop.yml").read_text().splitlines()
    except OSError:
        return out
    for line in lines:
        if re.match(r"^\S", line):
            inside = line.startswith("watch:")
        m = re.match(r"^\s+(\w+):\s*([\d.]+)", line)
        if inside and m and m[1] in out:
            out[m[1]] = float(m[2])
    return out


def prices(db: Path) -> dict:
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        return {r["model"]: dict(r) for r in con.execute("SELECT * FROM price")}
    except sqlite3.Error:
        return {}  # no history yet: no budget check


class Watch:
    def __init__(self, cwd: str, task: str, round_: int | None, lim: dict):
        self.cwd, self.task, self.round, self.lim, self.sent = cwd, task, round_, lim, set()

    def trouble(self, a: dict) -> list[tuple[str, str]]:
        lim, recent = self.lim, a["recent"]
        n = int(lim["repeat"])
        out = []
        if a["quiet"] > lim["stallMinutes"] * 60:
            out.append(("stalled", f"no transcript change for {a['quiet'] // 60} min"))
        if len(recent) >= n and len({(r["tool"], r["target"]) for r in recent[:n]}) == 1:
            out.append(("looping", f"{n} times {recent[0]['tool']} {recent[0]['target']}"))
        if a["tool_calls"] > lim["maxToolCalls"]:
            out.append(("tool_calls", f"{a['tool_calls']} tool calls"))
        if a["compactions"] >= lim["maxCompactions"]:
            out.append(("compacted", f"{a['compactions']} compactions"))
        if a["usd"] is not None and a["usd"] > lim["maxUsd"]:
            out.append(("budget", f"US$ {a['usd']}"))
        return out

    def agents(self, run: dict) -> list[dict]:
        return [a for a in run["agents"] if self.round is None or a["round"] == self.round]

    def events(self, run: dict, now: float) -> list[dict]:
        out = []
        for a in self.agents(run):
            if a["status"] not in ACTIVE:
                continue
            for kind, detail in self.trouble(a):
                agent = a["id"].removeprefix("agent-")  # the id TaskStop takes
                if (agent, kind) not in self.sent:
                    self.sent.add((agent, kind))
                    out.append({"agent": agent, "role": a["role"], "round": a["round"], "kind": kind,
                                "detail": detail, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))})
        return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--round", type=int)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--transcripts", type=Path, default=DEFAULT_TRANSCRIPTS)
    ap.add_argument("--every", type=float, default=10)
    args = ap.parse_args()
    w, live, cost = Watch(args.cwd, args.task, args.round, limits(args.cwd)), Live(args.transcripts), prices(args.db)
    started, seen = time.time(), False
    while True:
        state = live.poll(cost)
        mine = [r for r in state["runs"] if r["cwd"] == args.cwd and r["task"] == args.task]
        agents = [a for r in mine for a in w.agents(r)]
        for r in mine:
            for e in w.events(r, time.time()):
                print(json.dumps(e), flush=True)
        if agents and all(a["status"] not in ACTIVE for a in agents):
            return
        seen = seen or bool(agents)
        if not seen and time.time() - started > 120:
            print(json.dumps({"kind": "no-agents", "task": args.task}), flush=True)
            return
        time.sleep(args.every)


if __name__ == "__main__":
    sys.exit(main())
