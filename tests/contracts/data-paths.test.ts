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
 * The web server now reads loadConfig().dbPath directly and the web dream
 * route imports the daemon's resolveDreamLogPath (#122), so agreement holds
 * by construction. These tests pin the daemon resolvers themselves under
 * ENGRAM_DATA_DIR, under the explicit ENGRAM_LOGS_DIR override, with no
 * overrides at all, and with an explicit config.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { loadConfig } from "../../src/_core/config/index.js";
import { resolveDreamLogPath, resolvePendingFactsDir } from "../../src/dream/daemon.js";

const MANAGED = ["XDG_DATA_HOME", "LOCALAPPDATA"];
const isManaged = (key: string) => key.startsWith("ENGRAM_") || MANAGED.includes(key);

describe("Data Path Agreement Contract", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) if (isManaged(key)) vi.stubEnv(key, undefined);
  });

  it("dream daemon paths follow ENGRAM_DATA_DIR and re-resolve when it changes", () => {
    vi.stubEnv("ENGRAM_DATA_DIR", join("/tmp", "engram-contract"));
    const config = loadConfig();

    expect(resolveDreamLogPath()).toBe(join(config.logsDir, "dream.log"));
    expect(resolveDreamLogPath()).toBe(join("/tmp", "engram-contract", "logs", "dream.log"));
    expect(resolvePendingFactsDir()).toBe(join("/tmp", "engram-contract", "tmp"));

    // Resolved per call, not cached at import
    vi.stubEnv("ENGRAM_DATA_DIR", join("/tmp", "second"));
    expect(resolveDreamLogPath()).toBe(join("/tmp", "second", "logs", "dream.log"));
  });

  it("explicit ENGRAM_LOGS_DIR is honored; the scratch dir still follows ENGRAM_DATA_DIR", () => {
    vi.stubEnv("ENGRAM_DATA_DIR", join("/tmp", "engram-contract"));
    vi.stubEnv("ENGRAM_DB_PATH", join("/elsewhere", "graph.db"));
    vi.stubEnv("ENGRAM_LOGS_DIR", join("/var", "log", "engram"));

    expect(resolveDreamLogPath()).toBe(join("/var", "log", "engram", "dream.log"));
    expect(resolvePendingFactsDir()).toBe(join("/tmp", "engram-contract", "tmp"));
  });

  it("agrees with loadConfig() when nothing is overridden (platform default)", () => {
    const config = loadConfig();
    expect(resolveDreamLogPath()).toBe(join(config.logsDir, "dream.log"));
    expect(resolvePendingFactsDir()).toBe(join(config.dataDir, "tmp"));
  });

  it("daemon resolvers accept an explicit config (runDream receives one)", () => {
    const config = loadConfig({ dataDir: join("/opt", "engram") });
    expect(resolveDreamLogPath(config)).toBe(join("/opt", "engram", "logs", "dream.log"));
    expect(resolvePendingFactsDir(config)).toBe(join("/opt", "engram", "tmp"));
  });
});
