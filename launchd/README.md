# Launchd

macOS Launch Agent plist files for scheduled and persistent engram services. Install to `~/Library/LaunchAgents/` via [scripts/install-daemon.sh](../scripts/install-daemon.sh).

## In Scope

- launchd plist definitions for engram background services
- Scheduling configuration (calendar intervals, keep-alive)

## Out of Scope

- Service implementation logic (see [src/dream/](../src/dream/) and [src/interfaces/web/](../src/interfaces/web/))
- Installation scripts (see [scripts/](../scripts/))

## Contains

- [com.engram.dreamstate.plist](./com.engram.dreamstate.plist) — Nightly dream consolidation (2 AM schedule). Runs `scripts/run-dream.sh --daemon`, which sources `~/.config/engram/env` for API keys; the plist itself carries no secrets.
- [com.engram.visualizer.plist](./com.engram.visualizer.plist) — Web visualization server (keep-alive)

Both files are templates: `__ENGRAM_DIR__`, `__NODE_BIN__`, and `__LOG_DIR__` are substituted by the install scripts, and [tests/deployment/paths.test.ts](../tests/deployment/paths.test.ts) enforces that no personal paths or API keys are committed here.

## See Also

- [scripts/install-daemon.sh](../scripts/install-daemon.sh) — Installs plists to LaunchAgents
- [scripts/install-visualizer.sh](../scripts/install-visualizer.sh) — Installs visualizer service
- [docs/lessons-learned-launchd-env.md](../docs/lessons-learned-launchd-env.md) — Environment pitfalls
- [docs/research/daemon-launchd-patterns.md](../docs/research/daemon-launchd-patterns.md) — Design research
