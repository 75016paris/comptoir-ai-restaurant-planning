import { afterEach, describe, expect, test } from "bun:test";
import { apiGet, apiPost, apiPostInternal, WhatsAppApiError } from "./api-client.js";
import type { ToolContext } from "./tools/types.js";

const ctx: ToolContext = {
  userId: "user-1",
  restaurantId: "resto-1",
  restaurantTimezone: "Europe/Paris",
  role: "manager",
  userName: "Manager",
  permissions: null,
};

const originalFetch = globalThis.fetch;
const originalSecret = process.env.WHATSAPP_INTERNAL_API_SECRET;
const originalUrl = process.env.API_INTERNAL_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.WHATSAPP_INTERNAL_API_SECRET;
  else process.env.WHATSAPP_INTERNAL_API_SECRET = originalSecret;
  if (originalUrl === undefined) delete process.env.API_INTERNAL_URL;
  else process.env.API_INTERNAL_URL = originalUrl;
});

describe("WhatsApp internal API client", () => {
  test("injects server-owned auth headers", async () => {
    process.env.WHATSAPP_INTERNAL_API_SECRET = "secret-1";
    process.env.API_INTERNAL_URL = "http://api.local/";

    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as typeof fetch;

    const result = await apiGet<{ data: { ok: boolean } }>("/me", ctx);

    expect(result).toEqual({ data: { ok: true } });
    expect(seenUrl).toBe("http://api.local/internal/whatsapp/me");
    expect(seenInit?.method).toBe("GET");
    expect((seenInit?.headers as Record<string, string>)["X-WhatsApp-Internal-Secret"]).toBe("secret-1");
    expect((seenInit?.headers as Record<string, string>)["X-Comptoir-User-Id"]).toBe("user-1");
    expect((seenInit?.headers as Record<string, string>)["X-Comptoir-Restaurant-Id"]).toBe("resto-1");
  });

  test("posts JSON bodies", async () => {
    process.env.WHATSAPP_INTERNAL_API_SECRET = "secret-1";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as typeof fetch;

    await apiPost("/pilot", { ok: true }, ctx);

    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(seenInit?.body).toBe(JSON.stringify({ ok: true }));
  });

  test("internal-only posts omit user-controlled identity header", async () => {
    process.env.WHATSAPP_INTERNAL_API_SECRET = "secret-1";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await apiPostInternal("/identity/resolve", { phone: "+336" });

    expect((seenInit?.headers as Record<string, string>)["X-WhatsApp-Internal-Secret"]).toBe("secret-1");
    expect((seenInit?.headers as Record<string, string>)["X-Comptoir-User-Id"]).toBeUndefined();
  });

  test("maps HTTP errors to typed errors", async () => {
    process.env.WHATSAPP_INTERNAL_API_SECRET = "secret-1";
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })) as unknown as typeof fetch;

    await expect(apiGet("/me", ctx)).rejects.toMatchObject({
      name: "WhatsAppApiError",
      status: 403,
      message: "Forbidden",
    });
  });

  test("rejects missing local secret before fetch", async () => {
    delete process.env.WHATSAPP_INTERNAL_API_SECRET;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(apiGet("/me", ctx)).rejects.toBeInstanceOf(WhatsAppApiError);
    expect(called).toBe(false);
  });
});
