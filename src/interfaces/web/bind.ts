/**
 * Bind-host resolution for the web visualizer (ADR-010 hardening).
 *
 * The visualizer has no authentication, so it binds loopback by default and
 * is served through the local Caddy reverse proxy. Binding a wider interface
 * is an explicit opt-in via the HOST environment variable.
 */
export function getBindHost(env: Record<string, string | undefined>): string {
  const host = env.HOST?.trim();
  return host && host.length > 0 ? host : "127.0.0.1";
}
