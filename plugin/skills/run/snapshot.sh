#!/usr/bin/env bash
# Usage: snapshot.sh <task-slug> <base-commit>
# Records the working tree as the loop left it (new files included) as a commit under refs/dev-loop/<task-slug>,
# without touching the index, the branch or any file. Prints the commit. ingest.py compares it with main later.
set -euo pipefail
slug="$1" base="$2"
git_dir="$(git rev-parse --git-dir)"
idx="$(mktemp)"
trap 'rm -f "$idx"' EXIT
cp "$git_dir/index" "$idx"
GIT_INDEX_FILE="$idx" git add -A
tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
commit="$(git commit-tree "$tree" -p "$base" -m "dev-loop snapshot: $slug")"
git update-ref "refs/dev-loop/$slug" "$commit"
echo "$commit"
