import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import {
  users, services, serviceTemplates, serviceTemplateOverrides, workerAvailability, workerRestrictions,
  restaurants, restaurantClosures, holidayRequests, staffingTargets, staffingProfiles,
  staffingSchedule, workerPreferredSchedule, ownerMemberships, restaurantMemberships,
  workerRestaurantProfiles, workerShareAuthorizations,
} from "../db/schema.js";
import { eq, and, gte, lte, ne, gt, or, inArray, isNotNull, isNull } from "drizzle-orm";
import { timesOverlap, isoWeekNum, isoWeekYear, serviceHours as calcServiceHours, isoDayOfWeek, timeToMinutes, getMonday, weekDates as utilWeekDates, zoneToAvailSlot, parseOpenDays, buildAvailabilityMap, isWorkerAvailable, buildRestrictionMap, isAvailableByRestrictions } from "../utils/scheduling.js";
import { requireAuth, requirePermission, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { logAudit } from "../db/audit.js";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "../utils/ilp-solver.js";
import { solveWithTiers } from "../utils/solver-tiers.js";
import { deriveDowTemplates, templateMatchEnabled } from "../services/dow-template.js";
import { isBootstrapWorker } from "../utils/c9-freshness.js";
import { hasChefLabel, resolveWeights, parseCustomWeights, resolveHcrRate, subRoleSubstitution, type HcrLevel, type HcrGrid } from "@comptoir/shared";
import { computeLeaveBalances, computeLeaveUrgency } from "../services/holiday-advice.js";
import { listRestaurantMemberUserIds } from "../services/restaurant-context.js";

export const autostaffingRoutes = new Hono<AppEnv>();

// /auto-fill is cron-authenticated with CRON_SECRET below. It cannot use the
// session middleware because VPS cron calls it without browser cookies.
const isAutoFillCronPath = (path: string) => path.endsWith("/autostaffing/auto-fill") || path.endsWith("/auto-fill");

autostaffingRoutes.use("*", async (c, next) => {
  if (isAutoFillCronPath(c.req.path)) {
    await next();
    return;
  }
  return requireAuth(c, next);
});
autostaffingRoutes.use("*", async (c, next) => {
  if (isAutoFillCronPath(c.req.path)) {
    await next();
    return;
  }
  return requireActiveSubscription(c, next);
});

// Surface solver failures (malformed model / sidecar-side exceptions) as 5xx
// with the error detail, instead of Hono's generic "Internal Server Error".
// Bad-model errors must escape cpsat-solver so operators see the real reason —
// see audit H5 and solveCPSAT's throw. `solveWithFallback` still absorbs
// unreachability internally (ILP fallback), so anything reaching here is
// genuinely un-recoverable.
autostaffingRoutes.onError((err, c) => {
  console.error("[autostaffing] unhandled error:", err?.message || err);
  return c.json({ error: err?.message || "autostaffing failed" }, 500);
});

type Role = "kitchen" | "floor";

const ALLOWED_STYLES = new Set(["equilibre", "equipe-stable", "economique", "resilience"]);
const LOCAL_MULTI_RESTAURANT_RESERVE_PENALTY = 20;
const SHARED_WORKER_RESERVE_PENALTY = 80;

function assignmentPoolPenalty(worker: { multiRestaurantWilling?: boolean | null; sharedFromRestaurantId?: string | null }): number {
  if (worker.sharedFromRestaurantId) return SHARED_WORKER_RESERVE_PENALTY;
  return worker.multiRestaurantWilling ? LOCAL_MULTI_RESTAURANT_RESERVE_PENALTY : 0;
}

export function canRunDemoOptimization(_restaurantStatus: string | null | undefined): boolean {
  // Demo restaurants must be able to showcase auto-staffing during sales demos.
  // Auth, permissions, subscription bypass, and route-level rate limits still apply.
  return true;
}

type UnfilledDiagnostic = {
  slotId: number;
  message: string;
};

type Blocker = "unavailable" | "subrole" | "overlap" | "hours" | "rest" | "eligible";
type SolveTier = 0 | 1 | 2 | 3 | 4;

function addDaysStr(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function workerWeeklyCap(w: ILPWorker, config: ILPConfig): number {
  const effectiveOtCap = w.otCap ?? config.otCap;
  if (w.contractHours != null && w.contractHours === 0 && w.contractType === "extra") {
    return Math.min(effectiveOtCap, 48);
  }
  const configuredCap = w.contractHours != null && w.contractHours === 0 ? 0
    : w.contractHours != null ? Math.max(w.contractHours, effectiveOtCap) : effectiveOtCap;
  return Math.min(configuredCap, 48);
}

function workerDailyCap(w: ILPWorker, slot: ILPSlot, config: ILPConfig): number {
  if (slot.compound) return config.maxDailyHoursCompound;
  if (w.role === "floor") return 11.5;
  return hasChefLabel(w.subRoles) ? 11 : 11;
}

function summarizeCounts(counts: Record<Blocker, number>): string {
  const parts: string[] = [];
  if (counts.unavailable) parts.push(`${counts.unavailable} indispo`);
  if (counts.subrole) parts.push(`${counts.subrole} compétence`);
  if (counts.overlap) parts.push(`${counts.overlap} chevauchement`);
  if (counts.hours) parts.push(`${counts.hours} heures`);
  if (counts.rest) parts.push(`${counts.rest} repos`);
  if (counts.eligible) parts.push(`${counts.eligible} théoriquement OK`);
  return parts.join(", ");
}

function formatSolverTierWarning(tier: SolveTier, relaxations: readonly string[] = []): string {
  if (tier === 4) {
    return "Mode exceptionnel utilisé — le planning restait incomplet après les essais conformes. Comptoir a tenté de compléter les postes en autorisant jusqu'à 60h/semaine avec alerte conformité si un salarié dépasse 48h.";
  }
  if (tier === 3) {
    return "Planning complété en mode secours — Comptoir a utilisé une méthode de remplissage simplifiée, tout en conservant la limite normale de 48h/semaine.";
  }
  if (tier === 2) {
    return "Planning complété avec assouplissement — Comptoir a relâché certains réglages internes pour éviter les postes vides, sans dépasser la limite légale de 48h/semaine.";
  }
  if (tier === 1) {
    return "Planning complété avec priorité aux postes ouverts — Comptoir a accepté quelques écarts de préférence pour couvrir davantage de créneaux.";
  }
  return relaxations.length > 0
    ? "Planning calculé avec des ajustements automatiques."
    : "";
}

export function buildUnfilledSlotDiagnostics(
  workers: ILPWorker[],
  slots: ILPSlot[],
  assignments: Array<{ workerId: string; slotId: number }>,
  checker: AvailabilityChecker,
  config: ILPConfig,
): UnfilledDiagnostic[] {
  const slotById = new Map(slots.map(s => [s.id, s]));
  const assignedBySlot = new Map<number, Set<string>>();
  const plannedByWorkerDate = new Map<string, Array<{ slotId: number; startTime: string; endTime: string; hours: number }>>();
  const plannedHoursByWorker = new Map<string, number>();
  const plannedHoursByWorkerDate = new Map<string, number>();

  for (const a of assignments) {
    const s = slotById.get(a.slotId);
    if (!s) continue;
    if (!assignedBySlot.has(a.slotId)) assignedBySlot.set(a.slotId, new Set());
    assignedBySlot.get(a.slotId)!.add(a.workerId);
    const dateKey = `${a.workerId}_${s.date}`;
    if (!plannedByWorkerDate.has(dateKey)) plannedByWorkerDate.set(dateKey, []);
    plannedByWorkerDate.get(dateKey)!.push({ slotId: s.id, startTime: s.startTime, endTime: s.endTime, hours: s.hours });
    plannedHoursByWorker.set(a.workerId, (plannedHoursByWorker.get(a.workerId) ?? 0) + s.hours);
    plannedHoursByWorkerDate.set(dateKey, (plannedHoursByWorkerDate.get(dateKey) ?? 0) + s.hours);
  }

  function lastEnd(workerId: string, date: string, excludeSlotId?: number): number | undefined {
    const w = workers.find(x => x.id === workerId);
    let out = w?.existingLastEnd.get(date);
    for (const p of plannedByWorkerDate.get(`${workerId}_${date}`) ?? []) {
      if (p.slotId === excludeSlotId) continue;
      let end = timeToMinutes(p.endTime);
      if (end < timeToMinutes(p.startTime)) end += 24 * 60;
      out = out === undefined ? end : Math.max(out, end);
    }
    return out;
  }

  function firstStart(workerId: string, date: string, excludeSlotId?: number): number | undefined {
    const w = workers.find(x => x.id === workerId);
    let out = w?.existingFirstStart.get(date);
    for (const p of plannedByWorkerDate.get(`${workerId}_${date}`) ?? []) {
      if (p.slotId === excludeSlotId) continue;
      const start = timeToMinutes(p.startTime);
      out = out === undefined ? start : Math.min(out, start);
    }
    return out;
  }

  function restBlocked(w: ILPWorker, slot: ILPSlot): boolean {
    const start = timeToMinutes(slot.startTime);
    let end = timeToMinutes(slot.endTime);
    if (end < start) end += 24 * 60;
    const prevEnd = lastEnd(w.id, addDaysStr(slot.date, -1), slot.id);
    if (prevEnd !== undefined && ((24 * 60 - prevEnd) + start) / 60 < config.minRestHours) return true;
    const sameLast = lastEnd(w.id, slot.date, slot.id);
    if (sameLast !== undefined && sameLast <= start && (start - sameLast) / 60 < config.minRestHours) return true;
    const nextStart = firstStart(w.id, addDaysStr(slot.date, 1), slot.id);
    if (nextStart !== undefined && ((24 * 60 - end) + nextStart) / 60 < config.minRestHours) return true;
    return false;
  }

  const diagnostics: UnfilledDiagnostic[] = [];
  for (const slot of slots) {
    if (slot.compound && slot.compoundPairId !== undefined && slot.id > slot.compoundPairId) continue;
    const assigned = assignedBySlot.get(slot.id)?.size ?? 0;
    const shortage = Math.max(0, slot.target - slot.existingFill - assigned);
    if (shortage <= 0) continue;

    const assignedHere = assignedBySlot.get(slot.id) ?? new Set<string>();
    const sameRole = workers.filter(w => w.role === slot.role && !assignedHere.has(w.id));
    const counts: Record<Blocker, number> = { unavailable: 0, subrole: 0, overlap: 0, hours: 0, rest: 0, eligible: 0 };
    const requiredSubRoles = Object.entries(slot.roleBreakdown ?? {}).filter(([, n]) => n > 0).map(([sr]) => sr);

    for (const w of sameRole) {
      let blocker: Blocker = "eligible";
      if (!checker.isAvailable(w.id, slot)) blocker = "unavailable";
      else if (requiredSubRoles.length > 0 && !requiredSubRoles.some(sr => subRoleSubstitution(sr, w.subRoles).eligible)) blocker = "subrole";
      else {
        const existing = w.existingServicesByDate.get(slot.date) ?? [];
        const planned = plannedByWorkerDate.get(`${w.id}_${slot.date}`) ?? [];
        if (existing.some(s => timesOverlap(s.startTime, s.endTime, slot.startTime, slot.endTime))
          || planned.some(s => s.slotId !== slot.id && timesOverlap(s.startTime, s.endTime, slot.startTime, slot.endTime))) {
          blocker = "overlap";
        } else {
          const dayHours = (w.existingDailyHours.get(slot.date) ?? 0) + (plannedHoursByWorkerDate.get(`${w.id}_${slot.date}`) ?? 0) + slot.hours;
          const weekHours = w.existingWeeklyHours + (plannedHoursByWorker.get(w.id) ?? 0) + slot.hours;
          if (dayHours > workerDailyCap(w, slot, config) + 1e-6 || weekHours > workerWeeklyCap(w, config) + 1e-6) blocker = "hours";
          else if (restBlocked(w, slot)) blocker = "rest";
        }
      }
      counts[blocker]++;
    }

    const label = `${slot.date} ${slot.role === "kitchen" ? "Cuisine" : "Salle"} ${slot.zone} ${slot.startTime}-${slot.endTime}`;
    const subRoleText = requiredSubRoles.length > 0 ? ` (${requiredSubRoles.join("/")})` : "";
    let reason: string;
    if (sameRole.length === 0) reason = `aucun employé actif dans ce rôle.`;
    else if (counts.unavailable === sameRole.length) reason = `${counts.unavailable}/${sameRole.length} employés du rôle sont indisponibles (congé, contrat, disponibilité ou restriction).`;
    else if (counts.subrole > 0 && counts.subrole + counts.unavailable === sameRole.length) reason = `compétence requise insuffisante${subRoleText}.`;
    else if (counts.overlap > 0 && counts.overlap + counts.subrole + counts.unavailable === sameRole.length) reason = `les candidats restants sont déjà placés sur un créneau qui chevauche.`;
    else if (counts.hours > 0 && counts.hours + counts.overlap + counts.subrole + counts.unavailable === sameRole.length) reason = `les candidats restants dépasseraient leur plafond d'heures.`;
    else if (counts.rest > 0 && counts.rest + counts.hours + counts.overlap + counts.subrole + counts.unavailable === sameRole.length) reason = `les candidats restants casseraient le repos légal HCR.`;
    else if (counts.eligible > 0) reason = `des candidats existent, mais l'arbitrage global les consomme sur d'autres créneaux plus contraints (${summarizeCounts(counts)}).`;
    else reason = `blocages mixtes: ${summarizeCounts(counts) || "aucun candidat exploitable"}.`;

    diagnostics.push({
      slotId: slot.id,
      message: `Poste non pourvu — ${label}: manque ${shortage}/${slot.target}. ${reason}`,
    });
  }
  return diagnostics;
}

function restaurantCanRunOptimization(restaurantId: string): boolean {
  const [row] = db.select({ status: restaurants.status })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();
  return canRunDemoOptimization(row?.status);
}

/** Generate array of date strings for a Mon-Sun week containing `dateStr` */
function weekDates(dateStr: string): string[] {
  return utilWeekDates(getMonday(dateStr));
}

/** Check if a date falls within any closure period */
function isClosureDate(dateStr: string, closures: { startDate: string; endDate: string }[]): boolean {
  return closures.some((c) => dateStr >= c.startDate && dateStr <= c.endDate);
}

/** Check if worker has approved/pending holiday on date */
function isOnHoliday(workerId: string, dateStr: string, holidays: { workerId: string; startDate: string; endDate: string }[]): boolean {
  return holidays.some((h) => h.workerId === workerId && dateStr >= h.startDate && dateStr <= h.endDate);
}

/** Check if worker is temporarily deactivated on a given date */
function isTempInactive(worker: { inactiveFrom?: string | null; inactiveUntil?: string | null }, dateStr: string): boolean {
  if (!worker.inactiveFrom || !worker.inactiveUntil) return false;
  return dateStr >= worker.inactiveFrom && dateStr <= worker.inactiveUntil;
}


// ── Preview: show what would be generated without creating services ──

// POST /autostaffing/preview  { date: "2026-03-30", maxTier?: 0|1|2|3|4 }
autostaffingRoutes.post("/preview", requirePermission("OPTIMIZE_RUN"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!restaurantCanRunOptimization(restaurant.restaurantId)) {
    return c.json({ error: "Optimisation désactivée sur la démo publique" }, 403);
  }
  const { date, targetOverrides, profileId: requestedProfileId, maxTier, styleOverride } = await c.req.json();
  if (!date) return c.json({ error: "date required" }, 400);

  // Preview defaults to Tier 1 (soft slot floors only). Callers can opt into 2/3
  // explicitly; env SOLVER_MAX_TIER further clamps the ceiling inside the wrapper.
  const requestedTier = typeof maxTier === "number" ? (Math.max(0, Math.min(4, maxTier)) as 0 | 1 | 2 | 3 | 4) : 1;
  const validStyle = ALLOWED_STYLES.has(styleOverride) ? (styleOverride as PlanOptions["styleOverride"]) : undefined;
  const result = await generatePlan(restaurant.restaurantId, date, targetOverrides, {
    maxTier: requestedTier,
    styleOverride: validStyle,
    profileIdOverride: typeof requestedProfileId === "string" ? requestedProfileId : undefined,
  });

  // Include existing manual services that would be preserved on overwrite
  const dates = weekDates(date);
  const manualServices = db.select({
    id: services.id,
    workerId: services.workerId,
    workerName: users.name,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
  }).from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(and(
      eq(services.restaurantId, restaurant.restaurantId),
      gte(services.date, dates[0]),
      lte(services.date, dates[6]),
      ne(services.status, "cancelled"),
      eq(services.source, "manual"),
    )).all();

  const autoServices = db.select({ id: services.id })
    .from(services)
    .where(and(
      eq(services.restaurantId, restaurant.restaurantId),
      gte(services.date, dates[0]),
      lte(services.date, dates[6]),
      ne(services.status, "cancelled"),
      eq(services.source, "auto"),
    )).all();

  return c.json({
    data: {
      ...result,
      manualServices,          // manual services that will be kept on overwrite
      autoServicesToReplace: autoServices.length, // auto services that will be deleted on overwrite
    },
  });
});

// ── Generate: create services for the week ──

// POST /autostaffing/generate  { date: "2026-03-30", overwrite?: boolean, maxTier?: 0|1|2|3|4 }
autostaffingRoutes.post("/generate", requirePermission("OPTIMIZE_RUN"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!restaurantCanRunOptimization(restaurant.restaurantId)) {
    return c.json({ error: "Optimisation désactivée sur la démo publique" }, 403);
  }
  const { date, overwrite, targetOverrides, profileId: requestedProfileId, maxTier, styleOverride } = await c.req.json();
  if (!date) return c.json({ error: "date required" }, 400);

  // Generate defaults to Tier 4: it first tries fully compliant tiers, then may
  // use the exceptional 60h crisis cap only as the final fill-first fallback.
  const requestedTier = typeof maxTier === "number" ? (Math.max(0, Math.min(4, maxTier)) as 0 | 1 | 2 | 3 | 4) : 4;
  const validStyle = ALLOWED_STYLES.has(styleOverride) ? (styleOverride as PlanOptions["styleOverride"]) : undefined;
  const plan = await generatePlan(restaurant.restaurantId, date, targetOverrides, {
    maxTier: requestedTier,
    styleOverride: validStyle,
    profileIdOverride: typeof requestedProfileId === "string" ? requestedProfileId : undefined,
    ignoreAutoServicesForWeek: !!overwrite,
  });

  // If overwrite, only delete auto-generated services — manual services are preserved
  const dates = weekDates(date);
  const from = dates[0];
  const to = dates[6];

  let manualKept = 0;
  if (overwrite) {
    db.delete(services)
      .where(and(
        eq(services.restaurantId, restaurant.restaurantId),
        gte(services.date, from),
        lte(services.date, to),
        ne(services.status, "cancelled"),
        eq(services.source, "auto"),
      ))
      .run();

    // Count manual services that remain (for response info)
    manualKept = db.select({ id: services.id })
      .from(services)
      .where(and(
        eq(services.restaurantId, restaurant.restaurantId),
        gte(services.date, from),
        lte(services.date, to),
        ne(services.status, "cancelled"),
        eq(services.source, "manual"),
      ))
      .all().length;
  }

  // Batch overlap check: one query instead of N per-service DB reads.
  // Catches race conditions (manual edits between preview and generate).
  const freshExisting = db.select({
    workerId: services.workerId, date: services.date,
    startTime: services.startTime, endTime: services.endTime,
  }).from(services).where(and(
    eq(services.restaurantId, restaurant.restaurantId),
    gte(services.date, from), lte(services.date, to),
    ne(services.status, "cancelled"),
  )).all();

  const freshMap = new Map<string, Array<{ startTime: string; endTime: string }>>();
  for (const s of freshExisting) {
    const key = `${s.workerId}_${s.date}`;
    if (!freshMap.has(key)) freshMap.set(key, []);
    freshMap.get(key)!.push({ startTime: s.startTime, endTime: s.endTime });
  }

  let created = 0;
  let skipped = 0;
  for (const entry of plan.services) {
    const key = `${entry.workerId}_${entry.date}`;
    const existing = freshMap.get(key) || [];
    if (existing.some(s => timesOverlap(s.startTime, s.endTime, entry.startTime, entry.endTime))) {
      skipped++;
      continue;
    }
    db.insert(services).values({
      workerId: entry.workerId,
      restaurantId: restaurant.restaurantId,
      date: entry.date,
      startTime: entry.startTime,
      endTime: entry.endTime,
      role: entry.role,
      source: "auto",
      status: "scheduled",
      filledAs: entry.filledAs ?? null,
    }).run();
    // Track newly inserted so subsequent entries for same worker+date are caught
    if (!freshMap.has(key)) freshMap.set(key, []);
    freshMap.get(key)!.push({ startTime: entry.startTime, endTime: entry.endTime });
    created++;
  }

  // Record which profile was used for this week so the schedule view can display it
  const usedProfileId = requestedProfileId || plan.activeProfileId;
  if (usedProfileId) {
    const weekYear = isoWeekYear(from);
    const weekNum = isoWeekNum(from);
    const existing = db.select({ id: staffingSchedule.id })
      .from(staffingSchedule)
      .where(and(
        eq(staffingSchedule.restaurantId, restaurant.restaurantId),
        eq(staffingSchedule.year, weekYear),
        eq(staffingSchedule.week, weekNum),
      )).limit(1).all();
    if (existing.length > 0) {
      db.update(staffingSchedule)
        .set({ profileId: usedProfileId })
        .where(eq(staffingSchedule.id, existing[0].id))
        .run();
    } else {
      db.insert(staffingSchedule).values({
        restaurantId: restaurant.restaurantId,
        year: weekYear,
        week: weekNum,
        profileId: usedProfileId,
      }).run();
    }
  }

  // Compute unfilled slots: compare targets vs actual services post-generation
  const postServices = db.select({ date: services.date, role: services.role })
    .from(services)
    .where(and(
      eq(services.restaurantId, restaurant.restaurantId),
      gte(services.date, from),
      lte(services.date, to),
      ne(services.status, "cancelled"),
    )).all();
  const fillCount = new Map<string, number>();
  for (const s of postServices) {
    const dow = isoDayOfWeek(s.date);
    // zone is not on the service row — count by dow_role only
    const key = `${dow}_${s.role}`;
    fillCount.set(key, (fillCount.get(key) || 0) + 1);
  }

  // Sum targets by dow_role (across zones) — merge profile targets with any overrides.
  // Important: ignore full-day restaurant closures. generatePlan skips closed days,
  // and the schedule UI also suppresses ghost/missing cards on closures; counting
  // their targets here produced a false "Postes non pourvus" popup for closed days.
  const closureRows = db.select({ startDate: restaurantClosures.startDate, endDate: restaurantClosures.endDate })
    .from(restaurantClosures)
    .where(eq(restaurantClosures.restaurantId, restaurant.restaurantId))
    .all();
  const dateByDow = new Map(dates.map(d => [isoDayOfWeek(d), d] as const));
  const shouldCountTargetDow = (dow: number) => {
    const dateForDow = dateByDow.get(dow);
    return !!dateForDow && !isClosureDate(dateForDow, closureRows);
  };
  const targetByDowRole = new Map<string, number>();
  const profileTargets = plan.activeProfileId
    ? db.select({ dayOfWeek: staffingTargets.dayOfWeek, role: staffingTargets.role, zone: staffingTargets.zone, count: staffingTargets.count })
        .from(staffingTargets).where(and(eq(staffingTargets.restaurantId, restaurant.restaurantId), eq(staffingTargets.profileId, plan.activeProfileId))).all()
    : [];
  // Build per-slot target map, then apply overrides on top
  const slotTargetMap = new Map<string, number>();
  for (const t of profileTargets) {
    slotTargetMap.set(`${t.dayOfWeek}_${t.role}_${t.zone}`, t.count);
  }
  if (targetOverrides?.length) {
    for (const t of targetOverrides) {
      slotTargetMap.set(`${t.dayOfWeek}_${t.role}_${t.zone}`, t.count);
    }
  }
  // Aggregate by dow_role
  for (const [slotKey, count] of slotTargetMap) {
    const [dowRaw, role] = slotKey.split("_");
    const dow = Number(dowRaw);
    if (!shouldCountTargetDow(dow)) continue;
    const key = `${dow}_${role}`;
    targetByDowRole.set(key, (targetByDowRole.get(key) || 0) + count);
  }
  let unfilled = 0;
  for (const [key, target] of targetByDowRole) {
    const actual = fillCount.get(key) || 0;
    if (actual < target) unfilled += target - actual;
  }

  if (created > 0) {
    logAudit({
      restaurantId: restaurant.restaurantId,
      tableName: "services",
      rowId: `week:${dates[0]}`,
      action: "insert",
      actorId: user.id,
      actorName: user.name,
      source: "auto-scheduler",
      changes: { created: { new: created }, skipped: { new: skipped }, unfilled: { new: unfilled } },
      summary: `Auto-staffing semaine ${dates[0]} : ${created} créés, ${skipped} ignorés${unfilled ? `, ${unfilled} non-pourvus` : ""}`,
    });
  }

  return c.json({
    data: {
      week: plan.week,
      created,
      skipped,
      manualKept,
      total: plan.services.length,
      unfilled,
      warnings: plan.warnings,
    },
  });
});

// ── Auto-fill: cron endpoint — fills upcoming weeks for all restaurants with autoStaffingWeeks > 0 ──

export async function runAutoFill() {
  // Find all live/demo restaurants with auto-staffing enabled. Demo restaurants
  // power the public demo and should exercise the same prefill behaviour.
  const activeRestaurants = db.select({
    id: restaurants.id,
    name: restaurants.name,
    autoStaffingWeeks: restaurants.autoStaffingWeeks,
    status: restaurants.status,
  })
    .from(restaurants)
    .where(and(gt(restaurants.autoStaffingWeeks, 0), inArray(restaurants.status, ["active", "demo"])))
    .all();

  const results: Array<{ restaurant: string; week: string; created: number; skipped: number }> = [];

  for (const resto of activeRestaurants) {
    const weeksAhead = resto.autoStaffingWeeks;

    // For each week from next week to N weeks ahead
    for (let w = 1; w <= weeksAhead; w++) {
      const target = new Date();
      target.setDate(target.getDate() + w * 7);
      const targetStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;

      const dates = weekDates(targetStr);
      const from = dates[0];
      const to = dates[6];

      // generatePlan is idempotent — it skips already-filled slots,
      // so it's safe to run on weeks that already have some services.

      // Generate and insert (fills gaps only)
      const plan = await generatePlan(resto.id, targetStr);
      // Batch overlap check for this week
      const cronFresh = db.select({
        workerId: services.workerId, date: services.date,
        startTime: services.startTime, endTime: services.endTime,
      }).from(services).where(and(
        eq(services.restaurantId, resto.id),
        gte(services.date, from), lte(services.date, to),
        ne(services.status, "cancelled"),
      )).all();

      const cronFreshMap = new Map<string, Array<{ startTime: string; endTime: string }>>();
      for (const s of cronFresh) {
        const key = `${s.workerId}_${s.date}`;
        if (!cronFreshMap.has(key)) cronFreshMap.set(key, []);
        cronFreshMap.get(key)!.push({ startTime: s.startTime, endTime: s.endTime });
      }

      let created = 0;
      let skipped = 0;

      for (const entry of plan.services) {
        const key = `${entry.workerId}_${entry.date}`;
        const existing = cronFreshMap.get(key) || [];
        if (existing.some(s => timesOverlap(s.startTime, s.endTime, entry.startTime, entry.endTime))) {
          skipped++;
          continue;
        }
        db.insert(services).values({
          workerId: entry.workerId,
          restaurantId: resto.id,
          date: entry.date,
          startTime: entry.startTime,
          endTime: entry.endTime,
          role: entry.role,
          source: "auto",
          status: "scheduled",
          filledAs: entry.filledAs ?? null,
        }).run();
        if (!cronFreshMap.has(key)) cronFreshMap.set(key, []);
        cronFreshMap.get(key)!.push({ startTime: entry.startTime, endTime: entry.endTime });
        created++;
      }

      if (created > 0) {
        // Record which profile was used
        if (plan.activeProfileId) {
          const weekYear = isoWeekYear(from);
          const weekNum = isoWeekNum(from);
          const existing = db.select({ id: staffingSchedule.id })
            .from(staffingSchedule)
            .where(and(
              eq(staffingSchedule.restaurantId, resto.id),
              eq(staffingSchedule.year, weekYear),
              eq(staffingSchedule.week, weekNum),
            )).limit(1).all();
          if (existing.length > 0) {
            db.update(staffingSchedule)
              .set({ profileId: plan.activeProfileId })
              .where(eq(staffingSchedule.id, existing[0].id))
              .run();
          } else {
            db.insert(staffingSchedule).values({
              restaurantId: resto.id,
              year: weekYear,
              week: weekNum,
              profileId: plan.activeProfileId,
            }).run();
          }
        }
        results.push({ restaurant: resto.name, week: `${from} → ${to}`, created, skipped });
      }
    }
  }

  console.log(`⚙️ Auto-fill: ${results.length} weeks generated for ${activeRestaurants.length} restaurant(s)`);
  return { restaurants: activeRestaurants.length, results };
}

// POST /autostaffing/auto-fill  (bearer-token auth, called by VPS cron)
autostaffingRoutes.post("/auto-fill", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const data = await runAutoFill();
  return c.json({ data });
});

// ── Core scheduling logic ──

export type SyntheticService = {
  workerId: string;
  date: string;
  startTime: string;
  endTime: string;
  role: "kitchen" | "floor";
};

export type ForbiddenSolverAssignment = {
  workerId: string;
  date: string;
  startTime: string;
  endTime: string;
  role?: string;
  zone?: string;
};

export type PlanOptions = {
  /** Which holiday statuses to include — defaults to ["approved", "pending"] */
  holidayFilter?: ("approved" | "pending")[];
  /** Extra absences to inject (e.g. a pending holiday treated as approved) */
  extraAbsences?: Array<{ workerId: string; startDate: string; endDate: string }>;
  /** Override contract hours for specific workers (what-if simulation) */
  contractOverrides?: Record<string, number>;
  /** Override personal weekly max/OT cap for specific workers (what-if simulation). */
  maxWeeklyOverrides?: Record<string, number>;
  /** Worker IDs whose restrictions should be ignored (what-if simulation) */
  restrictionOverrides?: string[];
  /** Override a worker's role (cross-training simulation: e.g. kitchen→salle) */
  roleOverrides?: Record<string, string>;
  /** Add extra sub-roles to a worker (intra-role training simulation) */
  subRoleOverrides?: Record<string, string[]>;
  /** Inject virtual (phantom) workers for hire simulation */
  virtualWorkers?: Array<{
    id: string;
    name: string;
    role: string;
    contractHours: number;
  }>;
  /** Services from prior simulated weeks (multi-week chaining).
   *  Injected into constraint checks (rest, consecutive days, rolling hours)
   *  but NOT into the current week's slot fill counts. */
  syntheticServices?: SyntheticService[];
  /** Return model inputs without solving (for multi-week analysis) */
  _buildOnly?: boolean;
  /** Force a specific staffing profile for this week, bypassing staffingSchedule lookup.
   *  Used by staffing-analysis + auto-optimize to test a single profile across 12 weeks. */
  profileIdOverride?: string;
  /** Merge extra target rows on top of the positional `targetOverrides` arg.
   *  Used by expansion-suggestions to inject hypothetical shifts. */
  targetOverrides?: Array<{ dayOfWeek: number; role: string; zone: string; count: number; roleBreakdown?: Record<string, number> }>;
  /** Override the restaurant's openDays for the solve window (expansion simulation).
   *  Values: "midi" | "soir" | "both" per ISO day-of-week (1=Mon..7=Sun). */
  openDaysOverride?: Record<string, "midi" | "soir" | "both">;
  /** Max relaxation tier when Tier 0 is infeasible. 0=no relaxation, 1=soft slot floors,
   *  2=soft OT + bypass C7/C8, 3=greedy at 48h, 4=exceptional greedy at 60h.
   *  Default 1 inside generatePlan; route-level generate opts into 4. Env `SOLVER_MAX_TIER` clamps higher. */
  maxTier?: 0 | 1 | 2 | 3 | 4;
  /** One-shot override of `restaurants.preferredStyle` for this solve only.
   *  Drives the dropdown on /schedule next to the Brouillon badge — does not
   *  persist anywhere; per-restaurant default still lives in settings. */
  styleOverride?: "equilibre" | "equipe-stable" | "economique" | "resilience";
  /** For recommendation what-ifs: forbid specific worker-slot pairs without
   *  removing the worker from the rest of the weekly solve. */
  forbiddenAssignments?: ForbiddenSolverAssignment[];
  /** For replacement what-ifs: remove these concrete services from the seeded
   *  existing schedule so the solver treats their slot as open. */
  ignoreServiceIds?: string[];
  /** Build the model as if current-week auto services did not exist.
   *  Used by /generate overwrite so we solve the replacement plan before
   *  deleting old auto-generated services. Manual services are still preserved. */
  ignoreAutoServicesForWeek?: boolean;
};

export async function generatePlan(restaurantId: string, dateStr: string, targetOverrides?: Array<{ dayOfWeek: number; role: string; zone: string; count: number }>, options?: PlanOptions) {
  const dates = weekDates(dateStr);
  const week = { from: dates[0], to: dates[6] };

  // Fetch restaurant config
  const [restaurant] = db.select({
    ownerId: restaurants.ownerId,
    openDays: restaurants.openDays,
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
    overtimeDistribution: restaurants.overtimeDistribution,
    workerPreferencesEnabled: restaurants.workerPreferencesEnabled,
    disabledComplianceRules: restaurants.disabledComplianceRules,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
    hcrGrid: restaurants.hcrGrid,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  const openDaysBase = restaurant ? parseOpenDays(restaurant.openDays) : {};
  const openDays = options?.openDaysOverride
    ? { ...openDaysBase, ...options.openDaysOverride }
    : openDaysBase;
  const prefEnabled = !!restaurant?.workerPreferencesEnabled;
  const disabledRules = new Set<string>(JSON.parse(restaurant?.disabledComplianceRules || "[]"));
  const effectiveStyle = options?.styleOverride ?? restaurant?.preferredStyle;
  const styleWeights = resolveWeights(effectiveStyle, parseCustomWeights(restaurant?.customWeights));
  const ownerRestaurantIds = restaurant?.ownerId
    ? db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.ownerId, restaurant.ownerId))
      .all()
      .map((row) => row.id)
    : [restaurantId];
  if (!ownerRestaurantIds.includes(restaurantId)) ownerRestaurantIds.push(restaurantId);

  // Overtime policy
  const otMode = restaurant?.overtimeMode ?? "flexible";
  const otCap = otMode === "strict" ? 39 : otMode === "controlled" ? (restaurant?.overtimeWeeklyCap ?? 48) : 48;
  const otDistribution = restaurant?.overtimeDistribution ?? "willing-first";

  // Build override map: templateId → { dayOfWeek → { startTime, endTime } }
  const overrideMap = new Map<string, Map<number, { startTime: string; endTime: string }>>();

  let templates: { role: string; zone: string; startTime: string; endTime: string; _id?: string }[] = [];

  const templateMap = new Map<string, { startTime: string; endTime: string }>();
  for (const t of templates) templateMap.set(`${t.role}_${t.zone}`, { startTime: t.startTime, endTime: t.endTime });

  /** Resolve template times for a specific day-of-week (checks overrides first) */
  function resolveTemplateTimes(role: string, zone: string, dow: number): { startTime: string; endTime: string } | undefined {
    // Find matching template
    const tpl = templates.find(t => t.role === role && t.zone === zone);
    if (!tpl) return undefined;
    // Check for day override
    if (tpl._id) {
      const dayOv = overrideMap.get(tpl._id)?.get(dow);
      if (dayOv) return dayOv;
    }
    return { startTime: tpl.startTime, endTime: tpl.endTime };
  }

  /** Resolve both template halves for a paired (continuous shift) zone, sorted morning-first */
  function resolvePairedTemplateTimes(role: string, zone: string, dow: number): Array<{ startTime: string; endTime: string }> | undefined {
    const tpls = templates.filter(t => t.role === role && t.zone === zone);
    if (tpls.length !== 2) return undefined;
    return tpls.map(tpl => {
      if (tpl._id) {
        const dayOv = overrideMap.get(tpl._id)?.get(dow);
        if (dayOv) return dayOv;
      }
      return { startTime: tpl.startTime, endTime: tpl.endTime };
    }).sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  }

  // Fetch closures
  const closures = db.select({
    startDate: restaurantClosures.startDate,
    endDate: restaurantClosures.endDate,
  }).from(restaurantClosures)
    .where(eq(restaurantClosures.restaurantId, restaurantId)).all();

  // Fetch holidays — configurable status filter for impact analysis
  const hFilter = options?.holidayFilter ?? ["approved", "pending"];
  const hStatusCond = hFilter.length === 1
    ? eq(holidayRequests.status, hFilter[0])
    : or(...hFilter.map(s => eq(holidayRequests.status, s)));
  const holidays = [
    ...db.select({
      workerId: holidayRequests.workerId,
      startDate: holidayRequests.startDate,
      endDate: holidayRequests.endDate,
    }).from(holidayRequests)
      .where(and(
        ownerRestaurantIds.length > 1
          ? inArray(holidayRequests.restaurantId, ownerRestaurantIds)
          : eq(holidayRequests.restaurantId, restaurantId),
        hStatusCond!,
      )).all(),
    ...(options?.extraAbsences ?? []),
  ];

  // Fetch active operational workers sorted by priority. Managers/admins are
  // off-schedule and should not inflate solver capacity or model size.
  const memberWorkerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["kitchen", "floor"] });
  const localWorkers = memberWorkerIds.length > 0 ? db.select({
    id: users.id,
    name: users.name,
    role: users.role,
    priority: users.priority,
    overtimeWilling: users.overtimeWilling,
    contractHours: users.contractHours,
    contractEndDate: users.contractEndDate,
    contractType: users.contractType,
    subRoles: users.subRoles,
    inactiveFrom: users.inactiveFrom,
    inactiveUntil: users.inactiveUntil,
    maxWeeklyHours: users.maxWeeklyHours,
    adminOtOverride: users.adminOtOverride,
    hourlyRate: users.hourlyRate,
    hcrLevel: users.hcrLevel,
    startDate: users.startDate,
    multiRestaurantWilling: users.multiRestaurantWilling,
  }).from(users)
    .where(and(inArray(users.id, memberWorkerIds), inArray(users.role, ["kitchen", "floor"]), eq(users.active, true)))
    .orderBy(users.priority, users.name)
    .all() : [];
  const localWorkerIds = new Set(localWorkers.map((worker) => worker.id));
  const targetMemberIds = new Set(db
    .select({ userId: restaurantMemberships.userId })
    .from(restaurantMemberships)
    .where(and(
      eq(restaurantMemberships.restaurantId, restaurantId),
      eq(restaurantMemberships.active, true),
    ))
    .all()
    .map((row) => row.userId));
  const sharedWorkers = restaurant?.ownerId
    ? db.select({
      id: users.id,
      name: users.name,
      role: workerShareAuthorizations.role,
      priority: workerRestaurantProfiles.priority,
      overtimeWilling: users.overtimeWilling,
      contractHours: workerRestaurantProfiles.contractHours,
      contractEndDate: workerRestaurantProfiles.contractEndDate,
      contractType: workerRestaurantProfiles.contractType,
      subRoles: workerRestaurantProfiles.subRoles,
      inactiveFrom: users.inactiveFrom,
      inactiveUntil: users.inactiveUntil,
      maxWeeklyHours: workerRestaurantProfiles.maxWeeklyHours,
      adminOtOverride: workerRestaurantProfiles.adminOtOverride,
      hourlyRate: workerRestaurantProfiles.hourlyRate,
      hcrLevel: workerRestaurantProfiles.hcrLevel,
      startDate: users.startDate,
      multiRestaurantWilling: users.multiRestaurantWilling,
      sharedFromRestaurantId: workerShareAuthorizations.sourceRestaurantId,
    }).from(workerShareAuthorizations)
      .innerJoin(users, eq(workerShareAuthorizations.userId, users.id))
      .innerJoin(ownerMemberships, and(
        eq(ownerMemberships.ownerId, workerShareAuthorizations.ownerId),
        eq(ownerMemberships.userId, workerShareAuthorizations.userId),
      ))
      .innerJoin(workerRestaurantProfiles, and(
        eq(workerRestaurantProfiles.restaurantId, workerShareAuthorizations.targetRestaurantId),
        eq(workerRestaurantProfiles.userId, workerShareAuthorizations.userId),
      ))
      .innerJoin(restaurantMemberships, and(
        eq(restaurantMemberships.restaurantId, workerShareAuthorizations.sourceRestaurantId),
        eq(restaurantMemberships.userId, workerShareAuthorizations.userId),
        eq(restaurantMemberships.role, workerShareAuthorizations.role),
        eq(restaurantMemberships.active, true),
      ))
      .where(and(
        eq(workerShareAuthorizations.ownerId, restaurant.ownerId),
        eq(workerShareAuthorizations.targetRestaurantId, restaurantId),
        eq(workerShareAuthorizations.status, "accepted"),
        isNotNull(workerShareAuthorizations.workerConsentedAt),
        isNull(workerShareAuthorizations.revokedAt),
        eq(users.active, true),
        eq(users.multiRestaurantWilling, true),
      ))
      .orderBy(workerRestaurantProfiles.priority, users.name)
      .all()
      .filter((worker) => !targetMemberIds.has(worker.id) && ownerRestaurantIds.includes(worker.sharedFromRestaurantId))
    : [];
  const allWorkers = [...localWorkers, ...sharedWorkers];

  // Filter out workers whose contract has ended before this week
  const weekStart = dates[0];
  const weekEnd = dates[dates.length - 1];
  const workersActive = allWorkers.filter(w => {
    // CDD/saisonnier with end date before week start — contract expired
    if (w.contractEndDate && w.contractEndDate < weekStart) return false;
    return true;
  });

  // Filter out workers who are temporarily deactivated for the entire week
  const workersRaw = workersActive.filter(w => {
    if (!w.inactiveFrom || !w.inactiveUntil) return true;
    // Exclude if their inactive period covers the entire week
    return !(w.inactiveFrom <= weekStart && w.inactiveUntil >= weekEnd);
  });

  // Apply contract hour overrides (what-if simulation)
  const overrides = options?.contractOverrides;
  const workersWithContracts = overrides
    ? workersRaw.map(w => overrides[w.id] != null ? { ...w, contractHours: overrides[w.id] } : w)
    : workersRaw;

  // Apply temporary max-hours overrides (what-if overtime simulation)
  const maxWeeklyOverrides = options?.maxWeeklyOverrides;
  const workersWithMax = maxWeeklyOverrides
    ? workersWithContracts.map(w => maxWeeklyOverrides[w.id] != null ? { ...w, maxWeeklyHours: maxWeeklyOverrides[w.id], adminOtOverride: maxWeeklyOverrides[w.id] } : w)
    : workersWithContracts;

  // Apply role overrides (cross-training simulation)
  const roleOvr = options?.roleOverrides;
  const workers = roleOvr
    ? workersWithMax.map(w => roleOvr[w.id] ? { ...w, role: roleOvr[w.id] } : w)
    : workersWithMax;

  // Workers whose restrictions are ignored in simulation
  const ignoreRestrictions = new Set(options?.restrictionOverrides ?? []);

  // Resolve active staffing profile for this week.
  // Priority: explicit override > staffingSchedule assignment > first profile by sortOrder.
  let activeProfileId: string | undefined = options?.profileIdOverride;

  if (!activeProfileId) {
    const weekYear = isoWeekYear(dates[0]);
    const weekNum = isoWeekNum(dates[0]);

    const weekAssignment = db.select({ profileId: staffingSchedule.profileId })
      .from(staffingSchedule)
      .where(and(
        eq(staffingSchedule.restaurantId, restaurantId),
        eq(staffingSchedule.year, weekYear),
        eq(staffingSchedule.week, weekNum),
      ))
      .limit(1).all();

    activeProfileId = weekAssignment[0]?.profileId;
  }

  // Fall back to first profile by sortOrder if no override and no week-specific assignment
  if (!activeProfileId) {
    const profiles = db.select({ id: staffingProfiles.id })
      .from(staffingProfiles)
      .where(eq(staffingProfiles.restaurantId, restaurantId))
      .orderBy(staffingProfiles.sortOrder)
      .all();
    activeProfileId = profiles[0]?.id;
  }

  // Load day priorities + titulaire pinning from active profile
  let dayPriorityMap: Record<string, number> = {};
  const preferredAssignmentKeys = new Set<string>();
  if (activeProfileId) {
    const profRow = db.select({
      dayPriorities: staffingProfiles.dayPriorities,
      preferredAssignments: staffingProfiles.preferredAssignments,
    })
      .from(staffingProfiles)
      .where(eq(staffingProfiles.id, activeProfileId))
      .limit(1).all();
    if (profRow[0]?.dayPriorities) {
      try { dayPriorityMap = JSON.parse(profRow[0].dayPriorities); } catch { /* ignore */ }
    }
    if (profRow[0]?.preferredAssignments) {
      try {
        const arr = JSON.parse(profRow[0].preferredAssignments);
        if (Array.isArray(arr)) {
          for (const a of arr) {
            if (a && typeof a.workerId === "string" && typeof a.dayOfWeek === "number" && typeof a.zone === "string" && typeof a.role === "string") {
              preferredAssignmentKeys.add(`${a.workerId}_${a.dayOfWeek}_${a.zone}_${a.role}`);
            }
          }
        }
      } catch { /* ignore */ }
    }
  }
  // Load templates from active profile
  if (activeProfileId) {
    const profileTemplatesRaw = db.select({
      id: serviceTemplates.id,
      role: serviceTemplates.role,
      zone: serviceTemplates.zone,
      startTime: serviceTemplates.startTime,
      endTime: serviceTemplates.endTime,
    }).from(serviceTemplates)
      .where(and(
        eq(serviceTemplates.restaurantId, restaurantId),
        eq(serviceTemplates.profileId, activeProfileId),
      )).all();

    if (profileTemplatesRaw.length > 0) {
      const profileOverrides = db.select({
        templateId: serviceTemplateOverrides.templateId,
        dayOfWeek: serviceTemplateOverrides.dayOfWeek,
        startTime: serviceTemplateOverrides.startTime,
        endTime: serviceTemplateOverrides.endTime,
      }).from(serviceTemplateOverrides)
        .where(inArray(serviceTemplateOverrides.templateId, profileTemplatesRaw.map(pt => pt.id)))
        .all();
      for (const o of profileOverrides) {
        if (!overrideMap.has(o.templateId)) overrideMap.set(o.templateId, new Map());
        overrideMap.get(o.templateId)!.set(o.dayOfWeek, { startTime: o.startTime, endTime: o.endTime });
      }
      templates = profileTemplatesRaw.map(({ id, ...rest }) => ({ ...rest, _id: id }));
      templateMap.clear();
      for (const t of templates) templateMap.set(`${t.role}_${t.zone}`, { startTime: t.startTime, endTime: t.endTime });
    }
  }

  // Detect paired zones: same zone+role with 2 non-overlapping templates (continuous shifts)
  // Must run after profile template override to detect profile-specific paired zones
  const pairedZoneKeys = new Set<string>();
  const templatesByZoneRole = new Map<string, typeof templates>();
  for (const t of templates) {
    const key = `${t.zone}_${t.role}`;
    if (!templatesByZoneRole.has(key)) templatesByZoneRole.set(key, []);
    templatesByZoneRole.get(key)!.push(t);
  }
  for (const [key, tpls] of templatesByZoneRole) {
    if (tpls.length === 2 && !timesOverlap(tpls[0].startTime, tpls[0].endTime, tpls[1].startTime, tpls[1].endTime)) {
      pairedZoneKeys.add(key);
    }
  }

  const targets = activeProfileId
    ? db.select({
        dayOfWeek: staffingTargets.dayOfWeek,
        role: staffingTargets.role,
        zone: staffingTargets.zone,
        count: staffingTargets.count,
        roleBreakdown: staffingTargets.roleBreakdown,
      }).from(staffingTargets)
        .where(and(eq(staffingTargets.restaurantId, restaurantId), eq(staffingTargets.profileId, activeProfileId))).all()
    : [];

  const targetMap = new Map<string, number>();
  // roleBreakdownMap: "dow_role_zone" → {"Chef": 1, "Cuisinier": 2, ...}
  const roleBreakdownMap = new Map<string, Record<string, number>>();
  for (const t of targets) {
    const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
    targetMap.set(key, t.count);
    if (t.roleBreakdown) {
      try {
        const bd = typeof t.roleBreakdown === "string" ? JSON.parse(t.roleBreakdown) : t.roleBreakdown;
        if (Object.keys(bd).length > 0) roleBreakdownMap.set(key, bd);
      } catch { /* ignore */ }
    }
  }

  // Override with per-week targets if provided (count=0 means "skip this slot")
  if (targetOverrides?.length) {
    for (const t of targetOverrides) {
      targetMap.set(`${t.dayOfWeek}_${t.role}_${t.zone}`, t.count);
    }
  }
  // Additional overrides via options (expansion-suggestions passes them through runMultiWeekSolve)
  if (options?.targetOverrides?.length) {
    for (const t of options.targetOverrides) {
      const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
      targetMap.set(key, t.count);
      if (t.roleBreakdown && Object.keys(t.roleBreakdown).length > 0) {
        roleBreakdownMap.set(key, t.roleBreakdown);
      }
    }
  }

  // Fetch availability
  const avail = db.select({
    workerId: workerAvailability.workerId,
    dayOfWeek: workerAvailability.dayOfWeek,
    midi: workerAvailability.midi,
    soir: workerAvailability.soir,
    zones: workerAvailability.zones,
  }).from(workerAvailability)
    .where(eq(workerAvailability.restaurantId, restaurantId)).all();

  const availMap = buildAvailabilityMap(avail);

  // Fetch time-slot restrictions. Include effective date range; for the per-week solver,
  // also drop rows that are entirely outside the planning window so temporary restrictions
  // only apply when in effect.
  const planStart = dates[0];
  const planEnd = dates[dates.length - 1];
  const allRestrictionRows = db.select({
    workerId: workerRestrictions.workerId,
    dayOfWeek: workerRestrictions.dayOfWeek,
    startTime: workerRestrictions.startTime,
    endTime: workerRestrictions.endTime,
    effectiveFrom: workerRestrictions.effectiveFrom,
    effectiveUntil: workerRestrictions.effectiveUntil,
  }).from(workerRestrictions)
    .where(eq(workerRestrictions.restaurantId, restaurantId)).all();
  const restrictionRows = allRestrictionRows.filter(r => {
    if (r.effectiveFrom && r.effectiveFrom > planEnd) return false;
    if (r.effectiveUntil && r.effectiveUntil < planStart) return false;
    return true;
  });

  const restrictionMap = buildRestrictionMap(restrictionRows);

  // Inject virtual workers for hire simulation
  // All sub-roles for each department so the ILP can assign them freely
  const ALL_KITCHEN_SUBROLES = '["Chef","Sous-chef","Cuisinier","Commis","Plongeur"]';
  const ALL_SALLE_SUBROLES = '["Ma\u00eetre d\'h\u00f4tel","Chef de rang","Sous-chef de rang","Serveur","Runner","Barman"]';
  if (options?.virtualWorkers) {
    for (const vw of options.virtualWorkers) {
      workers.push({
        id: vw.id,
        name: vw.name,
        role: vw.role,
        priority: 999,
        overtimeWilling: false,
        contractHours: vw.contractHours,
        subRoles: vw.role === "kitchen" ? ALL_KITCHEN_SUBROLES : ALL_SALLE_SUBROLES,
        inactiveFrom: null,
        inactiveUntil: null,
      } as typeof workers[0]);
      // Full availability: every open day, midi + soir, all zones, no restrictions
      if (!availMap.has(vw.id)) availMap.set(vw.id, new Map());
      for (const [dayStr, mode] of Object.entries(openDays)) {
        if (!mode) continue;
        availMap.get(vw.id)!.set(Number(dayStr), { midi: true, soir: true });
      }
    }
  }

  // Worker preferred schedule (soft tiebreaker when enabled)
  // prefMap: workerId -> dayOfWeek -> { midi, soir }
  const prefMap = new Map<string, Map<number, { midi: boolean; soir: boolean }>>();
  if (prefEnabled) {
    const prefs = db.select({
      workerId: workerPreferredSchedule.workerId,
      dayOfWeek: workerPreferredSchedule.dayOfWeek,
      midi: workerPreferredSchedule.midi,
      soir: workerPreferredSchedule.soir,
    }).from(workerPreferredSchedule)
      .where(eq(workerPreferredSchedule.restaurantId, restaurantId)).all();

    for (const p of prefs) {
      if (!prefMap.has(p.workerId)) prefMap.set(p.workerId, new Map());
      prefMap.get(p.workerId)!.set(p.dayOfWeek, { midi: !!p.midi, soir: !!p.soir });
    }
  }

  /** Check if worker prefers this zone on this day-of-week.
   *  Maps zone to midi (< 14h) or soir (≥ 14h) based on template start time. */
  function workerPrefersSlot(workerId: string, dow: number, zone: string): boolean {
    if (!prefEnabled) return false;
    const dayPrefs = prefMap.get(workerId)?.get(dow);
    if (!dayPrefs) return false;
    const slot = zoneToAvailSlot(zone, templates);
    return slot === "midi" ? dayPrefs.midi : dayPrefs.soir;
  }

  // ── Compliance guardrails ──
  // Track daily hours per worker (existing + planned) for max-daily-hours check
  const dailyHoursMap = new Map<string, number>(); // key: workerId_date

  // Seed from existing DB services. In overwrite mode we build the model as if
  // current-week auto services were already removed, but keep manual services so
  // the replacement plan does not overlap or double-count hand-edited shifts.
  const ignoreAutoServicesForWeek = !!options?.ignoreAutoServicesForWeek;
  const ignoredServiceIds = new Set(options?.ignoreServiceIds ?? []);
  const scopedServiceRestaurantCondition = () => ownerRestaurantIds.length > 1
    ? inArray(services.restaurantId, ownerRestaurantIds)
    : eq(services.restaurantId, restaurantId);
  const targetExistingDayServicesDB = db.select({
    id: services.id,
    workerId: services.workerId,
    restaurantId: services.restaurantId,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
    source: services.source,
  }).from(services)
    .where(and(
      eq(services.restaurantId, restaurantId),
      gte(services.date, week.from),
      lte(services.date, week.to),
      ne(services.status, "cancelled"),
    )).all();
  const existingDayServicesDB = db.select({
    id: services.id,
    workerId: services.workerId,
    restaurantId: services.restaurantId,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
    source: services.source,
  }).from(services)
    .where(and(
      scopedServiceRestaurantCondition(),
      gte(services.date, week.from),
      lte(services.date, week.to),
      ne(services.status, "cancelled"),
    )).all();
  const existingDayServices = existingDayServicesDB.filter(s =>
    !ignoredServiceIds.has(s.id) &&
    !(ignoreAutoServicesForWeek && s.restaurantId === restaurantId && s.source === "auto")
  );
  const targetExistingDayServices = targetExistingDayServicesDB.filter(s =>
    !ignoredServiceIds.has(s.id) &&
    !(ignoreAutoServicesForWeek && s.source === "auto")
  );

  for (const s of existingDayServices) {
    const key = `${s.workerId}_${s.date}`;
    dailyHoursMap.set(key, (dailyHoursMap.get(key) || 0) + calcServiceHours(s.startTime, s.endTime));
  }

  // For min-daily-rest check: track last service end time per worker per date
  // (existing services + planned services, keyed by workerId_date)
  const lastEndByDate = new Map<string, number>(); // value: end time in minutes
  for (const s of existingDayServices) {
    const key = `${s.workerId}_${s.date}`;
    let endMin = timeToMinutes(s.endTime);
    if (endMin < timeToMinutes(s.startTime)) endMin += 24 * 60; // overnight
    lastEndByDate.set(key, Math.max(lastEndByDate.get(key) || 0, endMin));
  }

  // For forward rest check: track earliest service start per worker per date
  const firstStartByDate = new Map<string, number>(); // key: workerId_date, value: start minutes
  for (const s of existingDayServices) {
    const key = `${s.workerId}_${s.date}`;
    const startMin = timeToMinutes(s.startTime);
    const current = firstStartByDate.get(key);
    if (current === undefined || startMin < current) firstStartByDate.set(key, startMin);
  }

  // Load adjacent days for rest calculation (day before + day after the week)
  const dayBeforeWeek = new Date(dates[0] + "T12:00:00");
  dayBeforeWeek.setDate(dayBeforeWeek.getDate() - 1);
  const dayBeforeStr = dayBeforeWeek.toISOString().split("T")[0];

  const dayAfterWeek = new Date(dates[6] + "T12:00:00");
  dayAfterWeek.setDate(dayAfterWeek.getDate() + 1);
  const dayAfterStr = dayAfterWeek.toISOString().split("T")[0];

  const adjacentServicesDB = db.select({
    workerId: services.workerId,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
  }).from(services)
    .where(and(
      scopedServiceRestaurantCondition(),
      or(eq(services.date, dayBeforeStr), eq(services.date, dayAfterStr)),
      ne(services.status, "cancelled"),
    )).all();
  // Inject synthetic services from prior simulated weeks
  const adjacentServices = [...adjacentServicesDB];
  if (options?.syntheticServices) {
    for (const s of options.syntheticServices) {
      if (s.date === dayBeforeStr || s.date === dayAfterStr) {
        adjacentServices.push(s);
      }
    }
  }

  for (const s of adjacentServices) {
    const key = `${s.workerId}_${s.date}`;
    let endMin = timeToMinutes(s.endTime);
    if (endMin < timeToMinutes(s.startTime)) endMin += 24 * 60;
    lastEndByDate.set(key, Math.max(lastEndByDate.get(key) || 0, endMin));
    const startMin = timeToMinutes(s.startTime);
    const current = firstStartByDate.get(key);
    if (current === undefined || startMin < current) firstStartByDate.set(key, startMin);
  }

  // For max-consecutive-days: track which dates each worker works
  // (existing + planned, need 6 days before AND after week for bidirectional lookback/forward)
  const workerWorkDates = new Map<string, Set<string>>(); // workerId -> set of dates

  const sixDaysBefore = new Date(dates[0] + "T12:00:00");
  sixDaysBefore.setDate(sixDaysBefore.getDate() - 6);
  const sixDaysBeforeStr = sixDaysBefore.toISOString().split("T")[0];
  const sixDaysAfter = new Date(dates[6] + "T12:00:00");
  sixDaysAfter.setDate(sixDaysAfter.getDate() + 6);
  const sixDaysAfterStr = sixDaysAfter.toISOString().split("T")[0];

  const recentServicesDB = db.select({ id: services.id, workerId: services.workerId, restaurantId: services.restaurantId, date: services.date, source: services.source })
    .from(services)
    .where(and(
      scopedServiceRestaurantCondition(),
      gte(services.date, sixDaysBeforeStr),
      lte(services.date, sixDaysAfterStr),
      ne(services.status, "cancelled"),
    )).all();
  // Inject synthetic services for consecutive-day checks. In overwrite mode,
  // ignore only current-week auto services; prior/future auto services still
  // exist and must keep constraining rest/consecutive-day windows.
  const recentServices = recentServicesDB
    .filter(s => !ignoredServiceIds.has(s.id))
    .filter(s => !(ignoreAutoServicesForWeek && s.restaurantId === restaurantId && s.source === "auto" && s.date >= week.from && s.date <= week.to))
    .map(s => ({ workerId: s.workerId, date: s.date }));
  if (options?.syntheticServices) {
    for (const s of options.syntheticServices) {
      if (s.date >= sixDaysBeforeStr && s.date <= sixDaysAfterStr) {
        recentServices.push({ workerId: s.workerId, date: s.date });
      }
    }
  }

  for (const s of recentServices) {
    if (!workerWorkDates.has(s.workerId)) workerWorkDates.set(s.workerId, new Set());
    workerWorkDates.get(s.workerId)!.add(s.date);
  }

  // For rolling 12-week average hours check (HCR-L3121-22: max 46h/week average)
  const twelveWeeksBefore = new Date(dates[0] + "T12:00:00");
  twelveWeeksBefore.setDate(twelveWeeksBefore.getDate() - 12 * 7);
  const twelveWeeksBeforeStr = twelveWeeksBefore.toISOString().split("T")[0];

  const historicalServicesDB = db.select({
    id: services.id,
    workerId: services.workerId,
    restaurantId: services.restaurantId,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
    source: services.source,
  }).from(services)
    .where(and(
      scopedServiceRestaurantCondition(),
      gte(services.date, twelveWeeksBeforeStr),
      lte(services.date, week.to),
      ne(services.status, "cancelled"),
    )).all();
  // Inject synthetic services for rolling-average hours check
  const historicalServices = historicalServicesDB
    .filter(s => !ignoredServiceIds.has(s.id))
    .filter(s => !(ignoreAutoServicesForWeek && s.restaurantId === restaurantId && s.source === "auto" && s.date >= week.from && s.date <= week.to))
    .map(({ id: _id, restaurantId: _restaurantId, source: _source, ...s }) => s);
  if (options?.syntheticServices) {
    for (const s of options.syntheticServices) {
      if (s.date >= twelveWeeksBeforeStr && s.date <= week.to) {
        historicalServices.push(s);
      }
    }
  }

  // workerHistoricalHours: workerId → total hours in the 12-week window (pre-current-week)
  // workerHistoricalWeeks: workerId → distinct ISO weeks worked in that window
  const workerHistoricalHours = new Map<string, number>();
  const workerHistoricalWeeks = new Map<string, Set<number>>();
  for (const s of historicalServices) {
    if (s.date < dates[0]) {
      const hrs = calcServiceHours(s.startTime, s.endTime);
      workerHistoricalHours.set(s.workerId, (workerHistoricalHours.get(s.workerId) || 0) + hrs);
      if (!workerHistoricalWeeks.has(s.workerId)) workerHistoricalWeeks.set(s.workerId, new Set());
      workerHistoricalWeeks.get(s.workerId)!.add(isoWeekNum(s.date));
    }
  }

  const MAX_DAILY_HOURS_COMPOUND = 12; // HCR derogation for coupure/continuous shifts
  const MIN_REST_HOURS = 10; // HCR derogation (standard is 11h)
  const MAX_CONSECUTIVE_DAYS = 6;
  const MAX_ROLLING_WORK_DAYS = 5; // in any 7-day window (HCR-L3132-2: 1.5 rest days)
  const MAX_12WEEK_AVG_HOURS = 46; // HCR-L3121-22

  // Track weekly hours per worker (for ILP result tracking + workerHourSummary)
  // Seed from existingDayServices (already loaded above for compliance checks)
  const weeklyHours = new Map<string, number>();
  const weeklyServices = new Map<string, number>();

  for (const s of existingDayServices) {
    const hrs = calcServiceHours(s.startTime, s.endTime);
    weeklyHours.set(s.workerId, (weeklyHours.get(s.workerId) || 0) + hrs);
    weeklyServices.set(s.workerId, (weeklyServices.get(s.workerId) || 0) + 1);
  }

  const plannedServices: Array<{
    date: string;
    workerId: string;
    workerName: string;
    role: Role;
    zone: string;
    startTime: string;
    endTime: string;
    filledAs?: string | null;
  }> = [];

  const warnings: string[] = [];

  if (otMode === "strict") {
    warnings.push("Overtime policy: STRICT — capping all workers at 39h/week");
  } else if (otMode === "controlled") {
    warnings.push(`Overtime policy: CONTROLLED — cap at ${otCap}h/week`);
  }

  // Build existing-service maps for idempotency:
  // 1. Per-worker overlap lookup: workerId_date → [(startTime, endTime)]
  const existingServicesByWorkerDate = new Map<string, Array<{ startTime: string; endTime: string }>>();
  // 2. Per-slot services: date_role_startTime_endTime → count
  //    Exact-match keying: a service counts toward a slot only when its times match
  //    the template exactly. This prevents cross-zone miscounting when two zones of
  //    the same role have overlapping time ranges (e.g., Matin 06:00-14:00 vs Midi 10:00-16:00).
  const existingSlotCount = new Map<string, number>();
  for (const s of targetExistingDayServices) {
    const wKey = `${s.workerId}_${s.date}`;
    if (!existingServicesByWorkerDate.has(wKey)) existingServicesByWorkerDate.set(wKey, []);
    existingServicesByWorkerDate.get(wKey)!.push({ startTime: s.startTime, endTime: s.endTime });
    const slotKey = `${s.date}_${s.role}_${s.startTime}_${s.endTime}`;
    existingSlotCount.set(slotKey, (existingSlotCount.get(slotKey) || 0) + 1);
  }

  /** Count existing services whose times exactly match this template slot */
  function countExactFill(date: string, role: string, startTime: string, endTime: string): number {
    return existingSlotCount.get(`${date}_${role}_${startTime}_${endTime}`) || 0;
  }

  /** Count workers who already have existing services matching both halves of a compound slot */
  function countCompoundFill(date: string, role: string, halfA: { startTime: string; endTime: string }, halfB: { startTime: string; endTime: string }): number {
    const workersWithA = new Set<string>();
    const workersWithB = new Set<string>();
    for (const s of targetExistingDayServices) {
      if (s.date !== date || s.role !== role) continue;
      if (s.startTime === halfA.startTime && s.endTime === halfA.endTime) workersWithA.add(s.workerId);
      if (s.startTime === halfB.startTime && s.endTime === halfB.endTime) workersWithB.add(s.workerId);
    }
    let count = 0;
    for (const w of workersWithA) {
      if (workersWithB.has(w)) count++;
    }
    return count;
  }

  // ── Precompute: slot scarcity, worker flexibility, worker consistency ──

  const uniqueZones = [...new Set(templates.map(t => t.zone))];
  // Deduplicate zones that appear in multiple templates (paired zones)
  // Each zone appears once in uniqueZones regardless of template count

  type Slot = { date: string; dow: number; zone: string; role: Role; scarcity: number; compound: boolean };

  // Build flat list of all slots with static scarcity scores
  const slotsToFill: Slot[] = [];
  for (const dateStr of dates) {
    const dow = isoDayOfWeek(dateStr);
    const dayMode = openDays[String(dow)];
    if (!dayMode) continue;
    if (isClosureDate(dateStr, closures)) continue;

    const activeZones = dayMode === "both" ? uniqueZones
      : uniqueZones.filter(z => zoneToAvailSlot(z, templates) === dayMode);

    for (const zone of activeZones) {
      for (const role of ["kitchen", "floor"] as Role[]) {
        const isPaired = pairedZoneKeys.has(`${zone}_${role}`);
        // Continuous shifts span full day — skip if restaurant only open midi or soir
        if (isPaired && dayMode !== "both") continue;

        // For paired zones, check availability for both midi AND soir
        const staticAvail = workers
          .filter(w => w.role === role)
          .filter(w => {
            return checkWorkerAvailable(w.id, dow, role, zone, isPaired);
          })
          .filter(w => !isOnHoliday(w.id, dateStr, holidays))
          .filter(w => !isTempInactive(w, dateStr))
          .length;

        const targetKey = `${dow}_${role}_${zone}`;
        const target = targetMap.get(targetKey);
        // No target defined = admin doesn't want staff here — skip
        if (target === undefined || target <= 0) continue;
        const scarcity = staticAvail > 0 ? target / staticAvail : (target > 0 ? Infinity : 0);
        slotsToFill.push({ date: dateStr, dow, zone, role, scarcity, compound: isPaired });
      }
    }
  }

  // Initial sort: high-priority days first, then tightest slots (highest scarcity)
  slotsToFill.sort((a, b) => {
    const aPrio = dayPriorityMap[String(a.dow)] ?? 2;
    const bPrio = dayPriorityMap[String(b.dow)] ?? 2;
    if (aPrio !== bPrio) return aPrio - bPrio; // lower number = higher importance = scheduled first
    return b.scarcity - a.scarcity;
  });

  /** Check if worker is available for both midi and soir (for compound/continuous slots) */
  function isWorkerAvailableCompound(workerId: string, dow: number): boolean {
    const dayZones = availMap.get(workerId)?.get(dow);
    if (!dayZones) return true;
    let hasMidi = false, hasSoir = false;
    for (const [zone, available] of Object.entries(dayZones)) {
      if (!available) continue;
      if (zone === "midi") hasMidi = true;
      else if (zone === "soir") hasSoir = true;
      else {
        const slot = zoneToAvailSlot(zone, templates);
        if (slot === "midi") hasMidi = true;
        else hasSoir = true;
      }
    }
    return hasMidi && hasSoir;
  }

  /** Unified availability check: zone-based + time-slot restrictions */
  function checkWorkerAvailable(workerId: string, dow: number, role: string, zone: string, compound: boolean): boolean {
    // Legacy zone-based check
    if (compound) {
      if (!isWorkerAvailableCompound(workerId, dow)) return false;
    } else {
      if (!isWorkerAvailable(availMap, workerId, dow, zone, templates)) return false;
    }
    // Time-slot restriction check (skip if worker's restrictions are overridden)
    if (!ignoreRestrictions.has(workerId)) {
      if (compound) {
        const halves = resolvePairedTemplateTimes(role, zone, dow);
        if (halves) {
          for (const half of halves) {
            if (!isAvailableByRestrictions(restrictionMap, workerId, dow, half.startTime, half.endTime)) return false;
          }
        }
      } else {
        const tpl = resolveTemplateTimes(role, zone, dow);
        if (tpl) {
          if (!isAvailableByRestrictions(restrictionMap, workerId, dow, tpl.startTime, tpl.endTime)) return false;
        }
      }
    }
    return true;
  }

  /** Recompute dynamic scarcity for a slot, accounting for workers already assigned/consumed */
  function dynamicScarcity(slot: Slot): number {
    const avail = workers
      .filter(w => w.role === slot.role)
      .filter(w => {
        return checkWorkerAvailable(w.id, slot.dow, slot.role, slot.zone, slot.compound);
      })
      .filter(w => !isOnHoliday(w.id, slot.date, holidays))
      .filter(w => !isTempInactive(w, slot.date))
      // Exclude workers already assigned to overlapping services on this date
      .filter(w => {
        if (slot.compound) {
          const halves = resolvePairedTemplateTimes(slot.role, slot.zone, slot.dow);
          if (!halves) return true;
          return !halves.some(half =>
            plannedServices.some(p =>
              p.workerId === w.id && p.date === slot.date &&
              timesOverlap(p.startTime, p.endTime, half.startTime, half.endTime)
            )
          );
        }
        const tpl = resolveTemplateTimes(slot.role, slot.zone, slot.dow);
        if (!tpl) return true;
        return !plannedServices.some(p =>
          p.workerId === w.id && p.date === slot.date &&
          timesOverlap(p.startTime, p.endTime, tpl.startTime, tpl.endTime)
        );
      })
      .length;
    const targetKey = `${slot.dow}_${slot.role}_${slot.zone}`;
    const target = targetMap.get(targetKey) ?? 0;
    return avail > 0 ? target / avail : (target > 0 ? Infinity : 0);
  }

  // Worker flexibility: total slots each worker can fill this week (lower = more constrained)
  const workerFlexibility = new Map<string, number>();
  for (const w of workers) {
    let count = 0;
    for (const slot of slotsToFill) {
      if (w.role !== slot.role) continue;
      if (!checkWorkerAvailable(w.id, slot.dow, slot.role, slot.zone, slot.compound)) continue;
      if (!isOnHoliday(w.id, slot.date, holidays) && !isTempInactive(w, slot.date)) count++;
    }
    workerFlexibility.set(w.id, count);
  }

  // Worker consistency: how often each worker worked each (dow, role, midi/soir) in last 4 weeks
  const fourWeeksBeforeStr = (() => {
    const d = new Date(dates[0] + "T12:00:00");
    d.setDate(d.getDate() - 4 * 7);
    return d.toISOString().split("T")[0];
  })();
  const workerConsistency = new Map<string, Map<string, number>>();
  for (const s of historicalServices) {
    if (s.date >= fourWeeksBeforeStr && s.date < dates[0]) {
      const sDow = isoDayOfWeek(s.date);
      const sSlot = s.startTime < "16:00" ? "midi" : "soir";
      const key = `${sDow}_${s.role}_${sSlot}`;
      if (!workerConsistency.has(s.workerId)) workerConsistency.set(s.workerId, new Map());
      const wMap = workerConsistency.get(s.workerId)!;
      wMap.set(key, (wMap.get(key) || 0) + 1);
    }
  }

  // Resolve HCR grid + per-worker leave urgency so the solver can weight
  // cost-awareness and leave-conservation terms when the corresponding weights are on.
  const restaurantHcrGrid: Partial<HcrGrid> = (() => {
    try { return restaurant?.hcrGrid ? JSON.parse(restaurant.hcrGrid) as Partial<HcrGrid> : {}; }
    catch { return {}; }
  })();
  const leaveBalances = computeLeaveBalances(restaurantId);
  const urgencyByWorker = new Map<string, number>();
  for (const u of computeLeaveUrgency(leaveBalances)) urgencyByWorker.set(u.workerId, u.urgency);

  // ── ILP Solver ──
  // Build ILP workers
  const ilpWorkers: ILPWorker[] = workers.filter(w => (w.contractHours ?? 35) > 0 || w.contractType === "extra").map(w => {
        const subRoles: string[] = (() => {
          try {
            const parsed = typeof w.subRoles === "string" ? JSON.parse(w.subRoles) : w.subRoles;
            const base = Array.isArray(parsed) ? parsed : [];
            const extra = options?.subRoleOverrides?.[w.id];
            if (extra) return [...new Set([...base, ...extra])];
            return base;
          } catch { return []; }
        })();
        // Effective weekly OT cap = min(worker preference, admin override ?? global cap).
        // Worker pref is the worker's choice ("I'll do up to X h"); admin override replaces the global rule for this employee.
        // null means no per-worker cap → solver falls back to config.otCap.
        const workerPref = w.maxWeeklyHours;
        const adminOverride = w.adminOtOverride;
        const baseCap = adminOverride ?? null;
        let effectiveOtCap: number | null = null;
        if (workerPref != null && baseCap != null) effectiveOtCap = Math.min(workerPref, baseCap);
        else if (workerPref != null) effectiveOtCap = workerPref;
        else if (baseCap != null) effectiveOtCap = baseCap;
        const sharedFromRestaurantId = (w as { sharedFromRestaurantId?: string | null }).sharedFromRestaurantId ?? null;
        const multiRestaurantWilling = !!w.multiRestaurantWilling;
        return {
          id: w.id,
          name: w.name,
          role: w.role as Role,
          priority: w.priority,
          overtimeWilling: !!w.overtimeWilling,
          contractType: w.contractType ?? null,
          contractHours: w.contractHours ?? 35,
          otCap: effectiveOtCap,
          subRoles,
          existingWeeklyHours: weeklyHours.get(w.id) || 0,
          existingWorkDates: workerWorkDates.get(w.id) || new Set<string>(),
          existingDailyHours: new Map(
            [...dailyHoursMap.entries()]
              .filter(([k]) => k.startsWith(w.id + "_"))
              .map(([k, v]) => [k.split("_").slice(1).join("_"), v])
          ),
          existingLastEnd: new Map(
            [...lastEndByDate.entries()]
              .filter(([k]) => k.startsWith(w.id + "_"))
              .map(([k, v]) => [k.split("_").slice(1).join("_"), v])
          ),
          existingFirstStart: new Map(
            [...firstStartByDate.entries()]
              .filter(([k]) => k.startsWith(w.id + "_"))
              .map(([k, v]) => [k.split("_").slice(1).join("_"), v])
          ),
          existingServicesByDate: (() => {
            const m = new Map<string, Array<{ startTime: string; endTime: string }>>();
            const key = (d: string) => d;
            for (const s of existingDayServices) {
              if (s.workerId !== w.id) continue;
              if (!m.has(s.date)) m.set(s.date, []);
              m.get(s.date)!.push({ startTime: s.startTime, endTime: s.endTime });
            }
            return m;
          })(),
          historicalHours: workerHistoricalHours.get(w.id) || 0,
          historicalWeeks: workerHistoricalWeeks.get(w.id)?.size ?? 0,
          hireDate: w.startDate ?? null,
          bootstrapC9: isBootstrapWorker(w.startDate, week.from),
          consistency: workerConsistency.get(w.id) || new Map(),
          flexibility: workerFlexibility.get(w.id) || 0,
          hourlyRateCents: resolveHcrRate(w.hcrLevel as HcrLevel | null, w.hourlyRate, restaurantHcrGrid) ?? undefined,
          leaveUrgency: urgencyByWorker.get(w.id) ?? 0,
          multiRestaurantWilling,
          sharedFromRestaurantId,
          assignmentPoolPenalty: assignmentPoolPenalty({ multiRestaurantWilling, sharedFromRestaurantId }),
        };
      });

      // Build ILP slots — expand each (date, zone, role) into individual slots
      const ilpSlots: ILPSlot[] = [];
      let slotId = 0;
      for (const slot of slotsToFill) {
        const { date: dateStr, dow, zone, role, compound } = slot;
        const targetKey = `${dow}_${role}_${zone}`;
        const target = targetMap.get(targetKey) ?? 0;
        if (target <= 0) continue;
        const breakdown = roleBreakdownMap.get(targetKey);

        if (compound) {
          const halves = resolvePairedTemplateTimes(role, zone, dow);
          if (!halves || halves.length !== 2) continue;
          const [morning, evening] = halves;
          const morningHrs = calcServiceHours(morning.startTime, morning.endTime);
          const eveningHrs = calcServiceHours(evening.startTime, evening.endTime);
          const existingFill = countCompoundFill(dateStr, role, morning, evening);
          const morningId = slotId++;
          const eveningId = slotId++;
          ilpSlots.push({
            id: morningId, date: dateStr, dow, zone, role, compound: true,
            startTime: morning.startTime, endTime: morning.endTime,
            hours: morningHrs, target, existingFill, compoundPairId: eveningId,
            roleBreakdown: breakdown,
          });
          ilpSlots.push({
            id: eveningId, date: dateStr, dow, zone, role, compound: true,
            startTime: evening.startTime, endTime: evening.endTime,
            hours: eveningHrs, target, existingFill, compoundPairId: morningId,
            roleBreakdown: breakdown,
          });
        } else {
          const tpl = resolveTemplateTimes(role, zone, dow);
          if (!tpl) continue;
          const hrs = calcServiceHours(tpl.startTime, tpl.endTime);
          const existingFill = countExactFill(dateStr, role, tpl.startTime, tpl.endTime);
          ilpSlots.push({
            id: slotId++, date: dateStr, dow, zone, role, compound: false,
            startTime: tpl.startTime, endTime: tpl.endTime,
            hours: hrs, target, existingFill,
            roleBreakdown: breakdown,
          });
        }
      }

      // Build ILP config
      const ilpConfig: ILPConfig = {
        maxDailyHoursCompound: MAX_DAILY_HOURS_COMPOUND,
        minRestHours: MIN_REST_HOURS,
        maxConsecutiveDays: MAX_CONSECUTIVE_DAYS,
        maxRollingWorkDays: MAX_ROLLING_WORK_DAYS,
        max12WeekAvgHours: MAX_12WEEK_AVG_HOURS,
        otCap,
        disabledRules,
        otDistribution,
        dayPriorityMap,
        prefEnabled,
        templates: templates.map(t => ({ role: t.role, zone: t.zone, startTime: t.startTime, endTime: t.endTime })),
        preferredAssignmentKeys,
      };

      const forbiddenAssignments = options?.forbiddenAssignments ?? [];
      function isForbiddenAssignment(workerId: string, slot: ILPSlot): boolean {
        return forbiddenAssignments.some(f =>
          f.workerId === workerId &&
          f.date === slot.date &&
          f.startTime === slot.startTime &&
          f.endTime === slot.endTime &&
          (!f.role || f.role === slot.role) &&
          (!f.zone || f.zone === slot.zone)
        );
      }

      // Build availability checker
      const availChecker: AvailabilityChecker = {
        isAvailable(workerId: string, slot: ILPSlot): boolean {
          if (isForbiddenAssignment(workerId, slot)) return false;
          const w = workers.find(w => w.id === workerId);
          if (!w) return false;
          // Contract expired before this slot's date (multi-week safety)
          if (w.contractEndDate && w.contractEndDate < slot.date) return false;
          if (isOnHoliday(workerId, slot.date, holidays)) return false;
          if (isTempInactive(w, slot.date)) return false;
          return checkWorkerAvailable(workerId, slot.dow, slot.role, slot.zone, slot.compound);
        },
        prefersSlot(workerId: string, dow: number, zone: string): boolean {
          return workerPrefersSlot(workerId, dow, zone);
        },
      };

      // _buildOnly mode: return model inputs without solving
      if (options?._buildOnly) {
        return {
          week,
          services: [],
          warnings,
          activeProfileId,
          workerHourSummary: [],
          slotFillSummary: [],
          _modelInputs: { ilpWorkers, ilpSlots, ilpConfig, availChecker },
        };
      }

      // Backend: CP-SAT via solveWithTiers → solveWithFallback (ILP only on
      // CPSATUnreachableError). Tiered relaxation sits on top: infeasible Tier 0
      // may be rescued by Tier 1/2/3 depending on `options.maxTier` and the
      // `SOLVER_MAX_TIER` env ceiling.
      const maxTier = options?.maxTier ?? 1;
      const dowTemplates = templateMatchEnabled()
        ? deriveDowTemplates(restaurantId, week.from)
        : undefined;
      const ilpResult = await solveWithTiers(ilpWorkers, ilpSlots, ilpConfig, availChecker, undefined, undefined, styleWeights, maxTier, undefined, dowTemplates);

      if (ilpResult.status === "optimal" || ilpResult.status === "feasible") {
        // Convert ILP assignments to plannedServices
        const slotMap = new Map(ilpSlots.map(s => [s.id, s]));
        for (const a of ilpResult.assignments) {
          const slot = slotMap.get(a.slotId)!;
          plannedServices.push({
            date: slot.date,
            workerId: a.workerId,
            workerName: a.workerName,
            role: slot.role,
            zone: slot.zone,
            startTime: slot.startTime,
            endTime: slot.endTime,
            filledAs: a.crossFilled ? a.filledAs ?? null : null,
          });
          // Update tracking maps for workerHourSummary
          const hrs = slot.hours;
          weeklyHours.set(a.workerId, (weeklyHours.get(a.workerId) || 0) + hrs);
          weeklyServices.set(a.workerId, (weeklyServices.get(a.workerId) || 0) + 1);
        }
        warnings.push(
          `ILP solver: ${ilpResult.status} in ${Math.round(ilpResult.solveTimeMs)}ms ` +
          `(${ilpResult.stats.variables} vars, ${ilpResult.stats.constraints} constraints, ` +
          `${ilpResult.assignments.length} assignments)`
        );
        if (ilpResult.solveTier && ilpResult.solveTier > 0) {
          const tierWarning = formatSolverTierWarning(ilpResult.solveTier, ilpResult.relaxations ?? []);
          if (tierWarning) warnings.push(tierWarning);
        }
        if (ilpResult.complianceWarnings?.length) {
          const workerNameById = new Map(ilpWorkers.map(w => [w.id, w.name]));
          const formatComplianceWarning = (cw: NonNullable<typeof ilpResult.complianceWarnings>[number]) => {
            const workerName = workerNameById.get(cw.workerId) ?? cw.workerId;
            const amount = Math.round(cw.excessHours * 100) / 100;
            if (cw.rule === "HCR-L3121-22-weekly") {
              return `Alerte conformité — ${workerName} dépasse le plafond hebdomadaire de ${amount}h.`;
            }
            if (cw.rule === "HCR-L3121-20") {
              return `Alerte conformité critique — ${workerName} dépasse le maximum légal de 48h de ${amount}h; ce planning relève d'un mode exceptionnel.`;
            }
            if (cw.rule === "HCR-L3132-1") {
              return `Alerte conformité — ${workerName} dépasse la limite de jours consécutifs (${amount} jour${amount > 1 ? "s" : ""} au-delà).`;
            }
            if (cw.rule === "HCR-L3132-2") {
              return `Alerte conformité — ${workerName} ne respecte pas le repos hebdomadaire HCR (${amount} jour${amount > 1 ? "s" : ""} travaillé${amount > 1 ? "s" : ""} en trop sur 7 jours).`;
            }
            return `Alerte conformité — ${workerName}: règle ${cw.rule} non respectée (${amount}).`;
          };
          warnings.push(...ilpResult.complianceWarnings.map(formatComplianceWarning));
        }
  } else {
    warnings.push(`ILP solver: ${ilpResult.status} (${Math.round(ilpResult.solveTimeMs)}ms) — no feasible solution found`);
  }

  const unfilledDiagnostics = buildUnfilledSlotDiagnostics(
    ilpWorkers,
    ilpSlots,
    ilpResult.assignments,
    availChecker,
    ilpConfig,
  );
  if (unfilledDiagnostics.length > 0) {
    warnings.push(...unfilledDiagnostics.map(d => d.message));
  }

  // Build per-worker contract hour tracking
  const workerHourSummary = workers.map(w => {
    const contract = w.contractHours ?? 35;
    const planned = weeklyHours.get(w.id) || 0;
    return {
      workerId: w.id,
      workerName: w.name,
      role: w.role as Role,
      contractHours: contract,
      plannedHours: Math.round(planned * 100) / 100,
      deficit: Math.round((contract - planned) * 100) / 100,
      overtimeHours: Math.max(0, Math.round((planned - contract) * 100) / 100),
    };
  }).filter(w => w.plannedHours > 0 || w.deficit > 0);

  // Build slot fill summary for the analysis endpoint (deduplicated by dow/role/zone)
  const slotFillSeen = new Set<string>();
  const slotFillSummary: Array<{ dow: number; role: string; zone: string; target: number; existingFill: number }> = [];
  for (const s of ilpSlots) {
    const key = `${s.dow}_${s.role}_${s.zone}`;
    if (slotFillSeen.has(key)) continue;
    slotFillSeen.add(key);
    slotFillSummary.push({ dow: s.dow, role: s.role, zone: s.zone, target: s.target, existingFill: s.existingFill });
  }

  return {
    week,
    services: plannedServices,
    warnings,
    activeProfileId,
    workerHourSummary,
    slotFillSummary,
    solverStatus: ilpResult.status,
    solverUsed: ilpResult.solverUsed,
    objectiveValue: ilpResult.objectiveValue,
    solveTimeMs: ilpResult.solveTimeMs,
    solveTier: ilpResult.solveTier,
    unfilledSlots: ilpResult.unfilledSlots,
    complianceWarnings: ilpResult.complianceWarnings,
    relaxations: ilpResult.relaxations,
    degraded: ilpResult.degraded,
  };
}
