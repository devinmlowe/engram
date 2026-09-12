#!/bin/bash
# Engram Visualizer — launchd install/uninstall script
#
# Usage:
#   ./scripts/install-visualizer.sh install    Install and load the service
#   ./scripts/install-visualizer.sh uninstall  Unload and remove the service
#   ./scripts/install-visualizer.sh status     Check service status
#   ./scripts/install-visualizer.sh restart    Restart the service

set -euo pipefail

LABEL="com.engram.visualizer"
PLIST_SRC="$(cd "$(dirname "$0")/../launchd" && pwd)/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.local/share/engram/logs"
ENGRAM_DIR="$(cd "$(dirname "$0")/.." && pwd)"

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
        fallback="$(which node 2>/dev/null)"
        if [ -n "$fallback" ]; then
            echo "$fallback"
        else
            echo "ERROR: No node binary found." >&2
            exit 1
        fi
    fi
}

install_service() {
    ensure_dirs

    if [ ! -f "$PLIST_SRC" ]; then
        echo "Error: plist template not found at $PLIST_SRC"
        exit 1
    fi

    # Kill any existing graph-server process
    lsof -ti :3001 2>/dev/null | xargs kill 2>/dev/null || true

    NODE_BIN="$(resolve_node)"
    echo "Using node: $NODE_BIN ($($NODE_BIN --version))"

    # Build the project first
    echo "Building engram..."
    (cd "$ENGRAM_DIR" && npm run build)

    # Generate plist with correct paths
    sed -e "s|/usr/local/lib/engram|${ENGRAM_DIR}|g" \
        -e "s|/Users/USER|${HOME}|g" \
        -e "s|/usr/local/bin/node|${NODE_BIN}|g" \
        "$PLIST_SRC" > "$PLIST_DST"

    # Load the agent
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"

    echo ""
    echo "Engram visualizer installed and loaded."
    echo "  Plist:  $PLIST_DST"
    echo "  URL:    http://localhost:3001/graph"
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
        if lsof -ti :3001 &>/dev/null; then
            echo "Port 3001: listening"
        else
            echo "Port 3001: not listening (may be starting)"
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
