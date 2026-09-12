#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Nothing to do without a session ID
[ -z "$SESSION_ID" ] && exit 0

# Resolve the repo from this script's location; override with ENGRAM_DIR / NODE_BIN if needed.
ENGRAM_DIR="${ENGRAM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LOG_DIR="$HOME/.local/share/engram/logs"
LOCK_FILE="$HOME/.local/share/engram/tmp/compact-dream.lock"
LOG_FILE="$LOG_DIR/dream-compact-$(date +%Y%m%d-%H%M%S).log"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_FILE")"

# Skip if another compact-dream is already running
if [ -f "$LOCK_FILE" ] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
  exit 0
fi

(
  echo $$ > "$LOCK_FILE"
  trap 'rm -f "$LOCK_FILE"' EXIT
  cd "$ENGRAM_DIR"

  echo "=== Compact dream: $(date -Iseconds) | session: $SESSION_ID ==="

  echo "--- INGEST ---"
  "$NODE_BIN" --max-old-space-size=2048 dist/interfaces/cli/index.js dream \
    --phase ingest --verbose 2>&1

  echo "--- EXTRACT ($SESSION_ID) ---"
  "$NODE_BIN" --max-old-space-size=2048 dist/interfaces/cli/index.js dream \
    --phase extract --conversation "$SESSION_ID" --verbose 2>&1

  echo "=== Done: $(date -Iseconds) ==="
) >> "$LOG_FILE" 2>&1 &

disown
exit 0
