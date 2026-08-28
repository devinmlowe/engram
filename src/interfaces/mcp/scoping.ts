/**
 * Tenant scoping for the MCP server (ADR-010).
 *
 * A multi-tenant caller (e.g. the Hermes memory-provider plugin) scopes its
 * dedicated MCP child process via environment variables:
 *
 *   ENGRAM_SCOPE       — write scope stamped on every remember/remember_batch
 *                        (e.g. "hermes:career")
 *   ENGRAM_READ_SCOPES — comma-separated scopes recall may return; when unset
 *                        but ENGRAM_SCOPE is set, defaults to global + own.
 *
 * With neither set, behavior is identical to the single-tenant server:
 * writes land in 'global' (the column default) and reads see every scope.
 */

export interface TenantScoping {
  writeScope: string | undefined;
  readScopes: string[] | undefined;
}

export function getTenantScoping(env: Record<string, string | undefined>): TenantScoping {
  const writeScope = env.ENGRAM_SCOPE?.trim() || undefined;

  const rawRead = env.ENGRAM_READ_SCOPES?.trim();
  let readScopes: string[] | undefined;
  if (rawRead) {
    readScopes = rawRead
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (readScopes.length === 0) readScopes = undefined;
  } else if (writeScope) {
    readScopes = ["global", writeScope];
  }

  return { writeScope, readScopes };
}
