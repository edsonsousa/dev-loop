---
name: retro
description: Reviews past dev-loop runs from the history database - outcomes, value and cost of each role, what reached main after approval - and proposes concrete changes to the loop's agents and settings. Only when the user types /dev-loop:retro.
argument-hint: "[last N runs | since YYYY-MM-DD | all projects] (default: this project, all runs)"
disable-model-invocation: true
---

# dev-loop:retro

Evaluate how the dev-loop performed so the user can improve it. You read and report; you change no agent, skill or
settings file until the user picks a proposal.

Scope: $ARGUMENTS

## Data

1. Refresh the history: `python3 ${CLAUDE_PLUGIN_ROOT}/hub/ingest.py` (if `${CLAUDE_PLUGIN_ROOT}` was not replaced
   by a path, find the plugin folder with `claude plugin list`).
2. Query `~/.local/share/dev-loop/history.db` with `sqlite3` or `python3 -c`. Its schema is in `${CLAUDE_PLUGIN_ROOT}/hub/schema.sql`;
   start from the views `run_summary`, `role_value` and `agent_cost`, and the tables `finding`, `gate_run`,
   `post_merge`. Filter by `project.name` unless the scope says all projects.
3. Read a run's `.claude/dev-loop/<task>.md` or an agent transcript only to check a specific finding.

## Questions to answer

1. **Outcome**: runs approved vs escalated, average rounds, why escalations happened.
2. **Value per role**: per reviewer, critic, security: blocking findings that led to a fix, rejections upheld
   (false positives), duplicates of another role, cost per fix. A role that mostly duplicates or is mostly rejected
   is a candidate to cut or retarget.
3. **Missed by the loop** (the strongest signal): for each run with `post_merge.merged = 1`, read
   `git diff <snapshot> <mainBranch> -- <files>` in the project and the commits in `post_merge.commits`. Each change
   after the snapshot is something the loop missed, got wrong, or later unrelated work. Classify it and store it:
   `UPDATE post_merge SET class = 'bug|design|style|scope|unrelated', note = '...' WHERE run_id = ?`. Runs with
   `merged = 0` are not on main yet: say so.
4. **Cost**: USD and tokens per role and per round; which role costs most for the findings it yields; agents with
   `peak_context` near 300000 or with compactions.
5. **Protocol drift**: gate failures per run, findings without file and line, nits that keep coming back across
   runs (candidates for a rule in CLAUDE.md or a linter check).
6. **Errors into rules**: for each escaped bug (`post_merge.class = 'bug'`) and each nit repeated in two runs or
   more, prefer a check a machine runs over prose: a Semgrep rule in the project's `.semgrep/` (`scan.sh` runs it
   every round), a lint rule, or a regression test. Propose the rule with a snippet it flags and one it does not,
   and show `semgrep scan --config <rule> <snippet>` firing on the bad one. Only what no tool can express goes to
   CLAUDE.md as text.

## Report

Write `.claude/dev-loop/retro-<YYYY-MM-DD>.md` and show the user a short version:

- A table: runs, approved/escalated, average rounds, findings per role (fixed / false positive / duplicate), USD per role.
- What the loop missed, with the commit that fixed it.
- At most five proposals, each with its evidence and the exact change (agent file and lines, `.claude/dev-loop.yml`
  value, rule for CLAUDE.md). Rank by expected effect. No proposal without evidence from at least two runs, or one
  serious miss.
- Where to look: `${CLAUDE_PLUGIN_ROOT}/hub/serve.sh` opens the dashboard.

With fewer than three runs, say the data is too thin for changes and report only what was seen.
Agents and skills live in the plugin folder, shared by every project: a change there changes every project, so say
which projects' runs the evidence comes from.
