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
 *
 * Per-request override: a shared HTTP daemon serves every Hermes profile from
 * one process, so the env alone cannot distinguish tenants. Tool calls may
 * pass `scope` / `read_scopes` params; `resolveCallScoping` applies them on
 * top of the env defaults for that single call.
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

/** Optional per-call overrides carried in tool arguments. */
export interface CallScopeParams {
  /** Write scope for this call (also the tenant identity for read defaults). */
  scope?: string;
  /** Explicit read scopes for this call. */
  read_scopes?: string[];
}

/**
 * Validate one scope string the same way the env path does (trimmed,
 * non-empty). Throws with the param name so the MCP error is actionable.
 */
function requireScope(value: string, param: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    throw new Error(`${param} must be a non-empty scope string (e.g. "hermes:career")`);
  }
  return trimmed;
}

/**
 * Resolve the scoping for a single tool call: request params win over env,
 * env is the default when params are absent.
 *
 * - `scope` overrides ENGRAM_SCOPE. When ENGRAM_READ_SCOPES is unset it also
 *   re-derives the read default to global + own, mirroring the env rule.
 * - `read_scopes` overrides ENGRAM_READ_SCOPES (and the derived default).
 *
 * #108: the env is a ceiling, never a default the client may raise. When the
 * env restricts reads, `read_scopes` is intersected with it (empty → throw)
 * and `scope` must be one of the readable scopes (write only where you may
 * read). With no env restriction the params are the only tenant identity
 * (shared HTTP daemon) and apply as given.
 */
export function resolveCallScoping(
  env: Record<string, string | undefined>,
  params: CallScopeParams,
): TenantScoping {
  const base = getTenantScoping(env);

  const writeScope = params.scope !== undefined ? requireScope(params.scope, "scope") : base.writeScope;

  const allowed = base.readScopes;
  if (allowed && writeScope !== undefined && params.scope !== undefined && !allowed.includes(writeScope)) {
    throw new Error(`scope "${writeScope}" is outside this server's read scopes (${allowed.join(", ")})`);
  }

  let readScopes = allowed;
  if (params.read_scopes !== undefined) {
    if (!Array.isArray(params.read_scopes) || params.read_scopes.length === 0) {
      throw new Error("read_scopes must contain at least one scope");
    }
    readScopes = params.read_scopes.map((s) => requireScope(s, "read_scopes"));
    if (allowed) {
      readScopes = readScopes.filter((s) => allowed.includes(s));
      if (readScopes.length === 0) {
        throw new Error(`read_scopes has no scope in common with this server's read scopes (${allowed.join(", ")})`);
      }
    }
  } else if (params.scope !== undefined && !env.ENGRAM_READ_SCOPES?.trim()) {
    readScopes = ["global", writeScope as string];
  }

  return { writeScope, readScopes };
}
