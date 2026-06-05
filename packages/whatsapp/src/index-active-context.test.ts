import { afterEach, describe, expect, test } from "bun:test";

process.env.DEMO_CHAT_SECRET = "demo-chat-secret";
process.env.WHATSAPP_INTERNAL_API_SECRET = "internal-secret";
process.env.API_INTERNAL_URL = "http://api.test";

const app = (await import("./index.js")).default;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("demo chat active restaurant context", () => {
  test("GET /chat/notifications resolves identity with the selected restaurant", async () => {
    const seenBodies: unknown[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seenBodies.push(body);
      if (body?.phone) {
        return new Response(JSON.stringify({
          ok: true,
            identity: {
              userId: "worker-a",
              restaurantId: body.restaurantId,
              role: "floor",
              permissions: null,
              name: "Worker A",
              restaurantName: "Demo A",
              restaurantTimezone: "Europe/Paris",
              phone: body.phone,
            },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: { notifications: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await app.fetch(new Request(
      "http://whatsapp.test/chat/notifications?phone=%2B33600000002&since=2026-05-21T10%3A00%3A00.000Z&restaurantId=demo-a",
      { headers: { "x-demo-secret": "demo-chat-secret" } },
    ));

    expect(res.status).toBe(200);
    expect(seenBodies[0]).toEqual({ phone: "+33600000002", restaurantId: "demo-a" });
    expect(seenBodies[1]).toEqual({ userId: "worker-a", since: "2026-05-21T10:00:00.000Z" });
  });

  test("POST /chat/clear resolves identity with the selected restaurant", async () => {
    const seenBodies: unknown[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seenBodies.push(body);
      if (body?.phone) {
        return new Response(JSON.stringify({
          ok: true,
          identity: {
            userId: "worker-a",
            restaurantId: body.restaurantId,
            role: "floor",
            permissions: null,
            name: "Worker A",
            restaurantName: "Demo A",
            restaurantTimezone: "Europe/Paris",
            phone: body.phone,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await app.fetch(new Request("http://whatsapp.test/chat/clear", {
      method: "POST",
      headers: { "x-demo-secret": "demo-chat-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33600000002", restaurantId: "demo-a" }),
    }));

    expect(res.status).toBe(200);
    expect(seenBodies[0]).toEqual({ phone: "+33600000002", restaurantId: "demo-a" });
    expect(seenBodies[1]).toEqual({ userId: "worker-a" });
  });
});
