import { afterEach, describe, expect, test } from "bun:test";
import { resolveIdentity } from "./identity.js";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.WHATSAPP_INTERNAL_API_SECRET;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.WHATSAPP_INTERNAL_API_SECRET;
  else process.env.WHATSAPP_INTERNAL_API_SECRET = originalSecret;
});

describe("resolveIdentity", () => {
  test("passes selected restaurant context to the internal identity endpoint", async () => {
    process.env.WHATSAPP_INTERNAL_API_SECRET = "secret-1";
    let seenBody = "";
    globalThis.fetch = (async (_url, init) => {
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        ok: true,
        identity: {
          userId: "user-1",
          name: "Admin",
          role: "admin",
          restaurantId: "resto-2",
          restaurantName: "Resto 2",
          restaurantTimezone: "Europe/Paris",
          phone: "+336",
          permissions: null,
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await resolveIdentity("+336", "resto-2");

    expect(JSON.parse(seenBody)).toEqual({ phone: "+336", restaurantId: "resto-2" });
    expect(result).toMatchObject({ ok: true, identity: { restaurantId: "resto-2" } });
  });
});
