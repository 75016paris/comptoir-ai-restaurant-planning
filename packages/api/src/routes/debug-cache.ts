import { Hono } from "hono";
import { getCacheSnapshot } from "../services/baseline-cache.js";

export const debugCacheRoutes = new Hono();

/**
 * GET /debug/baseline-cache
 * Dev-only introspection of the multi-week solver LRU. 404s in production so
 * the route does not leak cache keys / timings.
 */
debugCacheRoutes.get("/", (c) => {
  if (process.env.NODE_ENV === "production") {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ entries: getCacheSnapshot() });
});
