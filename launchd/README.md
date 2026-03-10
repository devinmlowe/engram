# Launchd

macOS Launch Agent plist files for scheduled and persistent engram services. Install to `~/Library/LaunchAgents/` via [scripts/install-daemon.sh](../scripts/install-daemon.sh).

## In Scope

- launchd plist definitions for engram background services
- Scheduling configuration (calendar intervals, keep-alive)

## Out of Scope

- Service implementation logic (see [src/dream/](../src/dream/) and [src/interfaces/web/](../src/interfaces/web/))
- Installation scripts (see [scripts/](../scripts/))

## Contains

- [com.engram.dreamstate.plist](./com.engram.dreamstate.plist) — Nightly dream consolidation (2 AM schedule)
- [com.engram.visualizer.plist](./com.engram.visualizer.plist) — Web visualization server (keep-alive)

## See Also

- [scripts/install-daemon.sh](../scripts/install-daemon.sh) — Installs plists to LaunchAgents
- [scripts/install-visualizer.sh](../scripts/install-visualizer.sh) — Installs visualizer service
- [docs/lessons-learned-launchd-env.md](../docs/lessons-learned-launchd-env.md) — Environment pitfalls
- [docs/research/daemon-launchd-patterns.md](../docs/research/daemon-launchd-patterns.md) — Design research
