import { describe, it, expect } from "vitest";
import { getBindHost } from "../../src/interfaces/web/bind.js";

// ADR-010 hardening: the visualizer is unauthenticated, so it must bind
// loopback by default and sit behind the Caddy reverse proxy. Exposure is
// an explicit opt-in via HOST.
describe("visualizer bind host", () => {
  it("defaults to 127.0.0.1", () => {
    expect(getBindHost({})).toBe("127.0.0.1");
  });

  it("honors an explicit HOST override", () => {
    expect(getBindHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("treats an empty HOST as unset", () => {
    expect(getBindHost({ HOST: "  " })).toBe("127.0.0.1");
  });
});
