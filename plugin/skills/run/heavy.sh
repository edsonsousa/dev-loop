#!/usr/bin/env bash
# Runs a heavy command (gate, tests, mutation) so the machine stays usable:
#   - one at a time on this machine, across sessions and agents (flock);
#   - only when MemAvailable is above minFreeGb and memory pressure is low;
#   - under a memory cap (systemd user scope), so going over kills the command, not the desktop.
# Docker containers the command starts (Testcontainers) run under dockerd, outside the cap. They count against
# MemAvailable for the next command, and Ryuk removes them when the test JVM ends, even when the cap killed it.
# Usage: heavy.sh '<command>'
#   - with a time limit: a hung test or build gets TERM, then KILL 10 s later, with every process it started.
# Exit: the command's own code; 75 when the lock or memory did not free up in time; 137 when the cap killed it;
# 124 when it ran past the time limit.
# Settings: `resources:` in .claude/dev-loop.yml (minFreeGb, maxGb, waitMinutes, timeoutMinutes); DEV_LOOP_*
# variables win.
# Portable: the queue and the memory check need Linux (/proc, flock), the cap needs systemd. Elsewhere (macOS,
# Windows Git Bash) or with DEV_LOOP_NO_LIMITS=1 it only applies the time limit, when `timeout` or `gtimeout` exists.
set -uo pipefail
if [ -n "${DEV_LOOP_HEAVY:-}" ]; then exec bash -c "$*"; fi  # inside heavy.sh already: the lock is held

conf="$(git rev-parse --show-toplevel 2>/dev/null)/.claude/dev-loop.yml"
setting() { sed -n "s/^ *$1: *\([0-9.]*\).*/\1/p" "$conf" 2>/dev/null | head -1; }
timeout_min=$(setting timeoutMinutes)
timeout_s=${DEV_LOOP_TIMEOUT_SECONDS:-$(awk "BEGIN { print int(${timeout_min:-20} * 60) }")}

if [ -n "${DEV_LOOP_NO_LIMITS:-}" ] || [ ! -r /proc/meminfo ] || ! command -v flock > /dev/null; then
  export DEV_LOOP_HEAVY=1
  t=$(command -v timeout || command -v gtimeout || true)
  [ -n "$t" ] || exec bash -c "$*"
  "$t" -k 10 "$timeout_s" bash -c "$*"; rc=$?
  [ "$rc" = 124 ] && echo "dev-loop heavy: timed out after $timeout_s s" >&2
  exit $rc
fi

total_gb=$(awk '/^MemTotal/ { print $2 / 1048576 }' /proc/meminfo)
min_free=${DEV_LOOP_MIN_FREE_GB:-$(setting minFreeGb)}; min_free=${min_free:-4}
max_gb=${DEV_LOOP_MAX_GB:-$(setting maxGb)}; max_gb=${max_gb:-$(awk "BEGIN { print int($total_gb * 0.6) }")}
wait_min=$(setting waitMinutes)
wait_s=${DEV_LOOP_WAIT_SECONDS:-$(awk "BEGIN { print int(${wait_min:-8} * 60) }")}
lock=${DEV_LOOP_LOCK:-$HOME/.cache/dev-loop/heavy.lock}
mkdir -p "$(dirname "$lock")"
deadline=$(( $(date +%s) + wait_s ))

exec 9>"$lock"
if ! flock -w "$wait_s" 9; then
  echo "dev-loop heavy: busy for ${wait_s}s, held by: $(cat "$lock.who" 2>/dev/null)" >&2
  exit 75
fi
echo "pid $$ since $(date +%H:%M:%S) in $PWD: $*" > "$lock.who"

while :; do
  free_kb=$(awk '/^MemAvailable/ { print $2 }' /proc/meminfo)
  stall=$(awk '/^full/ { split($2, a, "="); print int(a[2]) }' /proc/pressure/memory 2>/dev/null || echo 0)
  awk "BEGIN { exit !($free_kb >= $min_free * 1048576 && ${stall:-0} < 10) }" && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "dev-loop heavy: not enough memory after ${wait_s}s: $((free_kb / 1048576)) GB free, need $min_free" >&2
    exit 75
  fi
  sleep 15
done

export DEV_LOOP_HEAVY=1
max_mb=$(awk "BEGIN { print int($max_gb * 1024) }")
# $1 command, $2 cap in MB or empty, $3 time limit in seconds. timeout signals its whole process group.
run='timeout -k 10 "$3" bash -c "$1"; rc=$?
if [ -n "$2" ] && grep -q "^oom_kill [1-9]" "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.events"; then
  echo "dev-loop heavy: killed at the memory cap of $2 MB" >&2; exit 137
fi
if [ "$rc" = 124 ] || { [ "$rc" = 137 ] && [ "$SECONDS" -ge "$3" ]; }; then
  echo "dev-loop heavy: timed out after $3 s" >&2; exit 124
fi
exit $rc'
# 9>&- : a process the command leaves behind must not keep the lock
if systemd-run --user --scope -q true 2>/dev/null; then
  systemd-run --user --scope -q -p MemoryMax="${max_mb}M" -p MemorySwapMax=0 -p OOMPolicy=continue \
    bash -c "$run" _ "$*" "$max_mb" "$timeout_s" 9>&-
else
  echo "dev-loop heavy: no systemd user scope, running without a memory cap" >&2
  bash -c "$run" _ "$*" "" "$timeout_s" 9>&-
fi
