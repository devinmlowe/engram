/**
 * `show` tool helpers: slice a JSONL archive by real file line numbers and
 * render the user/assistant records as markdown.
 */

/**
 * Select lines [startLine, endLine] (1-based, inclusive end) from raw file
 * content. Blank lines are kept so the numbers match the file on disk.
 */
export function sliceShowLines(
  content: string,
  startLine?: number,
  endLine?: number,
): { lines: string[]; firstLineNum: number } {
  const allLines = content.split("\n");
  const start = startLine ? startLine - 1 : 0;
  const end = endLine ?? allLines.length;
  return { lines: allLines.slice(start, end), firstLineNum: start + 1 };
}

export function formatShowOutput(lines: string[], startLineNum: number): string {
  let output = "# Conversation\n\n";

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.type !== "user" && parsed.type !== "assistant") continue;
      if (!parsed.message?.content) continue;

      const lineNum = startLineNum + i;
      const role = parsed.type === "user" ? "User" : "Assistant";
      const timestamp = parsed.timestamp
        ? new Date(parsed.timestamp).toLocaleString()
        : "";

      output += `### ${role} (line ${lineNum}${timestamp ? `, ${timestamp}` : ""})\n\n`;

      if (typeof parsed.message.content === "string") {
        output += `${parsed.message.content}\n\n`;
      } else if (Array.isArray(parsed.message.content)) {
        for (const block of parsed.message.content) {
          if (block.type === "text" && block.text) {
            output += `${block.text}\n\n`;
          } else if (block.type === "tool_use") {
            output += `**Tool:** \`${block.name}\`\n\n`;
          }
        }
      }
    } catch {
      continue;
    }
  }

  return output;
}
