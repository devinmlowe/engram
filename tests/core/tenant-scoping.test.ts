import { describe, it, expect } from "vitest";
import { getTenantScoping } from "../../src/interfaces/mcp/scoping.js";

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
