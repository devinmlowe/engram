#!/usr/bin/env node
import { Command } from "commander";
import { join } from "node:path";
import { loadConfig } from "../../_core/config/index.js";
import { getDatabase, closeDatabase } from "../../_core/db/index.js";
import { ENGRAM_VERSION } from "../../_core/version/index.js";
import { loadPreflight } from "./preflight.js";
import { registerMemoriesCommand } from "./memories.js";

const program = new Command();

program
  .name("engram")
  .description("Cognitive memory system for Claude Code")
  .version(ENGRAM_VERSION);

// ─── sync ──────────────────────────────────────────────────────

program
  .command("sync")
  .description("Sync and index conversations from Claude projects")
  .option("-p, --project <name>", "Only sync a specific project")
  .option("-f, --force", "Force re-index all conversations")
  .option("-n, --dry-run", "Show what would be synced without indexing")
  .action(async (opts) => {
    const { syncConversations } = await import("../../episodic/sync.js");
    const config = loadConfig();
    const db = getDatabase(config);

    try {
      console.log("Syncing conversations...");
      const result = await syncConversations(db, config, {
        project: opts.project,
        force: opts.force,
        dryRun: opts.dryRun,
      });

      console.log(`\nSync complete:`);
      console.log(`  Discovered: ${result.discovered}`);
      console.log(`  Copied:     ${result.copied}`);
      console.log(`  Indexed:    ${result.indexed}`);
      console.log(`  Skipped:    ${result.skipped}`);

      if (result.errors.length > 0) {
        console.log(`  Errors:     ${result.errors.length}`);
        for (const err of result.errors) {
          console.error(`    ${err.file}: ${err.error}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

// ─── search ────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search indexed conversations")
  .option("-l, --limit <n>", "Max results", "10")
  .option("-m, --mode <mode>", "Search mode: hybrid, vector, text", "hybrid")
  .option("--after <date>", "Only results on/after date (YYYY-MM-DD)")
  .option("--before <date>", "Only results before date (YYYY-MM-DD, that day excluded)")
  .option(
    "--date-hint <phrase>",
    'Natural-language date window: "last week", "in March", "this day last year", "on this day"',
  )
  .option(
    "--date-basis <basis>",
    "Which timestamp dates apply to: filed (when recorded) or event (when it happened)",
    "filed",
  )
  .option("--budget <tokens>", "Token budget for results", "1500")
  .option("--json", "Print the raw RecallResponse as JSON (ids, metadata, dateFilter)")
  .option(
    "--no-reinforce",
    "Do not reinforce returned memories (skip FSRS access_count/stability growth)",
  )
  .action(async (query, opts) => {
    const { unifiedSearch, formatRecallXml } = await import(
      "../shared/search.js"
    );
    const { initEmbeddings } = await import("../../_core/embeddings/index.js");
    const config = loadConfig();
    const db = getDatabase(config);

    try {
      if (opts.dateBasis !== "filed" && opts.dateBasis !== "event") {
        console.error(`Invalid --date-basis "${opts.dateBasis}" (expected filed or event)`);
        process.exit(1);
      }

      await initEmbeddings(config);

      const response = await unifiedSearch(db, {
        query,
        mode: opts.mode as "hybrid" | "vector" | "text",
        limit: parseInt(opts.limit, 10),
        budget: parseInt(opts.budget, 10),
        after: opts.after,
        before: opts.before,
        dateHint: opts.dateHint,
        dateBasis: opts.dateBasis as "filed" | "event",
        reinforce: opts.reinforce !== false,
      }, config);

      if (opts.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      if (response.results.length === 0) {
        const df = response.dateFilter;
        const scope = df
          ? ` (date filter: basis=${df.basis}${df.after ? ` after=${df.after}` : ""}${df.before ? ` before=${df.before}` : ""}${df.anniversary ? ` anniversary=${df.anniversary.month}-${df.anniversary.day}` : ""}${df.note ? `; ${df.note}` : ""})`
          : "";
        console.log(`No results found.${scope}`);
        return;
      }

      console.log(formatRecallXml(response));
    } finally {
      closeDatabase();
    }
  });

// ─── remember ──────────────────────────────────────────────────

program
  .command("remember <content>")
  .description("Store a fact, preference, or knowledge as a semantic memory")
  .option(
    "-t, --type <type>",
    "Memory type (preference, decision, pattern, fact, solution, convention)",
    "fact",
  )
  .option(
    "-i, --importance <n>",
    "Importance score (0-1)",
    "0.7",
  )
  .action(async (content, opts) => {
    const { initEmbeddings } = await import(
      "../../_core/embeddings/index.js"
    );
    const { rememberFact } = await import("../shared/remember.js");

    const config = loadConfig();
    const db = getDatabase(config);

    try {
      const importance = parseFloat(opts.importance);
      const type = opts.type;

      // Validate type before paying for the multi-second model load
      const validTypes = [
        "preference",
        "decision",
        "pattern",
        "fact",
        "solution",
        "convention",
      ];
      if (!validTypes.includes(type)) {
        console.error(
          `Invalid type: ${type}. Must be one of: ${validTypes.join(", ")}`,
        );
        process.exit(1);
      }

      await initEmbeddings(config);

      const result = await rememberFact(db, {
        content,
        type: type as import("../../_core/types/index.js").MemoryType,
        importance,
      });

      if (result.action === "updated") {
        console.log(`Updated existing memory: ${result.memoryId}`);
      } else {
        console.log(`Remembered: ${content}`);
      }
    } finally {
      closeDatabase();
    }
  });

// ─── memories ──────────────────────────────────────────────────

// `engram memories list|show|edit|delete|restore|purge|log` (#55)
registerMemoriesCommand(program);

// ─── extract ───────────────────────────────────────────────────

program
  .command("extract <conversation-id>")
  .description("Extract semantic facts from a conversation")
  .option(
    "--tier <tier>",
    "Extraction tier (auto, haiku, sonnet)",
    "auto",
  )
  .option("--reflexion", "Enable reflexion pass for completeness")
  .option("--dry-run", "Show extracted facts without consolidating")
  .action(async (conversationId, opts) => {
    const { initEmbeddings } = await import("../../_core/embeddings/index.js");
    const { initExtractor, extractFromConversation } = await import(
      "../../semantic/extractor.js"
    );
    const { consolidateFacts, initConsolidator } = await import(
      "../../semantic/consolidator.js"
    );

    const config = loadConfig();
    const db = getDatabase(config);

    try {
      await initEmbeddings(config);
      await initExtractor();

      // Load exchanges for this conversation
      const rows = db
        .prepare(
          "SELECT * FROM exchanges WHERE conversation_id = ? ORDER BY exchange_index ASC",
        )
        .all(conversationId) as Array<Record<string, unknown>>;

      if (rows.length === 0) {
        console.error(
          `No exchanges found for conversation: ${conversationId}`,
        );
        process.exit(1);
      }

      // Convert rows to ConversationExchange format
      const exchanges = rows.map((row) => ({
        id: row.id as string,
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
        dateRange: `${firstTimestamp.split("T")[0]} to ${lastTimestamp.split("T")[0]}`,
      };

      console.log(
        `Extracting facts from ${exchanges.length} exchanges...`,
      );

      const tier = opts.tier as "auto" | "haiku" | "sonnet";
      const result = await extractFromConversation(
        conversationId,
        exchanges,
        metadata,
        {
          tier,
          reflexionEnabled: opts.reflexion ?? false,
        },
      );

      console.log(
        `\nExtracted ${result.facts.length} facts (model: ${result.model}, tier: ${result.tier})`,
      );

      if (result.facts.length === 0) {
        console.log("No facts extracted.");
        return;
      }

      // Print extracted facts
      for (const fact of result.facts) {
        console.log(
          `  [${fact.type}] ${fact.content} (importance: ${fact.importance})`,
        );
      }

      if (opts.dryRun) {
        console.log("\n(dry run — facts not consolidated)");
        return;
      }

      // Consolidate
      console.log("\nConsolidating...");
      await initConsolidator();

      // W2: extracted facts inherit the conversation's tenant scope (ADR-010)
      const convScope = (
        db.prepare("SELECT scope FROM conversations WHERE id = ?").get(conversationId) as
          | { scope: string | null }
          | undefined
      )?.scope ?? "global";
      const consolidationResults = await consolidateFacts(
        db,
        result.facts,
        conversationId,
        { scope: convScope },
      );

      // Report
      const actions = {
        insert: 0,
        merge: 0,
        conflict: 0,
        skip: 0,
        error: 0,
      };
      for (const cr of consolidationResults) {
        actions[cr.action]++;
      }

      console.log("\nConsolidation complete:");
      console.log(`  Inserted: ${actions.insert}`);
      console.log(`  Merged:   ${actions.merge}`);
      console.log(`  Conflicts: ${actions.conflict}`);
      console.log(`  Skipped:  ${actions.skip}`);
      if (actions.error > 0) console.log(`  Failed:   ${actions.error}`);
    } finally {
      closeDatabase();
    }
  });

// ─── stats ─────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show database statistics")
  .option("--json", "Print the row counts as JSON (what `engram update` compares before/after)")
  .action(async (opts) => {
    const { statSync } = await import("node:fs");
    const config = loadConfig();
    const db = getDatabase(config);

    try {
      if (opts.json) {
        const { snapshotCounts } = await import("./snapshot.js");
        const size = statSync(config.dbPath).size;
        console.log(JSON.stringify({ db: config.dbPath, size, counts: snapshotCounts(db) }, null, 2));
        return;
      }
      const exchangeCount = (
        db.prepare("SELECT COUNT(*) as count FROM exchanges").get() as {
          count: number;
        }
      ).count;

      const convCount = (
        db.prepare("SELECT COUNT(*) as count FROM conversations").get() as {
          count: number;
        }
      ).count;

      const toolCount = (
        db.prepare("SELECT COUNT(*) as count FROM tool_calls").get() as {
          count: number;
        }
      ).count;

      // Semantic memory counts
      const memoryCount = (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM memories WHERE is_active = 1",
          )
          .get() as { count: number }
      ).count;

      const inactiveMemoryCount = (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM memories WHERE is_active = 0",
          )
          .get() as { count: number }
      ).count;

      const conflictCount = (
        db.prepare("SELECT COUNT(*) as count FROM conflicts").get() as {
          count: number;
        }
      ).count;

      const unresolvedConflicts = (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM conflicts WHERE resolution IS NULL",
          )
          .get() as { count: number }
      ).count;

      const lastSync = db
        .prepare(
          "SELECT MAX(last_indexed) as ts FROM conversations",
        )
        .get() as { ts: number | null };

      let dbSize = "unknown";
      try {
        const stat = statSync(config.dbPath);
        dbSize = `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
      } catch {
        // ignore
      }

      console.log("Engram Statistics:");
      console.log(`  Database:      ${config.dbPath}`);
      console.log(`  Size:          ${dbSize}`);
      console.log("");
      console.log("  Episodic:");
      console.log(`    Exchanges:     ${exchangeCount}`);
      console.log(`    Conversations: ${convCount}`);
      console.log(`    Tool Calls:    ${toolCount}`);
      console.log("");
      console.log("  Semantic:");
      console.log(`    Memories:      ${memoryCount} active, ${inactiveMemoryCount} superseded`);
      console.log(`    Conflicts:     ${conflictCount} total, ${unresolvedConflicts} unresolved`);

      // Graph statistics
      const entityCount = (
        db
          .prepare("SELECT COUNT(*) as count FROM entities")
          .get() as { count: number }
      ).count;

      const entityTypeCounts = db
        .prepare(
          "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC",
        )
        .all() as Array<{ type: string; count: number }>;

      const relationshipCount = (
        db
          .prepare("SELECT COUNT(*) as count FROM relationships")
          .get() as { count: number }
      ).count;

      const clusterCount = (
        db
          .prepare("SELECT COUNT(*) as count FROM topic_clusters")
          .get() as { count: number }
      ).count;

      console.log("");
      console.log("  Graph:");
      console.log(
        `    Entities:      ${entityCount}${entityTypeCounts.length > 0 ? ` (${entityTypeCounts.map((t) => `${t.count} ${t.type}`).join(", ")})` : ""}`,
      );
      console.log(`    Relationships: ${relationshipCount}`);
      console.log(`    Topic Clusters: ${clusterCount}`);
      console.log("");
      console.log(
        `  Last Sync:     ${lastSync.ts ? new Date(lastSync.ts * 1000).toISOString() : "never"}`,
      );
    } finally {
      closeDatabase();
    }
  });

// ─── backfill-event-ts ─────────────────────────────────────────

program
  .command("backfill-event-ts")
  .description(
    "Recover event_ts (event-time basis) for legacy dream memories from the " +
    "pipeline's pending-facts files; only NULL event_ts rows are written",
  )
  .option("-n, --dry-run", "Report what would change without writing")
  .option(
    "--tmp-dir <path>",
    "Directory holding pending-facts-*.json (default: <dataDir>/tmp)",
  )
  .action(async (opts) => {
    const { backfillEventTsFromPendingFacts } = await import(
      "../../migration/backfill-event-ts.js"
    );
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      const tmpDir = opts.tmpDir ?? join(config.dataDir, "tmp");
      const before = db
        .prepare("SELECT COUNT(*) AS total, SUM(event_ts IS NOT NULL) AS dated FROM memories")
        .get() as { total: number; dated: number };
      const r = backfillEventTsFromPendingFacts(db, tmpDir, { dryRun: opts.dryRun });
      const after = db
        .prepare("SELECT COUNT(*) AS total, SUM(event_ts IS NOT NULL) AS dated FROM memories")
        .get() as { total: number; dated: number };
      console.log(`${r.dryRun ? "[dry run] " : ""}event_ts backfill from ${tmpDir}`);
      console.log(`  files: ${r.files}  facts: ${r.facts}  with sources: ${r.factsWithSources}  unresolved: ${r.unresolvedFacts}`);
      console.log(`  memories matched: ${r.matched}  ${r.dryRun ? "would update" : "updated"}: ${r.updated}  already dated: ${r.alreadySet}`);
      console.log(`  memories: ${before.total} → ${after.total}  dated: ${before.dated ?? 0} → ${after.dated ?? 0}`);
    } finally {
      closeDatabase();
    }
  });

// ─── init ──────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize database and pre-download embedding model")
  .action(async () => {
    const { initEmbeddings, getActiveModel } = await import(
      "../../_core/embeddings/index.js"
    );
    const config = loadConfig();

    console.log("Initializing database...");
    const db = getDatabase(config);
    closeDatabase();
    console.log(`  Database: ${config.dbPath}`);

    // Adopt a pre-0.4.0 node_modules model cache before the first download (#53).
    const { env: transformersEnv } = await import("@xenova/transformers");
    const { applyModelCacheDir } = await import("../../_core/embeddings/model-cache.js");
    const cacheDir = applyModelCacheDir(transformersEnv, config.modelCacheDir, { log: (l) => console.log(`  ${l}`) });
    console.log(`  Model cache: ${cacheDir}`);

    console.log("Downloading embedding model...");
    await initEmbeddings(config);
    console.log(`  Model: ${getActiveModel()}`);

    console.log("Done. Engram is ready.");
  });

// ─── migrate ────────────────────────────────────────────────────

/** The legacy conversation-index importer (was `engram migrate --source` before 0.4.0). */
async function runLegacyImport(opts: { source: string; dryRun?: boolean; batchSize?: string; force?: boolean }): Promise<void> {
  const { runMigration, formatProgress } = await import("../../migration/migrate.js");
  try {
    console.log(`Importing legacy conversation index from: ${opts.source}`);
    const report = await runMigration({
      sourcePath: opts.source,
      dryRun: opts.dryRun,
      batchSize: parseInt(opts.batchSize ?? "32", 10),
      force: opts.force,
      onProgress: (p) => {
        process.stdout.write(`\r${formatProgress(p)}`);
      },
    });

    if (!opts.dryRun) {
      console.log("\n\nImport complete:");
      console.log(`  Exchanges:     ${report.exchangesMigrated}`);
      console.log(`  Tool calls:    ${report.toolCallsMigrated}`);
      console.log(`  Conversations: ${report.conversationsCreated}`);
      console.log(`  Embeddings:    ${report.embeddingsGenerated}`);

      if (report.errors.length > 0) {
        console.log(`  Errors:        ${report.errors.length}`);
        for (const err of report.errors.slice(0, 10)) {
          console.error(`    ${err}`);
        }
        if (report.errors.length > 10) {
          console.error(`    ... and ${report.errors.length - 10} more`);
        }
      }

      const durationSec = report.completedAt
        ? Math.round((report.completedAt - report.startedAt) / 1000)
        : 0;
      console.log(`  Duration:      ${durationSec}s`);
    }
  } catch (err) {
    console.error("Import failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

program
  .command("import-legacy")
  .description("Import a legacy conversation-index SQLite database (was `engram migrate --source` before 0.4.0)")
  .requiredOption(
    "-s, --source <path>",
    "Path to the source conversation-index SQLite database (no default)",
  )
  .option("-n, --dry-run", "Show what would be imported without making changes")
  .option("--batch-size <n>", "Embedding batch size", "32")
  .option("--force", "Force re-import (ignore checkpoints)")
  .action(async (opts) => {
    await runLegacyImport(opts);
  });

// ─── migrate (install / data migration, #44) ──────────────────────

const MIGRATE_TOPICS = ["all", "data-dir", "model-cache", "schema"] as const;

program
  .command("migrate")
  .argument("[topic]", `what to migrate: ${MIGRATE_TOPICS.join(" | ")} (default: all)`)
  .description(
    "Migrate this install: move a pre-0.2.0 data dir into the resolved one, give the embedding model a durable cache, run schema migrations. Idempotent; --dry-run lists every action. (The legacy conversation-index importer is now `engram import-legacy`.)",
  )
  .option("-n, --dry-run", "List every action without changing anything")
  .option("-s, --source <path>", "DEPRECATED: forwards to `engram import-legacy --source`")
  .option("--batch-size <n>", "DEPRECATED (import-legacy option)")
  .option("--force", "DEPRECATED (import-legacy option)")
  .action(async (topic: string | undefined, opts) => {
    if (opts.source) {
      console.error(
        "engram migrate --source is deprecated and will be removed in the next release: use `engram import-legacy --source <path>`. Forwarding...",
      );
      await runLegacyImport(opts);
      return;
    }
    const which = (topic ?? "all") as (typeof MIGRATE_TOPICS)[number];
    if (!MIGRATE_TOPICS.includes(which)) {
      console.error(`Unknown topic "${topic}". Expected one of: ${MIGRATE_TOPICS.join(", ")}`);
      process.exit(2);
    }
    const { homedir } = await import("node:os");
    const { planDataDir, applyDataDirPlan, planModelCache, applyModelCachePlan, modelCacheSourceLabel, reportSchema } = await import("./data-migration.js");
    const { portFor, realProbe } = await import("./services.js");
    const config = loadConfig();
    const penv = { config, env: process.env, platform: process.platform, home: homedir() };
    const dryRun = Boolean(opts.dryRun);
    let failed = false;

    if (which === "all" || which === "data-dir") {
      const plan = planDataDir(penv);
      console.log(`data-dir: effective ${plan.effective} (db: ${plan.effectiveDb}; from ${plan.source})`);
      for (const c of plan.candidates) {
        console.log(`  ${c.populated ? "[db] " : c.exists ? "[dir]" : "[--] "} ${c.dir}  (${c.reasons.join("+")}${c.populated ? `, ${(c.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ""})`);
      }
      if (plan.action.kind === "refuse") {
        console.error(`  !! ${plan.action.reason}: ${plan.action.populated.join(", ")}`);
        failed = true;
      } else if (plan.action.kind === "move" && !dryRun) {
        const mcp = portFor("mcp", process.env)!;
        if (await realProbe(mcp.port, mcp.path)) {
          console.error(`  !! the MCP daemon is running on port ${mcp.port}; stop every engram service first (or run \`engram update\`, which does), then re-run`);
          failed = true;
        } else {
          for (const l of applyDataDirPlan(plan, { dryRun })) console.log(`  ${l}`);
        }
      } else {
        for (const l of applyDataDirPlan(plan, { dryRun })) console.log(`  ${l}`);
      }
    }
    if (which === "all" || which === "model-cache") {
      const plan = planModelCache(penv);
      console.log(`model-cache: ${plan.current} (${plan.durable ? "durable" : "inside node_modules: wiped by npm ci"}; ${modelCacheSourceLabel(plan.source)})`);
      for (const l of applyModelCachePlan(plan, { dryRun })) console.log(`  ${l}`);
    }
    if (which === "all" || which === "schema") {
      if (dryRun) {
        console.log(`schema: would open ${config.dbPath} once so pending schema migrations run`);
      } else if (failed) {
        console.log("schema: skipped (data-dir step failed)");
      } else {
        const report = await reportSchema(config);
        console.log(`schema: ${report.dbPath}`);
        if (report.applied.length === 0) console.log("  no checkpoints recorded (fresh database or pre-checkpoint schema)");
        for (const m of report.applied) {
          console.log(`  ${m.name}${m.applied_at ? `  (${new Date(m.applied_at * 1000).toISOString()})` : ""}`);
        }
      }
    }
    if (failed) process.exit(1);
  });

// ─── update (controlled self-update, #44) ─────────────────────────

program
  .command("update")
  .description(
    "Upgrade this install safely: backup, stop services, pull/npm install, migrate, restart services, verify. --check compares versions; --plan shows what would happen",
  )
  .option("--check", "Print current vs available version and exit")
  .option("--plan", "Read-only: print the full plan (install kind, data dirs, model cache, services) and exit")
  .option("--dry-run", "Alias for --plan")
  .option("-y, --yes", "Do not ask for confirmation")
  .option("--no-backup", "Skip the pre-update backup of the data dir")
  .option("--to <version>", "Target version for npm installs (default: latest)")
  .action(async (opts) => {
    const { homedir } = await import("node:os");
    const { realpathSync } = await import("node:fs");
    const { PACKAGE_ROOT } = await import("../../_core/version/index.js");
    const { defaultServiceDeps } = await import("./services.js");
    const { detectInstall, latestAvailable, formatCheck } = await import("./install-kind.js");
    const { buildUpdatePlan, formatPlan, runUpdate } = await import("./update.js");

    const services = defaultServiceDeps({ engramDir: PACKAGE_ROOT, home: homedir() });
    if (opts.check) {
      const install = await detectInstall({ exec: services.exec, packageRoot: PACKAGE_ROOT });
      for (const l of formatCheck(install, await latestAvailable(install, services.exec))) console.log(l);
      return;
    }
    const thisScript = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return process.argv[1] ?? ""; } })();
    const deps = {
      config: loadConfig(),
      services,
      packageRoot: PACKAGE_ROOT,
      hermesHome: process.env.HERMES_HOME?.trim() || process.env.HERMES_ROOT?.trim() || join(homedir(), ".hermes"),
      now: () => new Date(),
      log: (l: string) => console.log(l),
      node: process.execPath,
      cliScript: (install: { kind: string; root: string }) =>
        install.kind === "git" ? join(install.root, "dist", "interfaces", "cli", "index.js") : thisScript,
    };
    const plan = await buildUpdatePlan(deps, { noBackup: opts.backup === false, to: opts.to });
    for (const l of formatPlan(plan)) console.log(l);
    if (opts.plan || opts.dryRun) return;
    if (plan.blockers.length) process.exit(1);
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error("Not a terminal: re-run with --yes to proceed without confirmation.");
        process.exit(2);
      }
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("\nProceed with the update? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") { console.log("Aborted."); return; }
    }
    console.log("");
    const result = await runUpdate(plan, deps);
    if (!result.ok) process.exit(1);
  });

// ─── validate ───────────────────────────────────────────────────

program
  .command("validate")
  .description(
    "Validate store integrity: embeddings, FTS, search quality, and no vector/FTS rows for forgotten or missing memories (#55). With --source, also compare against a legacy conversation-index database",
  )
  .option(
    "-s, --source <path>",
    "Path to a legacy conversation-index SQLite database to compare row counts and content against",
  )
  .option("--fix", "Repair orphaned memory vector/FTS rows before reporting")
  .action(async (opts) => {
    const { runValidation } = await import("../../migration/validate.js");

    try {
      console.log("Running validation checks...\n");
      const results = await runValidation({
        sourcePath: opts.source,
        fix: Boolean(opts.fix),
      });

      let passed = 0;
      let failed = 0;

      for (const result of results) {
        const status = result.passed ? "PASS" : "FAIL";
        const icon = result.passed ? "+" : "x";
        console.log(`  [${icon}] ${status}: ${result.check}`);

        if (!result.passed) {
          console.log(
            `       Expected: ${result.expected}, Actual: ${result.actual}`,
          );
          if (result.details) {
            console.log(`       ${result.details}`);
          }
        }

        if (result.passed) passed++;
        else failed++;
      }

      console.log(`\nResults: ${passed} passed, ${failed} failed`);

      if (failed > 0) {
        process.exit(1);
      }
    } catch (err) {
      console.error(
        "Validation failed:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  });

// ─── entities ─────────────────────────────────────────────────

program
  .command("entities")
  .description("List entities in the knowledge graph")
  .option("-t, --type <type>", "Filter by entity type")
  .option("-l, --limit <n>", "Max results", "20")
  .option("--search <query>", "Search entities by name")
  .action(async (opts) => {
    const { getAllEntities, ftsSearchEntities, getEntity } = await import(
      "../../graph/entity.js"
    );
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      if (opts.search) {
        const results = ftsSearchEntities(db, opts.search, parseInt(opts.limit, 10));
        if (results.length === 0) {
          console.log("No entities found.");
          return;
        }
        for (const r of results) {
          const entity = getEntity(db, r.id);
          if (entity) {
            console.log(
              `  [${entity.type}] ${entity.name} (mentions: ${entity.mentionCount})`,
            );
            if (entity.description) console.log(`    ${entity.description}`);
          }
        }
      } else {
        const entities = getAllEntities(db, opts.type);
        if (entities.length === 0) {
          console.log("No entities found.");
          return;
        }
        const limited = entities.slice(0, parseInt(opts.limit, 10));
        for (const e of limited) {
          console.log(
            `  [${e.type}] ${e.name} (mentions: ${e.mentionCount})`,
          );
          if (e.description) console.log(`    ${e.description}`);
        }
        if (entities.length > limited.length) {
          console.log(`  ... and ${entities.length - limited.length} more`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

// ─── relationships ────────────────────────────────────────────

program
  .command("relationships <entity>")
  .description("Show relationships for an entity")
  .option("-t, --type <type>", "Filter by relationship type")
  .action(async (entity, opts) => {
    const { getEntityByName, getEntityByAlias, getEntity } = await import(
      "../../graph/entity.js"
    );
    const { getRelationshipsForEntity } = await import(
      "../../graph/relationship.js"
    );
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      // Find entity
      const found =
        getEntityByName(db, entity) ?? getEntityByAlias(db, entity);
      if (!found) {
        console.error(`Entity not found: ${entity}`);
        process.exit(1);
      }
      const rels = getRelationshipsForEntity(db, found.id);
      const filtered = opts.type
        ? rels.filter((r) => r.type === opts.type)
        : rels;
      if (filtered.length === 0) {
        console.log(`No relationships found for ${found.name}.`);
        return;
      }
      console.log(`Relationships for ${found.name} (${found.type}):\n`);
      for (const rel of filtered) {
        const isSource = rel.sourceEntityId === found.id;
        const otherId = isSource ? rel.targetEntityId : rel.sourceEntityId;
        const other = getEntity(db, otherId);
        const dir = isSource ? "->" : "<-";
        console.log(
          `  ${dir} ${rel.type} ${other?.name ?? otherId} (weight: ${rel.weight.toFixed(2)})`,
        );
        if (rel.context) console.log(`    ${rel.context}`);
      }
    } finally {
      closeDatabase();
    }
  });

// ─── explore ──────────────────────────────────────────────────

program
  .command("explore <entity>")
  .description("Explore entity connections in the knowledge graph")
  .option("-d, --depth <n>", "Traversal depth (1-3)", "1")
  .option("-t, --type <type>", "Filter by relationship type")
  .action(async (entity, opts) => {
    const { explore: exploreEntity } = await import("../shared/explore.js");
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      const depth = parseInt(opts.depth, 10);
      // graph SPEC POST-2: an unknown entity is a descriptive throw; the
      // top-level handler prints it as one line and exits 1 (#29, #37).
      const result = exploreEntity(db, {
        entity,
        depth: Math.min(Math.max(depth, 1), 3),
        relationshipTypes: opts.type ? [opts.type] : undefined,
      });
      console.log(`\n${result.centerEntity.name} (${result.centerEntity.type})`);
      if (result.centerEntity.description) {
        console.log(`  ${result.centerEntity.description}`);
      }
      console.log(`  Mentions: ${result.centerEntity.mentionCount}\n`);
      if (result.neighbors.length === 0) {
        console.log("  No connections found.");
        return;
      }
      console.log("  Connections:");
      for (const n of result.neighbors) {
        const dir = n.relationship.direction === "outgoing" ? "->" : "<-";
        console.log(
          `    ${dir} ${n.relationship.type} ${n.entity.name} (${n.entity.type}, weight: ${n.relationship.weight.toFixed(2)}, depth: ${n.depth})`,
        );
        if (n.relationship.context) {
          console.log(`      ${n.relationship.context}`);
        }
      }
      if (result.community) {
        console.log(
          `\n  Community: ${result.community.name} (${result.community.entityCount} entities)`,
        );
      }
    } finally {
      closeDatabase();
    }
  });

// ─── dream ──────────────────────────────────────────────────────

program
  .command("dream")
  .description("Run dream state processing pipeline")
  .option(
    "--phase <phase>",
    "Run only a specific phase: ingest|extract|consolidate|reflect|prune",
  )
  .option("--conversation <id>", "Process a specific conversation")
  .option("--dry-run", "Show what would be processed without making changes")
  .option("--force", "Re-extract conversations even when unchanged since their last extraction")
  .option("--verbose", "Show detailed progress")
  .action(async (opts) => {
    const { runDream, formatDreamSummary } = await import("../../dream/daemon.js");
    const { initEmbeddings } = await import("../../_core/embeddings/index.js");
    const config = loadConfig();
    const db = getDatabase(config);

    try {
      await initEmbeddings(config);

      const phases = opts.phase
        ? [opts.phase as import("../../dream/types.js").DreamPhase]
        : undefined;

      const report = await runDream(db, config, {
        phases,
        conversationId: opts.conversation,
        dryRun: opts.dryRun,
        force: opts.force,
        verbose: opts.verbose,
        onProgress: (phase, processed, total, errors) => {
          if (opts.verbose) {
            process.stdout.write(
              `\r  [${phase}] ${processed}/${total} (${errors} errors)`,
            );
          }
        },
      });

      if (opts.verbose) {
        process.stdout.write("\n");
      }

      console.log("");
      for (const line of formatDreamSummary(report)) console.log(line);
    } finally {
      closeDatabase();
    }
  });

// ─── commitments ─────────────────────────────────────────────────

program
  .command("commitments [status]")
  .description(
    "List tracked commitments (pending|done|dropped|superseded|all; default pending) — " +
      "same XML as the `commitments` MCP tool",
  )
  .option("--due-within <days>", "Only items due within N days (overdue included)")
  .option("-l, --limit <n>", "Max items", "20")
  .option("--budget <tokens>", "Token budget for the XML output", "1500")
  .option("--json", "Output JSON instead of XML")
  .action(async (status: string | undefined, opts) => {
    const { listCommitments, formatCommitmentsXml, COMMITMENT_STATUSES } = await import(
      "../../semantic/commitments.js"
    );
    const wanted = status ?? "pending";
    if (wanted !== "all" && !(COMMITMENT_STATUSES as readonly string[]).includes(wanted)) {
      console.error(`Invalid status: ${wanted}. Must be one of: ${COMMITMENT_STATUSES.join(", ")}, all`);
      process.exit(1);
    }
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      const result = listCommitments(db, {
        status: wanted as import("../../semantic/commitments.js").CommitmentQueryStatus,
        dueWithinDays: opts.dueWithin !== undefined ? parseFloat(opts.dueWithin) : undefined,
        limit: parseInt(opts.limit, 10),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatCommitmentsXml(result, { budget: parseInt(opts.budget, 10) }));
      }
    } finally {
      closeDatabase();
    }
  });

program
  .command("commitment-done <id>")
  .description("Resolve a commitment: mark it done (default), dropped, or superseded")
  .option("--status <status>", "done|dropped|superseded", "done")
  .option("--superseded-by <id>", "Replacement commitment id (with --status superseded)")
  .action(async (id: string, opts) => {
    const { updateCommitmentStatus } = await import("../../semantic/commitments.js");
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      const updated = updateCommitmentStatus(
        db,
        id,
        opts.status as import("../../semantic/commitments.js").CommitmentStatus,
        { supersededBy: opts.supersededBy },
      );
      const suffix = updated.supersededBy ? ` (superseded by ${updated.supersededBy})` : "";
      console.log(`Commitment ${updated.id} marked ${updated.status}${suffix}: ${updated.content}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

program
  .command("commitments-extract <conversation-id>")
  .description(
    "Re-scan one conversation for commitments with the configured LLM (no dream checkpoint; " +
      "dedupes against the ledger — useful to prove a re-run adds nothing)",
  )
  .option("--json", "Output extraction stats as JSON")
  .action(async (conversationId: string, opts) => {
    const { extractCommitmentsForConversation } = await import("../../dream/commitments-pass.js");
    const { hasCommitmentsProvider } = await import("../../semantic/commitments.js");
    const { initEmbeddings } = await import("../../_core/embeddings/index.js");
    if (!hasCommitmentsProvider()) {
      console.error("No extraction provider configured (set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or ENGRAM_LOCAL_MODEL)");
      process.exit(1);
    }
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      await initEmbeddings(config);
      const result = await extractCommitmentsForConversation(db, conversationId, {
        log: (message) => { if (!opts.json) console.error(message); },
      });
      if (opts.json) {
        console.log(JSON.stringify({ conversationId, ...result }, null, 2));
      } else {
        console.log(
          `${conversationId}: ${result.candidates} candidates, ${result.rejected} rejected (no cue), ${result.inserted} inserted, ` +
            `${result.duplicates} duplicates${result.skipped ? " (skipped: trivial conversation)" : ""}` +
            `${result.model ? ` [${result.model}]` : ""}`,
        );
        for (const c of result.items) console.log(`  + ${c.id}  ${c.content}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

// ─── mcp ──────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Start the MCP server (stdio; bridges to the HTTP daemon when one is healthy, --standalone forces inline)")
  .option("--standalone", "never bridge: run the full server in this process even if the daemon is up (also ENGRAM_MCP_STANDALONE=1)")
  .option("--http", "serve Streamable HTTP with the worker pool instead of stdio")
  .option("--port <port>", "daemon port: the HTTP listen port with --http, else the port to bridge to (default ENGRAM_MCP_PORT or 9907)")
  .action(async (opts: { standalone?: boolean; http?: boolean; port?: string }) => {
    const args: string[] = [];
    if (opts.http) args.push("--http");
    if (opts.port) args.push("--port", opts.port);
    if (opts.standalone) args.push("--standalone");
    if (opts.http) {
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer(args);
      return;
    }
    // The stdio entry decides bridge vs inline BEFORE server.ts is imported, so a
    // bridged `engram mcp` (the plugin's `npx` command, #58/#60) never loads
    // better-sqlite3 or the embedding model.
    const { runStdioEntry } = await import("../mcp/bridge.js");
    await runStdioEntry({
      args,
      env: process.env,
      inline: async () => {
        const { connectStdioInline } = await import("../mcp/server.js");
        await connectStdioInline();
      },
    });
  });

// ─── health ───────────────────────────────────────────────────────

program
  .command("health")
  .description("Check system health")
  .action(async () => {
    const { existsSync, statSync } = await import("node:fs");
    const config = loadConfig();

    let allOk = true;

    // 1. Check DB exists and is readable
    const dbExists = existsSync(config.dbPath);
    if (dbExists) {
      try {
        const db = getDatabase(config);
        const exchangeCount = (
          db.prepare("SELECT COUNT(*) as count FROM exchanges").get() as {
            count: number;
          }
        ).count;
        const memoryCount = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM memories WHERE is_active = 1",
            )
            .get() as { count: number }
        ).count;
        const entityCount = (
          db.prepare("SELECT COUNT(*) as count FROM entities").get() as {
            count: number;
          }
        ).count;
        const dbSize = statSync(config.dbPath).size;
        closeDatabase();

        console.log(`[ok] Database: ${config.dbPath} (${(dbSize / 1024 / 1024).toFixed(1)} MB)`);
        console.log(`     Exchanges: ${exchangeCount}, Memories: ${memoryCount}, Entities: ${entityCount}`);
      } catch (err) {
        console.log(`[FAIL] Database: ${config.dbPath} — ${err instanceof Error ? err.message : err}`);
        allOk = false;
      }
    } else {
      console.log(`[FAIL] Database: ${config.dbPath} — not found (run 'engram init')`);
      allOk = false;
    }

    // 2. Check embedding model
    try {
      const { initEmbeddings, getActiveModel } = await import(
        "../../_core/embeddings/index.js"
      );
      await initEmbeddings(config);
      console.log(`[ok] Embedding model: ${getActiveModel()}`);
    } catch (err) {
      console.log(`[FAIL] Embedding model: ${err instanceof Error ? err.message : err}`);
      allOk = false;
    }

    // 3. Check Ollama availability (optional)
    try {
      const resp = await fetch("http://localhost:11434/api/tags");
      if (resp.ok) {
        const data = (await resp.json()) as { models?: Array<{ name: string }> };
        const modelCount = data.models?.length ?? 0;
        console.log(`[ok] Ollama: running (${modelCount} models available)`);
      } else {
        console.log(`[--] Ollama: not responding (optional)`);
      }
    } catch {
      console.log(`[--] Ollama: not running (optional)`);
    }

    // 4. Check MCP server entry point — sibling when running from dist/,
    //    otherwise the built dist/ tree relative to the repo root (tsx runs)
    const here = import.meta.dirname ?? ".";
    const mcpCandidates = [
      join(here, "../mcp/server.js"),
      join(here, "../../../dist/interfaces/mcp/server.js"),
    ];
    const mcpEntry = mcpCandidates.find((p) => existsSync(p));
    if (mcpEntry) {
      console.log(`[ok] MCP server: ${mcpEntry}`);
    } else {
      console.log(`[--] MCP server: not built (run 'npm run build')`);
    }

    // 5. Report MCP tool count
    const { MCP_TOOL_NAMES } = await import("../mcp/tool-names.js");
    console.log(`[ok] MCP tools: ${MCP_TOOL_NAMES.length} (${MCP_TOOL_NAMES.join(", ")})`);

    if (allOk) {
      console.log("\nHealth: all checks passed");
    } else {
      console.log("\nHealth: some checks failed");
      process.exit(1);
    }
  });

// ─── export ─────────────────────────────────────────────────────

program
  .command("export")
  .description(
    "Export memories, entities, relationships, and commitments as JSONL (embeddings are regenerated on import)",
  )
  .option("-o, --out <file>", "Write to a file instead of stdout")
  .option("-s, --scope <scope...>", "Only memories in these scopes (default: all scopes)")
  .option("--include-inactive", "Include superseded/inactive memories (default: active only)")
  .option(
    "--kinds <list>",
    "Comma-separated record kinds: memories,entities,relationships,commitments",
    "memories,entities,relationships,commitments",
  )
  .action(async (opts) => {
    const { writeFileSync } = await import("node:fs");
    const { exportLines, ALL_KINDS } = await import("./transfer.js");

    const kinds = String(opts.kinds)
      .split(",")
      .map((k: string) => k.trim())
      .filter(Boolean);
    const unknown = kinds.filter((k) => !(ALL_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      console.error(`Unknown kind(s): ${unknown.join(", ")}. Valid: ${ALL_KINDS.join(", ")}`);
      process.exit(1);
    }

    const config = loadConfig();
    const db = getDatabase(config);
    try {
      const lines = exportLines(db, {
        scopes: opts.scope,
        includeInactive: Boolean(opts.includeInactive),
        kinds: kinds as (typeof ALL_KINDS)[number][],
      });
      const body = lines.join("\n") + "\n";
      if (opts.out) {
        writeFileSync(opts.out, body, "utf-8");
        console.error(`Exported ${lines.length - 1} records to ${opts.out}`);
      } else {
        process.stdout.write(body);
      }
    } finally {
      closeDatabase();
    }
  });

// ─── import ─────────────────────────────────────────────────────

program
  .command("import <file>")
  .description(
    "Import a JSONL export (idempotent by id; vectors and FTS are regenerated from content)",
  )
  .option("-s, --scope <scope>", "Override the scope on every imported memory")
  .option("-n, --dry-run", "Validate and report what would change without writing")
  .action(async (file, opts) => {
    const { readFileSync } = await import("node:fs");
    const { importLines, formatImportSummary, ImportFormatError } = await import("./transfer.js");
    const { initEmbeddings } = await import("../../_core/embeddings/index.js");

    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      if (!opts.dryRun) await initEmbeddings(config);
      const summary = await importLines(db, lines, {
        scope: opts.scope,
        dryRun: Boolean(opts.dryRun),
        onProgress: (done, total) => {
          if (!opts.dryRun) console.error(`  ${done}/${total} records`);
        },
      });
      for (const line of formatImportSummary(summary)) console.log(line);
    } catch (err) {
      if (err instanceof ImportFormatError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    } finally {
      closeDatabase();
    }
  });

// ─── doctor ─────────────────────────────────────────────────────

program
  .command("doctor")
  .description(
    "Diagnose the runtime: node version, platform/arch, native modules, model cache, data dir, MCP daemon",
  )
  .option("--json", "Print the report as JSON instead of text")
  .action(async (opts) => {
    const { runDoctor, formatDoctorReport } = await import("./doctor.js");
    const report = await runDoctor(loadConfig());

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatDoctorReport(report)) console.log(line);
    }

    if (!report.ok) process.exit(1);
  });

// ─── preflight ──────────────────────────────────────────────────

program
  .command("preflight")
  .description(
    "Native-dependency check for this node/platform/arch/libc: prebuilt, compiled locally, will compile, or unsupported, with the fix per OS. Needs no database or models",
  )
  .option("--strict", "Exit 1 when any line is [FAIL] (CI)")
  .option("--json", "Print the structured result as JSON instead of text")
  .option(
    "--expect <spec>",
    "Exit 1 unless every verdict matches: a status for all deps (prebuilt) or dep=status pairs (better-sqlite3=prebuilt,sqlite-vec=unsupported)",
  )
  .action((opts) => {
    // Runs the same dependency-free script as the npm postinstall hook
    // (scripts/preflight.cjs); ENGRAM_SKIP_PREFLIGHT only silences that hook.
    const { preflight, toJson, checkExpectations } = loadPreflight();
    const result = preflight();
    if (opts.json) {
      console.log(JSON.stringify(toJson(result), null, 2));
    } else {
      console.log(result.lines.join("\n"));
    }
    let failed = Boolean(opts.strict) && result.failed > 0;
    if (opts.expect) {
      const problems = checkExpectations(result, opts.expect);
      for (const p of problems) console.error(p);
      if (problems.length > 0) failed = true;
    }
    if (failed) process.exit(1);
  });

// ─── reflect ─────────────────────────────────────────────────────

program
  .command("reflect")
  .description("Show knowledge graph reflection and emergent patterns")
  .option("-m, --mode <mode>", "Focus: communities, bridges, temporal, health, all", "all")
  .option("--refresh", "Force fresh analysis (slower)")
  .action(async (opts) => {
    const config = loadConfig();
    const db = getDatabase(config);
    try {
      const { reflect } = await import("../shared/reflect.js");
      if (opts.refresh) console.log("Running fresh reflection analysis...\n");
      const result = await reflect(db, { mode: opts.mode, refresh: Boolean(opts.refresh) }, config);
      if (!result) {
        console.log("No reflection data. Run 'engram dream --phase reflect' first.");
        return;
      }
      printReflectResult(result, opts.mode);
    } finally {
      closeDatabase();
    }
  });

// #37: an async action that throws must surface as one line + exit 1, not
// an unhandled-rejection stack trace. Per-command catches that need their
// own wording keep it; everything else lands here.
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// ─── Reflect Formatting ──────────────────────────────────────────

function printReflectResult(
  result: import("../../graph/types.js").ReflectResult,
  mode: string,
): void {
  const timestamp = new Date(result.generatedAt * 1000).toLocaleString();
  console.log(`Reflection (generation ${result.generation}, ${timestamp})\n`);

  // Communities
  if (mode === "all" || mode === "communities") {
    console.log(`Communities (${result.communities.length}):`);
    if (result.communities.length === 0) {
      console.log("  (none detected)\n");
    } else {
      for (const community of result.communities) {
        console.log(
          `  ${community.name} (${community.entityCount} entities, coherence: ${community.coherenceScore.toFixed(2)}, memories: ${community.memoryCount})`,
        );
        console.log(`    ${community.description}`);
        if (community.topEntities.length > 0) {
          const entities = community.topEntities
            .map((e) => `${e.name} [${e.type}]`)
            .join(", ");
          console.log(`    Top entities: ${entities}`);
        }
      }
      console.log("");
    }
  }

  // Bridges
  if (mode === "all" || mode === "bridges") {
    console.log(`Bridge Entities (${result.bridges.length}):`);
    if (result.bridges.length === 0) {
      console.log("  (none detected)\n");
    } else {
      for (const bridge of result.bridges) {
        console.log(
          `  ${bridge.entityName} [${bridge.entityType}] (score: ${bridge.bridgeScore.toFixed(2)}, spans ${bridge.communitySpan} communities)`,
        );
        if (bridge.narrative) {
          console.log(`    ${bridge.narrative}`);
        }
        if (bridge.connectedCommunities.length > 0) {
          console.log(`    Connects: ${bridge.connectedCommunities.join(", ")}`);
        }
      }
      console.log("");
    }
  }

  // Temporal patterns
  if (mode === "all" || mode === "temporal") {
    console.log(`Temporal Patterns (${result.temporalPatterns.length}):`);
    if (result.temporalPatterns.length === 0) {
      console.log("  (none detected)\n");
    } else {
      for (const pattern of result.temporalPatterns) {
        console.log(
          `  [${pattern.type}] (confidence: ${pattern.confidence.toFixed(1)})`,
        );
        console.log(`    ${pattern.description}`);
      }
      console.log("");
    }
  }

  // Health
  if (mode === "all" || mode === "health") {
    console.log("Graph Health:");
    console.log(`  Nodes:            ${result.health.totalNodes}`);
    console.log(`  Edges:            ${result.health.totalEdges}`);
    console.log(`  Modularity:       ${result.health.modularity.toFixed(2)}`);
    console.log(`  Communities:      ${result.health.communityCount}`);
    console.log(`  Orphan nodes:     ${result.health.orphanNodes}`);
    console.log(`  Stale nodes:      ${result.health.staleNodes} (flagged by forget; pruned on the next dream run)`);
    console.log(`  Avg coherence:    ${result.health.averageCoherence.toFixed(2)}`);
    console.log(`  Generations:      ${result.health.generationCount}`);
    if (result.staleEntities.length > 0) {
      console.log("  Stale entities:");
      for (const e of result.staleEntities) {
        console.log(`    ${e.name} (${e.type}) since ${e.staleSince}`);
      }
    }
    console.log("");
  }

  // Observations
  if (result.observations.length > 0) {
    console.log(`Observations (${result.observations.length}):`);
    for (const obs of result.observations) {
      console.log(`  [${obs.type}] (confidence: ${obs.confidence.toFixed(1)})`);
      console.log(`    ${obs.content}`);
    }
    console.log("");
  }
}
