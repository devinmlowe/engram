/**
 * Dynamic `UPDATE … SET` fragments for partial updates.
 */

/**
 * `SET` assignments and bound values for every column whose value is not
 * `undefined` (a `null` binds SQL NULL), in the object's key order.
 */
export function buildUpdate(columns: Record<string, unknown>): { set: string[]; values: unknown[] } {
  const set: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    set.push(`${column} = ?`);
    values.push(value);
  }
  return { set, values };
}
