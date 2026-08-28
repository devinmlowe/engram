import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../../src/interfaces/web/data/graph-queries.js", () => ({
  getGraphData: vi.fn(() => ({ nodes: [], links: [] })),
}));

import { handleSseConnection, broadcastUpdate } from "../../src/interfaces/web/routes/sse.js";

function fakeClient() {
  const writes: string[] = [];
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((s: string) => writes.push(s)),
  } as unknown as ServerResponse;
  const req = { on: vi.fn() } as unknown as IncomingMessage;
  return { req, res, writes };
}

describe("SSE broadcast cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers an update that lands inside the cooldown instead of dropping it", () => {
    const c = fakeClient();
    handleSseConnection(c.req, c.res);
    const db = {} as Database.Database;

    broadcastUpdate(db); // first broadcast goes out
    const after1 = c.writes.length;

    vi.advanceTimersByTime(10_000);
    broadcastUpdate(db); // inside cooldown → queued, not sent yet
    vi.advanceTimersByTime(10_000);
    broadcastUpdate(db); // still inside cooldown → coalesced into the same pending timer
    expect(c.writes.length).toBe(after1);

    vi.advanceTimersByTime(10_001); // cooldown expires → exactly one trailing broadcast
    expect(c.writes.length).toBe(after1 + 1);

    vi.advanceTimersByTime(60_000); // nothing else queued
    expect(c.writes.length).toBe(after1 + 1);
  });
});
