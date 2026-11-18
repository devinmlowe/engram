import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalModule } from "./_support/load.ts";

export const TRACES = ["SPEC-001"];

const tmp = mkdtempSync(join(tmpdir(), "spec001-"));
const zero = join(tmp, "zero.db");
writeFileSync(zero, "");
const notSqlite = join(tmp, "notsqlite.db");
writeFileSync(notSqlite, "definitely not a sqlite database header\n");

// A minimal real SQLite file (a valid DB created with better-sqlite3).
import Database from "better-sqlite3";
const good = join(tmp, "good.db");
const gdb = new Database(good);
gdb.exec("CREATE TABLE ok (id TEXT)");
gdb.close();

describe("SPEC-001 store-path guard", () => {
  it("rejects a 0-byte DB with a clear StoreGuardError", async () => {
    const store = await loadEvalModule<Record<string, any>>("store.js");
    const StoreGuardError = store.StoreGuardError;
    expect(typeof store.assertUsableStore, "assertUsableStore export").toBe("function");
    expect(() => store.assertUsableStore(zero)).toThrowError(/0 bytes|empty/i);
    try {
      store.assertUsableStore(zero);
      throw new Error("expected StoreGuardError");
    } catch (err: any) {
      if (!(err instanceof StoreGuardError)) {
        expect.fail(`0-byte guard must raise StoreGuardError, got ${err?.constructor?.name}`);
      }
    }
  });

  it("rejects a missing file and a non-SQLite file", async () => {
    const store = await loadEvalModule<Record<string, any>>("store.js");
    expect(() => store.assertUsableStore(join(tmp, "missing.db"))).toThrowError(
      /missing|not found/i,
    );
    expect(() => store.assertUsableStore(notSqlite)).toThrowError(/not.*sqlite|header/i);
  });

  it("accepts a valid SQLite file", async () => {
    const store = await loadEvalModule<Record<string, any>>("store.js");
    expect(() => store.assertUsableStore(good)).not.toThrow();
  });

  it("resolves the store path through Engram's own config logic", async () => {
    const store = await loadEvalModule<Record<string, any>>("store.js");
    expect(typeof store.resolveStorePath, "resolveStorePath export").toBe("function");
    const env = { ENGRAM_DATA_DIR: join(tmp, "data") } as Record<string, string>;
    expect(store.resolveStorePath({ env })).toBe(join(tmp, "data", "engram.db"));
    // --db flag wins over env
    expect(store.resolveStorePath({ dbFlag: join(tmp, "flag.db"), env })).toBe(
      join(tmp, "flag.db"),
    );
  });

  it("opens the store read-only via better-sqlite3 readonly:true", async () => {
    const store = await loadEvalModule<Record<string, any>>("store.js");
    const db = store.openStoreReadonly(good);
    expect(db.readonly).toBe(true);
    expect(() => db.exec("CREATE TABLE tamper (x)")).toThrow();
    db.close();
    // store still intact
    const check = new Database(good);
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("ok");
    check.close();
  });

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });
});
