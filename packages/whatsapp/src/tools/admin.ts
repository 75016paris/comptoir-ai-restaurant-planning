/**
 * Admin tool manifest — extends worker tools with full management capabilities.
 * Every tool pre-injects restaurantId. The LLM cannot access other restaurants.
 *
 * New in v2: dynamic zones from service templates, weather, calendar events,
 * closures list, revenue logging/checking.
 */

import type { ToolContext, ToolDef } from "./types.js";
import { WORKER_TOOLS } from "./worker.js";
import { apiGet, apiPost, WhatsAppApiError } from "../api-client.js";
import { resolveRelativeDate } from "../date-resolver.js";
import { setPending, confirmActionTool, registerHandler } from "./confirmation.js";
import { can, hasChefLabel, todayInTimeZone } from "@comptoir/shared";
import { isWeekLocked, WEEK_LOCKED_ERROR } from "../../../api/src/utils/week-lock.js";

// ── Helpers ──

/** Format Date as YYYY-MM-DD in local timezone (not UTC). */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function monday(ref?: Date): Date {
  const d = new Date(ref || new Date());
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d;
}

function serviceHours(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60;
  return Math.round(diff / 60 * 100) / 100;
}

const DAY_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
function dayName(dateStr: string): string {
  return DAY_FR[new Date(dateStr + "T12:00:00").getDay()];
}

/** Resolve week bounds from date text OR week_offset. Date takes priority.
 *  On Sunday with no explicit date/offset, defaults to next week (current week is over). */
function resolveWeek(args: { date?: string; week_offset?: number }, timeZone?: string): { mon: Date; sun: Date } {
  let ref: Date | undefined;
  if (args.date && typeof args.date === "string") {
    const resolved = resolveRelativeDate(args.date, { timeZone });
    if (resolved) ref = new Date(resolved + "T12:00:00");
  }
  const today = new Date(`${todayInTimeZone(timeZone)}T12:00:00`);
  const mon = monday(ref ?? today);
  const offset = args.week_offset ?? 0;
  // On Sunday with no explicit date/offset → default to next week
  const isSunday = today.getDay() === 0;
  const effectiveOffset = (!ref && offset === 0 && isSunday) ? 1 : offset;
  if (effectiveOffset) mon.setDate(mon.getDate() + effectiveOffset * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { mon, sun };
}

// ── Print redirect for long responses ──
// Meta Cloud API cap: 4096 chars/message. Instead of splitting into multiple
// messages, we summarize long schedule responses and redirect to the print page.

const APP_URL = process.env.FRONTEND_URL || "https://comptoir.cosmobot.fr";
const PRINT_THRESHOLD = 3800; // chars — Meta cap is 4096, leave room for print hint

function withPrintHint(response: string, role: "admin" | "manager" | "kitchen" | "floor"): string {
  if (response.length <= PRINT_THRESHOLD) return response;
  const url = (role === "admin" || role === "manager") ? `${APP_URL}/schedule` : `${APP_URL}/my-schedule`;
  // Keep first ~900 chars (the first few days) + add print hint
  const truncated = response.slice(0, 900);
  const lastNewline = truncated.lastIndexOf("\n");
  const clean = lastNewline > 200 ? truncated.slice(0, lastNewline) : truncated;
  return `${clean}\n\n_(suite tronquée)_\n\n📄 Pour le planning complet → *Imprimer* sur ${url}`;
}

// ── Name matching (PI-06) ──

function findWorkerByName(
  workers: Array<{ id: string; name: string }>,
  input: string,
): { worker: typeof workers[0] | null; ambiguous: string[] } {
  const namePart = input.toLowerCase().trim();
  if (!namePart) return { worker: null, ambiguous: [] };
  const exactFirst = workers.filter((w) => w.name.toLowerCase().split(" ")[0] === namePart);
  if (exactFirst.length === 1) return { worker: exactFirst[0], ambiguous: [] };
  const exact = workers.filter((w) => w.name.toLowerCase() === namePart);
  if (exact.length === 1) return { worker: exact[0], ambiguous: [] };
  const partial = workers.filter((w) => w.name.toLowerCase().includes(namePart));
  if (partial.length === 1) return { worker: partial[0], ambiguous: [] };
  if (partial.length > 1) return { worker: null, ambiguous: partial.map((w) => w.name) };
  return { worker: null, ambiguous: [] };
}

// ── Date resolution helper ──

function resolveDateOrError(input: string, timeZone?: string): { date: string } | { error: string } {
  const resolved = resolveRelativeDate(input, { timeZone });
  if (!resolved) return { error: `Je n'ai pas compris la date "${input}". Essaie: "lundi", "demain", "2026-04-05".` };
  return { date: resolved };
}

// ── Date/time validation ──

const TIME_REGEX = /^([01]?\d|2[0-3]):[0-5]\d$/;
function validateTime(time: string): boolean { return TIME_REGEX.test(time); }
function isDatePast(dateStr: string, timeZone?: string): boolean { return dateStr < todayInTimeZone(timeZone); }
function offsetRestaurantDate(timeZone: string | undefined, days: number): string {
  const d = new Date(`${todayInTimeZone(timeZone)}T12:00:00`);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

type InternalTeamMember = {
  id: string;
  name: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  priority: number;
  subRoles: string | null;
  contractHours: number | null;
  phone?: string | null;
  active: boolean;
  restaurantIds?: string[];
  restaurantNames?: string[];
};

type InternalApiErrorBody = {
  error?: string;
  ambiguous?: string[];
  team?: string[];
};

type InternalReplacementReviewResult = {
  data: {
    decision: "pick" | "broadcast" | "refuse" | "approve_absence";
    requesterName: string | null;
    service: { date: string; startTime: string; endTime: string } | null;
    pickedName: string | null;
    candidateCount: number | null;
    status: string;
  };
};

function formatInternalApiError(err: unknown, requestedName?: string): string {
  if (err instanceof WhatsAppApiError) {
    const body = err.body as InternalApiErrorBody | undefined;
    if (err.status === 403) return "Je n'ai pas l'autorisation d'accéder à ces informations.";
    if (err.status === 409 && body?.ambiguous?.length) {
      return `Plusieurs employés correspondent:\n${body.ambiguous.map((n, i) => `${i + 1}. ${n}`).join("\n")}\nPrécise le nom complet.`;
    }
    if (err.status === 404 && requestedName) {
      const suffix = body?.team?.length ? ` Équipe: ${body.team.join(", ")}` : "";
      return `Employé "${requestedName}" non trouvé.${suffix}`;
    }
    if (err.status === 404 && body?.error) return body.error;
    if (err.status === 400) return body?.error || "Paramètres invalides.";
    if (err.status === 409 || err.status === 423) return body?.error || err.message;
  }
  return "Erreur: l'opération a échoué.";
}

async function resolveInternalWorker(name: string, scope: "team" | "hours" | "leave", ctx: ToolContext): Promise<InternalTeamMember | string> {
  try {
    const res = await apiGet<{ data: { worker: InternalTeamMember } }>(
      `/workers/resolve?name=${encodeURIComponent(name)}&scope=${scope}`,
      ctx,
    );
    return res.data.worker;
  } catch (err) {
    return formatInternalApiError(err, name);
  }
}

// ── Admin-only tools ──

const teamSchedule: ToolDef = {
  name: "team_schedule",
  requiredPermission: "TEAM_VIEW",
  description: "Planning de la semaine entière (tous les jours). Utilise team_on_date si la question porte sur UN seul jour.",
  parameters: {
    date: { type: "string", description: "Texte exact de l'utilisateur: 'lundi prochain', 'semaine prochaine', 'demain'. L'outil calcule la semaine contenant cette date.", required: false },
    week_offset: { type: "number", description: "Fallback: 0 = cette semaine, 1 = prochaine, -1 = dernière. Ignoré si date est fourni.", required: false },
  },
  async execute(args, ctx) {
    const params = new URLSearchParams();
    if (args.date) params.set("date", String(args.date));
    if (args.week_offset != null) params.set("week_offset", String(args.week_offset));

    try {
      const res = await apiGet<{ data: {
        from: string;
        to: string;
        zones: string[];
        closures: Array<{ startDate: string; endDate: string }>;
        scope?: "restaurant" | "owner";
        services: Array<{ date: string; startTime: string; endTime: string; role: "kitchen" | "floor"; workerName: string; hours: number; zone: string; restaurantName?: string }>;
        totalHours: number;
      } }>(`/team/schedule${params.size ? `?${params.toString()}` : ""}`, ctx);
      const data = res.data;
      const rows = data.services;
      const isClosedOn = (d: string) => data.closures.some(c => d >= c.startDate && d <= c.endDate);
      const byDate = new Map<string, typeof rows>();
      for (const r of rows) {
        if (!byDate.has(r.date)) byDate.set(r.date, []);
        byDate.get(r.date)!.push(r);
      }

      const lines: string[] = [];
      if (data.scope === "owner") lines.push("*Planning multi-resto:*");
      const mon = new Date(`${data.from}T12:00:00`);
      for (let i = 0; i < 7; i++) {
        const d = new Date(mon);
        d.setDate(mon.getDate() + i);
        const dateStr = fmtDate(d);
        const dayServices = byDate.get(dateStr) || [];

        if (isClosedOn(dateStr)) {
          lines.push(`*${dayName(dateStr)} ${dateStr}:* FERMÉ`);
          continue;
        }
        if (!dayServices.length) {
          lines.push(`*${dayName(dateStr)} ${dateStr}:* aucun service`);
          continue;
        }

        lines.push(`*${dayName(dateStr)} ${dateStr}:*`);
        const byRestaurant = data.scope === "owner"
          ? [...new Set(dayServices.map((s) => s.restaurantName || "Restaurant"))].map((name) => ({ name, rows: dayServices.filter((s) => (s.restaurantName || "Restaurant") === name) }))
          : [{ name: "", rows: dayServices }];
        for (const group of byRestaurant) {
          if (group.name) lines.push(`  _${group.name}_`);
          for (const zone of data.zones) {
            const zoneServices = group.rows.filter((s) => s.zone === zone);
            if (!zoneServices.length) continue;
            const kitchen = zoneServices.filter((s) => s.role === "kitchen");
            const salleStaff = zoneServices.filter((s) => s.role === "floor");
            const parts: string[] = [];
            if (kitchen.length) parts.push(`${kitchen.length} cuisine`);
            if (salleStaff.length) parts.push(`${salleStaff.length} salle`);
            lines.push(`  ${zone}: ${parts.join(" + ")}`);
          }
        }
      }

      if (!rows.length) return `Aucun service du ${data.from} au ${data.to}.`;
      lines.push(`\nTotal: ${rows.length} services, ${Math.round(data.totalHours)}h`);
      return withPrintHint(lines.join("\n"), "admin");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const addService: ToolDef = {
  name: "add_service",
  requiredPermission: "PLANNING_EDIT",
  description: "Ajouter un service pour un employé.",
  parameters: {
    worker_name: { type: "string", description: "Nom (ou début du nom) de l'employé" },
    date: { type: "string", description: "Passe le texte exact de l'utilisateur: 'jeudi prochain', 'demain', etc." },
    zone: { type: "string", description: "OBLIGATOIRE si mentionné: midi, soir, matin, après-midi. Extrais-le du message utilisateur." },
    start_time: { type: "string", description: "Heure de début HH:MM (optionnel si zone précisée)", required: false },
    end_time: { type: "string", description: "Heure de fin HH:MM (optionnel si zone précisée)", required: false },
    role: { type: "string", description: "kitchen ou server (auto-détecté depuis l'employé)", required: false },
  },
  async execute(args, ctx) {
    const role = args.role as string | undefined;

    const dateResult = resolveDateOrError(args.date as string, ctx.restaurantTimezone);
    if ("error" in dateResult) return dateResult.error;
    const resolvedDate = dateResult.date;

    if (isDatePast(resolvedDate, ctx.restaurantTimezone)) {
      return `La date ${dayName(resolvedDate)} ${resolvedDate} est dans le passé.`;
    }

    let startTime = args.start_time as string;
    let endTime = args.end_time as string;
    if (startTime && !TIME_REGEX.test(startTime)) startTime = "";
    if (endTime && !TIME_REGEX.test(endTime)) endTime = "";
    if (startTime && !validateTime(startTime)) return `Heure de début invalide: "${startTime}". Format: HH:MM (ex: 09:00).`;
    if (endTime && !validateTime(endTime)) return `Heure de fin invalide: "${endTime}". Format: HH:MM (ex: 23:00).`;

    try {
      const res = await apiPost<{ data: {
        status: "needs_zone" | "duplicate" | "overlap" | "ok";
        worker: { id: string; name: string };
        date: string;
        zones?: string[];
        startTime?: string;
        endTime?: string;
        role?: "kitchen" | "floor";
        zone?: string;
        overlap?: { startTime: string; endTime: string };
      } }>("/planning/services/prepare", {
        workerName: args.worker_name,
        date: resolvedDate,
        dateText: args.date,
        zone: args.zone,
        startTime,
        endTime,
        role,
        lastUserMessage: ctx.lastUserMessage,
      }, ctx);
      const data = res.data;
      if (data.status === "needs_zone") {
        const zoneSentence = data.zones?.length ? data.zones.join(", ") : "aucune zone configurée";
        return `[ACTION NON EFFECTUÉE] Le service de ${data.worker.name} le ${dayName(resolvedDate)} ${resolvedDate} n'a PAS été ajouté. Demande à l'utilisateur quelle zone parmi : ${zoneSentence}. Tu ne dois pas dire "ajouté" ou "fait" tant qu'il n'a pas répondu.`;
      }
      if (data.status === "duplicate") {
        return `${data.worker.name} a déjà exactement ce service (*${data.zone}* ${data.startTime}-${data.endTime}) le ${dayName(resolvedDate)} ${resolvedDate}. Pas besoin de l'ajouter à nouveau.`;
      }
      setPending(ctx.userId, "add_service_confirmed", {
        workerId: data.worker.id, workerName: data.worker.name,
        date: resolvedDate, startTime: data.startTime, endTime: data.endTime, role: data.role,
      });
      if (data.status === "overlap") {
        return `⚠️ ${data.worker.name} a déjà un service (${data.overlap!.startTime}-${data.overlap!.endTime}) le ${dayName(resolvedDate)} ${resolvedDate}. Ajouter quand même *${data.zone}* (${data.startTime}-${data.endTime}) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
      }
      return `Ajouter *${data.worker.name}* le ${dayName(resolvedDate)} ${resolvedDate} en *${data.zone}* (${data.startTime}-${data.endTime}, ${data.role === "kitchen" ? "cuisine" : "floor"}) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
    } catch (err) {
      return formatInternalApiError(err, args.worker_name as string);
    }
  },
};

const deleteService: ToolDef = {
  name: "delete_service",
  requiredPermission: "PLANNING_EDIT",
  description: "Supprimer un service d'un employé.",
  parameters: {
    worker_name: { type: "string", description: "Nom de l'employé" },
    date: { type: "string", description: "Date du service: 'demain', 'mercredi prochain', etc." },
    zone: { type: "string", description: "Zone (si l'employé a plusieurs services ce jour)", required: false },
  },
  async execute(args, ctx) {
    const dateResult = resolveDateOrError(args.date as string, ctx.restaurantTimezone);
    if ("error" in dateResult) return dateResult.error;
    const resolvedDate = dateResult.date;

    try {
      const res = await apiPost<{ data: {
        status: "none" | "multiple" | "ok";
        worker: { id: string; name: string };
        date: string;
        services?: Array<{ id: string; startTime: string; endTime: string; zone: string }>;
        service?: { id: string; startTime: string; endTime: string; zone: string };
      } }>("/planning/services/prepare-delete", { workerName: args.worker_name, date: resolvedDate, zone: args.zone }, ctx);
      const data = res.data;
      if (data.status === "none") return `${data.worker.name} n'a pas de service le ${dayName(resolvedDate)} ${resolvedDate}.`;
      if (data.status === "multiple") {
        const options = data.services!.map((s, i) => `${i + 1}. ${s.zone} (${s.startTime}-${s.endTime})`);
        return `${data.worker.name} a ${data.services!.length} services le ${dayName(resolvedDate)} ${resolvedDate}:\n${options.join("\n")}\nLequel supprimer ?`;
      }
      const target = data.service!;
      setPending(ctx.userId, "delete_service_confirmed", { serviceId: target.id });
      return `Supprimer le service de *${data.worker.name}* le ${dayName(resolvedDate)} ${resolvedDate} en ${target.zone} (${target.startTime}-${target.endTime}) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
    } catch (err) {
      return formatInternalApiError(err, args.worker_name as string);
    }
  },
};

const reviewHoliday: ToolDef = {
  name: "review_holiday",
  requiredPermission: "LEAVE_APPROVE",
  description: "Approuver ou refuser une demande de congé.",
  parameters: {
    worker_name: { type: "string", description: "Nom de l'employé" },
    decision: { type: "string", description: "approved ou rejected", enum: ["approved", "rejected"] },
  },
  async execute(args, ctx) {
    const decision = args.decision as string;
    if (decision !== "approved" && decision !== "rejected") {
      return "Décision invalide. Utilise 'approved' ou 'rejected'.";
    }

    const worker = await resolveInternalWorker(args.worker_name as string, "leave", ctx);
    if (typeof worker === "string") return worker;

    let pending: { id: string; startDate: string; endDate: string };
    try {
      const res = await apiGet<{ data: { request: { id: string; startDate: string; endDate: string } } }>(`/workers/${encodeURIComponent(worker.id)}/holidays/pending/latest`, ctx);
      pending = res.data.request;
    } catch (err) {
      return formatInternalApiError(err);
    }

    const verb = decision === "approved" ? "Approuver" : "Refuser";
    setPending(ctx.userId, "review_holiday_confirmed", {
      requestId: pending.id, decision,
      workerName: worker.name, startDate: pending.startDate, endDate: pending.endDate,
    });
    return `${verb} le congé de *${worker.name}* (${dayName(pending.startDate)} ${pending.startDate} → ${dayName(pending.endDate)} ${pending.endDate}) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
  },
};

const addWorkerHoliday: ToolDef = {
  name: "add_worker_holiday",
  requiredPermission: "LEAVE_APPROVE",
  description: "Enregistrer une absence/congé pour un employé (auto-approuvé).",
  parameters: {
    worker_name: { type: "string", description: "Nom de l'employé" },
    start_date: { type: "string", description: "Date de début: 'lundi prochain', 'demain', 'YYYY-MM-DD'" },
    end_date: { type: "string", description: "Date de fin (optionnel, même jour si omis)", required: false },
    reason: { type: "string", description: "Motif (optionnel)", required: false },
  },
  async execute(args, ctx) {
    const worker = await resolveInternalWorker(args.worker_name as string, "leave", ctx);
    if (typeof worker === "string") return worker;

    const startResult = resolveDateOrError(args.start_date as string, ctx.restaurantTimezone);
    if ("error" in startResult) return startResult.error;
    const start = startResult.date;

    let end = start;
    if (args.end_date) {
      const endResult = resolveDateOrError(args.end_date as string, ctx.restaurantTimezone);
      if ("error" in endResult) return endResult.error;
      end = endResult.date;
    }

    if (start > end) return "La date de début doit être avant la date de fin.";

    const days = Math.ceil((new Date(end + "T12:00:00").getTime() - new Date(start + "T12:00:00").getTime()) / 86400000) + 1;

    setPending(ctx.userId, "add_worker_holiday_confirmed", {
      workerId: worker.id,
      workerName: worker.name,
      startDate: start,
      endDate: end,
      reason: (args.reason as string) || null,
      days,
    });
    return `Enregistrer une absence pour *${worker.name}* du ${dayName(start)} ${start} au ${dayName(end)} ${end} (${days} jour${days > 1 ? "s" : ""})${args.reason ? ` — ${args.reason}` : ""} ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
  },
};

const pendingRequests: ToolDef = {
  name: "pending_requests",
  requiredPermission: "TEAM_VIEW",
  description: "Affiche les demandes en attente (congés + remplacements).",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiGet<{ data: {
        holidays: Array<{ workerName: string; startDate: string; endDate: string; reason: string | null }>;
        replacements: Array<{ requesterName: string; message: string | null; status: string }>;
      } }>("/requests/pending", ctx);
      const { holidays, replacements } = res.data;
      const lines: string[] = [];
      if (holidays.length) {
        lines.push(`*Congés en attente (${holidays.length}):*`);
        for (const h of holidays) {
          lines.push(`  ${h.workerName}: ${h.startDate} → ${h.endDate}${h.reason ? ` (${h.reason})` : ""}`);
        }
      }
      if (replacements.length) {
        lines.push(`\n*Remplacements en attente (${replacements.length}):*`);
        for (const s of replacements) {
          const phase = s.status === "awaiting_admin_decision" ? "à toi de choisir" : "proposé, en attente du collègue";
          lines.push(`  ${s.requesterName}: ${s.message || "(pas de message)"} — _${phase}_`);
        }
      }
      if (!lines.length) return "Aucune demande en attente. 👌";
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const reviewReplacement: ToolDef = {
  name: "review_replacement",
  requiredPermission: "REPLACEMENT_APPROVE",
  description: "Décider quoi faire d'une demande de remplacement (le gérant choisit un collègue, broadcaste à tous, ou refuse). À utiliser quand le gérant répond à la liste de candidats : 'propose à Paul', 'envoie à tous', 'refuse le remplacement de Marie', 'annule'.",
  parameters: {
    requester_name: { type: "string", description: "Prénom de l'employé qui ne peut pas venir (optionnel s'il n'y a qu'une seule demande en attente)", required: false },
    decision: { type: "string", description: "pick = proposer à un collègue précis (nécessite candidate_name) ; broadcast = proposer à tous les candidats ; refuse = annuler la demande", enum: ["pick", "broadcast", "refuse"] },
    candidate_name: { type: "string", description: "Prénom du collègue à qui proposer le remplacement (obligatoire si decision=pick)", required: false },
  },
  async execute(args, ctx) {
    const decision = args.decision as "pick" | "broadcast" | "refuse";
    if (!["pick", "broadcast", "refuse"].includes(decision)) {
      return "Décision invalide. Utilise pick, broadcast ou refuse.";
    }

    try {
      const res = await apiPost<{ data: {
        status: string;
        ambiguous?: string[];
        requesters?: string[];
        requesterName?: string;
        replacementId?: string;
        requesterId?: string;
        service?: { date: string; startTime: string; endTime: string } | null;
        svcLabel?: string;
        candidateIds?: string[];
        candidateNames?: string[];
        candidateName?: string;
        available?: string[];
        pickedId?: string;
        pickedName?: string;
      } }>("/replacements/review/prepare", {
        requesterName: args.requester_name,
        decision,
        candidateName: args.candidate_name,
      }, ctx);
      const data = res.data;

      if (data.status === "no_requests") return "Aucune demande de remplacement en attente.";
      if (data.status === "requester_ambiguous") return `Plusieurs demandes correspondent:\n${data.ambiguous!.map((n, i) => `${i + 1}. ${n}`).join("\n")}\nPrécise le prénom complet.`;
      if (data.status === "requester_not_found") return `Aucune demande de remplacement pour "${data.requesterName}".`;
      if (data.status === "multiple_requests") return `Plusieurs demandes en attente. Précise pour qui :\n${data.requesters!.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;
      if (data.status === "no_candidates") return `Plus aucun candidat disponible pour le service de *${data.requesterName}*. Refuse la demande ou trouve quelqu'un manuellement.`;
      if (data.status === "pick_needs_candidate") return "Pour proposer à un seul collègue, donne son nom (ex: 'propose à Paul').";
      if (data.status === "pick_ambiguous") return `Plusieurs candidats correspondent:\n${data.ambiguous!.map((n, i) => `${i + 1}. ${n}`).join("\n")}\nPrécise le prénom complet.`;
      if (data.status === "pick_not_candidate") return `"${data.candidateName}" n'est pas dans la liste des candidats. Disponibles: ${data.available!.join(", ")}.`;

      if (data.status === "refuse_ready") {
        setPending(ctx.userId, "review_replacement_refuse_confirmed", {
          replacementId: data.replacementId,
          requesterId: data.requesterId,
          requesterName: data.requesterName,
          date: data.service?.date ?? "?",
        });
        return `Refuser la demande de remplacement de *${data.requesterName}* pour la ${data.svcLabel} ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
      }

      if (data.status === "broadcast_ready") {
        setPending(ctx.userId, "review_replacement_broadcast_confirmed", {
          replacementId: data.replacementId,
          requesterId: data.requesterId,
          requesterName: data.requesterName,
          candidateIds: data.candidateIds,
          candidateNames: data.candidateNames,
          date: data.service?.date ?? "?",
          startTime: data.service?.startTime ?? "?",
          endTime: data.service?.endTime ?? "?",
        });
        return `Proposer le service de *${data.requesterName}* (${data.svcLabel}) à ${data.candidateIds!.length} collègue${data.candidateIds!.length > 1 ? "s" : ""} (${data.candidateNames!.join(", ")}) ?\nLe premier qui accepte prend le service. Réponds *oui* pour confirmer.`;
      }

      setPending(ctx.userId, "review_replacement_pick_confirmed", {
        replacementId: data.replacementId,
        requesterId: data.requesterId,
        requesterName: data.requesterName,
        pickedId: data.pickedId,
        pickedName: data.pickedName,
        date: data.service?.date ?? "?",
        startTime: data.service?.startTime ?? "?",
        endTime: data.service?.endTime ?? "?",
      });
      return `Proposer à *${data.pickedName}* de remplacer *${data.requesterName}* (${data.svcLabel}) ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const teamOnDate: ToolDef = {
  name: "team_on_date",
  requiredPermission: "TEAM_VIEW",
  description: "Liste détaillée des noms et horaires pour UN jour précis. Utilise cet outil dès qu'on demande 'qui travaille [jour]' ou 'l'équipe de [jour]'.",
  parameters: {
    date: { type: "string", description: "Date: 'aujourd'hui', 'demain', 'lundi prochain', 'YYYY-MM-DD'", required: false },
  },
  async execute(args, ctx) {
    const params = new URLSearchParams();
    if (args.date) params.set("date", String(args.date));
    try {
      const res = await apiGet<{ data: { date: string; scope?: "restaurant" | "owner"; zones: string[]; services: Array<{ workerName: string; startTime: string; endTime: string; role: "kitchen" | "floor"; zone: string; restaurantName?: string }> } }>(`/team/on-date${params.size ? `?${params.toString()}` : ""}`, ctx);
      const { date, zones, services: rows, scope } = res.data;

      const lines: string[] = rows.length ? [`*Équipe du ${dayName(date)} ${date}${scope === "owner" ? " (multi-resto)" : ""}:*`] : [`Personne ne travaille le ${dayName(date)} ${date}.`];
      const byRestaurant = scope === "owner"
        ? [...new Set(rows.map((r) => r.restaurantName || "Restaurant"))].map((name) => ({ name, rows: rows.filter((r) => (r.restaurantName || "Restaurant") === name) }))
        : [{ name: "", rows }];
      for (const group of byRestaurant) {
        if (group.name) lines.push(`\n_${group.name}_`);
        for (const zone of zones) {
          const zoneServices = group.rows.filter((r) => r.zone === zone);
          if (!zoneServices.length) continue;
          lines.push(`\n*${zone}:*`);
          for (const r of zoneServices) {
            const roleIcon = r.role === "kitchen" ? "🍳" : "🍽️";
            lines.push(`  ${roleIcon} ${r.workerName} ${r.startTime}-${r.endTime}`);
          }
        }
      }

      try {
        if (scope === "owner") return lines.join("\n");
        const gapRes = await apiGet<{ data: {
          zones: Array<{
            zone: string;
            kitchen: { target: number; actual: number; missing: number };
            floor: { target: number; actual: number; missing: number };
          }>;
        } }>(`/team/staffing-gap?date=${encodeURIComponent(date)}`, ctx);
        const missing: string[] = [];
        for (const zone of gapRes.data.zones) {
          if (zone.kitchen.missing > 0) missing.push(`${zone.kitchen.missing} en cuisine sur ${zone.zone}`);
          if (zone.floor.missing > 0) missing.push(`${zone.floor.missing} en salle sur ${zone.zone}`);
        }
        if (missing.length) {
          lines.push(`\n⚠️ *Attention : objectif non couvert* — il manque ${missing.join(", ")}.`);
          lines.push("Je peux te donner la *reco du solver* pour choisir qui contacter.");
        }
      } catch {
        // Ne bloque pas l'affichage du planning si l'objectif n'est pas disponible.
      }

      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const listTeam: ToolDef = {
  name: "list_team",
  requiredPermission: "TEAM_VIEW",
  description: "Liste tous les employés du restaurant.",
  parameters: {},
  async execute(_args, ctx) {
    let workers: InternalTeamMember[];
    try {
      const res = await apiGet<{ data: { members: InternalTeamMember[] } }>("/team", ctx);
      workers = res.data.members;
    } catch (err) {
      return formatInternalApiError(err);
    }

    if (!workers.length) return "Aucun employé.";

    const isChef = (subRolesJson: string | null) => {
      try {
        const arr: string[] = JSON.parse(subRolesJson || "[]");
        return hasChefLabel(arr);
      } catch { return false; }
    };

    const kitchen = workers.filter((w) => w.role === "kitchen");
    const salleStaff = workers.filter((w) => w.role === "floor");

    const lines: string[] = [];
    if (kitchen.length) {
      lines.push(`*Cuisine (${kitchen.length}):*`);
      for (const w of kitchen) lines.push(`  P${w.priority} ${w.name}${isChef(w.subRoles) ? " 👑" : ""}`);
    }
    if (salleStaff.length) {
      lines.push(`\n*Salle (${salleStaff.length}):*`);
      for (const w of salleStaff) lines.push(`  P${w.priority} ${w.name}${isChef(w.subRoles) ? " 👑" : ""}`);
    }
    return lines.join("\n");
  },
};

const addClosure: ToolDef = {
  name: "add_closure",
  requiredPermission: "RESTAURANT_SETTINGS",
  description: "Ajouter une fermeture du restaurant.",
  parameters: {
    start_date: { type: "string", description: "Date de début" },
    end_date: { type: "string", description: "Date de fin" },
    reason: { type: "string", description: "Raison de la fermeture", required: false },
  },
  async execute(args, ctx) {
    const startResult = resolveDateOrError(args.start_date as string, ctx.restaurantTimezone);
    if ("error" in startResult) return startResult.error;
    const startDate = startResult.date;

    const endResult = resolveDateOrError(args.end_date as string, ctx.restaurantTimezone);
    if ("error" in endResult) return endResult.error;
    const endDate = endResult.date;

    if (startDate > endDate) return `La date de début (${startDate}) est après la date de fin (${endDate}).`;

    setPending(ctx.userId, "add_closure_confirmed", {
      startDate, endDate, reason: (args.reason as string) || null,
    });
    return `Fermer le restaurant du ${dayName(startDate)} ${startDate} au ${dayName(endDate)} ${endDate}${args.reason ? ` (${args.reason})` : ""} ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
  },
};

const listClosures: ToolDef = {
  name: "list_closures",
  requiredPermission: "RESTAURANT_SETTINGS",
  description: "Affiche les fermetures programmées.",
  parameters: {},
  async execute(_args, ctx) {
    try {
      const res = await apiGet<{ data: { today: string; closures: Array<{ startDate: string; endDate: string; reason: string | null }> } }>("/closures", ctx);
      const { today, closures: rows } = res.data;
      if (!rows.length) return "Aucune fermeture programmée.";

      const lines = [`*Fermetures à venir:*`];
      for (const r of rows) {
        const now = r.startDate <= today && r.endDate >= today;
        lines.push(`  ${r.startDate} → ${r.endDate}${r.reason ? ` (${r.reason})` : ""}${now ? " ← EN COURS" : ""}`);
      }
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const weeklyRecap: ToolDef = {
  name: "weekly_recap",
  requiredPermission: "HOURS_VIEW",
  description: "Résumé des HEURES travaillées (pas le planning). Utilise team_schedule pour voir le planning.",
  parameters: {
    date: { type: "string", description: "Texte exact: 'semaine dernière', 'lundi prochain', etc. L'outil calcule la semaine.", required: false },
    week_offset: { type: "number", description: "Fallback: 0 = cette semaine, -1 = dernière. Ignoré si date fourni.", required: false },
  },
  async execute(args, ctx) {
    const params = new URLSearchParams();
    if (args.date) params.set("date", String(args.date));
    if (args.week_offset != null) params.set("week_offset", String(args.week_offset));

    try {
      const res = await apiGet<{ data: {
        from: string;
        to: string;
        serviceCount: number;
        totalHours: number;
        workers: Array<{ name: string; role: string; hours: number; services: number }>;
      } }>(`/team/weekly-recap${params.size ? `?${params.toString()}` : ""}`, ctx);
      const data = res.data;
      if (!data.serviceCount) return `Aucun service du ${data.from} au ${data.to}.`;

      const lines: string[] = [`*Récap ${data.from} → ${data.to}:*`];
      const otWorkers: string[] = [];
      for (const w of data.workers) {
        const ot = w.hours > 39 ? ` ⚠️ +${Math.round((w.hours - 39) * 10) / 10}h sup` : "";
        if (w.hours > 39) otWorkers.push(w.name.split(" ")[0]);
        lines.push(`  ${w.name}: ${Math.round(w.hours * 10) / 10}h (${w.services} services)${ot}`);
      }

      lines.push(`\n*Total:* ${data.serviceCount} services, ${Math.round(data.totalHours)}h`);
      lines.push(`*Équipe:* ${data.workers.length} personnes`);
      if (otWorkers.length) lines.push(`⚠️ *Heures sup:* ${otWorkers.join(", ")}`);

      return withPrintHint(lines.join("\n"), "admin");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

function weekRangeLabel(weekStart: string): string {
  return `${dayName(weekStart)} ${weekStart} → ${dayName(addDays(weekStart, 6))} ${addDays(weekStart, 6)}`;
}

const publishScheduleWeek: ToolDef = {
  name: "publish_schedule_week",
  requiredPermission: "PUBLISH_WEEK",
  description: "Publier le planning d'une semaine et l'envoyer à tous les employés planifiés. À utiliser quand l'admin dit 'publie le planning', 'publier la semaine' ou répond 'publier' au rappel de publication.",
  parameters: {
    date: { type: "string", description: "Semaine à publier: 'semaine prochaine', 'dans 2 semaines', date précise. Par défaut: semaine à communiquer sous ~15 jours si ambigu.", required: false },
    week_offset: { type: "number", description: "Fallback: 0 = cette semaine, 1 = semaine prochaine. Ignoré si date fourni.", required: false },
  },
  async execute(args, ctx) {
    if (!can({ role: ctx.role, permissions: ctx.permissions }, "PUBLISH_WEEK")) {
      return "Tu n'as pas le droit de publier les plannings.";
    }

    const effectiveArgs = { ...args };
    if (!effectiveArgs.date && effectiveArgs.week_offset == null) {
      effectiveArgs.date = addDays(todayInTimeZone(ctx.restaurantTimezone), 15);
    }
    const { mon, sun } = resolveWeek(effectiveArgs as any, ctx.restaurantTimezone);
    const weekStart = fmtDate(mon);
    const weekEnd = fmtDate(sun);

    try {
      const res = await apiPost<{ data: { status: "already_published" | "empty" | "ok"; serviceCount?: number; workerCount?: number } }>("/planning/weeks/prepare-publish", { weekStart, weekEnd }, ctx);
      const data = res.data;
      if (data.status === "already_published") return `Le planning ${weekRangeLabel(weekStart)} est déjà publié.`;
      if (data.status === "empty") return `Aucun service à publier pour la semaine ${weekRangeLabel(weekStart)}. Lance d'abord l'auto-staffing ou crée le planning.`;

      const serviceCount = data.serviceCount ?? 0;
      const workerCount = data.workerCount ?? 0;
      setPending(ctx.userId, "publish_schedule_week_confirmed", { weekStart, weekEnd, serviceCount, workerCount });
      return `Publier le planning ${weekRangeLabel(weekStart)} (${serviceCount} service${serviceCount > 1 ? "s" : ""}, ${workerCount} employé${workerCount > 1 ? "s" : ""}) et l'envoyer aux employés ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const complianceCheck: ToolDef = {
  name: "compliance_check",
  requiredPermission: "TEAM_VIEW",
  description: "Vérifie la conformité droit du travail pour une semaine.",
  parameters: {
    date: { type: "string", description: "Texte exact: 'semaine dernière', 'lundi'. L'outil calcule la semaine.", required: false },
    week_offset: { type: "number", description: "Fallback: 0 = cette semaine. Ignoré si date fourni.", required: false },
  },
  async execute(args, ctx) {
    const params = new URLSearchParams();
    if (args.date) params.set("date", String(args.date));
    if (args.week_offset != null) params.set("week_offset", String(args.week_offset));
    try {
      const res = await apiGet<{ data: { from: string; to: string; serviceCount: number; alerts: string[] } }>(`/team/compliance${params.size ? `?${params.toString()}` : ""}`, ctx);
      const data = res.data;
      if (!data.serviceCount) return "Aucun service cette semaine — rien à vérifier.";
      if (!data.alerts.length) return `✅ *Conforme* — aucune alerte pour la semaine du ${data.from}.`;

      const errors = data.alerts.filter((a) => a.startsWith("🛑")).length;
      const warnings = data.alerts.filter((a) => a.startsWith("⚠️")).length;
      const header = errors > 0
        ? `🔴 *${errors} erreur(s), ${warnings} alerte(s)* — semaine du ${data.from}`
        : `🟡 *${warnings} alerte(s)* — semaine du ${data.from}`;

      const MAX_ALERTS = 10;
      const shown = data.alerts.slice(0, MAX_ALERTS);
      const hidden = data.alerts.length - shown.length;
      const lines = [header, ...shown];
      if (hidden > 0) lines.push(`\n_(+ ${hidden} autres alertes — voir l'appli pour le détail)_`);
      return withPrintHint(lines.join("\n"), "admin");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const staffingGap: ToolDef = {
  name: "staffing_gap",
  requiredPermission: "TEAM_VIEW",
  description: "Comparer le planning réel à l'objectif d'effectif configuré. À utiliser pour: 'objectif ce soir', 'il manque du monde ?', 'on est assez ?', 'combien il manque en cuisine/salle'. Objectif = objectif de planning/effectif, jamais CA.",
  parameters: {
    date: { type: "string", description: "Date: 'ce soir', 'demain', 'mardi prochain', etc." },
    zone: { type: "string", description: "Zone spécifique (midi, soir, matin, etc.) si mentionnée", required: false },
  },
  async execute(args, ctx) {
    const dateResult = resolveDateOrError(args.date as string, ctx.restaurantTimezone);
    if ("error" in dateResult) return dateResult.error;
    const params = new URLSearchParams({ date: dateResult.date });
    const dateText = String(args.date || "").toLowerCase();
    const implicitZone = /\bsoir\b/.test(dateText) ? "soir" : /\bmidi\b/.test(dateText) ? "midi" : /\bmatin\b/.test(dateText) ? "matin" : "";
    if (args.zone || implicitZone) params.set("zone", String(args.zone || implicitZone));

    try {
      const res = await apiGet<{ data: {
        date: string;
        profileId: string | null;
        zones: Array<{
          zone: string;
          kitchen: { target: number; actual: number; missing: number; workers: string[] };
          floor: { target: number; actual: number; missing: number; workers: string[] };
        }>;
      } }>(`/team/staffing-gap?${params.toString()}`, ctx);
      const { date, zones } = res.data;
      if (!zones.length) return `Aucun objectif de planning configuré pour le ${dayName(date)} ${date}${args.zone ? ` en ${args.zone}` : ""}.`;

      const lines = [`*Objectif planning ${dayName(date)} ${date}:*`];
      let totalMissing = 0;
      for (const zone of zones) {
        lines.push(`\n*${zone.zone}:*`);
        const roles = [
          { label: "cuisine", icon: "🍳", data: zone.kitchen },
          { label: "salle", icon: "🍽️", data: zone.floor },
        ];
        for (const r of roles) {
          if (r.data.target <= 0 && r.data.actual <= 0) continue;
          totalMissing += r.data.missing;
          const missing = r.data.missing > 0 ? ` — il manque ${r.data.missing} personne${r.data.missing > 1 ? "s" : ""}` : " — OK";
          const workers = r.data.workers.length ? ` (${r.data.workers.join(", ")})` : "";
          lines.push(`  ${r.icon} ${r.label}: ${r.data.actual}/${r.data.target}${workers}${missing}`);
        }
      }
      lines.push(totalMissing > 0 ? `\n⚠️ Total: il manque ${totalMissing} personne${totalMissing > 1 ? "s" : ""}.\nTu veux la *reco du solver* pour choisir qui contacter ?` : "\n✅ Objectif couvert.");
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const solverRecommendation: ToolDef = {
  name: "solver_recommendation",
  requiredPermission: "TEAM_VIEW",
  description: "Recommandation du solver/ranking pour couvrir un service manquant. À utiliser quand le gérant demande 'reco du solver', 'qui tu recommandes ?', 'meilleur candidat', après un manque d'effectif.",
  parameters: {
    date: { type: "string", description: "Date du service manquant: 'ce soir', 'demain soir', 'mardi prochain', etc." },
    zone: { type: "string", description: "Zone/service manquant: midi, soir, matin, etc. Si le contexte précédent mentionne une zone, la reprendre.", required: false },
    role: { type: "string", description: "Rôle manquant si connu: kitchen/cuisine ou floor/salle", required: false },
  },
  async execute(args, ctx) {
    const dateResult = resolveDateOrError(args.date as string, ctx.restaurantTimezone);
    if ("error" in dateResult) return dateResult.error;

    const params = new URLSearchParams({ date: dateResult.date });
    const dateText = String(args.date || "").toLowerCase();
    const implicitZone = /\bsoir\b/.test(dateText) ? "soir" : /\bmidi\b/.test(dateText) ? "midi" : /\bmatin\b/.test(dateText) ? "matin" : "";
    if (args.zone || implicitZone) params.set("zone", String(args.zone || implicitZone));
    if (args.role) params.set("role", String(args.role));

    try {
      const res = await apiGet<{ data: {
        date: string;
        status: "ok" | "covered" | "no_profile";
        recommendations: Array<{
          zone: string;
          role: "kitchen" | "floor";
          target: number;
          actual: number;
          missing: number;
          startTime: string;
          endTime: string;
          requiredSubRoles: string[];
          candidates: Array<{ id: string; name: string; score: number; reasons: string[] }>;
        }>;
      } }>(`/team/staffing-recommendation?${params.toString()}`, ctx);
      const { date, status, recommendations } = res.data;
      if (status === "no_profile") return `Aucun objectif de planning configuré pour le ${dayName(date)} ${date}.`;
      if (status === "covered" || !recommendations.length) return `L'objectif est déjà couvert pour le ${dayName(date)} ${date}.`;

      const lines = [`*Reco solver ${dayName(date)} ${date}:*`];
      for (const rec of recommendations) {
        const roleLabel = rec.role === "kitchen" ? "cuisine" : "salle";
        lines.push(`\n*${rec.zone} — ${roleLabel}* (${rec.actual}/${rec.target}, ${rec.startTime}-${rec.endTime})`);
        if (!rec.candidates.length) {
          lines.push("  Aucun candidat éligible trouvé.");
          continue;
        }
        const [best, ...others] = rec.candidates;
        const reason = best.reasons.length ? ` — ${best.reasons.join(", ")}` : "";
        lines.push(`  ✅ Reco: *${best.name}* (score ${Math.round(best.score)})${reason}`);
        if (others.length) {
          lines.push(`  Alternatives: ${others.slice(0, 3).map((c) => `*${c.name}* (${Math.round(c.score)})`).join(", ")}`);
        }
      }
      lines.push("\nTu peux dire: *demande à [nom] s'il peut prendre le service*.");
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const whoIsAvailable: ToolDef = {
  name: "who_is_available",
  requiredPermission: "TEAM_VIEW",
  description: "Lister les personnes disponibles un jour donné. Ne pas utiliser pour demander à un employé précis de prendre un service: utiliser request_worker_for_shift.",
  parameters: {
    date: { type: "string", description: "Date: 'demain', 'vendredi prochain', etc." },
    zone: { type: "string", description: "Zone spécifique (midi, soir, matin, etc.)", required: false },
  },
  async execute(args, ctx) {
    const params = new URLSearchParams();
    if (args.date) params.set("date", String(args.date));
    const dateText = String(args.date || "").toLowerCase();
    const implicitZone = /\bsoir\b/.test(dateText) ? "soir" : /\bmidi\b/.test(dateText) ? "midi" : /\bmatin\b/.test(dateText) ? "matin" : "";
    if (args.zone || implicitZone) params.set("zone", String(args.zone || implicitZone));
    try {
      const res = await apiGet<{ data: { date: string; zones: Array<{ zone: string; available: string[]; alreadyScheduled: string[]; unavailable: string[] }> } }>(`/team/availability${params.size ? `?${params.toString()}` : ""}`, ctx);
      const { date, zones } = res.data;
      const lines: string[] = [`*Disponibilités ${dayName(date)} ${date}:*`];
      for (const zone of zones) {
        lines.push(`\n*${zone.zone}:*`);
        if (zone.available.length) lines.push(`  ✅ Dispos: ${zone.available.join(", ")}`);
        if (zone.alreadyScheduled.length) lines.push(`  📅 Déjà placés: ${zone.alreadyScheduled.join(", ")}`);
        if (zone.unavailable.length) lines.push(`  ❌ Non dispo: ${zone.unavailable.join(", ")}`);
      }
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const requestWorkerForShift: ToolDef = {
  name: "request_worker_for_shift",
  requiredPermission: "PLANNING_EDIT",
  description: "Envoyer un message WhatsApp à un employé précis pour lui demander s'il veut prendre un service vacant. À utiliser pour: 'demande à Omar s'il peut prendre le service', 'propose le soir à Léa'. Ne réponds pas seulement qu'il est disponible: cet outil envoie la demande.",
  parameters: {
    worker_name: { type: "string", description: "Nom (ou début du nom) de l'employé à qui demander" },
    date: { type: "string", description: "Date du service: 'ce soir', 'demain soir', 'mardi prochain', etc." },
    zone: { type: "string", description: "Zone/service: midi, soir, matin, etc. Obligatoire si mentionné", required: false },
    message: { type: "string", description: "Message court optionnel à ajouter à la demande", required: false },
  },
  async execute(args, ctx) {
    const dateResult = resolveDateOrError(args.date as string, ctx.restaurantTimezone);
    if ("error" in dateResult) return dateResult.error;
    const resolvedDate = dateResult.date;
    if (isDatePast(resolvedDate, ctx.restaurantTimezone)) return `La date ${dayName(resolvedDate)} ${resolvedDate} est dans le passé.`;

    try {
      const res = await apiPost<{ data: {
        status: "needs_zone" | "overlap" | "not_candidate" | "sent";
        worker: { id: string; name: string };
        date: string;
        zones?: string[];
        startTime?: string;
        endTime?: string;
        role?: "kitchen" | "floor";
        overlap?: { startTime: string; endTime: string };
      } }>("/planning/open-shift/request-worker", {
        workerName: args.worker_name,
        date: resolvedDate,
        dateText: args.date,
        zone: args.zone,
        message: args.message,
        lastUserMessage: ctx.lastUserMessage,
      }, ctx);
      const data = res.data;
      if (data.status === "needs_zone") return `Quel service proposer à *${data.worker.name}* le ${dayName(resolvedDate)} ${resolvedDate} ? Options: ${data.zones?.join(", ") || "aucune zone configurée"}.`;
      if (data.status === "overlap") return `*${data.worker.name}* a déjà un service (${data.overlap!.startTime}-${data.overlap!.endTime}) le ${dayName(resolvedDate)} ${resolvedDate}. Je ne lui ai pas envoyé de demande.`;
      if (data.status === "not_candidate") return `*${data.worker.name}* n'est pas éligible/disponible pour ce service le ${dayName(resolvedDate)} ${resolvedDate} (${data.startTime}-${data.endTime}). Je ne lui ai pas envoyé de demande.`;
      return `Demande envoyée à *${data.worker.name}* pour le ${dayName(resolvedDate)} ${resolvedDate} (${data.startTime}-${data.endTime}). Il peut répondre *oui/je prends* ou *non*. Je te préviens dès sa réponse, et aussi sans retour sous ~10 minutes.`;
    } catch (err) {
      return formatInternalApiError(err, args.worker_name as string);
    }
  },
};

const workerHours: ToolDef = {
  name: "worker_hours",
  requiredPermission: "HOURS_VIEW",
  description: "Heures d'un employé pour une période donnée. Utilise cet outil quand le gérant demande les heures d'un membre de l'équipe.",
  parameters: {
    worker_name: { type: "string", description: "Nom de l'employé" },
    period: { type: "string", description: "'semaine' pour la semaine en cours, ou un mois: 'mars', '2026-03'. Par défaut mois en cours.", required: false },
  },
  async execute(args, ctx) {
    const requestedName = args.worker_name as string;
    const worker = await resolveInternalWorker(requestedName, "hours", ctx);
    if (typeof worker === "string") return worker;

    try {
      const res = await apiGet<{ data: { worker: InternalTeamMember; periodLabel: string; serviceCount: number; totalHours: number } }>(
        `/workers/${encodeURIComponent(worker.id)}/hours?period=${encodeURIComponent((args.period as string) || "")}`,
        ctx,
      );
      const data = res.data;
      return `*${data.worker.name}* (${data.periodLabel}): ${data.serviceCount} services, ${Math.round(data.totalHours * 10) / 10}h.`;
    } catch (err) {
      return formatInternalApiError(err, requestedName);
    }
  },
};

const workerSchedule: ToolDef = {
  name: "worker_schedule",
  requiredPermission: "TEAM_VIEW",
  description: "Planning d'un employé spécifique pour la semaine.",
  parameters: {
    worker_name: { type: "string", description: "Nom de l'employé" },
    date: { type: "string", description: "Semaine contenant cette date: 'cette semaine', 'semaine prochaine', 'lundi prochain'. Par défaut: cette semaine.", required: false },
    week_offset: { type: "number", description: "Fallback: 0 = cette semaine, 1 = prochaine, -1 = dernière. Ignoré si date fourni.", required: false },
  },
  async execute(args, ctx) {
    const requestedName = args.worker_name as string;
    const worker = await resolveInternalWorker(requestedName, "team", ctx);
    if (typeof worker === "string") return worker;

    const params = new URLSearchParams();
    if (args.date) params.set("date", String(args.date));
    if (args.week_offset != null) params.set("week_offset", String(args.week_offset));

    try {
      const res = await apiGet<{ data: {
        worker: InternalTeamMember;
        from: string;
        to: string;
        services: Array<{ date: string; startTime: string; endTime: string; role: "kitchen" | "floor"; hours: number; zone: string; restaurantName?: string }>;
        totalHours: number;
      } }>(`/workers/${encodeURIComponent(worker.id)}/schedule${params.size ? `?${params.toString()}` : ""}`, ctx);
      const data = res.data;
      if (data.services.length === 0) return `*${data.worker.name}* n'a aucun service du ${data.from} au ${data.to}.`;

      const lines = [`*Planning de ${data.worker.name} (${data.from} → ${data.to}):*`];
      for (const r of data.services) {
        const restaurant = r.restaurantName ? `, ${r.restaurantName}` : "";
        lines.push(`${dayName(r.date)} ${r.date} — ${r.startTime}-${r.endTime} (${r.hours}h, ${r.zone}, ${r.role === "kitchen" ? "cuisine" : "floor"}${restaurant})`);
      }
      lines.push(`\nTotal: ${data.services.length} services, ${Math.round(data.totalHours * 10) / 10}h`);
      return withPrintHint(lines.join("\n"), "admin");
    } catch (err) {
      return formatInternalApiError(err, requestedName);
    }
  },
};

const sendSchedule: ToolDef = {
  name: "send_schedule",
  requiredPermission: "TEAM_VIEW",
  description: "Envoyer le planning d'un employé par notification.",
  parameters: {
    worker_name: { type: "string", description: "Nom de l'employé" },
    date: { type: "string", description: "Semaine: 'cette semaine', 'semaine prochaine'. Par défaut: cette semaine.", required: false },
  },
  async execute(args, ctx) {
    const requestedName = args.worker_name as string;
    const worker = await resolveInternalWorker(requestedName, "team", ctx);
    if (typeof worker === "string") return worker;

    try {
      const res = await apiPost<{ data: { sent: boolean; worker: InternalTeamMember; from: string; to: string } }>(`/workers/${encodeURIComponent(worker.id)}/send-schedule`, {
        date: args.date as string | undefined,
        weekOffset: args.week_offset as number | undefined,
      }, ctx);
      const data = res.data;
      if (!data.sent) return `*${data.worker.name}* n'a aucun service du ${data.from} au ${data.to}. Rien à envoyer.`;
      return `✅ Planning envoyé à *${data.worker.name}* par notification.`;
    } catch (err) {
      return formatInternalApiError(err, requestedName);
    }
  },
};

// ── NEW: Weather ──

const WEATHER_CODES: Record<number, string> = {
  0: "☀️ Ciel dégagé", 1: "🌤️ Peu nuageux", 2: "⛅ Partiellement nuageux", 3: "☁️ Couvert",
  45: "🌫️ Brouillard", 48: "🌫️ Brouillard givrant",
  51: "🌦️ Bruine légère", 53: "🌦️ Bruine", 55: "🌧️ Bruine forte",
  61: "🌧️ Pluie légère", 63: "🌧️ Pluie", 65: "🌧️ Pluie forte",
  71: "🌨️ Neige légère", 73: "🌨️ Neige", 75: "❄️ Neige forte",
  80: "🌦️ Averses légères", 81: "🌧️ Averses", 82: "⛈️ Averses fortes",
  95: "⛈️ Orage", 96: "⛈️ Orage + grêle", 99: "⛈️ Orage + forte grêle",
};

const checkWeather: ToolDef = {
  name: "check_weather",
  requiredPermission: "TEAM_VIEW",
  description: "Météo du restaurant pour un jour donné.",
  parameters: {
    date: { type: "string", description: "Date: 'demain', 'samedi', 'YYYY-MM-DD'. Par défaut aujourd'hui.", required: false },
  },
  async execute(args, ctx) {
    const dateInput = (args.date as string) || "aujourd'hui";
    try {
      const res = await apiGet<{ data: { date: string; weather: { weatherCode: number | null; tempMin: number | null; tempMax: number | null; sunrise: string | null; sunset: string | null; normalTempMax: number | null } | null } }>(`/weather?date=${encodeURIComponent(dateInput)}`, ctx);
      const { date: dateStr, weather: row } = res.data;
      if (!row) return `Pas de données météo pour le ${dayName(dateStr)} ${dateStr}. Les prévisions couvrent les 7 prochains jours.`;

      const desc = WEATHER_CODES[row.weatherCode ?? -1] || "🌡️ Conditions variées";
      const lines = [`*Météo ${dayName(dateStr)} ${dateStr}:*`, desc];
      if (row.tempMin != null && row.tempMax != null) {
        lines.push(`🌡️ ${row.tempMin}°C → ${row.tempMax}°C`);
      }
      if (row.sunrise && row.sunset) {
        lines.push(`☀️ Lever ${row.sunrise.slice(11, 16)} — Coucher ${row.sunset.slice(11, 16)}`);
      }
      if (row.normalTempMax != null && row.tempMax != null) {
        const diff = row.tempMax - row.normalTempMax;
        if (Math.abs(diff) >= 3) {
          const sign = diff > 0 ? "+" : "";
          lines.push(`📊 ${sign}${diff}°C vs normale saisonnière`);
        }
      }
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

// ── NEW: Calendar events (jours fériés + vacances scolaires) ──

const checkCalendar: ToolDef = {
  name: "check_calendar",
  requiredPermission: "TEAM_VIEW",
  description: "Jours fériés et vacances scolaires à venir.",
  parameters: {
    month: { type: "string", description: "Mois à vérifier: 'avril', 'mai', 'YYYY-MM'. Par défaut mois en cours.", required: false },
  },
  async execute(args, ctx) {
    const params = new URLSearchParams();
    if (args.month) params.set("month", String(args.month));
    try {
      const res = await apiGet<{ data: { label: string; events: Array<{ type: "public_holiday" | "school_vacation"; date: string; endDate: string | null; name: string }> } }>(`/calendar${params.size ? `?${params}` : ""}`, ctx);
      const { label, events } = res.data;
      if (!events.length) return `Pas de jours fériés ni vacances scolaires en ${label}.`;

      const holidays = events.filter((e) => e.type === "public_holiday");
      const vacations = events.filter((e) => e.type === "school_vacation");

      const lines: string[] = [`*Calendrier ${label}:*`];
      if (holidays.length) {
        lines.push("\n*Jours fériés:*");
        for (const h of holidays) lines.push(`  🔴 ${dayName(h.date)} ${h.date} — ${h.name}`);
      }
      if (vacations.length) {
        lines.push("\n*Vacances scolaires:*");
        // Deduplicate by name
        const seen = new Set<string>();
        for (const v of vacations) {
          if (seen.has(v.name)) continue;
          seen.add(v.name);
          lines.push(`  🔵 ${v.name}${v.endDate ? ` (→ ${v.endDate})` : ""}`);
        }
      }
      return lines.join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

// ── NEW: Revenue ──

const checkRevenue: ToolDef = {
  name: "check_revenue",
  requiredPermission: "HOURS_VIEW",
  description: "Chiffre d'affaires du restaurant par jour, semaine ou mois.",
  parameters: {
    date: { type: "string", description: "Date ou mois: 'hier', 'mars', '2026-04-01'. Par défaut mois en cours.", required: false },
  },
  async execute(args, ctx) {
    const raw = (args.date as string || "").toLowerCase().trim();
    const params = new URLSearchParams();
    if (raw) params.set("date", raw);

    try {
      const res = await apiGet<{ data: { kind: "month"; label: string; rows: Array<{ date: string; amount: number }>; total?: number; avg?: number; best?: { date: string; amount: number } } | { kind: "day"; date: string; amount: number | null } }>(`/revenue${params.size ? `?${params}` : ""}`, ctx);
      const data = res.data;
      if (data.kind === "month") {
        if (!data.rows.length) return `Aucun CA enregistré en ${data.label}.`;
        return `*CA ${data.label}:*\nTotal: ${((data.total ?? 0) / 100).toLocaleString("fr-FR")}€ sur ${data.rows.length} jours\nMoyenne: ${((data.avg ?? 0) / 100).toLocaleString("fr-FR")}€/jour\nMeilleur: ${dayName(data.best!.date)} ${data.best!.date} (${(data.best!.amount / 100).toLocaleString("fr-FR")}€)`;
      }
      if (data.amount == null) return `Pas de CA enregistré pour le ${dayName(data.date)} ${data.date}.`;
      return `*CA ${dayName(data.date)} ${data.date}:* ${(data.amount / 100).toLocaleString("fr-FR")}€`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const logRevenue: ToolDef = {
  name: "log_revenue",
  requiredPermission: "RESTAURANT_SETTINGS",
  description: "Enregistrer le chiffre d'affaires du jour.",
  parameters: {
    date: { type: "string", description: "Date: 'aujourd'hui', 'hier', 'YYYY-MM-DD'. Par défaut aujourd'hui.", required: false },
    amount: { type: "number", description: "Montant en euros (ex: 3500)" },
  },
  async execute(args, ctx) {
    const raw = (args.date as string || "aujourd'hui").toLowerCase();
    let dateStr: string;
    if (raw.includes("hier")) { dateStr = offsetRestaurantDate(ctx.restaurantTimezone, -1); }
    else if (raw.includes("aujourd") || !raw) { dateStr = todayInTimeZone(ctx.restaurantTimezone); }
    else { const r = resolveDateOrError(raw, ctx.restaurantTimezone); if ("error" in r) return r.error; dateStr = r.date; }

    const amount = args.amount as number;
    if (!amount || amount <= 0) return "Montant invalide. Donne un montant positif en euros (ex: 3500).";

    const cents = Math.round(amount * 100);

    setPending(ctx.userId, "log_revenue_confirmed", { date: dateStr, amount: cents });
    return `Enregistrer *${amount.toLocaleString("fr-FR")}€* de CA pour le ${dayName(dateStr)} ${dateStr} ?\nRéponds *oui* pour confirmer ou *non* pour annuler.`;
  },
};

// ── Register admin confirmation handlers ──

registerHandler("delete_service_confirmed", async (args, ctx) => {
  try {
    await apiPost(`/planning/services/${encodeURIComponent(args.serviceId as string)}/cancel`, { zone: args.zone }, ctx);
    return "Service supprimé. ✅";
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("add_service_confirmed", async (args, ctx) => {
  try {
    await apiPost("/planning/services", {
      workerId: args.workerId,
      workerName: args.workerName,
      date: args.date,
      startTime: args.startTime,
      endTime: args.endTime,
      role: args.role,
      zone: args.zone,
    }, ctx);
    return `Service ajouté: *${args.workerName}* le ${dayName(args.date as string)} ${args.date}, ${args.startTime}-${args.endTime}. ✅`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("review_holiday_confirmed", async (args, ctx) => {
  const decision = args.decision as "approved" | "rejected";
  try {
    await apiPost(`/holidays/${encodeURIComponent(args.requestId as string)}/review`, { decision }, ctx);
    const fr = decision === "approved" ? "approuvé ✅" : "refusé ❌";
    return `Congé de *${args.workerName}* (${args.startDate} → ${args.endDate}) ${fr}.`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("add_worker_holiday_confirmed", async (args, ctx) => {
  const startDate = args.startDate as string;
  const endDate = args.endDate as string;
  const workerId = args.workerId as string;
  const workerName = args.workerName as string;
  const reason = (args.reason as string) || null;
  const days = args.days as number;
  try {
    await apiPost(`/workers/${encodeURIComponent(workerId)}/holidays`, { startDate, endDate, reason }, ctx);
    return `Absence enregistrée pour *${workerName}*: ${dayName(startDate)} ${startDate} → ${dayName(endDate)} ${endDate} (${days} jour${days > 1 ? "s" : ""}). ✅`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("add_closure_confirmed", async (args, ctx) => {
  const startDate = args.startDate as string;
  const endDate = args.endDate as string;
  try {
    await apiPost("/closures", { startDate, endDate, reason: (args.reason as string) || null }, ctx);
    return `Fermeture ajoutée: ${startDate} → ${endDate}. ✅`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("review_replacement_pick_confirmed", async (args, ctx) => {
  const replacementId = args.replacementId as string;
  const pickedId = args.pickedId as string;
  const pickedName = args.pickedName as string;
  try {
    const res = await apiPost<InternalReplacementReviewResult>(
      `/replacements/${encodeURIComponent(replacementId)}/review`,
      { decision: "pick", candidateId: pickedId },
      ctx,
    );
    return `✅ *${res.data.pickedName || pickedName}* a été notifié. Tu seras tenu au courant de sa réponse.`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("review_replacement_broadcast_confirmed", async (args, ctx) => {
  const replacementId = args.replacementId as string;
  const candidateIds = args.candidateIds as string[];
  try {
    const res = await apiPost<InternalReplacementReviewResult>(
      `/replacements/${encodeURIComponent(replacementId)}/review`,
      { decision: "broadcast" },
      ctx,
    );
    const count = res.data.candidateCount ?? candidateIds.length;
    return `✅ ${count} collègue${count > 1 ? "s ont" : " a"} été notifié${count > 1 ? "s" : ""}. Le premier qui accepte prend le service.`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("review_replacement_refuse_confirmed", async (args, ctx) => {
  const replacementId = args.replacementId as string;
  const requesterName = args.requesterName as string;
  try {
    const res = await apiPost<InternalReplacementReviewResult>(
      `/replacements/${encodeURIComponent(replacementId)}/review`,
      { decision: "refuse" },
      ctx,
    );
    return `Demande de remplacement de *${res.data.requesterName || requesterName}* refusée.`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("publish_schedule_week_confirmed", async (args, ctx) => {
  const weekStart = args.weekStart as string;
  try {
    const res = await apiPost<{ data: { notifiedWorkers: number } }>(`/planning/weeks/${encodeURIComponent(weekStart)}/publish`, {}, ctx);
    const notifiedWorkers = res.data.notifiedWorkers;
    return `✅ Planning ${weekRangeLabel(weekStart)} publié. ${notifiedWorkers} employé${notifiedWorkers > 1 ? "s ont" : " a"} reçu son planning sur WhatsApp.`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

registerHandler("log_revenue_confirmed", async (args, ctx) => {
  try {
    await apiPost("/revenue", { date: args.date, amount: args.amount }, ctx);
    return `CA enregistré: ${((args.amount as number) / 100).toLocaleString("fr-FR")}€ le ${args.date}. ✅`;
  } catch (err) {
    return formatInternalApiError(err);
  }
});

const confirmTimeclock: ToolDef = {
  name: "confirm_timeclock",
  description: "Confirme le plus ancien pointage employé en attente. À appeler quand le gérant répond 'oui', 'ok', 'confirmé' après un message WhatsApp de confirmation de pointage.",
  parameters: {},
  requiredPermission: "HOURS_VIEW",
  execute: async (_args, ctx) => {
    try {
      const res = await apiPost<{ data: { workerName: string; adminConfirmedAt: string } }>("/timeclock/confirm-latest", {}, ctx);
      return `Pointage de ${res.data.workerName} confirmé. ✅`;
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

const listPendingTimeclocks: ToolDef = {
  name: "list_pending_timeclocks",
  description: "Liste les pointages employés en attente de confirmation par le gérant.",
  parameters: {},
  requiredPermission: "HOURS_VIEW",
  execute: async (_args, ctx) => {
    try {
      const res = await apiGet<{ data: { pending: Array<{ workerName: string; tapIn: string; tapOut: string | null; date: string }> } }>("/timeclock/pending-confirmations", ctx);
      if (res.data.pending.length === 0) return "Aucun pointage en attente de confirmation.";
      return res.data.pending.map((p) => {
        const kind = p.tapOut ? "sortie" : "arrivée";
        const when = new Intl.DateTimeFormat("fr-FR", { timeZone: ctx.restaurantTimezone, hour: "2-digit", minute: "2-digit" }).format(new Date(p.tapOut || p.tapIn));
        return `• ${p.workerName}: ${kind} ${p.date} à ${when}`;
      }).join("\n");
    } catch (err) {
      return formatInternalApiError(err);
    }
  },
};

// ── Export full admin manifest ──
// confirm_action is already in WORKER_TOOLS

export const ADMIN_TOOLS: ToolDef[] = [
  ...WORKER_TOOLS,
  teamSchedule,
  teamOnDate,
  listTeam,
  addService,
  deleteService,
  reviewHoliday,
  addWorkerHoliday,
  pendingRequests,
  reviewReplacement,
  addClosure,
  listClosures,
  weeklyRecap,
  publishScheduleWeek,
  complianceCheck,
  staffingGap,
  solverRecommendation,
  whoIsAvailable,
  requestWorkerForShift,
  workerHours,
  workerSchedule,
  confirmTimeclock,
  listPendingTimeclocks,
  sendSchedule,
  checkWeather,
  checkCalendar,
];
