# memory_history — append-only trigger-based audit trail

Status: spec (dev-spec, card t_2a879d52) · Branch `memory-history-spec` off `main` @ abf0c28 ·
Acceptance suite: SPEC-001…012 (RED against `main`):
`tests/semantic/memory-history.test.ts`, `tests/semantic/memory-history-scans.test.ts`,
`tests/interfaces/cli/history-export.test.ts`.

`memory_history` is a **trigger-based, append-only audit trail** over the `memories` table,
additive to the existing app-written `memory_changes` log (`src/semantic/forget.ts:249` — no
hashes, not trigger-based; untouched by this work). Where `memory_changes` records what the
forget surface *says* it did, `memory_history` records what the database *did* — every
write fires, no matter which code path made it. Dolt was adjudicated NO; this is a trigger
table only.

## Instrument set — text-of-record, transported VERBATIM

### Archivist's five spec lines (verbatim)

1. **Append-only, enforced.** No update/delete paths on history rows — the table's integrity *is* the audit trail's integrity. If a history row can be edited, the trail is testimony, not evidence.
2. **Before/after hashes, not just text.** Storing a content hash alongside the text lets a future verifier prove a replay corpus row is unmodified — the same principle as my PDF MD5 earlier in this thread. Cheap now, load-bearing later.
3. **Actor + mechanism fields distinct.** `actor` (which agent) and `mechanism` (edit/forget/purge/restore) as separate columns, so the harness can slice the temporal suite by correction type instead of re-parsing prose.
4. **A retention decision for the history table itself.** The un-chosen-retention trap applies to the audit trail too — `memory_history` grows unboundedly and nobody notices until it's a problem. One line in the spec: history rows are retained indefinitely (they're tiny), *or* Devin names a horizon. Indefinite is my recommendation; an audit trail that expires is an audit trail with amnesia.
5. **A custody export hook.** Periodic export of `memory_history` into `archivist.db` (or a JSON append) makes the audit trail part of household record custody — which concretely delivers the engine-decoupling I argued for last round: the trail survives any future backend swap, including a hypothetical Dolt one, because the durable copy lives outside the engine.

### Trust-boundary clause (lead-researcher, spec-ready wording, VERBATIM)

Trust boundary: the append-only triggers on `memory_history` are enforced against application code paths only; any actor with direct write access to `engram.db` can drop the triggers or edit rows. The trail's evidentiary guarantee therefore rests on the combination of (a) triggers — no in-band edit path; (b) content hashes on before/after values — tampering is detectable, not prevented; (c) custody export to `archivist.db` — a durable copy exists outside the engine's write reach. The spec must state this boundary explicitly and must not describe the table as immutable without qualification.

### Custody-boundary note (archivist, verbatim intent)

the `archivist.db` copy lives under archivist-profile custody exclusively — Engram tooling, dream jobs, and future migrations never gain a write path to it; the export is append-only with the same hash discipline on the receiving end. Two separately-controlled stores = two-key tamper arrangement.

## Normative design

### Table (adjudicated baseline)

```sql
CREATE TABLE memory_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id      TEXT NOT NULL,
  mechanism      TEXT NOT NULL CHECK(mechanism IN ('insert','edit','forget','purge','restore')),
  before_content TEXT,
  after_content   TEXT,
  before_hash     TEXT,
  after_hash      TEXT,
  actor           TEXT,                -- nullable: triggers cannot see app state
  at              INTEGER NOT NULL DEFAULT (unixepoch())
);
```

- Hashes are **sha256 hex** of the UTF-8 bytes of the content column, computed inside the
  trigger via an in-process better-sqlite3 custom function (adjudicated acceptable).
- **Absent-content convention (deterministic):** an absent side is `NULL` in *both* the
  content column and the hash column. Never `''`, never `sha256('')`. A present side always
  carries both text and matching hash.
- **Retention:** history rows are retained **indefinitely** — no purge, no TTL (archivist
  line 4, recommendation adopted). **Devin is the sole override authority** for any future
  retention horizon; the migration records this in the table's doc comment.

### Trigger semantics

Five triggers, all created by one checkpointed migration
(`memory_history_v1`, following the `migrateForget` / `schema_migrations` idiom — appended
to `SCHEMA_MIGRATIONS`, **not** added to `BREAKING_MIGRATIONS` because it is purely
additive):

| Trigger | On | Fires when | Records |
|---|---|---|---|
| `memory_history_on_insert` | `memories` AFTER INSERT | always | mechanism `insert`; before absent; after = content + hash |
| `memory_history_on_update` | `memories` AFTER UPDATE | **WHEN content or is_active changed** | classified below |
| `memory_history_on_delete` | `memories` AFTER DELETE | always | mechanism `purge`; before = content + hash; after absent |
| `memory_history_no_update` | `memory_history` BEFORE UPDATE | always | `RAISE(ABORT, … append-only …)` |
| `memory_history_no_delete` | `memory_history` BEFORE DELETE | always | `RAISE(ABORT, … append-only …)` |

UPDATE classification, in priority order (evaluated per statement via OLD/NEW):

1. `content` changed → **`edit`** (before/after content + hashes)
2. else `is_active` 1 → 0 → **`forget`** (before content + hash; after absent) — covers the
   forget tool's soft delete (`src/semantic/forget.ts:367`), supersession
   (`src/semantic/memory.ts:237`), and dream prune (`src/dream/daemon.ts:757`)
3. else `is_active` 0 → 1 → **`restore`** (before absent; after content + hash — `src/semantic/forget.ts:456`)
4. else (a statement that changed neither) → **no history row**

Metadata-only updates — recall reinforcement (`recordAccess`, `src/semantic/memory.ts:288`),
FSRS stability (`applyContradiction`, `:310`), confidence/importance bumps — record
**nothing**. This is what keeps the recall path write-neutral (SPEC-012) and the trail
sliced by *correction* type, exactly as archivist line 3 asks, instead of flooding it with
an access bump per recall.

A single UPDATE that changes both content and `is_active` classifies as `edit` (priority 1)
and records one row. Trigger-written rows are transactional: they roll back with the
statement's transaction.

### Actor stamping

Triggers cannot see app state, so the `actor` column is stamped from a **per-connection
actor context** read via an in-process custom function (`engram_actor()`), falling back to
the sentinel **`unknown`**. The card's "temp-table per-connection pattern" is **not
implementable**: SQLite raises `trigger … cannot reference objects in database temp` for a
main-schema trigger (probed on better-sqlite3, this repo's version). Two patterns are
proven feasible and either is acceptable:

- **(chosen for this spec)** a custom function registered per connection at DB open
  (`initDatabase`), reading a connection-scoped actor set/cleared by the app path
  **inside the same transaction** that performs the write;
- a single-row main-schema context table, written and cleared inside the same transaction.

Normative API (exported so app paths can bracket their transactions):

- `src/_core/db/history.ts` (new): `registerHistoryFunctions(db)` (registers
  `engram_sha256` and `engram_actor`; called from `initDatabase`), `withHistoryActor(db,
  actor, fn)` (set/clear bracket), `listMemoryHistory(db, opts?)`, type `MemoryHistoryRow`.
- `src/semantic/forget.ts`: `forgetMemory` / `editMemory` / `restoreMemory` wrap their
  existing transactions with `withHistoryActor(db, options.actor, …)` — the actor they
  already take for `memory_changes`.
- Paths with no actor concept (dream prune, transfer import, raw statements) record the
  sentinel `unknown`; the spec does **not** require them to grow an actor, and **no path
  ever fabricates an actor**. Actors never leak: a context-free write after an app-path
  write on the same connection stamps `unknown`, not the previous actor.

### Append-only enforcement

`memory_history_no_update` / `memory_history_no_delete` `RAISE(ABORT)` on any UPDATE or
DELETE of history rows. In addition, app code must never contain a write against
`memory_history` (textual scan, SPEC-009): no `UPDATE memory_history`, no `DELETE FROM
memory_history` — including comments. Phrase doc comments so those
patterns do not appear. Engram tooling never references `archivist.db` at all
— the SPEC-009 scan is zero-tolerance: **any** textual occurrence of
`archivist.db` anywhere under `src/` (code or comment) is a violation, so the
boundary is auditable with a single grep. The copy lives under
archivist-profile custody exclusively.

### Custody export hook

CLI `engram history export` (registered via `registerHistoryCommand(program)` in
`src/interfaces/cli/history.ts`, wired into `src/interfaces/cli/index.ts`):

- `--since-id <id>` — **exclusive** cursor: exports rows with `id > since-id`, ordered
  `id ASC`. Omitted/0 → from the beginning. Beyond the last row → empty slice.
- `--out <path>` — write to the caller-provided path; without it, stdout. Engram never
  picks the destination and never writes `archivist.db` (the receiving side is
  archivist-profile work, out of scope).
- `--json` — one JSON object per line (JSONL), keys exactly the table column names
  (`id`, `memory_id`, `mechanism`, `before_content`, `after_content`, `before_hash`,
  `after_hash`, `actor`, `at`) — a faithful projection of the row, custody-copy fidelity.
  Default (no `--json`) prints one human-readable line per row.
- Core query: `listMemoryHistory(db, { sinceId })` in `src/_core/db/history.ts` — the CLI
  is a thin formatter/IO shell over it.

## Requirements (SPEC-001…012) — every requirement maps to ≥1 test, every test traces here

| ID | Requirement | Test file |
|---|---|---|
| SPEC-001 | Migration idempotence + provable no-op: checkpointed `memory_history_v1`, exact baseline schema, 5 triggers, re-open is a no-op | `tests/semantic/memory-history.test.ts` |
| SPEC-002 | Insert records a history row with `after_hash = sha256(after_content)` (UTF-8 pinned) | same |
| SPEC-003 | Edit records before/after content **and** both hashes (edit tool + `updateMemory`) | same |
| SPEC-004 | Soft delete records mechanism `forget` (forget tool + supersede) | same |
| SPEC-005 | Purge records mechanism `purge`; absent-content convention (NULL⇔NULL, never `sha256('')`) tested explicitly | same |
| SPEC-006 | Restore records mechanism `restore` (before absent, after content + hash) | same |
| SPEC-007 | UPDATE/DELETE on `memory_history` abort with an append-only message; rows unchanged | same |
| SPEC-008 | Actor stamping: real actor on app paths, sentinel `unknown` fallback, never fabricated/leaked | same |
| SPEC-009 | Negative scans: no app UPDATE/DELETE against `memory_history`; no write-open of `archivist.db` in `src/` | `tests/semantic/memory-history-scans.test.ts` |
| SPEC-010 | Export hook: exclusive `--since-id` cursor, id ASC, row shape, JSONL key correctness, CLI tree + wiring | `tests/interfaces/cli/history-export.test.ts` |
| SPEC-011 | Trust-boundary clause present **verbatim** in this doc; schema doc comment states indefinite retention + Devin's sole override; no unqualified "immutable" anywhere the trail is described | `tests/semantic/memory-history-scans.test.ts` |
| SPEC-012 | Zero recall-path behavior change: reinforcement/metadata updates write no rows, recall behavior intact with triggers active, history rows are transactional | `tests/semantic/memory-history.test.ts` |

Fixtures derive from the real write sites (cited file:line in the tests, verified against
`main` @ abf0c28): `src/semantic/memory.ts:114/208/237/288/310`,
`src/semantic/forget.ts:367/403/432/456`, `src/dream/daemon.ts:757`,
`src/interfaces/cli/transfer.ts:529`. Never invented.

## Out of scope

- Archivist-side ingestion of the export (separate archivist-profile work).
- The temporal recall harness (card t_ec74a86a) — it *consumes* this trail.
- Any recall-behavior change; any Dolt migration; touching `memory_changes`.
- Actor context for dream prune / transfer import (sentinel `unknown` is compliant).

## Verification notes (what this suite cannot prove)

- "Pre-existing suites green with triggers active" (SPEC-012's full guarantee) is a
  whole-repo gate: the builder must run `npm run test:run` and the verifier re-runs it on a
  clean checkout. The in-suite SPEC-012 tests prove the trigger surface does not alter
  recall-path semantics at the write sites it probes.
- The textual negative scans (SPEC-009, SPEC-011) are regex over source and docs; they
  cannot catch semantic smuggling (e.g. a write path reaching the table through dynamic
  SQL). The RAISE(ABORT) triggers (SPEC-007) are the enforced backstop.
- Direct inserts into `memory_history` remain SQL-possible (append-only blocks
  UPDATE/DELETE, not INSERT); app code is kept honest by the SPEC-009 scan and by code
  review, and tampering is detectable by the hash discipline.
