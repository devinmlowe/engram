import { describe, it, expect } from "vitest";
import { getTenantScoping, resolveCallScoping } from "../../src/interfaces/mcp/scoping.js";

// ADR-010: the Hermes plugin scopes its MCP child via env —
// ENGRAM_SCOPE (write scope) and ENGRAM_READ_SCOPES (comma list).
describe("getTenantScoping (ADR-010)", () => {
  it("returns undefined scoping when env is unset (single-tenant behavior)", () => {
    const s = getTenantScoping({});
    expect(s.writeScope).toBeUndefined();
    expect(s.readScopes).toBeUndefined();
  });

  it("ENGRAM_SCOPE sets writeScope and defaults readScopes to global + own", () => {
    const s = getTenantScoping({ ENGRAM_SCOPE: "hermes:career" });
    expect(s.writeScope).toBe("hermes:career");
    expect(s.readScopes).toEqual(["global", "hermes:career"]);
  });

  it("ENGRAM_READ_SCOPES overrides the default read scopes", () => {
    const s = getTenantScoping({
      ENGRAM_SCOPE: "hermes:career",
      ENGRAM_READ_SCOPES: "global,hermes:career,hermes:pmp",
    });
    expect(s.readScopes).toEqual(["global", "hermes:career", "hermes:pmp"]);
  });

  it("ENGRAM_READ_SCOPES alone restricts reads without a write scope", () => {
    const s = getTenantScoping({ ENGRAM_READ_SCOPES: "global" });
    expect(s.writeScope).toBeUndefined();
    expect(s.readScopes).toEqual(["global"]);
  });

  it("trims whitespace and drops empty entries", () => {
    const s = getTenantScoping({ ENGRAM_READ_SCOPES: " global , ,hermes:finance " });
    expect(s.readScopes).toEqual(["global", "hermes:finance"]);
  });

  it("empty-string env vars are treated as unset", () => {
    const s = getTenantScoping({ ENGRAM_SCOPE: "", ENGRAM_READ_SCOPES: "" });
    expect(s.writeScope).toBeUndefined();
    expect(s.readScopes).toBeUndefined();
  });
});

// Per-request overrides (W1): tool params `scope` / `read_scopes` win over the
// env defaults for that call only; absent params fall back to env behavior.
describe("resolveCallScoping (per-request override)", () => {
  it("no params → identical to env-derived scoping", () => {
    expect(resolveCallScoping({}, {})).toEqual(getTenantScoping({}));
    const env = { ENGRAM_SCOPE: "hermes:career", ENGRAM_READ_SCOPES: "global,hermes:pmp" };
    expect(resolveCallScoping(env, {})).toEqual(getTenantScoping(env));
  });

  it("scope param sets writeScope and defaults readScopes to global + own when env has none", () => {
    const s = resolveCallScoping({}, { scope: "hermes:career" });
    expect(s.writeScope).toBe("hermes:career");
    expect(s.readScopes).toEqual(["global", "hermes:career"]);
  });

  it("scope param overrides ENGRAM_SCOPE within an explicit ENGRAM_READ_SCOPES", () => {
    const env = { ENGRAM_SCOPE: "hermes:pmp", ENGRAM_READ_SCOPES: "global,hermes:pmp,hermes:career" };
    const s = resolveCallScoping(env, { scope: "hermes:career" });
    expect(s.writeScope).toBe("hermes:career");
    expect(s.readScopes).toEqual(["global", "hermes:pmp", "hermes:career"]);
  });

  it("read_scopes param narrows env read scopes and leaves writeScope alone", () => {
    const env = { ENGRAM_SCOPE: "hermes:pmp", ENGRAM_READ_SCOPES: "global,hermes:pmp,hermes:career" };
    const s = resolveCallScoping(env, { read_scopes: [" hermes:career "] });
    expect(s.writeScope).toBe("hermes:pmp");
    expect(s.readScopes).toEqual(["hermes:career"]);
  });

  // #108: an env-pinned child (Hermes stdio) must not be widened by tool args.
  it("read_scopes outside the env ceiling are dropped; none left → throws", () => {
    const env = { ENGRAM_SCOPE: "hermes:pmp" }; // reads default to global + own
    expect(resolveCallScoping(env, { read_scopes: ["hermes:career", "global"] }).readScopes).toEqual(["global"]);
    expect(() => resolveCallScoping(env, { read_scopes: ["hermes:career"] })).toThrow(/no scope in common/);
  });

  it("scope outside the env read scopes throws (write only where you may read)", () => {
    const env = { ENGRAM_SCOPE: "hermes:pmp", ENGRAM_READ_SCOPES: "global,hermes:pmp" };
    expect(() => resolveCallScoping(env, { scope: "hermes:career" })).toThrow(/outside this server's read scopes/);
    expect(resolveCallScoping(env, { scope: "global" }).writeScope).toBe("global");
  });

  it("with no env restriction the params apply as given (shared HTTP daemon)", () => {
    const s = resolveCallScoping({}, { scope: "hermes:career", read_scopes: ["hermes:pmp"] });
    expect(s.writeScope).toBe("hermes:career");
    expect(s.readScopes).toEqual(["hermes:pmp"]);
  });

  it("rejects empty / whitespace scope strings and empty read_scopes", () => {
    expect(() => resolveCallScoping({}, { scope: "" })).toThrow(/scope/);
    expect(() => resolveCallScoping({}, { scope: "   " })).toThrow(/scope/);
    expect(() => resolveCallScoping({}, { read_scopes: [] })).toThrow(/read_scopes/);
    expect(() => resolveCallScoping({}, { read_scopes: ["global", " "] })).toThrow(/read_scopes/);
  });
});
