// Loader hooks for module-trace.mjs (run on the hooks thread).
import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const file = process.env.MODULE_TRACE_FILE;
  if (file && result?.url) {
    try { appendFileSync(file, `${result.url}\n`); } catch { /* tracing must never fail the traced process */ }
  }
  return result;
}
