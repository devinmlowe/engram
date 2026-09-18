---
module: config
level: L2
derives-from: ../SPEC.md
status: draft
verified-by: ../../../tests/contracts/config-defaults.test.ts
---

# Config

Provides system-wide configuration with sensible defaults and environment variable overrides. Single source of truth for all configurable parameters.

## Requirements

- **REQ-1**: The module shall provide a complete `EngramConfig` with defaults for all fields. *(traces to _core)*
- **REQ-2**: The module shall override defaults from environment variables (ENGRAM_DB_PATH, ENGRAM_DATA_DIR, etc.). *(traces to _core)*
- **REQ-3**: `modelCacheDir` shall always resolve to a durable directory, in precedence `ENGRAM_MODEL_CACHE_DIR` → programmatic override → `$HF_HOME/hub` → `<data dir>/models`; the library default inside `node_modules` is never chosen. *(#53)*

## Interface Contract

### Postconditions

- **POST-1**: `loadConfig()` shall always return a valid, complete `EngramConfig` — never partial.

### Invariants

- **INV-1**: Configuration shall be immutable after loading — no runtime mutation.
