# Systemd

Linux systemd *user* unit templates for the nightly `engram dream` consolidation and the persistent MCP HTTP daemon. Rendered into `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/` and enabled via [scripts/install-daemon.sh](../scripts/install-daemon.sh) / [scripts/install-mcp-daemon.sh](../scripts/install-mcp-daemon.sh), which select this path when `uname -s` reports `Linux`. No root required.

## In Scope

- Service and timer definitions for the scheduled dream run
- The persistent MCP HTTP daemon service (`Restart=always`, loopback only)
- The same `__ENGRAM_DIR__` / `__NODE_BIN__` / `__LOG_DIR__` (/ `__DATA_DIR__`) placeholder contract as [launchd/](../launchd/), so one installer renders both

## Out of Scope

- Service implementation logic (see [src/dream/](../src/dream/))
- Installation scripts (see [scripts/](../scripts/))
- Visualizer keep-alive on Linux (run `node dist/interfaces/web/server.js` under your own supervisor)

## Contains

- [engram-dream.service](./engram-dream.service) — Oneshot service running `node --max-old-space-size=2048 dist/interfaces/cli/index.js dream` from the checkout; reads optional provider keys from `${XDG_CONFIG_HOME:-~/.config}/engram/env` (the same file `scripts/run-dream.sh` sources on macOS)
- [engram-dream.timer](./engram-dream.timer) — `OnCalendar=*-*-* 02:00:00`, `Persistent=true` (missed runs fire at next login)
- [engram-mcp.service](./engram-mcp.service) — Simple service running `scripts/run-mcp-daemon.sh` (sources the env file, execs `node dist/interfaces/mcp/server.js --http --port ${ENGRAM_MCP_PORT:-9907}`); `Restart=always`, 5 restarts per 600 s; the installer renders `ENGRAM_DATA_DIR` into it (issue #28)

## Operating

```bash
./scripts/install-daemon.sh install     # render + daemon-reload + enable --now engram-dream.timer
./scripts/install-daemon.sh status      # list-timers, service status, last log lines
./scripts/install-daemon.sh run-now     # systemctl --user start engram-dream.service
./scripts/install-daemon.sh uninstall   # disable --now, remove units, daemon-reload
./scripts/install-mcp-daemon.sh install # render + enable --now engram-mcp.service, wait for /health
./scripts/install-mcp-daemon.sh status  # unit state, /health, effective data dir, log tail
loginctl enable-linger "$USER"          # optional: run while logged out
journalctl --user -u engram-dream.service -f
journalctl --user -u engram-mcp.service -f
```

## See Also

- [launchd/](../launchd/) — macOS sibling (`com.engram.dreamstate.plist`)
- [scripts/install-daemon.ps1](../scripts/install-daemon.ps1) — Windows sibling (Task Scheduler)
- [tests/deployment/paths.test.ts](../tests/deployment/paths.test.ts) — Placeholder and path-integrity checks for these templates
