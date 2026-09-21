/**
 * W7 — the default commitments extraction LLM must go through the _core/llm
 * factory so the configured cascade (Ollama → OpenRouter → Anthropic)
 * applies. SPEC.md INV-3: no cloud dependency when a local LLM is available.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";


import type { AnthropicClient as Anthropic } from "../../src/_core/llm/index.js";
import { defaultCommitmentsLlm, hasCommitmentsProvider } from "../../src/semantic/commitments.js";
import { runCommitmentsPass } from "../../src/dream/commitments-pass.js";
import { resetIntelligence, setClient } from "../../src/_core/llm/index.js";
import { createTestDb, type TestDb } from "../helpers.js";

/** URLs the fetch stub saw that would have reached the real Anthropic Messages API (#118: the client is a plain fetch POST). */
function anthropicCalls(): string[] {
  return vi.mocked(fetch).mock.calls
    .map((c) => (c[0] instanceof Request ? c[0].url : String(c[0])))
    .filter((u) => u.includes("api.anthropic.com"));
}

// ─── Helpers ────────────────────────────────────────────────────

const OLLAMA_RAW = {
  commitments: [
    { content: "Send Alan the leave timeline", subject: "devin", origin: "stated", due_hint: "tomorrow", source_exchange_indexes: [1] },
  ],
};
const OPENROUTER_RAW = { commitments: [{ content: "Ping Sam", subject: "devin", origin: "stated", due_hint: null, source_exchange_indexes: [0] }] };
const ANTHROPIC_RAW = { commitments: [] as unknown[] };

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
        return json({ response: JSON.stringify(OLLAMA_RAW) });
      }
      if (url.includes("openrouter.ai")) {
        if (opts.openrouter === "unauthorized") return json({ error: "nope" }, 401);
        return json({
          model: "google/gemini-2.5-flash-lite",
          choices: [
            {
              message: {
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "extract_commitments", arguments: JSON.stringify(OPENROUTER_RAW) } },
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
    content: [{ type: "tool_use", id: "toolu_1", name: "extract_commitments", input: ANTHROPIC_RAW }],
  });
}

function seedConversation(t: TestDb, id: string, userText: string): void {
  t.db.prepare(
    "INSERT INTO conversations (id, project, exchange_count, last_indexed) VALUES (?, 'demo', 1, 100)",
  ).run(id);
  t.db.prepare(
    `INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index)
     VALUES (?, ?, 'demo', '2026-09-10T10:00:00Z', ?, 'ok', 1)`,
  ).run(`${id}-ex-1`, id, userText);
}

// ─── Setup ──────────────────────────────────────────────────────

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST", "ENGRAM_LOCAL_MODEL"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetIntelligence();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  resetIntelligence();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Tests ──────────────────────────────────────────────────────

describe("commitments extraction routes through the LLM factory", () => {
  it("uses the Ollama tier when available and never constructs an Anthropic client", async () => {
    const { calls, bodies } = stubFetch({ ollamaUp: true });

    const { raw, model } = await defaultCommitmentsLlm("[Exchange 1]\nUser: I'll send Alan the timeline tomorrow");

    expect(model).toBe("qwen2.5:7b");
    expect(raw).toEqual(OLLAMA_RAW);
    expect(anthropicCalls()).toEqual([]);
    expect(calls.some((u) => u.includes("openrouter.ai"))).toBe(false);

    const generateBody = bodies.find((b) => b.format !== undefined);
    expect((generateBody?.format as { properties: Record<string, unknown> }).properties.commitments).toBeDefined();
    expect((generateBody?.options as { num_predict: number }).num_predict).toBe(2048);
  });

  it("falls back Ollama → OpenRouter → Anthropic in order", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const mockCreate = makeAnthropicMock();
    setClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const first = stubFetch({ ollamaUp: false, openrouter: "ok" });
    const viaOpenRouter = await defaultCommitmentsLlm("prompt");
    expect(viaOpenRouter.model).toBe("google/gemini-2.5-flash-lite");
    expect(viaOpenRouter.raw).toEqual(OPENROUTER_RAW);
    expect(first.calls[0]).toMatch(/\/api\/tags$/);
    expect(first.calls[1]).toContain("openrouter.ai");
    expect(mockCreate).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const second = stubFetch({ ollamaUp: false, openrouter: "unauthorized" });
    const viaAnthropic = await defaultCommitmentsLlm("prompt");
    expect(viaAnthropic.model).toBe("claude-haiku-4-5-20251001");
    expect(viaAnthropic.raw).toEqual(ANTHROPIC_RAW);
    expect(second.calls[0]).toMatch(/\/api\/tags$/);
    expect(second.calls[1]).toContain("openrouter.ai");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0];
    expect(args.max_tokens).toBe(2048);
    expect(args.tools[0].name).toBe("extract_commitments");
    expect(args.tool_choice).toEqual({ type: "tool", name: "extract_commitments" });
    expect(anthropicCalls()).toEqual([]);
  });

  it("the dream pass runs on a reachable Ollama alone (INV-3) instead of reporting no provider", async () => {
    stubFetch({ ollamaUp: true });
    expect(hasCommitmentsProvider()).toBe(false); // sync env check: no cloud keys, no local pin

    const t = createTestDb();
    try {
      seedConversation(t, "c1", "setting things up for the week ahead, I'll send Alan the leave timeline tomorrow");
      const r = await runCommitmentsPass(t.db, t.config, {
        conversationIds: ["c1"],
        embed: async (texts) => texts.map(() => [1, 0, 0, 0]),
      });
      expect(r.disabledReason).toBeUndefined();
      expect(r.conversations).toBe(1);
      expect(r.model).toBe("qwen2.5:7b");
      expect(r.inserted).toBe(1);
      expect(anthropicCalls()).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
