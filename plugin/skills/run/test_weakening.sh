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
"$script" "$base" src/x.ts > /dev/null || { echo "path limit ignored"; exit 1; }
echo ok
