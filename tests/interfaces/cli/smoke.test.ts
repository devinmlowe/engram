/**
 * Issue #61: the `extraction smoke` doctor check. The LLM tiers are a stubbed
 * `fetch` (Ollama up / everything refused), embeddings and NLI are mocked, and
 * the database is a temp file — so the real extractor and the real consolidator
 * run, but nothing leaves the process and nothing touches the developer's store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../../../src/_core/config/index.js";
import { initDatabase } from "../../../src/_core/db/schema.js";
import { CascadeError } from "../../../src/_core/llm/index.js";
import type { EngramConfig } from "../../../src/_core/types/index.js";
import { resetExtractor } from "../../../src/semantic/extractor.js";
import { consolidateFacts } from "../../../src/semantic/consolidator.js";
import type { ExtractionResult } from "../../../src/semantic/types.js";
import { checkSmoke } from "../../../src/interfaces/cli/doctor.js";
import {
  LLM_PROVIDER_HINT, SMOKE_FIXTURE, SMOKE_MAX_EXCHANGES, latestConversation, loadSmokeFixture, providerOf, runExtractionSmoke, skippedSmoke, tallyWritten,
} from "../../../src/interfaces/cli/smoke.js";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("../../../src/semantic/nli.js", () => ({ classifyNli: vi.fn() }));
vi.mock("../../../src/_core/embeddings/index.js", () => ({
  initEmbeddings: vi.fn(async () => undefined),
  embedDocument: vi.fn(async () => {
    const vec = Array.from({ length: 256 }, () => Math.random() - 0.5);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / norm);
  }),
}));

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST", "ENGRAM_OPENAI_BASE_URL", "ENGRAM_OPENAI_MODEL", "ENGRAM_LLM_PROVIDERS", "ENGRAM_LOCAL_MODEL", "ENGRAM_LOCAL_MODEL_FALLBACKS", "ENGRAM_DATA_DIR", "ENGRAM_DB_PATH", "ENGRAM_MODEL_CACHE_DIR", "HF_HOME"];
let saved: Record<string, string | undefined>;
let root: string;
let config: EngramConfig;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetExtractor();
  root = mkdtempSync(join(tmpdir(), "engram-smoke-"));
  config = loadConfig({ dataDir: root, dbPath: join(root, "engram.db") });
});
afterEach(() => {
  resetExtractor();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

const OLLAMA_FACTS = {
  facts: [
    { type: "decision", content: "The store uses SQLite with WAL mode and sqlite-vec.", importance: 0.8, source_exchange_indexes: [1] },
    { type: "preference", content: "The user prefers local inference through Ollama.", importance: 0.7, source_exchange_indexes: [2] },
  ],
};

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** Stub fetch: Ollama lists qwen2.5:7b and answers /api/generate, or refuses everything. */
function stubFetch(opts: { ollamaUp: boolean; delayMs?: number }): { prompts: string[] } {
  const prompts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (!opts.ollamaUp) throw new Error("ECONNREFUSED (stubbed)");
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 });
    if (url.endsWith("/api/generate")) {
      if (init?.body) prompts.push(String((JSON.parse(String(init.body)) as { prompt: string }).prompt));
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return new Response(JSON.stringify({ response: JSON.stringify(OLLAMA_FACTS) }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }));
  return { prompts };
}

/** A real database with one conversation of `n` exchanges (the newest ingested). */
function seedConversation(cfg: EngramConfig, id: string, n: number, lastIndexed: number, scope = "global"): void {
  const db = initDatabase(cfg);
  db.prepare("INSERT INTO conversations (id, project, started_at, ended_at, exchange_count, last_indexed, scope) VALUES (?, 'proj', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', ?, ?, ?)").run(id, n, lastIndexed, scope);
  const ins = db.prepare("INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index) VALUES (?, ?, 'proj', ?, ?, ?, ?)");
  for (let i = 0; i < n; i++) ins.run(`${id}-x${i}`, id, `2026-09-0${1 + (i % 2)}T0${i}:00:00Z`, `user ${i} ${"x".repeat(3000)}`, `assistant ${i}`, i);
  db.close();
}

describe("source selection", () => {
  it("uses the bundled fixture when no database exists — and never creates one", async () => {
    const r = await runExtractionSmoke(config, { extract: async (id, exchanges) => ({ conversationId: id, facts: [{ type: "fact", content: `${exchanges.length} exchanges`, importance: 0.5, sourceExchangeIds: [] }], model: "qwen2.5:7b", tier: "local", provider: "ollama", confidence: 7, durationMs: 1 }) });
    expect(r.status).toBe("ok");
    expect(r.source).toBe("fixture");
    expect(r.conversationId).toBe("smoke-fixture");
    expect(r.exchanges).toBe(3);
    expect(r.written).toBeNull();
    expect(r.message).toMatch(/^tier=ollama memories=1 \(qwen2\.5:7b; bundled fixture; nothing written/);
    expect(existsSync(config.dbPath)).toBe(false);
  });

  it("uses the fixture when the database holds no conversation with exchanges", async () => {
    initDatabase(config).close();
    const r = await runExtractionSmoke(config, { extract: async (id) => ({ conversationId: id, facts: [], model: "m", tier: "local", provider: "ollama", confidence: 1, durationMs: 1 }) });
    expect(r.source).toBe("fixture");
    expect(r.written).toBeNull();
  });

  it("picks the most recently ingested conversation, the last 3 exchanges, clipped, in order", () => {
    seedConversation(config, "old", 2, 100);
    seedConversation(config, "new", 5, 200, "hermes:work");
    const db = new Database(config.dbPath);
    try {
      const src = latestConversation(db)!;
      expect(src.kind).toBe("conversation");
      expect(src.id).toBe("new");
      expect(src.scope).toBe("hermes:work");
      expect(src.exchanges.map((e) => e.index)).toEqual([2, 3, 4]);
      expect(src.exchanges[0].id).toBe("new-x2");
      expect(src.exchanges[0].userMessage.length).toBe(2001); // 2000 + ellipsis
      expect(src.exchanges[0].userMessage.endsWith("…")).toBe(true);
      expect(src.metadata).toEqual({ project: "proj", dateRange: "2026-09-01 to 2026-09-01" });
      expect(latestConversation(db, 2).exchanges.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it("the bundled fixture parses, is capped like a real conversation and lives in prompts/ (shipped in the tarball)", () => {
    expect(SMOKE_FIXTURE).toMatch(/prompts[\\/]smoke-conversation\.json$/);
    const f = loadSmokeFixture();
    expect(f.kind).toBe("fixture");
    expect(f.exchanges.length).toBeLessThanOrEqual(SMOKE_MAX_EXCHANGES);
    expect(f.exchanges.length).toBeGreaterThanOrEqual(2);
    expect(f.metadata.project).toBe("engram-smoke");
    expect(f.exchanges.every((e) => e.userMessage.length > 0 && e.assistantMessage.length > 0)).toBe(true);
  });
});

describe("with the real extractor and a stubbed Ollama (mocked provider)", () => {
  it("success: tier=ollama memories=N, and the real conversation's facts land in the store as source='smoke'", async () => {
    seedConversation(config, "conv-1", 4, 100);
    const { prompts } = stubFetch({ ollamaUp: true });
    const r = await runExtractionSmoke(config, { consolidate: consolidateFacts });
    expect(r.status).toBe("ok");
    expect(r.source).toBe("conversation");
    expect(r.conversationId).toBe("conv-1");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("qwen2.5:7b");
    expect(r.memories).toBe(2);
    expect(r.written).toEqual({ inserted: 2, merged: 0, conflicts: 0, skipped: 0, errors: 0 });
    expect(r.message).toMatch(/^tier=ollama memories=2 \(qwen2\.5:7b; conversation conv-1 \(3 exchanges\); written to .*engram\.db as source=smoke: 2 inserted, 0 merged/);
    expect(r.message).toContain("forget removes them");
    // capped input: only the last three exchanges reached the prompt
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[Exchange 1]");
    expect(prompts[0]).not.toContain("[Exchange 0]");

    const db = new Database(config.dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT content, source, scope, is_active FROM memories ORDER BY content").all() as Array<{ content: string; source: string; scope: string; is_active: number }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((m) => m.source === "smoke" && m.scope === "global" && m.is_active === 1)).toBe(true);
      expect(rows.map((m) => m.content)).toEqual(OLLAMA_FACTS.facts.map((f) => f.content).sort());
    } finally {
      db.close();
    }
  });

  it("cascade failure: every tried tier's reason, the dream warning and the provider env vars", async () => {
    seedConversation(config, "conv-1", 2, 100);
    stubFetch({ ollamaUp: false });
    const r = await runExtractionSmoke(config, { consolidate: consolidateFacts });
    expect(r.status).toBe("no-tier");
    expect(r.source).toBe("conversation");
    expect(r.written).toBeNull();
    expect(r.tiers.map((t) => t.tier)).toEqual(["ollama", "openai", "openrouter", "anthropic"]);
    expect(r.tiers.every((t) => t.errorClass === "config")).toBe(true);
    expect(r.message).toMatch(/^no LLM tier reachable — ollama: skipped: Ollama not reachable at http:\/\/localhost:11434; openai: .*; openrouter: skipped: OPENROUTER_API_KEY not set; anthropic: skipped: ANTHROPIC_API_KEY not set — dream will not extract until a provider is configured \(/);
    expect(r.message).toContain(LLM_PROVIDER_HINT);
    // nothing written
    const db = new Database(config.dbPath, { readonly: true });
    try { expect((db.prepare("SELECT COUNT(*) n FROM memories").get() as { n: number }).n).toBe(0); } finally { db.close(); }
  });

  it("a CascadeError wrapped in an error cause (the extractor's wrapper) is still reported per tier", async () => {
    const cascade = new CascadeError([{ tier: "openrouter", errorClass: "provider", message: "HTTP 401: invalid key" }]);
    const r = await runExtractionSmoke(config, { extract: async () => { throw new Error("All extraction tiers failed for conversation x: …", { cause: cascade }); } });
    expect(r.status).toBe("no-tier");
    expect(r.tiers).toEqual([{ tier: "openrouter", errorClass: "provider", reason: "HTTP 401: invalid key" }]);
    expect(r.message).toContain("openrouter: HTTP 401: invalid key");
  });

  it("a non-cascade failure is reported as failed", async () => {
    const r = await runExtractionSmoke(config, { extract: async () => { throw new Error("prompt file missing"); } });
    expect(r.status).toBe("error");
    expect(r.message).toBe("failed (bundled fixture): prompt file missing");
  });
});

describe("budget", () => {
  it("honours the hard wall-clock budget: a slow provider becomes a timeout, nothing is written", async () => {
    seedConversation(config, "conv-1", 2, 100);
    stubFetch({ ollamaUp: true, delayMs: 300 });
    const started = Date.now();
    const r = await runExtractionSmoke(config, { budgetMs: 40, consolidate: consolidateFacts });
    expect(Date.now() - started).toBeLessThan(250);
    expect(r.status).toBe("timeout");
    expect(r.written).toBeNull();
    expect(r.message).toMatch(/^timed out after 40ms \(conversation conv-1 \(2 exchanges\)\) — no tier answered within the budget/);
    // the stray extraction finishing later must not write: give it time, then look
    await new Promise((res) => setTimeout(res, 350));
    const db = new Database(config.dbPath, { readonly: true });
    try { expect((db.prepare("SELECT COUNT(*) n FROM memories").get() as { n: number }).n).toBe(0); } finally { db.close(); }
  });

  it("formats whole seconds for the real 60 s budget", async () => {
    const r = await runExtractionSmoke(config, { budgetMs: 1000, extract: () => new Promise((res) => setTimeout(() => res({ conversationId: "x", facts: [], model: "m", tier: "local", confidence: 1, durationMs: 1 }), 1500)) });
    expect(r.message).toMatch(/^timed out after 1s /);
  });
});

describe("doctor check wrapper", () => {
  it("--no-smoke yields [--] skipped (--no-smoke) without touching anything", async () => {
    const { check, outcome } = await checkSmoke(config, { extract: async () => { throw new Error("must not run"); } }, true);
    expect(check).toEqual({ name: "extraction smoke", level: "warn", required: false, detail: "skipped (--no-smoke)" });
    expect(outcome).toEqual(skippedSmoke());
    expect(existsSync(config.dbPath)).toBe(false);
  });

  it("maps ok → [ok] and every other status → [--], never required", async () => {
    const ok = await checkSmoke(config, { extract: async (id) => ({ conversationId: id, facts: [], model: "m", tier: "openrouter", provider: "openrouter", confidence: 1, durationMs: 1 }) });
    expect(ok.check.level).toBe("ok");
    expect(ok.check.required).toBe(false);
    expect(ok.check.detail).toMatch(/^tier=openrouter memories=0/);
    const bad = await checkSmoke(config, { extract: async () => { throw new CascadeError([]); } });
    expect(bad.check.level).toBe("warn");
  });

  it("providerOf falls back from the historical tier names when a result carries no provider", () => {
    const base = { conversationId: "x", facts: [], model: "m", confidence: 1, durationMs: 1 };
    expect(providerOf({ ...base, tier: "local" } as ExtractionResult)).toBe("ollama");
    expect(providerOf({ ...base, tier: "openrouter" } as ExtractionResult)).toBe("openrouter");
    expect(providerOf({ ...base, tier: "haiku" } as ExtractionResult)).toBe("anthropic");
    expect(providerOf({ ...base, tier: "haiku", provider: "openai" } as ExtractionResult)).toBe("openai");
    expect(tallyWritten([{ action: "insert", memoryId: "a" }, { action: "merge", memoryId: "b" }, { action: "error", memoryId: "" }])).toEqual({ inserted: 1, merged: 1, conflicts: 0, skipped: 0, errors: 1 });
  });
});
