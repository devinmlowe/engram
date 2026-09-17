/**
 * W7 — the consolidator's contradiction resolver must obtain its LLM through
 * the _core/llm factory so the configured cascade (Ollama → OpenRouter →
 * Anthropic) applies. SPEC.md INV-3: no cloud dependency when a local LLM
 * is available.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("../../src/semantic/nli.js", () => ({ classifyNli: vi.fn() }));
vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedDocument: vi.fn(),
  initEmbeddings: vi.fn(),
}));

import Anthropic from "@anthropic-ai/sdk";
import {
  deduplicateFact,
  initConsolidator,
  resetConsolidator,
  setConsolidatorClient,
} from "../../src/semantic/consolidator.js";
import { insertMemory, getMemory } from "../../src/semantic/memory.js";
import { CascadeError } from "../../src/_core/llm/index.js";
import { classifyNli } from "../../src/semantic/nli.js";
import { embedDocument } from "../../src/_core/embeddings/index.js";
import type { Memory, ExtractedFact } from "../../src/semantic/types.js";
import { createTestDb, type TestDb } from "../helpers.js";

const AnthropicCtor = vi.mocked(Anthropic);
const mockedClassifyNli = vi.mocked(classifyNli);
const mockedEmbedDocument = vi.mocked(embedDocument);

// ─── Helpers ────────────────────────────────────────────────────

const DIMS = 256;

/** Unit vector along axis 0. */
function baseEmbedding(): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 1;
  return v;
}

/** Unit vector with cosine ≈ 0.9 to baseEmbedding() — inside the NLI band. */
function nliBandEmbedding(): number[] {
  const k = Math.sqrt(1 / 0.81 - 1); // cos = 1/sqrt(1+k²) = 0.9
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 1;
  v[1] = k;
  const norm = Math.sqrt(1 + k * k);
  return v.map((x) => x / norm);
}

function existingMemory(): Memory {
  return {
    id: "mem-existing",
    type: "preference",
    content: "User prefers 2-space indentation",
    confidence: 0.5,
    importance: 0.5,
    accessCount: 1,
    createdAt: Math.floor(Date.now() / 1000) - 86_400,
    sourceExchanges: ["exch-001"],
    isActive: true,
  };
}

function newFact(): ExtractedFact {
  return {
    type: "preference",
    content: "User prefers 4-space indentation",
    importance: 0.6,
    sourceExchangeIds: ["exch-010"],
    extractionBasis: "explicit",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function stubFetch(opts: {
  ollamaUp: boolean;
  openrouter?: "ok" | "unauthorized";
}): { calls: string[]; bodies: Array<Record<string, unknown>> } {
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push(url);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));

      if (url.endsWith("/api/tags")) {
        if (!opts.ollamaUp) throw new Error("ECONNREFUSED (stubbed)");
        return json({ models: [{ name: "qwen2.5:7b" }] });
      }
      if (url.endsWith("/api/generate")) {
        return json({
          response: JSON.stringify({
            action: "update",
            reasoning: "Ollama resolved: preference changed",
            updated_content: "User prefers 4-space indentation",
          }),
        });
      }
      if (url.includes("openrouter.ai")) {
        if (opts.openrouter === "unauthorized") return json({ error: "nope" }, 401);
        return json({
          model: "google/gemini-2.5-flash-lite",
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "resolve_conflict",
                      arguments: JSON.stringify({
                        action: "keep_both",
                        reasoning: "OpenRouter resolved: both valid",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return { calls, bodies };
}

function makeAnthropicMock(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "resolve_conflict",
        input: { action: "noop", reasoning: "Anthropic resolved: keep existing" },
      },
    ],
  });
}

// ─── Setup ──────────────────────────────────────────────────────

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST"] as const;
let savedEnv: Record<string, string | undefined> = {};
let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  resetConsolidator();
  AnthropicCtor.mockClear();
  vi.clearAllMocks();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  insertMemory(t.db, existingMemory(), baseEmbedding());
  mockedEmbedDocument.mockResolvedValue(nliBandEmbedding());
  mockedClassifyNli.mockResolvedValue({
    entailment: 0.05,
    contradiction: 0.9,
    neutral: 0.05,
    label: "contradiction",
  });
});

afterEach(() => {
  t.cleanup();
  resetConsolidator();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Tests ──────────────────────────────────────────────────────

describe("consolidator conflict resolution routes through the LLM factory", () => {
  it("uses the Ollama tier when available and never constructs an Anthropic client", async () => {
    const { calls, bodies } = stubFetch({ ollamaUp: true });

    await expect(initConsolidator()).resolves.toBeUndefined();

    const result = await deduplicateFact(t.db, newFact(), "conv-001");

    expect(result.action).toBe("conflict");
    const old = getMemory(t.db, "mem-existing");
    expect(old!.isActive).toBe(false);
    expect(old!.supersededBy).toBe(result.memoryId);

    expect(AnthropicCtor).not.toHaveBeenCalled();
    expect(calls.some((u) => u.includes("openrouter.ai"))).toBe(false);

    // Structured-output contract on the local path: schema + token cap preserved
    const generateBody = bodies.find((b) => b.format !== undefined);
    expect(generateBody?.model).toBe("qwen2.5:7b");
    expect((generateBody?.format as { properties: Record<string, unknown> }).properties.action).toBeDefined();
    expect((generateBody?.options as { num_predict: number }).num_predict).toBe(1024);
    expect(String(generateBody?.system)).toContain("conflict");
    expect(String(generateBody?.prompt)).toContain("User prefers 2-space indentation");
  });

  it("falls back to OpenRouter when Ollama is unavailable, before Anthropic", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const { calls } = stubFetch({ ollamaUp: false, openrouter: "ok" });
    const mockCreate = makeAnthropicMock();
    setConsolidatorClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const result = await deduplicateFact(t.db, newFact(), "conv-001");

    // keep_both → recorded as a conflict with the old memory still active
    expect(result.action).toBe("conflict");
    expect(getMemory(t.db, "mem-existing")!.isActive).toBe(true);
    expect(calls[0]).toMatch(/\/api\/tags$/);
    expect(calls[1]).toContain("openrouter.ai");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it("falls through to Anthropic when both Ollama and OpenRouter fail", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const { calls } = stubFetch({ ollamaUp: false, openrouter: "unauthorized" });
    const mockCreate = makeAnthropicMock();
    setConsolidatorClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const result = await deduplicateFact(t.db, newFact(), "conv-001");

    // noop → existing kept, new discarded
    expect(result.action).toBe("skip");
    expect(result.memoryId).toBe("mem-existing");
    expect(calls[0]).toMatch(/\/api\/tags$/);
    expect(calls[1]).toContain("openrouter.ai");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.max_tokens).toBe(1024);
    expect(args.tools[0].name).toBe("resolve_conflict");
    expect(args.tool_choice).toEqual({ type: "tool", name: "resolve_conflict" });
    expect(String(args.system)).toContain("conflict");
  });

  it("throws a CascadeError naming the Anthropic tier when neither model returns a tool_use block (#30)", async () => {
    stubFetch({ ollamaUp: false });
    // Text-only responses from both the primary and the fallback model.
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "I would keep the existing memory." }],
      stop_reason: "end_turn",
    });
    setConsolidatorClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const promise = deduplicateFact(t.db, newFact(), "conv-001");

    await expect(promise).rejects.toBeInstanceOf(CascadeError);
    await expect(promise).rejects.toThrow(/anthropic \(unknown\): No tool_use block in API response/);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls.map((c) => c[0].model)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
    ]);
    // Nothing was written: the existing memory is untouched and no new one exists.
    expect(getMemory(t.db, "mem-existing")?.isActive).toBe(true);
    expect((t.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c).toBe(1);
  });

  it("initConsolidator rejects when no tier is reachable", async () => {
    stubFetch({ ollamaUp: false });
    await expect(initConsolidator()).rejects.toThrow("No conflict resolution provider configured");
  });
});
