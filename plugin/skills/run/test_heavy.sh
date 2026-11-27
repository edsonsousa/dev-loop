#!/usr/bin/env bash
# Run: plugin/skills/run/test_heavy.sh   Prints "ok" when heavy.sh queues, waits, caps and passes exit codes.
set -uo pipefail
h="$(dirname "$0")/heavy.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export DEV_LOOP_LOCK="$tmp/heavy.lock" DEV_LOOP_WAIT_SECONDS=2 DEV_LOOP_MIN_FREE_GB=0
fail() { echo "FAIL: $*"; exit 1; }

out="$("$h" 'echo hi; exit 3')"; rc=$?
[ "$rc" = 3 ] && [ "$out" = hi ] || fail "exit code or output not passed: $rc $out"

out="$("$h" "$h 'echo nested'")" || fail "nested call"
[ "$out" = nested ] || fail "nested call deadlocked or lost output: $out"

"$h" 'sleep 4' & sleep 0.5
out="$("$h" 'echo ran' 2>&1)"; rc=$?
[ "$rc" = 75 ] && [[ "$out" == *busy* ]] || fail "a held lock should give 75 after the wait: $rc $out"
wait

out="$(DEV_LOOP_MIN_FREE_GB=100000 "$h" 'echo ran' 2>&1)"; rc=$?
[ "$rc" = 75 ] && [[ "$out" == *memory* ]] || fail "too little memory should give 75: $rc $out"

"$h" 'sleep 3 & disown; echo bg' >/dev/null
out="$("$h" 'echo after' 2>&1)" || fail "a process left in the background kept the lock: $out"

start=$(date +%s)
out="$(DEV_LOOP_TIMEOUT_SECONDS=1 "$h" 'sleep 1 & sleep 30; echo late' 2>&1)"; rc=$?
[ "$rc" = 124 ] && [[ "$out" == *"timed out"* ]] && [[ "$out" != *late* ]] || fail "a hung command should give 124: $rc $out"
[ $(( $(date +%s) - start )) -lt 10 ] || fail "the timeout did not stop the command"
out="$(DEV_LOOP_TIMEOUT_SECONDS=1 "$h" 'trap "" TERM; sleep 40' 2>&1)"; rc=$?
[ "$rc" = 124 ] || fail "a command ignoring TERM should still end as 124: $rc $out"

out="$(DEV_LOOP_NO_LIMITS=1 "$h" 'echo plain; exit 4')"; rc=$?
[ "$rc" = 4 ] && [ "$out" = plain ] || fail "without limits the exit code or output was lost: $rc $out"
out="$(DEV_LOOP_NO_LIMITS=1 DEV_LOOP_TIMEOUT_SECONDS=1 "$h" 'sleep 30' 2>&1)"; rc=$?
[ "$rc" = 124 ] || fail "without limits the time limit should still give 124: $rc $out"

if systemd-run --user --scope -q true 2>/dev/null; then
  out="$(DEV_LOOP_MAX_GB=0.05 "$h" "python3 -c 'b = bytearray(300 * 2**20)'" 2>&1)"; rc=$?
  [ "$rc" = 137 ] && [[ "$out" == *cap* ]] || fail "the memory cap should kill with 137: $rc $out"
else
  echo "skipped the memory cap check: no systemd user scope"
fi
echo ok
