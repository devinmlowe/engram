/**
 * Dream State Daemon — pipeline orchestrator for autonomous memory processing.
 *
 * Composes all Phase 1-4 components into a sequential five-phase pipeline:
 *   INGEST → EXTRACT → CONSOLIDATE → REFLECT → PRUNE
 *
 * Features:
 * - Per-conversation checkpointing for crash-safe processing
 * - Run lifecycle management (create/resume/complete/fail)
 * - Signal handling for graceful shutdown
 * - Skip-and-continue error handling per conversation
 * - Logging to config.logsDir/dream.log
 *
 * Phase 5, Step 3 implementation.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { DreamPhase, DreamReport, EngramConfig } from "../core/types.js";
import type { ExtractedFact } from "../semantic/types.js";
import {
  createRun,
  completeRun,
  failRun,
  getIncompleteRun,
  recordCheckpoint,
  getCheckpointedItems,
  getUnprocessedConversations,
  prioritizeConversations,
} from "./scheduler.js";

// ─── Types ───────────────────────────────────────────────────────

export interface DreamOptions {
  phases?: DreamPhase[];
  conversationId?: string;
  dryRun?: boolean;
  verbose?: boolean;
  onProgress?: (phase: DreamPhase, processed: number, total: number, errors: number) => void;
}

interface PhaseResult {
  phase: DreamPhase;
  itemsProcessed: number;
  errors: number;
  durationMs: number;
}

interface ConversationResult {
  memoriesCreated: number;
  memoriesMerged: number;
  conflictsDetected: number;
  entitiesCreated: number;
  relationshipsCreated: number;
  facts: ExtractedFact[];
}

// ─── Module State ────────────────────────────────────────────────

let shuttingDown = false;

// ─── Signal Handling ─────────────────────────────────────────────

function setupSignalHandlers(logPath: string): void {
  const handler = (signal: string) => {
    shuttingDown = true;
    logEntry(logPath, "daemon", `Received ${signal} — completing current item and shutting down`);
  };

  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

// ─── Logging ─────────────────────────────────────────────────────

function logEntry(logPath: string, phase: string, message: string, extra?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    phase,
    message,
    ...extra,
  };
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // If logging fails, continue processing
  }
}

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Run the dream state processing pipeline.
 *
 * Creates or resumes a dream run, executes phases sequentially,
 * and returns a report of all processing performed.
 */
export async function runDream(
  db: Database.Database,
  config: EngramConfig,
  options: DreamOptions = {},
): Promise<DreamReport> {
  const startedAt = Math.floor(Date.now() / 1000);
  const logDir = config.logsDir;
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "dream.log");

  setupSignalHandlers(logPath);
  shuttingDown = false;

  const phasesToRun = options.phases ?? [
    "ingest", "extract", "consolidate", "reflect", "prune",
  ] as DreamPhase[];

  logEntry(logPath, "daemon", "Dream run starting", {
    phases: phasesToRun,
    dryRun: options.dryRun ?? false,
    conversationId: options.conversationId,
  });

  // Resume or create a run
  let runId: string;
  let skipPhases: Set<DreamPhase> = new Set();

  const incomplete = getIncompleteRun(db);
  if (incomplete && !options.conversationId) {
    runId = incomplete.id;
    skipPhases = new Set(incomplete.phasesCompleted);
    logEntry(logPath, "daemon", `Resuming incomplete run ${runId}`, {
      phasesCompleted: incomplete.phasesCompleted,
    });
  } else {
    runId = createRun(db);
    logEntry(logPath, "daemon", `Created new run ${runId}`);
  }

  const report: DreamReport = {
    startedAt,
    completedAt: 0,
    phases: [],
    newMemories: 0,
    updatedMemories: 0,
    newEntities: 0,
    newRelationships: 0,
    conflictsDetected: 0,
    memoriesPruned: 0,
  };

  try {
    for (const phase of phasesToRun) {
      if (shuttingDown) {
        logEntry(logPath, "daemon", "Shutting down before phase", { phase });
        break;
      }

      if (skipPhases.has(phase)) {
        logEntry(logPath, phase, `Skipping (already completed in previous run)`);
        continue;
      }

      let result: PhaseResult;

      switch (phase) {
        case "ingest":
          result = await runIngestPhase(db, config, runId, logPath, options);
          break;
        case "extract":
          result = await runExtractPhase(db, config, runId, logPath, options, report);
          break;
        case "consolidate":
          result = await runConsolidatePhase(db, config, runId, logPath, options, report);
          break;
        case "reflect":
          result = await runReflectPhase(db, config, runId, logPath, options);
          break;
        case "prune":
          result = await runPrunePhase(db, config, runId, logPath, options, report);
          break;
        default:
          throw new Error(`Unknown phase: ${phase}`);
      }

      report.phases.push(result);
      logEntry(logPath, phase, "Phase complete", {
        itemsProcessed: result.itemsProcessed,
        errors: result.errors,
        durationMs: result.durationMs,
      });

      // Update phases_completed in the run for resume support
      updatePhasesCompleted(db, runId, report.phases.map((p) => p.phase));
    }

    report.completedAt = Math.floor(Date.now() / 1000);
    completeRun(db, runId, report);
    logEntry(logPath, "daemon", "Dream run completed", {
      runId,
      newMemories: report.newMemories,
      newEntities: report.newEntities,
      memoriesPruned: report.memoriesPruned,
    });

    return report;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    failRun(db, runId, errorMsg);
    logEntry(logPath, "daemon", `Dream run failed: ${errorMsg}`);
    throw err;
  }
}

// ─── Phase Runners ───────────────────────────────────────────────

/**
 * INGEST phase: sync new conversations from Claude projects directory.
 */
async function runIngestPhase(
  db: Database.Database,
  config: EngramConfig,
  runId: string,
  logPath: string,
  options: DreamOptions,
): Promise<PhaseResult> {
  const startMs = Date.now();
  logEntry(logPath, "ingest", "Starting ingest phase");

  if (options.dryRun) {
    logEntry(logPath, "ingest", "Dry run — skipping sync");
    return { phase: "ingest", itemsProcessed: 0, errors: 0, durationMs: Date.now() - startMs };
  }

  const { syncConversations } = await import("../episodic/sync.js");
  const { initEmbeddings } = await import("../episodic/embeddings.js");

  await initEmbeddings(config);

  const syncResult = await syncConversations(db, config, { force: false });

  logEntry(logPath, "ingest", "Sync complete", {
    discovered: syncResult.discovered,
    indexed: syncResult.indexed,
    skipped: syncResult.skipped,
    errors: syncResult.errors.length,
  });

  recordCheckpoint(db, runId, "ingest", "sync");

  return {
    phase: "ingest",
    itemsProcessed: syncResult.indexed,
    errors: syncResult.errors.length,
    durationMs: Date.now() - startMs,
  };
}

/**
 * EXTRACT phase: extract facts, entities, and relationships from conversations.
 *
 * This is the most complex phase — it composes the full pipeline:
 * extractFromConversation → extractEntities → resolveEntities → extractRelationships → findOrCreateRelationship
 */
async function runExtractPhase(
  db: Database.Database,
  config: EngramConfig,
  runId: string,
  logPath: string,
  options: DreamOptions,
  report: DreamReport,
): Promise<PhaseResult> {
  const startMs = Date.now();
  logEntry(logPath, "extract", "Starting extract phase");

  // Get conversations to process
  let conversationIds: string[];

  if (options.conversationId) {
    conversationIds = [options.conversationId];
  } else {
    const unprocessed = getUnprocessedConversations(db, runId);
    conversationIds = prioritizeConversations(db, unprocessed);
  }

  if (options.dryRun) {
    logEntry(logPath, "extract", `Dry run — would process ${conversationIds.length} conversations`);
    return { phase: "extract", itemsProcessed: 0, errors: 0, durationMs: Date.now() - startMs };
  }

  // Load checkpoints for skip detection
  const checkpointed = getCheckpointedItems(db, runId, "extract");
  const toProcess = conversationIds.filter((id) => !checkpointed.has(id));

  logEntry(logPath, "extract", `Processing ${toProcess.length} conversations (${checkpointed.size} already checkpointed)`);

  // Lazy-load pipeline components
  const { initExtractor, extractFromConversation } = await import("../semantic/extractor.js");
  const { initGraphExtractor, extractEntities, extractRelationships } = await import("../graph/extractor.js");
  const { resolveEntities } = await import("../graph/resolver.js");
  const { findOrCreateRelationship } = await import("../graph/relationship.js");
  const { initEmbeddings } = await import("../episodic/embeddings.js");

  await initEmbeddings(config);
  await initExtractor();
  await initGraphExtractor();

  // Accumulate facts for batch consolidation in the next phase
  const allFacts: Array<{ conversationId: string; facts: ExtractedFact[] }> = [];
  let processed = 0;
  let errors = 0;

  for (const convId of toProcess) {
    if (shuttingDown) {
      logEntry(logPath, "extract", `Shutting down — ${toProcess.length - processed} conversations remaining`);
      break;
    }

    try {
      const result = await processConversation(
        db, convId, config, logPath,
        extractFromConversation,
        extractEntities,
        resolveEntities,
        extractRelationships,
        findOrCreateRelationship,
      );

      allFacts.push({ conversationId: convId, facts: result.facts });

      report.newMemories += result.memoriesCreated;
      report.newEntities += result.entitiesCreated;
      report.newRelationships += result.relationshipsCreated;
      report.conflictsDetected += result.conflictsDetected;

      recordCheckpoint(db, runId, "extract", convId);
      processed++;

      options.onProgress?.("extract", processed, toProcess.length, errors);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEntry(logPath, "extract", `Error processing conversation ${convId}: ${errorMsg}`);
      recordCheckpoint(db, runId, "extract", `error:${convId}`);
      errors++;
      // Skip and continue to next conversation
    }
  }

  // Store accumulated facts in a temporary table-like structure for consolidation
  // We use a simple approach: store facts as JSON in the run's data
  storePendingFacts(db, runId, allFacts);

  return {
    phase: "extract",
    itemsProcessed: processed,
    errors,
    durationMs: Date.now() - startMs,
  };
}

/**
 * CONSOLIDATE phase: deduplicate and merge extracted facts into the semantic memory store.
 */
async function runConsolidatePhase(
  db: Database.Database,
  config: EngramConfig,
  runId: string,
  logPath: string,
  options: DreamOptions,
  report: DreamReport,
): Promise<PhaseResult> {
  const startMs = Date.now();
  logEntry(logPath, "consolidate", "Starting consolidate phase");

  if (options.dryRun) {
    logEntry(logPath, "consolidate", "Dry run — skipping consolidation");
    return { phase: "consolidate", itemsProcessed: 0, errors: 0, durationMs: Date.now() - startMs };
  }

  const { initConsolidator, consolidateFacts } = await import("../semantic/consolidator.js");
  const { initEmbeddings } = await import("../episodic/embeddings.js");

  await initEmbeddings(config);
  initConsolidator();

  // Retrieve pending facts from the extract phase
  const pendingFacts = loadPendingFacts(db, runId);
  let processed = 0;
  let errors = 0;

  for (const batch of pendingFacts) {
    if (shuttingDown) break;

    try {
      const results = await consolidateFacts(db, batch.facts, batch.conversationId);

      for (const r of results) {
        if (r.action === "insert") report.newMemories++;
        if (r.action === "merge") report.updatedMemories++;
        if (r.action === "conflict") report.conflictsDetected++;
      }

      recordCheckpoint(db, runId, "consolidate", batch.conversationId);
      processed++;

      options.onProgress?.("consolidate", processed, pendingFacts.length, errors);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEntry(logPath, "consolidate", `Error consolidating facts for ${batch.conversationId}: ${errorMsg}`);
      errors++;
    }
  }

  return {
    phase: "consolidate",
    itemsProcessed: processed,
    errors,
    durationMs: Date.now() - startMs,
  };
}

/**
 * REFLECT phase: analyze the knowledge graph for communities and bridge entities.
 */
async function runReflectPhase(
  db: Database.Database,
  _config: EngramConfig,
  runId: string,
  logPath: string,
  options: DreamOptions,
): Promise<PhaseResult> {
  const startMs = Date.now();
  logEntry(logPath, "reflect", "Starting reflect phase");

  if (options.dryRun) {
    logEntry(logPath, "reflect", "Dry run — skipping graph analysis");
    return { phase: "reflect", itemsProcessed: 0, errors: 0, durationMs: Date.now() - startMs };
  }

  const { analyzeGraph, persistAnalysis } = await import("../graph/analyzer.js");

  try {
    const analysis = analyzeGraph(db);
    persistAnalysis(db, analysis);

    recordCheckpoint(db, runId, "reflect", "analysis");

    logEntry(logPath, "reflect", "Graph analysis complete", {
      communities: analysis.communities.length,
      bridgeEntities: analysis.bridgeEntities.length,
      totalNodes: analysis.totalNodes,
      totalEdges: analysis.totalEdges,
    });

    options.onProgress?.("reflect", 1, 1, 0);

    return {
      phase: "reflect",
      itemsProcessed: 1,
      errors: 0,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logEntry(logPath, "reflect", `Error in graph analysis: ${errorMsg}`);
    return {
      phase: "reflect",
      itemsProcessed: 0,
      errors: 1,
      durationMs: Date.now() - startMs,
    };
  }
}

/**
 * PRUNE phase: scan all active memories and deactivate those below the confidence threshold.
 */
async function runPrunePhase(
  db: Database.Database,
  config: EngramConfig,
  runId: string,
  logPath: string,
  options: DreamOptions,
  report: DreamReport,
): Promise<PhaseResult> {
  const startMs = Date.now();
  logEntry(logPath, "prune", "Starting prune phase");

  if (options.dryRun) {
    logEntry(logPath, "prune", "Dry run — skipping pruning");
    return { phase: "prune", itemsProcessed: 0, errors: 0, durationMs: Date.now() - startMs };
  }

  const { isPruneEligible, getMemoryHealth } = await import("../semantic/decay.js");

  // Fetch all active memories
  const memRows = db
    .prepare(
      "SELECT id, type, content, confidence, importance, access_count, created_at, last_accessed, source_exchanges, is_active FROM memories WHERE is_active = 1",
    )
    .all() as Array<{
      id: string;
      type: string;
      content: string;
      confidence: number;
      importance: number;
      access_count: number;
      created_at: number;
      last_accessed: number | null;
      source_exchanges: string | null;
      is_active: number;
    }>;

  logEntry(logPath, "prune", `Scanning ${memRows.length} active memories for pruning`);

  let pruned = 0;
  let scanned = 0;

  for (const row of memRows) {
    if (shuttingDown) break;

    // Reconstruct Memory object for the decay functions
    const memory = {
      id: row.id,
      type: row.type as import("../core/types.js").MemoryType,
      content: row.content,
      confidence: row.confidence,
      importance: row.importance,
      accessCount: row.access_count,
      createdAt: row.created_at,
      lastAccessed: row.last_accessed ?? undefined,
      sourceExchanges: row.source_exchanges ? JSON.parse(row.source_exchanges) : [],
      isActive: row.is_active === 1,
    };

    if (isPruneEligible(memory)) {
      const health = getMemoryHealth(memory);
      // Deactivate the memory
      db.prepare("UPDATE memories SET is_active = 0 WHERE id = ?").run(row.id);
      pruned++;
      logEntry(logPath, "prune", `Pruned memory ${row.id}`, {
        type: row.type,
        confidence: health.confidence,
        retrievability: health.retrievability,
      });
    }

    scanned++;
    if (scanned % 100 === 0) {
      options.onProgress?.("prune", scanned, memRows.length, 0);
    }
  }

  report.memoriesPruned = pruned;
  recordCheckpoint(db, runId, "prune", "scan");

  logEntry(logPath, "prune", `Pruning complete: ${pruned} of ${memRows.length} memories pruned`);

  return {
    phase: "prune",
    itemsProcessed: scanned,
    errors: 0,
    durationMs: Date.now() - startMs,
  };
}

// ─── Pipeline Composition ────────────────────────────────────────

/**
 * Process a single conversation through the full extraction pipeline:
 * 1. Load exchanges from DB
 * 2. Extract semantic facts
 * 3. Extract entities and resolve to graph
 * 4. Extract relationships and persist to graph
 *
 * Returns per-conversation statistics and accumulated facts for later consolidation.
 */
async function processConversation(
  db: Database.Database,
  conversationId: string,
  config: EngramConfig,
  logPath: string,
  extractFromConversation: Function,
  extractEntities: Function,
  resolveEntities: Function,
  extractRelationships: Function,
  findOrCreateRelationship: Function,
): Promise<ConversationResult> {
  // Load exchanges
  const rows = db
    .prepare(
      "SELECT * FROM exchanges WHERE conversation_id = ? ORDER BY exchange_index ASC",
    )
    .all(conversationId) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return {
      memoriesCreated: 0,
      memoriesMerged: 0,
      conflictsDetected: 0,
      entitiesCreated: 0,
      relationshipsCreated: 0,
      facts: [],
    };
  }

  const exchanges = rows.map((row) => ({
    index: row.exchange_index as number,
    userMessage: (row.user_message as string) || "",
    assistantMessage: (row.assistant_message as string) || "",
  }));

  // Get conversation metadata
  const convRow = db
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(conversationId) as Record<string, unknown> | undefined;

  const project = convRow
    ? (convRow.project as string)
    : (rows[0].project as string);
  const firstTimestamp = rows[0].timestamp as string;
  const lastTimestamp = rows[rows.length - 1].timestamp as string;

  const metadata = {
    project,
    dateRange: `${firstTimestamp?.split("T")[0] ?? "unknown"} to ${lastTimestamp?.split("T")[0] ?? "unknown"}`,
  };

  // Determine extraction tier
  const tier = config.dream.localModel ? "auto" : "auto";

  // 1. Semantic fact extraction
  const extractionResult = await extractFromConversation(
    conversationId, exchanges, metadata, { tier },
  );
  const facts: ExtractedFact[] = extractionResult.facts;

  logEntry(logPath, "extract", `Extracted ${facts.length} facts from ${conversationId}`, {
    model: extractionResult.model,
    tier: extractionResult.tier,
  });

  // 2. Entity extraction
  let entitiesCreated = 0;
  let relationshipsCreated = 0;

  try {
    const entityResult = await extractEntities(exchanges, metadata);

    // 3. Entity resolution (creates/merges entities in graph)
    const resolved = await resolveEntities(db, entityResult.entities);

    entitiesCreated = resolved.filter(
      (r: { resolution: { action: string } }) => r.resolution.action === "create",
    ).length;

    // 4. Relationship extraction (using resolved entity IDs)
    const entityList = resolved.map(
      (r: { extracted: { name: string; type: string }; resolution: { entityId: string } }, idx: number) => ({
        index: idx,
        id: r.resolution.entityId,
        name: r.extracted.name,
        type: r.extracted.type,
      }),
    );

    if (entityList.length >= 2) {
      const relResult = await extractRelationships(exchanges, metadata, entityList);

      // 5. Persist relationships
      for (const rel of relResult.relationships) {
        const sourceId = entityList[rel.sourceEntityIndex]?.id;
        const targetId = entityList[rel.targetEntityIndex]?.id;
        if (sourceId && targetId) {
          findOrCreateRelationship(
            db, sourceId, targetId, rel.type,
            rel.context, [conversationId],
          );
          relationshipsCreated++;
        }
      }
    }

    logEntry(logPath, "extract", `Graph: ${entitiesCreated} new entities, ${relationshipsCreated} relationships`, {
      conversationId,
    });
  } catch (err) {
    // Graph extraction failure is non-fatal — we still have the facts
    const errorMsg = err instanceof Error ? err.message : String(err);
    logEntry(logPath, "extract", `Graph extraction failed for ${conversationId} (non-fatal): ${errorMsg}`);
  }

  return {
    memoriesCreated: 0, // Will be counted during consolidation
    memoriesMerged: 0,
    conflictsDetected: 0,
    entitiesCreated,
    relationshipsCreated,
    facts,
  };
}

// ─── Pending Facts Storage ───────────────────────────────────────

/**
 * Store extracted facts from the extract phase for batch consolidation.
 * Uses a simple JSON blob in the dream_runs error field as scratch space,
 * or more properly, a dedicated SQLite table if available.
 *
 * For simplicity, we store as JSON in a file in the logs directory.
 */
function storePendingFacts(
  db: Database.Database,
  runId: string,
  facts: Array<{ conversationId: string; facts: ExtractedFact[] }>,
): void {
  if (facts.length === 0) return;

  // Store in a JSON file for retrieval during consolidation
  const dataDir = join(process.env.ENGRAM_DATA_DIR ?? join(process.env.HOME ?? "", ".local/share/engram"), "tmp");
  mkdirSync(dataDir, { recursive: true });
  const filePath = join(dataDir, `pending-facts-${runId}.json`);
  writeFileSync(filePath, JSON.stringify(facts));
}

function loadPendingFacts(
  _db: Database.Database,
  runId: string,
): Array<{ conversationId: string; facts: ExtractedFact[] }> {
  const dataDir = join(process.env.ENGRAM_DATA_DIR ?? join(process.env.HOME ?? "", ".local/share/engram"), "tmp");
  const filePath = join(dataDir, `pending-facts-${runId}.json`);

  if (!existsSync(filePath)) return [];

  try {
    const data = readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function updatePhasesCompleted(
  db: Database.Database,
  runId: string,
  phases: DreamPhase[],
): void {
  db.prepare("UPDATE dream_runs SET phases_completed = ? WHERE id = ?")
    .run(JSON.stringify(phases), runId);
}
