#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../_core/config/index.js";
import { getDatabase, closeDatabase } from "../../_core/db/index.js";

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
  .option("--after <date>", "Only results after date (YYYY-MM-DD)")
  .option("--before <date>", "Only results before date (YYYY-MM-DD)")
  .option("--budget <tokens>", "Token budget for results", "1500")
  .action(async (query, opts) => {
    const { unifiedSearch, formatRecallXml } = await import(
      "../shared/search.js"
    );
    const { initEmbeddings } = await import("../../_core/embeddings/index.js");
    const config = loadConfig();
    const db = getDatabase(config);

    try {
      await initEmbeddings(config);

      const response = await unifiedSearch(db, {
        query,
        mode: opts.mode as "hybrid" | "vector" | "text",
        limit: parseInt(opts.limit, 10),
        budget: parseInt(opts.budget, 10),
        after: opts.after,
        before: opts.before,
      }, config);

      if (response.results.length === 0) {
        console.log("No results found.");
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
      closeDatabase();
    }
  });

// ─── stats ─────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show database statistics")
  .action(async () => {
    const { statSync } = await import("node:fs");
    const config = loadConfig();
    const db = getDatabase(config);

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
      "../../migration/migrate.js"
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
    const { runValidation } = await import("../../migration/validate.js");

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
  .option("--verbose", "Show detailed progress")
  .action(async (opts) => {
    const { runDream } = await import("../../dream/daemon.js");
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

      console.log("\nDream complete:");
      for (const phase of report.phases) {
        console.log(
          `  ${phase.phase}: ${phase.itemsProcessed} items, ${phase.errors} errors (${phase.durationMs}ms)`,
        );
      }
      console.log("");
      console.log(`  New memories:      ${report.newMemories}`);
      console.log(`  Updated memories:  ${report.updatedMemories}`);
      console.log(`  New entities:      ${report.newEntities}`);
      console.log(`  New relationships: ${report.newRelationships}`);
      console.log(`  Conflicts:         ${report.conflictsDetected}`);
      console.log(`  Pruned:            ${report.memoriesPruned}`);

      const durationSec = report.completedAt - report.startedAt;
      console.log(`  Duration:          ${durationSec}s`);
    } finally {
      closeDatabase();
    }
  });

// ─── mcp ──────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Start MCP server (stdio transport)")
  .action(async () => {
    await import("../mcp/server.js");
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

    // 4. Check MCP server entry point
    const mcpEntry = join(
      import.meta.dirname ?? ".",
      "../mcp/server.js",  // relative from interfaces/cli/ to interfaces/mcp/
    );
    if (existsSync(mcpEntry)) {
      console.log(`[ok] MCP server: ${mcpEntry}`);
    } else {
      console.log(`[--] MCP server: not built (run 'npm run build')`);
    }

    // 5. Report MCP tool count
    console.log(`[ok] MCP tools: 5 (recall, remember, show, explore, reflect)`);

    if (allOk) {
      console.log("\nHealth: all checks passed");
    } else {
      console.log("\nHealth: some checks failed");
      process.exit(1);
    }
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
      if (opts.refresh) {
        const { runReflection } = await import("../../graph/reflection.js");
        console.log("Running fresh reflection analysis...\n");
        const result = await runReflection(db, config);
        printReflectResult(result, opts.mode);
      } else {
        const { buildReflectResultFromCache } = await import("../../graph/reflection.js");
        const result = buildReflectResultFromCache(db);
        if (!result) {
          console.log("No reflection data. Run 'engram dream --phase reflect' first.");
          return;
        }
        printReflectResult(result, opts.mode);
      }
    } finally {
      closeDatabase();
    }
  });

program.parse();

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
    console.log(`  Avg coherence:    ${result.health.averageCoherence.toFixed(2)}`);
    console.log(`  Generations:      ${result.health.generationCount}`);
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
