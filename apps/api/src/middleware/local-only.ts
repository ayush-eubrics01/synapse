import type { MiddlewareHandler } from "hono";

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Guards the unauthenticated loopback API against DNS rebinding and cross-site writes
 * (security-model §5).
 *
 * - `Host` must be a loopback name with the API or web port. The Next rewrite proxy
 *   (`changeOrigin: true`) rewrites Host to the API's own and passes the browser's Host in
 *   `X-Forwarded-Host`; a proxy that kept the original Host would send the web host instead.
 * - `X-Forwarded-Host`, if present, must also be one of those hosts, so a rebound name reaching
 *   the web app is rejected even though Next rewrote its Host.
 * - Non-GET/HEAD requests with an `Origin` must come from the web app or the API itself.
 */
export function localOnly(ports: { api: number; web: number }): MiddlewareHandler {
  const hosts = new Set(
    [ports.api, ports.web].flatMap((port) => LOOPBACK_NAMES.map((name) => `${name}:${port}`)),
  );
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  return async (ctx, next) => {
    const host = (ctx.req.header("host") ?? new URL(ctx.req.url).host).toLowerCase();
    const forwarded = ctx.req.header("x-forwarded-host");
    const origin = ctx.req.header("origin");
    const allowed =
      hosts.has(host) &&
      (forwarded === undefined || hosts.has(forwarded.toLowerCase())) &&
      (SAFE_METHODS.has(ctx.req.method) ||
        origin === undefined ||
        origins.has(origin.toLowerCase()));
    if (!allowed) return ctx.json({ error: "forbidden" }, 403);
    await next();
  };
}
