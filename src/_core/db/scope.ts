/**
 * Tenant-scope helpers shared by every scoped table (#25).
 *
 * Rows carry `scope` ('global' or e.g. 'hermes:career'). A read with
 * `scopes` set sees only rows whose scope is in the list; without it, every
 * scope (single-tenant behaviour). Graph rows are shared knowledge: an
 * entity or edge first seen from one profile and later from another is
 * *widened* to 'global' rather than duplicated per tenant.
 */
import type Database from "better-sqlite3";

export const GLOBAL_SCOPE = "global";

export function scopeVisible(rowScope: string | null | undefined, scopes?: readonly string[]): boolean {
  if (!scopes || scopes.length === 0) return true;
  return scopes.includes(rowScope ?? GLOBAL_SCOPE);
}

/** `col IN (?, ?)` fragment + params, or null when unfiltered. */
export function scopeInClause(col: string, scopes?: readonly string[]): { sql: string; params: string[] } | null {
  if (!scopes || scopes.length === 0) return null;
  return { sql: `${col} IN (${scopes.map(() => "?").join(", ")})`, params: [...scopes] };
}

/**
 * A graph row seen again from a different scope becomes global. No-op when
 * the scopes agree or the row is already global. Returns true when widened.
 */
export function widenScope(
  db: Database.Database,
  table: "entities" | "relationships",
  id: string,
  seenFrom: string | undefined,
): boolean {
  const from = seenFrom ?? GLOBAL_SCOPE;
  const r = db
    .prepare(`UPDATE ${table} SET scope = '${GLOBAL_SCOPE}' WHERE id = ? AND scope IS NOT NULL AND scope != ? AND scope != '${GLOBAL_SCOPE}'`)
    .run(id, from);
  return r.changes > 0;
}
