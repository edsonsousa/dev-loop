#!/usr/bin/env bash
# Opens the dev-loop UI on http://127.0.0.1:${PORT:-8766}: live agents, runs, quality, agents.
# `serve.sh sql` opens the database in Datasette instead, for ad-hoc SQL (needs: pipx install datasette).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="${DEV_LOOP_DB:-$HOME/.local/share/dev-loop/history.db}"
if [ "${1:-}" = sql ]; then
  shift
  python3 "$HERE/ingest.py" --db "$DB"
  exec datasette "$DB" -h 127.0.0.1 -p "${PORT:-8767}" "$@"
fi
exec python3 "$HERE/app.py" --db "$DB" --port "${PORT:-8766}" "$@"
