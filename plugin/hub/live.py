"""Live state of the dev-loop agents, read from Claude Code's transcripts as they grow.

A subagent writes ~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl while it works, next to a
.meta.json whose `finished` turns true when it ends. Each poll reads only the bytes added since the last one.
Only names of tools and paths leave this module, never what the transcripts say, apart from the agent's
final JSON block (its verdict or its list of changes).
"""
import json
import re
import time
from pathlib import Path

from ingest import TAG, TASK

WINDOW = 12 * 3600      # agents active in the last 12 hours
STALE = 30 * 60         # an unfinished agent silent this long is shown as stale
TAIL = 256 * 1024       # bytes read from the end of the orchestrator's transcript


def target(tool: dict) -> str:
    """A short label of what a tool call works on: a path, a command, a pattern."""
    i = tool.get("input") or {}
    for key in ("file_path", "path", "notebook_path", "pattern", "url", "description", "command", "query"):
        if isinstance(i.get(key), str) and i[key]:
            return i[key].splitlines()[0][:120]
    return ""


def last_json(text: str):
    """The last JSON object in a report: the block the dev-loop agents end with."""
    dec, found, end = json.JSONDecoder(), None, 0
    for m in re.finditer(r"\{\s*\"", text):
        if m.start() < end:
            continue  # inside the object already read
        try:
            obj, end = dec.raw_decode(text, m.start())
        except ValueError:
            continue
        found = obj
    return found


class Agent:
    def __init__(self, meta: Path):
        self.meta, self.jsonl = meta, meta.with_name(meta.name.replace(".meta.json", ".jsonl"))
        self.id, self.session = self.jsonl.stem, meta.parent.parent.name
        self.project_dir = meta.parent.parent.parent
        self.offset, self.rest = 0, b""
        self.usage, self.tools, self.recent = {}, set(), []
        self.first = self.last = self.cwd = self.task = self.report = None
        self.compactions, self.context, self.stopped = 0, 0, False
        self.info = {}

    def read(self) -> None:
        self.info = json.loads(self.meta.read_text())
        if not self.jsonl.exists():
            return
        with self.jsonl.open("rb") as f:
            f.seek(self.offset)
            data = self.rest + f.read()
        self.offset += len(data) - len(self.rest)
        *lines, self.rest = data.split(b"\n")  # a half-written last line waits for the next poll
        for raw in lines:
            if raw.strip():
                self.line(json.loads(raw))

    def line(self, d: dict) -> None:
        ts = d.get("timestamp")
        if ts:
            self.first = self.first or ts
            self.last = ts
        self.cwd = self.cwd or d.get("cwd")
        if d.get("type") == "system" and d.get("subtype") == "compact_boundary":
            self.compactions += 1
        m = d.get("message")
        if not isinstance(m, dict):
            return
        if m.get("role") == "user" and "[Request interrupted by user" in json.dumps(m.get("content")):
            self.stopped = True  # TaskStop, or the user pressing Esc; meta.json never gets `finished` then
        if self.task is None and m.get("role") == "user":
            found = TASK.search(json.dumps(m.get("content")))
            self.task = found.group(1) if found else None
        if m.get("usage"):
            u = m["usage"]
            self.usage[m.get("id") or d.get("uuid")] = u
            self.context = (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                            + u.get("cache_read_input_tokens", 0))
        if m.get("role") == "assistant" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use" and b.get("id") not in self.tools:
                    self.tools.add(b.get("id"))
                    if b.get("name") == "SubagentHandback":
                        self.report = (b.get("input") or {}).get("message")
                    else:
                        self.recent = (self.recent + [{"at": ts, "tool": b.get("name"), "target": target(b)}])[-15:]
                elif b.get("type") == "text" and b.get("text"):
                    self.report = b["text"]

    def state(self, now: float, prices: dict) -> dict:
        tag = TAG.match(self.info.get("description", ""))
        sums = {k: sum(u.get(f, 0) for u in self.usage.values()) for k, f in
                [("input", "input_tokens"), ("cache_write", "cache_creation_input_tokens"),
                 ("cache_read", "cache_read_input_tokens"), ("output", "output_tokens")]}
        price = prices.get(self.info.get("model"))
        usd = round(sum(sums[k] * price[k] for k in sums) / 1e6, 4) if price else None
        finished = bool(self.info.get("finished"))
        quiet = now - self.jsonl.stat().st_mtime if self.jsonl.exists() else 0
        status = "done" if finished else "stopped" if self.stopped else "stale" if quiet > STALE else "running"
        result = last_json(self.report) if finished and self.report else None
        return {"id": self.id, "session": self.session, "round": int(tag[1]), "role": tag[2],
                "model": self.info.get("model"), "type": self.info.get("agentType"), "status": status,
                "started": self.first, "last": self.last, "cwd": self.cwd, "task": self.task,
                "tool_calls": len(self.tools - {None}), "compactions": self.compactions, "context": self.context,
                "quiet": round(quiet),
                **sums, "usd": usd, "recent": self.recent[::-1] if status in ("running", "stale") else self.recent[-1:],
                "verdict": (result or {}).get("verdict"),
                "blocking": len((result or {}).get("blocking") or []) if result and "blocking" in result else None,
                "result": result}


class Live:
    def __init__(self, transcripts: Path):
        self.root, self.agents, self.parents = transcripts, {}, {}

    def poll(self, prices: dict) -> dict:
        now = time.time()
        for meta in self.root.glob("*/*/subagents/*.meta.json"):
            try:
                mtime = meta.stat().st_mtime
                jsonl = meta.with_name(meta.name.replace(".meta.json", ".jsonl"))
                if jsonl.exists():
                    mtime = max(mtime, jsonl.stat().st_mtime)
                if now - mtime > WINDOW:
                    self.agents.pop(meta, None)
                    continue
                if meta not in self.agents:
                    info = json.loads(meta.read_text())
                    if not TAG.match(info.get("description", "")):
                        continue
                    self.agents[meta] = Agent(meta)
                self.agents[meta].read()
                if not TAG.match(self.agents[meta].info.get("description", "")):
                    self.agents.pop(meta)  # its description changed after the first read
            except (OSError, ValueError):
                continue  # a file being written or removed; the next poll sees it whole
        agents = [a.state(now, prices) | {"_parent": a.project_dir / f"{a.session}.jsonl"}
                  for a in self.agents.values() if a.info]
        return self.group(agents, now)

    def orchestrator(self, path: Path) -> dict | None:
        """The last tool call of the session that runs the loop."""
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None
        cached = self.parents.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        last = None
        with path.open("rb") as f:
            start = max(0, path.stat().st_size - TAIL)
            f.seek(start)
            lines = f.read().split(b"\n")
            for raw in lines[1:] if start else lines:  # past the start, the first line is cut
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                m = d.get("message")
                if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("content"), list):
                    for b in m["content"]:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            last = {"at": d.get("timestamp"), "tool": b.get("name"), "target": target(b)}
        state = {"last": last, "quiet": round(time.time() - mtime)}
        self.parents[path] = (mtime, state)
        return state

    def group(self, agents: list, now: float) -> dict:
        runs = {}
        for a in agents:
            parent = a.pop("_parent")
            key = f"{a['cwd']}|{a['task'] or a['session']}"
            r = runs.setdefault(key, {"key": key, "cwd": a["cwd"], "project": Path(a["cwd"] or "?").name,
                                      "task": a["task"], "session": a["session"], "agents": [], "_parent": parent})
            r["agents"].append(a)
        out = []
        for r in runs.values():
            ags = sorted(r["agents"], key=lambda a: a["started"] or "")
            r["agents"] = ags
            r["started"], r["last"] = ags[0]["started"], max(a["last"] or "" for a in ags)
            r["round"] = max(a["round"] for a in ags)
            r["usd"] = round(sum(a["usd"] or 0 for a in ags), 2)
            r["running"] = sum(a["status"] == "running" for a in ags)
            r["orchestrator"] = self.orchestrator(r.pop("_parent"))
            out.append(r)
        return {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                "runs": sorted(out, key=lambda r: r["last"] or "", reverse=True)}
