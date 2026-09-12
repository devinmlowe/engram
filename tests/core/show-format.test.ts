import { describe, it, expect } from "vitest";
import { sliceShowLines, formatShowOutput } from "../../src/interfaces/mcp/show-format.js";

const rec = (type: string, text: string) =>
  JSON.stringify({ type, message: { content: text } });

// Line numbers:            1            2   3                4   5
const CONTENT = [rec("user", "first"), "", rec("assistant", "second"), "", rec("user", "third")].join("\n");

describe("show line slicing", () => {
  it("reports real file line numbers even when the archive has blank lines", () => {
    const { lines, firstLineNum } = sliceShowLines(CONTENT, 3, 5);
    expect(firstLineNum).toBe(3);
    const out = formatShowOutput(lines, firstLineNum);
    expect(out).toContain("### Assistant (line 3)");
    expect(out).toContain("### User (line 5)");
    expect(out).not.toContain("first");
  });

  it("startLine addresses the same record as the file's line number", () => {
    const { lines, firstLineNum } = sliceShowLines(CONTENT, 5, 5);
    const out = formatShowOutput(lines, firstLineNum);
    expect(out).toContain("third");
    expect(out).not.toContain("second");
  });

  it("defaults to the whole file and skips blank/non-record lines", () => {
    const { lines, firstLineNum } = sliceShowLines(CONTENT);
    expect(lines).toHaveLength(5);
    const out = formatShowOutput(lines, firstLineNum);
    expect(out.match(/^### /gm)).toHaveLength(3);
  });
});
