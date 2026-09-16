# Scripts

Installation, maintenance, and operational scripts. Bash remains the macOS/Linux path; PowerShell provides the Windows visualizer service path.

## In Scope

- Service installation and uninstallation (launchd and Windows Task Scheduler)
- Operational wrappers for dream pipeline execution
- Dependency checking and environment validation

## Out of Scope

- Application logic (see [src/](../src/))
- npm scripts defined in [package.json](../package.json) (`build`, `test`, `mcp`, `dev`, `dream`, `lint`)

## Contains

- [install-daemon.sh](./install-daemon.sh) — Install dream state launchd agent
- [install-visualizer.sh](./install-visualizer.sh) — Install web visualizer launchd agent
- [install-visualizer.ps1](./install-visualizer.ps1) — Install and control the Windows Task Scheduler visualizer task
- [run-visualizer.ps1](./run-visualizer.ps1) — Run the compiled visualizer with explicit Windows paths and restart-on-child-exit behavior
- [run-dream.sh](./run-dream.sh) — Manual dream cycle wrapper with logging
- [compact-dream.sh](./compact-dream.sh) — Compact dream run with reduced output
- [commitments-surface.sh](./commitments-surface.sh) — Heartbeat digest of the commitments ledger via the HTTP MCP `commitments` tool (count, overdue, due within 7 days; prints nothing when empty). Deployed copy: `~/.hermes/scripts/fleet/commitments-surface.sh`
- [check-deps.sh](./check-deps.sh) — Verify system dependencies are available

## See Also

- [launchd/](../launchd/) — Plist files installed by these scripts
- [package.json](../package.json) — npm scripts for development workflows
