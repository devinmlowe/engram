# Scripts

Installation, maintenance, and operational scripts. Bash remains the macOS/Linux path (launchd or systemd user units, chosen by `uname -s`); PowerShell provides the Windows Task Scheduler paths.

## In Scope

- Service installation and uninstallation (launchd, systemd user units, and Windows Task Scheduler)
- Operational wrappers for dream pipeline execution
- Dependency checking and environment validation

## Out of Scope

- Application logic (see [src/](../src/))
- npm scripts defined in [package.json](../package.json) (`build`, `test`, `mcp`, `dev`, `dream`, `lint`)

## Contains

- [install-daemon.sh](./install-daemon.sh) — Install the nightly dream scheduler: launchd agent on macOS, systemd user timer (`engram-dream.timer`) on Linux; `install|uninstall|status|run-now`; creates the [service environment file](#service-environment-file-api-keys) for API keys
- [install-daemon.ps1](./install-daemon.ps1) — Install and control the Windows Task Scheduler nightly dream task (`install|uninstall|status|run-now`)
- [install-visualizer.sh](./install-visualizer.sh) — Install web visualizer launchd agent
- [install-visualizer.ps1](./install-visualizer.ps1) — Install and control the Windows Task Scheduler visualizer task
- [install-mcp-daemon.sh](./install-mcp-daemon.sh) — Install and control the MCP HTTP daemon: launchd agent `com.engram.mcp` on macOS, systemd user unit `engram-mcp.service` on Linux (`install|uninstall|start|stop|restart|status`); every verb waits on `/health`; `status` prints the effective data dir and warns about a second legacy database; `install` retires a hand-written `ai.hermes.engram-mcp` agent (issue #28)
- [run-mcp-daemon.sh](./run-mcp-daemon.sh) — MCP daemon launcher the plist/unit runs: sources the service environment file, then execs `node dist/interfaces/mcp/server.js --http --port ${ENGRAM_MCP_PORT:-9907}`
- [run-visualizer.ps1](./run-visualizer.ps1) — Run the compiled visualizer with explicit Windows paths and restart-on-child-exit behavior
- [install-mcp-daemon.ps1](./install-mcp-daemon.ps1) — Install and control the Windows Task Scheduler MCP HTTP daemon task (`install|uninstall|start|stop|restart|status`); status reports both Task Scheduler state and `/health`; reaps orphaned processes on stop/uninstall
- [run-mcp-daemon.ps1](./run-mcp-daemon.ps1) — Run the compiled MCP server (`--http --port`) with explicit Windows paths and bounded restart-on-failure
- [run-dream.sh](./run-dream.sh) — Dream-cycle launcher: interactive (`tsx`, tee'd log) or `--daemon` (what the launchd plist runs); sources the service environment file first
- [compact-dream.sh](./compact-dream.sh) — Claude Code post-compaction hook: background ingest + extract for the compacted session (needs only `node`; honours `ENGRAM_DATA_DIR` / `ENGRAM_LOGS_DIR`)
- [commitments-surface.sh](./commitments-surface.sh) — Heartbeat digest of the commitments ledger via the HTTP MCP `commitments` tool (count, overdue, due within 7 days; prints nothing when empty). Self-contained node program inside a bash wrapper (no python3). Deployed copy: `~/.hermes/scripts/fleet/commitments-surface.sh`
- [check-deps.sh](./check-deps.sh) — Verify system dependencies are available

## Data directory

Every installer and runner resolves the data directory the way the CLI does: `ENGRAM_DATA_DIR`
if set, else `%LOCALAPPDATA%\engram` on Windows / `$XDG_DATA_HOME/engram` elsewhere, falling
back to the pre-0.2.0 `~/.local/share/engram`. The Windows installers accept `-DataDir` /
`-DbPath` explicitly, and `install-mcp-daemon.ps1 status` reports `dataDir`, `dbPath` and a
`legacyDbPath` when a populated pre-0.2.0 database would be ignored. `engram update --plan`
shows the same picture across platforms.

## Tool prerequisites

Every script checks the external tools it needs up front with `command -v` and exits with a
one-line "install X" message. Beyond a POSIX userland, the installers need `launchctl` (macOS)
and `npm`; the hooks and launchers need only `node`.

## Service environment file (API keys)

The dream daemon reads secrets from `${XDG_CONFIG_HOME:-~/.config}/engram/env`, a mode-600
shell-syntax file that `run-dream.sh` (and `run-mcp-daemon.sh`) source before they start node.
`install-daemon.sh install` (or `install-mcp-daemon.sh install`) creates it with a commented template (seeded from `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` /
`ENGRAM_LOCAL_MODEL` when those are set in your shell) and never overwrites an existing file.
Any variable from the README Configuration table can go there. Override the location with
`ENGRAM_ENV_FILE`.

**Migrating an install made before this file existed.** Older versions of `install-daemon.sh`
wrote the keys in plaintext into `~/Library/LaunchAgents/com.engram.dreamstate.plist`:

1. `./scripts/install-daemon.sh status` — warns if the installed plist still embeds `*_API_KEY`.
2. Put the keys in the env file, e.g. `printf "ANTHROPIC_API_KEY='sk-...'\n" >> ~/.config/engram/env`
   then `chmod 600 ~/.config/engram/env` (or run `install` once to get the template and edit it).
3. `./scripts/install-daemon.sh install` — re-renders a key-free plist and reloads the agent.
4. `./scripts/install-daemon.sh run-now`, then check `~/.local/share/engram/logs/dream-error.log`
   for provider errors.

Schedule, logs, and `ENGRAM_*` overrides are unchanged. You can drop the `export` of the keys
from your shell profile if it only existed for the old installer.

## See Also

- [launchd/](../launchd/) — Plist files installed by these scripts (macOS)
- [systemd/](../systemd/) — User unit + timer templates installed by these scripts (Linux)
- [package.json](../package.json) — npm scripts for development workflows
