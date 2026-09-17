/**
 * Commitments pass of the dream EXTRACT phase.
 *
 * For each conversation that has never been scanned for commitments (or has
 * grown since its last scan) the pass builds the extraction prompt, runs the
 * configured LLM, validates the JSON, dedupes against the ledger and inserts
 * the survivors as pending commitments. Every conversation is checkpointed
 * under phase "commitments" (cross-run, unlike the per-run fact checkpoints)
 * so a nightly run only pays for new material. Extraction errors are logged
 * and skipped — the pass never throws into the dream run.
 */

import type Database from "better-sqlite3";
import type { EngramConfig } from "../_core/types/index.js";
import {
  buildCommitmentsPrompt,
  parseCommitmentsResponse,
  filterByCue,
  dedupeCandidates,
  insertCommitments,
  defaultCommitmentsLlm,
  hasCommitmentsProvider,
  type Commitment,
  type CommitmentCandidate,
  type CommitmentExchange,
  type CommitmentsLlm,
  type CommitmentsEmbed,
} from "../semantic/commitments.js";
import { recordCheckpoint, recordFailure } from "./scheduler.js";

export const COMMITMENTS_PHASE = "commitments";

/** Conversations scanned per run unless ENGRAM_COMMITMENTS_MAX_CONVERSATIONS overrides it. */
export const DEFAULT_MAX_CONVERSATIONS = 60;

/** Exchanges per LLM call. */
const CHUNK_SIZE = 25;

/** Conversations whose user text is shorter than this carry nothing to extract. */
const MIN_USER_TEXT_CHARS = 40;

export interface CommitmentsPassOptions {
  /** Dream run id — when set, each conversation is checkpointed under phase "commitments". */
  runId?: string;
  /** Explicit conversations to scan (bypasses the never-scanned selection). */
  conversationIds?: string[];
  /** Cap on conversations per pass (ignored when conversationIds is given). */
  maxConversations?: number;
  /** Injectable LLM call (tests); defaults to the configured provider cascade. */
  callLlm?: CommitmentsLlm;
  /** Injectable embedding call for cosine dedupe; defaults to the embedding model. */
  embed?: CommitmentsEmbed;
  log?: (message: string, data?: Record<string, unknown>) => void;
  onProgress?: (processed: number, total: number, errors: number) => void;
  shouldStop?: () => boolean;
}

export interface CommitmentsPassResult {
  conversations: number;
  skipped: number;
  candidates: number;
  /** Candidates dropped by the first-person cue guard. */
  rejected: number;
  duplicates: number;
  inserted: number;
  errors: number;
  model?: string;
  items: Commitment[];
  /** Set when the pass could not run at all (no provider). */
  disabledReason?: string;
}

export interface ConversationCommitmentsResult {
  candidates: number;
  rejected: number;
  duplicates: number;
  inserted: number;
  skipped: boolean;
  lexicalOnly: boolean;
  model?: string;
  items: Commitment[];
}

export function maxConversationsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.ENGRAM_COMMITMENTS_MAX_CONVERSATIONS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_CONVERSATIONS;
}

/**
 * Conversations never checkpointed for commitments, or re-indexed since their
 * last successful scan (the transcript grew). Newest first.
 */
export function selectConversationsForCommitments(db: Database.Database, limit: number): string[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      `SELECT c.id
       FROM conversations c
       LEFT JOIN (
         SELECT item_id, MAX(processed_at) AS processed_at
         FROM dream_checkpoints
         WHERE phase = ? AND status = 'success'
         GROUP BY item_id
       ) dc ON dc.item_id = c.id
       WHERE dc.item_id IS NULL OR coalesce(c.last_indexed, 0) > dc.processed_at
       ORDER BY c.last_indexed DESC, c.exchange_count DESC
       LIMIT ?`,
    )
    .all(COMMITMENTS_PHASE, limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function loadExchanges(db: Database.Database, conversationId: string): CommitmentExchange[] {
  const rows = db
    .prepare(
      `SELECT id, exchange_index, timestamp, user_message, assistant_message
       FROM exchanges WHERE conversation_id = ? ORDER BY exchange_index ASC`,
    )
    .all(conversationId) as Array<Record<string, unknown>>;
  return rows.map((row, i) => ({
    id: row.id as string,
    index: typeof row.exchange_index === "number" ? (row.exchange_index as number) : i,
    timestamp: (row.timestamp as string) || undefined,
    userMessage: (row.user_message as string) || "",
    assistantMessage: (row.assistant_message as string) || "",
  }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function defaultEmbed(texts: string[]): Promise<number[][]> {
  const { embedDocumentBatch } = await import("../_core/embeddings/index.js");
  return embedDocumentBatch(texts);
}

/**
 * Extract, dedupe and store commitments for one conversation. Does not
 * checkpoint — callers decide (the dream pass does, the manual CLI re-scan
 * deliberately does not).
 */
export async function extractCommitmentsForConversation(
  db: Database.Database,
  conversationId: string,
  options: Pick<CommitmentsPassOptions, "callLlm" | "embed" | "log"> = {},
): Promise<ConversationCommitmentsResult> {
  const callLlm = options.callLlm ?? defaultCommitmentsLlm;
  const embed = options.embed ?? defaultEmbed;
  const exchanges = loadExchanges(db, conversationId);
  const userChars = exchanges.reduce((n, ex) => n + ex.userMessage.trim().length, 0);
  if (exchanges.length === 0 || userChars < MIN_USER_TEXT_CHARS) {
    return { candidates: 0, rejected: 0, duplicates: 0, inserted: 0, skipped: true, lexicalOnly: false, items: [] };
  }

  const conv = db
    .prepare("SELECT project FROM conversations WHERE id = ?")
    .get(conversationId) as { project?: string } | undefined;
  const first = exchanges[0].timestamp?.split("T")[0] ?? "unknown";
  const last = exchanges[exchanges.length - 1].timestamp?.split("T")[0] ?? "unknown";
  const metadata = { project: conv?.project ?? "unknown", dateRange: `${first} to ${last}` };

  const idByIndex = new Map<number, string>();
  const timestamps = new Map<string, string>();
  const userTextById = new Map<string, string>();
  const assistantTextById = new Map<string, string>();
  for (const ex of exchanges) {
    idByIndex.set(ex.index, ex.id);
    if (ex.timestamp) timestamps.set(ex.id, ex.timestamp);
    userTextById.set(ex.id, ex.userMessage);
    assistantTextById.set(ex.id, ex.assistantMessage);
  }

  const candidates: CommitmentCandidate[] = [];
  let model: string | undefined;
  for (const part of chunk(exchanges, CHUNK_SIZE)) {
    const prompt = buildCommitmentsPrompt(part, metadata);
    const { raw, model: usedModel } = await callLlm(prompt);
    model = usedModel;
    candidates.push(...parseCommitmentsResponse(raw, idByIndex));
  }

  const { kept, rejected } = filterByCue(candidates, userTextById, assistantTextById);
  const { fresh, duplicates, lexicalOnly } = await dedupeCandidates(db, kept, { embed });
  const items = insertCommitments(db, fresh, timestamps);
  options.log?.(
    `Commitments for ${conversationId}: ${candidates.length} candidates, ${rejected} rejected (no cue), ` +
      `${items.length} inserted, ${duplicates} duplicates`,
    { model, lexicalOnly },
  );
  return { candidates: candidates.length, rejected, duplicates, inserted: items.length, skipped: false, lexicalOnly, model, items };
}

/**
 * A reachable local Ollama model is a valid provider on its own (SPEC.md
 * INV-3) even without any cloud key or ENGRAM_LOCAL_MODEL pin.
 */
async function localModelReachable(config: EngramConfig): Promise<boolean> {
  const { isOllamaAvailable, buildIntelligenceConfig } = await import("../_core/llm/index.js");
  return isOllamaAvailable(buildIntelligenceConfig(config));
}

/**
 * Run the commitments pass over the selected conversations. Never throws for
 * per-conversation failures; returns `disabledReason` (and does nothing) when
 * no extraction provider is configured or reachable and no LLM was injected.
 */
export async function runCommitmentsPass(
  db: Database.Database,
  config: EngramConfig,
  options: CommitmentsPassOptions = {},
): Promise<CommitmentsPassResult> {
  const log = options.log ?? (() => {});
  const result: CommitmentsPassResult = {
    conversations: 0, skipped: 0, candidates: 0, rejected: 0, duplicates: 0, inserted: 0, errors: 0, items: [],
  };

  if (!options.callLlm && !hasCommitmentsProvider() && !(await localModelReachable(config))) {
    result.disabledReason = "no extraction provider configured (OPENROUTER_API_KEY / ANTHROPIC_API_KEY / ENGRAM_LOCAL_MODEL, or a running Ollama)";
    log(`Commitments pass skipped: ${result.disabledReason}`);
    return result;
  }

  const targets = options.conversationIds
    ?? selectConversationsForCommitments(db, options.maxConversations ?? maxConversationsFromEnv());
  log(`Commitments pass: scanning ${targets.length} conversations`);

  for (const conversationId of targets) {
    if (options.shouldStop?.()) {
      log(`Commitments pass stopping early — ${targets.length - result.conversations} conversations remaining`);
      break;
    }
    try {
      const r = await extractCommitmentsForConversation(db, conversationId, options);
      result.conversations++;
      if (r.skipped) result.skipped++;
      result.candidates += r.candidates;
      result.rejected += r.rejected;
      result.duplicates += r.duplicates;
      result.inserted += r.inserted;
      result.items.push(...r.items);
      if (r.model) result.model = r.model;
      if (options.runId) recordCheckpoint(db, options.runId, COMMITMENTS_PHASE, conversationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors++;
      log(`Commitments extraction failed for ${conversationId}: ${message.slice(0, 300)}`);
      if (options.runId) {
        recordFailure(db, options.runId, COMMITMENTS_PHASE, conversationId, {
          provider: "auto",
          errorClass: /401|403|not set|not configured/i.test(message) ? "permanent" : "transient",
          errorMessage: message.slice(0, 500),
        });
      }
    }
    options.onProgress?.(result.conversations + result.errors, targets.length, result.errors);
  }

  log(
    `Commitments pass complete: ${result.conversations} conversations (${result.skipped} trivial), ` +
      `${result.candidates} candidates → ${result.rejected} rejected (no cue), ${result.inserted} inserted, ${result.duplicates} duplicates, ${result.errors} errors`,
    { model: result.model },
  );
  return result;
}
