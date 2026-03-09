/**
 * Contract: Configuration Defaults
 *
 * loadConfig() returns defaults that every module depends on. If a default
 * changes during extraction to _core/config/, modules silently get wrong
 * values. These tests pin every default value.
 *
 * Additionally tests env var override precedence — the merge order matters
 * and must survive the move.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

describe("Config Defaults Contract", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all ENGRAM_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ENGRAM_")) {
        envBackup[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ENGRAM_")) delete process.env[key];
    }
    for (const [key, val] of Object.entries(envBackup)) {
      if (val !== undefined) process.env[key] = val;
    }
  });

  // ── Path Defaults ──────────────────────────────────────────────

  it("pins all default paths", () => {
    const c = loadConfig();
    expect(c.dataDir).toBe(join(HOME, ".local", "share", "engram"));
    expect(c.dbPath).toBe(join(HOME, ".local", "share", "engram", "engram.db"));
    expect(c.archiveDir).toBe(join(HOME, ".local", "share", "engram", "archive"));
    expect(c.logsDir).toBe(join(HOME, ".local", "share", "engram", "logs"));
    expect(c.claudeProjectsDir).toBe(join(HOME, ".claude", "projects"));
  });

  // ── Embedding Defaults ─────────────────────────────────────────

  it("pins embedding defaults", () => {
    const c = loadConfig();
    expect(c.embedding.model).toBe("nomic-ai/nomic-embed-text-v1.5");
    expect(c.embedding.dimensions).toBe(256);
    expect(c.embedding.maxTokens).toBe(8192);
  });

  // ── Search Defaults ────────────────────────────────────────────

  it("pins search defaults", () => {
    const c = loadConfig();
    expect(c.search.defaultLimit).toBe(10);
    expect(c.search.defaultBudget).toBe(1500);
    expect(c.search.rrfK).toBe(60);
    expect(c.search.rerankEnabled).toBe(true);
  });

  it("pins reranker defaults", () => {
    const c = loadConfig();
    expect(c.search.reranker.enabled).toBe(true);
    expect(c.search.reranker.model).toBe("Xenova/bge-reranker-base");
    expect(c.search.reranker.topK).toBe(5);
    expect(c.search.reranker.blendWeight).toBe(0.7);
  });

  // ── Dream Defaults ─────────────────────────────────────────────

  it("pins dream defaults", () => {
    const c = loadConfig();
    expect(c.dream.apiModel).toBe("claude-haiku-4-5-20251001");
    expect(c.dream.apiFallbackModel).toBe("claude-sonnet-4-6");
    expect(c.dream.concurrency).toBe(1);
    expect(c.dream.scheduleHour).toBe(2);
    expect(c.dream.localModel).toBeUndefined();
    expect(c.dream.openrouterModel).toBeUndefined();
  });

  // ── Decay Defaults ─────────────────────────────────────────────

  it("pins all decay rates", () => {
    const c = loadConfig();
    expect(c.decay).toEqual({
      preference: 0.01,
      decision: 0.02,
      fact: 0.05,
      pattern: 0.005,
      solution: 0.03,
      convention: 0.015,
    });
  });

  // ── Environment Variable Overrides ─────────────────────────────

  it("ENGRAM_DB_PATH overrides dbPath", () => {
    process.env.ENGRAM_DB_PATH = "/tmp/custom.db";
    const c = loadConfig();
    expect(c.dbPath).toBe("/tmp/custom.db");
  });

  it("ENGRAM_DATA_DIR cascades to derived paths", () => {
    process.env.ENGRAM_DATA_DIR = "/tmp/engram-custom";
    const c = loadConfig();
    expect(c.dataDir).toBe("/tmp/engram-custom");
    expect(c.dbPath).toBe("/tmp/engram-custom/engram.db");
    expect(c.archiveDir).toBe("/tmp/engram-custom/archive");
    expect(c.logsDir).toBe("/tmp/engram-custom/logs");
  });

  it("explicit env vars override cascaded paths", () => {
    process.env.ENGRAM_DATA_DIR = "/tmp/engram-custom";
    process.env.ENGRAM_DB_PATH = "/other/path.db";
    const c = loadConfig();
    expect(c.dataDir).toBe("/tmp/engram-custom");
    expect(c.dbPath).toBe("/other/path.db"); // explicit wins over cascade
  });

  it("ENGRAM_EMBEDDING_DIMS overrides dimensions", () => {
    process.env.ENGRAM_EMBEDDING_DIMS = "768";
    const c = loadConfig();
    expect(c.embedding.dimensions).toBe(768);
  });

  it("ENGRAM_RERANK_ENABLED=false disables reranking", () => {
    process.env.ENGRAM_RERANK_ENABLED = "false";
    const c = loadConfig();
    expect(c.search.rerankEnabled).toBe(false);
    expect(c.search.reranker.enabled).toBe(false);
  });

  it("ENGRAM_RERANK_ENABLED=0 disables reranking", () => {
    process.env.ENGRAM_RERANK_ENABLED = "0";
    const c = loadConfig();
    expect(c.search.rerankEnabled).toBe(false);
  });

  // ── Override Precedence ────────────────────────────────────────

  it("env vars take precedence over programmatic overrides", () => {
    process.env.ENGRAM_DB_PATH = "/env/wins.db";
    const c = loadConfig({ dbPath: "/override/loses.db" });
    expect(c.dbPath).toBe("/env/wins.db");
  });

  it("programmatic overrides take precedence over defaults", () => {
    const c = loadConfig({ dataDir: "/custom/dir" });
    expect(c.dataDir).toBe("/custom/dir");
  });

  // ── Completeness ───────────────────────────────────────────────

  it("loadConfig with no args returns a complete config (no undefined required fields)", () => {
    const c = loadConfig();

    // Every required path is a non-empty string
    expect(c.dataDir).toBeTruthy();
    expect(c.dbPath).toBeTruthy();
    expect(c.archiveDir).toBeTruthy();
    expect(c.logsDir).toBeTruthy();
    expect(c.claudeProjectsDir).toBeTruthy();

    // Every numeric field is a number (not NaN)
    expect(Number.isFinite(c.embedding.dimensions)).toBe(true);
    expect(Number.isFinite(c.search.defaultLimit)).toBe(true);
    expect(Number.isFinite(c.search.defaultBudget)).toBe(true);
    expect(Number.isFinite(c.search.rrfK)).toBe(true);
    expect(Number.isFinite(c.dream.concurrency)).toBe(true);
    expect(Number.isFinite(c.dream.scheduleHour)).toBe(true);

    // All decay rates are positive numbers
    for (const [type, rate] of Object.entries(c.decay)) {
      expect(rate, `decay.${type}`).toBeGreaterThan(0);
      expect(Number.isFinite(rate), `decay.${type} is finite`).toBe(true);
    }
  });
});
