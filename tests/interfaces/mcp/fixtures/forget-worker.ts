/**
 * Real worker_threads fixture for the #55 forget-tool HTTP-mode test.
 *
 * Started through forget-worker-entry.mjs (which registers tsx for the
 * thread) so it can import the TypeScript sources directly. It speaks the pool protocol
 * ({ id, tool, args, context } → { id, ok, result }) exactly like
 * src/interfaces/mcp/worker.ts and routes `forget` to the REAL
 * `handleToolCall` (which never touches the embedding model for an id
 * lookup). `remember` and `recall` are implemented on the semantic layer
 * with deterministic vectors so the worker needs no ONNX model.
 */

import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { handleToolCall } from "../../../../src/interfaces/mcp/server.js";
import type { ToolCallContext } from "../../../../src/interfaces/mcp/dispatch.js";
import { getDatabase } from "../../../../src/_core/db/index.js";
import { loadConfig } from "../../../../src/_core/config/index.js";
import { insertMemory, findNearestMemories, getMemory } from "../../../../src/semantic/memory.js";
import { formatRecallXml } from "../../../../src/_core/search/format.js";
import type { SearchResult } from "../../../../src/_core/types/index.js";

if (!parentPort) throw new Error("forget-worker.ts must run as a worker thread");
const port = parentPort;

const DIMS = 256;
function vec(seed: string): number[] {
  const v = new Array(DIMS);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  for (let i = 0; i < DIMS; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    v[i] = (hash & 0xffff) / 0xffff - 0.5;
  }
  const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0));
  return v.map((x: number) => x / norm);
}

const db = getDatabase(loadConfig());
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

port.on("message", (message: unknown) => {
  const { id, tool, args, context } = message as { id: number; tool: string; args: Record<string, unknown>; context?: ToolCallContext };
  const reply = (result: unknown) => port.postMessage({ id, ok: true, result });
  const fail = (error: unknown) => port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });

  try {
    if (tool === "remember") {
      const content = String(args.content);
      const memoryId = randomUUID();
      insertMemory(
        db,
        {
          id: memoryId,
          type: "fact",
          content,
          confidence: 0.9,
          importance: 0.7,
          accessCount: 0,
          createdAt: Math.floor(Date.now() / 1000),
          sourceExchanges: [],
          isActive: true,
          source: "user",
          scope: "global",
        },
        vec(`doc:${content}`),
      );
      reply(text(`Remembered: ${content} (${memoryId})`));
      return;
    }

    if (tool === "recall") {
      const query = String(args.query);
      const results: SearchResult[] = findNearestMemories(db, vec(`doc:${query}`), 10)
        .map((hit) => getMemory(db, hit.id))
        .filter((m): m is NonNullable<typeof m> => m !== null)
        .map((m) => ({
          id: m.id,
          source: "semantic" as const,
          score: 1,
          content: m.content,
          metadata: { type: m.type, confidence: m.confidence, importance: m.importance },
          tokenEstimate: Math.ceil(m.content.length / 4),
        }));
      reply(text(formatRecallXml({ results, tokensUsed: 0, totalResults: results.length, query })));
      return;
    }

    // Everything else (forget) goes through the real handler with the context intact.
    handleToolCall(tool, args, context).then(reply, fail);
  } catch (error) {
    fail(error);
  }
});

port.postMessage({ type: "ready" });
