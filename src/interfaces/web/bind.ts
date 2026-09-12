/**
 * Bind-host resolution for the web visualizer (ADR-010 hardening).
 *
 * The visualizer has no authentication, so it binds loopback by default and
 * is served through the local Caddy reverse proxy. Binding a wider interface
 * is an explicit opt-in via ENGRAM_BIND (the documented public name) or HOST
 * (the ADR-010 name); ENGRAM_BIND wins when both are set.
 */
export function getBindHost(env: Record<string, string | undefined>): string {
  for (const key of ["ENGRAM_BIND", "HOST"] as const) {
    const host = env[key]?.trim();
    if (host && host.length > 0) return host;
  }
  return "127.0.0.1";
}
