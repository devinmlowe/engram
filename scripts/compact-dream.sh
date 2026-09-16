#!/usr/bin/env bash
# compact-dream.sh — Claude Code post-compaction hook. Reads the hook payload on
# stdin, then runs `dream --phase ingest` and `dream --phase extract` for that
# session in the background so the hook returns immediately.
#
# Directories follow the CLI's configuration (src/_core/config):
#   ENGRAM_DATA_DIR  (default ~/.local/share/engram)  — lock file lives under $ENGRAM_DATA_DIR/tmp
#   ENGRAM_LOGS_DIR  (default $ENGRAM_DATA_DIR/logs)  — per-run log files
# Override ENGRAM_DIR (repo checkout) / NODE_BIN (node binary) if auto-detection is wrong.
#
# External tools: only `node` (already required by engram). The payload is parsed
# with node so the hook does not need jq on the host.
set -euo pipefail

INPUT=$(cat)

# Resolve the repo from this script's location; override with ENGRAM_DIR / NODE_BIN if needed.
ENGRAM_DIR="${ENGRAM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "compact-dream: node not found — install Node.js 22+ (https://nodejs.org) or set NODE_BIN" >&2
  exit 1
fi

# Same defaults as the CLI: ENGRAM_DATA_DIR -> ~/.local/share/engram, ENGRAM_LOGS_DIR -> $ENGRAM_DATA_DIR/logs
DATA_DIR="${ENGRAM_DATA_DIR:-$HOME/.local/share/engram}"
LOG_DIR="${ENGRAM_LOGS_DIR:-$DATA_DIR/logs}"
LOCK_FILE="$DATA_DIR/tmp/compact-dream.lock"
LOG_FILE="$LOG_DIR/dream-compact-$(date +%Y%m%d-%H%M%S).log"

SESSION_ID=$(printf '%s' "$INPUT" | "$NODE_BIN" -e '
  let raw = "";
  process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
    try { process.stdout.write(String(JSON.parse(raw).session_id ?? "")); } catch { /* not JSON: no session */ }
  });
')

# Nothing to do without a session ID
[ -z "$SESSION_ID" ] && exit 0

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

# The subshell is backgrounded; a non-interactive bash does not HUP it on exit,
# so no job-control builtins are needed here.
exit 0
