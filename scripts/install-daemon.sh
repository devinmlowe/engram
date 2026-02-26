#!/bin/bash
# Engram Dream State Daemon — launchd install/uninstall script
#
# Usage:
#   ./scripts/install-daemon.sh install    Install and load the daemon
#   ./scripts/install-daemon.sh uninstall  Unload and remove the daemon
#   ./scripts/install-daemon.sh status     Check daemon status
#   ./scripts/install-daemon.sh run-now    Trigger an immediate run

set -euo pipefail

LABEL="com.engram.dreamstate"
PLIST_SRC="$(cd "$(dirname "$0")/../launchd" && pwd)/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.local/share/engram/logs"
ENGRAM_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ensure_dirs() {
    mkdir -p "$LOG_DIR"
    mkdir -p "${HOME}/.local/share/engram"
}

install_daemon() {
    ensure_dirs

    if [ ! -f "$PLIST_SRC" ]; then
        echo "Error: plist template not found at $PLIST_SRC"
        exit 1
    fi

    # Build the project first
    echo "Building engram..."
    (cd "$ENGRAM_DIR" && npm run build)

    # Generate plist with correct paths
    sed -e "s|/usr/local/lib/engram|${ENGRAM_DIR}|g" \
        -e "s|/Users/USER|${HOME}|g" \
        -e "s|/usr/local/bin/node|$(which node)|g" \
        "$PLIST_SRC" > "$PLIST_DST"

    # Copy ANTHROPIC_API_KEY if set
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        # Insert API key into EnvironmentVariables
        /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:ANTHROPIC_API_KEY string ${ANTHROPIC_API_KEY}" "$PLIST_DST" 2>/dev/null || \
        /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:ANTHROPIC_API_KEY ${ANTHROPIC_API_KEY}" "$PLIST_DST"
    fi

    # Add local model if configured
    if [ -n "${ENGRAM_LOCAL_MODEL:-}" ]; then
        /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:ENGRAM_LOCAL_MODEL string ${ENGRAM_LOCAL_MODEL}" "$PLIST_DST" 2>/dev/null || \
        /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:ENGRAM_LOCAL_MODEL ${ENGRAM_LOCAL_MODEL}" "$PLIST_DST"
    fi

    # Load the agent
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"

    echo "Engram dream daemon installed and loaded."
    echo "  Plist:    $PLIST_DST"
    echo "  Schedule: Daily at 2:00 AM"
    echo "  Logs:     $LOG_DIR/dream.log"
    echo ""
    echo "To trigger now: $0 run-now"
    echo "To uninstall:   $0 uninstall"
}

uninstall_daemon() {
    if [ -f "$PLIST_DST" ]; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
        rm -f "$PLIST_DST"
        echo "Engram dream daemon unloaded and removed."
    else
        echo "Daemon not installed (plist not found at $PLIST_DST)."
    fi
}

status_daemon() {
    if launchctl list "$LABEL" 2>/dev/null; then
        echo ""
        echo "Daemon is loaded."
    else
        echo "Daemon is not loaded."
    fi

    if [ -f "${LOG_DIR}/dream.log" ]; then
        echo ""
        echo "Last 5 log lines:"
        tail -5 "${LOG_DIR}/dream.log"
    fi
}

run_now() {
    if ! launchctl list "$LABEL" &>/dev/null; then
        echo "Daemon is not installed. Run '$0 install' first."
        exit 1
    fi
    launchctl kickstart "gui/$(id -u)/${LABEL}"
    echo "Dream run triggered. Check logs: tail -f ${LOG_DIR}/dream.log"
}

case "${1:-}" in
    install)
        install_daemon
        ;;
    uninstall)
        uninstall_daemon
        ;;
    status)
        status_daemon
        ;;
    run-now)
        run_now
        ;;
    *)
        echo "Usage: $0 {install|uninstall|status|run-now}"
        exit 1
        ;;
esac
