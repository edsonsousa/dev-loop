---
name: run
description: Runs one development task through an agent loop - implementer, deterministic gate, reviewer and critic in parallel, a second implementer that resolves their findings - until both approve or the round limit is hit. Only when the user types /dev-loop:run.
argument-hint: <task description or tracker task id>
disable-model-invocation: true
---

# dev-loop:run

You are the orchestrator. You run in the main conversation because subagents cannot start subagents. You do not
write production code yourself: you plan, dispatch, run the gate, read verdicts and decide.

Task: $ARGUMENTS

Plugin folder: `${CLAUDE_PLUGIN_ROOT}` (if that text was not replaced by a path, find the folder with
`claude plugin list` under `dev-loop`). The history tools are in its sibling `hub/`.

## Project settings

Read `.claude/dev-loop.yml` in the repo root. It holds:

- `gate`: a list of `{when: <path prefix>, run: <command>}`; run the lines whose prefix the diff touches, from the repo root.
- `sensitive`: path prefixes or file name patterns that need human review and add the security reviewer.
- `securityReviewer`: the agent type to call for sensitive paths (omit to skip).
- `onApproval`: what to do in the project once a run is approved (e.g. a tracker update).
- `mutation`: optional, a list like `gate`; `{files}` in `run` is replaced by the changed source files under `when`
  (tests excluded), comma-separated, relative to the folder the command `cd`s into.
- `resources`: optional, `{minFreeGb: 4, maxGb: <60% of RAM>, waitMinutes: 8, timeoutMinutes: 20}`, read by
  `heavy.sh`.
- `watch`: optional, the watchdog's limits per agent, `{stallMinutes: 30, repeat: 5, maxToolCalls: 150,
  maxCompactions: 2, maxUsd: 5}`.
- `roundLimit` (default 3) and `mainBranch` (default `main`).

If the file is missing, stop and offer to write it from the project's CLAUDE.md (its build and test commands, and
any paths it says need human review). Do not guess the gate.

## Rules

- The agents are `dev-loop:implementer`, `dev-loop:reviewer`, `dev-loop:critic`, `dev-loop:refiner`.
- Each subagent call passes `description: "dev-loop r<round> <role>"` (round 0 for the first implementer, and
  `<role>` one of implementer, gate-fix, reviewer, critic, security, refiner). The live pane and the history read it.
- Each prompt names the state file `.claude/dev-loop/<task-slug>.md`; the history links agents to the run by it.
- Reviewers get the brief and the diff, never the implementer's reasoning or replies.
- Only blocking findings keep the loop going. Nits go into the final summary.
- Never commit, push, merge, or approve anything on the user's behalf.
- Every gate, mutation and test command, yours or an agent's, runs as
  `${CLAUDE_PLUGIN_ROOT}/skills/run/heavy.sh '<command>'` (HEAVY below): one at a time on the machine, when memory
  allows, under a memory cap. Its exit 75 (busy or low memory) and 137 (killed at the cap) are not test results:
  wait a minute and run it again once; a second time, escalate with that reason. Never send them to a gate fix.
  Exit 124 means the command ran past `timeoutMinutes` and was killed with everything it started. The change may
  have caused the hang, so it is a gate failure: the gate fix gets "timed out after N s" with the last 80 lines.
- Run HEAVY with Bash `run_in_background: true` and wait for its completion notice: with the queue and the time
  limit it can pass the 10-minute limit of a foreground Bash call, which would kill it halfway.

## Watchdog

Every subagent call runs in the background. Right after the calls of a step (the implementer, a gate fix, the
round's reviewers, the refiner), arm a `Monitor` with timeout 1800000 and the command
`python3 ${CLAUDE_PLUGIN_ROOT}/../hub/watch.py --cwd <repo root> --task <task-slug> --round <N>`. Re-arm it when
it expires while those agents still run. Each line it prints is one agent in trouble:
`{"agent", "role", "round", "kind", "detail", "at"}`, with kind `stalled`, `looping`, `tool_calls`, `compacted` or
`budget`. `{"kind": "no-agents"}` means it found none of the step's agents: check the `description` tags.

For each line:

1. Stop the agent: `TaskStop` with `agent` as `task_id`. It kills the agent's running command too.
2. Append the event and what you do next to the state file, and keep it for `incidents` in the run record.
3. Act by role. Never revert files yourself.
   - reviewer, critic, security: they change no files, so nothing is lost. Call the role again once, fresh, with
     one line saying the last try was stopped and why. A second incident for the role in this round counts as a
     reply without a verdict: `changes`, with "did not finish: <kind>" as its finding. Action `rerun`, then
     `no-verdict`.
   - implementer, refiner, gate fix: before each of these calls, keep the tree with
     `${CLAUDE_PLUGIN_ROOT}/skills/run/snapshot.sh <task-slug>--r<N>-<role> BASE`, which writes the ref
     `refs/dev-loop/<task-slug>--r<N>-<role>`. After a stop, run the gate on what is there. Then call the refiner
     with the brief, the open findings or the gate output, the stop and its reason, and the diff of what the
     stopped agent did (`git diff refs/dev-loop/<task-slug>--r<N>-<role>` plus new files), to finish from there.
     Action `continued`. A second incident for a writing role in the same round escalates (action `escalated`),
     with that ref in the report so the user can compare or restore.
4. Incidents do not count as rounds or as gate failures.

## Steps

### 0. Brief

1. Note the start time as STARTED (`date -u +%Y-%m-%dT%H:%M:%SZ`) and the loop's version as LOOP
   (`${CLAUDE_PLUGIN_ROOT}/skills/run/version.sh`). Run `git rev-parse HEAD` and
   `git status --porcelain`. Keep the commit as BASE. If the tree has changes, list them and ask the user whether
   they belong to this task; the ones that do not are out of scope for every agent.
2. Read the task (from the tracker if it is an id), the project's CLAUDE.md, and the code it touches. If the task
   starts with `part of <slug>:`, it is one slice of an earlier run's split: keep `<slug>` as PARENT, read
   `.claude/dev-loop/<slug>.md` (its brief and its `## Split`), and take only this slice's criteria.
3. Write the brief: goal, acceptance criteria (each one testable), out-of-scope files, the gate lines that apply.
   Name HEAVY with its full path in the brief, as the way to run any command in it, in the background as above.
   Say there that its exit 75 or 137 means a busy machine, not a failing test: wait a minute, run it again once,
   then report it. Exit 124 means it hung: find out why, as with a failing test.
   If the task is ambiguous, ask the user now. Do not start with a guess.
   Then show the user, in your own words, the goal and the problem it solves in two or three sentences, the
   acceptance criteria and what is out of scope, and wait for their confirmation or corrections. Do not call the
   implementer before they confirm: a misread brief costs every round after it.
4. Create `.claude/dev-loop/<task-slug>.md` with the brief, BASE and a `## Rounds` heading. Append to it after
   every step from here on: who ran, the gate result, each verdict JSON, the refiner's answer.

### 1. Implement (round 0)

Call `dev-loop:implementer` with the brief.

### 2. Gate

Run the gate lines yourself, each through HEAVY, and note each result and how long it took. Then run
`${CLAUDE_PLUGIN_ROOT}/skills/run/weakening.sh BASE <in-scope changed files>` as one more gate line: it fails on
skipped or deleted tests, removed assertions, new lint or type suppressions and edited check configs. If the
brief itself asks for one of those, note it in the state file and count that line as passed.

If a gate line fails, call `dev-loop:implementer` (round 0) or `dev-loop:refiner` (later rounds) with role
`gate-fix`, the brief and the last 80 lines of the failure, then run the gate again. A gate fix does not count as a round. After 3 gate failures in a row, stop and
escalate.

### 3. Review (round N, starting at 1)

First, on the in-scope changed files:

- `HEAVY '${CLAUDE_PLUGIN_ROOT}/skills/run/scan.sh <files>'` (Semgrep and gitleaks, local). Its output goes to the security
  reviewer when one is called, otherwise to the reviewer. It is input, not a gate: the reviewer decides.
- The `mutation` lines whose `when` the diff touches, through HEAVY. Pass the surviving mutants to the reviewer, the
  ones on changed lines only.

The diff is `git diff BASE` plus the new files from `git ls-files --others --exclude-standard`, minus the
out-of-scope files. In one message, call in parallel:

- `dev-loop:reviewer` and `dev-loop:critic`, each with the brief, those two commands, the gate lines that passed
  (so they do not rerun the suite), and from round 2 on the
  previous round's findings with the refiner's `fixed` and `rejected` lists. The reviewer also gets the
  implementer's `criteria` map and the mutation survivors.
- The `securityReviewer` agent, only if the diff touches a sensitive path, with the same input, the scan output,
  and: "Cover tenant isolation, auth, vault and secrets; correctness and design belong to two other reviewers.
  Every blocking finding needs `evidence`: a command and its output, a failing test, or the quoted lines. A
  blocking finding also names the lower-trust principal and the input it controls, the control that should stop
  it, the trust boundary crossed, and the affected principal or resource with the concrete result; a missing best
  practice or defense-in-depth advice with no reachable boundary violation is a nit. At most
  five nits. End your reply with this JSON block, nothing after it: `{"verdict": "approve" or "changes",
  "blocking": [{"id": "S1", "file", "line", "issue", "evidence", "fix"}], "nits": []}`. `verdict` is exactly
  `approve` when `blocking` is empty, otherwise exactly `changes`."

Parse the JSON block at the end of each reply. A reply without a parsable block, or with a verdict other than
`approve` or `changes`, is called again once; a second miss counts as `changes` with that problem as its finding.
A blocking finding with no `evidence` counts as a nit. When two roles report the same issue, the first in the order
reviewer, critic, security keeps it and the others are marked as its duplicate (`S1=R1`).

### 4. Decide

- All verdicts `approve`: go to step 6.
- A blocking finding id that was listed as `fixed` in an earlier round is back for the second time, or two rounds
  in a row raised the same issue under new ids: the loop is stuck. Go to step 6 as escalated.
- Round N equals the round limit: go to step 6 as escalated.
- Otherwise go to step 5.

### 5. Refine

Call `dev-loop:refiner` with the brief, the diff commands and every blocking finding of this round. Then go to step
2 and, after the gate passes, to step 3 with N + 1.

### 6. Report and record

Write a short summary for the user, also appended to the state file:

- Outcome: approved in N rounds, or escalated and why (the open findings, with file:line).
- Files changed, and the gate that passed.
- The nits, grouped, for the user to take or drop.
- If a sensitive path changed: "Needs human review: <paths>". Agent approval does not replace it.
- If escalated (stuck, round limit or 3 gate failures): a split proposal, also written to the state file under
  `## Split`. Split only when the open findings or failures sit in parts that can be built and tested on their
  own:
  - vertical slices, each with its own acceptance criteria and tests, never one slice per layer;
  - every criterion of the brief in exactly one slice;
  - a sensitive path in a slice of its own, so the human review stays small;
  - at most four slices, ordered so each builds on the ones before.

  For each slice give one line to start it: `/dev-loop:run part of <task-slug>: <goal> (AC…)`. When the problem
  is a disagreement or the parts only work together, say why no split helps instead. Start no slice yourself:
  the user decides, and the escalated change is still in the tree for them to keep or drop.
- On approval, do what `onApproval` says.

Then record the run, approved or escalated alike:

1. `SNAPSHOT=$(${CLAUDE_PLUGIN_ROOT}/skills/run/snapshot.sh <task-slug> BASE)`: keeps the code as the loop left it
   under `refs/dev-loop/<task-slug>`, touching no file, index or branch.
2. Write `.claude/dev-loop/<task-slug>.run.json`:

```json
{
  "task": "<task-slug>", "title": "<one line>", "started": "STARTED", "ended": "<now, same format>",
  "base": "BASE", "branch": "<branch>", "mainBranch": "<from settings>", "snapshot": "SNAPSHOT",
  "outcome": "approved | escalated", "escalation": "why, or null", "rounds": 2, "loopVersion": "LOOP",
  "parent": "PARENT or null", "split": "after | none",
  "incidents": [{"round": 1, "role": "critic", "agent": "<id>", "kind": "stalled", "detail": "...",
                 "at": "<time>", "action": "rerun | continued | no-verdict | escalated"}],
  "mutation": {"score": 91.3, "survived": 4}, "scan": {"findings": 0}, "weakening": ["each line it reported"],
  "sensitive": ["changed sensitive paths"], "files": ["every changed path, out-of-scope ones excluded"],
  "gates": [{"round": 0, "command": "...", "passed": true, "seconds": 95, "exit": 0}],
  "findings": [
    {"id": "R1", "role": "reviewer", "round": 1, "blocking": true, "file": "path", "line": 12, "issue": "...",
     "evidence": "...", "outcome": "fixed | rejected-upheld | rejected-overruled | open", "closedRound": 2, "duplicateOf": null},
    {"id": "C1-n1", "role": "critic", "round": 1, "blocking": false, "issue": "...", "outcome": "nit"}
  ]
}
```

   One entry per gate run, failed ones included. Every blocking finding once, under the id it was first raised
   with; `rejected-upheld` is a rejection the next round accepted, `rejected-overruled` one it did not. Every nit,
   with an id `<role letter><round>-n<k>`. `mutation` is the last mutation run (its overall score and the survivors
   on changed lines), `scan` the last scan, `weakening` every line `weakening.sh` reported in the run; leave out
   the ones that did not run. `split` is `after` when the report proposed slices, otherwise `none`.
3. `python3 ${CLAUDE_PLUGIN_ROOT}/../hub/ingest.py` to add it to the history. If it fails, show the error and go
   on: the run file is enough to ingest later.

Do not commit. Offer to, in one line.
