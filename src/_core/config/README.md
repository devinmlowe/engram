# Config

System-wide configuration with sensible defaults and environment variable overrides. Single source of truth for all configurable values.

## In Scope

- Default configuration values for all engram subsystems
- Environment variable override mapping (`ENGRAM_*` prefix)
- Configuration type definitions
- Platform data-dir default (`resolveDefaultDataDir`) and the durable model-cache location (`resolveModelCacheLocation`: `ENGRAM_MODEL_CACHE_DIR` → override → `$HF_HOME/hub` → `<data dir>/models`, #53)

## Out of Scope

- Runtime configuration changes (config is read-only after initialization)
- Per-user or per-project configuration files

## Contains

- `index.ts` — Configuration loader with env var overrides, exports `EngramConfig`; `resolveModelCacheLocation` / `describeModelCacheDir` name the winning tier for `engram doctor` and `engram migrate`

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [_core/](../) — Parent shared infrastructure
- [CLAUDE.md](../../../CLAUDE.md) — Lists key configuration variables
