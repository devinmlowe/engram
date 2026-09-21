/**
 * `extraction smoke` — the doctor check that proves extraction works end to
 * end (#61), instead of letting a user with no working LLM tier learn it from
 * an empty knowledge graph after the first nightly dream.
 *
 * Source: the most recently ingested conversation (`conversations` ordered by
 * `last_indexed`) or, when the database is absent or holds none, the bundled
 * `prompts/smoke-conversation.json`. The input is capped (the last
 * `SMOKE_MAX_EXCHANGES` exchanges, `SMOKE_MAX_CHARS` per message) so a cloud
 * tier costs a few thousand tokens at most, and the whole run — extraction
 * plus consolidation — races a hard `SMOKE_BUDGET_MS` budget.
 *
 * What gets written (the PRD's open question, decided the recommended way):
 * facts from a *real* conversation go through the ordinary consolidator into
 * the real database, stamped `source = 'smoke'` so `engram memories list` finds
 * them and `forget` removes them like any other memory. The bundled fixture is
 * never written: its facts describe a made-up conversation, and this check
 * must never create a database on its own.
 *
 * Failure reporting: a `CascadeError` (thrown by the cascade or wrapped in the
 * extractor's error `cause`) becomes one `<tier>: <reason>` per tried tier.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CascadeError, resolveLlmTimeoutMs, type LlmProvider } from "../../_core/llm/index.js";
import type { EngramConfig, MemorySource } from "../../_core/types/index.js";
import { PACKAGE_ROOT } from "../../_core/version/index.js";
import type { ConversationExchange, ConversationMetadata } from "../../semantic/extractor.js";
import type { ConsolidateOptions } from "../../semantic/consolidator.js";
import type { DeduplicationResult, ExtractedFact, ExtractionResult } from "../../semantic/types.js";

export const SMOKE_BUDGET_MS = 60_000;
export const SMOKE_MAX_EXCHANGES = 3;
export const SMOKE_MAX_CHARS = 2_000;
/** Provenance stamped on the memories the smoke writes. */
export const SMOKE_SOURCE: MemorySource = "smoke";
export const SMOKE_FIXTURE = join(PACKAGE_ROOT, "prompts", "smoke-conversation.json");
/** The env vars a user sets to make some tier reachable; printed with every no-tier verdict. */
export const LLM_PROVIDER_HINT =
  "OLLAMA_HOST / ENGRAM_LOCAL_MODEL, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ENGRAM_OPENAI_BASE_URL + ENGRAM_OPENAI_MODEL";

export type SmokeExtract = (
  conversationId: string,
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
) => Promise<ExtractionResult>;
export type SmokeConsolidate = (
  db: Database.Database,
  facts: ExtractedFact[],
  conversationId: string,
  options: ConsolidateOptions,
) => Promise<DeduplicationResult[]>;

/** Every collaborator is injectable so tests never load a model or talk to a provider. */
export interface SmokeDeps {
  budgetMs?: number;
  maxExchanges?: number;
  maxChars?: number;
  fixturePath?: string;
  extract?: SmokeExtract;
  consolidate?: SmokeConsolidate;
  initEmbeddings?: (config: EngramConfig) => Promise<void>;
  openDb?: (config: EngramConfig) => Database.Database;
}

export interface SmokeTierFailure {
  tier: LlmProvider;
  errorClass: string;
  reason: string;
}

export interface SmokeWritten {
  inserted: number;
  merged: number;
  conflicts: number;
  skipped: number;
  errors: number;
}

export interface SmokeOutcome {
  status: "ok" | "no-tier" | "timeout" | "error" | "skipped";
  source: "conversation" | "fixture" | null;
  conversationId: string | null;
  exchanges: number;
  /** The cascade tier that answered (`tier=` on the doctor line). */
  provider: LlmProvider | null;
  model: string | null;
  /** Facts the tier extracted (`memories=` on the doctor line). */
  memories: number;
  /** Consolidation tally for a real conversation; null when nothing was written (fixture, failure). */
  written: SmokeWritten | null;
  /** One entry per tried tier when no tier answered. */
  tiers: SmokeTierFailure[];
  message: string;
  durationMs: number;
}

interface SmokeSource {
  kind: "conversation" | "fixture";
  id: string;
  exchanges: ConversationExchange[];
  metadata: ConversationMetadata;
  scope: string;
}

interface FixtureFile {
  id: string;
  project: string;
  dateRange?: string;
  exchanges: Array<{ index: number; userMessage: string; assistantMessage: string }>;
}

class SmokeTimeout extends Error {
  constructor(budgetMs: number) {
    super(`timed out after ${budgetMs >= 1000 ? `${Math.round(budgetMs / 1000)}s` : `${budgetMs}ms`}`);
    this.name = "SmokeTimeout";
  }
}

function clip(text: string | null | undefined, maxChars: number): string {
  const s = text ?? "";
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** The bundled conversation, capped like a real one. */
export function loadSmokeFixture(path: string = SMOKE_FIXTURE, maxExchanges = SMOKE_MAX_EXCHANGES, maxChars = SMOKE_MAX_CHARS): SmokeSource {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  const exchanges = parsed.exchanges.slice(-maxExchanges).map((e) => ({
    index: e.index,
    userMessage: clip(e.userMessage, maxChars),
    assistantMessage: clip(e.assistantMessage, maxChars),
  }));
  return {
    kind: "fixture",
    id: parsed.id,
    exchanges,
    metadata: { project: parsed.project, dateRange: parsed.dateRange ?? "" },
    scope: "global",
  };
}

/**
 * The most recently ingested conversation that has exchanges, with the last
 * `maxExchanges` of them clipped to `maxChars`. Null when the store is empty.
 */
export function latestConversation(db: Database.Database, maxExchanges = SMOKE_MAX_EXCHANGES, maxChars = SMOKE_MAX_CHARS): SmokeSource | null {
  const conv = db
    .prepare(
      `SELECT c.id, c.project, c.scope
         FROM conversations c
        WHERE EXISTS (SELECT 1 FROM exchanges e WHERE e.conversation_id = c.id)
        ORDER BY c.last_indexed DESC, c.ended_at DESC, c.rowid DESC
        LIMIT 1`,
    )
    .get() as { id: string; project: string; scope: string | null } | undefined;
  if (!conv) return null;
  const rows = (
    db
      .prepare(
        `SELECT id, exchange_index, user_message, assistant_message, timestamp
           FROM exchanges WHERE conversation_id = ?
          ORDER BY exchange_index DESC LIMIT ?`,
      )
      .all(conv.id, maxExchanges) as Array<{ id: string; exchange_index: number; user_message: string | null; assistant_message: string | null; timestamp: string }>
  ).reverse();
  const day = (ts: string | undefined) => (ts ?? "").split("T")[0];
  return {
    kind: "conversation",
    id: conv.id,
    exchanges: rows.map((r) => ({
      id: r.id,
      index: r.exchange_index,
      userMessage: clip(r.user_message, maxChars),
      assistantMessage: clip(r.assistant_message, maxChars),
    })),
    metadata: { project: conv.project, dateRange: `${day(rows[0]?.timestamp)} to ${day(rows.at(-1)?.timestamp)}` },
    scope: conv.scope ?? "global",
  };
}

/** The CascadeError thrown directly or carried in the `cause` chain (the extractor wraps it). */
export function findCascadeError(err: unknown): CascadeError | null {
  let e: unknown = err;
  for (let hops = 0; hops < 5 && e instanceof Error; hops++) {
    if (e instanceof CascadeError) return e;
    e = e.cause;
  }
  return null;
}

/** `tier=` label: the cascade provider when the result carries it, else derived from the historical tier name. */
export function providerOf(result: Pick<ExtractionResult, "provider" | "tier">): LlmProvider {
  if (result.provider) return result.provider;
  if (result.tier === "local") return "ollama";
  if (result.tier === "openrouter") return "openrouter";
  return "anthropic";
}

export function tallyWritten(results: DeduplicationResult[]): SmokeWritten {
  const w: SmokeWritten = { inserted: 0, merged: 0, conflicts: 0, skipped: 0, errors: 0 };
  for (const r of results) {
    if (r.action === "insert") w.inserted++;
    else if (r.action === "merge") w.merged++;
    else if (r.action === "conflict") w.conflicts++;
    else if (r.action === "skip") w.skipped++;
    else w.errors++;
  }
  return w;
}

/**
 * Race `work` against the budget. The losing extraction keeps running (the
 * providers take no abort signal) but `expired` flips first, and the work
 * checks it before it would write anything.
 */
function withBudget<T>(work: (budget: { expired: boolean }) => Promise<T>, budgetMs: number): Promise<T> {
  const budget = { expired: false };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { budget.expired = true; reject(new SmokeTimeout(budgetMs)); }, budgetMs);
    timer.unref?.();
  });
  return Promise.race([work(budget), timeout]).finally(() => clearTimeout(timer));
}

async function defaultExtract(id: string, exchanges: ConversationExchange[], metadata: ConversationMetadata): Promise<ExtractionResult> {
  const { extractFromConversation } = await import("../../semantic/extractor.js");
  // One chunk: the smallest real extraction the pipeline does.
  return extractFromConversation(id, exchanges, metadata, {
    tier: "auto",
    chunkSize: Math.max(exchanges.length, 1),
    chunkOverlap: 0,
  });
}

async function defaultConsolidate(db: Database.Database, facts: ExtractedFact[], id: string, options: ConsolidateOptions): Promise<DeduplicationResult[]> {
  // No initConsolidator(): the tier that just extracted is reachable, and a
  // conflict-resolution failure is reported per fact (#36), never thrown.
  const { consolidateFacts } = await import("../../semantic/consolidator.js");
  return consolidateFacts(db, facts, id, options);
}

async function defaultInitEmbeddings(config: EngramConfig): Promise<void> {
  const { initEmbeddings } = await import("../../_core/embeddings/index.js");
  await initEmbeddings(config);
}

/** Run the smoke. Never throws: every failure is an outcome. */
export async function runExtractionSmoke(config: EngramConfig, deps: SmokeDeps = {}): Promise<SmokeOutcome> {
  const started = Date.now();
  // A raised ENGRAM_LLM_TIMEOUT_MS (slow local model) would otherwise make the
  // smoke time out before the single request it is measuring can finish.
  const budgetMs = deps.budgetMs ?? Math.max(SMOKE_BUDGET_MS, resolveLlmTimeoutMs());
  const maxExchanges = deps.maxExchanges ?? SMOKE_MAX_EXCHANGES;
  const maxChars = deps.maxChars ?? SMOKE_MAX_CHARS;
  const extract = deps.extract ?? defaultExtract;
  const consolidate = deps.consolidate ?? defaultConsolidate;
  const initEmbeddings = deps.initEmbeddings ?? defaultInitEmbeddings;
  const base = { conversationId: null, exchanges: 0, provider: null, model: null, memories: 0, written: null, tiers: [] as SmokeTierFailure[] };
  const done = (partial: Partial<SmokeOutcome> & Pick<SmokeOutcome, "status" | "source" | "message">): SmokeOutcome =>
    ({ ...base, ...partial, durationMs: Date.now() - started });

  let db: Database.Database | null = null;
  let source: SmokeSource | null = null;
  try {
    if (existsSync(config.dbPath)) {
      // A dedicated connection (not the CLI singleton), opened only when the
      // file already exists: the smoke never creates a database.
      db = deps.openDb ? deps.openDb(config) : await (async () => {
        const { initDatabase } = await import("../../_core/db/schema.js");
        return initDatabase(config);
      })();
      source = latestConversation(db, maxExchanges, maxChars);
    }
    if (!source) {
      if (db) { db.close(); db = null; }
      source = loadSmokeFixture(deps.fixturePath ?? SMOKE_FIXTURE, maxExchanges, maxChars);
    }
  } catch (err) {
    if (db) { try { db.close(); } catch { /* already closed */ } }
    return done({ status: "error", source: source?.kind ?? null, message: `could not pick a conversation: ${err instanceof Error ? err.message : String(err)}` });
  }

  const src = source;
  const where = src.kind === "conversation" ? `conversation ${src.id} (${src.exchanges.length} exchange${src.exchanges.length === 1 ? "" : "s"})` : "bundled fixture";
  try {
    const { result, written } = await withBudget(
      async (budget) => {
        const result = await extract(src.id, src.exchanges, src.metadata);
        let written: SmokeWritten | null = null;
        // Past the budget the verdict is already "timeout": never write late.
        if (budget.expired) throw new SmokeTimeout(budgetMs);
        if (src.kind === "conversation" && db) {
          if (result.facts.length > 0) {
            await initEmbeddings(config);
            written = tallyWritten(await consolidate(db, result.facts, src.id, { scope: src.scope, source: SMOKE_SOURCE }));
          } else {
            written = { inserted: 0, merged: 0, conflicts: 0, skipped: 0, errors: 0 };
          }
        }
        return { result, written };
      },
      budgetMs,
    );
    const provider = providerOf(result);
    const wrote = written
      ? `written to ${config.dbPath} as source=smoke: ${written.inserted} inserted, ${written.merged} merged${written.conflicts ? `, ${written.conflicts} conflicts` : ""}${written.errors ? `, ${written.errors} failed` : ""}; engram memories list --query … / forget removes them`
      : "nothing written — run `engram sync` to index a real conversation";
    return done({
      status: "ok",
      source: src.kind,
      conversationId: src.id,
      exchanges: src.exchanges.length,
      provider,
      model: result.model,
      memories: result.facts.length,
      written,
      message: `tier=${provider} memories=${result.facts.length} (${result.model}; ${where}; ${wrote})`,
    });
  } catch (err) {
    const cascade = findCascadeError(err);
    if (cascade) {
      const tiers = cascade.tierErrors.map((t) => ({ tier: t.tier, errorClass: t.errorClass, reason: t.message }));
      return done({
        status: "no-tier",
        source: src.kind,
        conversationId: src.id,
        exchanges: src.exchanges.length,
        tiers,
        message: `no LLM tier reachable — ${tiers.map((t) => `${t.tier}: ${t.reason}`).join("; ")} — dream will not extract until a provider is configured (${LLM_PROVIDER_HINT})`,
      });
    }
    if (err instanceof SmokeTimeout) {
      return done({
        status: "timeout",
        source: src.kind,
        conversationId: src.id,
        exchanges: src.exchanges.length,
        message: `${err.message} (${where}) — no tier answered within the budget; check the provider's latency or pick a smaller local model (ENGRAM_LOCAL_MODEL)`,
      });
    }
    return done({
      status: "error",
      source: src.kind,
      conversationId: src.id,
      exchanges: src.exchanges.length,
      message: `failed (${where}): ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
}

/** The outcome `--no-smoke` reports. */
export function skippedSmoke(): SmokeOutcome {
  return { status: "skipped", source: null, conversationId: null, exchanges: 0, provider: null, model: null, memories: 0, written: null, tiers: [], message: "skipped (--no-smoke)", durationMs: 0 };
}
