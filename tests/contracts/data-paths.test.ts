/**
 * Contract: Data Path Agreement (issue #7)
 *
 * Every component that touches engram data on disk must resolve its paths
 * through loadConfig() in src/_core/config. Before this contract existed the
 * web server hand-built ~/.local/share/engram/engram.db (ignoring
 * ENGRAM_DATA_DIR) and the daemon and web dream route could disagree on the
 * dream.log location, so the visualizer read an empty DB and tailed a log
 * nobody wrote.
 *
 * These tests pin that the web server, the dream daemon, and the web dream
 * route all agree with loadConfig() -- and with each other -- under
 * ENGRAM_DATA_DIR, under the explicit ENGRAM_DB_PATH / ENGRAM_LOGS_DIR
 * overrides, and with no overrides at all.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { loadConfig } from "../../src/_core/config/index.js";
import { resolveWebDbPath } from "../../src/interfaces/web/paths.js";
import {
  resolveDreamLogPath as daemonDreamLogPath,
  resolvePendingFactsDir,
} from "../../src/dream/daemon.js";
import { resolveDreamLogPath as routeDreamLogPath } from "../../src/interfaces/web/routes/dream.js";

const MANAGED = ["XDG_DATA_HOME", "LOCALAPPDATA"];
const isManaged = (key: string) => key.startsWith("ENGRAM_") || MANAGED.includes(key);

describe("Data Path Agreement Contract", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (isManaged(key)) {
        envBackup[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (isManaged(key)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(envBackup)) {
      if (val !== undefined) process.env[key] = val;
    }
  });

  it("web server, dream daemon, and web dream route agree under ENGRAM_DATA_DIR", () => {
    process.env.ENGRAM_DATA_DIR = join("/tmp", "engram-contract");
    const config = loadConfig();

    // DB: the web server opens the same file the config module resolves.
    expect(resolveWebDbPath()).toBe(config.dbPath);
    expect(resolveWebDbPath()).toBe(join("/tmp", "engram-contract", "engram.db"));

    // Log: the route tails exactly the file the daemon writes.
    expect(daemonDreamLogPath()).toBe(join(config.logsDir, "dream.log"));
    expect(routeDreamLogPath()).toBe(daemonDreamLogPath());
    expect(routeDreamLogPath()).toBe(join("/tmp", "engram-contract", "logs", "dream.log"));

    // Scratch: pending facts live under the same data dir.
    expect(resolvePendingFactsDir()).toBe(join("/tmp", "engram-contract", "tmp"));
  });

  it("explicit ENGRAM_DB_PATH and ENGRAM_LOGS_DIR are honored by every component", () => {
    process.env.ENGRAM_DATA_DIR = join("/tmp", "engram-contract");
    process.env.ENGRAM_DB_PATH = join("/elsewhere", "graph.db");
    process.env.ENGRAM_LOGS_DIR = join("/var", "log", "engram");

    expect(resolveWebDbPath()).toBe(join("/elsewhere", "graph.db"));
    expect(daemonDreamLogPath()).toBe(join("/var", "log", "engram", "dream.log"));
    expect(routeDreamLogPath()).toBe(daemonDreamLogPath());
    // Scratch dir still follows ENGRAM_DATA_DIR, not the log/db overrides.
    expect(resolvePendingFactsDir()).toBe(join("/tmp", "engram-contract", "tmp"));
  });

  it("agrees with loadConfig() when nothing is overridden (platform default)", () => {
    const config = loadConfig();
    expect(resolveWebDbPath()).toBe(config.dbPath);
    expect(daemonDreamLogPath()).toBe(join(config.logsDir, "dream.log"));
    expect(routeDreamLogPath()).toBe(join(config.logsDir, "dream.log"));
    expect(resolvePendingFactsDir()).toBe(join(config.dataDir, "tmp"));
  });

  it("re-resolves when the environment changes after import (no cached paths)", () => {
    process.env.ENGRAM_DATA_DIR = join("/tmp", "first");
    const first = routeDreamLogPath();
    process.env.ENGRAM_DATA_DIR = join("/tmp", "second");
    expect(routeDreamLogPath()).not.toBe(first);
    expect(resolveWebDbPath()).toBe(join("/tmp", "second", "engram.db"));
    expect(daemonDreamLogPath()).toBe(join("/tmp", "second", "logs", "dream.log"));
  });

  it("daemon resolvers accept an explicit config (runDream receives one)", () => {
    const config = loadConfig({ dataDir: join("/opt", "engram") });
    expect(daemonDreamLogPath(config)).toBe(join("/opt", "engram", "logs", "dream.log"));
    expect(resolvePendingFactsDir(config)).toBe(join("/opt", "engram", "tmp"));
  });
});
