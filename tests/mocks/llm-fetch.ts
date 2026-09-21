/**
 * Global-fetch stub for the LLM cascade (#126): Ollama `/api/tags` +
 * `/api/generate`, OpenRouter chat completions with a tool call, and a
 * rejection for anything else, so a test can prove which tier served a
 * request. Pair it with `anthropicToolMock` for the injected Anthropic
 * client. Callers `vi.unstubAllGlobals()` in afterEach.
 */

import { vi } from "vitest";

export const OPENROUTER_MODEL = "google/gemini-2.5-flash-lite";

export interface StubFetchOptions {
  /** Whether `/api/tags` answers (with `qwen2.5:7b`) or throws ECONNREFUSED. */
  ollamaUp: boolean;
  /** OpenRouter answers with the tool call, or 401. */
  openrouter?: "ok" | "unauthorized";
  /** What Ollama "wrote" for `/api/generate`; a function sees the parsed request body to route by schema. */
  ollama: unknown | ((body: Record<string, unknown> | undefined) => unknown);
  /** The OpenRouter reply: the tool's name and its arguments object. */
  tool: string;
  openrouterResult: unknown;
}

export interface StubbedFetch {
  /** Every URL fetched, in order. */
  calls: string[];
  /** Every parsed JSON request body, in order. */
  bodies: Array<Record<string, unknown>>;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** URLs the fetch stub saw that would have reached the real Anthropic Messages API (#118: the client is a plain fetch POST). */
export function anthropicCalls(): string[] {
  return vi.mocked(fetch).mock.calls
    .map((c) => (c[0] instanceof Request ? c[0].url : String(c[0])))
    .filter((u) => u.includes("api.anthropic.com"));
}

export function stubFetch(opts: StubFetchOptions): StubbedFetch {
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      if (body) bodies.push(body);

      if (url.endsWith("/api/tags")) {
        if (!opts.ollamaUp) throw new Error("ECONNREFUSED (stubbed)");
        return json({ models: [{ name: "qwen2.5:7b" }] });
      }
      if (url.endsWith("/api/generate")) {
        const payload = typeof opts.ollama === "function" ? (opts.ollama as (b: typeof body) => unknown)(body) : opts.ollama;
        return json({ response: JSON.stringify(payload) });
      }
      if (url.includes("openrouter.ai")) {
        if (opts.openrouter === "unauthorized") return json({ error: "nope" }, 401);
        return json({
          model: OPENROUTER_MODEL,
          choices: [
            {
              message: {
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: opts.tool, arguments: JSON.stringify(opts.openrouterResult) } },
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

/** A `messages.create` mock that answers with one `tool_use` block. */
export function anthropicToolMock(tool: string, input: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "toolu_1", name: tool, input }],
  });
}
