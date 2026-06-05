import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getRateLimitIp, rateLimit } from "./rate-limit.js";
import { securityHeaders } from "./security-headers.js";

describe("rate limit IP resolution", () => {
  function headers(values: Record<string, string | undefined>) {
    return { get: (name: string) => values[name.toLowerCase()] };
  }

  test("prefers x-real-ip over x-forwarded-for", () => {
    expect(getRateLimitIp(headers({ "x-real-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.1, 10.0.0.1" })))
      .toBe("203.0.113.10");
  });

  test("falls back to first x-forwarded-for value", () => {
    expect(getRateLimitIp(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
  });

  test("uses unknown when IP headers are empty", () => {
    expect(getRateLimitIp(headers({ "x-real-ip": "  ", "x-forwarded-for": "  " }))).toBe("unknown");
  });
});

describe("security headers", () => {
  test("sets browser hardening headers", async () => {
    const app = new Hono();
    app.use("*", securityHeaders);
    app.get("/health", (c) => c.text("ok"));

    const res = await app.request("/health");

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });
});

describe("rateLimit middleware", () => {
  test("returns 429 after the limit is exceeded", async () => {
    const app = new Hono();
    app.use("*", rateLimit({ windowMs: 60_000, max: 1, message: "limited" }));
    app.get("/public", (c) => c.text("ok"));

    const headers = { "x-real-ip": "203.0.113.20" };
    expect((await app.request("/public", { headers })).status).toBe(200);
    const limited = await app.request("/public", { headers });

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "limited" });
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
