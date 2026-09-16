#!/usr/bin/env bash
# run-dream.sh — dream-cycle launcher, used both by people and by the launchd service.
#
#   ./scripts/run-dream.sh            Interactive: full cycle via tsx, output tee'd to a
#                                     log under the engram logs dir, waits for a key at the end.
#   ./scripts/run-dream.sh --daemon   Service mode (launchd, cron, systemd): exec the built
#                                     CLI (dist/interfaces/cli/index.js dream) with NODE_BIN.
#
# Before either mode starts, the launcher sources the engram environment file:
#
#   ${XDG_CONFIG_HOME:-$HOME/.config}/engram/env      (override: ENGRAM_ENV_FILE)
#
# That mode-600 file is where ANTHROPIC_API_KEY / OPENROUTER_API_KEY / ENGRAM_LOCAL_MODEL
# and any other ENGRAM_* settings belong, so the LaunchAgent plist never carries secrets
# (issue #10). Every assignment in the file is exported for this run and overrides the
# caller's environment. scripts/install-daemon.sh creates the file with a commented
# template if it is missing.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

ENV_FILE="${ENGRAM_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/engram/env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

if [ "${1:-}" = "--daemon" ]; then
    NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
    if [ -z "$NODE_BIN" ]; then
        echo "run-dream: node not found — install Node.js 22+ (https://nodejs.org) or set NODE_BIN" >&2
        exit 1
    fi
    if [ ! -f dist/interfaces/cli/index.js ]; then
        echo "run-dream: dist/interfaces/cli/index.js missing — run 'npm run build' in $(pwd)" >&2
        exit 1
    fi
    exec "$NODE_BIN" --max-old-space-size=2048 dist/interfaces/cli/index.js dream
fi

if ! command -v npx >/dev/null 2>&1; then
    echo "run-dream: npx not found — install Node.js 22+ (https://nodejs.org); it ships npx" >&2
    exit 1
fi
LOG_DIR="${ENGRAM_LOGS_DIR:-${ENGRAM_DATA_DIR:-$HOME/.local/share/engram}/logs}"
mkdir -p "$LOG_DIR"
LOGFILE="$LOG_DIR/dream-full-batch-$(date +%Y%m%d-%H%M%S).log"
echo "Dream cycle starting — log: $LOGFILE"
npx tsx src/interfaces/cli/index.ts dream 2>&1 | tee "$LOGFILE"
echo ""
if [ -t 0 ]; then
    echo "Dream cycle finished. Press any key to close."
    read -r -n1
else
    echo "Dream cycle finished."
fi
