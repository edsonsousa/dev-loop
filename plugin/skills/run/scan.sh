#!/usr/bin/env bash
# Static scan of the given files: Semgrep (local CLI, default rules; the code never leaves the machine) and
# gitleaks (secrets). Prints the findings for the security reviewer; exit 1 when either found something.
# A tool that is not installed is skipped with a note.
# Usage: scan.sh file...
set -uo pipefail
[ $# -gt 0 ] || exit 0
rc=0
if command -v semgrep > /dev/null; then
  # the project's own rules, from the retro's escaped bugs and repeated nits, run next to the defaults
  extra=(); [ -d .semgrep ] && extra=(--config .semgrep)
  semgrep scan --metrics=off --config p/default "${extra[@]}" --quiet --error "$@" || rc=1
else
  echo "scan: semgrep not installed, skipped (pipx install semgrep)"
fi
if command -v gitleaks > /dev/null; then
  for f in "$@"; do
    [ -f "$f" ] || continue
    gitleaks dir --no-banner --redact --log-level warn -v "$f" || rc=1
  done
else
  echo "scan: gitleaks not installed, skipped (github.com/gitleaks/gitleaks/releases)"
fi
exit $rc
