// `node --import ./module-trace.mjs <entry>`: records the URL of every module
// the process resolves into $MODULE_TRACE_FILE (one per line), from the
// loader-hooks thread, synchronously, so the list is complete at exit. The
// bridge test uses it to prove a bridged `engram mcp` never loads
// better-sqlite3, @xenova/transformers, src/_core/db or src/_core/embeddings.
import { register } from "node:module";

register(new URL("./module-trace-hooks.mjs", import.meta.url));
