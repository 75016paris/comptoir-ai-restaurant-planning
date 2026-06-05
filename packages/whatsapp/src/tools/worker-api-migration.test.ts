import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "./types.js";

process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
process.env.API_INTERNAL_URL = "http://api.local";

const { WORKER_TOOLS } = await import("./worker.js");

const originalFetch = globalThis.fetch;
const originalSecret = process.env.WHATSAPP_INTERNAL_API_SECRET;
const originalUrl = process.env.API_INTERNAL_URL;

const ctx: ToolContext = {
  userId: "worker-1",
  restaurantId: "resto-1",
  restaurantTimezone: "Europe/Paris",
  role: "floor",
  userName: "Worker One",
  permissions: null,
};

function tool(name: string) {
  const found = WORKER_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.WHATSAPP_INTERNAL_API_SECRET;
  else process.env.WHATSAPP_INTERNAL_API_SECRET = originalSecret;
  if (originalUrl === undefined) delete process.env.API_INTERNAL_URL;
  else process.env.API_INTERNAL_URL = originalUrl;
});

describe("worker tools migrated to internal API", () => {
  test("my_schedule fetches own schedule from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { from: "2026-05-04", to: "2026-05-10", services: [{ date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor", hours: 4, zone: "Midi" }], totalHours: 4 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("my_schedule").execute({ date: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/schedule?date=2026-05-04"]);
    expect(output).toBe("Lundi 2026-05-04 — 10:00-14:00 (4h, Midi)\n\nTotal: 1 jour, 4h");
  });

  test("my_schedule groups multi-restaurant services by restaurant", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: {
      from: "2026-05-04",
      to: "2026-05-10",
      services: [
        { date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor", hours: 4, zone: "Midi", restaurantName: "Chez Reno" },
        { date: "2026-05-05", startTime: "18:00", endTime: "23:00", role: "floor", hours: 5, zone: "Soir", restaurantName: "La civette" },
      ],
      totalHours: 9,
    } }), { status: 200 })) as unknown as typeof fetch;

    const output = await tool("my_schedule").execute({ date: "2026-05-04" }, ctx);

    expect(output).toContain("*Chez Reno:*\nLundi 2026-05-04 — 10:00-14:00 (4h, Midi)");
    expect(output).toContain("*La civette:*\nMardi 2026-05-05 — 18:00-23:00 (5h, Soir)");
    expect(output).toContain("Total: 2 jours, 9h");
  });

  test("my_next_service fetches own next service from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { service: { date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor", zone: "Midi" } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("my_next_service").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/next-service"]);
    expect(output).toBe("Prochain service: Lundi 2026-05-04, 10:00-14:00 (Midi, service)");
  });

  test("my_hours fetches own hours from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { serviceCount: 2, totalHours: 8.5 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("my_hours").execute({ month: "2026-05" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/hours?month=2026-05"]);
    expect(output).toBe("mai 2026: 2 services, 8.5h travaillées.");
  });

  test("clock_in posts to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { tapIn: "2026-05-04T08:00:00.000Z" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const output = await tool("clock_in").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/clock-in"]);
    expect(output).toContain("Pointé à");
    expect(output).toContain("Bon service");
  });

  test("clock_out maps API errors to worker-facing copy", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Tu n'es pas pointé(e) actuellement." }), { status: 400 })) as unknown as typeof fetch;

    const output = await tool("clock_out").execute({}, ctx);

    expect(output).toBe("Tu n'es pas pointé(e) actuellement.");
  });

  test("my_pending_replacements fetches replacement state from the internal API", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { sent: [{ service: { date: "2026-05-04", startTime: "10:00", endTime: "14:00" }, phase: "en attente du gérant" }], received: [] } }), { status: 200 })) as unknown as typeof fetch;

    const output = await tool("my_pending_replacements").execute({}, ctx);

    expect(output).toBe("Envoyée: 2026-05-04 (10:00-14:00) — en attente du gérant");
  });

  test("respond_replacement posts decision to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ decision: "accepted" }));
      return new Response(JSON.stringify({ data: { decision: "accepted", requesterName: "Alice", service: { date: "2026-05-04" } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("respond_replacement").execute({ decision: "accepted" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/replacements/respond"]);
    expect(output).toBe("✅ Remplacement accepté ! Le service du *Lundi 2026-05-04* de *Alice* t'est maintenant assigné.");
  });

  test("report_unavailable prompt fetches own schedule from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { services: [{ id: "svc-1", date: "2099-05-04", startTime: "10:00", endTime: "14:00", role: "floor" }] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("report_unavailable").execute({ service_date: "2099-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/schedule?date=2099-05-04"]);
    expect(output).toBe("Prévenir le gérant que tu peux pas venir le Lundi 2099-05-04 (10:00-14:00) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.");
  });

  test("report_unavailable confirmation posts to the internal API", async () => {
    const { getHandler } = await import("./confirmation.js");
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { replacementId: "repl-1" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const handler = getHandler("report_unavailable_confirmed");
    if (!handler) throw new Error("missing report unavailable handler");
    const output = await handler({ requesterServiceId: "svc-1", date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/replacements/report-unavailable"]);
    expect(output).toContain("J'ai prévenu le gérant");
  });

  test("my_holidays fetches own holidays from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { holidays: [{ startDate: "2026-05-04", endDate: "2026-05-06", status: "pending", reason: "vacances" }] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("my_holidays").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/holidays"]);
    expect(output).toBe("Lundi 2026-05-04 → Mercredi 2026-05-06: ⏳ En attente (vacances)");
  });

  test("my_preferences fetches own preferences from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { contractHours: 35, maxWeeklyHours: 42, coupureWilling: true, slots: [{ dayOfWeek: 1, midi: true, soir: false }] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("my_preferences").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/preferences"]);
    expect(output).toContain("• Heures max / semaine : *42h* (contrat : 35h)");
    expect(output).toContain("• Coupures acceptées : ✅ oui");
    expect(output).toContain("• Lundi : < 14h");
  });

  test("update_preferences confirmation posts to the internal API", async () => {
    const { getHandler } = await import("./confirmation.js");
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ maxWeeklyHours: 42, coupureWilling: true, slotsByDay: { monday: { midi: true } } }));
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const handler = getHandler("update_preferences_confirmed");
    if (!handler) throw new Error("missing preferences handler");
    const output = await handler({ maxWeeklyHours: 42, coupureWilling: true, slotsByDay: { monday: { midi: true } } }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/preferences"]);
    expect(output).toBe("Préférences mises à jour. ✅");
  });

  test("claim_open_shift posts to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { date: "2026-05-04", startTime: "10:00", endTime: "14:00" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("claim_open_shift").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/open-shifts/claim"]);
    expect(output).toBe("C'est noté ! Service confirmé le 2026-05-04 de 10:00 à 14:00. Le gérant est prévenu.");
  });

  test("claim_open_shift maps API errors to worker-facing copy", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Aucun service ouvert ne t'attend pour l'instant." }), { status: 404 })) as unknown as typeof fetch;

    const output = await tool("claim_open_shift").execute({}, ctx);

    expect(output).toBe("Aucun service ouvert ne t'attend pour l'instant.");
  });

  test("decline_open_shift posts to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { date: "2026-05-04", startTime: "10:00", endTime: "14:00" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("decline_open_shift").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/open-shifts/decline"]);
    expect(output).toBe("C'est noté, j'ai prévenu le gérant que tu refuses le service du 2026-05-04 10:00-14:00.");
  });

  test("request_holiday confirmation posts to the internal API", async () => {
    const { getHandler } = await import("./confirmation.js");
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ startDate: "2026-05-04", endDate: "2026-05-06", reason: "vacances" }));
      return new Response(JSON.stringify({ data: { isMedical: false } }), { status: 201 });
    }) as unknown as typeof fetch;

    const handler = getHandler("request_holiday_confirmed");
    if (!handler) throw new Error("missing holiday handler");
    const output = await handler({ startDate: "2026-05-04", endDate: "2026-05-06", reason: "vacances", days: 3 }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/me/holidays"]);
    expect(output).toBe("Demande de congé envoyée: Lundi 2026-05-04 → Mercredi 2026-05-06 (3 jours). En attente de validation par ton responsable.");
  });
});
