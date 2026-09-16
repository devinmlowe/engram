#!/bin/bash
# Engram Dream State Daemon — nightly `engram dream` scheduler installer
#
# macOS: renders launchd/com.engram.dreamstate.plist into ~/Library/LaunchAgents
# Linux: renders systemd/engram-dream.{service,timer} into the systemd *user*
#        unit directory and enables the timer (no root required)
# Windows: see scripts/install-daemon.ps1 (Task Scheduler)
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

# --- Linux (systemd user units) ---------------------------------------------
OS="$(uname -s)"
SYSTEMD_SRC_DIR="${ENGRAM_DIR}/systemd"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="engram-dream.service"
TIMER_NAME="engram-dream.timer"
# Optional provider keys for the service; referenced via EnvironmentFile= in
# the unit template (path must stay in sync with systemd/engram-dream.service).
DREAM_ENV_FILE="${HOME}/.local/share/engram/dream.env"

ensure_dirs() {
    mkdir -p "$LOG_DIR"
    mkdir -p "${HOME}/.local/share/engram"
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
            if echo "$fallback" | grep -q "fnm_multishells"; then
                echo "WARNING: Resolved node path is an ephemeral fnm multishell path." >&2
                echo "         The daemon may break after reboot. Consider setting fnm default." >&2
            fi
            echo "$fallback"
        else
            echo "ERROR: No node binary found." >&2
            exit 1
        fi
    fi
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

    # Resolve a stable node binary path (avoid fnm multishell ephemeral paths)
    NODE_BIN="$(resolve_node)"
    echo "Using node: $NODE_BIN ($($NODE_BIN --version))"

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

    # Copy ANTHROPIC_API_KEY if set
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        # Insert API key into EnvironmentVariables
        /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:ANTHROPIC_API_KEY string ${ANTHROPIC_API_KEY}" "$PLIST_DST" 2>/dev/null || \
        /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:ANTHROPIC_API_KEY ${ANTHROPIC_API_KEY}" "$PLIST_DST"
    fi

    # Copy OPENROUTER_API_KEY if set
    if [ -n "${OPENROUTER_API_KEY:-}" ]; then
        /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OPENROUTER_API_KEY string ${OPENROUTER_API_KEY}" "$PLIST_DST" 2>/dev/null || \
        /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:OPENROUTER_API_KEY ${OPENROUTER_API_KEY}" "$PLIST_DST"
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

# --- Linux (systemd user units) ---------------------------------------------

require_systemctl() {
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "Error: systemctl not found. On Linux this installer needs systemd user services." >&2
        echo "       Without systemd, schedule '${ENGRAM_DIR}/dist/interfaces/cli/index.js dream' from cron instead." >&2
        exit 1
    fi
}

write_dream_env() {
    # Provider keys are kept out of the unit file and out of `systemctl show`
    # output; the unit reads them from an optional 0600 EnvironmentFile.
    local tmp
    tmp="$(mktemp)"
    [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> "$tmp"
    [ -n "${OPENROUTER_API_KEY:-}" ] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" >> "$tmp"
    [ -n "${ENGRAM_LOCAL_MODEL:-}" ] && echo "ENGRAM_LOCAL_MODEL=${ENGRAM_LOCAL_MODEL}" >> "$tmp"
    if [ -s "$tmp" ]; then
        install -m 600 "$tmp" "$DREAM_ENV_FILE"
        echo "Wrote provider environment: $DREAM_ENV_FILE (mode 600)"
    elif [ ! -f "$DREAM_ENV_FILE" ]; then
        echo "Note: no ANTHROPIC_API_KEY/OPENROUTER_API_KEY/ENGRAM_LOCAL_MODEL in the environment;"
        echo "      add them to $DREAM_ENV_FILE (KEY=value per line) if dream needs an LLM provider."
    fi
    rm -f "$tmp"
}

install_systemd() {
    require_systemctl
    ensure_dirs
    mkdir -p "$SYSTEMD_USER_DIR"

    local service_src="${SYSTEMD_SRC_DIR}/${SERVICE_NAME}"
    local timer_src="${SYSTEMD_SRC_DIR}/${TIMER_NAME}"
    local service_dst="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
    local timer_dst="${SYSTEMD_USER_DIR}/${TIMER_NAME}"

    if [ ! -f "$service_src" ] || [ ! -f "$timer_src" ]; then
        echo "Error: systemd templates not found under $SYSTEMD_SRC_DIR"
        exit 1
    fi

    # Build the project first
    echo "Building engram..."
    (cd "$ENGRAM_DIR" && npm run build)

    # Resolve a stable node binary path (avoid fnm multishell ephemeral paths)
    NODE_BIN="$(resolve_node)"
    echo "Using node: $NODE_BIN ($($NODE_BIN --version))"

    # Render the service from the same placeholders the launchd plist uses.
    sed -e "s|__ENGRAM_DIR__|${ENGRAM_DIR}|g" \
        -e "s|__NODE_BIN__|${NODE_BIN}|g" \
        -e "s|__LOG_DIR__|${LOG_DIR}|g" \
        "$service_src" > "$service_dst"
    if grep -q "__[A-Z_]*__" "$service_dst"; then
        echo "Error: unresolved placeholder in rendered unit:" >&2
        grep -n "__[A-Z_]*__" "$service_dst" >&2
        rm -f "$service_dst"
        exit 1
    fi
    # The timer carries no placeholders; copy verbatim.
    cp "$timer_src" "$timer_dst"

    write_dream_env

    systemctl --user daemon-reload
    systemctl --user enable --now "$TIMER_NAME"

    echo "Engram dream timer installed and enabled."
    echo "  Units:    $service_dst"
    echo "            $timer_dst"
    echo "  Schedule: Daily at 2:00 AM (Persistent: missed runs fire at next login)"
    echo "  Logs:     $LOG_DIR/dream.log"
    echo ""
    echo "The user timer only runs while your user session exists. To run it"
    echo "without being logged in: loginctl enable-linger $(id -un)"
    echo ""
    echo "To trigger now: $0 run-now"
    echo "To uninstall:   $0 uninstall"
}

uninstall_systemd() {
    require_systemctl
    local service_dst="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
    local timer_dst="${SYSTEMD_USER_DIR}/${TIMER_NAME}"

    if [ -f "$timer_dst" ] || [ -f "$service_dst" ]; then
        systemctl --user disable --now "$TIMER_NAME" 2>/dev/null || true
        systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
        rm -f "$timer_dst" "$service_dst"
        systemctl --user daemon-reload
        echo "Engram dream timer disabled and units removed."
        echo "(Provider env file left in place: $DREAM_ENV_FILE)"
    else
        echo "Daemon not installed (no units found in $SYSTEMD_USER_DIR)."
    fi
}

status_systemd() {
    require_systemctl
    if systemctl --user list-timers --all "$TIMER_NAME" 2>/dev/null | grep -q "$TIMER_NAME"; then
        systemctl --user list-timers --all --no-pager "$TIMER_NAME"
        echo ""
        systemctl --user status --no-pager "$SERVICE_NAME" 2>/dev/null || true
        echo ""
        echo "Timer is loaded."
    else
        echo "Timer is not loaded."
    fi

    if [ -f "${LOG_DIR}/dream.log" ]; then
        echo ""
        echo "Last 5 log lines:"
        tail -5 "${LOG_DIR}/dream.log"
    fi
}

run_now_systemd() {
    require_systemctl
    if [ ! -f "${SYSTEMD_USER_DIR}/${SERVICE_NAME}" ]; then
        echo "Daemon is not installed. Run '$0 install' first."
        exit 1
    fi
    systemctl --user start "$SERVICE_NAME"
    echo "Dream run triggered. Check logs: tail -f ${LOG_DIR}/dream.log"
    echo "(or: journalctl --user -u ${SERVICE_NAME} -f)"
}

# --- Dispatch ---------------------------------------------------------------

case "${1:-}" in
    install)
        if [ "$OS" = "Linux" ]; then install_systemd; else install_daemon; fi
        ;;
    uninstall)
        if [ "$OS" = "Linux" ]; then uninstall_systemd; else uninstall_daemon; fi
        ;;
    status)
        if [ "$OS" = "Linux" ]; then status_systemd; else status_daemon; fi
        ;;
    run-now)
        if [ "$OS" = "Linux" ]; then run_now_systemd; else run_now; fi
        ;;
    *)
        echo "Usage: $0 {install|uninstall|status|run-now}"
        exit 1
        ;;
esac
