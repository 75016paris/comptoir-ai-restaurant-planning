import { Hono } from "hono";
import { type AppEnv, type AuthUser } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { services, users, restaurants, staffingSchedule, staffingProfiles, timeClocks, replacementRequests, openShifts, publishedWeeks, holidayRequests, workerShareAuthorizations } from "../db/schema.js";
import { isoWeekNum, isoWeekYear, getMonday, weekDates, serviceMinutes, isPastWeek } from "../utils/scheduling.js";
import { computeLaborCostSummary } from "../utils/labor-cost.js";
import { isWeekLocked, WEEK_LOCKED_ERROR } from "../utils/week-lock.js";
import { eq, and, gte, lte, ne, sql, inArray, or } from "drizzle-orm";
import { requireAuth, requireActiveSubscription, requirePermission } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { logAudit } from "../db/audit.js";
import { notifyWorkersWeekPublished } from "../services/notifications.js";
import { can, resolveHcrRate, zonedDateTimeToUtc, todayInTimeZone, type HcrLevel, type HcrGrid } from "@comptoir/shared";
import { listRestaurantMemberUserIds, listSchedulingRosterWorkers, userCanBeScheduledInRestaurant } from "../services/restaurant-context.js";

export const scheduleRoutes = new Hono<AppEnv>();

export function canViewHoursForWorker(user: Pick<AuthUser, "id" | "role" | "permissions">, workerId: string): boolean {
  return workerId === user.id || can(user, "HOURS_VIEW");
}

export function canViewMonthlyRecap(user: Pick<AuthUser, "role" | "permissions">): boolean {
  return user.role === "kitchen" || user.role === "floor" || can(user, "HOURS_VIEW");
}

export function canViewDraftSchedule(user: Pick<AuthUser, "role" | "permissions">): boolean {
  return can(user, "PLANNING_EDIT");
}

export function filterRowsToPublishedWeeks<T extends { date: string }>(rows: T[], publishedWeekDates: Set<string>): T[] {
  return rows.filter((row) => publishedWeekDates.has(getMonday(row.date)));
}

type ScheduleVisibleService = { workerId: string; role: string };
type LiveSchedulingRosterById = Map<string, ReturnType<typeof listSchedulingRosterWorkers>[number]>;

function liveSchedulingRosterById(restaurantId: string): LiveSchedulingRosterById {
  return new Map(listSchedulingRosterWorkers(restaurantId, ["manager", "kitchen", "floor"]).map((worker) => [worker.id, worker]));
}

function isVisibleSchedulingService(rosterById: LiveSchedulingRosterById, service: ScheduleVisibleService): boolean {
  const worker = rosterById.get(service.workerId);
  if (!worker) return false;
  if (!worker.sharedFromRestaurantId) return true;
  return worker.role === service.role;
}

function loadPublishedWeekSet(restaurantId: string, weekDates: string[]): Set<string> {
  if (weekDates.length === 0) return new Set();
  const publishedRows = db.select({ weekDate: publishedWeeks.weekDate })
    .from(publishedWeeks)
    .where(and(
      eq(publishedWeeks.restaurantId, restaurantId),
      inArray(publishedWeeks.weekDate, weekDates),
    ))
    .all();
  return new Set(publishedRows.map((r) => r.weekDate));
}

export function workerBelongsToRestaurant(worker: { restaurantId: string } | undefined | null, restaurantId: string): boolean {
  return worker?.restaurantId === restaurantId;
}

scheduleRoutes.use("*", requireAuth);
scheduleRoutes.use("*", requireActiveSubscription);

// GET /schedule/week?date=2026-03-20
scheduleRoutes.get("/week", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const dateParam = c.req.query("date") || new Date().toISOString().split("T")[0];

  // Use noon to avoid timezone edge cases
  const date = new Date(dateParam + "T12:00:00");
  const day = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const from = monday.toISOString().split("T")[0];
  const to = sunday.toISOString().split("T")[0];

  const serviceSelect = {
    id: services.id,
    workerId: services.workerId,
    workerName: users.name,
    workerRole: users.role,
    workerSubRoles: users.subRoles,
    workerHourlyRate: users.hourlyRate,
    workerHcrLevel: users.hcrLevel,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
    status: services.status,
    notes: services.notes,
    source: services.source,
    filledAs: services.filledAs,
  };

  const visibleRosterById = liveSchedulingRosterById(restaurant.restaurantId);

  const result = db
    .select(serviceSelect)
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(
      and(
        eq(services.restaurantId, restaurant.restaurantId),
        gte(services.date, from),
        lte(services.date, to),
        ne(services.status, "cancelled")
      )
    )
    .orderBy(services.date, services.startTime)
    .all()
    .filter((service) => isVisibleSchedulingService(visibleRosterById, service));

  const cancelledResult = db
    .select(serviceSelect)
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(
      and(
        eq(services.restaurantId, restaurant.restaurantId),
        gte(services.date, from),
        lte(services.date, to),
        eq(services.status, "cancelled")
      )
    )
    .orderBy(services.date, services.startTime)
    .all()
    .filter((service) => isVisibleSchedulingService(visibleRosterById, service));

  // Labor cost (id:1384) — sum of hours × effective hourly rate per service,
  // with HCR weekly overtime premiums applied per worker (39h base, then 110/120/150%).
  // Rates are stored in cents (project convention, matches schema + Zod) and converted
  // to euros at the response boundary so the pill displays readable amounts.
  const [resto] = db.select({ hcrGrid: restaurants.hcrGrid })
    .from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();
  let restaurantHcrGrid: Partial<HcrGrid> = {};
  try { restaurantHcrGrid = JSON.parse(resto?.hcrGrid || "{}") as Partial<HcrGrid>; } catch { /* keep empty */ }

  const laborCost = computeLaborCostSummary(result.map(s => ({
    workerId: s.workerId,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    rateCents: resolveHcrRate(s.workerHcrLevel as HcrLevel | null, s.workerHourlyRate, restaurantHcrGrid),
  })));

  // Resolve active staffing profile for this week
  const weekYear = isoWeekYear(from);
  const weekNum = isoWeekNum(from);
  const weekAssignment = db.select({ profileId: staffingSchedule.profileId })
    .from(staffingSchedule)
    .where(and(
      eq(staffingSchedule.restaurantId, restaurant.restaurantId),
      eq(staffingSchedule.year, weekYear),
      eq(staffingSchedule.week, weekNum),
    ))
    .limit(1).all();

  let profileId = weekAssignment[0]?.profileId;
  // Fall back to first profile by sortOrder (same logic as autostaffing)
  if (!profileId) {
    const [first] = db.select({ id: staffingProfiles.id })
      .from(staffingProfiles)
      .where(eq(staffingProfiles.restaurantId, restaurant.restaurantId))
      .orderBy(staffingProfiles.sortOrder)
      .limit(1).all();
    profileId = first?.id;
  }
  let profileName: string | null = null;
  if (profileId) {
    const [p] = db.select({ name: staffingProfiles.name })
      .from(staffingProfiles)
      .where(and(eq(staffingProfiles.id, profileId), eq(staffingProfiles.restaurantId, restaurant.restaurantId)))
      .limit(1).all();
    profileName = p?.name || null;
  }

  const hasAuto = result.some(s => s.source === "auto");
  const hasManual = result.some(s => s.source === "manual");

  // Detect manual modifications to an auto-staffed week:
  // manual services added alongside auto ones, auto services edited, or auto services cancelled
  let autoModified = false;
  if (hasAuto) {
    if (hasManual) {
      autoModified = true;
    } else {
      // Check for edited auto services (updatedAt differs from createdAt)
      const edited = db.select({ id: services.id })
        .from(services)
        .where(and(
          eq(services.restaurantId, restaurant.restaurantId),
          gte(services.date, from),
          lte(services.date, to),
          ne(services.status, "cancelled"),
          eq(services.source, "auto"),
          sql`${services.updatedAt} != ${services.createdAt}`,
        ))
        .limit(1).all();
      if (edited.length > 0) {
        autoModified = true;
      } else {
        // Check for cancelled (deleted) auto services
        const cancelled = db.select({ id: services.id })
          .from(services)
          .where(and(
            eq(services.restaurantId, restaurant.restaurantId),
            gte(services.date, from),
            lte(services.date, to),
            eq(services.status, "cancelled"),
            eq(services.source, "auto"),
          ))
          .limit(1).all();
        autoModified = cancelled.length > 0;
      }
    }
  }

  const weekPast = isPastWeek(from);
  const weekLocked = isWeekLocked(restaurant.restaurantId, from);

  const serializeService = (s: (typeof result)[number]) => {
    const { workerHourlyRate: _r, workerHcrLevel: _l, ...rest } = s;
    return {
      ...rest,
      workerSubRoles: (() => { try { return JSON.parse(s.workerSubRoles || "[]"); } catch { return []; } })(),
    };
  };

  return c.json({
    data: {
      week: { from, to },
      weekPast,
      weekLocked,
      services: result.map(serializeService),
      cancelledServices: cancelledResult.map(serializeService),
      staffingInfo: {
        profileId: profileId ?? null,
        profileName,
        hasAuto,
        hasManual,
        autoModified,
      },
      laborCost,
    },
  });
});

// GET /schedule/hours?workerId=...&from=...&to=...
scheduleRoutes.get("/hours", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const workerId = c.req.query("workerId") || user.id;
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!from || !to) {
    return c.json({ error: "from and to query params required" }, 400);
  }

  if (!canViewHoursForWorker(user, workerId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [worker] = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, workerId))
    .limit(1)
    .all();
  if (!worker || !userCanBeScheduledInRestaurant(workerId, restaurant.restaurantId)) {
    return c.json({ error: "Worker not found" }, 404);
  }

  let result = db
    .select({
      id: services.id,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
      status: services.status,
    })
    .from(services)
    .where(
      and(
        eq(services.workerId, workerId),
        eq(services.restaurantId, restaurant.restaurantId),
        gte(services.date, from),
        lte(services.date, to),
        ne(services.status, "cancelled")
      )
    )
    .orderBy(services.date)
    .all();

  // Workers only count hours from published weeks; admins/managers see drafts too.
  if (!canViewDraftSchedule(user)) {
    const mondays = Array.from(new Set(result.map((s) => getMonday(s.date))));
    result = filterRowsToPublishedWeeks(result, loadPublishedWeekSet(restaurant.restaurantId, mondays));
  }

  // Sync-mode: replace scheduled minutes on past services with tap-derived minutes.
  const [restaurantRow] = db
    .select({ tapInOutMode: restaurants.tapInOutMode, tapInCountsAsHours: restaurants.tapInCountsAsHours })
    .from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();
  const syncMode = restaurantRow?.tapInOutMode === "sync";
  const tapInCountsEarly = !!restaurantRow?.tapInCountsAsHours;
  const tapByServiceId = new Map<string, { tapIn: string; tapOut: string | null }>();
  if (syncMode) {
    const taps = db
      .select({ serviceId: timeClocks.serviceId, tapIn: timeClocks.tapIn, tapOut: timeClocks.tapOut })
      .from(timeClocks)
      .where(and(
        eq(timeClocks.restaurantId, restaurant.restaurantId),
        eq(timeClocks.userId, workerId),
        gte(timeClocks.date, from),
        lte(timeClocks.date, to),
      ))
      .all();
    for (const t of taps) if (t.serviceId) tapByServiceId.set(t.serviceId, { tapIn: t.tapIn, tapOut: t.tapOut });
  }

  const today = todayInTimeZone(user.restaurantTimezone);
  let totalMinutes = 0;
  for (const service of result) {
    const [sh, sm] = service.startTime.split(":").map(Number);
    const [eh, em] = service.endTime.split(":").map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60; // overnight service

    // Past + sync mode + matched tap → swap to actual
    if (syncMode && service.date <= today) {
      const tap = tapByServiceId.get(service.id);
      if (tap) {
        const scheduledStart = zonedDateTimeToUtc(service.date, service.startTime, user.restaurantTimezone);
        const scheduledEndBase = zonedDateTimeToUtc(service.date, service.endTime, user.restaurantTimezone);
        const scheduledEnd = scheduledEndBase <= scheduledStart
          ? new Date(scheduledEndBase.getTime() + 24 * 60 * 60 * 1000)
          : scheduledEndBase;
        const tapInMs = new Date(tap.tapIn).getTime();
        const startMs = tapInCountsEarly
          ? Math.min(tapInMs, scheduledStart.getTime())
          : Math.max(tapInMs, scheduledStart.getTime());
        const endMs = tap.tapOut ? new Date(tap.tapOut).getTime() : scheduledEnd.getTime();
        diff = Math.max(0, Math.round((endMs - startMs) / 60000));
      }
    }
    totalMinutes += diff;
  }

  return c.json({
    data: {
      workerId,
      workerName: worker.name,
      period: `${from} to ${to}`,
      totalHours: Math.round((totalMinutes / 60) * 100) / 100,
      serviceCount: result.length,
      services: result,
    },
  });
});

// GET /schedule/monthly-recap?month=2026-03
// Per-worker monthly hours with weekly overtime breakdown (39h HCR threshold)
scheduleRoutes.get("/monthly-recap", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const monthParam = c.req.query("month");

  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }

  if (!canViewMonthlyRecap(user)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [yearStr, monthStr] = monthParam.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr) - 1; // 0-indexed

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const from = firstDay.toISOString().split("T")[0];
  const to = `${year}-${String(month + 1).padStart(2, "0")}-${lastDay.getDate()}`;

  // Find all Mondays of weeks that overlap with this month
  const weeks: Array<{ from: string; to: string }> = [];
  const firstMonday = new Date(firstDay);
  const dow = firstMonday.getDay();
  firstMonday.setDate(firstMonday.getDate() - ((dow + 6) % 7)); // back to Monday

  for (let d = new Date(firstMonday); d <= lastDay; d.setDate(d.getDate() + 7)) {
    const wFrom = d.toISOString().split("T")[0];
    const wSun = new Date(d);
    wSun.setDate(d.getDate() + 6);
    const wTo = wSun.toISOString().split("T")[0];
    weeks.push({ from: wFrom, to: wTo });
  }

  // Fetch all services for the full span (first Monday through last Sunday)
  const spanFrom = weeks[0].from;
  const spanTo = weeks[weeks.length - 1].to;

  const [restaurantRow] = db
    .select({ name: restaurants.name, ownerId: restaurants.ownerId, tapInOutMode: restaurants.tapInOutMode, tapInCountsAsHours: restaurants.tapInCountsAsHours })
    .from(restaurants)
    .where(eq(restaurants.id, restaurant.restaurantId))
    .limit(1)
    .all();
  const sourceMemberWorkerIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });
  const sharedTargetIds = sourceMemberWorkerIds.length > 0
    ? db.select({ restaurantId: workerShareAuthorizations.targetRestaurantId })
      .from(workerShareAuthorizations)
      .where(and(
        eq(workerShareAuthorizations.sourceRestaurantId, restaurant.restaurantId),
        eq(workerShareAuthorizations.ownerId, restaurantRow?.ownerId ?? restaurant.ownerId),
        eq(workerShareAuthorizations.status, "accepted"),
        inArray(workerShareAuthorizations.userId, sourceMemberWorkerIds),
      ))
      .all()
      .map((row) => row.restaurantId)
    : [];
  const serviceScopeRestaurantIds = Array.from(new Set([restaurant.restaurantId, ...sharedTargetIds]));
  const serviceScopeRestaurants = serviceScopeRestaurantIds.length > 0
    ? db.select({ id: restaurants.id, name: restaurants.name })
      .from(restaurants)
      .where(inArray(restaurants.id, serviceScopeRestaurantIds))
      .all()
    : [];
  const restaurantNameById = new Map(serviceScopeRestaurants.map((row) => [row.id, row.name]));
  const serviceScopeFilter = sharedTargetIds.length > 0
    ? or(
      eq(services.restaurantId, restaurant.restaurantId),
      and(inArray(services.restaurantId, sharedTargetIds), inArray(services.workerId, sourceMemberWorkerIds)),
    )
    : eq(services.restaurantId, restaurant.restaurantId);

  let allServices = db
    .select({
      id: services.id,
      restaurantId: services.restaurantId,
      workerId: services.workerId,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
      role: services.role,
    })
    .from(services)
    .where(
      and(
        serviceScopeFilter,
        gte(services.date, spanFrom),
        lte(services.date, spanTo),
        ne(services.status, "cancelled")
      )
    )
    .orderBy(services.date, services.startTime)
    .all();

  if (!canViewDraftSchedule(user)) {
    allServices = filterRowsToPublishedWeeks(allServices, loadPublishedWeekSet(restaurant.restaurantId, weeks.map((w) => w.from)));
  }

  // ── Sync-mode hours: replace scheduled minutes on past services with tap-derived minutes ──
  const syncMode = restaurantRow?.tapInOutMode === "sync";
  const tapInCountsEarly = !!restaurantRow?.tapInCountsAsHours;

  const tapByServiceId = new Map<string, { tapIn: string; tapOut: string | null }>();
  if (syncMode) {
    const taps = db
      .select({ serviceId: timeClocks.serviceId, tapIn: timeClocks.tapIn, tapOut: timeClocks.tapOut })
      .from(timeClocks)
      .where(
        and(
          inArray(timeClocks.restaurantId, serviceScopeRestaurantIds),
          gte(timeClocks.date, spanFrom),
          lte(timeClocks.date, spanTo),
        )
      )
      .all();
    for (const t of taps) {
      if (t.serviceId) tapByServiceId.set(t.serviceId, { tapIn: t.tapIn, tapOut: t.tapOut });
    }
  }

  // Fetch workers
  const rosterWorkers = listSchedulingRosterWorkers(restaurant.restaurantId, ["manager", "kitchen", "floor"]);
  const rosterById = new Map(rosterWorkers.map((worker) => [worker.id, worker]));
  allServices = allServices.filter((service) => isVisibleSchedulingService(rosterById, service));
  const memberWorkerIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });
  const workerIds = Array.from(new Set([...memberWorkerIds, ...rosterWorkers.map((worker) => worker.id)]));
  const workerList = workerIds.length > 0
    ? db
      .select({ id: users.id, name: users.name, role: users.role, overtimeWilling: users.overtimeWilling, contractHours: users.contractHours })
      .from(users)
      .where(and(inArray(users.id, workerIds), ne(users.role, "admin")))
      .all()
    : [];

  const workerMap = new Map(workerList.map(w => [w.id, w]));
  const OVERTIME_THRESHOLD = 39; // HCR convention
  const today = todayInTimeZone(user.restaurantTimezone);

  // Helper: round to 2 decimals
  const r2 = (n: number) => Math.round(n * 100) / 100;

  // Helper: compute service duration in minutes
  function serviceMins(startTime: string, endTime: string): number {
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60;
    return diff;
  }

  function countWeekdaysInRange(startDate: string, endDate: string, rangeFrom: string, rangeTo: string): number {
    const start = startDate > rangeFrom ? startDate : rangeFrom;
    const end = endDate < rangeTo ? endDate : rangeTo;
    if (start > end) return 0;

    let days = 0;
    const cursor = new Date(`${start}T12:00:00`);
    const limit = new Date(`${end}T12:00:00`);
    while (cursor <= limit) {
      const day = cursor.getDay();
      if (day >= 1 && day <= 5) days++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  // Helper: compute actual minutes for a past service, using tap data when sync mode is on.
  // Falls back to scheduled minutes if no tap exists or sync is off.
  // - tapInCountsEarly=false: paid hours start at scheduled start regardless of an earlier tap-in
  //                           (a late tap-in still pushes the start later — the worker doesn't get paid for missed minutes)
  // - tapInCountsEarly=true:  paid hours start at min(tapIn, scheduledStart) — early arrivals are credited
  // - missing tapOut:         fall back to scheduledEnd (forgotten clock-out shouldn't zero out the shift)
  function actualMinsForService(svc: { id: string; date: string; startTime: string; endTime: string }): number {
    if (!syncMode) return serviceMins(svc.startTime, svc.endTime);
    const tap = tapByServiceId.get(svc.id);
    if (!tap) return serviceMins(svc.startTime, svc.endTime);

    const scheduledStart = zonedDateTimeToUtc(svc.date, svc.startTime, user.restaurantTimezone);
    const scheduledEndBase = zonedDateTimeToUtc(svc.date, svc.endTime, user.restaurantTimezone);
    const scheduledEnd = scheduledEndBase <= scheduledStart
      ? new Date(scheduledEndBase.getTime() + 24 * 60 * 60 * 1000)
      : scheduledEndBase;

    const tapInMs = new Date(tap.tapIn).getTime();
    const startMs = tapInCountsEarly
      ? Math.min(tapInMs, scheduledStart.getTime())
      : Math.max(tapInMs, scheduledStart.getTime());
    const endMs = tap.tapOut ? new Date(tap.tapOut).getTime() : scheduledEnd.getTime();

    const mins = Math.max(0, Math.round((endMs - startMs) / 60000));
    return mins;
  }

  type OTBreakdown = { rate110: number; rate120: number; rate150: number };
  type WeekDetail = {
    week: { from: string; to: string };
    hours: number;
    actualHours: number;
    overtime: number;
    actualOvertime: number;
    services: number;
    actualServices: number;
    breakdown: OTBreakdown;
    actualBreakdown: OTBreakdown;
  };
  type AnalyticSection = {
    restaurantId: string;
    restaurantName: string;
    serviceCount: number;
    actualServiceCount: number;
    totalHours: number;
    actualHours: number;
  };
  type WorkerRecap = {
    workerId: string;
    workerName: string;
    workerRole: string;
    contractHours: number | null;
    overtimeWilling: boolean;
    serviceCount: number;
    actualServiceCount: number;
    totalHours: number;
    actualHours: number;
    holidayDays: number;
    actualHolidayDays: number;
    holidayHours: number;
    actualHolidayHours: number;
    overtimeHours: number;
    actualOvertimeHours: number;
    overtimeBreakdown: OTBreakdown;
    actualOvertimeBreakdown: OTBreakdown;
    analytics: AnalyticSection[];
    weeks: WeekDetail[];
  };

  const workerRecaps = new Map<string, WorkerRecap>();

  for (const w of workerList) {
    workerRecaps.set(w.id, {
      workerId: w.id,
      workerName: w.name,
      workerRole: rosterById.get(w.id)?.role ?? w.role,
      contractHours: rosterById.get(w.id)?.contractHours ?? w.contractHours,
      overtimeWilling: !!w.overtimeWilling,
      serviceCount: 0,
      actualServiceCount: 0,
      totalHours: 0,
      actualHours: 0,
      holidayDays: 0,
      actualHolidayDays: 0,
      holidayHours: 0,
      actualHolidayHours: 0,
      overtimeHours: 0,
      actualOvertimeHours: 0,
      overtimeBreakdown: { rate110: 0, rate120: 0, rate150: 0 },
      actualOvertimeBreakdown: { rate110: 0, rate120: 0, rate150: 0 },
      analytics: [],
      weeks: [],
    });
  }

  for (const week of weeks) {
    const weekServices = allServices.filter(s => s.date >= week.from && s.date <= week.to);
    const byWorker = new Map<string, typeof weekServices>();
    for (const s of weekServices) {
      if (!byWorker.has(s.workerId)) byWorker.set(s.workerId, []);
      byWorker.get(s.workerId)!.push(s);
    }

    for (const [workerId, wServices] of byWorker) {
      const recap = workerRecaps.get(workerId);
      if (!recap) continue;

      let weekMinutes = 0;
      let weekActualMinutes = 0;
      let monthMinutes = 0;
      let monthActualMinutes = 0;
      let monthServiceCount = 0;
      let monthActualServiceCount = 0;
      const analyticByRestaurant = new Map<string, AnalyticSection>();

      for (const s of wServices) {
        const mins = serviceMins(s.startTime, s.endTime);
        const isPast = s.date <= today;
        const actMins = isPast ? actualMinsForService(s) : mins;
        weekMinutes += mins;
        if (isPast) weekActualMinutes += actMins;

        if (s.date >= from && s.date <= to) {
          monthMinutes += mins;
          monthServiceCount++;
          if (isPast) {
            monthActualMinutes += actMins;
            monthActualServiceCount++;
          }
          const analytic = analyticByRestaurant.get(s.restaurantId) ?? {
            restaurantId: s.restaurantId,
            restaurantName: restaurantNameById.get(s.restaurantId) ?? s.restaurantId,
            serviceCount: 0,
            actualServiceCount: 0,
            totalHours: 0,
            actualHours: 0,
          };
          analytic.serviceCount += 1;
          analytic.totalHours += mins / 60;
          if (isPast) {
            analytic.actualServiceCount += 1;
            analytic.actualHours += actMins / 60;
          }
          analyticByRestaurant.set(s.restaurantId, analytic);
        }
      }

      const weekHours = r2(weekMinutes / 60);
      const weekActualHours = r2(weekActualMinutes / 60);

      // Overtime computed on full week (labor law is weekly)
      function computeOT(hours: number): { ot: number } & OTBreakdown {
        const ot = Math.max(0, hours - OVERTIME_THRESHOLD);
        return {
          ot,
          rate110: Math.min(ot, 4),
          rate120: Math.min(Math.max(ot - 4, 0), 4),
          rate150: Math.max(ot - 8, 0),
        };
      }

      const projOT = computeOT(weekHours);
      const actOT = computeOT(weekActualHours);

      // Pro-rate overtime for weeks that straddle month boundary
      const weekDaysInMonth = wServices.filter(s => s.date >= from && s.date <= to).length;
      const weekDaysTotal = wServices.length;
      const prorata = weekDaysTotal > 0 ? weekDaysInMonth / weekDaysTotal : 0;

      const weekActualInMonth = wServices.filter(s => s.date >= from && s.date <= to && s.date <= today).length;
      const weekActualTotal = wServices.filter(s => s.date <= today).length;
      const actProrata = weekActualTotal > 0 ? weekActualInMonth / weekActualTotal : 0;

      recap.weeks.push({
        week: { from: week.from, to: week.to },
        hours: r2(monthMinutes / 60),
        actualHours: r2(monthActualMinutes / 60),
        overtime: r2(projOT.ot * prorata),
        actualOvertime: r2(actOT.ot * actProrata),
        services: monthServiceCount,
        actualServices: monthActualServiceCount,
        breakdown: {
          rate110: r2(projOT.rate110 * prorata),
          rate120: r2(projOT.rate120 * prorata),
          rate150: r2(projOT.rate150 * prorata),
        },
        actualBreakdown: {
          rate110: r2(actOT.rate110 * actProrata),
          rate120: r2(actOT.rate120 * actProrata),
          rate150: r2(actOT.rate150 * actProrata),
        },
      });

      recap.serviceCount += monthServiceCount;
      recap.actualServiceCount += monthActualServiceCount;
      recap.totalHours += r2(monthMinutes / 60);
      recap.actualHours += r2(monthActualMinutes / 60);
      for (const analytic of analyticByRestaurant.values()) {
        const existing = recap.analytics.find((section) => section.restaurantId === analytic.restaurantId);
        if (existing) {
          existing.serviceCount += analytic.serviceCount;
          existing.actualServiceCount += analytic.actualServiceCount;
          existing.totalHours = r2(existing.totalHours + analytic.totalHours);
          existing.actualHours = r2(existing.actualHours + analytic.actualHours);
        } else {
          recap.analytics.push({
            ...analytic,
            totalHours: r2(analytic.totalHours),
            actualHours: r2(analytic.actualHours),
          });
        }
      }
      recap.overtimeHours += r2(projOT.ot * prorata);
      recap.actualOvertimeHours += r2(actOT.ot * actProrata);
      recap.overtimeBreakdown.rate110 += r2(projOT.rate110 * prorata);
      recap.overtimeBreakdown.rate120 += r2(projOT.rate120 * prorata);
      recap.overtimeBreakdown.rate150 += r2(projOT.rate150 * prorata);
      recap.actualOvertimeBreakdown.rate110 += r2(actOT.rate110 * actProrata);
      recap.actualOvertimeBreakdown.rate120 += r2(actOT.rate120 * actProrata);
      recap.actualOvertimeBreakdown.rate150 += r2(actOT.rate150 * actProrata);
    }
  }

  const approvedLeaves = db
    .select({
      workerId: holidayRequests.workerId,
      startDate: holidayRequests.startDate,
      endDate: holidayRequests.endDate,
    })
    .from(holidayRequests)
    .where(
      and(
        eq(holidayRequests.restaurantId, restaurant.restaurantId),
        eq(holidayRequests.status, "approved"),
        eq(holidayRequests.medical, false),
        lte(holidayRequests.startDate, to),
        gte(holidayRequests.endDate, from),
      )
    )
    .all();

  for (const leave of approvedLeaves) {
    const recap = workerRecaps.get(leave.workerId);
    const worker = workerMap.get(leave.workerId);
    if (!recap || !worker) continue;

    const leaveDays = countWeekdaysInRange(leave.startDate, leave.endDate, from, to);
    const actualLeaveDays = countWeekdaysInRange(leave.startDate, leave.endDate, from, today < to ? today : to);
    const dailyContractHours = (worker.contractHours ?? 35) / 5;

    recap.holidayDays += leaveDays;
    recap.actualHolidayDays += actualLeaveDays;
    recap.holidayHours += r2(leaveDays * dailyContractHours);
    recap.actualHolidayHours += r2(actualLeaveDays * dailyContractHours);
  }

  // Only include workers who had services or approved paid leave; workers see only their own data
  const workers = [...workerRecaps.values()]
    .map((w) => ({
      ...w,
      analytics: w.analytics.sort((a, b) => a.restaurantName.localeCompare(b.restaurantName, "fr", { sensitivity: "base" })),
    }))
    .filter(w => w.serviceCount > 0 || w.holidayDays > 0)
    .filter(w => can(user, "HOURS_VIEW") || w.workerId === user.id)
    .sort((a, b) => a.workerName.localeCompare(b.workerName));

  const sum = (arr: WorkerRecap[], fn: (w: WorkerRecap) => number) =>
    r2(arr.reduce((s, w) => s + fn(w), 0));

  const totals = {
    serviceCount: sum(workers, w => w.serviceCount),
    actualServiceCount: sum(workers, w => w.actualServiceCount),
    totalHours: sum(workers, w => w.totalHours),
    actualHours: sum(workers, w => w.actualHours),
    holidayDays: sum(workers, w => w.holidayDays),
    actualHolidayDays: sum(workers, w => w.actualHolidayDays),
    holidayHours: sum(workers, w => w.holidayHours),
    actualHolidayHours: sum(workers, w => w.actualHolidayHours),
    overtimeHours: sum(workers, w => w.overtimeHours),
    actualOvertimeHours: sum(workers, w => w.actualOvertimeHours),
  };

  return c.json({
    data: {
      month: monthParam,
      today,
      workers,
      totals,
    },
  });
});

// GET /schedule/who-works?date=2026-03-22
scheduleRoutes.get("/who-works", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const date = c.req.query("date");

  if (!date) {
    return c.json({ error: "date query param required" }, 400);
  }

  if (!canViewDraftSchedule(user)) {
    const published = loadPublishedWeekSet(restaurant.restaurantId, [getMonday(date)]);
    if (published.size === 0) return c.json({ data: [] });
  }

  const visibleRosterById = liveSchedulingRosterById(restaurant.restaurantId);
  const result = db
    .select({
      workerId: services.workerId,
      workerName: users.name,
      role: services.role,
      startTime: services.startTime,
      endTime: services.endTime,
      status: services.status,
    })
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(
      and(
        eq(services.restaurantId, restaurant.restaurantId),
        eq(services.date, date),
        ne(services.status, "cancelled")
      )
    )
    .orderBy(services.startTime)
    .all()
    .filter((service) => isVisibleSchedulingService(visibleRosterById, service));

  return c.json({ data: result });
});

// DELETE /schedule/week?date=YYYY-MM-DD — wipe all services for the week
scheduleRoutes.delete("/week", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const date = c.req.query("date");
  if (!date) return c.json({ error: "date required" }, 400);

  const monday = getMonday(date);
  const dates = weekDates(monday);
  const from = dates[0];
  const to = dates[6];

  const forced = c.req.query("force") === "true";
  const locked = isWeekLocked(restaurant.restaurantId, from);
  if (locked && !forced) {
    return c.json({ error: WEEK_LOCKED_ERROR, code: "WEEK_LOCKED", weekStart: from }, 423);
  }

  const existing = db.select({ id: services.id })
    .from(services)
    .where(and(
      eq(services.restaurantId, restaurant.restaurantId),
      gte(services.date, from),
      lte(services.date, to),
      ne(services.status, "cancelled"),
    )).all();

  if (existing.length === 0) return c.json({ data: { deleted: 0 } });

  const serviceIds = existing.map(s => s.id);

  // Delete related records that have FK references to these services
  for (const sid of serviceIds) {
    db.delete(timeClocks).where(eq(timeClocks.serviceId, sid)).run();
    db.delete(replacementRequests).where(eq(replacementRequests.requesterServiceId, sid)).run();
    db.update(openShifts).set({ status: "cancelled", serviceId: null }).where(eq(openShifts.serviceId, sid)).run();
  }

  db.delete(services)
    .where(and(
      eq(services.restaurantId, restaurant.restaurantId),
      gte(services.date, from),
      lte(services.date, to),
      ne(services.status, "cancelled"),
    )).run();

  const wipePrefix = locked && forced ? "[Semaine verrouillée — override] " : "";
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "services",
    rowId: `week:${from}`,
    action: "delete",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: { deleted: { old: existing.length, new: 0 } },
    summary: `${wipePrefix}Semaine effacée ${from} → ${to} : ${existing.length} service(s) supprimé(s)`,
  });

  return c.json({ data: { deleted: existing.length } });
});

// GET /schedule/week/published?date=YYYY-MM-DD — check if week is published
// Open to any authed role: workers need it to render "not yet published" empty states.
scheduleRoutes.get("/week/published", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const date = c.req.query("date");
  if (!date) return c.json({ error: "date required" }, 400);
  const monday = getMonday(date);
  const row = db.select().from(publishedWeeks)
    .where(and(eq(publishedWeeks.restaurantId, restaurant.restaurantId), eq(publishedWeeks.weekDate, monday)))
    .get();
  return c.json({ data: { published: !!row, publishedAt: row?.publishedAt ?? null } });
});

// PUT /schedule/week/published?date=YYYY-MM-DD — toggle publish status
scheduleRoutes.put("/week/published", requirePermission("PUBLISH_WEEK"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const date = c.req.query("date");
  if (!date) return c.json({ error: "date required" }, 400);
  const monday = getMonday(date);
  const body = await c.req.json<{ published: boolean }>();

  if (body.published) {
    // Upsert
    const existing = db.select().from(publishedWeeks)
      .where(and(eq(publishedWeeks.restaurantId, restaurant.restaurantId), eq(publishedWeeks.weekDate, monday)))
      .get();
    if (!existing) {
      const publishedAt = new Date().toISOString();
      db.insert(publishedWeeks).values({
        restaurantId: restaurant.restaurantId,
        weekDate: monday,
        publishedAt,
      }).run();
      const notifiedWorkers = await notifyWorkersWeekPublished(restaurant.restaurantId, monday);
      return c.json({ data: { published: true, publishedAt, notifiedWorkers } });
    }
    return c.json({ data: { published: true, publishedAt: existing.publishedAt } });
  } else {
    if (isWeekLocked(restaurant.restaurantId, monday)) {
      return c.json({ error: WEEK_LOCKED_ERROR }, 423);
    }
    db.delete(publishedWeeks)
      .where(and(eq(publishedWeeks.restaurantId, restaurant.restaurantId), eq(publishedWeeks.weekDate, monday)))
      .run();
    return c.json({ data: { published: false, publishedAt: null } });
  }
});
