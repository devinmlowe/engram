#!/bin/bash
# Engram MCP HTTP Daemon — launchd (macOS) / systemd user service (Linux) installer
#
# macOS: renders launchd/com.engram.mcp.plist into ~/Library/LaunchAgents
# Linux: renders systemd/engram-mcp.service into the systemd *user* unit
#        directory and enables it (no root required)
# Windows: see scripts/install-mcp-daemon.ps1 (Task Scheduler)
#
# Usage:
#   ./scripts/install-mcp-daemon.sh install    Render, load and start the daemon (re-runnable)
#   ./scripts/install-mcp-daemon.sh uninstall  Stop and remove the service definition
#   ./scripts/install-mcp-daemon.sh start      Start the service and wait for /health
#   ./scripts/install-mcp-daemon.sh stop       Stop the service and wait for /health to go away
#   ./scripts/install-mcp-daemon.sh restart    stop then start (picks up a new dist/ build)
#   ./scripts/install-mcp-daemon.sh status     Supervisor state, /health, effective data dir, log tail
#
# The service runs scripts/run-mcp-daemon.sh, which sources
# ${XDG_CONFIG_HOME:-$HOME/.config}/engram/env (mode 600) and then execs
# `node dist/interfaces/mcp/server.js --http --port ${ENGRAM_MCP_PORT:-9907}`
# bound to 127.0.0.1. `install` creates that env file with a commented
# template if it does not exist. The plist/unit carries no secrets (issue #10).
#
# Directories follow the CLI: ENGRAM_DATA_DIR (default
# ${XDG_DATA_HOME:-~/.local/share}/engram) and ENGRAM_LOGS_DIR (default
# $ENGRAM_DATA_DIR/logs). The data dir the installer resolves is rendered into
# the service so the daemon and the CLI can never open different databases.

set -euo pipefail

LABEL="com.engram.mcp"
SERVICE_NAME="engram-mcp.service"
LEGACY_LABEL="ai.hermes.engram-mcp"            # hand-written LaunchAgent from the 0.1.x era
ENGRAM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="${ENGRAM_DIR}/launchd/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="${HOME}/Library/LaunchAgents/${LEGACY_LABEL}.plist"
SYSTEMD_SRC="${ENGRAM_DIR}/systemd/${SERVICE_NAME}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SYSTEMD_DST="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
DATA_DIR="${ENGRAM_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/engram}"
LOG_DIR="${ENGRAM_LOGS_DIR:-$DATA_DIR/logs}"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/engram"
ENV_FILE="${ENGRAM_ENV_FILE:-${ENV_DIR}/env}"
PORT="${ENGRAM_MCP_PORT:-9907}"
HOST="127.0.0.1"
OS="$(uname -s)"
HEALTH_WAIT_SECS="${ENGRAM_HEALTH_WAIT_SECS:-30}"

# Up-front tool checks: one line naming what to install, instead of a bare
# "command not found" halfway through.
need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: '$1' not found — $2" >&2
        exit 1
    fi
}
if [ "$OS" = "Linux" ]; then
    need systemctl "on Linux this installer needs systemd user services; without it run 'scripts/run-mcp-daemon.sh' under your own supervisor"
else
    need launchctl "this installer targets macOS launchd (Linux: systemd user units, Windows: scripts/install-mcp-daemon.ps1)"
fi
need npm "install Node.js 22+ (https://nodejs.org); it ships npm"

ensure_dirs() {
    mkdir -p "$LOG_DIR" "$DATA_DIR"
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

# Create the shared service env file once (same file the dream daemon reads);
# never rewrite an existing one, only tighten its permissions.
ensure_env_file() {
    if [ -f "$ENV_FILE" ]; then
        chmod 600 "$ENV_FILE"
        return 0
    fi
    mkdir -p "$ENV_DIR"
    chmod 700 "$ENV_DIR"
    (
        umask 077
        {
            echo "# engram service environment — sourced by scripts/run-mcp-daemon.sh and scripts/run-dream.sh."
            echo "# One NAME=value per line (shell syntax, quote values with spaces). Keep this file mode 600."
            echo "# MCP daemon settings (all optional):"
            echo "#ENGRAM_DATA_DIR=          # where engram.db lives; the installer rendered '${DATA_DIR}' into the service"
            echo "#ENGRAM_MODEL_CACHE_DIR=   # durable embedding-model cache (npm ci wipes node_modules/.cache)"
            echo "#ENGRAM_HTTP_WORKERS=2     # tool-call worker threads (0 = inline)"
            echo "#ENGRAM_MCP_PORT=9907      # loopback port for /mcp and /health"
            echo "# Dream daemon providers (see scripts/install-daemon.sh):"
            echo "#ANTHROPIC_API_KEY="
            echo "#OPENROUTER_API_KEY="
            echo "#ENGRAM_LOCAL_MODEL="
        } > "$ENV_FILE"
    )
    chmod 600 "$ENV_FILE"
    echo "Created $ENV_FILE (mode 600) — ENGRAM_* overrides and API keys live here, never in the plist/unit."
}

# health_ok — succeeds when GET /health on 127.0.0.1:$PORT answers 200.
# Order: node (mandatory for engram anyway), then curl.
health_ok() {
    local node_bin
    node_bin="$(command -v node 2>/dev/null || true)"
    if [ -n "$node_bin" ]; then
        "$node_bin" -e '
            const req = require("node:http").get({ host: process.argv[1], port: Number(process.argv[2]), path: "/health", timeout: 2000 },
              (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); });
            req.on("timeout", () => { req.destroy(); process.exit(1); });
            req.on("error", () => process.exit(1));
        ' "$HOST" "$PORT"
        return $?
    fi
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1
        return $?
    fi
    echo "Warning: cannot probe /health — install node (https://nodejs.org) or curl." >&2
    return 1
}

health_json() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" 2>/dev/null || true
    fi
}

wait_for_health() {     # wait_for_health up|down
    local want="$1" i=0
    while [ "$i" -lt "$HEALTH_WAIT_SECS" ]; do
        if [ "$want" = "up" ] && health_ok; then return 0; fi
        if [ "$want" = "down" ] && ! health_ok; then return 0; fi
        sleep 1; i=$((i + 1))
    done
    return 1
}

# A process on the port that no supervisor owns (a hand-started `node server.js
# --http`, or a previous install) must go before the service can bind. Only lsof
# maps a port to a PID portably enough here; without it we just warn.
stop_port_holder() {
    if command -v lsof >/dev/null 2>&1; then
        local pids
        pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
        if [ -n "$pids" ]; then
            echo "Stopping unsupervised process(es) on ${HOST}:${PORT}: $(echo "$pids" | tr '\n' ' ')"
            echo "$pids" | xargs kill 2>/dev/null || true
            wait_for_health down || true
        fi
    elif health_ok; then
        echo "Warning: something already answers on ${HOST}:${PORT}/health; the service cannot bind until it is stopped." >&2
    fi
}

render() {   # render SRC DST
    sed -e "s|__ENGRAM_DIR__|${ENGRAM_DIR}|g" \
        -e "s|__NODE_BIN__|${NODE_BIN}|g" \
        -e "s|__LOG_DIR__|${LOG_DIR}|g" \
        -e "s|__DATA_DIR__|${DATA_DIR}|g" \
        "$1" > "$2"
    if grep -q "__[A-Z_]*__" "$2"; then
        echo "Error: unresolved placeholder in rendered service:" >&2
        grep -n "__[A-Z_]*__" "$2" >&2
        rm -f "$2"
        exit 1
    fi
}

build_and_resolve() {
    ensure_dirs
    ensure_env_file
    echo "Building engram..."
    (cd "$ENGRAM_DIR" && npm run build)
    NODE_BIN="$(resolve_node)"
    echo "Using node: $NODE_BIN ($($NODE_BIN --version))"
}

print_summary() {
    echo ""
    echo "Engram MCP daemon installed and running."
    echo "  Service:  $1"
    echo "  Endpoint: http://${HOST}:${PORT}/mcp   (health: http://${HOST}:${PORT}/health)"
    echo "  Data dir: $DATA_DIR"
    echo "  Env file: $ENV_FILE"
    echo "  Logs:     $LOG_DIR/mcp.log"
    echo ""
    echo "To restart after a rebuild: $0 restart"
    echo "To check:                   $0 status   (or: engram doctor)"
    echo "To uninstall:               $0 uninstall"
}

# --- macOS (launchd) ---------------------------------------------------------

launchd_loaded() { launchctl list "$1" >/dev/null 2>&1; }

# The 0.1.x docs had people hand-write ~/Library/LaunchAgents/ai.hermes.engram-mcp.plist
# for the same port. Two agents cannot share it, so retire the old one: unload it and
# rename the file (reversible) so launchd does not load it again at next login.
retire_legacy_agent() {
    if [ -f "$LEGACY_PLIST" ]; then
        echo "Found legacy LaunchAgent ${LEGACY_LABEL}; retiring it in favour of ${LABEL}."
        launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
        mv "$LEGACY_PLIST" "${LEGACY_PLIST}.retired-by-engram"
        echo "  Moved to ${LEGACY_PLIST}.retired-by-engram (delete it once ${LABEL} is confirmed healthy)."
        wait_for_health down || true
    elif launchd_loaded "$LEGACY_LABEL"; then
        echo "Unloading legacy LaunchAgent ${LEGACY_LABEL} (no plist file found; it will not return at login)."
        launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
        wait_for_health down || true
    fi
}

install_launchd() {
    if [ ! -f "$PLIST_SRC" ]; then
        echo "Error: plist template not found at $PLIST_SRC" >&2
        exit 1
    fi
    build_and_resolve
    if launchd_loaded "$LABEL"; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
        wait_for_health down || true
    fi
    retire_legacy_agent
    stop_port_holder
    render "$PLIST_SRC" "$PLIST_DST"
    launchctl load "$PLIST_DST"
    if wait_for_health up; then
        print_summary "$PLIST_DST"
    else
        echo "Error: ${LABEL} loaded but /health did not answer within ${HEALTH_WAIT_SECS}s. Check ${LOG_DIR}/mcp-error.log" >&2
        exit 1
    fi
}

uninstall_launchd() {
    if [ -f "$PLIST_DST" ]; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
        rm -f "$PLIST_DST"
        wait_for_health down || true
        echo "Engram MCP daemon unloaded and removed. (Env file left in place: $ENV_FILE)"
    else
        echo "Service not installed (plist not found at $PLIST_DST)."
    fi
}

start_launchd() {
    if [ ! -f "$PLIST_DST" ]; then
        echo "Service not installed. Run '$0 install' first." >&2
        exit 1
    fi
    launchd_loaded "$LABEL" || launchctl load "$PLIST_DST"
    launchctl kickstart "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    if wait_for_health up; then echo "Engram MCP daemon is up: http://${HOST}:${PORT}/health"; else
        echo "Error: /health did not answer within ${HEALTH_WAIT_SECS}s. Check ${LOG_DIR}/mcp-error.log" >&2; exit 1; fi
}

stop_launchd() {
    if launchd_loaded "$LABEL"; then
        launchctl unload "$PLIST_DST" 2>/dev/null || launchctl remove "$LABEL" 2>/dev/null || true
    fi
    if wait_for_health down; then echo "Engram MCP daemon stopped."; else
        echo "Warning: something still answers on ${HOST}:${PORT}/health after ${HEALTH_WAIT_SECS}s (an unsupervised process? run '$0 status')." >&2; exit 1; fi
}

restart_launchd() {
    if [ ! -f "$PLIST_DST" ]; then
        echo "Service not installed. Run '$0 install' first." >&2
        exit 1
    fi
    # kickstart -k restarts the running job in place and KeepAlive brings it back
    # if it is not running; both leave the plist loaded.
    launchd_loaded "$LABEL" || launchctl load "$PLIST_DST"
    launchctl kickstart -k "gui/$(id -u)/${LABEL}"
    if wait_for_health up; then echo "Engram MCP daemon restarted: http://${HOST}:${PORT}/health"; else
        echo "Error: /health did not answer within ${HEALTH_WAIT_SECS}s. Check ${LOG_DIR}/mcp-error.log" >&2; exit 1; fi
}

status_launchd() {
    if launchd_loaded "$LABEL"; then
        launchctl list "$LABEL" 2>/dev/null | grep -E '"(PID|LastExitStatus)"' || true
        echo "Service ${LABEL}: loaded"
    else
        echo "Service ${LABEL}: not loaded"
    fi
    if [ -f "$LEGACY_PLIST" ] || launchd_loaded "$LEGACY_LABEL"; then
        echo "Warning: legacy LaunchAgent ${LEGACY_LABEL} is still present; '$0 install' retires it."
    fi
    status_common
}

# --- Linux (systemd user units) ---------------------------------------------

install_systemd() {
    if [ ! -f "$SYSTEMD_SRC" ]; then
        echo "Error: systemd template not found at $SYSTEMD_SRC" >&2
        exit 1
    fi
    build_and_resolve
    mkdir -p "$SYSTEMD_USER_DIR"
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    stop_port_holder
    render "$SYSTEMD_SRC" "$SYSTEMD_DST"
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE_NAME"
    if wait_for_health up; then
        print_summary "$SYSTEMD_DST"
        echo "The user service only runs while your user session exists. To run it"
        echo "without being logged in: loginctl enable-linger $(id -un)"
    else
        echo "Error: ${SERVICE_NAME} started but /health did not answer within ${HEALTH_WAIT_SECS}s. Check ${LOG_DIR}/mcp-error.log" >&2
        exit 1
    fi
}

uninstall_systemd() {
    if [ -f "$SYSTEMD_DST" ]; then
        systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
        rm -f "$SYSTEMD_DST"
        systemctl --user daemon-reload
        wait_for_health down || true
        echo "Engram MCP daemon disabled and unit removed. (Env file left in place: $ENV_FILE)"
    else
        echo "Service not installed (no unit at $SYSTEMD_DST)."
    fi
}

start_systemd() {
    [ -f "$SYSTEMD_DST" ] || { echo "Service not installed. Run '$0 install' first." >&2; exit 1; }
    systemctl --user start "$SERVICE_NAME"
    if wait_for_health up; then echo "Engram MCP daemon is up: http://${HOST}:${PORT}/health"; else
        echo "Error: /health did not answer within ${HEALTH_WAIT_SECS}s. See: journalctl --user -u ${SERVICE_NAME}" >&2; exit 1; fi
}

stop_systemd() {
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    if wait_for_health down; then echo "Engram MCP daemon stopped."; else
        echo "Warning: something still answers on ${HOST}:${PORT}/health after ${HEALTH_WAIT_SECS}s (an unsupervised process? run '$0 status')." >&2; exit 1; fi
}

restart_systemd() {
    [ -f "$SYSTEMD_DST" ] || { echo "Service not installed. Run '$0 install' first." >&2; exit 1; }
    systemctl --user restart "$SERVICE_NAME"
    if wait_for_health up; then echo "Engram MCP daemon restarted: http://${HOST}:${PORT}/health"; else
        echo "Error: /health did not answer within ${HEALTH_WAIT_SECS}s. See: journalctl --user -u ${SERVICE_NAME}" >&2; exit 1; fi
}

status_systemd() {
    if [ -f "$SYSTEMD_DST" ]; then
        systemctl --user status --no-pager "$SERVICE_NAME" 2>/dev/null | head -5 || true
        echo "Service ${SERVICE_NAME}: $(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)"
    else
        echo "Service ${SERVICE_NAME}: not installed"
    fi
    status_common
}

# --- shared -----------------------------------------------------------------

status_common() {
    if health_ok; then
        echo "Health:   http://${HOST}:${PORT}/health -> ok $(health_json)"
    else
        echo "Health:   http://${HOST}:${PORT}/health -> not answering"
    fi
    echo "Data dir: $DATA_DIR$( [ -f "$DATA_DIR/engram.db" ] && echo "  (engram.db present)" || echo "  (no engram.db here yet)")"
    if [ -n "${ENGRAM_DATA_DIR:-}" ]; then
        echo "          (from ENGRAM_DATA_DIR)"
    fi
    local legacy="$HOME/.local/share/engram"
    if [ "$DATA_DIR" != "$legacy" ] && [ -f "$legacy/engram.db" ]; then
        echo "Warning:  a second database exists at $legacy/engram.db — run 'engram doctor' to see which one the CLI uses."
    fi
    echo "Env file: $ENV_FILE$( [ -f "$ENV_FILE" ] && echo "" || echo "  (missing; '$0 install' creates it)")"
    if [ -f "${LOG_DIR}/mcp.log" ]; then
        echo ""
        echo "Last 5 log lines (${LOG_DIR}/mcp.log):"
        tail -5 "${LOG_DIR}/mcp.log"
    fi
    if [ -f "${LOG_DIR}/mcp-error.log" ]; then
        local errors
        errors="$(tail -5 "${LOG_DIR}/mcp-error.log" 2>/dev/null)"
        if [ -n "$errors" ]; then
            echo ""
            echo "Last 5 error lines:"
            echo "$errors"
        fi
    fi
}

case "${1:-}" in
    install)   if [ "$OS" = "Linux" ]; then install_systemd;   else install_launchd;   fi ;;
    uninstall) if [ "$OS" = "Linux" ]; then uninstall_systemd; else uninstall_launchd; fi ;;
    start)     if [ "$OS" = "Linux" ]; then start_systemd;     else start_launchd;     fi ;;
    stop)      if [ "$OS" = "Linux" ]; then stop_systemd;      else stop_launchd;      fi ;;
    restart)   if [ "$OS" = "Linux" ]; then restart_systemd;   else restart_launchd;   fi ;;
    status)    if [ "$OS" = "Linux" ]; then status_systemd;    else status_launchd;    fi ;;
    *)
        echo "Usage: $0 {install|uninstall|start|stop|restart|status}"
        exit 1
        ;;
esac
