import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import type Database from "better-sqlite3";
import type { EngramConfig } from "../_core/types/index.js";
import type { Conversation } from "./types.js";
import { parseConversationFile, shouldSkipConversation } from "./parser.js";
import { initEmbeddings, embedExchange } from "../_core/embeddings/index.js";
import { insertExchange, upsertConversation, getConversation } from "./store.js";

// ─── Types ─────────────────────────────────────────────────────

export interface SyncResult {
  discovered: number;
  copied: number;
  skipped: number;
  indexed: number;
  conversations: number;
  errors: Array<{ file: string; error: string }>;
}

interface DiscoveredFile {
  project: string;
  file: string;
  path: string;
}

// ─── Discovery ─────────────────────────────────────────────────

/**
 * Extract the human-readable project name from an encoded dir name.
 * e.g. "-Users-devinmlowe-Documents-git-engram" → "engram"
 */
export function extractProjectName(dirName: string): string {
  // Split on path-separator encoding, take last non-empty segment
  const segments = dirName.split("-").filter((s) => s.length > 0);
  return segments[segments.length - 1] || dirName;
}

/**
 * Discover all .jsonl conversation files in the Claude projects directory.
 */
export function discoverConversations(
  projectsDir: string,
): DiscoveredFile[] {
  if (!existsSync(projectsDir)) return [];

  const files: DiscoveredFile[] = [];
  const projects = readdirSync(projectsDir);

  for (const projectDir of projects) {
    const projectPath = join(projectsDir, projectDir);
    if (!statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = readdirSync(projectPath).filter((f) =>
      f.endsWith(".jsonl"),
    );

    for (const file of jsonlFiles) {
      files.push({
        project: extractProjectName(projectDir),
        file,
        path: join(projectPath, file),
      });
    }
  }

  return files;
}

// ─── File Copy ─────────────────────────────────────────────────

/**
 * Copy file to archive if newer. Atomic via temp + rename.
 * Returns true if file was copied.
 */
function copyIfNewer(src: string, dest: string): boolean {
  mkdirSync(dirname(dest), { recursive: true });

  if (existsSync(dest)) {
    const srcStat = statSync(src);
    const destStat = statSync(dest);
    if (destStat.mtimeMs >= srcStat.mtimeMs) return false;
  }

  const tempDest = `${dest}.tmp.${process.pid}`;
  copyFileSync(src, tempDest);
  renameSync(tempDest, dest);
  return true;
}

// ─── Sync ──────────────────────────────────────────────────────

/**
 * Sync and index conversations from Claude projects to Engram.
 *
 * Flow: discover → copy to archive → check indexed state → parse → embed → store
 */
export async function syncConversations(
  db: Database.Database,
  config: EngramConfig,
  options: {
    project?: string;
    force?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    discovered: 0,
    copied: 0,
    skipped: 0,
    indexed: 0,
    conversations: 0,
    errors: [],
  };

  // 1. Discover conversations
  const discovered = discoverConversations(config.claudeProjectsDir);
  result.discovered = discovered.length;

  // Filter by project if specified
  const toProcess = options.project
    ? discovered.filter((d) => d.project === options.project)
    : discovered;

  if (options.dryRun) {
    result.discovered = toProcess.length;
    return result;
  }

  // 2. Init embeddings (lazy — loaded once)
  await initEmbeddings(config);

  // 3. Process each conversation
  for (const { project, file, path: srcPath } of toProcess) {
    const conversationId = basename(file, ".jsonl");
    const archiveDest = join(config.archiveDir, project, file);

    try {
      // Copy to archive
      const wasCopied = copyIfNewer(srcPath, archiveDest);
      if (wasCopied) {
        result.copied++;
      }

      // Check if already indexed (unless force)
      if (!options.force) {
        const existing = getConversation(db, conversationId);
        if (existing?.lastIndexed) {
          // Already indexed and file wasn't updated
          if (!wasCopied) {
            result.skipped++;
            continue;
          }
        }
      }

      // Check exclusion markers
      if (shouldSkipConversation(archiveDest)) {
        result.skipped++;
        continue;
      }

      // Parse
      const parsed = await parseConversationFile(
        archiveDest,
        project,
        archiveDest,
      );

      if (parsed.exchanges.length === 0) {
        result.skipped++;
        continue;
      }

      // Embed and store each exchange
      for (const exchange of parsed.exchanges) {
        const toolNames = parsed.toolCalls
          .filter((tc) => tc.exchangeId === exchange.id)
          .map((tc) => tc.toolName);

        const embedding = await embedExchange(
          exchange.userMessage,
          exchange.assistantMessage,
          {
            project,
            date: exchange.timestamp.split("T")[0],
            branch: exchange.gitBranch,
            tools: toolNames,
          },
        );

        const exchangeToolCalls = parsed.toolCalls.filter(
          (tc) => tc.exchangeId === exchange.id,
        );

        insertExchange(db, exchange, embedding, exchangeToolCalls);
      }

      // Upsert conversation record
      const conv: Conversation = {
        id: conversationId,
        project,
        startedAt: parsed.metadata.startedAt,
        endedAt: parsed.metadata.endedAt,
        exchangeCount: parsed.exchanges.length,
        archivePath: archiveDest,
        lastIndexed: Math.floor(Date.now() / 1000),
      };
      upsertConversation(db, conv);

      result.indexed++;
      result.conversations++;
    } catch (error) {
      result.errors.push({
        file: srcPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
