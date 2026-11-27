-- dev-loop history. Created by ingest.py; every statement is idempotent.

CREATE TABLE IF NOT EXISTS project (
  id   INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

-- One /dev-loop:run, from <project>/.claude/dev-loop/<task>.run.json.
CREATE TABLE IF NOT EXISTS run (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES project(id),
  task          TEXT NOT NULL,
  title         TEXT,
  started       TEXT NOT NULL,   -- ISO 8601
  ended         TEXT,
  base          TEXT,
  branch        TEXT,
  main_branch   TEXT,
  snapshot      TEXT,            -- git ref holding the code as the loop left it
  outcome       TEXT,            -- approved | escalated
  escalation    TEXT,
  rounds        INTEGER,
  sensitive     TEXT,            -- JSON list of paths
  files         TEXT,            -- JSON list of paths
  UNIQUE (project_id, task, started)
);

CREATE TABLE IF NOT EXISTS gate_run (
  run_id   INTEGER NOT NULL REFERENCES run(id),
  seq      INTEGER NOT NULL,
  round    INTEGER,
  command  TEXT,
  passed   INTEGER,
  seconds  REAL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS finding (
  run_id        INTEGER NOT NULL REFERENCES run(id),
  finding_id    TEXT NOT NULL,   -- R1, C2, S1
  role          TEXT NOT NULL,   -- reviewer | critic | security
  round         INTEGER,
  blocking      INTEGER NOT NULL,
  file          TEXT,
  line          INTEGER,
  issue         TEXT,
  outcome       TEXT,            -- fixed | rejected-upheld | rejected-overruled | open | nit
  closed_round  INTEGER,
  duplicate_of  TEXT,            -- another finding_id of the same run
  PRIMARY KEY (run_id, finding_id)
);

-- An agent the orchestrator stopped or worked around: stalled, looping, over budget (from the watchdog).
CREATE TABLE IF NOT EXISTS incident (
  run_id    INTEGER NOT NULL REFERENCES run(id),
  seq       INTEGER NOT NULL,
  round     INTEGER,
  role      TEXT,
  agent_id  TEXT,
  kind      TEXT,             -- stalled | looping | tool_calls | compacted | budget
  detail    TEXT,
  at        TEXT,
  action    TEXT,             -- rerun | continued | no-verdict | escalated
  PRIMARY KEY (run_id, seq)
);

-- One subagent, from ~/.claude/projects/*/<session>/subagents/agent-*.{jsonl,meta.json}.
-- Kept after Claude Code deletes old transcripts.
CREATE TABLE IF NOT EXISTS agent_run (
  agent_id      TEXT PRIMARY KEY,
  run_id        INTEGER REFERENCES run(id),
  project_id    INTEGER REFERENCES project(id),
  session       TEXT,
  task          TEXT,
  round         INTEGER,
  role          TEXT,
  type          TEXT,
  model         TEXT,
  started       TEXT,
  ended         TEXT,
  seconds       REAL,
  tool_calls    INTEGER,
  api_calls     INTEGER,
  compactions   INTEGER,
  peak_context  INTEGER,         -- largest single request, in tokens
  input         INTEGER,
  cache_write   INTEGER,
  cache_read    INTEGER,
  output        INTEGER
);

-- What happened to a run's files on the main branch after the loop. class is set by /dev-loop:retro.
CREATE TABLE IF NOT EXISTS post_merge (
  run_id       INTEGER PRIMARY KEY REFERENCES run(id),
  checked      TEXT,
  merged       INTEGER,          -- 1 when main changed the run's files after base
  commits      TEXT,             -- JSON list of "sha subject"
  drift_files  INTEGER,          -- files that differ between the loop's snapshot and main
  drift_lines  INTEGER,          -- lines added + removed between them
  class        TEXT,
  note         TEXT
);

-- USD per million tokens. Edit to match your plan; costs are estimates.
CREATE TABLE IF NOT EXISTS price (
  model        TEXT PRIMARY KEY,
  input        REAL,
  cache_write  REAL,
  cache_read   REAL,
  output       REAL
);
INSERT OR IGNORE INTO price VALUES
  ('claude-fable-5-2',  8.00, 10.00,  0.20, 40.00),
  ('claude-opus-5-5',   4.00,  5.00,  0.20, 20.00),
  ('claude-sonnet-5-5', 2.00,  2.50,  0.10, 10.00),
  ('claude-haiku-5-5',  0.10,  0.125, 0.01,  0.50);

-- Version of the loop's agents and skills (a hash of their files) the run used; label it to name an experiment.
CREATE TABLE IF NOT EXISTS loop_version (
  version     TEXT PRIMARY KEY,
  first_seen  TEXT,
  label       TEXT
);
