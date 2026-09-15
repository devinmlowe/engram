/**
 * MCP `commitments` / `commitments_update` handlers against a temp DB.
 * server.ts only starts a transport when run directly, so importing it here
 * is side-effect free; ENGRAM_DB_PATH is set before the lazy DB open.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const tmpDir = mkdtempSync(join(tmpdir(), "engram-commit-tools-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "tools.db");
process.env.ENGRAM_DATA_DIR = tmpDir;

describe("commitments MCP tools", () => {
  let handleToolCall: typeof import("../../../src/interfaces/mcp/server.js").handleToolCall;
  let ids: string[] = [];

  beforeAll(async () => {
    ({ handleToolCall } = await import("../../../src/interfaces/mcp/server.js"));
    // First call opens (and migrates) the DB
    await handleToolCall("commitments", {});
    const db = new Database(process.env.ENGRAM_DB_PATH!);
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare("INSERT INTO commitments (id, content, subject, origin, due_at, created_at, source_exchanges) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run("aaaaaaaa-1111-4000-8000-000000000001", "Send Alan the leave timeline", "devin", "stated", now - 86_400, now - 5 * 86_400, JSON.stringify(["ex-1"]));
    ins.run("bbbbbbbb-2222-4000-8000-000000000002", "Alan to confirm the return date", "alan", "inferred", now + 3 * 86_400, now - 86_400, JSON.stringify(["ex-1"]));
    ins.run("cccccccc-3333-4000-8000-000000000003", "Revisit the retry logic", "devin", "stated", null, now, JSON.stringify(["ex-2"]));
    db.close();
    ids = ["aaaaaaaa-1111-4000-8000-000000000001", "bbbbbbbb-2222-4000-8000-000000000002", "cccccccc-3333-4000-8000-000000000003"];
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists pending commitments as XML, overdue first", async () => {
    const res = await handleToolCall("commitments", {});
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text as string;
    expect(text).toMatch(/^<engram_commitments status="pending" count="3" total="3"/);
    const order = [...text.matchAll(/commitment id="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(ids);
    expect(text).toContain('overdue="true"');
    expect(text).toContain('subject="alan" origin="inferred"');
  });

  it("filters by due window and rejects bad input", async () => {
    const soon = (await handleToolCall("commitments", { include_due_within_days: 7 })).content[0].text as string;
    expect(soon).toContain('count="2"');
    expect(soon).not.toContain(ids[2]);
    const bad = await handleToolCall("commitments", { status: "whatever" });
    expect(bad.isError).toBe(true);
  });

  it("commitments_update resolves by prefix and removes the item from the pending list", async () => {
    const res = await handleToolCall("commitments_update", { id: "aaaaaaaa", status: "done" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe(`Commitment ${ids[0]} marked done: Send Alan the leave timeline`);
    const pending = (await handleToolCall("commitments", {})).content[0].text as string;
    expect(pending).not.toContain(ids[0]);
    const done = (await handleToolCall("commitments", { status: "done" })).content[0].text as string;
    expect(done).toContain(ids[0]);
    expect(done).toMatch(/resolved="\d{4}-\d{2}-\d{2}"/);

    const sup = await handleToolCall("commitments_update", { id: ids[2], status: "superseded", superseded_by: ids[1] });
    expect(sup.content[0].text).toContain(`marked superseded (superseded by ${ids[1]})`);
    const missing = await handleToolCall("commitments_update", { id: "zzzzzzzz", status: "done" });
    expect(missing.isError).toBe(true);
  });
});
