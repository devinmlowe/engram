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
#
# Secrets never go into the plist. The service runs scripts/run-dream.sh --daemon,
# and that launcher sources ${XDG_CONFIG_HOME:-$HOME/.config}/engram/env (mode 600)
# before starting node. `install` creates that file with a commented template if it
# does not exist, seeding it from ANTHROPIC_API_KEY / OPENROUTER_API_KEY /
# ENGRAM_LOCAL_MODEL when those are set in the calling shell.
#
# Directories follow the CLI: ENGRAM_DATA_DIR (default ~/.local/share/engram) and
# ENGRAM_LOGS_DIR (default $ENGRAM_DATA_DIR/logs).

set -euo pipefail

LABEL="com.engram.dreamstate"
PLIST_SRC="$(cd "$(dirname "$0")/../launchd" && pwd)/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DATA_DIR="${ENGRAM_DATA_DIR:-$HOME/.local/share/engram}"
LOG_DIR="${ENGRAM_LOGS_DIR:-$DATA_DIR/logs}"
ENGRAM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/engram"
ENV_FILE="${ENV_DIR}/env"

# Up-front tool checks: one line naming what to install, instead of a bare
# "command not found" halfway through.
need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: '$1' not found — $2" >&2
        exit 1
    fi
}
need launchctl "this installer targets macOS launchd; on Linux run 'engram dream' from cron or a systemd timer (see README)"
need npm "install Node.js 22+ (https://nodejs.org); it ships npm"

# --- Linux (systemd user units) ---------------------------------------------
OS="$(uname -s)"
SYSTEMD_SRC_DIR="${ENGRAM_DIR}/systemd"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="engram-dream.service"
TIMER_NAME="engram-dream.timer"

ensure_dirs() {
    mkdir -p "$LOG_DIR"
    mkdir -p "$DATA_DIR"
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
            if echo "$fallback" | grep -q "fnm_multishells"; then
                echo "WARNING: Resolved node path is an ephemeral fnm multishell path." >&2
                echo "         The daemon may break after reboot. Consider setting fnm default." >&2
            fi
            echo "$fallback"
        else
            echo "ERROR: No node binary found — install Node.js 22+ (https://nodejs.org)." >&2
            exit 1
        fi
    fi
}

# Emit one line for the env file: NAME='value' if NAME is set in this shell,
# otherwise a commented placeholder the user can fill in later.
env_line() {
    local name="$1" comment="$2" value
    value="${!name:-}"
    if [ -n "$value" ]; then
        printf "%s='%s'\n" "$name" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
    else
        printf '# %s\n#%s=\n' "$comment" "$name"
    fi
}

# Create ${XDG_CONFIG_HOME:-~/.config}/engram/env (mode 600) once; never rewrite
# an existing file, only tighten its permissions and hint at missing keys.
ensure_env_file() {
    if [ -f "$ENV_FILE" ]; then
        chmod 600 "$ENV_FILE"
        local name
        for name in ANTHROPIC_API_KEY OPENROUTER_API_KEY ENGRAM_LOCAL_MODEL; do
            if [ -n "${!name:-}" ] && ! grep -q "^${name}=" "$ENV_FILE"; then
                echo "Note: $name is set in your shell but not in $ENV_FILE; the daemon only reads the file."
            fi
        done
        return 0
    fi

    mkdir -p "$ENV_DIR"
    chmod 700 "$ENV_DIR"
    (
        umask 077
        {
            echo "# engram service environment — sourced by scripts/run-dream.sh before the dream daemon starts."
            echo "# One NAME=value per line (shell syntax, quote values with spaces). Keep this file mode 600."
            echo "# Configure at least one LLM provider for 'engram dream':"
            env_line ANTHROPIC_API_KEY "Anthropic provider (final tier of the LLM cascade)"
            env_line OPENROUTER_API_KEY "OpenRouter provider (middle tier)"
            env_line ENGRAM_LOCAL_MODEL "Ollama model name (default qwen2.5:7b)"
            env_line ENGRAM_LOCAL_MODEL_FALLBACKS "Comma-separated Ollama models tried when ENGRAM_LOCAL_MODEL is not pulled"
            echo "# Any other ENGRAM_* setting from the README Configuration table works here too, e.g.:"
            echo "#ENGRAM_DATA_DIR="
        } > "$ENV_FILE"
    )
    chmod 600 "$ENV_FILE"
    echo "Created $ENV_FILE (mode 600) — put API keys there, never in the plist."
}

install_daemon() {
    ensure_dirs
    ensure_env_file

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

    # Load the agent
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"

    echo "Engram dream daemon installed and loaded."
    echo "  Plist:    $PLIST_DST"
    echo "  Env file: $ENV_FILE  (API keys live here; the plist carries none)"
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

    # Installs made before the env-file launcher embedded API keys in the plist.
    if [ -f "$PLIST_DST" ] && grep -q '_API_KEY</key>' "$PLIST_DST"; then
        echo ""
        echo "WARNING: $PLIST_DST still embeds API keys in plaintext (pre-env-file install)."
        echo "         Put them in $ENV_FILE and re-run '$0 install' to render a key-free plist."
    fi
    if [ -f "$ENV_FILE" ]; then
        echo "Env file: $ENV_FILE"
    else
        echo "Env file: $ENV_FILE (missing — '$0 install' creates it)"
    fi

    if [ -f "${LOG_DIR}/dream.log" ]; then
        echo ""
        echo "Last 5 log lines:"
        tail -5 "${LOG_DIR}/dream.log"
    fi
}

run_now() {
    if ! launchctl list "$LABEL" >/dev/null 2>&1; then
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

    ensure_env_file

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
        echo "(Service env file left in place: $ENV_FILE)"
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
