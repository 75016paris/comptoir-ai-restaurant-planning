/**
 * Simple in-memory rate limiter middleware.
 * Good enough for single-process Bun — not distributed.
 * Keyed by IP address.
 */
import { createMiddleware } from "hono/factory";

type RateLimitEntry = { count: number; resetAt: number };

export function getRateLimitIp(headers: { get(name: string): string | undefined | null }): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || "unknown";
}

export function rateLimit(opts: { windowMs: number; max: number; message?: string }) {
  const store = new Map<string, RateLimitEntry>();
  const { windowMs, max, message = "Trop de requêtes. Réessayez plus tard." } = opts;

  // Sweep expired entries every 60s to prevent memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt < now) store.delete(key);
    }
  }, 60_000);

  return createMiddleware(async (c, next) => {
    const ip = getRateLimitIp({ get: (name) => c.req.header(name) });

    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || entry.resetAt < now) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    entry.count++;
    if (entry.count > max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: message }, 429);
    }

    await next();
  });
}
