# Lessons Learned: launchd and Environment Variables

**Date:** 2026-03-03
**Context:** engram dream daemon failing with "No extraction provider configured"

## Problem

The engram dream daemon (`com.engram.dreamstate`) runs as a macOS launchd agent scheduled at 2am. After adding OpenRouter as the primary extraction provider, dream runs began failing:

```
Dream run failed: No extraction provider configured.
Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable.
```

The `.env` file in the repo root had both keys set correctly.

## Root Cause

**launchd does not source `.env` files, shell profiles, or any shell initialization.** It runs processes in a minimal environment with only the variables explicitly declared in the plist's `<EnvironmentVariables>` dict.

The plist only had:
- `NODE_ENV=production`
- `PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`

No API keys were included.

## Fix

Added `OPENROUTER_API_KEY` to the plist `EnvironmentVariables` section, then reloaded:

```bash
launchctl unload ~/Library/LaunchAgents/com.engram.dreamstate.plist
launchctl load ~/Library/LaunchAgents/com.engram.dreamstate.plist
```

## Key Takeaways

1. **launchd has its own environment** — it does not inherit from your shell, `.bashrc`, `.zshrc`, Fish config, or `.env` files. Every variable the process needs must be explicitly declared in the plist.

2. **Adding a new env var dependency to code requires updating the plist** — when a feature adds a new `process.env.X` dependency, the launchd plist must be updated too. This is easy to miss because local development (running from a shell) always works.

3. **The `.env` file is a development convenience, not a deployment mechanism** — for launchd services, the plist is the source of truth for environment configuration.

4. **Debugging tip:** `launchctl list | grep <label>` shows the service status. A `-` for PID means it's waiting for the next scheduled run. Exit code `0` means last run succeeded; `1` means it failed.

5. **fnm/nvm node paths in plists are fragile** — the plist references a specific fnm multishell path (`/Users/.../.local/state/fnm_multishells/91891_.../bin/node`). These paths are ephemeral and will break after a reboot or new shell session. Consider using a stable symlink or the fnm default alias path instead.

## Checklist for Future launchd Services

- [ ] List all `process.env.*` references the code depends on
- [ ] Add each to the plist `EnvironmentVariables` dict
- [x] Use stable paths for interpreters (not fnm multishell paths) — resolved via `resolve_node()` in `scripts/install-daemon.sh`, which prefers `~/.local/share/fnm/aliases/default/bin/node` over ephemeral multishell paths
- [ ] Test with `launchctl start <label>` after changes
- [ ] Check logs at the paths defined in `StandardOutPath` / `StandardErrorPath`
