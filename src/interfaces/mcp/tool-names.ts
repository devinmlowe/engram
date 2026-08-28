/**
 * Names of the tools the MCP server registers (see server.ts ListTools).
 * Kept side-effect free so the CLI can report them without importing the
 * server module, which connects to stdio on load. A test pins this list
 * against the server source.
 */
export const MCP_TOOL_NAMES = [
  "recall",
  "remember",
  "remember_batch",
  "show",
  "explore",
  "reflect",
  "recall_session",
  "recall_drill",
  "explore_selective",
  "fetch_snippets",
  "scan_file",
  "index_file_structure",
] as const;
