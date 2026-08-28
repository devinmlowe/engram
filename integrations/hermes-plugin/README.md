# Hermes Memory Provider Plugin

Engram as a [Hermes](https://github.com/NousResearch/hermes-agent) external
memory provider: automatic recall from the shared knowledge graph before every
turn, `engram_*` tools for deliberate recall/exploration, and profile-scoped
curated writes. Design rationale: `../../decisions/hermes-memory-provider-integration.md` (ADR-010).

## Install

```fish
npm run build                                   # engram repo root — build dist/
ln -s ~/git/engram/integrations/hermes-plugin ~/.hermes/plugins/engram
```

Then per profile (start with default only):

```yaml
# $HERMES_HOME/config.yaml
memory:
  provider: engram
```

Rollback: `hermes memory off` (or delete the symlink). Phase 1 behavior is
read-mostly; nothing in the engram DB is migrated or rewritten.

## Configuration — `$HERMES_HOME/engram.json`

| Key | Default | Meaning |
|---|---|---|
| `repo_path` | `~/git/engram` | engram checkout containing `dist/` |
| `node_path` | PATH lookup | node ≥22 binary |
| `db_path` | engram default | override the SQLite DB |
| `budget` | 1200 | prefetch token budget |
| `read_scopes` | `global,hermes:<profile>` | recall visibility |
| `idle_kill_s` | 600 | reap the Node child after idle |

## Files

- `__init__.py` — Hermes entry point (`register(ctx)`)
- `provider.py` — `EngramMemoryProvider`
- `mcp_client.py` — stdlib stdio JSON-RPC client
- `plugin.yaml` — Hermes plugin metadata
- `tests/` — pytest suite (run `pytest` here)
