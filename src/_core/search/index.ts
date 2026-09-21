/**
 * _core/search barrel — the symbols the interfaces import through it.
 * Everything else is imported from its own module.
 */

export { escapeXml, formatRecallXml } from "./format.js";
export { searchMultiSource } from "./orchestrator.js";
export { getSessionStore } from "./session.js";
export { drillIntoResult } from "./drill.js";
