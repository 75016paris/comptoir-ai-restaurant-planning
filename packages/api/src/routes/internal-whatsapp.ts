import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { can, todayInTimeZone } from "@comptoir/shared";
import { db, rawDb } from "../db/connection.js";
import { calendarEvents, chatMessages, dailyRevenue, documents, holidayRequests, notifications, openShifts, publishedWeeks, replacementRequests, restaurantClosures, restaurants, serviceTemplates, services, staffingProfiles, staffingSchedule, staffingTargets, timeClocks, users, weatherData, workerAvailability } from "../db/schema.js";
import type { AppEnv } from "../middleware/auth.js";
import { constantTimeEqual, isProductionLikeEnv, requireInternalWhatsappAuth } from "../middleware/internal-whatsapp-auth.js";
import { ReplacementReviewError, reviewReplacementRequest, type ReviewReplacementDecision } from "../services/replacement-review.js";
import { cancelPlanningService, createPlanningService, PlanningMutationError, publishPlanningWeek } from "../services/planning-mutations.js";
import { clockInUser, clockOutUser, confirmOldestPendingTimeclock, getOwnHours, TimeclockActionError } from "../services/timeclock-actions.js";
import { listWorkerPendingReplacements, reportUnavailable, respondToReplacement, WorkerReplacementError } from "../services/worker-replacements.js";
import { createOwnHolidayRequest, listOwnHolidays, WorkerHolidayError } from "../services/worker-holidays.js";
import { claimOpenShift, createOpenShift, findClaimableForWorker } from "../services/open-shifts.js";
import { getOwnPreferences, updateOwnPreferences, WorkerPreferenceError, type PreferenceSlotPatch } from "../services/worker-preferences.js";
import { notify, notifyHolidayReview, notifyOpenShiftBroadcast, notifyOpenShiftClaimed, notifyScheduleChange, queueNotification } from "../services/notifications.js";
import { logAudit } from "../db/audit.js";
import { bumpCacheVersion } from "../services/baseline-cache.js";
import { InvalidUploadError, StorageInactiveError, proxyUploadDocument } from "../services/document-uploads.js";
import { isWeekLocked, WEEK_LOCKED_ERROR } from "../utils/week-lock.js";
import { isoWeekYear } from "../utils/scheduling.js";
import { generatePlan, type ForbiddenSolverAssignment } from "./autostaffing.js";
import { columnExists, listAccessibleRestaurants, listOwnerRestaurantIdsForRestaurant, listRestaurantMemberUserIds, listSchedulingRosterWorkers, userHasActiveRestaurantMembership } from "../services/restaurant-context.js";

export const internalWhatsappRoutes = new Hono<AppEnv>();

const DAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const DAY_NAMES_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const MONTH_NAMES_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayNameFr(dateStr: string): string {
  return DAY_NAMES_FR[new Date(`${dateStr}T12:00:00`).getDay()];
}

function serviceHours(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60;
  return Math.round((diff / 60) * 100) / 100;
}

function mondayForDate(date: Date): Date {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d;
}

function resolveDateText(input: string | undefined, timeZone: string): Date | null {
  const today = new Date(`${todayInTimeZone(timeZone)}T12:00:00`);
  const raw = (input || "").toLowerCase().trim();
  if (!raw) return today;

  const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return new Date(`${iso[1]}T12:00:00`);

  const d = new Date(today);
  if (/semaine\s+prochaine|next\s+week/.test(raw)) { d.setDate(d.getDate() + 7); return d; }
  if (/semaine\s+(derni[eè]re|pass[eé]e)|last\s+week/.test(raw)) { d.setDate(d.getDate() - 7); return d; }
  if (/cette\s+semaine|la\s+semaine|week/.test(raw)) return d;
  if (/apr[eè]s[-\s]?demain/.test(raw)) { d.setDate(d.getDate() + 2); return d; }
  if (/demain|2main|2min/.test(raw)) { d.setDate(d.getDate() + 1); return d; }
  if (/aujourd|ajd|ojd/.test(raw) || /\bce\s+(?:soir|midi|matin)\b/.test(raw)) return d;
  if (/avant[-\s]?hier/.test(raw)) { d.setDate(d.getDate() - 2); return d; }
  if (/\bhier\b/.test(raw)) { d.setDate(d.getDate() - 1); return d; }

  const dayIndex = DAY_NAMES.findIndex((name) => new RegExp(`\\b${name}\\b`, "i").test(raw));
  if (dayIndex >= 0) {
    let diff = dayIndex - today.getDay();
    if (/dernier|derni[eè]re|pass[eé]/.test(raw)) {
      if (diff >= 0) diff -= 7;
    } else if (/\bce\s+/.test(raw)) {
      // Keep the current week, including past days.
    } else {
      if (diff <= 0) diff += 7;
    }
    d.setDate(d.getDate() + diff);
    return d;
  }

  return null;
}

function resolveWeekRange(input: { date?: string; weekOffset?: number }, timeZone: string): { from: string; to: string } | null {
  const ref = resolveDateText(input.date, timeZone);
  if (!ref) return null;
  const mon = mondayForDate(ref);
  if (!input.date) {
    const offset = input.weekOffset ?? 0;
    const today = new Date(`${todayInTimeZone(timeZone)}T12:00:00`);
    const effectiveOffset = offset === 0 && today.getDay() === 0 ? 1 : offset;
    if (effectiveOffset) mon.setDate(mon.getDate() + effectiveOffset * 7);
  }
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: fmtDate(mon), to: fmtDate(sun) };
}

function isMonthQuery(raw: string): boolean {
  const monthMap = ["janvier", "février", "fevrier", "mars", "avril", "mai", "juin", "juillet", "août", "aout", "septembre", "octobre", "novembre", "décembre", "decembre"];
  return monthMap.some((m) => raw.includes(m)) || /^\d{4}-\d{2}$/.test(raw) || raw.includes("mois");
}

function resolveMonth(raw: string | undefined, timeZone: string): string {
  const now = new Date(`${todayInTimeZone(timeZone)}T12:00:00`);
  const clean = (raw || "").toLowerCase().trim();
  if (/^\d{4}-\d{2}$/.test(clean)) return clean;
  const monthMap: Record<string, number> = {
    janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  };
  const found = Object.entries(monthMap)
    .sort(([a], [b]) => b.length - a.length)
    .find(([name]) => new RegExp(`\\b${name}\\b`, "i").test(clean));
  if (found) {
    const year = found[1] > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
    return `${year}-${String(found[1]).padStart(2, "0")}`;
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function templateRows(restaurantId: string) {
  return db.select({ zone: serviceTemplates.zone, role: serviceTemplates.role, startTime: serviceTemplates.startTime, endTime: serviceTemplates.endTime, sortOrder: serviceTemplates.sortOrder })
    .from(serviceTemplates)
    .where(eq(serviceTemplates.restaurantId, restaurantId))
    .orderBy(serviceTemplates.sortOrder)
    .all();
}

function getZoneLabel(restaurantId: string, startTime: string): string {
  const templates = templateRows(restaurantId);
  const startH = parseInt(startTime.split(":")[0]);
  for (const t of templates) {
    const tStart = parseInt(t.startTime.split(":")[0]);
    if (Math.abs(startH - tStart) <= 2) return t.zone;
  }
  return startH < 15 ? "Midi" : "Soir";
}

function zoneNames(restaurantId: string): string[] {
  return [...new Set(templateRows(restaurantId).map((t) => t.zone))];
}

function findTemplate(restaurantId: string, zoneName: string, role: string) {
  const templates = templateRows(restaurantId);
  const exact = templates.find((t) => t.zone.toLowerCase() === zoneName.toLowerCase() && t.role === role);
  if (exact) return exact;
  const anyRole = templates.find((t) => t.zone.toLowerCase() === zoneName.toLowerCase());
  if (anyRole) return anyRole;
  return templates.find((t) => t.zone.toLowerCase().includes(zoneName.toLowerCase()) && t.role === role) || null;
}

function offsetDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function minutesFromBase(serviceDate: string, baseDate: string, time: string): number {
  const days = Math.round((new Date(`${serviceDate}T12:00:00`).getTime() - new Date(`${baseDate}T12:00:00`).getTime()) / 86_400_000);
  const [h, m] = time.split(":").map(Number);
  return days * 1440 + h * 60 + m;
}

function datedTimesOverlap(aDate: string, aStart: string, aEnd: string, bDate: string, bStart: string, bEnd: string): boolean {
  const as = minutesFromBase(aDate, bDate, aStart);
  let ae = minutesFromBase(aDate, bDate, aEnd);
  const bs = minutesFromBase(bDate, bDate, bStart);
  let be = minutesFromBase(bDate, bDate, bEnd);
  if (ae <= as) ae += 1440;
  if (be <= bs) be += 1440;
  return as < be && bs < ae;
}

function findPlanningOverlap(workerId: string, restaurantIds: string[], date: string, startTime: string, endTime: string): { startTime: string; endTime: string } | null {
  const dayServices = db.select({ date: services.date, startTime: services.startTime, endTime: services.endTime })
    .from(services)
    .where(and(
      eq(services.workerId, workerId),
      inArray(services.restaurantId, restaurantIds),
      inArray(services.date, [offsetDate(date, -1), date, offsetDate(date, 1)]),
      ne(services.status, "cancelled"),
    ))
    .all();
  for (const s of dayServices) {
    if (datedTimesOverlap(s.date, s.startTime, s.endTime, date, startTime, endTime)) return s;
  }
  return null;
}

function activeTeamRows(restaurantId: string) {
  return listSchedulingRosterWorkers(restaurantId, ["manager", "kitchen", "floor"]).map((worker) => {
    const { maxWeeklyHours: _maxWeeklyHours, ...safeWorker } = worker;
    return safeWorker;
  });
}

type ActiveTeamRow = ReturnType<typeof activeTeamRows>[number];
type VisibleTeamService = { workerId: string; role: string };

function isOwnerScopeUser(user: { ownerRole?: string | null }): boolean {
  return user.ownerRole === "owner_admin" || user.ownerRole === "owner_manager";
}

function ownerScopeRestaurantIds(user: { ownerRole?: string | null; activeRestaurantId: string }): string[] {
  return isOwnerScopeUser(user) ? listOwnerRestaurantIdsForRestaurant(user.activeRestaurantId) : [user.activeRestaurantId];
}

function restaurantNameById(restaurantId: string): string {
  const row = db.select({ name: restaurants.name }).from(restaurants).where(eq(restaurants.id, restaurantId)).get();
  return row?.name || restaurantId;
}

function dedupeTeamRows(rows: Array<ActiveTeamRow & { restaurantIds?: string[]; restaurantNames?: string[] }>) {
  const byId = new Map<string, ActiveTeamRow & { restaurantIds: string[]; restaurantNames: string[] }>();
  for (const row of rows) {
    const restaurantIds = row.restaurantIds ?? [row.restaurantId];
    const restaurantNames = row.restaurantNames ?? [restaurantNameById(row.restaurantId)];
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, { ...row, restaurantIds: [...new Set(restaurantIds)], restaurantNames: [...new Set(restaurantNames)] });
      continue;
    }
    existing.restaurantIds = [...new Set([...existing.restaurantIds, ...restaurantIds])];
    existing.restaurantNames = [...new Set([...existing.restaurantNames, ...restaurantNames])];
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
}

function activeTeamRosterById(restaurantId: string): Map<string, ActiveTeamRow> {
  return new Map(activeTeamRows(restaurantId).map((worker) => [worker.id, worker]));
}

function isVisibleTeamService(rosterById: Map<string, ActiveTeamRow>, service: VisibleTeamService): boolean {
  const worker = rosterById.get(service.workerId);
  if (!worker) return false;
  if (!worker.sharedFromRestaurantId) return true;
  return worker.role === service.role;
}

function isVisibleWorkerService(worker: Pick<ActiveTeamRow, "role" | "sharedFromRestaurantId"> | null | undefined, service: Pick<VisibleTeamService, "role">): boolean {
  if (!worker?.sharedFromRestaurantId) return true;
  return worker.role === service.role;
}

function isVisibleReplacementRequester(rosterById: Map<string, ActiveTeamRow>, request: { requesterId: string; requesterServiceId?: string | null; restaurantId?: string | null }): boolean {
  const worker = rosterById.get(request.requesterId);
  if (!worker) return false;
  if (!worker.sharedFromRestaurantId) return true;
  if (!request.requesterServiceId) return false;
  const service = db.select({ role: services.role })
    .from(services)
    .where(request.restaurantId
      ? and(eq(services.id, request.requesterServiceId), eq(services.restaurantId, request.restaurantId))
      : eq(services.id, request.requesterServiceId))
    .limit(1)
    .all()[0];
  return service?.role === worker.role;
}

function findWorkerByName<T extends { id: string; name: string }>(workers: T[], input: string): { worker: T | null; ambiguous: string[] } {
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

function requireInternalPermission(c: Context<AppEnv>, permission: "TEAM_VIEW" | "HOURS_VIEW" | "RESTAURANT_SETTINGS" | "LEAVE_APPROVE" | "PLANNING_EDIT" | "PUBLISH_WEEK" | "REPLACEMENT_APPROVE"): Response | null {
  const user = c.get("user");
  if (!can(user, permission)) return c.json({ error: "Forbidden" }, 403);
  return null;
}

function requireInternalSecretOnly(c: Context<AppEnv>): Response | null {
  const expectedSecret = process.env.WHATSAPP_INTERNAL_API_SECRET || "";
  if (!expectedSecret) {
    if (isProductionLikeEnv()) console.error("[SECURITY] WHATSAPP_INTERNAL_API_SECRET missing; rejecting WhatsApp identity request.");
    return c.json({ error: "Internal WhatsApp API is not configured" }, 503);
  }
  const providedSecret = c.req.header("X-WhatsApp-Internal-Secret") || "";
  if (!providedSecret || !constantTimeEqual(providedSecret, expectedSecret)) return c.json({ error: "Forbidden" }, 403);
  return null;
}

function sqliteDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-\(\)]/g, "");
  if (!p.startsWith("+")) p = "+" + p;
  return p;
}

function identityRowsByPhone(phone: string) {
  if (columnExists("restaurants", "owner_id") && columnExists("restaurant_memberships", "restaurant_id")) {
    return rawDb.query(`
      SELECT
        u.id AS userId,
        u.name,
        rm.role,
        r.id AS restaurantId,
        u.phone,
        r.name AS restaurantName,
        r.timezone AS restaurantTimezone,
        r.status AS restaurantStatus,
        r.subscription_status AS subscriptionStatus,
        rm.permissions,
        u.whatsapp_opt_in AS whatsappOptIn
      FROM users u
      INNER JOIN restaurant_memberships rm ON rm.user_id = u.id AND rm.active = 1
      INNER JOIN restaurants r ON r.id = rm.restaurant_id
      WHERE u.phone = ? AND u.active = 1
      ORDER BY r.name COLLATE NOCASE ASC, r.id ASC
    `).all(phone) as Array<{
      userId: string;
      name: string;
      role: string;
      restaurantId: string;
      phone: string;
      restaurantName: string;
      restaurantTimezone: string;
      restaurantStatus: string;
      subscriptionStatus: string;
      permissions: string | null;
      whatsappOptIn: boolean | number | null;
    }>;
  }

  return db.select({
    userId: users.id,
    name: users.name,
    role: users.role,
    restaurantId: users.restaurantId,
    phone: users.phone,
    restaurantName: restaurants.name,
    restaurantTimezone: restaurants.timezone,
    restaurantStatus: restaurants.status,
    subscriptionStatus: restaurants.subscriptionStatus,
    permissions: users.permissions,
    whatsappOptIn: users.whatsappOptIn,
  })
    .from(users)
    .innerJoin(restaurants, eq(users.restaurantId, restaurants.id))
    .where(and(eq(users.phone, phone), eq(users.active, true)))
    .all();
}

const BLOCKED_SUBSCRIPTION = new Set(["cancelled", "unpaid"]);
const MAX_CONVERSATION_TURNS = 6;
const MAX_TOTAL_MESSAGES = 12;
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const KEEP_AFTER_CONFIRMATION = 2;
const WHATSAPP_CONTEXT_TTL_MS = 15 * 60 * 1000;

type WhatsappIdentityRow = ReturnType<typeof identityRowsByPhone>[number];
type WhatsappIdentityResolution =
  | { ok: true; identity: WhatsappIdentityRow }
  | { ok: false; blocked: false; code?: string; message?: string; restaurants?: Array<{ id: string; name: string; status: string }> }
  | { ok: false; blocked: true; message: string };

function tableExists(tableName: string): boolean {
  const row = rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

function contextExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + WHATSAPP_CONTEXT_TTL_MS).toISOString();
}

function loadWhatsappContext(phone: string): { userId: string; restaurantId: string } | null {
  if (!tableExists("whatsapp_context_sessions")) return null;
  const row = rawDb.query(`
    SELECT user_id AS userId, restaurant_id AS restaurantId
    FROM whatsapp_context_sessions
    WHERE phone = ? AND expires_at > ?
    LIMIT 1
  `).get(phone, new Date().toISOString()) as { userId: string; restaurantId: string } | null;
  return row ?? null;
}

function saveWhatsappContext(phone: string, identity: { userId: string; restaurantId: string }): void {
  if (!tableExists("whatsapp_context_sessions")) return;
  rawDb.prepare(`
    INSERT INTO whatsapp_context_sessions (phone, user_id, restaurant_id, selected_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      user_id = excluded.user_id,
      restaurant_id = excluded.restaurant_id,
      selected_at = excluded.selected_at,
      expires_at = excluded.expires_at
  `).run(phone, identity.userId, identity.restaurantId, new Date().toISOString(), contextExpiresAt());
}

function hasWhatsappConsent(row: Pick<WhatsappIdentityRow, "role" | "restaurantStatus" | "whatsappOptIn">): boolean {
  return row.role === "admin" || row.restaurantStatus === "demo" || row.whatsappOptIn === true || row.whatsappOptIn === 1;
}

function whatsappRecipientTarget(userId: string): { phone: string; hasConsent: boolean; restaurantId: string | null } | null {
  const user = db.select({ phone: users.phone, active: users.active, whatsappOptIn: users.whatsappOptIn })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all()[0];
  if (!user?.phone || user.active !== true) return null;

  const contexts = listAccessibleRestaurants(userId);
  if (contexts.length === 0) {
    return { phone: user.phone, hasConsent: user.whatsappOptIn === true, restaurantId: null };
  }
  const activeContexts = contexts.filter((context) => context.status === "active" || context.status === "demo");
  const scopeCandidates = activeContexts.length ? activeContexts : contexts;
  const restaurantId = scopeCandidates.length === 1 ? scopeCandidates[0].id : null;

  return {
    phone: user.phone,
    hasConsent: contexts.some((context) => hasWhatsappConsent({
      role: context.role,
      restaurantStatus: context.status,
      whatsappOptIn: user.whatsappOptIn,
    })),
    restaurantId,
  };
}

function ownerIdForRestaurant(restaurantId: string | null): string | null {
  if (!restaurantId || !columnExists("restaurants", "owner_id")) return null;
  const row = rawDb.query("SELECT owner_id FROM restaurants WHERE id = ?").get(restaurantId) as { owner_id?: string | null } | undefined;
  return row?.owner_id ?? null;
}

function insertScopedChatMessage(params: {
  userId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: string | null;
  restaurantId: string | null;
}): string {
  const id = randomUUID();
  const columns = ["id", "user_id", "role", "content"];
  const values: (string | null)[] = [id, params.userId, params.role, params.content];
  if (columnExists("chat_messages", "tool_calls")) {
    columns.push("tool_calls");
    values.push(params.toolCalls ?? null);
  }
  if (columnExists("chat_messages", "owner_id")) {
    columns.push("owner_id");
    values.push(ownerIdForRestaurant(params.restaurantId));
  }
  if (columnExists("chat_messages", "restaurant_id")) {
    columns.push("restaurant_id");
    values.push(params.restaurantId);
  }
  if (columnExists("chat_messages", "context_kind")) {
    columns.push("context_kind");
    values.push(params.restaurantId ? "restaurant_context" : "pre_context");
  }
  const placeholders = columns.map(() => "?").join(", ");
  rawDb.prepare(`INSERT INTO chat_messages (${columns.join(", ")}) VALUES (${placeholders})`).run(...values);
  return id;
}

function resolveIdentityRows(rows: ReturnType<typeof identityRowsByPhone>, requestedRestaurantId?: string | null, phone?: string | null): WhatsappIdentityResolution {
  if (!rows.length) return { ok: false, blocked: false };
  if (requestedRestaurantId) {
    const selected = rows.filter((r) => r.restaurantId === requestedRestaurantId);
    if (!selected.length) {
      return { ok: false, blocked: true, message: "Ce numéro n'est pas autorisé pour ce restaurant." };
    }
    const resolved = resolveIdentityRows(selected);
    if (phone && resolved.ok) saveWhatsappContext(phone, resolved.identity);
    return resolved;
  }

  if (phone) {
    const context = loadWhatsappContext(phone);
    if (context) {
      const selected = rows.filter((r) => r.userId === context.userId && r.restaurantId === context.restaurantId);
      if (selected.length) return resolveIdentityRows(selected);
    }
  }

  const eligible = rows.filter((r) => r.restaurantStatus === "demo" || !BLOCKED_SUBSCRIPTION.has(r.subscriptionStatus));
  if (!eligible.length) return { ok: false, blocked: true, message: "Votre abonnement Comptoir est inactif. Contactez votre gérant." };
  const consented = eligible.filter((r) => hasWhatsappConsent(r));
  if (!consented.length) return { ok: false, blocked: true, message: "WhatsApp n'est pas activé sur votre compte. Connectez-vous à Comptoir pour l'activer si vous souhaitez utiliser l'assistant." };
  const rowsWithConsent = consented;
  if (rowsWithConsent.length === 1) return { ok: true, identity: rowsWithConsent[0] };
  const preferred = rowsWithConsent.filter((r) => r.restaurantStatus === "active" || r.restaurantStatus === "demo");
  const candidates = preferred.length ? preferred : rowsWithConsent;
  const bestSub = candidates.filter((r) => r.subscriptionStatus === "active" || r.subscriptionStatus === "trialing" || r.restaurantStatus === "demo");
  const finalists = bestSub.length ? bestSub : candidates;
  if (finalists.length === 1) return { ok: true, identity: finalists[0] };
  return {
    ok: false,
    blocked: false,
    code: "RESTAURANT_CONTEXT_REQUIRED",
    message: "Votre numéro est associé à plusieurs restaurants. Choisissez le restaurant avant de continuer.",
    restaurants: finalists.map((r) => ({
      id: r.restaurantId,
      name: r.restaurantName,
      status: r.restaurantStatus,
    })),
  };
}

internalWhatsappRoutes.post("/identity/resolve", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.phone !== "string" || !body.phone.trim()) return c.json({ ok: false, blocked: false }, 400);
  const phone = normalizePhone(body.phone);
  const requestedRestaurantId = typeof body.restaurantId === "string" && body.restaurantId.trim() ? body.restaurantId.trim() : null;
  const rows = identityRowsByPhone(phone);
  if (rows.length) return c.json(resolveIdentityRows(rows, requestedRestaurantId, phone));
  const bare = phone.startsWith("+") ? phone.slice(1) : phone;
  return c.json(resolveIdentityRows(identityRowsByPhone(bare), requestedRestaurantId, bare));
});

internalWhatsappRoutes.post("/notifications/list", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.userId !== "string" || typeof body.since !== "string") {
    return c.json({ error: "userId and since are required" }, 400);
  }
  const since = body.since.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
  const rows = db.select({ id: notifications.id, type: notifications.type, message: notifications.message, createdAt: notifications.createdAt })
    .from(notifications)
    .where(and(eq(notifications.recipientId, body.userId), gt(notifications.createdAt, since)))
    .orderBy(notifications.createdAt)
    .limit(20)
    .all();
  return c.json({ data: { notifications: rows } });
});

internalWhatsappRoutes.post("/chat/history", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.userId !== "string") return c.json({ error: "userId is required" }, 400);

  const latest = db.select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.userId, body.userId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1)
    .all()[0];

  if (latest) {
    const lastTime = new Date(`${latest.createdAt}Z`).getTime();
    if (Date.now() - lastTime > SESSION_TIMEOUT_MS) {
      db.delete(chatMessages).where(eq(chatMessages.userId, body.userId)).run();
      console.log(`[session] Auto-cleared stale history for user ${body.userId} (idle > 15min)`);
      return c.json({ data: { messages: [] } });
    }
  }

  const rows = db.select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.userId, body.userId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(MAX_TOTAL_MESSAGES)
    .all()
    .reverse();

  let turns = 0;
  let cutoff = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === "user" || rows[i].role === "assistant") turns++;
    if (turns > MAX_CONVERSATION_TURNS) { cutoff = i + 1; break; }
  }
  return c.json({ data: { messages: rows.slice(cutoff) } });
});

internalWhatsappRoutes.post("/chat/messages", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.userId !== "string" || typeof body.role !== "string" || typeof body.content !== "string") {
    return c.json({ error: "userId, role, and content are required" }, 400);
  }
  if (!["user", "assistant", "tool"].includes(body.role)) return c.json({ error: "Invalid role" }, 400);
  const requestedRestaurantId = typeof body.restaurantId === "string" && body.restaurantId.trim() ? body.restaurantId.trim() : null;
  const target = whatsappRecipientTarget(body.userId);
  const restaurantId = requestedRestaurantId && userHasActiveRestaurantMembership(body.userId, requestedRestaurantId)
    ? requestedRestaurantId
    : target?.restaurantId ?? null;
  insertScopedChatMessage({
    userId: body.userId,
    role: body.role as "user" | "assistant" | "tool",
    content: body.content,
    toolCalls: typeof body.toolCalls === "string" ? body.toolCalls : null,
    restaurantId,
  });
  return c.json({ ok: true });
});

internalWhatsappRoutes.post("/chat/reset-after-confirmation", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.userId !== "string") return c.json({ error: "userId is required" }, 400);
  const all = db.select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.userId, body.userId))
    .orderBy(desc(chatMessages.createdAt))
    .all();
  if (all.length > KEEP_AFTER_CONFIRMATION) {
    const toDelete = all.slice(KEEP_AFTER_CONFIRMATION);
    for (const row of toDelete) db.delete(chatMessages).where(eq(chatMessages.id, row.id)).run();
    console.log(`[session] Reset history for user ${body.userId} after confirmation (kept ${KEEP_AFTER_CONFIRMATION}, dropped ${toDelete.length})`);
  }
  return c.json({ ok: true });
});

internalWhatsappRoutes.post("/chat/trim", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.userId !== "string") return c.json({ error: "userId is required" }, 400);
  const all = db.select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.userId, body.userId))
    .orderBy(asc(chatMessages.createdAt))
    .all();
  if (all.length > MAX_TOTAL_MESSAGES) {
    for (const row of all.slice(0, all.length - MAX_TOTAL_MESSAGES)) db.delete(chatMessages).where(eq(chatMessages.id, row.id)).run();
  }
  return c.json({ ok: true });
});

internalWhatsappRoutes.post("/chat/clear", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.userId !== "string") return c.json({ error: "userId is required" }, 400);
  db.delete(chatMessages).where(eq(chatMessages.userId, body.userId)).run();
  return c.json({ ok: true });
});

internalWhatsappRoutes.post("/chat/expire-old", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const cutoff = sqliteDateTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
  db.delete(chatMessages).where(lt(chatMessages.createdAt, cutoff)).run();
  return c.json({ ok: true });
});

internalWhatsappRoutes.post("/documents/upload", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const { userId, restaurantId, name, filename, mimeType, base64 } = body;
  const size = typeof body.size === "number" ? body.size : NaN;
  if (typeof userId !== "string" || typeof restaurantId !== "string" || typeof name !== "string" || typeof filename !== "string" || typeof mimeType !== "string" || typeof base64 !== "string" || !Number.isFinite(size)) {
    return c.json({ error: "userId, restaurantId, name, filename, mimeType, size, and base64 are required" }, 400);
  }
  if (size > 5 * 1024 * 1024) return c.json({ error: "File too large" }, 413);

  if (!userHasActiveRestaurantMembership(userId, restaurantId)) return c.json({ error: "User not found" }, 404);

  const owner = db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.active, true)))
    .limit(1)
    .all()[0];
  if (!owner) return c.json({ error: "User not found" }, 404);

  const today = new Date().toISOString().slice(0, 10);
  const docType = body.isSignedContract === true ? "contract"
    : mimeType.includes("pdf") ? "other"
    : mimeType.startsWith("image/") ? "id"
    : "other";
  const documentId = crypto.randomUUID();
  let uploaded: { storageKey: string; size: number };
  try {
    uploaded = await proxyUploadDocument({
      restaurantId,
      userId,
      filename,
      mimeType,
      body: Buffer.from(base64, "base64"),
    });
  } catch (err) {
    if (err instanceof StorageInactiveError) return c.json({ error: "Object storage is not configured" }, 503);
    if (err instanceof InvalidUploadError) return c.json({ error: err.message }, err.status as 400 | 403 | 413);
    throw err;
  }
  db.insert(documents).values({
    id: documentId,
    userId,
    restaurantId,
    name,
    type: docType,
    filename,
    mimeType,
    size: uploaded.size,
    data: "",
    storageProvider: "ovh",
    storageKey: uploaded.storageKey,
    storageStatus: "ready",
    uploadedBy: userId,
    signedAt: body.isSignedContract === true ? today : null,
  }).run();
  return c.json({ data: { documentId } });
});

internalWhatsappRoutes.post("/notifications/record", async (c) => {
  const forbidden = requireInternalSecretOnly(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.userId !== "string" || typeof body.message !== "string" || typeof body.type !== "string") {
    return c.json({ error: "userId, message, and type are required" }, 400);
  }

  const recipient = whatsappRecipientTarget(body.userId);
  if (!recipient?.phone) return c.json({ error: "Recipient phone not found" }, 404);
  if (!recipient.hasConsent) return c.json({ error: "WhatsApp opt-in required" }, 403);

  const latestInbound = db.select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, body.userId), eq(chatMessages.role, "user")))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1)
    .all()[0];
  const lastInboundMs = latestInbound ? new Date(`${latestInbound.createdAt.replace(" ", "T")}Z`).getTime() : 0;
  const hasOpenServiceWindow = Number.isFinite(lastInboundMs) && Date.now() - lastInboundMs < 24 * 60 * 60 * 1000;

  const requestedRestaurantId = typeof body.restaurantId === "string" && body.restaurantId.trim() ? body.restaurantId.trim() : null;
  const restaurantId = requestedRestaurantId && userHasActiveRestaurantMembership(body.userId, requestedRestaurantId)
    ? requestedRestaurantId
    : recipient.restaurantId ?? null;

  insertScopedChatMessage({
    userId: body.userId,
    role: "assistant",
    content: body.message,
    restaurantId,
  });
  queueNotification({
    recipientId: body.userId,
    type: body.type as any,
    message: body.message,
    channel: "whatsapp",
    scheduledFor: new Date().toISOString(),
    restaurantId,
  });

  return c.json({ data: { phone: recipient.phone, hasOpenServiceWindow } });
});

internalWhatsappRoutes.use("*", requireInternalWhatsappAuth);

internalWhatsappRoutes.get("/me", (c) => {
  const user = c.get("user");
  return c.json({
    data: {
      id: user.id,
      role: user.role,
      restaurantId: user.activeRestaurantId,
      permissions: user.permissions,
    },
  });
});

internalWhatsappRoutes.get("/context", (c) => {
  const user = c.get("user");
  const zones = zoneNames(user.activeRestaurantId);
  const workers = can(user, "TEAM_VIEW") ? activeTeamRows(user.activeRestaurantId) : [];
  return c.json({
    data: {
      zones,
      team: {
        kitchen: workers.filter((w) => w.role === "kitchen").map((w) => w.name),
        floor: workers.filter((w) => w.role === "floor").map((w) => w.name),
      },
    },
  });
});

internalWhatsappRoutes.get("/team", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  return c.json({ data: { members: activeTeamRows(user.activeRestaurantId) } });
});

internalWhatsappRoutes.get("/workers/resolve", (c) => {
  const scopeParam = c.req.query("scope");
  const scope = scopeParam === "hours" || scopeParam === "leave" ? scopeParam : "team";
  const requiredPermission = scope === "hours" ? "HOURS_VIEW" : scope === "leave" ? "LEAVE_APPROVE" : "TEAM_VIEW";
  const forbidden = requireInternalPermission(c, requiredPermission);
  if (forbidden) return forbidden;

  const name = c.req.query("name") || "";
  if (!name.trim()) return c.json({ error: "name query param required" }, 400);

  const user = c.get("user");
  const restaurantIds = scope === "leave" ? [user.activeRestaurantId] : ownerScopeRestaurantIds(user);
  const team = dedupeTeamRows(restaurantIds.flatMap((restaurantId) =>
    activeTeamRows(restaurantId).map((worker) => ({
      ...worker,
      restaurantIds: [restaurantId],
      restaurantNames: [restaurantNameById(restaurantId)],
    })),
  ))
    .filter((w) => scope !== "leave" || !w.sharedFromRestaurantId);
  const { worker, ambiguous } = findWorkerByName(team, name);
  if (ambiguous.length) {
    return c.json({ error: "Ambiguous worker", ambiguous }, 409);
  }
  if (!worker) {
    return c.json({ error: "Worker not found", team: team.map((w) => w.name) }, 404);
  }
  return c.json({ data: { worker } });
});

function teamScheduleRows(restaurantId: string, from: string, to: string) {
  const rosterById = activeTeamRosterById(restaurantId);
  const rows = db
    .select({
      id: services.id,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
      role: services.role,
      workerId: services.workerId,
      workerName: users.name,
      restaurantId: services.restaurantId,
    })
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(and(
      eq(services.restaurantId, restaurantId),
      gte(services.date, from),
      lte(services.date, to),
      ne(services.status, "cancelled"),
    ))
    .orderBy(services.date, services.startTime)
    .all();

  return rows.filter((s) => isVisibleTeamService(rosterById, s)).map((s) => ({
    ...s,
    hours: serviceHours(s.startTime, s.endTime),
    restaurantName: restaurantNameById(restaurantId),
    zone: getZoneLabel(restaurantId, s.startTime),
  }));
}

function closureRows(restaurantId: string, from: string, to: string) {
  return db.select({ startDate: restaurantClosures.startDate, endDate: restaurantClosures.endDate })
    .from(restaurantClosures)
    .where(and(eq(restaurantClosures.restaurantId, restaurantId), gte(restaurantClosures.endDate, from), lte(restaurantClosures.startDate, to)))
    .all();
}

function getZoneNames(restaurantId: string): string[] {
  const rows = db.select({ zone: serviceTemplates.zone }).from(serviceTemplates).where(eq(serviceTemplates.restaurantId, restaurantId)).all();
  const zones = [...new Set(rows.map((r) => r.zone))];
  return zones.length ? zones : ["Midi", "Soir"];
}

function workerScheduleRows(workerId: string, restaurantId: string, from: string, to: string, worker?: Pick<ActiveTeamRow, "role" | "sharedFromRestaurantId"> | null) {
  const rows = db
    .select({
      id: services.id,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
      role: services.role,
      status: services.status,
    })
    .from(services)
    .where(and(
      eq(services.workerId, workerId),
      eq(services.restaurantId, restaurantId),
      gte(services.date, from),
      lte(services.date, to),
      ne(services.status, "cancelled"),
    ))
    .orderBy(services.date, services.startTime)
    .all();

  return rows.filter((s) => isVisibleWorkerService(worker, s)).map((s) => ({
    ...s,
    restaurantId,
    restaurantName: restaurantNameById(restaurantId),
    hours: serviceHours(s.startTime, s.endTime),
    zone: getZoneLabel(restaurantId, s.startTime),
  }));
}

function workerScheduleRowsForRestaurants(workerId: string, restaurantIds: string[], from: string, to: string) {
  return restaurantIds.flatMap((restaurantId) => {
    const worker = activeTeamRosterById(restaurantId).get(workerId) ?? null;
    return workerScheduleRows(workerId, restaurantId, from, to, worker);
  }).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.restaurantName.localeCompare(b.restaurantName));
}

function staffingProfileIdForDate(restaurantId: string, date: string): string | null {
  const mon = mondayForDate(new Date(`${date}T12:00:00`));
  const monStr = fmtDate(mon);
  const weekNum = isoWeekNum(monStr);
  const weekYear = isoWeekYear(monStr);
  const assigned = db.select({ profileId: staffingSchedule.profileId })
    .from(staffingSchedule)
    .where(and(
      eq(staffingSchedule.restaurantId, restaurantId),
      eq(staffingSchedule.year, weekYear),
      eq(staffingSchedule.week, weekNum),
    ))
    .limit(1)
    .all()[0];
  if (assigned?.profileId) return assigned.profileId;
  const first = db.select({ id: staffingProfiles.id })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurantId))
    .orderBy(staffingProfiles.sortOrder)
    .limit(1)
    .all()[0];
  return first?.id ?? null;
}

function isoWeekNum(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00");
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const dayDiff = Math.round((thursday.getTime() - jan1.getTime()) / 86400000);
  return Math.ceil((dayDiff + 1) / 7);
}

function parseRoleBreakdown(raw: unknown): Record<string, number> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, number> : {};
}

async function rankStaffingGapWithCpsat(input: {
  restaurantId: string;
  date: string;
  zone: string;
  role: "kitchen" | "floor";
  startTime: string;
  endTime: string;
  limit?: number;
}): Promise<Array<{ id: string; name: string; score: number; reasons: string[] }>> {
  const limit = input.limit ?? 3;
  const forbiddenAssignments: ForbiddenSolverAssignment[] = [];
  const seen = new Set<string>();
  const candidates: Array<{ id: string; name: string; score: number; reasons: string[] }> = [];

  for (let rank = 1; rank <= limit; rank++) {
    const plan = await generatePlan(input.restaurantId, input.date, undefined, {
      maxTier: 1,
      forbiddenAssignments,
    });
    const chosen = plan.services.find((s) =>
      s.date === input.date &&
      s.zone === input.zone &&
      s.role === input.role &&
      s.startTime === input.startTime &&
      s.endTime === input.endTime &&
      !seen.has(s.workerId)
    );
    if (!chosen) break;

    seen.add(chosen.workerId);
    forbiddenAssignments.push({
      workerId: chosen.workerId,
      date: input.date,
      zone: input.zone,
      role: input.role,
      startTime: input.startTime,
      endTime: input.endTime,
    });

    const reasons = [`CP-SAT rang ${rank}`];
    if (plan.solveTier != null) reasons.push(`tier ${plan.solveTier}`);
    if (typeof plan.solveTimeMs === "number") reasons.push(`${Math.round(plan.solveTimeMs)}ms`);
    candidates.push({
      id: chosen.workerId,
      name: chosen.workerName,
      score: 100 - (rank - 1) * 10,
      reasons,
    });
  }

  return candidates;
}

internalWhatsappRoutes.get("/team/schedule", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const weekOffsetRaw = c.req.query("week_offset");
  const weekOffset = weekOffsetRaw == null ? undefined : Number(weekOffsetRaw);
  if (weekOffsetRaw != null && !Number.isFinite(weekOffset)) {
    return c.json({ error: "week_offset must be a number" }, 400);
  }
  const range = resolveWeekRange({ date: c.req.query("date"), weekOffset }, user.restaurantTimezone);
  if (!range) return c.json({ error: "Invalid date" }, 400);

  const restaurantIds = ownerScopeRestaurantIds(user);
  const serviceRows = restaurantIds.flatMap((restaurantId) => teamScheduleRows(restaurantId, range.from, range.to))
    .sort((a, b) => a.restaurantName.localeCompare(b.restaurantName) || a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const totalHours = serviceRows.reduce((sum, s) => sum + s.hours, 0);
  return c.json({
    data: {
      from: range.from,
      to: range.to,
      scope: restaurantIds.length > 1 ? "owner" : "restaurant",
      restaurants: restaurantIds.map((id) => ({ id, name: restaurantNameById(id) })),
      zones: [...new Set(restaurantIds.flatMap((id) => getZoneNames(id)))],
      closures: restaurantIds.flatMap((id) => closureRows(id, range.from, range.to).map((row) => ({ ...row, restaurantId: id, restaurantName: restaurantNameById(id) }))),
      services: serviceRows,
      totalHours: Math.round(totalHours * 10) / 10,
    },
  });
});

internalWhatsappRoutes.get("/team/on-date", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const ref = resolveDateText(c.req.query("date"), user.restaurantTimezone);
  if (!ref) return c.json({ error: "Invalid date" }, 400);
  const date = fmtDate(ref);
  const restaurantIds = ownerScopeRestaurantIds(user);
  const serviceRows = restaurantIds.flatMap((restaurantId) => teamScheduleRows(restaurantId, date, date))
    .sort((a, b) => a.restaurantName.localeCompare(b.restaurantName) || a.startTime.localeCompare(b.startTime));
  return c.json({
    data: {
      date,
      scope: restaurantIds.length > 1 ? "owner" : "restaurant",
      restaurants: restaurantIds.map((id) => ({ id, name: restaurantNameById(id) })),
      zones: [...new Set(restaurantIds.flatMap((id) => getZoneNames(id)))],
      services: serviceRows,
    },
  });
});

internalWhatsappRoutes.get("/team/staffing-gap", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const ref = resolveDateText(c.req.query("date"), user.restaurantTimezone);
  if (!ref) return c.json({ error: "Invalid date" }, 400);
  const date = fmtDate(ref);
  const dow = ref.getDay() === 0 ? 7 : ref.getDay();
  const requestedZone = (c.req.query("zone") || "").toLowerCase();

  const profileId = staffingProfileIdForDate(user.activeRestaurantId, date);
  if (!profileId) return c.json({ data: { date, profileId: null, zones: [] } });

  const targets = db.select({ role: staffingTargets.role, zone: staffingTargets.zone, count: staffingTargets.count })
    .from(staffingTargets)
    .where(and(
      eq(staffingTargets.restaurantId, user.activeRestaurantId),
      eq(staffingTargets.profileId, profileId),
      eq(staffingTargets.dayOfWeek, dow),
    ))
    .all()
    .filter((t) => t.count > 0)
    .filter((t) => !requestedZone || t.zone.toLowerCase().includes(requestedZone));

  const rows = teamScheduleRows(user.activeRestaurantId, date, date);
  const zones = [...new Set(targets.map((t) => t.zone))].map((zone) => {
    const byRole = (role: "kitchen" | "floor") => {
      const target = targets.filter((t) => t.zone === zone && t.role === role).reduce((sum, t) => sum + t.count, 0);
      const actualRows = rows.filter((s) => s.zone === zone && s.role === role);
      const actual = actualRows.length;
      return { target, actual, missing: Math.max(0, target - actual), workers: actualRows.map((s) => s.workerName) };
    };
    return { zone, kitchen: byRole("kitchen"), floor: byRole("floor") };
  });

  return c.json({ data: { date, profileId, zones } });
});

internalWhatsappRoutes.get("/team/staffing-recommendation", async (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const ref = resolveDateText(c.req.query("date"), user.restaurantTimezone);
  if (!ref) return c.json({ error: "Invalid date" }, 400);
  const date = fmtDate(ref);
  const dow = ref.getDay() === 0 ? 7 : ref.getDay();
  const requestedZone = (c.req.query("zone") || "").toLowerCase();
  const requestedRoleRaw = (c.req.query("role") || "").toLowerCase();
  const requestedRole = requestedRoleRaw === "kitchen" || requestedRoleRaw === "cuisine" ? "kitchen" : requestedRoleRaw === "floor" || requestedRoleRaw === "salle" ? "floor" : "";

  const profileId = staffingProfileIdForDate(user.activeRestaurantId, date);
  if (!profileId) return c.json({ data: { date, status: "no_profile", recommendations: [] } });

  const targets = db.select({ role: staffingTargets.role, zone: staffingTargets.zone, count: staffingTargets.count, roleBreakdown: staffingTargets.roleBreakdown })
    .from(staffingTargets)
    .where(and(
      eq(staffingTargets.restaurantId, user.activeRestaurantId),
      eq(staffingTargets.profileId, profileId),
      eq(staffingTargets.dayOfWeek, dow),
    ))
    .all()
    .filter((t) => t.count > 0)
    .filter((t) => !requestedZone || t.zone.toLowerCase().includes(requestedZone))
    .filter((t) => !requestedRole || t.role === requestedRole);

  const rows = teamScheduleRows(user.activeRestaurantId, date, date);
  const gaps = targets
    .map((t) => {
      const actual = rows.filter((s) => s.zone === t.zone && s.role === t.role).length;
      const missing = Math.max(0, t.count - actual);
      const template = findTemplate(user.activeRestaurantId, t.zone, t.role);
      return { ...t, actual, missing, template };
    })
    .filter((g) => g.missing > 0 && g.template);

  if (!gaps.length) return c.json({ data: { date, status: "covered", recommendations: [] } });

  const recommendations = await Promise.all(gaps.map(async (gap) => {
    const breakdown = parseRoleBreakdown(gap.roleBreakdown);
    const requiredSubRoles = Object.entries(breakdown)
      .filter(([, count]) => Number(count) > 0)
      .map(([name]) => name);
    const candidates = await rankStaffingGapWithCpsat({
      restaurantId: user.activeRestaurantId,
      date,
      zone: gap.zone,
      startTime: gap.template!.startTime,
      endTime: gap.template!.endTime,
      role: gap.role,
      limit: 3,
    });
    return {
      zone: gap.zone,
      role: gap.role,
      target: gap.count,
      actual: gap.actual,
      missing: gap.missing,
      startTime: gap.template!.startTime,
      endTime: gap.template!.endTime,
      requiredSubRoles,
      rankingMethod: "cpsat-iterative",
      candidates,
    };
  }));

  return c.json({ data: { date, status: "ok", recommendations } });
});

internalWhatsappRoutes.get("/closures", (c) => {
  const forbidden = requireInternalPermission(c, "RESTAURANT_SETTINGS");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const today = todayInTimeZone(user.restaurantTimezone);
  const rows = db.select({ startDate: restaurantClosures.startDate, endDate: restaurantClosures.endDate, reason: restaurantClosures.reason })
    .from(restaurantClosures)
    .where(and(eq(restaurantClosures.restaurantId, user.activeRestaurantId), gte(restaurantClosures.endDate, today)))
    .orderBy(restaurantClosures.startDate)
    .all();
  return c.json({ data: { today, closures: rows } });
});

internalWhatsappRoutes.post("/closures", async (c) => {
  const forbidden = requireInternalPermission(c, "RESTAURANT_SETTINGS");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.startDate !== "string" || typeof body.endDate !== "string") return c.json({ error: "startDate and endDate are required" }, 400);
  if (body.startDate > body.endDate) return c.json({ error: "La date de début est après la date de fin." }, 400);

  const overlap = db.select({ id: restaurantClosures.id }).from(restaurantClosures)
    .where(and(
      eq(restaurantClosures.restaurantId, user.activeRestaurantId),
      lte(restaurantClosures.startDate, body.endDate),
      gte(restaurantClosures.endDate, body.startDate),
    )).limit(1).all();
  if (overlap.length > 0) return c.json({ error: "Une fermeture existe déjà pour ces dates." }, 409);

  const [inserted] = db.insert(restaurantClosures).values({
    restaurantId: user.activeRestaurantId,
    startDate: body.startDate,
    endDate: body.endDate,
    reason: typeof body.reason === "string" ? body.reason : null,
  }).returning({ id: restaurantClosures.id }).all();
  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "restaurant_closures",
    rowId: inserted.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "bot:admin",
    summary: `Fermeture ${body.startDate} → ${body.endDate}${body.reason ? ` (${body.reason})` : ""}`,
  });
  return c.json({ data: { id: inserted.id } }, 201);
});

internalWhatsappRoutes.get("/weather", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const raw = c.req.query("date") || "aujourd'hui";
  const resolved = resolveDateText(raw, user.restaurantTimezone);
  if (!resolved) return c.json({ error: `Je n'ai pas compris la date "${raw}".` }, 400);
  const date = fmtDate(resolved);

  const row = db.select({
    weatherCode: weatherData.weatherCode,
    tempMax: weatherData.tempMax,
    tempMin: weatherData.tempMin,
    sunrise: weatherData.sunrise,
    sunset: weatherData.sunset,
    normalTempMax: weatherData.normalTempMax,
    normalTempMin: weatherData.normalTempMin,
  })
    .from(weatherData)
    .where(and(eq(weatherData.restaurantId, user.activeRestaurantId), eq(weatherData.date, date)))
    .limit(1).all()[0];
  return c.json({ data: { date, weather: row ?? null } });
});

internalWhatsappRoutes.get("/calendar", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const month = resolveMonth(c.req.query("month"), user.restaurantTimezone);
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${month}-${lastDay}`;
  const events = db.select({ type: calendarEvents.type, date: calendarEvents.date, endDate: calendarEvents.endDate, name: calendarEvents.name })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.restaurantId, user.activeRestaurantId), gte(calendarEvents.date, from), lte(calendarEvents.date, to)))
    .orderBy(calendarEvents.date)
    .all();
  return c.json({ data: { month, label: `${MONTH_NAMES_FR[m - 1]} ${y}`, events } });
});

internalWhatsappRoutes.get("/revenue", (c) => {
  const forbidden = requireInternalPermission(c, "HOURS_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const raw = (c.req.query("date") || "").toLowerCase().trim();

  if (isMonthQuery(raw)) {
    const month = resolveMonth(raw, user.restaurantTimezone);
    const [y, m] = month.split("-").map(Number);
    const from = `${month}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${month}-${lastDay}`;
    const rows = db.select({ date: dailyRevenue.date, amount: dailyRevenue.amount })
      .from(dailyRevenue)
      .where(and(eq(dailyRevenue.restaurantId, user.activeRestaurantId), gte(dailyRevenue.date, from), lte(dailyRevenue.date, to)))
      .orderBy(dailyRevenue.date)
      .all();

    if (!rows.length) return c.json({ data: { kind: "month", month, label: `${MONTH_NAMES_FR[m - 1]} ${y}`, rows: [] } });
    const total = rows.reduce((a, r) => a + r.amount, 0);
    const avg = Math.round(total / rows.length);
    const best = rows.reduce((a, r) => r.amount > a.amount ? r : a, rows[0]);
    return c.json({ data: { kind: "month", month, label: `${MONTH_NAMES_FR[m - 1]} ${y}`, rows, total, avg, best } });
  }

  let date: string;
  if (raw.includes("hier")) date = fmtDate(new Date(new Date(`${todayInTimeZone(user.restaurantTimezone)}T12:00:00`).getTime() - 86400000));
  else if (!raw || raw.includes("aujourd")) date = todayInTimeZone(user.restaurantTimezone);
  else {
    const resolved = resolveDateText(raw, user.restaurantTimezone);
    if (!resolved) return c.json({ error: `Je n'ai pas compris la date "${raw}".` }, 400);
    date = fmtDate(resolved);
  }

  const row = db.select({ amount: dailyRevenue.amount })
    .from(dailyRevenue)
    .where(and(eq(dailyRevenue.restaurantId, user.activeRestaurantId), eq(dailyRevenue.date, date)))
    .limit(1).all()[0];
  return c.json({ data: { kind: "day", date, amount: row?.amount ?? null } });
});

internalWhatsappRoutes.post("/revenue", async (c) => {
  const forbidden = requireInternalPermission(c, "RESTAURANT_SETTINGS");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.date !== "string" || typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount <= 0) {
    return c.json({ error: "date and positive amount are required" }, 400);
  }

  const existing = db.select({ id: dailyRevenue.id })
    .from(dailyRevenue)
    .where(and(eq(dailyRevenue.restaurantId, user.activeRestaurantId), eq(dailyRevenue.date, body.date)))
    .limit(1).all()[0];

  let rowId: string;
  if (existing) {
    db.update(dailyRevenue).set({ amount: Math.round(body.amount) }).where(eq(dailyRevenue.id, existing.id)).run();
    rowId = existing.id;
  } else {
    const [inserted] = db.insert(dailyRevenue).values({
      restaurantId: user.activeRestaurantId,
      date: body.date,
      amount: Math.round(body.amount),
    }).returning({ id: dailyRevenue.id }).all();
    rowId = inserted.id;
  }

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "daily_revenue",
    rowId,
    action: existing ? "update" : "insert",
    actorId: user.id,
    actorName: user.name,
    source: "bot:admin",
    summary: `CA ${body.date}: ${(Math.round(body.amount) / 100).toLocaleString("fr-FR")}€`,
  });
  return c.json({ data: { id: rowId } }, existing ? 200 : 201);
});

internalWhatsappRoutes.get("/workers/:id/holidays/pending/latest", (c) => {
  const forbidden = requireInternalPermission(c, "LEAVE_APPROVE");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const workerId = c.req.param("id");
  if (!userHasActiveRestaurantMembership(workerId, user.activeRestaurantId)) return c.json({ error: "Worker not found" }, 404);
  const worker = db.select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.id, workerId), eq(users.active, true)))
    .limit(1).all()[0];
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const request = db.select({ id: holidayRequests.id, startDate: holidayRequests.startDate, endDate: holidayRequests.endDate })
    .from(holidayRequests)
    .where(and(
      eq(holidayRequests.workerId, worker.id),
      eq(holidayRequests.restaurantId, user.activeRestaurantId),
      eq(holidayRequests.status, "pending"),
    ))
    .orderBy(desc(holidayRequests.createdAt))
    .limit(1)
    .all()[0];
  if (!request) return c.json({ error: `Aucune demande de congé en attente pour ${worker.name}.` }, 404);

  return c.json({ data: { worker, request } });
});

internalWhatsappRoutes.post("/holidays/:id/review", async (c) => {
  const forbidden = requireInternalPermission(c, "LEAVE_APPROVE");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") return c.json({ error: "decision must be approved or rejected" }, 400);

  const request = db.select({ id: holidayRequests.id, workerId: holidayRequests.workerId, startDate: holidayRequests.startDate, endDate: holidayRequests.endDate, status: holidayRequests.status })
    .from(holidayRequests)
    .where(and(eq(holidayRequests.id, id), eq(holidayRequests.restaurantId, user.activeRestaurantId)))
    .limit(1).all()[0];
  if (!request) return c.json({ error: "Holiday request not found" }, 404);
  if (request.status !== "pending") return c.json({ error: "Cette demande de congé a déjà été traitée." }, 409);

  db.update(holidayRequests).set({
    status: decision,
    reviewedBy: user.id,
    reviewedAt: new Date().toISOString(),
  }).where(eq(holidayRequests.id, request.id)).run();

  const worker = db.select({ name: users.name }).from(users).where(eq(users.id, request.workerId)).limit(1).all()[0];
  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "holiday_requests",
    rowId: request.id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "bot:admin",
    changes: { status: { old: "pending", new: decision } },
    summary: `Congé de ${worker?.name ?? "?"} (${request.startDate} → ${request.endDate}) ${decision === "approved" ? "approuvé" : "refusé"}`,
  });
  notifyHolidayReview(request.workerId, request.startDate, request.endDate, decision === "approved", user.activeRestaurantId).catch(console.error);
  bumpCacheVersion(user.activeRestaurantId);

  return c.json({ data: { request: { ...request, status: decision }, worker } });
});

internalWhatsappRoutes.post("/workers/:id/holidays", async (c) => {
  const forbidden = requireInternalPermission(c, "LEAVE_APPROVE");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const workerId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.startDate !== "string" || typeof body.endDate !== "string") return c.json({ error: "startDate and endDate are required" }, 400);
  if (body.startDate > body.endDate) return c.json({ error: "La date de début doit être avant la date de fin." }, 400);
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  if (!userHasActiveRestaurantMembership(workerId, user.activeRestaurantId)) return c.json({ error: "Worker not found" }, 404);
  const worker = db.select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.id, workerId), eq(users.active, true)))
    .limit(1).all()[0];
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const overlapping = db.select({ id: holidayRequests.id })
    .from(holidayRequests)
    .where(and(
      eq(holidayRequests.workerId, worker.id),
      eq(holidayRequests.restaurantId, user.activeRestaurantId),
      or(eq(holidayRequests.status, "pending"), eq(holidayRequests.status, "approved")),
      lte(holidayRequests.startDate, body.endDate),
      gte(holidayRequests.endDate, body.startDate),
    ))
    .limit(1).all();
  if (overlapping.length > 0) return c.json({ error: `*${worker.name}* a déjà une demande de congé en cours pour ces dates.` }, 409);

  const [inserted] = db.insert(holidayRequests).values({
    workerId: worker.id,
    restaurantId: user.activeRestaurantId,
    startDate: body.startDate,
    endDate: body.endDate,
    reason,
    status: "approved",
    source: "admin_proposal",
    reviewedBy: user.id,
    reviewedAt: new Date().toISOString(),
  }).returning({ id: holidayRequests.id }).all();
  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "holiday_requests",
    rowId: inserted.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "bot:admin",
    summary: `Absence enregistrée pour ${worker.name}: ${body.startDate} → ${body.endDate}${reason ? ` (${reason})` : ""}`,
  });
  notify({
    recipientId: worker.id,
    type: "holiday_approved",
    message: `✅ Ton responsable a enregistré une absence pour toi du ${body.startDate} au ${body.endDate}${reason ? ` (${reason})` : ""}.`,
  }).catch(console.error);
  bumpCacheVersion(user.activeRestaurantId);

  return c.json({ data: { id: inserted.id } }, 201);
});

internalWhatsappRoutes.get("/requests/pending", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const canViewMedical = can(user, "MEDICAL_DOC_VIEW");
  const teamRows = activeTeamRows(user.activeRestaurantId);
  const liveSchedulingWorkerIds = new Set(teamRows.map((w) => w.id));
  const rosterById = new Map(teamRows.map((worker) => [worker.id, worker]));
  const directLeaveWorkerIds = new Set(teamRows.filter((w) => !w.sharedFromRestaurantId).map((w) => w.id));
  const holidays = db.select({
    workerId: holidayRequests.workerId,
    workerName: users.name,
    startDate: holidayRequests.startDate,
    endDate: holidayRequests.endDate,
    reason: holidayRequests.reason,
    medical: holidayRequests.medical,
  })
    .from(holidayRequests)
    .innerJoin(users, eq(holidayRequests.workerId, users.id))
    .where(and(eq(holidayRequests.restaurantId, user.activeRestaurantId), eq(holidayRequests.status, "pending")))
    .all()
    .filter((h) => directLeaveWorkerIds.has(h.workerId))
    .map((h) => ({
      workerName: h.workerName,
      startDate: h.startDate,
      endDate: h.endDate,
      reason: h.medical && h.workerId !== user.id && !canViewMedical ? null : h.reason,
    }));

  const replacements = db.select({
    requesterId: replacementRequests.requesterId,
    requesterServiceId: replacementRequests.requesterServiceId,
    requesterName: users.name,
    message: replacementRequests.message,
    medical: replacementRequests.medical,
    status: replacementRequests.status,
  })
    .from(replacementRequests)
    .innerJoin(users, eq(replacementRequests.requesterId, users.id))
    .where(and(
      eq(replacementRequests.restaurantId, user.activeRestaurantId),
      // Open requests only: either awaiting manager action or waiting on a worker reply.
      // Avoid importing `or` in this already-large route by filtering after tenant-scoped read.
    ))
    .all()
    .filter((r) => r.status === "awaiting_admin_decision" || r.status === "awaiting_worker_reply")
    .filter((r) => liveSchedulingWorkerIds.has(r.requesterId))
    .filter((r) => isVisibleReplacementRequester(rosterById, r))
    .map((r) => ({
      requesterName: r.requesterName,
      message: r.medical && r.requesterId !== user.id && !canViewMedical ? null : r.message,
      status: r.status,
    }));

  return c.json({ data: { holidays, replacements } });
});

internalWhatsappRoutes.get("/team/compliance", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const weekOffsetRaw = c.req.query("week_offset");
  const weekOffset = weekOffsetRaw == null ? undefined : Number(weekOffsetRaw);
  if (weekOffsetRaw != null && !Number.isFinite(weekOffset)) {
    return c.json({ error: "week_offset must be a number" }, 400);
  }
  const range = resolveWeekRange({ date: c.req.query("date"), weekOffset }, user.restaurantTimezone);
  if (!range) return c.json({ error: "Invalid date" }, 400);

  const rows = teamScheduleRows(user.activeRestaurantId, range.from, range.to);
  const byWorker = new Map<string, { name: string; services: typeof rows; hours: number }>();
  for (const row of rows) {
    const w = byWorker.get(row.workerId) || { name: row.workerName, services: [], hours: 0 };
    w.hours += row.hours;
    w.services.push(row);
    byWorker.set(row.workerId, w);
  }

  const alerts: string[] = [];
  for (const [, worker] of byWorker) {
    if (worker.hours > 48) alerts.push(`🛑 ${worker.name}: ${Math.round(worker.hours * 10) / 10}h/sem (max 48h)`);
    else if (worker.hours > 44) alerts.push(`⚠️ ${worker.name}: ${Math.round(worker.hours * 10) / 10}h/sem (proche du max)`);

    const byDate = new Map<string, number>();
    for (const service of worker.services) byDate.set(service.date, (byDate.get(service.date) || 0) + service.hours);
    for (const [date, dayHours] of byDate) {
      if (dayHours > 11) alerts.push(`🛑 ${worker.name}: ${dayHours}h le ${dayNameFr(date)} ${date} (max 11h)`);
      else if (dayHours > 10) alerts.push(`⚠️ ${worker.name}: ${dayHours}h le ${dayNameFr(date)} ${date} (max 10h)`);
    }

    const workDates = [...new Set(worker.services.map((service) => service.date))].sort();
    let consecutive = 1;
    for (let i = 1; i < workDates.length; i++) {
      const prev = new Date(`${workDates[i - 1]}T12:00:00`);
      const curr = new Date(`${workDates[i]}T12:00:00`);
      if (Math.round((curr.getTime() - prev.getTime()) / 86_400_000) === 1) {
        consecutive += 1;
        if (consecutive > 6) alerts.push(`🛑 ${worker.name}: ${consecutive} jours consécutifs (max 6)`);
      } else {
        consecutive = 1;
      }
    }

    if (worker.hours > 39) alerts.push(`ℹ️ ${worker.name}: ${Math.round((worker.hours - 39) * 10) / 10}h supplémentaires`);
  }

  const sorted = alerts.sort((a, b) => {
    const rank = (s: string) => s.startsWith("🛑") ? 0 : s.startsWith("⚠️") ? 1 : 2;
    return rank(a) - rank(b);
  });
  return c.json({ data: { from: range.from, to: range.to, serviceCount: rows.length, alerts: sorted } });
});

internalWhatsappRoutes.get("/team/availability", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const ref = resolveDateText(c.req.query("date"), user.restaurantTimezone);
  if (!ref) return c.json({ error: "Invalid date" }, 400);
  const date = fmtDate(ref);
  const dow = ref.getDay() === 0 ? 7 : ref.getDay();

  const workers = activeTeamRows(user.activeRestaurantId).map((w) => ({ id: w.id, name: w.name, sharedFromRestaurantId: w.sharedFromRestaurantId }));
  const availabilityRows = db.select({ workerId: workerAvailability.workerId, midi: workerAvailability.midi, soir: workerAvailability.soir })
    .from(workerAvailability)
    .where(and(eq(workerAvailability.restaurantId, user.activeRestaurantId), eq(workerAvailability.dayOfWeek, dow)))
    .all();
  const availMap = new Map(availabilityRows.map((a) => [a.workerId, a]));

  const ownerRestaurantIds = listOwnerRestaurantIdsForRestaurant(user.activeRestaurantId);
  const scheduled = db.select({ workerId: services.workerId, startTime: services.startTime, restaurantId: services.restaurantId })
    .from(services)
    .where(and(
      ownerRestaurantIds.length > 1 ? inArray(services.restaurantId, ownerRestaurantIds) : eq(services.restaurantId, user.activeRestaurantId),
      eq(services.date, date),
      ne(services.status, "cancelled"),
    ))
    .all();
  const holidayRows = db.select({ workerId: holidayRequests.workerId })
    .from(holidayRequests)
    .where(and(
      eq(holidayRequests.restaurantId, user.activeRestaurantId),
      eq(holidayRequests.status, "approved"),
      lte(holidayRequests.startDate, date),
      gte(holidayRequests.endDate, date),
    ))
    .all();
  const onHoliday = new Set(holidayRows.map((h) => h.workerId));

  const requestedZone = (c.req.query("zone") || "").toLowerCase();
  const zones = getZoneNames(user.activeRestaurantId).filter((zone) => !requestedZone || zone.toLowerCase().includes(requestedZone));
  const data = zones.map((zone) => {
    const template = db.select({ startTime: serviceTemplates.startTime })
      .from(serviceTemplates)
      .where(and(eq(serviceTemplates.restaurantId, user.activeRestaurantId), eq(serviceTemplates.zone, zone)))
      .limit(1).all()[0];
    const isMidiZone = parseInt(template?.startTime || "12") < 15;
    const scheduledInZone = scheduled.filter((s) => getZoneLabel(user.activeRestaurantId, s.startTime) === zone);
    const scheduledInZoneIds = new Set(scheduledInZone.map((s) => s.workerId));
    const scheduledElsewhereIds = new Set(scheduledInZone.filter((s) => s.restaurantId !== user.activeRestaurantId).map((s) => s.workerId));
    const available: string[] = [];
    const alreadyScheduled: string[] = [];
    const unavailable: string[] = [];

    for (const w of workers) {
      if (onHoliday.has(w.id)) { unavailable.push(`${w.name} (congé)`); continue; }
      if (scheduledInZoneIds.has(w.id)) {
        alreadyScheduled.push(scheduledElsewhereIds.has(w.id) ? `${w.name} (ailleurs)` : w.name);
        continue;
      }
      const a = availMap.get(w.id);
      if (!a && w.sharedFromRestaurantId) { unavailable.push(`${w.name} (disponibilité à confirmer)`); continue; }
      if (!a || (isMidiZone ? a.midi : a.soir)) available.push(w.name);
      else unavailable.push(w.name);
    }
    return { zone, available, alreadyScheduled, unavailable };
  });

  return c.json({ data: { date, zones: data } });
});

internalWhatsappRoutes.get("/team/weekly-recap", (c) => {
  const forbidden = requireInternalPermission(c, "HOURS_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const weekOffsetRaw = c.req.query("week_offset");
  const weekOffset = weekOffsetRaw == null ? undefined : Number(weekOffsetRaw);
  if (weekOffsetRaw != null && !Number.isFinite(weekOffset)) {
    return c.json({ error: "week_offset must be a number" }, 400);
  }
  const range = resolveWeekRange({ date: c.req.query("date"), weekOffset }, user.restaurantTimezone);
  if (!range) return c.json({ error: "Invalid date" }, 400);

  const rows = teamScheduleRows(user.activeRestaurantId, range.from, range.to);
  const byWorker = new Map<string, { workerId: string; name: string; role: string; hours: number; services: number }>();
  for (const r of rows) {
    const existing = byWorker.get(r.workerId) || { workerId: r.workerId, name: r.workerName, role: r.role, hours: 0, services: 0 };
    existing.hours += r.hours;
    existing.services += 1;
    byWorker.set(r.workerId, existing);
  }
  const workers = [...byWorker.values()]
    .map((w) => ({ ...w, hours: Math.round(w.hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours);
  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);

  return c.json({ data: {
    from: range.from,
    to: range.to,
    serviceCount: rows.length,
    totalHours: Math.round(totalHours * 10) / 10,
    workers,
  } });
});

internalWhatsappRoutes.post("/workers/:id/send-schedule", async (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const workerId = c.req.param("id");
  const [worker] = activeTeamRows(user.activeRestaurantId).filter((w) => w.id === workerId);
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const weekOffsetRaw = typeof body.weekOffset === "number" ? String(body.weekOffset) : undefined;
  const weekOffset = weekOffsetRaw == null ? undefined : Number(weekOffsetRaw);
  const range = resolveWeekRange({ date: typeof body.date === "string" ? body.date : undefined, weekOffset }, user.restaurantTimezone);
  if (!range) return c.json({ error: "Invalid date" }, 400);

  const rows = workerScheduleRows(worker.id, user.activeRestaurantId, range.from, range.to, worker);
  if (rows.length === 0) {
    return c.json({ data: { sent: false, worker, from: range.from, to: range.to, serviceCount: 0, totalHours: 0 } });
  }

  const lines = [`Planning de ${worker.name} (${range.from} → ${range.to}):`];
  for (const row of rows) {
    lines.push(`${dayNameFr(row.date)} ${row.date} — ${row.startTime}-${row.endTime}`);
  }
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0);
  lines.push(`Total: ${rows.length} services, ${Math.round(totalHours * 10) / 10}h`);
  await notifyScheduleChange(worker.id, `📅 ${lines.join("\n")}`, {
    workerName: worker.name,
    serviceLabel: `Semaine ${range.from} → ${range.to}`,
    newSchedule: `${rows.length} service${rows.length > 1 ? "s" : ""}`,
  }, user.activeRestaurantId);

  return c.json({ data: { sent: true, worker, from: range.from, to: range.to, serviceCount: rows.length, totalHours: Math.round(totalHours * 10) / 10 } });
});

internalWhatsappRoutes.get("/workers/:id/schedule", (c) => {
  const forbidden = requireInternalPermission(c, "TEAM_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const workerId = c.req.param("id");
  const restaurantIds = ownerScopeRestaurantIds(user);
  const [worker] = dedupeTeamRows(restaurantIds.flatMap((restaurantId) =>
    activeTeamRows(restaurantId).filter((w) => w.id === workerId).map((w) => ({
      ...w,
      restaurantIds: [restaurantId],
      restaurantNames: [restaurantNameById(restaurantId)],
    })),
  ));
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const weekOffsetRaw = c.req.query("week_offset");
  const weekOffset = weekOffsetRaw == null ? undefined : Number(weekOffsetRaw);
  if (weekOffsetRaw != null && !Number.isFinite(weekOffset)) {
    return c.json({ error: "week_offset must be a number" }, 400);
  }
  const range = resolveWeekRange({ date: c.req.query("date"), weekOffset }, user.restaurantTimezone);
  if (!range) return c.json({ error: "Invalid date" }, 400);

  const servicesWithHours = workerScheduleRowsForRestaurants(worker.id, worker.restaurantIds ?? restaurantIds, range.from, range.to);
  const totalHours = servicesWithHours.reduce((sum, s) => sum + s.hours, 0);

  return c.json({
    data: {
      worker,
      from: range.from,
      to: range.to,
      services: servicesWithHours,
      totalHours: Math.round(totalHours * 10) / 10,
    },
  });
});

internalWhatsappRoutes.get("/me/schedule", (c) => {
  const user = c.get("user");
  const weekOffsetRaw = c.req.query("week_offset");
  const weekOffset = weekOffsetRaw == null ? undefined : Number(weekOffsetRaw);
  if (weekOffsetRaw != null && !Number.isFinite(weekOffset)) {
    return c.json({ error: "week_offset must be a number" }, 400);
  }
  const range = resolveWeekRange({ date: c.req.query("date"), weekOffset }, user.restaurantTimezone);
  if (!range) return c.json({ error: "Invalid date" }, 400);

  const serviceRows = workerScheduleRowsForRestaurants(user.id, listOwnerRestaurantIdsForRestaurant(user.activeRestaurantId), range.from, range.to);
  const totalHours = serviceRows.reduce((sum, s) => sum + s.hours, 0);
  return c.json({
    data: {
      from: range.from,
      to: range.to,
      services: serviceRows,
      totalHours: Math.round(totalHours * 10) / 10,
    },
  });
});

internalWhatsappRoutes.get("/me/next-service", (c) => {
  const user = c.get("user");
  const today = todayInTimeZone(user.restaurantTimezone);
  const [row] = workerScheduleRowsForRestaurants(user.id, listOwnerRestaurantIdsForRestaurant(user.activeRestaurantId), today, "9999-12-31");
  return c.json({
    data: {
      service: row ?? null,
    },
  });
});

internalWhatsappRoutes.get("/me/preferences", (c) => {
  const user = c.get("user");
  try {
    return c.json({ data: getOwnPreferences(user) });
  } catch (err) {
    if (err instanceof WorkerPreferenceError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/me/preferences", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const slotsByDay = body.slotsByDay && typeof body.slotsByDay === "object" && !Array.isArray(body.slotsByDay)
    ? body.slotsByDay as Record<string, PreferenceSlotPatch>
    : undefined;
  try {
    const result = updateOwnPreferences(user, {
      maxWeeklyHours: body.maxWeeklyHours === null ? null : typeof body.maxWeeklyHours === "number" ? body.maxWeeklyHours : undefined,
      coupureWilling: typeof body.coupureWilling === "boolean" ? body.coupureWilling : undefined,
      slotsByDay,
    }, { source: "bot:worker" });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof WorkerPreferenceError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/me/open-shifts/claim", (c) => {
  const user = c.get("user");
  if (user.role === "admin") {
    return c.json({ error: "En tant que gérant, tu publies des services ouverts depuis le tableau de bord. Tu ne les prends pas toi-même." }, 403);
  }

  const shift = findClaimableForWorker(user.activeRestaurantId, user.id);
  if (!shift) return c.json({ error: "Aucun service ouvert ne t'attend pour l'instant." }, 404);

  const result = claimOpenShift(shift.id, user.id);
  if (!result.ok) {
    if (result.reason === "already_claimed") return c.json({ error: "Trop tard — un collègue a déjà pris ce service." }, 409);
    if (result.reason === "cancelled") return c.json({ error: "Ce service a été annulé entre-temps." }, 409);
    if (result.reason === "not_eligible") return c.json({ error: "Tu n'es pas dans la liste des candidats pour ce service." }, 403);
    if (result.reason === "locked") return c.json({ error: "Ce service appartient à une semaine déjà publiée et verrouillée. Le gérant doit corriger le planning depuis le tableau de bord." }, 423);
    return c.json({ error: "Service ouvert introuvable." }, 404);
  }

  notifyOpenShiftClaimed(result.adminId, result.workerName, result.date, result.startTime, result.endTime, result.restaurantId)
    .catch((err) => console.error("[claim-open-shift] admin notify failed:", err));

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "open_shifts",
    rowId: shift.id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "bot:worker",
    changes: { status: { old: "open", new: "claimed" } },
    summary: `Service ouvert pris : ${shift.date} ${shift.startTime}-${shift.endTime}`,
  });

  return c.json({ data: { date: result.date, startTime: result.startTime, endTime: result.endTime, serviceId: result.serviceId } });
});

internalWhatsappRoutes.post("/me/open-shifts/decline", async (c) => {
  const user = c.get("user");
  if (user.role === "admin") {
    return c.json({ error: "En tant que gérant, tu ne refuses pas les services ouverts." }, 403);
  }

  const shift = findClaimableForWorker(user.activeRestaurantId, user.id);
  if (!shift) return c.json({ error: "Aucun service ouvert ne t'attend pour l'instant." }, 404);

  const rejected = Array.isArray(shift.rejectedCandidateIds) ? shift.rejectedCandidateIds : [];
  if (!rejected.includes(user.id)) rejected.push(user.id);
  db.update(openShifts).set({ rejectedCandidateIds: rejected }).where(eq(openShifts.id, shift.id)).run();

  await notify({
    recipientId: shift.createdBy,
    type: "open_shift_claimed",
    message: `❌ *${user.name}* a refusé le service ouvert du ${shift.date} ${shift.startTime}-${shift.endTime}.`,
  }).catch((err) => console.error("[decline-open-shift] admin notify failed:", err));

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "open_shifts",
    rowId: shift.id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "bot:worker",
    changes: { rejectedCandidateIds: { old: shift.rejectedCandidateIds, new: rejected } },
    summary: `Service ouvert refusé : ${shift.date} ${shift.startTime}-${shift.endTime}`,
  });

  return c.json({ data: { date: shift.date, startTime: shift.startTime, endTime: shift.endTime } });
});

internalWhatsappRoutes.get("/me/holidays", (c) => {
  const user = c.get("user");
  try {
    return c.json({ data: { holidays: listOwnHolidays(user) } });
  } catch (err) {
    if (err instanceof WorkerHolidayError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/me/holidays", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.startDate !== "string" || typeof body.endDate !== "string") {
    return c.json({ error: "startDate and endDate are required" }, 400);
  }
  try {
    const result = await createOwnHolidayRequest(user, {
      startDate: body.startDate,
      endDate: body.endDate,
      reason: typeof body.reason === "string" ? body.reason : null,
    }, { source: "bot:worker" });
    return c.json({ data: result }, 201);
  } catch (err) {
    if (err instanceof WorkerHolidayError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.get("/me/replacements/pending", (c) => {
  const user = c.get("user");
  return c.json({ data: listWorkerPendingReplacements(user) });
});

internalWhatsappRoutes.post("/me/replacements/report-unavailable", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.requesterServiceId !== "string" || typeof body.date !== "string" || typeof body.startTime !== "string" || typeof body.endTime !== "string") {
    return c.json({ error: "requesterServiceId, date, startTime, and endTime are required" }, 400);
  }
  if (body.role !== "kitchen" && body.role !== "floor") return c.json({ error: "role must be kitchen or floor" }, 400);
  try {
    const result = await reportUnavailable(user, {
      requesterServiceId: body.requesterServiceId,
      date: body.date,
      startTime: body.startTime,
      endTime: body.endTime,
      role: body.role,
      reason: typeof body.reason === "string" ? body.reason : null,
      isCoupure: body.isCoupure === true,
    }, { source: "bot:worker" });
    return c.json({ data: result }, 201);
  } catch (err) {
    if (err instanceof WorkerReplacementError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/me/replacements/respond", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.decision !== "accepted" && body.decision !== "rejected") return c.json({ error: "decision must be accepted or rejected" }, 400);
  try {
    const result = await respondToReplacement(user, body.decision, { source: "bot:worker" });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof WorkerReplacementError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.get("/me/hours", (c) => {
  const user = c.get("user");
  const month = c.req.query("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = `${month}-${new Date(y, m, 0).getDate()}`;
  return c.json({ data: { month, from, to, ...getOwnHours(user, from, to) } });
});

internalWhatsappRoutes.post("/me/clock-in", async (c) => {
  const user = c.get("user");
  try {
    const record = await clockInUser(user, { source: "bot:worker" });
    return c.json({ data: { id: record.id, tapIn: record.tapIn, serviceId: record.serviceId, date: record.date } }, 201);
  } catch (err) {
    if (err instanceof TimeclockActionError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/me/clock-out", async (c) => {
  const user = c.get("user");
  try {
    const record = await clockOutUser(user, { source: "bot:worker" });
    return c.json({ data: { id: record.id, tapIn: record.tapIn, tapOut: record.tapOut, serviceId: record.serviceId, date: record.date } });
  } catch (err) {
    if (err instanceof TimeclockActionError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.get("/timeclock/pending-confirmations", (c) => {
  const forbidden = requireInternalPermission(c, "HOURS_VIEW");
  if (forbidden) return forbidden;
  const user = c.get("user");
  const rows = db.select({ id: timeClocks.id, workerName: users.name, tapIn: timeClocks.tapIn, tapOut: timeClocks.tapOut, date: timeClocks.date })
    .from(timeClocks)
    .innerJoin(users, eq(users.id, timeClocks.userId))
    .where(and(eq(timeClocks.restaurantId, user.activeRestaurantId), isNull(timeClocks.adminConfirmedAt)))
    .orderBy(asc(timeClocks.createdAt))
    .limit(5)
    .all();
  return c.json({ data: { pending: rows } });
});

internalWhatsappRoutes.post("/timeclock/confirm-latest", async (c) => {
  const forbidden = requireInternalPermission(c, "HOURS_VIEW");
  if (forbidden) return forbidden;
  const user = c.get("user");
  try {
    const record = confirmOldestPendingTimeclock(user);
    return c.json({ data: { id: record.id, workerName: record.workerName, adminConfirmedAt: record.adminConfirmedAt } });
  } catch (err) {
    if (err instanceof TimeclockActionError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/planning/open-shift/request-worker", async (c) => {
  const forbidden = requireInternalPermission(c, "PLANNING_EDIT");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const workerName = typeof body.workerName === "string" ? body.workerName : "";
  const date = typeof body.date === "string" ? body.date : "";
  if (!workerName.trim() || !date) return c.json({ error: "workerName and date are required" }, 400);

  const team = activeTeamRows(user.activeRestaurantId);
  const { worker, ambiguous } = findWorkerByName(team, workerName);
  if (ambiguous.length) return c.json({ error: "Ambiguous worker", ambiguous }, 409);
  if (!worker) return c.json({ error: "Worker not found", team: team.map((w) => w.name) }, 404);
  if (worker.role !== "kitchen" && worker.role !== "floor") return c.json({ error: "Cet employé ne peut pas prendre de service cuisine/salle." }, 400);

  if (isWeekLocked(user.activeRestaurantId, date)) return c.json({ error: WEEK_LOCKED_ERROR }, 423);

  const role = body.role === "kitchen" || body.role === "floor" ? body.role : worker.role;
  if (worker.role !== role) {
    return c.json({ data: { status: "not_candidate", worker, date, startTime: "", endTime: "", role } });
  }
  let startTime = typeof body.startTime === "string" ? body.startTime : "";
  let endTime = typeof body.endTime === "string" ? body.endTime : "";
  const zones = zoneNames(user.activeRestaurantId);
  if (!startTime || !endTime) {
    const allText = [body.zone, body.dateText, body.workerName, body.lastUserMessage].filter((v) => typeof v === "string").join(" ").toLowerCase();
    let matched = null as ReturnType<typeof findTemplate>;
    for (const z of [...zones].sort((a, b) => b.length - a.length)) {
      if (allText.includes(z.toLowerCase())) { matched = findTemplate(user.activeRestaurantId, z, role); break; }
    }
    if (!matched && typeof body.zone === "string") matched = findTemplate(user.activeRestaurantId, body.zone, role);
    if (!matched) return c.json({ data: { status: "needs_zone", worker, date, zones } });
    startTime = startTime || matched.startTime;
    endTime = endTime || matched.endTime;
  }

  const ownerRestaurantIds = listOwnerRestaurantIdsForRestaurant(user.activeRestaurantId);
  const overlap = findPlanningOverlap(worker.id, ownerRestaurantIds, date, startTime, endTime);
  if (overlap) return c.json({ data: { status: "overlap", worker, date, startTime, endTime, role, overlap } });

  const result = createOpenShift({
    restaurantId: user.activeRestaurantId,
    createdBy: user.id,
    date,
    startTime,
    endTime,
    role,
    message: typeof body.message === "string" ? body.message : null,
  });
  if (!result.candidateIds.includes(worker.id)) {
    db.update(openShifts).set({ status: "cancelled" }).where(eq(openShifts.id, result.id)).run();
    return c.json({ data: { status: "not_candidate", worker, date, startTime, endTime, role } });
  }

  db.update(openShifts).set({ candidateIds: [worker.id], solicitedCandidateIds: [worker.id], lastSolicitedAt: new Date().toISOString() }).where(eq(openShifts.id, result.id)).run();
  const roleLabel = role === "kitchen" ? "cuisine" : "salle";
  const extra = typeof body.message === "string" && body.message.trim() ? ` (${body.message.trim()})` : "";
  const dateLabel = `${dayNameFr(date).toLowerCase()} ${Number(date.slice(8, 10))} ${MONTH_NAMES_FR[Number(date.slice(5, 7)) - 1]}`;
  await notify({
    recipientId: worker.id,
    type: "open_shift_broadcast",
    message: `📣 ${user.name} te propose un service ${roleLabel} le ${date} ${startTime}-${endTime}${extra}. Réponds *oui* / *je prends* pour accepter, ou *non* pour refuser. Je préviens le gérant dès ta réponse.`,
    template: {
      name: "open_shift_request_fr",
      language: "fr",
      body: [worker.name.trim().split(/\s+/)[0] || worker.name, user.name, roleLabel, dateLabel, startTime, endTime],
      buttonPayloads: ["OPEN_SHIFT_YES", "OPEN_SHIFT_NO"],
    },
  });

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "open_shifts",
    rowId: result.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "bot:admin",
    summary: `Service proposé à ${worker.name}: ${role} ${date} ${startTime}-${endTime}`,
  });

  return c.json({ data: { status: "sent", worker, date, startTime, endTime, role, openShiftId: result.id } }, 201);
});

internalWhatsappRoutes.post("/planning/services/prepare", async (c) => {
  const forbidden = requireInternalPermission(c, "PLANNING_EDIT");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const workerName = typeof body.workerName === "string" ? body.workerName : "";
  const date = typeof body.date === "string" ? body.date : "";
  if (!workerName.trim() || !date) return c.json({ error: "workerName and date are required" }, 400);

  const team = activeTeamRows(user.activeRestaurantId);
  const { worker, ambiguous } = findWorkerByName(team, workerName);
  if (ambiguous.length) return c.json({ error: "Ambiguous worker", ambiguous }, 409);
  if (!worker) return c.json({ error: "Worker not found", team: team.map((w) => w.name) }, 404);
  if (worker.role !== "kitchen" && worker.role !== "floor") return c.json({ error: "Cet employé ne peut pas prendre de service cuisine/salle." }, 400);

  const role = body.role === "kitchen" || body.role === "floor" ? body.role : worker.role;
  if (worker.role !== role) {
    return c.json({ data: { status: "not_candidate", worker, date, startTime: "", endTime: "", role } });
  }
  const zones = zoneNames(user.activeRestaurantId);
  let startTime = typeof body.startTime === "string" ? body.startTime : "";
  let endTime = typeof body.endTime === "string" ? body.endTime : "";

  if (!startTime || !endTime) {
    const allText = [body.zone, body.dateText, body.workerName, body.lastUserMessage].filter((v) => typeof v === "string").join(" ").toLowerCase();
    let matched = null as ReturnType<typeof findTemplate>;
    for (const z of [...zones].sort((a, b) => b.length - a.length)) {
      if (allText.includes(z.toLowerCase())) { matched = findTemplate(user.activeRestaurantId, z, role); break; }
    }
    if (!matched && typeof body.zone === "string") matched = findTemplate(user.activeRestaurantId, body.zone, role);
    if (matched) {
      startTime = startTime || matched.startTime;
      endTime = endTime || matched.endTime;
    } else if (!startTime || !endTime) {
      return c.json({ data: { status: "needs_zone", worker, date, zones } });
    }
  }

  const duplicate = db.select({ id: services.id })
    .from(services)
    .where(and(
      eq(services.workerId, worker.id), eq(services.restaurantId, user.activeRestaurantId),
      eq(services.date, date), eq(services.startTime, startTime), eq(services.endTime, endTime),
      ne(services.status, "cancelled"),
    ))
    .limit(1).all();
  const zone = getZoneLabel(user.activeRestaurantId, startTime);
  if (duplicate.length) return c.json({ data: { status: "duplicate", worker, date, startTime, endTime, role, zone } });

  const ownerRestaurantIds = listOwnerRestaurantIdsForRestaurant(user.activeRestaurantId);
  const overlap = findPlanningOverlap(worker.id, ownerRestaurantIds, date, startTime, endTime);
  if (overlap) return c.json({ data: { status: "overlap", worker, date, startTime, endTime, role, zone, overlap } });

  return c.json({ data: { status: "ok", worker, date, startTime, endTime, role, zone } });
});

internalWhatsappRoutes.post("/planning/services/prepare-delete", async (c) => {
  const forbidden = requireInternalPermission(c, "PLANNING_EDIT");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const workerName = typeof body.workerName === "string" ? body.workerName : "";
  const date = typeof body.date === "string" ? body.date : "";
  if (!workerName.trim() || !date) return c.json({ error: "workerName and date are required" }, 400);

  const team = activeTeamRows(user.activeRestaurantId);
  const { worker, ambiguous } = findWorkerByName(team, workerName);
  if (ambiguous.length) return c.json({ error: "Ambiguous worker", ambiguous }, 409);
  if (!worker) return c.json({ error: "Worker not found", team: team.map((w) => w.name) }, 404);

  const dayServices = db.select({ id: services.id, startTime: services.startTime, endTime: services.endTime, role: services.role })
    .from(services)
    .where(and(eq(services.workerId, worker.id), eq(services.restaurantId, user.activeRestaurantId), eq(services.date, date), ne(services.status, "cancelled")))
    .all()
    .filter((s) => isVisibleWorkerService(worker, s))
    .map((s) => ({ ...s, zone: getZoneLabel(user.activeRestaurantId, s.startTime) }));
  if (!dayServices.length) return c.json({ data: { status: "none", worker, date } });

  if (dayServices.length > 1 && !body.zone) return c.json({ data: { status: "multiple", worker, date, services: dayServices } });
  const zoneName = typeof body.zone === "string" ? body.zone.toLowerCase() : "";
  const target = zoneName ? (dayServices.find((s) => s.zone.toLowerCase().includes(zoneName)) || dayServices[0]) : dayServices[0];
  return c.json({ data: { status: "ok", worker, date, service: target } });
});

internalWhatsappRoutes.post("/planning/weeks/prepare-publish", async (c) => {
  const forbidden = requireInternalPermission(c, "PUBLISH_WEEK");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const weekStart = typeof body.weekStart === "string" ? body.weekStart : "";
  const weekEnd = typeof body.weekEnd === "string" ? body.weekEnd : "";
  if (!weekStart || !weekEnd) return c.json({ error: "weekStart and weekEnd are required" }, 400);

  const existing = db.select({ id: publishedWeeks.id }).from(publishedWeeks)
    .where(and(eq(publishedWeeks.restaurantId, user.activeRestaurantId), eq(publishedWeeks.weekDate, weekStart)))
    .get();
  if (existing) return c.json({ data: { status: "already_published", weekStart, weekEnd } });

  const rosterById = activeTeamRosterById(user.activeRestaurantId);
  const rows = db.select({ id: services.id, workerId: services.workerId, role: services.role })
    .from(services)
    .where(and(eq(services.restaurantId, user.activeRestaurantId), gte(services.date, weekStart), lte(services.date, weekEnd), ne(services.status, "cancelled")))
    .all()
    .filter((service) => isVisibleTeamService(rosterById, service));
  if (!rows.length) return c.json({ data: { status: "empty", weekStart, weekEnd } });
  return c.json({ data: { status: "ok", weekStart, weekEnd, serviceCount: rows.length, workerCount: new Set(rows.map((r) => r.workerId)).size } });
});

internalWhatsappRoutes.post("/planning/services", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.workerId !== "string" || typeof body.date !== "string" || typeof body.startTime !== "string" || typeof body.endTime !== "string") {
    return c.json({ error: "workerId, date, startTime, and endTime are required" }, 400);
  }
  if (body.role !== "kitchen" && body.role !== "floor") {
    return c.json({ error: "role must be kitchen or floor" }, 400);
  }
  try {
    const result = await createPlanningService(user, {
      workerId: body.workerId,
      workerName: typeof body.workerName === "string" ? body.workerName : undefined,
      date: body.date,
      startTime: body.startTime,
      endTime: body.endTime,
      role: body.role,
      zone: typeof body.zone === "string" ? body.zone : undefined,
    }, { source: "bot:admin", notifyWorkers: true });
    return c.json({ data: result }, 201);
  } catch (err) {
    if (err instanceof PlanningMutationError) return c.json(err.body ?? { error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/planning/services/:id/cancel", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const result = await cancelPlanningService(user, {
      serviceId: c.req.param("id"),
      zone: typeof body.zone === "string" ? body.zone : undefined,
    }, { source: "bot:admin", notifyWorkers: true });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof PlanningMutationError) return c.json(err.body ?? { error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/planning/weeks/:weekStart/publish", async (c) => {
  const user = c.get("user");
  try {
    const result = await publishPlanningWeek(user, { weekStart: c.req.param("weekStart") }, { source: "bot:admin", notifyWorkers: true });
    return c.json({ data: result }, 201);
  } catch (err) {
    if (err instanceof PlanningMutationError) return c.json(err.body ?? { error: err.message }, err.status);
    throw err;
  }
});

internalWhatsappRoutes.post("/replacements/review/prepare", async (c) => {
  const forbidden = requireInternalPermission(c, "REPLACEMENT_APPROVE");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const decision = body.decision;
  if (decision !== "pick" && decision !== "broadcast" && decision !== "refuse") return c.json({ error: "decision must be pick, broadcast, or refuse" }, 400);

  const rosterById = activeTeamRosterById(user.activeRestaurantId);
  const open = db.select().from(replacementRequests)
    .where(and(eq(replacementRequests.restaurantId, user.activeRestaurantId), eq(replacementRequests.status, "awaiting_admin_decision")))
    .orderBy(desc(replacementRequests.createdAt))
    .all()
    .filter((request) => isVisibleReplacementRequester(rosterById, request));
  if (!open.length) return c.json({ data: { status: "no_requests" } });

  let target = open[0];
  const requesterName = typeof body.requesterName === "string" ? body.requesterName.trim() : "";
  const requesterRows = open.map((r) => {
    const u = db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, r.requesterId)).limit(1).all()[0];
    return { id: r.requesterId, name: u?.name ?? "", row: r };
  });
  if (requesterName) {
    const { worker, ambiguous } = findWorkerByName(requesterRows.map((r) => ({ id: r.id, name: r.name })), requesterName);
    if (ambiguous.length) return c.json({ data: { status: "requester_ambiguous", ambiguous } });
    if (!worker) return c.json({ data: { status: "requester_not_found", requesterName } });
    target = requesterRows.find((r) => r.id === worker.id)!.row;
  } else if (open.length > 1) {
    return c.json({ data: { status: "multiple_requests", requesters: requesterRows.map((r) => r.name || "?") } });
  }

  const service = db.select({ date: services.date, startTime: services.startTime, endTime: services.endTime, role: services.role })
    .from(services).where(and(eq(services.id, target.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId))).limit(1).all()[0] ?? null;
  const requester = db.select({ name: users.name }).from(users).where(eq(users.id, target.requesterId)).limit(1).all()[0] ?? null;
  const requesterWorker = rosterById.get(target.requesterId);
  const siblingCount = service ? db.select({ id: services.id, role: services.role }).from(services)
    .where(and(eq(services.workerId, target.requesterId), eq(services.restaurantId, user.activeRestaurantId), eq(services.date, service.date), ne(services.status, "cancelled")))
    .all()
    .filter((s) => isVisibleWorkerService(requesterWorker, s))
    .length : 0;
  const isCoupure = siblingCount >= 2;
  const svcLabel = service ? (isCoupure ? `coupure le ${service.date}` : `${service.date} (${service.startTime}-${service.endTime})`) : "?";

  if (decision === "refuse") return c.json({ data: { status: "refuse_ready", replacementId: target.id, requesterId: target.requesterId, requesterName: requester?.name ?? "?", service, svcLabel } });

  const candidateIds = Array.isArray(target.candidateIds) ? target.candidateIds : [];
  const rejected = Array.isArray(target.rejectedCandidateIds) ? target.rejectedCandidateIds : [];
  const remaining = candidateIds.filter((id) => !rejected.includes(id));
  const candidateRoles: Array<"kitchen" | "floor"> =
    service?.role === "kitchen" || service?.role === "floor" ? [service.role] : ["kitchen", "floor"];
  const candidatePool: Array<{ id: string; name: string }> = listSchedulingRosterWorkers(user.activeRestaurantId, candidateRoles)
    .filter((u) => remaining.includes(u.id))
    .map((u) => ({ id: u.id, name: u.name }));
  const liveCandidateIds = candidatePool.map((candidate) => candidate.id);
  if (!liveCandidateIds.length) return c.json({ data: { status: "no_candidates", replacementId: target.id, requesterId: target.requesterId, requesterName: requester?.name ?? "?", service, svcLabel } });

  if (decision === "broadcast") return c.json({ data: { status: "broadcast_ready", replacementId: target.id, requesterId: target.requesterId, requesterName: requester?.name ?? "?", service, svcLabel, candidateIds: liveCandidateIds, candidateNames: candidatePool.map((c) => c.name) } });

  const candidateName = typeof body.candidateName === "string" ? body.candidateName.trim() : "";
  if (!candidateName) return c.json({ data: { status: "pick_needs_candidate" } });
  const { worker: pick, ambiguous } = findWorkerByName(candidatePool, candidateName);
  if (ambiguous.length) return c.json({ data: { status: "pick_ambiguous", ambiguous } });
  if (!pick) return c.json({ data: { status: "pick_not_candidate", candidateName, available: candidatePool.map((c) => c.name) } });

  return c.json({ data: { status: "pick_ready", replacementId: target.id, requesterId: target.requesterId, requesterName: requester?.name ?? "?", pickedId: pick.id, pickedName: pick.name, service, svcLabel } });
});

internalWhatsappRoutes.post("/replacements/:id/review", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { decision?: unknown; candidateId?: unknown };
  if (body.decision !== "pick" && body.decision !== "broadcast" && body.decision !== "refuse" && body.decision !== "approve_absence") {
    return c.json({ error: "decision must be pick, broadcast, refuse, or approve_absence" }, 400);
  }
  if (body.candidateId != null && typeof body.candidateId !== "string") {
    return c.json({ error: "candidateId must be a string" }, 400);
  }

  try {
    const result = await reviewReplacementRequest(user, {
      requestId: id,
      decision: body.decision as ReviewReplacementDecision,
      candidateId: body.candidateId as string | null | undefined,
      source: "bot:admin",
      notifyRequesterProgress: true,
    });
    return c.json({
      data: {
        decision: result.decision,
        requesterId: result.requesterId,
        requesterName: result.requesterName,
        service: result.service,
        pickedName: result.pickedName ?? null,
        candidateCount: result.candidateCount ?? null,
        status: result.updated.status,
      },
    });
  } catch (err) {
    if (err instanceof ReplacementReviewError) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  }
});

internalWhatsappRoutes.get("/workers/:id/hours", (c) => {
  const forbidden = requireInternalPermission(c, "HOURS_VIEW");
  if (forbidden) return forbidden;

  const user = c.get("user");
  const workerId = c.req.param("id");
  const restaurantIds = ownerScopeRestaurantIds(user);
  const [worker] = dedupeTeamRows(restaurantIds.flatMap((restaurantId) =>
    activeTeamRows(restaurantId).filter((w) => w.id === workerId).map((w) => ({
      ...w,
      restaurantIds: [restaurantId],
      restaurantNames: [restaurantNameById(restaurantId)],
    })),
  ));
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const periodRaw = (c.req.query("period") || "").trim().toLowerCase();
  const isWeekly = /semaine|week|hebdo/.test(periodRaw);
  let from: string;
  let to: string;
  let label: string;
  if (isWeekly) {
    const now = new Date(`${todayInTimeZone(user.restaurantTimezone)}T12:00:00`);
    const mon = mondayForDate(now);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    from = fmtDate(mon);
    to = fmtDate(sun);
    label = `semaine du ${from}`;
  } else {
    const month = resolveMonth(periodRaw, user.restaurantTimezone);
    const [y, m] = month.split("-").map(Number);
    from = `${month}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    to = `${month}-${lastDay}`;
    label = `${MONTH_NAMES_FR[m - 1]} ${y}`;
  }

  const rows = workerScheduleRowsForRestaurants(worker.id, worker.restaurantIds ?? restaurantIds, from, to);

  const totalHours = rows.reduce((sum, s) => sum + serviceHours(s.startTime, s.endTime), 0);
  return c.json({
    data: {
      worker,
      periodLabel: label,
      from,
      to,
      serviceCount: rows.length,
      totalHours: Math.round(totalHours * 10) / 10,
    },
  });
});
