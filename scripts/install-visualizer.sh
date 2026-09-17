#!/bin/bash
# Engram Visualizer — launchd install/uninstall script
#
# Usage:
#   ./scripts/install-visualizer.sh install    Install and load the service
#   ./scripts/install-visualizer.sh uninstall  Unload and remove the service
#   ./scripts/install-visualizer.sh status     Check service status
#   ./scripts/install-visualizer.sh restart    Restart the service
#
# Port liveness is probed portably: a node TCP connect (node is mandatory for
# engram anyway), falling back to curl against /api/health. lsof is only an
# optional fast path when it happens to be installed, so `status` no longer
# reports "not listening" on hosts without it.
#
# Directories follow the CLI: ENGRAM_DATA_DIR (default ~/.local/share/engram) and
# ENGRAM_LOGS_DIR (default $ENGRAM_DATA_DIR/logs).

set -euo pipefail

LABEL="com.engram.visualizer"
PLIST_SRC="$(cd "$(dirname "$0")/../launchd" && pwd)/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DATA_DIR="${ENGRAM_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/engram}"
LOG_DIR="${ENGRAM_LOGS_DIR:-$DATA_DIR/logs}"
ENGRAM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3001}"
HOST="127.0.0.1"

# Up-front tool checks: one line naming what to install, instead of a bare
# "command not found" halfway through.
need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: '$1' not found — $2" >&2
        exit 1
    fi
}
need launchctl "this installer targets macOS launchd; on Linux run the visualizer under your own supervisor (see README)"
need npm "install Node.js 22+ (https://nodejs.org); it ships npm"

ensure_dirs() {
    mkdir -p "$LOG_DIR"
}

resolve_node() {
    local fnm_default="${HOME}/.local/share/fnm/aliases/default/bin/node"
    local homebrew="/opt/homebrew/bin/node"
    local system="/usr/local/bin/node"

    if [ -x "$fnm_default" ]; then
        echo "$fnm_default"
    elif [ -x "$homebrew" ]; then
        echo "$homebrew"
    elif [ -x "$system" ]; then
        echo "$system"
    else
        local fallback
        fallback="$(command -v node 2>/dev/null || true)"
        if [ -n "$fallback" ]; then
            echo "$fallback"
        else
            echo "ERROR: No node binary found — install Node.js 22+ (https://nodejs.org)." >&2
            exit 1
        fi
    fi
}

# port_listening PORT — succeeds when something accepts TCP connections on
# 127.0.0.1:PORT. Order: lsof (optional fast path), node TCP connect, curl /api/health.
port_listening() {
    local port="$1" node_bin
    if command -v lsof >/dev/null 2>&1; then
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            return 0
        fi
    fi
    node_bin="$(command -v node 2>/dev/null || true)"
    if [ -n "$node_bin" ]; then
        if "$node_bin" -e '
            const s = require("node:net").connect({ host: process.argv[1], port: Number(process.argv[2]) });
            s.setTimeout(1500);
            s.once("connect", () => { s.destroy(); process.exit(0); });
            s.once("timeout", () => { s.destroy(); process.exit(1); });
            s.once("error", () => process.exit(1));
        ' "$HOST" "$port"; then
            return 0
        fi
        return 1
    fi
    if command -v curl >/dev/null 2>&1; then
        if curl -fsS --max-time 2 "http://${HOST}:${port}/api/health" >/dev/null 2>&1; then
            return 0
        fi
        return 1
    fi
    echo "Warning: cannot probe port $port — install node (https://nodejs.org) or curl." >&2
    return 1
}

# Free the port before (re)installing. Only lsof can map a port to a PID
# portably enough here; without it we just warn so the failure is not silent.
stop_port_holder() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
    elif port_listening "$PORT"; then
        echo "Warning: something is already listening on ${HOST}:${PORT}; the service cannot bind until it is stopped." >&2
    fi
}

install_service() {
    ensure_dirs

    if [ ! -f "$PLIST_SRC" ]; then
        echo "Error: plist template not found at $PLIST_SRC"
        exit 1
    fi

    # Stop any existing graph-server process (dev server, previous install)
    stop_port_holder

    NODE_BIN="$(resolve_node)"
    echo "Using node: $NODE_BIN ($($NODE_BIN --version))"

    # Build the project first
    echo "Building engram..."
    (cd "$ENGRAM_DIR" && npm run build)

    # Render the template: placeholders are substituted with the *resolved*
    # checkout, node binary, and log directory so the service works from any
    # clone location and any node installer (fnm, brew, nvm, system).
    sed -e "s|__ENGRAM_DIR__|${ENGRAM_DIR}|g" \
        -e "s|__NODE_BIN__|${NODE_BIN}|g" \
        -e "s|__LOG_DIR__|${LOG_DIR}|g" \
        "$PLIST_SRC" > "$PLIST_DST"
    if grep -q "__[A-Z_]*__" "$PLIST_DST"; then
        echo "Error: unresolved placeholder in rendered plist:" >&2
        grep -n "__[A-Z_]*__" "$PLIST_DST" >&2
        rm -f "$PLIST_DST"
        exit 1
    fi

    # Load the agent
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"

    echo ""
    echo "Engram visualizer installed and loaded."
    echo "  Plist:  $PLIST_DST"
    echo "  URL:    http://localhost:${PORT}/graph"
    echo "  Logs:   $LOG_DIR/visualizer.log"
    echo ""
    echo "To restart:   $0 restart"
    echo "To uninstall: $0 uninstall"
}

uninstall_service() {
    if [ -f "$PLIST_DST" ]; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
        rm -f "$PLIST_DST"
        echo "Engram visualizer unloaded and removed."
    else
        echo "Service not installed (plist not found at $PLIST_DST)."
    fi
}

status_service() {
    if launchctl list "$LABEL" 2>/dev/null; then
        echo ""
        echo "Service is loaded."
        if port_listening "$PORT"; then
            echo "Port ${PORT}: listening"
        else
            echo "Port ${PORT}: not listening (may be starting)"
        fi
    else
        echo "Service is not loaded."
    fi

    if [ -f "${LOG_DIR}/visualizer.log" ]; then
        echo ""
        echo "Last 5 log lines:"
        tail -5 "${LOG_DIR}/visualizer.log"
    fi
    if [ -f "${LOG_DIR}/visualizer-error.log" ]; then
        local errors
        errors="$(tail -5 "${LOG_DIR}/visualizer-error.log" 2>/dev/null)"
        if [ -n "$errors" ]; then
            echo ""
            echo "Last 5 error lines:"
            echo "$errors"
        fi
    fi
}

restart_service() {
    if [ ! -f "$PLIST_DST" ]; then
        echo "Service not installed. Run '$0 install' first."
        exit 1
    fi
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"
    echo "Engram visualizer restarted."
}

case "${1:-}" in
    install)
        install_service
        ;;
    uninstall)
        uninstall_service
        ;;
    status)
        status_service
        ;;
    restart)
        restart_service
        ;;
    *)
        echo "Usage: $0 {install|uninstall|status|restart}"
        exit 1
        ;;
esac
