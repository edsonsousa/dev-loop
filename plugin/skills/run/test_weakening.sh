#!/usr/bin/env bash
# Test of weakening.sh in a throwaway repo. Prints "ok" or fails.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/weakening.sh"
repo="$(mktemp -d)"; trap 'rm -rf "$repo"' EXIT
cd "$repo"; git init -q; git config user.email t@t; git config user.name t
mkdir src
printf 'test("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n' > src/a.test.ts
printf 'class GoneTests {}\n' > src/GoneTests.java
printf 'export const x = 1;\n' > src/x.ts
printf 'class CalcTest {}\n' > src/CalcTest.kt
printf 'public class CalcTests {\n  void A() { Assert.Equal(1, 1); }\n}\n' > src/CalcTests.cs
printf 'return true\n' > src/x.check.lua
git add -A; git commit -qm base; base="$(git rev-parse HEAD)"

"$script" "$base" > /dev/null || { echo "clean diff flagged"; exit 1; }
printf 'export const x = 2;\n' > src/x.ts
"$script" "$base" > /dev/null || { echo "plain change flagged"; exit 1; }

printf 'test.skip("a", () => {\n  expect(1).toBe(1);\n});\n' > src/a.test.ts
rm src/GoneTests.java
printf '// eslint-disable-next-line\nexport const y = 1;\n' > src/new.ts
printf '{}\n' > tsconfig.json
printf '@Ignore\nclass SlowTests {}\n' > src/SlowTests.java
printf 'xit("b", () => {});\n' > src/b.test.ts
printf 'const y = fixit(1); // @IgnoredField myskip()\n' > src/ok.ts
if out="$("$script" "$base")"; then echo "weakening not flagged"; exit 1; fi
for want in "src/a.test.ts: suppression added" "src/a.test.ts: 1 assertion line(s) removed" \
            "src/GoneTests.java: test file deleted" "src/new.ts: suppression added" "tsconfig.json: check config changed" \
            "src/SlowTests.java: suppression added" "src/b.test.ts: suppression added"; do
  grep -qF "$want" <<< "$out" || { echo "missing: $want"; echo "$out"; exit 1; }
done
if grep -q "src/ok.ts" <<< "$out"; then echo "false positive"; echo "$out"; exit 1; fi

# other languages
git stash -q -u
printf '#[ignore]\nfn slow() {}\n' > src/lib.rs
printf 'public class CalcTests {\n  [Fact(Skip = "flaky")]\n  void A() { }\n}\n' > src/CalcTests.cs
printf '# rubocop:disable Metrics\n' > src/calc_spec.rb
printf '<?php $this->markTestSkipped();\n' > src/CalcTest.php
printf 'try XCTSkipIf(true)\n' > src/CalcTests.swift
printf 't.Skip("later")\n' > src/calc_test.go
printf '@Suppress("UNUSED")\nval a = 1\n' > src/Calc.kt
rm src/CalcTest.kt
printf 'linters: {}\n' > .golangci.yml
printf 'let skipCount = 0; const allowance = 1; // Assertive skipping\n' > src/ok.ts
if out="$("$script" "$base")"; then echo "other languages not flagged"; exit 1; fi
for want in "src/lib.rs: suppression added" "src/CalcTests.cs: suppression added" "src/CalcTests.cs: 1 assertion line(s) removed" \
            "src/calc_spec.rb: suppression added" "src/CalcTest.php: suppression added" "src/CalcTests.swift: suppression added" \
            "src/calc_test.go: suppression added" "src/Calc.kt: suppression added" "src/CalcTest.kt: test file deleted" \
            ".golangci.yml: check config changed"; do
  grep -qF "$want" <<< "$out" || { echo "missing: $want"; echo "$out"; exit 1; }
done
if grep -q "src/ok.ts" <<< "$out"; then echo "false positive"; echo "$out"; exit 1; fi

# the project's own patterns, from .claude/dev-loop.yml
git stash -q -u
mkdir -p .claude
printf "weakeningTests: '\\.check\\.lua\$'\nweakeningSuppressions: 'DO-NOT-CHECK'\n" > .claude/dev-loop.yml
git add .claude; git commit -qm config; base="$(git rev-parse HEAD)"
printf 'x = 1 -- DO-NOT-CHECK\n' > src/y.lua
rm src/x.check.lua
if out="$("$script" "$base")"; then echo "project patterns not used"; exit 1; fi
for want in "src/y.lua: suppression added" "src/x.check.lua: test file deleted"; do
  grep -qF "$want" <<< "$out" || { echo "missing: $want"; echo "$out"; exit 1; }
done
git checkout -q -- . && rm src/y.lua
printf "roundLimit: 9\n" > .claude/dev-loop.yml
out="$("$script" "$base")" && { echo "dev-loop.yml edit not flagged"; exit 1; }
grep -qF ".claude/dev-loop.yml: check config changed" <<< "$out" || { echo "missing dev-loop.yml"; echo "$out"; exit 1; }
git checkout -q -- .
"$script" "$base" src/x.ts > /dev/null || { echo "path limit ignored"; exit 1; }
echo ok
