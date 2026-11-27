#!/usr/bin/env bash
# Prints the loop's version: a short hash of the files that shape its behaviour (agents, skills, their scripts).
# The same files give the same version, with or without git.
set -euo pipefail
cd "$(dirname "$0")/../.."
find agents skills -type f \( -name '*.md' -o -name '*.sh' \) ! -name 'test_*' | LC_ALL=C sort | xargs cat | sha256sum | cut -c1-8
