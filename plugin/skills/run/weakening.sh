#!/usr/bin/env bash
# Lists ways a diff weakens the checks instead of fixing the code: skipped or deleted tests, removed assertions,
# lint or type suppressions, edited check configs. Exit 1 when it finds any.
# Usage: weakening.sh BASE [path...]   (paths limit the diff to the task's files)
set -euo pipefail
base="$1"; shift
out="$(mktemp)"; trap 'rm -f "$out"' EXIT

suppress='@Disabled|@Ignore([^A-Za-z]|$)|@SuppressWarnings|\.(skip|only)\(|(^|[^A-Za-z.])x(it|describe|test)\(|eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|(istanbul|c8) ignore|pytest\.mark\.skip|# *noqa|# *type: *ignore|-DskipTests|--no-verify'
config='(^|/)(eslint\.config\.[^/]*|\.eslintrc[^/]*|(vitest|jest|vite)\.config\.[^/]*|tsconfig[^/]*\.json|\.prettierrc[^/]*|checkstyle[^/]*|spotbugs[^/]*|\.semgrepignore|\.gitleaks(ignore|\.toml)|stryker\.conf[^/]*)$'
tests='(Tests?\.java|\.(test|spec)\.[jt]sx?|(^|/)test_[^/]*\.py|_test\.(py|go))$'
assert='assert|expect\(|verify\(|should'

{
  git diff -U0 "$base" -- "$@"
  git ls-files --others --exclude-standard -- "$@" | while read -r f; do echo "+++ b/$f"; sed 's/^/+/' "$f"; done
} | S="$suppress" T="$tests" A="$assert" awk '
  BEGIN { s = ENVIRON["S"]; t = ENVIRON["T"]; a = ENVIRON["A"] }
  /^\+\+\+ b\// { f = substr($0, 7); next }
  /^(\+\+\+|---) / { next }
  /^\+/ && $0 ~ s { print f ": suppression added: " substr($0, 2) }
  f ~ t && /^-/ && $0 ~ a { del[f]++ }
  f ~ t && /^\+/ && $0 ~ a { add[f]++ }
  END { for (x in del) if (del[x] > add[x]) print x ": " del[x] - add[x] " assertion line(s) removed" }
' > "$out"
git diff --name-only --diff-filter=D "$base" -- "$@" | grep -E "$tests" | sed 's/$/: test file deleted/' >> "$out" || true
{ git diff --name-only "$base" -- "$@"; git ls-files --others --exclude-standard -- "$@"; } \
  | grep -E "$config" | sed 's/$/: check config changed/' >> "$out" || true

if [ -s "$out" ]; then cat "$out"; exit 1; fi
