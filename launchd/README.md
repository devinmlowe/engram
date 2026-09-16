# Launchd

macOS Launch Agent plist files for scheduled and persistent engram services. Install to `~/Library/LaunchAgents/` via [scripts/install-daemon.sh](../scripts/install-daemon.sh). The Linux equivalent of the nightly dream agent lives in [systemd/](../systemd/) (user unit + timer, same installer); Windows uses [scripts/install-daemon.ps1](../scripts/install-daemon.ps1) (Task Scheduler).

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

- [scripts/install-daemon.sh](../scripts/install-daemon.sh) — Installs the dream plist to LaunchAgents (macOS) or the systemd user timer (Linux)
- [scripts/install-daemon.ps1](../scripts/install-daemon.ps1) — Windows sibling for the nightly dream task using Task Scheduler
- [systemd/](../systemd/) — Linux sibling templates (`engram-dream.service` + `engram-dream.timer`) rendered from the same placeholders
- [scripts/install-visualizer.sh](../scripts/install-visualizer.sh) — Installs visualizer service
- [scripts/install-visualizer.ps1](../scripts/install-visualizer.ps1) — Windows sibling adapter using Task Scheduler
- [docs/lessons-learned-launchd-env.md](../docs/lessons-learned-launchd-env.md) — Environment pitfalls
- [docs/research/daemon-launchd-patterns.md](../docs/research/daemon-launchd-patterns.md) — Design research
