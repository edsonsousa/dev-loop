#!/usr/bin/env bash
# Lists ways a diff weakens the checks instead of fixing the code: skipped or deleted tests, removed assertions,
# lint or type suppressions, edited check configs. Exit 1 when it finds any.
# Usage: weakening.sh BASE [path...]   (paths limit the diff to the task's files)
# Covers Java, Kotlin, JS/TS, Python, Go, Rust, C#, Ruby, PHP and Swift; a project adds its own regexes with
# weakeningTests and weakeningSuppressions in .claude/dev-loop.yml.
set -euo pipefail
base="$1"; shift
out="$(mktemp)"; trap 'rm -f "$out"' EXIT

suppress='@Disabled|@Ignore([^A-Za-z]|$)|@SuppressWarnings|@Suppress\(|\.(skip|only)\(|(^|[^A-Za-z.])x(it|describe|test)\(|eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|(istanbul|c8) ignore|pytest\.mark\.(skip|xfail)|unittest\.skip|# *noqa|# *type: *ignore|-DskipTests|--no-verify|#\[ignore\]|#!?\[allow\(|\[Ignore[](]|Skip *= *"|#pragma warning disable|\[SuppressMessage|rubocop:disable|markTestSkipped|@phpstan-ignore|@psalm-suppress|XCTSkip|swiftlint:disable|t\.Skip(Now|f)?\(|//nolint'
config='(^|/)(eslint\.config\.[^/]*|\.eslintrc[^/]*|(vitest|jest|vite)\.config\.[^/]*|tsconfig[^/]*\.json|\.prettierrc[^/]*|checkstyle[^/]*|spotbugs[^/]*|detekt[^/]*\.ya?ml|\.semgrepignore|\.gitleaks(ignore|\.toml)|stryker\.conf[^/]*|\.rubocop[^/]*\.yml|\.swiftlint\.yml|\.golangci\.ya?ml|clippy\.toml|phpstan[^/]*\.neon|ruff\.toml|mypy\.ini|\.flake8|\.claude/dev-loop\.yml)$'
tests='(Tests?\.(java|kt|cs|php|swift)|\.(test|spec)\.[jt]sx?|(^|/)test_[^/]*\.py|_test\.(py|go|rb)|_spec\.rb|(^|/)tests/[^/]*\.rs)$'
assert='[Aa]ssert|expect\(|verify\(|should'

# the project's own patterns: single-quoted regexes on top-level keys of .claude/dev-loop.yml
conf="$(git rev-parse --show-toplevel)/.claude/dev-loop.yml"
setting() { [ -f "$conf" ] || return 0; sed -n "s/^$1: *'\(.*\)' *$/\1/p" "$conf" 2>/dev/null | head -1; }
extra="$(setting weakeningSuppressions)"; if [ -n "$extra" ]; then suppress="$suppress|$extra"; fi
extra="$(setting weakeningTests)"; if [ -n "$extra" ]; then tests="($tests|$extra)"; fi

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
