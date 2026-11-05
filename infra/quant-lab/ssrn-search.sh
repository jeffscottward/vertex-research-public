#!/usr/bin/env bash
# Scheduled SSRN topic search: capture metadata (and free PDFs), then record the captures.
# Usage: infra/quant-lab/ssrn-search.sh [rows-per-topic]   (run from any directory)
# Needs DATABASE_URL (local Postgres 127.0.0.1:5433) and QUANTLAB_PYTHON (Python 3.12 venv).
# Research only: no orders, no broker access. Searches only papers posted in the last 30 days.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
rows="${1:-10}"
python="${QUANTLAB_PYTHON:-python3}"
since="$(date -u -d '30 days ago' +%Y-%m-%d)"
cd "$repo/services/research"
out="$("$python" -m quantlab search --topics quantlab/topics.json --rows "$rows" --since "$since")"
echo "$out"
file="$(printf '%s' "$out" | sed -n 's/.*"written": "\([^"]*\)".*/\1/p')"
cd "$repo"
bun run vertex:quantlab:record -- --search "$file"
