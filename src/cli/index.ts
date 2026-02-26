#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { initDatabase } from "../core/db.js";

const program = new Command();

program
  .name("engram")
  .description("Cognitive memory system for Claude Code")
  .version("0.1.0");

// ─── sync ──────────────────────────────────────────────────────

program
  .command("sync")
  .description("Sync and index conversations from Claude projects")
  .option("-p, --project <name>", "Only sync a specific project")
  .option("-f, --force", "Force re-index all conversations")
  .option("-n, --dry-run", "Show what would be synced without indexing")
  .action(async (opts) => {
    const { syncConversations } = await import("../episodic/sync.js");
    const config = loadConfig();
    const db = initDatabase(config);

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
      db.close();
    }
  });

// ─── search ────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search indexed conversations")
  .option("-l, --limit <n>", "Max results", "10")
  .option("-m, --mode <mode>", "Search mode: hybrid, vector, text", "hybrid")
  .option("--after <date>", "Only results after date (YYYY-MM-DD)")
  .option("--before <date>", "Only results before date (YYYY-MM-DD)")
  .option("--budget <tokens>", "Token budget for results", "1500")
  .action(async (query, opts) => {
    const { searchEpisodic, formatRecallXml } = await import(
      "../episodic/search.js"
    );
    const { initEmbeddings } = await import("../episodic/embeddings.js");
    const config = loadConfig();
    const db = initDatabase(config);

    try {
      await initEmbeddings(config);

      const response = await searchEpisodic(db, {
        query,
        mode: opts.mode as "hybrid" | "vector" | "text",
        limit: parseInt(opts.limit, 10),
        budget: parseInt(opts.budget, 10),
        after: opts.after,
        before: opts.before,
      });

      if (response.results.length === 0) {
        console.log("No results found.");
        return;
      }

      console.log(formatRecallXml(response));
    } finally {
      db.close();
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
    const { initEmbeddings, embedDocument } = await import(
      "../episodic/embeddings.js"
    );
    const {
      insertMemory,
      findNearestMemories,
      recordAccess,
    } = await import("../semantic/memory.js");

    const config = loadConfig();
    const db = initDatabase(config);

    try {
      await initEmbeddings(config);

      const importance = parseFloat(opts.importance);
      const type = opts.type;

      // Validate type
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

      // 1. Embed the content
      const embedding = await embedDocument(content);

      // 2. Check for near-duplicates
      const neighbors = findNearestMemories(db, embedding, 3);
      for (const neighbor of neighbors) {
        const similarity =
          1 - (neighbor.distance * neighbor.distance) / 2;
        if (similarity >= 0.95) {
          recordAccess(db, neighbor.id);
          console.log(`Updated existing memory: ${neighbor.id}`);
          return;
        }
      }

      // 3. Insert new memory
      const newId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      insertMemory(
        db,
        {
          id: newId,
          type: type as import("../core/types.js").MemoryType,
          content,
          confidence: 0.9,
          importance,
          accessCount: 0,
          createdAt: now,
          sourceExchanges: [],
          isActive: true,
        },
        embedding,
      );

      console.log(`Remembered: ${content}`);
    } finally {
      db.close();
    }
  });

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
    const { initEmbeddings } = await import("../episodic/embeddings.js");
    const { initExtractor, extractFromConversation } = await import(
      "../semantic/extractor.js"
    );
    const { consolidateFacts, initConsolidator } = await import(
      "../semantic/consolidator.js"
    );

    const config = loadConfig();
    const db = initDatabase(config);

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
      initConsolidator();

      const consolidationResults = await consolidateFacts(
        db,
        result.facts,
        conversationId,
      );

      // Report
      const actions = {
        insert: 0,
        merge: 0,
        conflict: 0,
        skip: 0,
      };
      for (const cr of consolidationResults) {
        actions[cr.action]++;
      }

      console.log("\nConsolidation complete:");
      console.log(`  Inserted: ${actions.insert}`);
      console.log(`  Merged:   ${actions.merge}`);
      console.log(`  Conflicts: ${actions.conflict}`);
      console.log(`  Skipped:  ${actions.skip}`);
    } finally {
      db.close();
    }
  });

// ─── stats ─────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show database statistics")
  .action(async () => {
    const { statSync } = await import("node:fs");
    const config = loadConfig();
    const db = initDatabase(config);

    try {
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
      console.log("");
      console.log(
        `  Last Sync:     ${lastSync.ts ? new Date(lastSync.ts * 1000).toISOString() : "never"}`,
      );
    } finally {
      db.close();
    }
  });

// ─── init ──────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize database and pre-download embedding model")
  .action(async () => {
    const { initEmbeddings, getActiveModel } = await import(
      "../episodic/embeddings.js"
    );
    const config = loadConfig();

    console.log("Initializing database...");
    const db = initDatabase(config);
    db.close();
    console.log(`  Database: ${config.dbPath}`);

    console.log("Downloading embedding model...");
    await initEmbeddings(config);
    console.log(`  Model: ${getActiveModel()}`);

    console.log("Done. Engram is ready.");
  });

// ─── migrate ────────────────────────────────────────────────────

program
  .command("migrate")
  .description("Migrate data from superpowers conversation-index DB")
  .option(
    "-s, --source <path>",
    "Source database path",
    join(homedir(), ".config/superpowers/conversation-index/db.sqlite"),
  )
  .option(
    "-n, --dry-run",
    "Show what would be migrated without making changes",
  )
  .option("--batch-size <n>", "Embedding batch size", "32")
  .option("--force", "Force re-migration (ignore checkpoints)")
  .action(async (opts) => {
    const { runMigration, formatProgress } = await import(
      "../migration/migrate.js"
    );

    try {
      console.log(`Migrating from: ${opts.source}`);
      const report = await runMigration({
        sourcePath: opts.source,
        dryRun: opts.dryRun,
        batchSize: parseInt(opts.batchSize, 10),
        force: opts.force,
        onProgress: (p) => {
          process.stdout.write(`\r${formatProgress(p)}`);
        },
      });

      if (!opts.dryRun) {
        console.log("\n\nMigration complete:");
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
            console.error(
              `    ... and ${report.errors.length - 10} more`,
            );
          }
        }

        const durationSec = report.completedAt
          ? Math.round((report.completedAt - report.startedAt) / 1000)
          : 0;
        console.log(`  Duration:      ${durationSec}s`);
      }
    } catch (err) {
      console.error(
        "Migration failed:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  });

// ─── validate ───────────────────────────────────────────────────

program
  .command("validate")
  .description("Validate migration integrity")
  .option(
    "-s, --source <path>",
    "Source database path",
    join(homedir(), ".config/superpowers/conversation-index/db.sqlite"),
  )
  .action(async (opts) => {
    const { runValidation } = await import("../migration/validate.js");

    try {
      console.log("Running validation checks...\n");
      const results = await runValidation({
        sourcePath: opts.source,
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

program.parse();
