/**
 * Issue #65 (Should): the daily cached version check. `update --check` twice
 * within a day performs one network call; a stale cache performs a new one;
 * ENGRAM_NO_UPDATE_CHECK=1 performs none and prints nothing; `/health`
 * carries `update: {current, available}`; the CLI prints the notice once on
 * stderr for a user-facing command and never with --json.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGRAM_VERSION, PACKAGE_NAME, PACKAGE_ROOT } from "../../../src/_core/version/index.js";
import type { ExecResult } from "../../../src/interfaces/cli/services.js";
import {
  NO_UPDATE_CHECK_ENV, UPDATE_CHECK_TTL_MS, maybeUpdateNotice, readUpdateCheckCache, refreshUpdateCheck, updateCheckCachePath,
  updateCheckDisabled, updateHealthField, updateNotice, updateNoticeFor, writeUpdateCheckCache, type UpdateCheckCache,
} from "../../../src/interfaces/cli/update-check.js";
import { createEngramHttpServer, type EngramHttpServer } from "../../../src/interfaces/mcp/http.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engram-update-check-"));
  vi.stubEnv(NO_UPDATE_CHECK_ENV, undefined);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An npm-install fake (no `.git` under packageRoot): `npm view` answers the dist-tag and counts calls. */
function npmFake(answer = "0.9.0") {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> => {
    calls.push(`${cmd} ${args.join(" ")}${opts?.timeoutMs ? ` [timeout ${opts.timeoutMs}]` : ""}`);
    if (cmd === "npm" && args[0] === "view") return { status: 0, stdout: `${answer}\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: `no fake for ${cmd}` };
  };
  return { exec, calls };
}

const T0 = new Date("2026-09-17T12:00:00Z");

describe("daily cached version check (#65)", () => {
  it("update --check twice within a day performs exactly one network call; the cache holds {checkedAt, current, available, kind}", async () => {
    const { exec, calls } = npmFake();
    const dataDir = join(root, "data");
    const first = await refreshUpdateCheck({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => T0 }, { force: true });
    expect(first.cached).toBe(false);
    expect(first.available.version).toBe("0.9.0");
    expect(calls.filter((c) => c.startsWith("npm view"))).toHaveLength(1);
    expect(calls[0]).toBe(`npm view ${PACKAGE_NAME} dist-tags.latest [timeout 6000]`);
    const file = updateCheckCachePath(dataDir);
    expect(file).toBe(join(dataDir, "cache", "update-check.json"));
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ checkedAt: T0.toISOString(), current: "0.3.0", available: "0.9.0", kind: "npm", source: `npm view ${PACKAGE_NAME} dist-tags.latest` });
    const later = new Date(T0.getTime() + 23 * 3600 * 1000);
    const second = await refreshUpdateCheck({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => later }, { force: true });
    expect(second.cached).toBe(true);
    expect(second.available.version).toBe("0.9.0");
    expect(calls.filter((c) => c.startsWith("npm view"))).toHaveLength(1);
    // stale (25 h) → a new call
    const stale = new Date(T0.getTime() + 25 * 3600 * 1000);
    const third = await refreshUpdateCheck({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => stale });
    expect(third.cached).toBe(false);
    expect(calls.filter((c) => c.startsWith("npm view"))).toHaveLength(2);
    expect(UPDATE_CHECK_TTL_MS).toBe(24 * 3600 * 1000);
  });

  it("a failed lookup is cached for the day (no retry per command) but an explicit --check retries it", async () => {
    const calls: string[] = [];
    const exec = async (cmd: string, args: string[]): Promise<ExecResult> => { calls.push(`${cmd} ${args[0]}`); return { status: 1, stdout: "", stderr: "ENOTFOUND registry" }; };
    const dataDir = join(root, "data");
    const r = await refreshUpdateCheck({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => T0 });
    expect(r.entry).toMatchObject({ available: null, error: "ENOTFOUND registry" });
    expect(await maybeUpdateNotice({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => T0, env: {} })).toBeNull();
    expect(calls).toHaveLength(1); // the passive path reused the cached failure
    await refreshUpdateCheck({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => T0 }, { force: true });
    expect(calls).toHaveLength(2); // --check asked again
  });

  it("the notice: one line when newer, nothing when up to date or ahead, nothing for another version's cache entry", () => {
    const dataDir = join(root, "data");
    const entry = (available: string | null, current = "0.3.0"): UpdateCheckCache => ({ checkedAt: T0.toISOString(), current, available, kind: "git", source: "git ls-remote --tags origin" });
    expect(updateNoticeFor(entry("0.4.0"), {})).toBe("engram 0.4.0 available (you have 0.3.0) — engram update");
    expect(updateNoticeFor(entry("0.3.0"), {})).toBeNull();
    expect(updateNoticeFor(entry("0.2.0"), {})).toBeNull();
    expect(updateNoticeFor(entry(null), {})).toBeNull();
    expect(updateNoticeFor(null, {})).toBeNull();
    writeUpdateCheckCache(dataDir, entry("0.4.0", "0.2.9"));
    expect(readUpdateCheckCache(dataDir, T0, "0.3.0")).toBeNull(); // recorded by a build that is gone
    expect(readUpdateCheckCache(dataDir, T0, "0.2.9")?.available).toBe("0.4.0");
    writeUpdateCheckCache(dataDir, entry("9.9.9", ENGRAM_VERSION));
    expect(updateNotice({ dataDir }, {}, T0)).toBe(`engram 9.9.9 available (you have ${ENGRAM_VERSION}) — engram update`);
    writeFileSync(updateCheckCachePath(dataDir), "not json");
    expect(updateNotice({ dataDir }, {}, T0)).toBeNull();
  });

  it("ENGRAM_NO_UPDATE_CHECK=1 → zero network calls and no notice, even with a newer version cached", async () => {
    const { exec, calls } = npmFake();
    const dataDir = join(root, "data");
    writeUpdateCheckCache(dataDir, { checkedAt: T0.toISOString(), current: "0.3.0", available: "0.9.0", kind: "npm", source: "npm view" });
    const env = { [NO_UPDATE_CHECK_ENV]: "1" };
    expect(updateCheckDisabled(env)).toBe(true);
    expect(updateCheckDisabled({ [NO_UPDATE_CHECK_ENV]: "0" })).toBe(false);
    expect(updateCheckDisabled({})).toBe(false);
    expect(updateNotice({ dataDir }, env, T0)).toBeNull();
    rmSync(join(dataDir, "cache"), { recursive: true, force: true });
    expect(await maybeUpdateNotice({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => T0, env })).toBeNull();
    expect(calls).toEqual([]);
    // enabled: the passive path performs the daily call and returns the line
    expect(await maybeUpdateNotice({ dataDir, exec, packageRoot: root, version: "0.3.0", now: () => T0, env: {} })).toBe("engram 0.9.0 available (you have 0.3.0) — engram update");
    expect(calls).toHaveLength(1);
  });

  it("/health carries update: {current, available, checkedAt} from the cache only", async () => {
    const dataDir = join(root, "data");
    let server: EngramHttpServer | null = null;
    try {
      server = createEngramHttpServer({ port: 0, registerHandlers: () => {}, health: () => ({ update: updateHealthField(dataDir, T0, "0.3.0") }), log: () => {} });
      const { port } = await server.listen();
      const empty = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { status: string; update: unknown };
      expect(empty.status).toBe("ok");
      expect(empty.update).toEqual({ current: "0.3.0", available: null, checkedAt: null });
      writeUpdateCheckCache(dataDir, { checkedAt: T0.toISOString(), current: "0.3.0", available: "0.4.0", kind: "git", source: "git ls-remote --tags origin" });
      const filled = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { update: unknown };
      expect(filled.update).toEqual({ current: "0.3.0", available: "0.4.0", checkedAt: T0.toISOString() });
    } finally {
      await server?.close();
    }
    // the real daemon wires the same field
    expect(readFileSync(join(PACKAGE_ROOT, "src/interfaces/mcp/server.ts"), "utf-8")).toContain("update: updateHealthField(");
  });
});

describe("engram CLI notice", () => {
  const cli = fileURLToPath(new URL("../../../dist/interfaces/cli/index.js", import.meta.url));
  const built = existsSync(cli);
  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, ENGRAM_DATA_DIR: join(root, "cli-data"), ENGRAM_MODEL_CACHE_DIR: join(root, "cli-models"), ENGRAM_MCP_PORT: "1", [NO_UPDATE_CHECK_ENV]: "", ...env },
    });
  }
  const NOTICE = `engram 9.9.9 available (you have ${ENGRAM_VERSION}) — engram update`;

  it.skipIf(!built)("stats prints the cached notice once on stderr, not with --json, not when disabled; mcp-free commands never call the network when the cache is fresh", () => {
    const dataDir = join(root, "cli-data");
    mkdirSync(dataDir, { recursive: true });
    writeUpdateCheckCache(dataDir, { checkedAt: new Date().toISOString(), current: ENGRAM_VERSION, available: "9.9.9", kind: "git", source: "git ls-remote --tags origin" });
    const r = run(["stats"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.trim().split("\n").filter((l) => l.includes("available"))).toEqual([NOTICE]);
    expect(r.stdout).not.toContain(NOTICE);
    const j = run(["stats", "--json"]);
    expect(j.status).toBe(0);
    expect(j.stderr).not.toContain(NOTICE);
    expect(JSON.parse(j.stdout).counts).toBeDefined();
    const off = run(["stats"], { [NO_UPDATE_CHECK_ENV]: "1" });
    expect(off.status).toBe(0);
    expect(off.stderr).not.toContain(NOTICE);
  }, 60_000);

  it.skipIf(!built)("update --check writes the cache and says so on the second run", () => {
    const first = run(["update", "--check"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).not.toContain("(cached ");
    expect(existsSync(updateCheckCachePath(join(root, "cli-data")))).toBe(true);
    const second = run(["update", "--check"]);
    expect(second.status, second.stderr).toBe(0);
    if (JSON.parse(readFileSync(updateCheckCachePath(join(root, "cli-data")), "utf-8")).available !== null) {
      expect(second.stdout).toContain("(cached ");
    }
  }, 60_000);
});
