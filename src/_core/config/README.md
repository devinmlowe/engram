# Config

System-wide configuration with sensible defaults and environment variable overrides. Single source of truth for all configurable values.

## In Scope

- Default configuration values for all engram subsystems
- Environment variable override mapping (`ENGRAM_*` prefix)
- Configuration type definitions

## Out of Scope

- Runtime configuration changes (config is read-only after initialization)
- Per-user or per-project configuration files

## Contains

- `index.ts` — Configuration loader with env var overrides, exports `EngramConfig`

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [_core/](../) — Parent shared infrastructure
- [CLAUDE.md](../../../CLAUDE.md) — Lists key configuration variables
