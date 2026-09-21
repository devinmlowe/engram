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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig, resolveDefaultDataDir, resolveModelCacheLocation } from "../../src/_core/config/index.js";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

describe("Config Defaults Contract", () => {
  // Platform data-dir vars also steer the default (LOCALAPPDATA is always set
  // on Windows CI), and HF_HOME steers the model cache, so they are cleared
  // alongside ENGRAM_* to pin the fallbacks.
  const PLATFORM_DIR_VARS = ["XDG_DATA_HOME", "LOCALAPPDATA", "HF_HOME"];
  const isManaged = (key: string) =>
    key.startsWith("ENGRAM_") || PLATFORM_DIR_VARS.includes(key);

  beforeEach(() => {
    for (const key of Object.keys(process.env)) if (isManaged(key)) vi.stubEnv(key, undefined);
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

  // ── Platform Data-Dir Resolution ───────────────────────────────
  // Only consulted when ENGRAM_DATA_DIR is unset; the fallback is the
  // historical location so existing installs never move.

  it("falls back to ~/.local/share/engram on every platform when no var is set", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(resolveDefaultDataDir({}, platform, "/home/u")).toBe(
        join("/home/u", ".local", "share", "engram"),
      );
    }
  });

  it("macOS default stays ~/.local/share/engram (XDG_DATA_HOME normally unset)", () => {
    expect(resolveDefaultDataDir({ LOCALAPPDATA: "/ignored" }, "darwin", "/Users/u")).toBe(
      join("/Users/u", ".local", "share", "engram"),
    );
  });

  it("honors XDG_DATA_HOME on Linux and macOS", () => {
    expect(resolveDefaultDataDir({ XDG_DATA_HOME: "/xdg" }, "linux", "/home/u")).toBe(
      join("/xdg", "engram"),
    );
    expect(resolveDefaultDataDir({ XDG_DATA_HOME: "/xdg" }, "darwin", "/Users/u")).toBe(
      join("/xdg", "engram"),
    );
  });

  it("honors LOCALAPPDATA on Windows and ignores XDG_DATA_HOME there", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", XDG_DATA_HOME: "/xdg" };
    expect(resolveDefaultDataDir(env, "win32", "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Local", "engram"),
    );
  });

  it("treats blank platform vars as unset", () => {
    expect(resolveDefaultDataDir({ XDG_DATA_HOME: "  " }, "linux", "/home/u")).toBe(
      join("/home/u", ".local", "share", "engram"),
    );
    expect(resolveDefaultDataDir({ LOCALAPPDATA: "" }, "win32", "/home/u")).toBe(
      join("/home/u", ".local", "share", "engram"),
    );
  });

  it("loadConfig derives every path from the platform default", () => {
    vi.stubEnv("XDG_DATA_HOME", "/xdg-home");
    const c = loadConfig();
    if (process.platform === "win32") {
      expect(c.dataDir).toBe(join(HOME, ".local", "share", "engram"));
    } else {
      expect(c.dataDir).toBe(join("/xdg-home", "engram"));
      expect(c.dbPath).toBe(join("/xdg-home", "engram", "engram.db"));
      expect(c.archiveDir).toBe(join("/xdg-home", "engram", "archive"));
      expect(c.logsDir).toBe(join("/xdg-home", "engram", "logs"));
    }
  });

  it("ENGRAM_DATA_DIR wins over XDG_DATA_HOME and LOCALAPPDATA", () => {
    vi.stubEnv("XDG_DATA_HOME", "/xdg-home");
    vi.stubEnv("LOCALAPPDATA", "/local-app-data");
    vi.stubEnv("ENGRAM_DATA_DIR", "/explicit");
    const c = loadConfig();
    expect(c.dataDir).toBe("/explicit");
    expect(c.dbPath).toBe(join("/explicit", "engram.db"));
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
    expect(c.dream.localModelFallbacks).toEqual([]);
    expect(c.dream.openrouterModel).toBeUndefined();
  });

  it("parses ENGRAM_LOCAL_MODEL_FALLBACKS as a trimmed, comma-separated list (#16)", () => {
    vi.stubEnv("ENGRAM_LOCAL_MODEL_FALLBACKS", " llama3.1:8b, qwen3:8b ,,");
    expect(loadConfig().dream.localModelFallbacks).toEqual(["llama3.1:8b", "qwen3:8b"]);
    vi.stubEnv("ENGRAM_LOCAL_MODEL_FALLBACKS", "");
    expect(loadConfig().dream.localModelFallbacks).toEqual([]);
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
    vi.stubEnv("ENGRAM_DB_PATH", "/tmp/custom.db");
    const c = loadConfig();
    expect(c.dbPath).toBe("/tmp/custom.db");
  });

  it("ENGRAM_DATA_DIR cascades to derived paths", () => {
    vi.stubEnv("ENGRAM_DATA_DIR", "/tmp/engram-custom");
    const c = loadConfig();
    expect(c.dataDir).toBe("/tmp/engram-custom");
    expect(c.dbPath).toBe(join("/tmp/engram-custom", "engram.db"));
    expect(c.archiveDir).toBe(join("/tmp/engram-custom", "archive"));
    expect(c.logsDir).toBe(join("/tmp/engram-custom", "logs"));
  });

  it("explicit env vars override cascaded paths", () => {
    vi.stubEnv("ENGRAM_DATA_DIR", "/tmp/engram-custom");
    vi.stubEnv("ENGRAM_DB_PATH", "/other/path.db");
    const c = loadConfig();
    expect(c.dataDir).toBe("/tmp/engram-custom");
    expect(c.dbPath).toBe("/other/path.db"); // explicit wins over cascade
  });

  // Issue #53: the model cache is durable by default. The library default
  // (node_modules/@xenova/transformers/.cache) is never resolved to, because
  // every npm install / npm ci wipes it.
  it("modelCacheDir defaults to <data dir>/models, never node_modules", () => {
    const c = loadConfig();
    expect(c.modelCacheDir).toBe(join(c.dataDir, "models"));
    expect(c.modelCacheDir).toBe(join(HOME, ".local", "share", "engram", "models"));
    expect(c.modelCacheDir).not.toContain("node_modules");
  });

  it("modelCacheDir follows ENGRAM_DATA_DIR", () => {
    vi.stubEnv("ENGRAM_DATA_DIR", "/tmp/engram-custom");
    expect(loadConfig().modelCacheDir).toBe(join("/tmp/engram-custom", "models"));
  });

  it("ENGRAM_MODEL_CACHE_DIR overrides modelCacheDir", () => {
    vi.stubEnv("ENGRAM_MODEL_CACHE_DIR", "/tmp/engram-models");
    expect(loadConfig().modelCacheDir).toBe("/tmp/engram-models");
  });

  it("HF_HOME resolves to $HF_HOME/hub, above the default and below ENGRAM_MODEL_CACHE_DIR", () => {
    vi.stubEnv("HF_HOME", "/hf");
    expect(loadConfig().modelCacheDir).toBe(join("/hf", "hub"));
    vi.stubEnv("ENGRAM_MODEL_CACHE_DIR", "/tmp/engram-models");
    expect(loadConfig().modelCacheDir).toBe("/tmp/engram-models");
  });

  it("a programmatic override sits between ENGRAM_MODEL_CACHE_DIR and HF_HOME", () => {
    vi.stubEnv("HF_HOME", "/hf");
    expect(loadConfig({ modelCacheDir: "/from/overrides" }).modelCacheDir).toBe("/from/overrides");
    vi.stubEnv("ENGRAM_MODEL_CACHE_DIR", "/tmp/engram-models");
    expect(loadConfig({ modelCacheDir: "/from/overrides" }).modelCacheDir).toBe("/tmp/engram-models");
  });

  it("blank ENGRAM_MODEL_CACHE_DIR and HF_HOME are treated as unset", () => {
    vi.stubEnv("ENGRAM_MODEL_CACHE_DIR", "   ");
    vi.stubEnv("HF_HOME", "");
    const c = loadConfig();
    expect(c.modelCacheDir).toBe(join(c.dataDir, "models"));
    expect(loadConfig({ modelCacheDir: "/from/overrides" }).modelCacheDir).toBe("/from/overrides");
  });

  it("resolveModelCacheLocation names the winning tier in precedence order", () => {
    const data = "/data";
    expect(resolveModelCacheLocation(data, {})).toEqual({ dir: join(data, "models"), source: "default" });
    expect(resolveModelCacheLocation(data, { HF_HOME: "/hf" })).toEqual({ dir: join("/hf", "hub"), source: "HF_HOME" });
    expect(resolveModelCacheLocation(data, { HF_HOME: "/hf" }, "/ovr")).toEqual({ dir: "/ovr", source: "override" });
    expect(resolveModelCacheLocation(data, { HF_HOME: "/hf", ENGRAM_MODEL_CACHE_DIR: "/explicit" }, "/ovr"))
      .toEqual({ dir: "/explicit", source: "ENGRAM_MODEL_CACHE_DIR" });
    expect(resolveModelCacheLocation(data, { ENGRAM_MODEL_CACHE_DIR: " " }, "  ")).toEqual({ dir: join(data, "models"), source: "default" });
  });

  it("loadConfig keeps the winning tier as modelCacheSource", () => {
    expect(loadConfig().modelCacheSource).toBe("default");
    vi.stubEnv("HF_HOME", "/hf");
    expect(loadConfig()).toMatchObject({ modelCacheDir: join("/hf", "hub"), modelCacheSource: "HF_HOME" });
    expect(loadConfig({ modelCacheDir: "/ovr" }).modelCacheSource).toBe("override");
    vi.stubEnv("ENGRAM_MODEL_CACHE_DIR", "/explicit");
    expect(loadConfig()).toMatchObject({ modelCacheDir: "/explicit", modelCacheSource: "ENGRAM_MODEL_CACHE_DIR" });
  });

  it("ENGRAM_EMBEDDING_DIMS overrides dimensions", () => {
    vi.stubEnv("ENGRAM_EMBEDDING_DIMS", "768");
    const c = loadConfig();
    expect(c.embedding.dimensions).toBe(768);
  });

  it("ENGRAM_RERANK_ENABLED=false disables reranking", () => {
    vi.stubEnv("ENGRAM_RERANK_ENABLED", "false");
    const c = loadConfig();
    expect(c.search.rerankEnabled).toBe(false);
    expect(c.search.reranker.enabled).toBe(false);
  });

  it("ENGRAM_RERANK_ENABLED=0 disables reranking", () => {
    vi.stubEnv("ENGRAM_RERANK_ENABLED", "0");
    const c = loadConfig();
    expect(c.search.rerankEnabled).toBe(false);
  });

  // ── Override Precedence ────────────────────────────────────────

  it("env vars take precedence over programmatic overrides", () => {
    vi.stubEnv("ENGRAM_DB_PATH", "/env/wins.db");
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
