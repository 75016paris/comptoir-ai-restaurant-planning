/**
 * Worker tool manifest — what kitchen/server employees can do via WhatsApp.
 * Every tool pre-filters by userId/restaurantId. The LLM cannot escape this sandbox.
 */
import { apiGet, apiPost, WhatsAppApiError } from "../api-client.js";
import type { ToolDef } from "./types.js";
import { setPending, confirmActionTool, registerHandler } from "./confirmation.js";
import { resolveRelativeDate } from "../date-resolver.js";
import { todayInTimeZone } from "@comptoir/shared";

// ── Print redirect for long responses ──
// Meta Cloud API cap is 4096 chars/message. Summarize + redirect to print page.

const APP_URL = process.env.FRONTEND_URL || "https://comptoir.cosmobot.fr";
const PRINT_THRESHOLD = 3800; // chars — Meta cap is 4096, leave room for print hint

function withPrintHint(response: string, role: "admin" | "manager" | "kitchen" | "floor"): string {
  if (response.length <= PRINT_THRESHOLD) return response;
  const url = (role === "admin" || role === "manager") ? `${APP_URL}/schedule` : `${APP_URL}/my-schedule`;
  const truncated = response.slice(0, 900);
  const lastNewline = truncated.lastIndexOf("\n");
  const clean = lastNewline > 200 ? truncated.slice(0, lastNewline) : truncated;
  return `${clean}\n\n_(suite tronquée)_\n\n📄 Pour le planning complet → *Imprimer* sur ${url}`;
}

// ── Helpers ──

/** Format Date as YYYY-MM-DD in local timezone (not UTC). */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
function dayName(dateStr: string): string {
  return DAY_FR[new Date(dateStr + "T12:00:00").getDay()];
}

// ── Name matching (PI-06) ──

function findWorkerByName(
  workers: Array<{ id: string; name: string }>,
  input: string,
): { worker: typeof workers[0] | null; ambiguous: string[] } {
  const namePart = input.toLowerCase().trim();
  if (!namePart) return { worker: null, ambiguous: [] };
  // Try exact first name match
  const exactFirst = workers.filter((w) => w.name.toLowerCase().split(" ")[0] === namePart);
  if (exactFirst.length === 1) return { worker: exactFirst[0], ambiguous: [] };
  // Try full name match
  const exact = workers.filter((w) => w.name.toLowerCase() === namePart);
  if (exact.length === 1) return { worker: exact[0], ambiguous: [] };
  // Try includes
  const partial = workers.filter((w) => w.name.toLowerCase().includes(namePart));
  if (partial.length === 1) return { worker: partial[0], ambiguous: [] };
  if (partial.length > 1) return { worker: null, ambiguous: partial.map((w) => w.name) };
  return { worker: null, ambiguous: [] };
}

// Date resolver imported from ../date-resolver.ts
export { resolveRelativeDate } from "../date-resolver.js";

/** Resolve date or return an error message for the user */
function resolveDateOrError(input: string, timeZone?: string): { date: string } | { error: string } {
  const resolved = resolveRelativeDate(input, { timeZone });
  if (!resolved) return { error: `Je n'ai pas compris la date "${input}". Essaie: "lundi", "demain", "2026-04-05".` };
  return { date: resolved };
}

const resolveDate: ToolDef = {
  name: "resolve_date",
  description: "Convertit une date relative en YYYY-MM-DD. APPELLE TOUJOURS cet outil quand l'utilisateur dit 'mercredi prochain', 'demain', etc. Ne calcule JAMAIS les dates toi-même.",
  parameters: {
    date_text: { type: "string", description: "Texte de date à résoudre (ex: 'mercredi prochain', 'demain', 'lundi')" },
  },
  async execute(args, ctx) {
    const text = args.date_text as string;
    const resolved = resolveRelativeDate(text, { timeZone: ctx.restaurantTimezone });
    if (!resolved) return `Je n'ai pas compris la date "${text}". Essaie: "lundi", "demain", "2026-04-05".`;
    const d = new Date(resolved + "T12:00:00");
    return `${resolved} (${DAY_FR[d.getDay()]})`;
  },
};

// ── tapInOut check helper (PI-09) ──

function formatInternalApiError(err: unknown): string {
  if (err instanceof WhatsAppApiError) {
    const body = err.body as { error?: string } | undefined;
    if (err.status >= 400 && err.status < 500) return body?.error || err.message;
  }
  return "Erreur: l'opération a échoué.";
}

// ── Tools ──

const mySchedule: ToolDef = {
  name: "my_schedule",
  description: "Services personnels pour une semaine (ou un jour précis). Outil principal pour 'mon planning', 'je bosse quand', 'mon planning de demain'.",
  parameters: {
    date: { type: "string", description: "Texte exact de l'utilisateur: 'lundi prochain', 'semaine prochaine'. L'outil calcule la semaine contenant cette date.", required: false },
    week_offset: { type: "number", description: "Fallback: 0 = cette semaine, 1 = prochaine, -1 = dernière. Ignoré si date fourni.", required: false },
  },
  async execute(args, ctx) {
    const params = new URLSearchParams();
    if (args.date) params.set("date", String(args.date));
    if (args.week_offset != null) params.set("week_offset", String(args.week_offset));

    try {
      const res = await apiGet<{ data: {
        from: string;
        to: string;
        services: Array<{ date: string; startTime: string; endTime: string; role: "kitchen" | "floor"; hours: number; zone: string; restaurantName?: string }>;
        totalHours: number;
      } }>(`/me/schedule${params.size ? `?${params.toString()}` : ""}`, ctx);
      const rows = res.data.services;
      if (rows.length === 0) return `Aucun service prévu du ${res.data.from} au ${res.data.to}.`;

      const formatRows = (groupRows: typeof rows, options: { includeRestaurantName: boolean }): string[] => {
        const lines: string[] = [];
        const byDate = new Map<string, typeof rows>();
        for (const r of groupRows) {
          if (!byDate.has(r.date)) byDate.set(r.date, []);
          byDate.get(r.date)!.push(r);
        }
        for (const [date, dayRows] of byDate) {
          const dayH = dayRows.reduce((s, r) => s + r.hours, 0);
          if (dayRows.length >= 2) {
            const sorted = dayRows.sort((a, b) => a.startTime.localeCompare(b.startTime));
            const restaurants = options.includeRestaurantName ? [...new Set(sorted.map((r) => r.restaurantName).filter(Boolean))] : [];
            const restaurant = restaurants.length ? `, ${restaurants.join(" + ")}` : "";
            const label = restaurants.length > 1 ? "Services multiples" : "Coupure";
            lines.push(`${dayName(date)} ${date} — ${label} ${sorted[0].startTime}-${sorted[sorted.length - 1].endTime} (${dayH}h${restaurant})`);
          } else {
            const r = dayRows[0];
            const restaurant = options.includeRestaurantName && r.restaurantName ? `, ${r.restaurantName}` : "";
            lines.push(`${dayName(r.date)} ${r.date} — ${r.startTime}-${r.endTime} (${dayH}h, ${r.zone}${restaurant})`);
          }
        }
        return lines;
      };

      const restaurantNames = [...new Set(rows.map((r) => r.restaurantName).filter(Boolean))];
      const outLines: string[] = [];
      if (restaurantNames.length > 1) {
        for (const restaurantName of restaurantNames) {
          const restaurantRows = rows.filter((r) => r.restaurantName === restaurantName);
          outLines.push(`*${restaurantName}:*`);
          outLines.push(...formatRows(restaurantRows, { includeRestaurantName: false }));
          outLines.push("");
        }
        if (outLines[outLines.length - 1] === "") outLines.pop();
      } else {
        outLines.push(...formatRows(rows, { includeRestaurantName: true }));
      }

      const serviceDays = new Set(rows.map((r) => r.date)).size;
      outLines.push(`\nTotal: ${serviceDays} jour${serviceDays > 1 ? "s" : ""}, ${Math.round(res.data.totalHours * 10) / 10}h`);
      return withPrintHint(outLines.join("\n"), ctx.role);
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const myNextService: ToolDef = {
  name: "my_next_service",
  description: "Uniquement le tout prochain service. Utilise my_schedule si l'employé demande un planning ou une date précise.",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiGet<{ data: { service: { date: string; startTime: string; endTime: string; role: "kitchen" | "floor"; zone: string; restaurantName?: string } | null } }>("/me/next-service", ctx);
      const row = res.data.service;
      if (!row) return "Pas de service prévu prochainement.";
      const restaurant = row.restaurantName ? `, ${row.restaurantName}` : "";
      return `Prochain service: ${dayName(row.date)} ${row.date}, ${row.startTime}-${row.endTime} (${row.zone}, ${row.role === "kitchen" ? "cuisine" : "service"}${restaurant})`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const myHours: ToolDef = {
  name: "my_hours",
  description: "Récap des heures travaillées pour un mois donné.",
  parameters: {
    month: { type: "string", description: "Mois: 'mars', 'février', '2026-03', etc. Par défaut mois en cours.", required: false },
  },
  async execute(args, ctx) {
    const month = resolveMonth(args.month as string, ctx.restaurantTimezone);
    const [y, m] = month.split("-").map(Number);
    try {
      const res = await apiGet<{ data: { serviceCount: number; totalHours: number } }>(`/me/hours?month=${encodeURIComponent(month)}`, ctx);
      const monthLabel = MONTH_NAMES_FR[m - 1];
      return `${monthLabel} ${y}: ${res.data.serviceCount} services, ${Math.round(res.data.totalHours * 100) / 100}h travaillées.`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const reportUnavailable: ToolDef = {
  name: "report_unavailable",
  description: "L'employé signale qu'il ne peut pas venir un jour donné. Le bot trouve des candidats et le gérant décide qui prend le service. À utiliser pour 'je peux pas venir', 'je suis pas dispo', 'je peux pas faire mon service'.",
  parameters: {
    service_date: { type: "string", description: "Date du service: 'YYYY-MM-DD', 'demain', 'ce soir', 'mercredi prochain', etc." },
    zone: { type: "string", description: "OBLIGATOIRE si mentionné: midi, soir, matin. Extrais du message utilisateur.", required: false },
    reason: { type: "string", description: "Raison optionnelle", required: false },
  },
  async execute(args, ctx) {
    const dateResult = resolveDateOrError(args.service_date as string, ctx.restaurantTimezone);
    if ("error" in dateResult) return dateResult.error;
    const date = dateResult.date;

    const fetchServicesForDate = async (targetDate: string) => {
      const res = await apiGet<{ data: { services: Array<{ id: string; date: string; startTime: string; endTime: string; role: string }> } }>(`/me/schedule?date=${encodeURIComponent(targetDate)}`, ctx);
      return res.data.services.filter((s) => s.date === targetDate).sort((a, b) => a.startTime.localeCompare(b.startTime));
    };

    let myServices: Array<{ id: string; date: string; startTime: string; endTime: string; role: string }>;
    try {
      myServices = await fetchServicesForDate(date);
    } catch (err) {
      return formatInternalApiError(err);
    }

    if (!myServices.length) {
      const today = todayInTimeZone(ctx.restaurantTimezone);
      if (date <= today) {
        const nextWeek = new Date(date + "T12:00:00");
        nextWeek.setDate(nextWeek.getDate() + 7);
        const nextDate = fmtDate(nextWeek);
        let nextServices: typeof myServices;
        try {
          nextServices = await fetchServicesForDate(nextDate);
        } catch (err) {
          return formatInternalApiError(err);
        }
        if (nextServices.length > 0) {
          return (reportUnavailable as any).execute({ ...args, service_date: nextDate }, ctx);
        }
      }
      return `Tu n'as pas de service le ${dayName(date)} ${date}.`;
    }

    // Detect coupure: 2 services same day with AM+PM gap
    const isCoupure = myServices.length === 2 &&
      parseInt(myServices[0].startTime.split(":")[0]) < 16 &&
      parseInt(myServices[1].startTime.split(":")[0]) >= 16;

    if (isCoupure) {
      const sorted = myServices.sort((a, b) => a.startTime.localeCompare(b.startTime));
      setPending(ctx.userId, "report_unavailable_confirmed", {
        requesterServiceIds: sorted.map(s => s.id),
        reason: (args.reason as string) || null,
        date,
        startTime: sorted[0].startTime,
        endTime: sorted[sorted.length - 1].endTime,
        role: sorted[0].role,
      });
      return `Prévenir le gérant que tu peux pas venir le ${dayName(date)} ${date} (coupure ${sorted[0].startTime}-${sorted[sorted.length - 1].endTime}) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
    }

    let myService = myServices[0];
    if (myServices.length > 1) {
      const allText = [args.zone, args.service_date, ctx.lastUserMessage].filter(Boolean).join(" ").toLowerCase();
      const wantsSoir = /soir|nuit|evening/.test(allText);
      const wantsMidi = /midi|matin|journ[eé]e|morning|lunch/.test(allText);
      if (wantsSoir) {
        const soirService = myServices.find(s => parseInt(s.startTime.split(":")[0]) >= 16);
        if (soirService) myService = soirService;
      } else if (wantsMidi) {
        const midiService = myServices.find(s => parseInt(s.startTime.split(":")[0]) < 16);
        if (midiService) myService = midiService;
      } else {
        const zoneLabel = (s: typeof myService) => parseInt(s.startTime.split(":")[0]) < 16 ? "midi" : "soir";
        const options = myServices.map((s, i) => `${i + 1}. ${zoneLabel(s)} (${s.startTime}-${s.endTime})`);
        return `Tu as ${myServices.length} services le ${dayName(date)} ${date}:\n${options.join("\n")}\nLequel tu peux pas faire ?`;
      }
    }

    setPending(ctx.userId, "report_unavailable_confirmed", {
      requesterServiceId: myService.id,
      reason: (args.reason as string) || null,
      date,
      startTime: myService.startTime,
      endTime: myService.endTime,
      role: myService.role,
    });
    return `Prévenir le gérant que tu peux pas venir le ${dayName(date)} ${date} (${myService.startTime}-${myService.endTime}) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
  },
};

const respondReplacement: ToolDef = {
  name: "respond_replacement",
  description: "Accepter ou refuser une proposition de remplacement (le gérant te demande de prendre le service d'un collègue absent).",
  parameters: {
    decision: { type: "string", description: "accepted ou rejected", enum: ["accepted", "rejected"] },
  },
  async execute(args, ctx) {
    if (ctx.role === "admin") {
      return "En tant que gérant, tu ne réponds pas aux remplacements. Utilise 'review_replacement' pour proposer un remplacement à un employé.";
    }
    const decision = args.decision as string;
    if (decision !== "accepted" && decision !== "rejected") return "Réponds 'accepter' ou 'refuser'.";
    try {
      const res = await apiPost<{ data: { decision: "accepted" | "rejected"; requesterName: string | null; service: { date: string } } }>("/me/replacements/respond", { decision }, ctx);
      if (decision === "rejected") return "Refus enregistré. Le gérant va décider la suite.";
      return `✅ Remplacement accepté ! Le service du *${dayName(res.data.service.date)} ${res.data.service.date}* de *${res.data.requesterName || "?"}* t'est maintenant assigné.`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const requestHoliday: ToolDef = {
  name: "request_holiday",
  description: "Demander un congé. Si seul start_date fourni, end_date = même jour.",
  parameters: {
    start_date: { type: "string", description: "Date de début: 'YYYY-MM-DD', 'lundi prochain', 'vendredi', 'la semaine du 2026-07-13', etc." },
    end_date: { type: "string", description: "Date de fin (optionnel, même jour si omis): 'YYYY-MM-DD', 'vendredi prochain', etc.", required: false },
    reason: { type: "string", description: "Raison du congé", required: false },
  },
  async execute(args, ctx) {
    const startRaw = args.start_date as string;
    const endRaw = args.end_date as string | undefined;

    // Handle week expressions → resolve Monday→Friday
    const weekMatch = startRaw?.match(/semaine\s+(du|proch|derni)/i) || startRaw?.match(/cet(?:te)?\s*semaine/i);
    let start: string;
    let end: string;

    if (weekMatch) {
      const resolved = resolveRelativeDate(startRaw, { timeZone: ctx.restaurantTimezone });
      if (!resolved) return `Je n'ai pas compris la date "${startRaw}". Essaie: "la semaine du 14 juillet", "semaine prochaine".`;
      // resolveRelativeDate returns the Monday of the week
      const mon = new Date(resolved + "T12:00:00");
      const fri = new Date(mon);
      fri.setDate(mon.getDate() + 4); // Monday + 4 = Friday
      start = fmtDate(mon);
      end = fmtDate(fri);
    } else {
      const startResult = resolveDateOrError(startRaw, ctx.restaurantTimezone);
      if ("error" in startResult) return startResult.error;
      start = startResult.date;

      if (endRaw) {
        const endResult = resolveDateOrError(endRaw, ctx.restaurantTimezone);
        if ("error" in endResult) return endResult.error;
        end = endResult.date;
      } else {
        end = start; // Single day
      }
    }

    if (start > end) return "La date de début doit être avant la date de fin.";

    const today = todayInTimeZone(ctx.restaurantTimezone);
    if (start < today) return "Impossible de demander un congé dans le passé.";

    const days = Math.ceil((new Date(end + "T12:00:00").getTime() - new Date(start + "T12:00:00").getTime()) / 86400000) + 1;

    setPending(ctx.userId, "request_holiday_confirmed", {
      startDate: start, endDate: end,
      reason: (args.reason as string) || null,
      days,
    });
    return `Demander un congé du ${dayName(start)} ${start} au ${dayName(end)} ${end} (${days} jour${days > 1 ? "s" : ""})${args.reason ? ` — ${args.reason}` : ""} ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
  },
};

const myPendingReplacements: ToolDef = {
  name: "my_pending_replacements",
  description: "Affiche les demandes de remplacement en attente (envoyées par moi et reçues).",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiGet<{ data: {
        sent: Array<{ service: { date: string; startTime: string; endTime: string } | null; phase: string }>;
        received: Array<{ requesterName: string | null; service: { date: string; startTime: string; endTime: string } | null }>;
      } }>("/me/replacements/pending", ctx);
      const lines: string[] = [];
      for (const s of res.data.sent) {
        lines.push(`Envoyée: ${s.service?.date || "?"} (${s.service?.startTime}-${s.service?.endTime}) — ${s.phase}`);
      }
      for (const r of res.data.received) {
        lines.push(`Reçue de *${r.requesterName || "?"}*: ${r.service?.date || "?"} (${r.service?.startTime}-${r.service?.endTime}) — dis "accepter" ou "refuser"`);
      }
      if (!lines.length) return "Aucun remplacement en attente.";
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const clockIn: ToolDef = {
  name: "clock_in",
  description: "Pointer l'arrivée. Quand l'employé dit 'je suis arrivé', 'arrivé', 'je pointe'.",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiPost<{ data: { tapIn: string } }>("/me/clock-in", {}, ctx);
      return `Pointé à ${new Intl.DateTimeFormat("fr-FR", { timeZone: ctx.restaurantTimezone, hour: "2-digit", minute: "2-digit" }).format(new Date(res.data.tapIn))}. Bon service !`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const clockOut: ToolDef = {
  name: "clock_out",
  description: "Pointer la sortie. Quand l'employé dit 'je pars', 'fini', 'je quitte'.",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiPost<{ data: { tapOut: string } }>("/me/clock-out", {}, ctx);
      return `Sortie pointée à ${new Intl.DateTimeFormat("fr-FR", { timeZone: ctx.restaurantTimezone, hour: "2-digit", minute: "2-digit" }).format(new Date(res.data.tapOut))}. Bonne soirée !`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const myHolidays: ToolDef = {
  name: "my_holidays",
  description: "Affiche les demandes de congé récentes et leur statut.",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiGet<{ data: { holidays: Array<{ startDate: string; endDate: string; status: string; reason: string | null }> } }>("/me/holidays", ctx);
      const rows = res.data.holidays;
      if (!rows.length) return "Aucune demande de congé.";

      const statusFr: Record<string, string> = { pending: "⏳ En attente", approved: "✅ Approuvé", rejected: "❌ Refusé" };
      return rows
        .map((r) => `${dayName(r.startDate)} ${r.startDate} → ${dayName(r.endDate)} ${r.endDate}: ${statusFr[r.status] || r.status}${r.reason ? ` (${r.reason})` : ""}`)
        .join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

// ── Month resolver helper ──

const MONTH_NAMES_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function resolveMonth(raw?: string, timeZone?: string): string {
  const now = new Date(`${todayInTimeZone(timeZone)}T12:00:00`);
  if (!raw) return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const clean = raw.toLowerCase().trim();
  if (/^\d{4}-\d{2}$/.test(clean)) return clean;
  const monthMap: Record<string, number> = {
    janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  };
  // Sort longest-first to avoid substring matches (e.g. "semaine" matching "mai")
  const sortedMonths = Object.entries(monthMap).sort(([a], [b]) => b.length - a.length);
  const found = sortedMonths.find(([name]) => {
    const re = new RegExp(`\\b${name}\\b`, "i");
    return re.test(clean);
  });
  if (found) {
    const y = found[1] > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
    return `${y}-${String(found[1]).padStart(2, "0")}`;
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ── Register worker confirmation handlers ──

registerHandler("report_unavailable_confirmed", async (args, ctx) => {
  const serviceIds: string[] = (args.requesterServiceIds as string[] | undefined)
    ?? [args.requesterServiceId as string];
  const date = args.date as string;
  const startTime = args.startTime as string;
  const endTime = args.endTime as string;
  const role = args.role as "kitchen" | "floor";
  const reason = (args.reason as string) || null;

  const requesterServiceId = serviceIds[0];
  const timeLabel = serviceIds.length > 1 ? `coupure ${startTime}-${endTime}` : `${startTime}-${endTime}`;
  try {
    await apiPost("/me/replacements/report-unavailable", { requesterServiceId, date, startTime, endTime, role, reason, isCoupure: serviceIds.length > 1 }, ctx);
    return `J'ai prévenu le gérant que tu peux pas venir le ${dayName(date)} ${date} (${timeLabel}). Il choisira un remplaçant et tu seras tenu au courant.`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("request_holiday_confirmed", async (args, ctx) => {
  const startDate = args.startDate as string;
  const endDate = args.endDate as string;
  const reason = (args.reason as string) || null;
  const days = args.days as number;

  try {
    const res = await apiPost<{ data: { isMedical: boolean } }>("/me/holidays", { startDate, endDate, reason }, ctx);
    if (res.data.isMedical) {
      return `Congé médical enregistré et approuvé automatiquement: ${dayName(startDate)} ${startDate} → ${dayName(endDate)} ${endDate} (${days} jour${days > 1 ? "s" : ""}). Ton responsable a été prévenu.`;
    }
    return `Demande de congé envoyée: ${dayName(startDate)} ${startDate} → ${dayName(endDate)} ${endDate} (${days} jour${days > 1 ? "s" : ""}). En attente de validation par ton responsable.`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

// ── Worker preferences (planning) ──

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type DayKey = typeof DAY_KEYS[number];
const DAY_LABELS: Record<DayKey, string> = {
  monday: "Lundi", tuesday: "Mardi", wednesday: "Mercredi", thursday: "Jeudi",
  friday: "Vendredi", saturday: "Samedi", sunday: "Dimanche",
};
const DAY_TO_NUM: Record<DayKey, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};

type SlotPatch = { matin?: boolean; midi?: boolean; soir?: boolean; closed?: boolean };

function normalizeDayKey(input: string): DayKey | null {
  const k = input.toLowerCase().trim();
  const map: Record<string, DayKey> = {
    "lundi": "monday", "lun": "monday", "mon": "monday", "monday": "monday",
    "mardi": "tuesday", "mar": "tuesday", "tue": "tuesday", "tuesday": "tuesday",
    "mercredi": "wednesday", "mer": "wednesday", "wed": "wednesday", "wednesday": "wednesday",
    "jeudi": "thursday", "jeu": "thursday", "thu": "thursday", "thursday": "thursday",
    "vendredi": "friday", "ven": "friday", "fri": "friday", "friday": "friday",
    "samedi": "saturday", "sam": "saturday", "sat": "saturday", "saturday": "saturday",
    "dimanche": "sunday", "dim": "sunday", "sun": "sunday", "sunday": "sunday",
  };
  return map[k] ?? null;
}

function renderSlotsForDay(midi: boolean, soir: boolean): string {
  const parts: string[] = [];
  if (midi) parts.push("< 14h");
  if (soir) parts.push("≥ 14h");
  if (parts.length === 0) return "_fermé_";
  return parts.join(" + ");
}

const myPreferences: ToolDef = {
  name: "my_preferences",
  description: "Affiche les préférences de planning de l'employé : heures max par semaine, acceptation des coupures, et créneaux préférés par jour. À utiliser quand l'employé demande 'mes préférences', 'mes créneaux', 'je veux voir mes dispos', etc.",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiGet<{ data: { contractHours: number | null; maxWeeklyHours: number | null; coupureWilling: boolean; slots: Array<{ dayOfWeek: number; midi: boolean; soir: boolean }> } }>("/me/preferences", ctx);
      const u = res.data;
      const byDay = new Map<number, typeof u.slots[number]>();
      for (const r of u.slots) byDay.set(r.dayOfWeek, r);

      const lines: string[] = ["*Tes préférences de planning :*"];
      const contract = u.contractHours ?? null;
      const max = u.maxWeeklyHours ?? null;
      if (max == null) {
        lines.push(`• Heures max / semaine : ${contract != null ? `${contract}h (contrat)` : "non défini"}`);
      } else {
        lines.push(`• Heures max / semaine : *${max}h*${contract != null ? ` (contrat : ${contract}h)` : ""}`);
      }
      lines.push(`• Coupures acceptées : ${u.coupureWilling ? "✅ oui" : "❌ non"}`);
      lines.push("\n*Créneaux préférés :*");
      for (const day of DAY_KEYS) {
        const num = DAY_TO_NUM[day];
        const row = byDay.get(num);
        const label = DAY_LABELS[day];
        if (!row) {
          lines.push(`• ${label} : _non défini_`);
        } else {
          lines.push(`• ${label} : ${renderSlotsForDay(row.midi, row.soir)}`);
        }
      }
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const updatePreferences: ToolDef = {
  name: "update_preferences",
  description: "Met à jour les préférences de planning de l'employé. PATCH partiel : ne change que les champs fournis. À utiliser quand l'employé dit 'je veux faire 48h max', 'j'accepte les coupures', 'je préfère le matin et le midi le lundi', 'je ne veux plus bosser le dimanche', etc.",
  parameters: {
    max_weekly_hours: { type: "number", description: "Plafond hebdomadaire en heures (35-48). Mettre null pour s'aligner sur le contrat.", required: false },
    accepts_coupures: { type: "boolean", description: "L'employé accepte-t-il les services coupés (un service du midi + un du soir le même jour) ?", required: false },
    slots_json: {
      type: "string",
      description: "JSON string des créneaux préférés par jour (PATCH). Format : '{\"monday\":{\"midi\":true},\"sunday\":{\"closed\":true}}'. Clés : monday–sunday. Slots : midi (avant 14h), soir (après 14h), ou closed:true pour tout désactiver. matin est un alias de midi. Jours non mentionnés = inchangés.",
      required: false,
    },
  },
  async execute(args, ctx) {
    const max = args.max_weekly_hours;
    const coupures = args.accepts_coupures;
    let slots: Record<string, SlotPatch> | undefined;
    if (args.slots_json) {
      try {
        slots = typeof args.slots_json === "string" ? JSON.parse(args.slots_json) : args.slots_json as any;
      } catch (e: any) {
        return `JSON invalide pour slots_json : ${e.message}. Exemple : {"monday":{"matin":true}}`;
      }
    } else if (args.slots && typeof args.slots === "object") {
      slots = args.slots as Record<string, SlotPatch>;
    }

    if (max == null && coupures == null && !slots) {
      return "Précise ce que tu veux changer : nombre d'heures max, acceptation des coupures, ou créneaux par jour.";
    }
    if (max != null) {
      const n = Number(max);
      if (!Number.isFinite(n) || n < 1 || n > 60) return `Heures max hors limites: ${max}. Donne un nombre entre 35 et 48.`;
    }

    const normalizedSlots: Record<string, SlotPatch> = {};
    if (slots && typeof slots === "object") {
      for (const [k, v] of Object.entries(slots)) {
        const day = normalizeDayKey(k);
        if (!day) return `Jour inconnu : "${k}". Utilise lundi/mardi/...\\dimanche.`;
        normalizedSlots[day] = v as SlotPatch;
      }
    }

    // Build a delta summary for the confirmation prompt
    const prefRes = await apiGet<{ data: { maxWeeklyHours: number | null; coupureWilling: boolean } }>("/me/preferences", ctx).catch((err) => err);
    if (prefRes instanceof Error) return formatInternalApiError(prefRes);
    const u = prefRes.data;

    const lines: string[] = ["Mettre à jour tes préférences :"];
    if (max !== undefined) {
      const newVal = max == null ? "contrat" : `${max}h`;
      const oldVal = u.maxWeeklyHours == null ? "contrat" : `${u.maxWeeklyHours}h`;
      lines.push(`• Heures max / semaine : *${newVal}* _(était : ${oldVal})_`);
    }
    if (coupures !== undefined) {
      lines.push(`• Coupures acceptées : *${coupures ? "✅ oui" : "❌ non"}* _(était : ${u.coupureWilling ? "oui" : "non"})_`);
    }
    for (const day of DAY_KEYS) {
      const patch = normalizedSlots[day];
      if (!patch) continue;
      const parts: string[] = [];
      if (patch.closed) {
        parts.push("_fermé_");
      } else {
        if (patch.matin === true || patch.midi === true) parts.push("+ < 14h");
        if (patch.matin === false || patch.midi === false) parts.push("− < 14h");
        if (patch.soir === true) parts.push("+ ≥ 14h");
        if (patch.soir === false) parts.push("− ≥ 14h");
      }
      if (parts.length) lines.push(`• ${DAY_LABELS[day]} : ${parts.join(", ")}`);
    }
    if (lines.length === 1) return "Aucun changement à appliquer.";

    setPending(ctx.userId, "update_preferences_confirmed", {
      maxWeeklyHours: max === undefined ? undefined : (max == null ? null : Number(max)),
      coupureWilling: coupures,
      slotsByDay: normalizedSlots,
    });
    return `${lines.join("\n")}\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
  },
};

registerHandler("update_preferences_confirmed", async (args, ctx) => {
  try {
    await apiPost("/me/preferences", {
      maxWeeklyHours: args.maxWeeklyHours as number | null | undefined,
      coupureWilling: args.coupureWilling as boolean | undefined,
      slotsByDay: (args.slotsByDay as Record<string, SlotPatch>) || {},
    }, ctx);
    return "Préférences mises à jour. ✅";
  } catch (err) {
    return formatInternalApiError(err);
  }
});

// ── Open shifts ──

const claimOpenShiftTool: ToolDef = {
  name: "claim_open_shift",
  description: "Prendre un service ouvert que le gérant a publié à l'équipe. Premier qui répond, premier servi. À utiliser quand l'employé dit \"je prends\", \"j'y vais\", \"je peux le faire\", \"ok pour moi\", etc. en réponse à une annonce de service ouvert.",
  parameters: {},
  async execute(_args, ctx) {
    if (ctx.role === "admin") {
      return "En tant que gérant, tu publies des services ouverts depuis le tableau de bord. Tu ne les prends pas toi-même.";
    }

    try {
      const res = await apiPost<{ data: { date: string; startTime: string; endTime: string } }>("/me/open-shifts/claim", {}, ctx);
      return `C'est noté ! Service confirmé le ${res.data.date} de ${res.data.startTime} à ${res.data.endTime}. Le gérant est prévenu.`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const declineOpenShiftTool: ToolDef = {
  name: "decline_open_shift",
  description: "Refuser un service ouvert proposé par le gérant. À utiliser quand l'employé répond \"non\", \"pas dispo\", \"je peux pas\", \"désolé\" à une annonce de service ouvert.",
  parameters: {},
  async execute(_args, ctx) {
    if (ctx.role === "admin") return "En tant que gérant, tu ne refuses pas les services ouverts.";

    try {
      const res = await apiPost<{ data: { date: string; startTime: string; endTime: string } }>("/me/open-shifts/decline", {}, ctx);
      return `C'est noté, j'ai prévenu le gérant que tu refuses le service du ${res.data.date} ${res.data.startTime}-${res.data.endTime}.`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

// ── Export full worker manifest ──

export const WORKER_TOOLS: ToolDef[] = [
  mySchedule,
  myNextService,
  myHours,
  reportUnavailable,
  respondReplacement,
  requestHoliday,
  myPendingReplacements,
  clockIn,
  clockOut,
  myHolidays,
  claimOpenShiftTool,
  declineOpenShiftTool,
  myPreferences,
  updatePreferences,
];
