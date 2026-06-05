import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-wa-admin-api-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
process.env.API_INTERNAL_URL = "http://api.local";

const { ADMIN_TOOLS } = await import("./admin.js");
const { getHandler } = await import("./confirmation.js");

const originalFetch = globalThis.fetch;
const originalSecret = process.env.WHATSAPP_INTERNAL_API_SECRET;
const originalUrl = process.env.API_INTERNAL_URL;

const ctx: ToolContext = {
  userId: "manager-1",
  restaurantId: "resto-1",
  restaurantTimezone: "Europe/Paris",
  role: "manager",
  userName: "Manager",
  permissions: JSON.stringify({ TEAM_VIEW: true, HOURS_VIEW: true }),
};

function tool(name: string) {
  const found = ADMIN_TOOLS.find((t) => t.name === name);
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

describe("admin tools migrated to internal API", () => {
  test("list_team formats team data returned by the API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        data: {
          members: [
            { id: "w1", name: "Alice Chef", role: "kitchen", priority: 1, subRoles: JSON.stringify(["Chef"]), contractHours: 35, active: true },
            { id: "w2", name: "Bob Salle", role: "floor", priority: 2, subRoles: "[]", contractHours: 35, active: true },
          ],
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("list_team").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/team"]);
    expect(output).toContain("*Cuisine (1):*");
    expect(output).toContain("P1 Alice Chef 👑");
    expect(output).toContain("*Salle (1):*");
    expect(output).toContain("P2 Bob Salle");
  });

  test("list_closures fetches closures from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { today: "2099-05-01", closures: [{ startDate: "2099-05-01", endDate: "2099-05-02", reason: "travaux" }] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("list_closures").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/closures"]);
    expect(output).toBe("*Fermetures à venir:*\n  2099-05-01 → 2099-05-02 (travaux) ← EN COURS");
  });

  test("add_closure confirmation posts to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ startDate: "2099-05-01", endDate: "2099-05-02", reason: "travaux" }));
      return new Response(JSON.stringify({ data: { id: "closure-1" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const handler = getHandler("add_closure_confirmed");
    if (!handler) throw new Error("missing closure handler");
    const output = await handler({ startDate: "2099-05-01", endDate: "2099-05-02", reason: "travaux" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/closures"]);
    expect(output).toBe("Fermeture ajoutée: 2099-05-01 → 2099-05-02. ✅");
  });

  test("check_weather fetches weather from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { date: "2026-05-04", weather: { weatherCode: 1, tempMin: 12, tempMax: 21, sunrise: "2026-05-04T06:30:00", sunset: "2026-05-04T21:15:00", normalTempMax: 17 } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("check_weather").execute({ date: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/weather?date=2026-05-04"]);
    expect(output).toContain("*Météo Lundi 2026-05-04:*");
    expect(output).toContain("🌤️ Peu nuageux");
    expect(output).toContain("📊 +4°C vs normale saisonnière");
  });

  test("check_calendar fetches calendar events from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { label: "mai 2026", events: [
        { type: "public_holiday", date: "2026-05-01", endDate: null, name: "Fête du Travail" },
        { type: "school_vacation", date: "2026-05-10", endDate: "2026-05-20", name: "Vacances" },
      ] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("check_calendar").execute({ month: "2026-05" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/calendar?month=2026-05"]);
    expect(output).toContain("*Calendrier mai 2026:*");
    expect(output).toContain("🔴 Vendredi 2026-05-01 — Fête du Travail");
    expect(output).toContain("🔵 Vacances (→ 2026-05-20)");
  });

  test("check_revenue remains hidden from the admin manifest until CA tools ship", () => {
    expect(ADMIN_TOOLS.some((t) => t.name === "check_revenue")).toBe(false);
  });

  test("log_revenue confirmation posts to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ date: "2026-05-04", amount: 123400 }));
      return new Response(JSON.stringify({ data: { id: "rev-1" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const handler = getHandler("log_revenue_confirmed");
    if (!handler) throw new Error("missing log revenue handler");
    const output = await handler({ date: "2026-05-04", amount: 123400 }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/revenue"]);
    expect(output).toBe("CA enregistré: 1 234€ le 2026-05-04. ✅");
  });

  test("review_holiday resolves worker and fetches pending request from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("/workers/resolve")) {
        return new Response(JSON.stringify({ data: { worker: { id: "worker-1", name: "Alice Martin", role: "floor", priority: 1, subRoles: "[]", contractHours: 35, active: true } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { request: { id: "hol-1", startDate: "2099-07-01", endDate: "2099-07-02" } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("review_holiday").execute({ worker_name: "Alice", decision: "approved" }, ctx);

    expect(urls).toEqual([
      "http://api.local/internal/whatsapp/workers/resolve?name=Alice&scope=leave",
      "http://api.local/internal/whatsapp/workers/worker-1/holidays/pending/latest",
    ]);
    expect(output).toContain("Approuver le congé de *Alice Martin*");
  });

  test("review_holiday stops when leave-scoped worker resolution fails", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: "worker_not_found", team: ["Alice Martin"] }), { status: 404 });
    }) as unknown as typeof fetch;

    const output = await tool("review_holiday").execute({ worker_name: "Shared", decision: "approved" }, ctx);

    expect(urls).toEqual([
      "http://api.local/internal/whatsapp/workers/resolve?name=Shared&scope=leave",
    ]);
    expect(output).toBe('Employé "Shared" non trouvé. Équipe: Alice Martin');
  });

  test("review_holiday confirmation posts to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ decision: "rejected" }));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const handler = getHandler("review_holiday_confirmed");
    if (!handler) throw new Error("missing review holiday handler");
    const output = await handler({ requestId: "hol-1", decision: "rejected", workerName: "Alice Martin", startDate: "2099-07-01", endDate: "2099-07-02" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/holidays/hol-1/review"]);
    expect(output).toBe("Congé de *Alice Martin* (2099-07-01 → 2099-07-02) refusé ❌.");
  });

  test("add_worker_holiday resolves workers through leave scope before prompting", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        data: { worker: { id: "worker-1", name: "Alice Martin", role: "floor", priority: 1, subRoles: "[]", contractHours: 35, active: true } },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("add_worker_holiday").execute({
      worker_name: "Alice",
      start_date: "2099-08-01",
      end_date: "2099-08-03",
      reason: "repos",
    }, ctx);

    expect(urls).toEqual([
      "http://api.local/internal/whatsapp/workers/resolve?name=Alice&scope=leave",
    ]);
    expect(output).toContain("Enregistrer une absence pour *Alice Martin*");
  });

  test("add_worker_holiday stops when leave-scoped worker resolution fails", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: "worker_not_found", team: ["Alice Martin"] }), { status: 404 });
    }) as unknown as typeof fetch;

    const output = await tool("add_worker_holiday").execute({
      worker_name: "Shared",
      start_date: "2099-08-01",
      end_date: "2099-08-03",
    }, ctx);

    expect(urls).toEqual([
      "http://api.local/internal/whatsapp/workers/resolve?name=Shared&scope=leave",
    ]);
    expect(output).toBe('Employé "Shared" non trouvé. Équipe: Alice Martin');
  });

  test("add_worker_holiday confirmation posts to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ startDate: "2099-08-01", endDate: "2099-08-03", reason: "repos" }));
      return new Response(JSON.stringify({ data: { id: "hol-2" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const handler = getHandler("add_worker_holiday_confirmed");
    if (!handler) throw new Error("missing add worker holiday handler");
    const output = await handler({ workerId: "worker-1", workerName: "Alice Martin", startDate: "2099-08-01", endDate: "2099-08-03", reason: "repos", days: 3 }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/workers/worker-1/holidays"]);
    expect(output).toContain("Absence enregistrée pour *Alice Martin*");
  });

  test("pending_requests fetches pending requests from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: {
        holidays: [{ workerName: "Alice", startDate: "2026-05-20", endDate: "2026-05-22", reason: "vacances" }],
        replacements: [{ requesterName: "Bob", message: null, status: "awaiting_worker_reply" }],
      } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("pending_requests").execute({}, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/requests/pending"]);
    expect(output).toContain("*Congés en attente (1):*");
    expect(output).toContain("Alice: 2026-05-20 → 2026-05-22 (vacances)");
    expect(output).toContain("*Remplacements en attente (1):*");
    expect(output).toContain("Bob: (pas de message) — _proposé, en attente du collègue_");
  });

  test("team_schedule fetches team planning from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: {
        from: "2026-05-04",
        to: "2026-05-10",
        zones: ["Midi", "Soir"],
        closures: [],
        services: [
          { date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor", workerName: "Alice", hours: 4, zone: "Midi" },
          { date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "kitchen", workerName: "Bob", hours: 4, zone: "Midi" },
        ],
        totalHours: 8,
      } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("team_schedule").execute({ date: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/team/schedule?date=2026-05-04"]);
    expect(output).toContain("*Lundi 2026-05-04:*");
    expect(output).toContain("  Midi: 1 cuisine + 1 salle");
    expect(output).toContain("Total: 2 services, 8h");
  });

  test("team_on_date fetches detailed day planning from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("/team/staffing-gap")) {
        return new Response(JSON.stringify({ data: { zones: [{ zone: "Midi", kitchen: { target: 0, actual: 0, missing: 0 }, floor: { target: 1, actual: 1, missing: 0 } }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {
        date: "2026-05-04",
        zones: ["Midi"],
        services: [{ workerName: "Alice", startTime: "10:00", endTime: "14:00", role: "floor", zone: "Midi" }],
      } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("team_on_date").execute({ date: "2026-05-04" }, ctx);

    expect(urls).toEqual([
      "http://api.local/internal/whatsapp/team/on-date?date=2026-05-04",
      "http://api.local/internal/whatsapp/team/staffing-gap?date=2026-05-04",
    ]);
    expect(output).toBe("*Équipe du Lundi 2026-05-04:*\n\n*Midi:*\n  🍽️ Alice 10:00-14:00");
  });

  test("weekly_recap fetches hours recap from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: {
        from: "2026-05-04",
        to: "2026-05-10",
        serviceCount: 3,
        totalHours: 42,
        workers: [{ name: "Alice Martin", role: "floor", hours: 42, services: 3 }],
      } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("weekly_recap").execute({ date: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/team/weekly-recap?date=2026-05-04"]);
    expect(output).toContain("*Récap 2026-05-04 → 2026-05-10:*");
    expect(output).toContain("Alice Martin: 42h (3 services) ⚠️ +3h sup");
    expect(output).toContain("⚠️ *Heures sup:* Alice");
  });

  test("compliance_check fetches compliance alerts from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { from: "2026-05-04", to: "2026-05-10", serviceCount: 1, alerts: ["🛑 Alice: 12h le Lundi 2026-05-04 (max 11h)"] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("compliance_check").execute({ date: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/team/compliance?date=2026-05-04"]);
    expect(output).toBe("🔴 *1 erreur(s), 0 alerte(s)* — semaine du 2026-05-04\n🛑 Alice: 12h le Lundi 2026-05-04 (max 11h)");
  });

  test("who_is_available fetches availability from the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: {
        date: "2026-05-04",
        zones: [{ zone: "Midi", available: ["Alice"], alreadyScheduled: ["Bob"], unavailable: ["Carla (congé)"] }],
      } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("who_is_available").execute({ date: "2026-05-04", zone: "Midi" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/team/availability?date=2026-05-04&zone=Midi"]);
    expect(output).toBe("*Disponibilités Lundi 2026-05-04:*\n\n*Midi:*\n  ✅ Dispos: Alice\n  📅 Déjà placés: Bob\n  ❌ Non dispo: Carla (congé)");
  });

  test("send_schedule resolves worker and posts send request to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).includes("/workers/resolve")) {
        return new Response(JSON.stringify({ data: { worker: { id: "w1", name: "Alice Martin", role: "floor", priority: 1, subRoles: "[]", contractHours: 35, active: true } } }), { status: 200 });
      }
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ date: "2026-05-04" }));
      return new Response(JSON.stringify({ data: { sent: true, worker: { id: "w1", name: "Alice Martin" }, from: "2026-05-04", to: "2026-05-10" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("send_schedule").execute({ worker_name: "Alice", date: "2026-05-04" }, ctx);

    expect(urls).toEqual([
      "http://api.local/internal/whatsapp/workers/resolve?name=Alice&scope=team",
      "http://api.local/internal/whatsapp/workers/w1/send-schedule",
    ]);
    expect(output).toBe("✅ Planning envoyé à *Alice Martin* par notification.");
  });

  test("worker_hours resolves the worker then fetches API-owned hours", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("/workers/resolve")) {
        return new Response(JSON.stringify({ data: { worker: { id: "w1", name: "Alice Martin", role: "floor", priority: 1, subRoles: "[]", contractHours: 35, active: true } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { worker: { id: "w1", name: "Alice Martin" }, periodLabel: "mai 2026", serviceCount: 2, totalHours: 9 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("worker_hours").execute({ worker_name: "Alice", period: "2026-05" }, ctx);

    expect(urls).toEqual([
      "http://api.local/internal/whatsapp/workers/resolve?name=Alice&scope=hours",
      "http://api.local/internal/whatsapp/workers/w1/hours?period=2026-05",
    ]);
    expect(output).toBe("*Alice Martin* (mai 2026): 2 services, 9h.");
  });

  test("worker_schedule maps API 403 to a French denial", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })) as unknown as typeof fetch;

    const output = await tool("worker_schedule").execute({ worker_name: "Alice" }, ctx);

    expect(output).toBe("Je n'ai pas l'autorisation d'accéder à ces informations.");
  });

  test("review_replacement prompt preparation calls the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ requesterName: "Alice", decision: "pick", candidateName: "Bob" }));
      return new Response(JSON.stringify({ data: { status: "pick_ready", replacementId: "repl-1", requesterId: "worker-1", requesterName: "Alice Martin", pickedId: "worker-2", pickedName: "Bob Chef", service: { date: "2026-05-04", startTime: "10:00", endTime: "14:00" }, svcLabel: "2026-05-04 (10:00-14:00)" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("review_replacement").execute({ requester_name: "Alice", decision: "pick", candidate_name: "Bob" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/replacements/review/prepare"]);
    expect(output).toBe("Proposer à *Bob Chef* de remplacer *Alice Martin* (2026-05-04 (10:00-14:00)) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.");
  });

  test("review_replacement confirmation posts the mutation to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ decision: "pick", candidateId: "candidate-1" }));
      return new Response(JSON.stringify({ data: { decision: "pick", pickedName: "Alice Martin", status: "awaiting_worker_reply" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const handler = getHandler("review_replacement_pick_confirmed");
    if (!handler) throw new Error("missing review replacement handler");
    const output = await handler({ replacementId: "repl-1", pickedId: "candidate-1", pickedName: "Fallback" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/replacements/repl-1/review"]);
    expect(output).toBe("✅ *Alice Martin* a été notifié. Tu seras tenu au courant de sa réponse.");
  });

  test("review_replacement denied API response becomes a French refusal", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Seul le gérant peut arbitrer un remplacement." }), { status: 403 })) as unknown as typeof fetch;

    const handler = getHandler("review_replacement_refuse_confirmed");
    if (!handler) throw new Error("missing review replacement handler");
    const output = await handler({ replacementId: "repl-1", requesterName: "Alice" }, ctx);

    expect(output).toBe("Je n'ai pas l'autorisation d'accéder à ces informations.");
  });

  test("add_service prompt preparation calls the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ workerName: "Alice", date: "2099-05-04", dateText: "2099-05-04", zone: "Midi" }));
      return new Response(JSON.stringify({ data: { status: "ok", worker: { id: "worker-1", name: "Alice Martin" }, date: "2099-05-04", startTime: "10:00", endTime: "14:00", role: "floor", zone: "Midi" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("add_service").execute({ worker_name: "Alice", date: "2099-05-04", zone: "Midi" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/planning/services/prepare"]);
    expect(output).toBe("Ajouter *Alice Martin* le Lundi 2099-05-04 en *Midi* (10:00-14:00, floor) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.");
  });

  test("delete_service prompt preparation calls the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ workerName: "Alice", date: "2026-05-04" }));
      return new Response(JSON.stringify({ data: { status: "ok", worker: { id: "worker-1", name: "Alice Martin" }, date: "2026-05-04", service: { id: "svc-1", startTime: "10:00", endTime: "14:00", zone: "Midi" } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("delete_service").execute({ worker_name: "Alice", date: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/planning/services/prepare-delete"]);
    expect(output).toBe("Supprimer le service de *Alice Martin* le Lundi 2026-05-04 en Midi (10:00-14:00) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.");
  });

  test("publish_schedule_week prompt preparation calls the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { status: "ok", serviceCount: 2, workerCount: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const output = await tool("publish_schedule_week").execute({ date: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/planning/weeks/prepare-publish"]);
    expect(output).toContain("Publier le planning Lundi 2026-05-04 → Dimanche 2026-05-10 (2 services, 1 employé)");
  });

  test("add_service confirmation posts planning mutation to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({
        workerId: "worker-1",
        workerName: "Alice Martin",
        date: "2026-05-04",
        startTime: "10:00",
        endTime: "14:00",
        role: "floor",
      }));
      return new Response(JSON.stringify({ data: { service: { id: "svc-1" }, workerName: "Alice Martin" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const handler = getHandler("add_service_confirmed");
    if (!handler) throw new Error("missing add service handler");
    const output = await handler({ workerId: "worker-1", workerName: "Alice Martin", date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/planning/services"]);
    expect(output).toBe("Service ajouté: *Alice Martin* le Lundi 2026-05-04, 10:00-14:00. ✅");
  });

  test("delete_service confirmation posts cancel mutation to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const handler = getHandler("delete_service_confirmed");
    if (!handler) throw new Error("missing delete service handler");
    const output = await handler({ serviceId: "svc-1" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/planning/services/svc-1/cancel"]);
    expect(output).toBe("Service supprimé. ✅");
  });

  test("publish_schedule_week confirmation posts publish mutation to the internal API", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { notifiedWorkers: 2 } }), { status: 201 });
    }) as unknown as typeof fetch;

    const handler = getHandler("publish_schedule_week_confirmed");
    if (!handler) throw new Error("missing publish week handler");
    const output = await handler({ weekStart: "2026-05-04" }, ctx);

    expect(urls).toEqual(["http://api.local/internal/whatsapp/planning/weeks/2026-05-04/publish"]);
    expect(output).toBe("✅ Planning Lundi 2026-05-04 → Dimanche 2026-05-10 publié. 2 employés ont reçu son planning sur WhatsApp.");
  });
});
