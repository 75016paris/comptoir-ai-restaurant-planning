import { Hono } from "hono";
import { type AppEnv, type AuthUser } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { db } from "../db/connection.js";
import { holidayRequests, users, restaurants, documents, services, staffingTargets, staffingProfiles, staffingSchedule, restaurantClosures } from "../db/schema.js";
import { eq, and, gte, lte, or, ne, sql, inArray } from "drizzle-orm";
import { isoWeekNum, isoWeekYear, isoDayOfWeek, fmtDate, getMonday, weekDates } from "../utils/scheduling.js";
import { requireAuth, requirePermission, requireActiveSubscription } from "../middleware/auth.js";
import { can, createHolidayRequestSchema, reviewHolidaySchema, flattenZodError } from "@comptoir/shared";
import { notifyHolidayAssigned, notifyHolidayReview, notifyHolidayProposal, notifyHolidayImposed } from "../services/notifications.js";
import { logAudit, diff } from "../db/audit.js";
import { listRestaurantMemberUserIds, userHasActiveRestaurantMembership } from "../services/restaurant-context.js";

import { generatePlan } from "./autostaffing.js";
import { computePendingClusters, computeLeaveIntelligence } from "../services/leave-intelligence.js";
import { bumpCacheVersion } from "../services/baseline-cache.js";
import {
  InvalidUploadError,
  StorageInactiveError,
  commitUploadedObject,
  deleteStoredObject,
  presignDocumentDownload,
  presignDocumentUpload,
} from "../services/document-uploads.js";

export const holidayRoutes = new Hono<AppEnv>();

holidayRoutes.use("*", requireAuth);
holidayRoutes.use("*", requireActiveSubscription);

function findOverlappingHoliday(restaurantId: string, workerId: string, startDate: string, endDate: string) {
  return db.select({ id: holidayRequests.id })
    .from(holidayRequests)
    .where(and(
      eq(holidayRequests.workerId, workerId),
      eq(holidayRequests.restaurantId, restaurantId),
      or(eq(holidayRequests.status, "pending"), eq(holidayRequests.status, "approved")),
      lte(holidayRequests.startDate, endDate),
      gte(holidayRequests.endDate, startDate),
    ))
    .limit(1)
    .all()[0] ?? null;
}

function canViewMedicalFor(user: Pick<AuthUser, "id" | "role" | "permissions">, workerId: string): boolean {
  return user.id === workerId || can(user, "MEDICAL_DOC_VIEW");
}

function redactHolidayMedical<T extends { workerId: string; medical: boolean; reason: string | null }>(row: T, user: Pick<AuthUser, "id" | "role" | "permissions">): T {
  if (!row.medical || canViewMedicalFor(user, row.workerId)) return row;
  return { ...row, medical: false, reason: null };
}

// GET /holidays — includes workerName for admin view
holidayRoutes.get("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);

  const where =
    can(user, "LEAVE_APPROVE")
      ? eq(holidayRequests.restaurantId, restaurant.restaurantId)
      : and(
          eq(holidayRequests.restaurantId, restaurant.restaurantId),
          eq(holidayRequests.workerId, user.id)
        );

  const rows = db
    .select({
      id: holidayRequests.id,
      workerId: holidayRequests.workerId,
      restaurantId: holidayRequests.restaurantId,
      startDate: holidayRequests.startDate,
      endDate: holidayRequests.endDate,
      reason: holidayRequests.reason,
      medical: holidayRequests.medical,
      status: holidayRequests.status,
      source: holidayRequests.source,
      reviewedBy: holidayRequests.reviewedBy,
      reviewedAt: holidayRequests.reviewedAt,
      createdAt: holidayRequests.createdAt,
      workerName: users.name,
    })
    .from(holidayRequests)
    .leftJoin(users, eq(holidayRequests.workerId, users.id))
    .where(where)
    .orderBy(holidayRequests.createdAt)
    .all();

  // Attach document count per request (avoids N+1 — single query for all)
  const docCounts = db
    .select({ holidayRequestId: documents.holidayRequestId })
    .from(documents)
    .where(eq(documents.restaurantId, restaurant.restaurantId))
    .all()
    .reduce((acc, d) => {
      if (d.holidayRequestId) acc[d.holidayRequestId] = (acc[d.holidayRequestId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

  const result = rows.map((r) => redactHolidayMedical({
    ...r,
    documentCount: canViewMedicalFor(user, r.workerId) ? docCounts[r.id] || 0 : 0,
  }, user));

  return c.json({ data: result });
});

// POST /holidays
holidayRoutes.post("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const parsed = createHolidayRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  // Admins/managers can create holidays on behalf of a worker by passing workerId in the body
  let targetWorkerId = user.id;
  if (can(user, "LEAVE_APPROVE") && parsed.data.workerId) {
    const [worker] = db.select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, parsed.data.workerId), eq(users.active, true)))
      .limit(1).all();
    if (!worker || !userHasActiveRestaurantMembership(parsed.data.workerId, restaurant.restaurantId, ["kitchen", "floor"])) {
      return c.json({ error: "Employé non trouvé" }, 404);
    }
    targetWorkerId = parsed.data.workerId;
  }

  // Workers cannot backdate; admins/managers can (e.g. registering yesterday's sick leave)
  const today = new Date().toISOString().split("T")[0];
  if (targetWorkerId === user.id && !can(user, "LEAVE_APPROVE") && parsed.data.startDate < today && !parsed.data.medical) {
    return c.json({ error: "Les demandes de congé ne peuvent pas être créées pour des dates passées" }, 400);
  }
  if (parsed.data.endDate < parsed.data.startDate) {
    return c.json({ error: "La date de fin doit être après la date de début" }, 400);
  }

  // Block duplicate for the target worker (applies whether submitted by worker or admin)
  if (findOverlappingHoliday(restaurant.restaurantId, targetWorkerId, parsed.data.startDate, parsed.data.endDate)) {
    return c.json({ error: "Une demande de congé existe déjà pour ces dates" }, 409);
  }

  const isMedical = parsed.data.medical ?? false;
  if (isMedical && !canViewMedicalFor(user, targetWorkerId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const reason = typeof parsed.data.reason === "string" && parsed.data.reason.trim()
    ? parsed.data.reason.trim()
    : null;
  const storedReason = isMedical ? null : reason;

  // Admin/manager-created holidays for workers are auto-approved; medical requests auto-approved when medicalMode is on
  const ownerAssigned = can(user, "LEAVE_APPROVE") && targetWorkerId !== user.id;
  let status: "pending" | "approved" = "pending";
  if (ownerAssigned) {
    status = "approved";
  } else if (isMedical) {
    const [resto] = db.select({ medicalMode: restaurants.medicalMode })
      .from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();
    if (resto?.medicalMode) status = "approved";
  }

  // Attach uploaded documents to the holiday request. Caller must PUT the file
  // to OVH via /holidays/documents/presign first, then post the returned
  // storageKey here. Base64 ingestion was removed in Phase E.
  const docs = body.documents as Array<{
    name: string;
    filename: string;
    mimeType: string;
    size: number;
    storageKey?: string;
  }> | undefined;
  if (docs?.length && !canViewMedicalFor(user, targetWorkerId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const committedDocs: Array<{
    name: string;
    filename: string;
    mimeType: string;
    size: number;
    storageProvider: "ovh";
    storageKey: string;
  }> = [];
  if (docs?.length) {
    for (const doc of docs) {
      if (!doc.name || !doc.filename || !doc.mimeType || !doc.storageKey) continue;
      try {
        const committed = await commitUploadedObject({
          pendingKey: doc.storageKey,
          restaurantId: restaurant.restaurantId,
          userId: user.id,
          filename: doc.filename,
          expectedMimeType: doc.mimeType,
        });
        committedDocs.push({
          name: doc.name,
          filename: doc.filename,
          mimeType: doc.mimeType,
          size: committed.size,
          storageProvider: "ovh",
          storageKey: committed.storageKey,
        });
      } catch (err) {
        if (err instanceof StorageInactiveError) return c.json({ error: "Object storage indisponible" }, 503);
        if (err instanceof InvalidUploadError) return c.json({ error: err.message }, err.status as 400 | 403 | 413);
        throw err;
      }
    }
  }

  let request: typeof holidayRequests.$inferSelect;
  try {
    request = db.transaction((tx) => {
      const [created] = tx
        .insert(holidayRequests)
        .values({
          workerId: targetWorkerId,
          restaurantId: restaurant.restaurantId,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          reason: ownerAssigned ? (storedReason ?? "Congé ajouté par l’employeur") : storedReason,
          medical: isMedical,
          status,
          ...(ownerAssigned ? { source: "admin_proposal" as const, reviewedBy: user.id, reviewedAt: new Date().toISOString() } : {}),
        })
        .returning()
        .all();

      for (const doc of committedDocs) {
        tx.insert(documents).values({
          userId: user.id,
          restaurantId: restaurant.restaurantId,
          holidayRequestId: created.id,
          name: doc.name,
          type: "medical",
          filename: doc.filename,
          mimeType: doc.mimeType,
          size: doc.size,
          data: "",
          storageProvider: doc.storageProvider,
          storageKey: doc.storageKey,
          storageStatus: "ready",
          uploadedBy: user.id,
        }).run();
      }
      return created;
    });
  } catch (err) {
    await Promise.all(committedDocs.map((doc) => deleteStoredObject(doc.storageKey)));
    throw err;
  }

  const workerRow = db.select({ name: users.name }).from(users).where(eq(users.id, targetWorkerId)).all()[0];
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "holiday_requests",
    rowId: request.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: diff(null, request),
    summary: `Demande de congé ${request.startDate} → ${request.endDate} pour ${workerRow?.name ?? "?"}${isMedical ? " (arrêt maladie)" : ""}`,
  });

  if (ownerAssigned) {
    notifyHolidayAssigned(targetWorkerId, request.startDate, request.endDate, request.reason, restaurant.restaurantId).catch(console.error);
  }

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: request }, 201);
});

// GET /holidays/batch-impact — optimal approval set for all pending holidays.
// Thin wrapper around the unified leave-intelligence service.
holidayRoutes.get("/batch-impact", requirePermission("LEAVE_APPROVE"), async (c) => {
  const restaurant = requestRestaurant(c);
  const clusters = await computePendingClusters(restaurant.restaurantId);
  return c.json({ data: { clusters } });
});

// GET /holidays/intelligence — unified payload for /holidays:
// balances, per-role advice, pending clusters, HCR-CONGES-PAYES warnings, urgency.
holidayRoutes.get("/intelligence", requirePermission("LEAVE_APPROVE"), async (c) => {
  const restaurant = requestRestaurant(c);
  const profileId = c.req.query("profileId") || undefined;
  try {
    const data = await computeLeaveIntelligence(restaurant.restaurantId, profileId);
    return c.json({ data });
  } catch (e: any) {
    console.error("Leave intelligence failed:", e?.message || e);
    return c.json({ error: e?.message || "leave intelligence failed" }, 500);
  }
});
// POST /holidays/documents/presign — mint an OVH upload URL for an ITT/medical doc.
// Called before POST /holidays so the eventual create payload can carry a storageKey
// instead of a base64 blob.
holidayRoutes.post("/documents/presign", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json().catch(() => ({}));
  const { filename, mimeType, size } = body as { filename?: string; mimeType?: string; size?: number };
  if (!filename || !mimeType || typeof size !== "number") {
    return c.json({ error: "filename, mimeType, size requis" }, 400);
  }
  const documentId = crypto.randomUUID();
  try {
    const presigned = await presignDocumentUpload({
      restaurantId: restaurant.restaurantId,
      userId: user.id,
      documentId,
      filename,
      mimeType,
      size,
    });
    return c.json({ data: { documentId, ...presigned } });
  } catch (err) {
    if (err instanceof StorageInactiveError) return c.json({ error: "Object storage indisponible" }, 503);
    if (err instanceof InvalidUploadError) return c.json({ error: err.message }, err.status as 400 | 403 | 413);
    throw err;
  }
});

// GET /holidays/:id/documents — list docs attached to a holiday request
holidayRoutes.get("/:id/documents", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");

  // Verify the holiday request belongs to this restaurant + user has medical access
  const [hr] = db.select({ workerId: holidayRequests.workerId })
    .from(holidayRequests)
    .where(and(eq(holidayRequests.id, id), eq(holidayRequests.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!hr) return c.json({ error: "Not found" }, 404);
  if (!canViewMedicalFor(user, hr.workerId)) return c.json({ error: "Forbidden" }, 403);

  const docs = db.select({
    id: documents.id,
    name: documents.name,
    type: documents.type,
    filename: documents.filename,
    mimeType: documents.mimeType,
    size: documents.size,
    createdAt: documents.createdAt,
  }).from(documents)
    .where(and(eq(documents.holidayRequestId, id), eq(documents.restaurantId, restaurant.restaurantId)))
    .all();

  return c.json({ data: docs });
});

// GET /holidays/:id/documents/:docId — download a specific document
holidayRoutes.get("/:id/documents/:docId", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const docId = c.req.param("docId");

  const [hr] = db.select({ workerId: holidayRequests.workerId })
    .from(holidayRequests)
    .where(and(eq(holidayRequests.id, id), eq(holidayRequests.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!hr) return c.json({ error: "Not found" }, 404);
  if (!canViewMedicalFor(user, hr.workerId)) return c.json({ error: "Forbidden" }, 403);

  const [doc] = db.select().from(documents)
    .where(and(eq(documents.id, docId), eq(documents.holidayRequestId, id), eq(documents.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!doc) return c.json({ error: "Document not found" }, 404);

  if (doc.storageProvider === "ovh" && doc.storageKey) {
    const presigned = await presignDocumentDownload(doc.storageKey);
    const { data: _legacy, ...meta } = doc;
    return c.json({ data: { ...meta, url: presigned.url, urlExpiresAt: presigned.expiresAt } });
  }

  return c.json({ data: doc });
});

// GET /holidays/:id/impact — decision-support analysis for a pending holiday
holidayRoutes.get("/:id/impact", requirePermission("LEAVE_APPROVE"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");

  // Load the holiday request
  const [hr] = db.select()
    .from(holidayRequests)
    .where(and(eq(holidayRequests.id, id), eq(holidayRequests.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!hr) return c.json({ error: "Not found" }, 404);

  const [worker] = db.select({
    name: users.name,
    role: users.role,
    contractHours: users.contractHours,
    subRoles: users.subRoles,
  }).from(users).where(eq(users.id, hr.workerId)).limit(1).all();

  // 1. Services this worker has during the holiday period
  const affectedServices = db.select({
    id: services.id,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
  }).from(services)
    .where(and(
      eq(services.workerId, hr.workerId),
      eq(services.restaurantId, restaurant.restaurantId),
      gte(services.date, hr.startDate),
      lte(services.date, hr.endDate),
    )).all();

  // 2. For each affected day, count how many other workers of the same role are scheduled
  const dayDetails: Array<{
    date: string;
    servicesToCancel: number;
    sameRoleTotal: number;
    sameRoleWithout: number;
    belowTarget: boolean;
    targetCount: number;
  }> = [];

  // Resolve week-aware profile EARLY — shared by Layer 2 targets + Layer 4 structural analysis
  let impactProfileId: string | undefined;
  {
    const d = new Date(hr.startDate + "T12:00:00");
    const dow = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((dow + 6) % 7));
    const monStr = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}`;
    const weekNum = isoWeekNum(monStr);
    const weekYear = isoWeekYear(monStr);
    const [assignment] = db.select({ profileId: staffingSchedule.profileId })
      .from(staffingSchedule)
      .where(and(
        eq(staffingSchedule.restaurantId, restaurant.restaurantId),
        eq(staffingSchedule.year, weekYear),
        eq(staffingSchedule.week, weekNum),
      )).limit(1).all();
    if (assignment) {
      impactProfileId = assignment.profileId;
    } else {
      const [first] = db.select({ id: staffingProfiles.id })
        .from(staffingProfiles)
        .where(eq(staffingProfiles.restaurantId, restaurant.restaurantId))
        .orderBy(staffingProfiles.sortOrder)
        .limit(1).all();
      impactProfileId = first?.id;
    }
  }

  // Load staffing targets scoped to the resolved profile
  const targets = impactProfileId
    ? db.select()
        .from(staffingTargets)
        .where(and(eq(staffingTargets.restaurantId, restaurant.restaurantId), eq(staffingTargets.profileId, impactProfileId)))
        .all()
    : [];

  // Group affected services by date
  const servicesByDate = new Map<string, typeof affectedServices>();
  for (const s of affectedServices) {
    const arr = servicesByDate.get(s.date) || [];
    arr.push(s);
    servicesByDate.set(s.date, arr);
  }

  for (const [date, workerServices] of servicesByDate) {
    const role = worker?.role || workerServices[0]?.role || "floor";

    // Count all services of same role on this day
    const allSameRole = db.select({ id: services.id })
      .from(services)
      .where(and(
        eq(services.restaurantId, restaurant.restaurantId),
        eq(services.date, date),
        eq(services.role, role as "kitchen" | "floor"),
      )).all();

    // Day of week (1=Mon..7=Sun)
    const d = new Date(date + "T12:00:00");
    const jsDay = d.getDay();
    const dow = jsDay === 0 ? 7 : jsDay;

    // Sum targets for this day + role across all zones
    const dayTargets = targets.filter(t => t.dayOfWeek === dow && t.role === role);
    const targetCount = dayTargets.reduce((sum, t) => sum + t.count, 0);

    const sameRoleTotal = allSameRole.length;
    const sameRoleWithout = sameRoleTotal - workerServices.length;

    dayDetails.push({
      date,
      servicesToCancel: workerServices.length,
      sameRoleTotal,
      sameRoleWithout,
      belowTarget: targetCount > 0 && sameRoleWithout < targetCount,
      targetCount,
    });
  }

  // 3. Other approved/pending holidays overlapping this period (same restaurant)
  const overlapping = db.select({
    id: holidayRequests.id,
    workerId: holidayRequests.workerId,
    startDate: holidayRequests.startDate,
    endDate: holidayRequests.endDate,
    status: holidayRequests.status,
    workerName: users.name,
    workerRole: users.role,
  }).from(holidayRequests)
    .leftJoin(users, eq(holidayRequests.workerId, users.id))
    .where(and(
      eq(holidayRequests.restaurantId, restaurant.restaurantId),
      ne(holidayRequests.id, hr.id),
      or(eq(holidayRequests.status, "approved"), eq(holidayRequests.status, "pending")),
      lte(holidayRequests.startDate, hr.endDate),
      gte(holidayRequests.endDate, hr.startDate),
    )).all();

  // 4. Solver-backed structural analysis (CP-SAT primary, ILP fallback) — run twice to compare baseline vs with-holiday
  //    Baseline: only approved holidays (worker IS available)
  //    Without:  approved holidays + this pending holiday (worker is NOT available on those days)
  const alreadyOutIds = overlapping.filter(o => o.status === "approved").map(o => o.workerId);
  const workerRole = worker?.role || "floor";

  // Compute which ISO days-of-week (1=Mon..7=Sun) are covered by this holiday
  const holidayDows = new Set<number>();
  {
    const cur = new Date(hr.startDate + "T12:00:00");
    const end = new Date(hr.endDate + "T12:00:00");
    while (cur <= end) {
      const jsDay = cur.getDay();
      holidayDows.add(jsDay === 0 ? 7 : jsDay);
      if (holidayDows.size === 7) break;
      cur.setDate(cur.getDate() + 1);
    }
  }

  // Reference week = 8 weeks out to avoid existing services interfering
  const refMonday = fmtDate((() => {
    const d = new Date(); d.setDate(d.getDate() + 56 - d.getDay() + 1); return d;
  })());

  // Run solver twice: baseline (worker available) vs without (worker on leave)
  let baselineSchedule: Awaited<ReturnType<typeof generatePlan>> | null = null;
  let withoutSchedule: Awaited<ReturnType<typeof generatePlan>> | null = null;
  let solveError: string | undefined;
  try {
    [baselineSchedule, withoutSchedule] = await Promise.all([
      generatePlan(restaurant.restaurantId, refMonday, undefined, {
        holidayFilter: ["approved"],
      }),
      generatePlan(restaurant.restaurantId, refMonday, undefined, {
        holidayFilter: ["approved"],
        // Map absence to reference week dates so isOnHoliday matches
        extraAbsences: [{ workerId: hr.workerId, startDate: weekDates(refMonday)[0], endDate: weekDates(refMonday)[6] }],
      }),
    ]);
  } catch (e: any) {
    solveError = e.message || String(e);
  }

  // Build slot comparison from solver results
  const slotsAffected: Array<{
    dayOfWeek: number;
    zone: string;
    role: string;
    baselineFilled: number;
    withoutFilled: number;
    target: number;
    becameUnfillable: boolean;
  }> = [];

  let baselineUnfillable = 0;
  let withoutUnfillable = 0;

  if (baselineSchedule && withoutSchedule) {
    // Count unique workers assigned per (dow, role, zone) in each solve
    const countBySlot = (svcs: typeof baselineSchedule.services) => {
      const map = new Map<string, Set<string>>();
      for (const s of svcs) {
        const dow = isoDayOfWeek(s.date);
        const key = `${dow}_${s.role}_${s.zone}`;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key)!.add(s.workerId);
      }
      return map;
    };
    const baselineFills = countBySlot(baselineSchedule.services);
    const withoutFills = countBySlot(withoutSchedule.services);

    // Load targets to know what slots exist
    const tgts = impactProfileId
      ? db.select().from(staffingTargets)
          .where(and(eq(staffingTargets.restaurantId, restaurant.restaurantId), eq(staffingTargets.profileId, impactProfileId))).all()
      : [];

    for (const t of tgts) {
      if (t.count === 0) continue;
      if (!holidayDows.has(t.dayOfWeek)) continue;
      const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
      const bFilled = baselineFills.get(key)?.size ?? 0;
      const wFilled = withoutFills.get(key)?.size ?? 0;
      if (bFilled !== wFilled) {
        const bUnfillable = bFilled < t.count;
        const wUnfillable = wFilled < t.count;
        if (bUnfillable) baselineUnfillable++;
        if (wUnfillable) withoutUnfillable++;
        slotsAffected.push({
          dayOfWeek: t.dayOfWeek,
          zone: t.zone,
          role: t.role,
          baselineFilled: bFilled,
          withoutFilled: wFilled,
          target: t.count,
          becameUnfillable: !bUnfillable && wUnfillable,
        });
      }
    }
  }

  // 4b. Contract hours impact — all derived from solver dual-run, no heuristic
  const contractHours = worker?.contractHours ?? 35;
  const actualLostHours = affectedServices.reduce((sum, s) => {
    const [sh, sm] = s.startTime.split(":").map(Number);
    const [eh, em] = s.endTime.split(":").map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60;
    return sum + diff / 60;
  }, 0);

  const holidayDayCount = (() => {
    let count = 0;
    const cur = new Date(hr.startDate + "T12:00:00");
    const end = new Date(hr.endDate + "T12:00:00");
    while (cur <= end) { count++; cur.setDate(cur.getDate() + 1); }
    return count;
  })();

  // Absorption: use baseline workerHourSummary for planned hours per worker
  const baselineHours = baselineSchedule?.workerHourSummary ?? [];
  const sameRoleHours = baselineHours.filter(wh => wh.role === workerRole && wh.workerId !== hr.workerId);
  const remainingCapacity = sameRoleHours.reduce((sum, wh) => {
    const slack = wh.contractHours - wh.plannedHours;
    return sum + Math.max(0, slack);
  }, 0);
  const [restaurantPolicy] = db.select({
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
  }).from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();
  const globalOtCap = restaurantPolicy?.overtimeMode === "strict"
    ? 39
    : restaurantPolicy?.overtimeMode === "controlled"
      ? restaurantPolicy.overtimeWeeklyCap
      : 48;
  const remainingOvertimeCapacity = sameRoleHours.reduce((sum, wh) => {
    const cap = Math.max(wh.contractHours, globalOtCap);
    return sum + Math.max(0, cap - Math.max(wh.plannedHours, wh.contractHours));
  }, 0);

  // Bottleneck & demand share: derive from solver data
  const workerBaselineHours = baselineHours.find(wh => wh.workerId === hr.workerId);
  const totalRoleServices = baselineSchedule?.services.filter(s => s.role === workerRole).length ?? 0;
  const workerServices = baselineSchedule?.services.filter(s => s.workerId === hr.workerId).length ?? 0;

  // Projection: when the absence is in a future week with no published plan,
  // affectedServices is empty. Fall back to the solver baseline week scaled by
  // ouvrables-of-absence over 6 (CP entitlement is in jours ouvrables, Mon-Sat).
  // Calendar-days/7 underestimated typical Mon-Fri leaves (5/7 ≈ 0.71 of a week
  // when the worker actually loses 5 of their 6 ouvrables). Audit Bug H4.
  const workingDaysOff = (() => {
    let count = 0;
    const cur = new Date(hr.startDate + "T12:00:00");
    const end = new Date(hr.endDate + "T12:00:00");
    while (cur <= end) {
      if (cur.getDay() !== 0) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  })();
  const weeksOfAbsence = workingDaysOff / 6;
  const projectedLostHours = (workerBaselineHours?.plannedHours ?? 0) * weeksOfAbsence;
  const projectedShiftsAffected = Math.round(workerServices * weeksOfAbsence);
  const lostHours = actualLostHours > 0 ? actualLostHours : projectedLostHours;
  const canAbsorbWithoutOT = remainingCapacity >= lostHours;
  const overtimeHoursNeeded = Math.max(0, lostHours - remainingCapacity);
  const workerDemandShare = totalRoleServices > 0 ? Math.round((workerServices / totalRoleServices) * 100) / 100 : 0;
  const isBottleneck = slotsAffected.some(s => s.becameUnfillable);

  // Capacity from solver baseline
  const baselineRoleServices = totalRoleServices;
  const roleDemand = baselineSchedule?.slotFillSummary
    .filter(sf => sf.role === workerRole)
    .reduce((sum, sf) => sum + sf.target, 0) ?? 0;

  // Sub-role coverage: fetch other workers' subRoles directly
  let subRoleCoverage: { subRole: string; coveredBy: number; totalNeeded: number }[] | undefined;
  const workerSubRoles: string[] = (() => {
    try {
      const parsed = typeof worker?.subRoles === "string" ? JSON.parse(worker.subRoles) : worker?.subRoles;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  })();
  if (workerSubRoles.length > 0) {
    const memberWorkerIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: [workerRole] });
    const otherWorkers = memberWorkerIds.length > 0
      ? db.select({ id: users.id, subRoles: users.subRoles })
        .from(users)
        .where(and(
          inArray(users.id, memberWorkerIds),
          eq(users.role, workerRole),
          eq(users.active, true),
          ne(users.id, hr.workerId),
        )).all()
      : [];
    subRoleCoverage = workerSubRoles.map(sr => {
      const others = otherWorkers.filter(ow => {
        try {
          const roles = typeof ow.subRoles === "string" ? JSON.parse(ow.subRoles) : ow.subRoles;
          return Array.isArray(roles) && roles.includes(sr);
        } catch { return false; }
      });
      return { subRole: sr, coveredBy: others.length, totalNeeded: 1 };
    });
  }

  const hoursImpact = {
    contractHours,
    lostHours: Math.round(lostHours * 10) / 10,
    holidayDays: holidayDayCount,
    canAbsorbWithoutOT,
    remainingTeamSlack: Math.round(remainingCapacity * 10) / 10,
    canCoverWithOvertime: !canAbsorbWithoutOT
      && !!withoutSchedule
      && (withoutSchedule.solverStatus === "optimal" || withoutSchedule.solverStatus === "feasible")
      && (withoutSchedule.complianceWarnings?.length ?? 0) === 0
      && !slotsAffected.some(s => s.becameUnfillable),
    overtimeHoursNeeded: Math.round(overtimeHoursNeeded * 10) / 10,
    remainingOvertimeCapacity: Math.round(remainingOvertimeCapacity * 10) / 10,
    subRoleCoverage,
  };

  const structuralImpact = {
    slotsAffected,
    slotsBecameUnfillable: slotsAffected.filter(s => s.becameUnfillable).length,
    baselineUnfillable,
    withoutUnfillable,
    capacityBefore: roleDemand > 0 ? { total: baselineRoleServices, demand: roleDemand, ratio: Math.round((baselineRoleServices / roleDemand) * 100) / 100 } : null,
    isBottleneck,
    workerDemandShare,
    workersAlreadyOut: alreadyOutIds.length,
    solverBacked: !solveError,
    solveError,
  };

  // 5. Summary
  const actualServicesAffected = affectedServices.length;
  const totalServicesAffected = actualServicesAffected > 0 ? actualServicesAffected : projectedShiftsAffected;
  const daysBelow = dayDetails.filter(d => d.belowTarget);

  return c.json({
    data: {
      holidayId: hr.id,
      workerName: worker?.name || "Inconnu",
      workerRole: worker?.role || "floor",
      startDate: hr.startDate,
      endDate: hr.endDate,
      totalServicesAffected,
      daysWithImpact: dayDetails,
      daysBelowTarget: daysBelow.length,
      overlappingHolidays: overlapping.map(o => ({
        workerName: o.workerName,
        workerRole: o.workerRole,
        startDate: o.startDate,
        endDate: o.endDate,
        status: o.status,
      })),
      hoursImpact,
      structuralImpact,
    },
  });
});


// POST /holidays/propose — admin proposes or imposes leave to a specific worker.
// - impose=false (default): creates pending row (source=admin_proposal); worker
//   accepts/rejects via /holidays/:id/respond.
// - impose=true: creates the row directly at status=approved. Legally covered
//   by Code du travail L3141-16 (congé imposé — fermeture annuelle / congés
//   payés imposés avec préavis). No worker action possible.
holidayRoutes.post("/propose", requirePermission("LEAVE_APPROVE"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const workerId = typeof body.workerId === "string" ? body.workerId : "";
  const startDate = typeof body.startDate === "string" ? body.startDate : "";
  const endDate = typeof body.endDate === "string" ? body.endDate : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() || null : null;
  const impose = body.impose === true;

  if (!workerId || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return c.json({ error: "invalid_payload" }, 400);
  }
  if (endDate < startDate) return c.json({ error: "invalid_range" }, 400);

  // Verify worker belongs to this restaurant
  const worker = db.select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.id, workerId), eq(users.active, true)))
    .get();
  if (!worker || !userHasActiveRestaurantMembership(workerId, restaurant.restaurantId, ["kitchen", "floor"])) {
    return c.json({ error: "worker_not_found" }, 404);
  }

  if (findOverlappingHoliday(restaurant.restaurantId, workerId, startDate, endDate)) {
    return c.json({ error: "Une demande de congé existe déjà pour ces dates" }, 409);
  }

  const nowIso = new Date().toISOString();
  const [created] = db.insert(holidayRequests).values({
    workerId,
    restaurantId: restaurant.restaurantId,
    startDate,
    endDate,
    reason,
    status: impose ? "approved" : "pending",
    source: "admin_proposal",
    ...(impose ? { reviewedBy: user.id, reviewedAt: nowIso } : {}),
  }).returning().all();

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "holiday_requests",
    rowId: created.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: impose
      ? `Congé imposé à ${worker.name} (${startDate} → ${endDate}) — L3141-16`
      : `Proposition de congé à ${worker.name} (${startDate} → ${endDate})`,
  });

  // Push notification (WhatsApp + in-app) — fire-and-forget
  if (impose) {
    notifyHolidayImposed(workerId, startDate, endDate, "Code du travail art. L3141-16", restaurant.restaurantId).catch(console.error);
  } else {
    notifyHolidayProposal(workerId, startDate, endDate, restaurant.restaurantId).catch(console.error);
  }

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: created }, 201);
});

// PATCH /holidays/:id/respond — worker accepts/rejects an admin_proposal.
// Flips status to approved or rejected. Reviewer is the worker themselves.
holidayRoutes.patch("/:id/respond", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json();
  const action = body.action;
  if (action !== "accept" && action !== "reject") {
    return c.json({ error: "invalid_action" }, 400);
  }

  const existing = db.select().from(holidayRequests)
    .where(and(
      eq(holidayRequests.id, id),
      eq(holidayRequests.restaurantId, restaurant.restaurantId),
      eq(holidayRequests.workerId, user.id),
      eq(holidayRequests.source, "admin_proposal"),
      eq(holidayRequests.status, "pending"),
    ))
    .get();
  if (!existing) return c.json({ error: "not_found_or_not_pending" }, 404);

  const [updated] = db.update(holidayRequests)
    .set({
      status: action === "accept" ? "approved" : "rejected",
      reviewedBy: user.id,
      reviewedAt: new Date().toISOString(),
    })
    .where(eq(holidayRequests.id, id))
    .returning()
    .all();

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "holiday_requests",
    rowId: id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: `Proposition de congé ${action === "accept" ? "acceptée" : "refusée"} (${updated.startDate} → ${updated.endDate})`,
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: updated });
});

// PATCH /holidays/:id/review
holidayRoutes.patch("/:id/review", requirePermission("LEAVE_APPROVE"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = reviewHolidaySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  const [updated] = db
    .update(holidayRequests)
    .set({
      status: parsed.data.status,
      reviewedBy: user.id,
      reviewedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(holidayRequests.id, id),
        eq(holidayRequests.restaurantId, restaurant.restaurantId)
      )
    )
    .returning()
    .all();

  if (!updated) {
    return c.json({ error: "Holiday request not found" }, 404);
  }

  const hrWorker = db.select({ name: users.name }).from(users).where(eq(users.id, updated.workerId)).all()[0];
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "holiday_requests",
    rowId: id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: { status: { old: "pending", new: parsed.data.status } },
    summary: `Congé de ${hrWorker?.name ?? "?"} (${updated.startDate} → ${updated.endDate}) ${parsed.data.status === "approved" ? "approuvé" : "refusé"}`,
  });

  // Notify worker of review result
  notifyHolidayReview(
    updated.workerId,
    updated.startDate,
    updated.endDate,
    parsed.data.status === "approved",
    restaurant.restaurantId,
  ).catch(console.error);

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: updated });
});
