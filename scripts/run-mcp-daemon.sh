#!/usr/bin/env bash
# run-mcp-daemon.sh — MCP HTTP daemon launcher for launchd / systemd (issue #28).
#
#   ./scripts/run-mcp-daemon.sh        exec the built server: dist/interfaces/mcp/server.js
#                                      --http --port ${ENGRAM_MCP_PORT:-9907}, bound to 127.0.0.1
#
# Before starting node the launcher sources the engram environment file:
#
#   ${XDG_CONFIG_HOME:-$HOME/.config}/engram/env      (override: ENGRAM_ENV_FILE)
#
# That mode-600 file is where ENGRAM_DATA_DIR / ENGRAM_MODEL_CACHE_DIR /
# ENGRAM_HTTP_WORKERS / ENGRAM_MCP_PORT and any other ENGRAM_* setting belong, so the
# rendered plist or unit never has to change (and never carries secrets, issue #10).
# Every assignment in the file is exported for this run and overrides the supervisor's
# environment. scripts/install-mcp-daemon.sh creates the file with a commented template
# if it is missing. Windows uses scripts/run-mcp-daemon.ps1 instead.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

ENV_FILE="${ENGRAM_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/engram/env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ]; then
    echo "run-mcp-daemon: node not found — install Node.js 22+ (https://nodejs.org) or set NODE_BIN" >&2
    exit 1
fi
if [ ! -f dist/interfaces/mcp/server.js ]; then
    echo "run-mcp-daemon: dist/interfaces/mcp/server.js missing — run 'npm run build' in $(pwd)" >&2
    exit 1
fi
exec "$NODE_BIN" dist/interfaces/mcp/server.js --http --port "${ENGRAM_MCP_PORT:-9907}"
