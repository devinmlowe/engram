# SPEC — Engram recall-quality eval harness (read-only)

Branch: `eval-harness-spec` (spec card) → `eval-harness-impl` (builder).
Repo state at authoring: main @ `abf0c28`.
Owner card: t_3370c953. Parent: t_ec74a86a.

## Mission
Measure whether Engram's recall ranking is materially weak on the conflict
axis, and produce evidence for/against the query-conditioned-retrieval lever.
**Read-only against the live store. No changes to recall behavior. No new
infrastructure.**

## In scope
- `eval/` harness (TypeScript, repo toolchain: vitest, tsx, better-sqlite3).
- Acceptance suite in `eval/acceptance/` (this card's deliverable).
- Fixtures: captured-real-pair JSON (redacted, cited), seeded mini-DB builder,
  external-comparability sample fixtures.

## Out of scope
- Any change to production recall code (`src/**`), schema, or config.
- Leaderboard submissions or LoCoMo runs (comparability note only).
- Live-store fixtures committed to the repo (the 483MB store is never copied).
- Fixing weaknesses the harness finds — that is future work gated on evidence.

## Live store ground truth (probed 2026-11-18)
- Real store: `~/.local/share/engram/engram.db` (483,700,736 bytes; probed
  counts: memories 25,697 · conflicts 4,948 · memory_changes 18 ·
  memory_suppressions 13). `~/.hermes/engram.db` is a 0-byte stray.
- Resolution follows Engram's own logic: `loadConfig()` / `resolveDefaultDataDir`
  (`src/_core/config/index.ts`), overridable with `--db`.

## Requirements → tests

### SPEC-001 Store-path guard
The harness resolves the store path via Engram's own config logic (or `--db`);
`assertUsableStore(path)` hard-fails with a clear `StoreGuardError` when the
resolved DB is missing, 0 bytes, or not SQLite (header `SQLite format 3`).
Missing module / missing script → nonzero exit, never a silent empty run.
Tests: `spec001-store-guard.test.ts`.

### SPEC-002 Conflict replay suite (PRIMARY)
`runConflictSuite` samples real `conflicts` rows (+ their `memories` rows),
queries recall through Engram's own `searchSemantic` code path, and scores
whether the SURVIVING fact outranks the stale one. Metrics: stale-surfacing
rate and recall@k (k = 1, 3, 10). Hermetic tests run on a seeded mini-DB plus
a fixture derived from a captured real conflict pair (conflict `d385a95a…`,
memories `c95613a4…` surviving / `f5f2e86b…` stale, values redacted).
Tests: `spec002-conflicts.test.ts`.

### SPEC-003 Thin temporal suite + read-only enforcement
`runTemporalSuite` replays `memory_changes` rows (all 18 live; the op mix
probed: forget 14, purge 3, restore 1) scoring ordering/supersede behavior.
Read-only: the harness opens SQLite with better-sqlite3 `readonly: true`
(pinned; mode is the same open path every suite uses); a test asserts
unchanged schema and row counts after a full run.
Tests: `spec003-temporal-readonly.test.ts`.

### SPEC-004 Redaction axis
`runRedactionSuite` iterates `memory_suppressions` rows (13 live) and scores
whether recall surfaces the suppressed content hash. Metric: hash-leakage
rate. On the hermetic mini-DB the ground truth is controlled by the seeder.
Tests: `spec004-redaction.test.ts`.

### SPEC-005 External-comparability hooks
`eval/docs/adapter-format.md` documents a fixture-based adapter format for
LongMemEval (knowledge-update/temporal; arXiv:2410.10813) and MemoryAgentBench
(delete-supersede; arXiv:2507.05257); `eval/fixtures/external/` holds small
sample fixtures whose shape is derived from those papers' public formats and
is labeled as shape-derived, not official data. LoCoMo (arXiv:2402.17753)
appears as a comparability note only — no leaderboard claims.
Tests: `spec005-external.test.ts`.

### SPEC-006 Report + entry points
`npm run eval` runs the hermetic suite and writes `eval/report.json` +
`eval/report.md`; exit 0 on success, nonzero on harness failure. The report
numerically answers "is recall materially weak on the conflict axis"
(`conflictVerdict` with `staleSurfacingRate` and `materiallyWeak` boolean at
threshold ≥ 0.30) and includes a query-conditioned vs plain-query comparison
slice. `npm run eval -- --live` is the read-only live smoke.
Tests: `spec006-report-cli.test.ts`.

### SPEC-007 Hermeticity
All unit tests run against the seeded mini SQLite DB built by the fixture
builder (`buildMiniStore`) — never the live 483MB store. The live store is
exercised only by the `--live` smoke.
Tests: `spec007-hermeticity.test.ts` (+ mini-DB usage asserted in 002–004).

## Module contract (builder implements under `eval/src/`)
- `store.ts`: `resolveStorePath`, `StoreGuardError`, `assertUsableStore`,
  `openStoreReadonly` (better-sqlite3 `{ readonly: true }` + sqlite-vec load).
- `fixtures/mini-store.ts`: `buildMiniStore(dir, seed)` — real `initDatabase`,
  `insertMemory` with repo-generated embeddings, `insertConflict`, direct
  `memory_changes` / `memory_suppressions` seeding.
- `suites/conflicts.ts` / `temporal.ts` / `redaction.ts`: `runConflictSuite(db,
  {k})`, `runTemporalSuite(db)`, `runRedactionSuite(db)` — all recall through
  repo `searchSemantic`, never a reimplementation.
- `score.ts`: pure metric functions (`staleSurfacingRate`, `recallAtK`,
  `redactionLeakageRate`, `orderingCorrectRate`).
- `report.ts`: `buildReport(run)` → JSON object; markdown renderer.
- `cli.ts`: arg parsing (`--db`, `--live`, `--out`), exit codes.
- `comparability/adapter.ts`: `loadExternalFixture(file)` + validators.

## Decisions surfaced by this spec
1. Materially-weak threshold on the conflict axis: stale-surfacing rate
   ≥ 0.30 ⇒ `materiallyWeak: true`. This is a reporting aid, not a verdict on
   Engram; the number itself is the evidence.
2. Query-conditioned slice: "plain" query = surviving-memory content keywords;
   "conditioned" query = conflict-description keywords + surviving content +
   temporal qualifiers. Both slices always reported side by side.
3. Read-only mode pinned to better-sqlite3 `readonly: true` (orchestrator pin).
4. Hermetic embeddings use the repo's own local model pipeline (cached under
   the Engram data dir) — hermetic = no live store, local compute only.

## Sizing (honest)
SPEC-001 S · SPEC-002 M · SPEC-003 S · SPEC-004 S · SPEC-005 S · SPEC-006 M ·
SPEC-007 S. One builder run is plausible but M-sized; the risk concentrates in
SPEC-002 (live sampling + scoring plumbing) and SPEC-006 (CLI/report).
