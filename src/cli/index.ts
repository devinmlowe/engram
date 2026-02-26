#!/usr/bin/env node
import { Command } from "commander";
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
      console.log(`  Exchanges:     ${exchangeCount}`);
      console.log(`  Conversations: ${convCount}`);
      console.log(`  Tool Calls:    ${toolCount}`);
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

program.parse();
