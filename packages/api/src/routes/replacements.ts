import { Hono } from "hono";
import { type AppEnv, type AuthUser } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { db } from "../db/connection.js";
import { replacementRequests, services, users, documents } from "../db/schema.js";
import { eq, and, or, inArray, ne } from "drizzle-orm";
import { requireAuth, requireActiveSubscription } from "../middleware/auth.js";
import { can, createReplacementRequestSchema, respondReplacementSchema, flattenZodError } from "@comptoir/shared";
import {
  adminRecipientsForRestaurant,
  notifyReplacementProposal,
  notifyReplacementResponse,
  notifyAdminReplacementCandidates,
} from "../services/notifications.js";
import { logAudit } from "../db/audit.js";
import { rankReplacementCandidates } from "../services/replacement-candidates.js";
import { replacementReplyExpiresAt } from "../services/replacement-deadline.js";
import { ReplacementReviewError, reviewReplacementRequest } from "../services/replacement-review.js";
import { userCanBeScheduledInRestaurant } from "../services/restaurant-context.js";
import { generatePlan, type ForbiddenSolverAssignment } from "./autostaffing.js";
import {
  InvalidUploadError,
  StorageInactiveError,
  presignDocumentUpload,
  commitUploadedObject,
  deleteStoredObject,
} from "../services/document-uploads.js";
import { z } from "zod";

export const replacementRoutes = new Hono<AppEnv>();

replacementRoutes.use("*", requireAuth);
replacementRoutes.use("*", requireActiveSubscription);

function canViewMedicalFor(user: Pick<AuthUser, "id" | "role" | "permissions">, requesterId: string): boolean {
  return user.id === requesterId || can(user, "MEDICAL_DOC_VIEW");
}

export function canFindReplacementCandidatesForService(user: Pick<AuthUser, "id" | "role" | "permissions">, serviceWorkerId: string): boolean {
  return user.id === serviceWorkerId || can(user, "PLANNING_EDIT") || can(user, "REPLACEMENT_APPROVE");
}

async function rankReplacementCandidatesWithCpsat(input: {
  restaurantId: string;
  date: string;
  startTime: string;
  endTime: string;
  role: "kitchen" | "floor";
  zone?: string;
  excludeWorkerIds?: string[];
  ignoreServiceIds?: string[];
  limit?: number;
}): Promise<Array<{ id: string; name: string; score: number; reasons: string[] }>> {
  const limit = input.limit ?? 3;
  const forbiddenAssignments: ForbiddenSolverAssignment[] = (input.excludeWorkerIds ?? []).map((workerId) => ({
    workerId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    role: input.role,
    zone: input.zone,
  }));
  const seen = new Set(input.excludeWorkerIds ?? []);
  const candidates: Array<{ id: string; name: string; score: number; reasons: string[] }> = [];

  for (let rank = 1; rank <= limit; rank++) {
    const plan = await generatePlan(input.restaurantId, input.date, undefined, {
      maxTier: 1,
      ignoreServiceIds: input.ignoreServiceIds,
      forbiddenAssignments,
    });
    const chosen = plan.services.find((s) =>
      s.date === input.date &&
      s.role === input.role &&
      s.startTime === input.startTime &&
      s.endTime === input.endTime &&
      (!input.zone || s.zone === input.zone) &&
      !seen.has(s.workerId)
    );
    if (!chosen) break;

    seen.add(chosen.workerId);
    forbiddenAssignments.push({
      workerId: chosen.workerId,
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      role: input.role,
      zone: input.zone,
    });

    const reasons = [`CP-SAT rang ${rank}`];
    if (plan.solveTier != null) reasons.push(`tier ${plan.solveTier}`);
    if (typeof plan.solveTimeMs === "number") reasons.push(`${Math.round(plan.solveTimeMs)}ms`);
    candidates.push({ id: chosen.workerId, name: chosen.workerName, score: 100 - (rank - 1) * 10, reasons });
  }

  return candidates;
}

function attachDocCounts<T extends { id: string; requesterId: string; medical: boolean; message: string | null }>(
  user: Pick<AuthUser, "id" | "role" | "permissions">,
  restaurantId: string,
  rows: T[],
): Array<T & { documentCount: number }> {
  const counts = db
    .select({ replacementRequestId: documents.replacementRequestId })
    .from(documents)
    .where(eq(documents.restaurantId, restaurantId))
    .all()
    .reduce((acc, d) => {
      if (d.replacementRequestId) acc[d.replacementRequestId] = (acc[d.replacementRequestId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  return rows.map((r) => {
    if (r.medical && !canViewMedicalFor(user, r.requesterId)) {
      return { ...r, medical: false, message: null, documentCount: 0 };
    }
    return { ...r, documentCount: canViewMedicalFor(user, r.requesterId) ? counts[r.id] || 0 : 0 };
  });
}

// GET /services/replacement/all — admin sees all, workers see only their own
replacementRoutes.get("/all", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);

  const conditions = [eq(replacementRequests.restaurantId, restaurant.restaurantId)];
  if (!can(user, "REPLACEMENT_APPROVE")) {
    conditions.push(or(eq(replacementRequests.requesterId, user.id), eq(replacementRequests.targetId, user.id))!);
  }

  const result = db
    .select()
    .from(replacementRequests)
    .where(and(...conditions))
    .orderBy(replacementRequests.createdAt)
    .all();

  return c.json({ data: attachDocCounts(user, restaurant.restaurantId, result) });
});

// GET /services/replacement/pending — admin sees all, workers see only their own
replacementRoutes.get("/pending", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);

  const conditions = [
    eq(replacementRequests.restaurantId, restaurant.restaurantId),
    or(
      eq(replacementRequests.status, "awaiting_admin_decision"),
      eq(replacementRequests.status, "awaiting_worker_reply"),
    )!,
  ];
  if (!can(user, "REPLACEMENT_APPROVE")) {
    conditions.push(or(eq(replacementRequests.requesterId, user.id), eq(replacementRequests.targetId, user.id))!);
  }

  const result = db
    .select()
    .from(replacementRequests)
    .where(and(...conditions))
    .orderBy(replacementRequests.createdAt)
    .all();

  return c.json({ data: attachDocCounts(user, restaurant.restaurantId, result) });
});

// POST /services/replacement/find
replacementRoutes.post("/find", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const serviceId = typeof body.serviceId === "string" ? body.serviceId : "";

  if (!serviceId) {
    if (!can(user, "PLANNING_EDIT")) return c.json({ error: "Forbidden" }, 403);
    if (typeof body.date !== "string" || typeof body.startTime !== "string" || typeof body.endTime !== "string" || (body.role !== "kitchen" && body.role !== "floor")) {
      return c.json({ error: "serviceId or date/startTime/endTime/role required" }, 400);
    }

    const targetSubRole = typeof body.targetSubRole === "string" && body.targetSubRole.trim()
      ? body.targetSubRole.trim()
      : undefined;
    const busyThatDay = db.select({ workerId: services.workerId })
      .from(services)
      .where(and(
        eq(services.restaurantId, restaurant.restaurantId),
        eq(services.date, body.date),
        ne(services.status, "cancelled"),
      ))
      .all()
      .map((s) => s.workerId);
    let rankingMethod = "cpsat-iterative";
    let ranked: Array<{ id: string; name: string; score: number; reasons: string[] }> = [];
    try {
      ranked = await rankReplacementCandidatesWithCpsat({
        restaurantId: restaurant.restaurantId,
        date: body.date,
        startTime: body.startTime,
        endTime: body.endTime,
        role: body.role,
        zone: typeof body.zone === "string" ? body.zone : undefined,
        excludeWorkerIds: busyThatDay,
        limit: 3,
      });
    } catch (err) {
      console.warn("[replacements] CP-SAT candidate ranking failed; using direct fallback", err);
    }

    if (ranked.length === 0) {
      rankingMethod = "direct-slot-fallback";
      ranked = rankReplacementCandidates({
        restaurantId: restaurant.restaurantId,
        date: body.date,
        startTime: body.startTime,
        endTime: body.endTime,
        role: body.role,
        requiredSubRoles: targetSubRole ? [targetSubRole] : undefined,
        excludeWorkerIds: busyThatDay,
      }).slice(0, 3).map((candidate) => ({
        id: candidate.workerId,
        name: candidate.name,
        score: candidate.score,
        reasons: candidate.reasons.length ? ["créneau compatible", ...candidate.reasons] : ["créneau compatible"],
      }));
    }

    return c.json({
      data: {
        slot: {
          date: body.date,
          startTime: body.startTime,
          endTime: body.endTime,
          role: body.role,
        },
        rankingMethod,
        candidates: ranked,
      },
    });
  }

  const [service] = db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.restaurantId, restaurant.restaurantId)))
    .limit(1)
    .all();

  if (!service) {
    return c.json({ error: "Service not found" }, 404);
  }
  if (!canFindReplacementCandidatesForService(user, service.workerId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  let rankingMethod = "cpsat-iterative";
  let ranked: Array<{ id: string; name: string; score: number; reasons: string[] }> = [];
  try {
    ranked = await rankReplacementCandidatesWithCpsat({
      restaurantId: restaurant.restaurantId,
      date: service.date,
      startTime: service.startTime,
      endTime: service.endTime,
      role: service.role,
      excludeWorkerIds: [service.workerId],
      ignoreServiceIds: [service.id],
      limit: 3,
    });
  } catch (err) {
    console.warn("[replacements] CP-SAT candidate ranking failed; using direct fallback", err);
  }
  if (ranked.length === 0) {
    rankingMethod = "direct-slot-fallback";
    ranked = rankReplacementCandidates({
      restaurantId: restaurant.restaurantId,
      date: service.date,
      startTime: service.startTime,
      endTime: service.endTime,
      role: service.role,
      excludeWorkerIds: [service.workerId],
    }).slice(0, 3).map((candidate) => ({
      id: candidate.workerId,
      name: candidate.name,
      score: candidate.score,
      reasons: candidate.reasons.length ? ["créneau compatible", ...candidate.reasons] : ["créneau compatible"],
    }));
  }

  return c.json({
    data: {
      service: {
        id: service.id,
        date: service.date,
        startTime: service.startTime,
        endTime: service.endTime,
        role: service.role,
      },
      rankingMethod,
      candidates: ranked,
    },
  });
});

// POST /services/replacement/request
replacementRoutes.post("/request", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const parsed = createReplacementRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  // Verify requester service belongs to this restaurant
  const [reqService] = db.select().from(services)
    .where(and(eq(services.id, parsed.data.requesterServiceId), eq(services.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!reqService) {
    return c.json({ error: "Service non trouvé" }, 404);
  }

  // Verify target worker can work the requester service role (only when one was pre-picked).
  if (parsed.data.targetId) {
    const [target] = db.select({ id: users.id }).from(users)
      .where(and(eq(users.id, parsed.data.targetId), eq(users.active, true)))
      .limit(1).all();
    if (!target) {
      return c.json({ error: "Employé cible non trouvé" }, 404);
    }
  }
  if (reqService.workerId !== user.id && !can(user, "REPLACEMENT_APPROVE")) {
    return c.json({ error: "Vous ne pouvez demander un remplacement que pour vos propres services" }, 403);
  }


  // Block duplicate: reject if an open replacement for this service already exists
  const existingReplacement = db.select({ id: replacementRequests.id })
    .from(replacementRequests)
    .where(and(
      eq(replacementRequests.requesterServiceId, parsed.data.requesterServiceId),
      or(
        eq(replacementRequests.status, "awaiting_admin_decision"),
        eq(replacementRequests.status, "awaiting_worker_reply"),
      )!,
    ))
    .limit(1).all();
  if (existingReplacement.length > 0) {
    return c.json({ error: "Une demande de remplacement est déjà en cours pour ce service" }, 409);
  }

  const isMedical = parsed.data.medical ?? false;
  const docs = parsed.data.documents;
  if ((isMedical || docs?.length) && !canViewMedicalFor(user, reqService.workerId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = replacementReplyExpiresAt(nowDate);

  // Run the ranker so direct picks and admin-decision rows share the same live
  // eligibility checks: membership/share status, conflicts, and compliance.
  const ranked = rankReplacementCandidates({
    restaurantId: restaurant.restaurantId,
    date: reqService.date,
    startTime: reqService.startTime,
    endTime: reqService.endTime,
    role: reqService.role,
    excludeWorkerIds: [reqService.workerId],
  });
  if (parsed.data.targetId) {
    const targetIsSchedulable = userCanBeScheduledInRestaurant(
      parsed.data.targetId,
      restaurant.restaurantId,
      [reqService.role as "kitchen" | "floor"],
    );
    const targetIsLiveEligible = ranked.some((candidate) => candidate.workerId === parsed.data.targetId);
    if (!targetIsSchedulable && !targetIsLiveEligible) {
      return c.json({ error: "Employé cible non trouvé" }, 404);
    }
    if (!targetIsLiveEligible) {
      return c.json({ error: "Candidat non disponible pour cette demande" }, 400);
    }
  }

  const initialStatus = parsed.data.targetId ? "awaiting_worker_reply" : "awaiting_admin_decision";

  // Attach uploaded ITT / arrêt maladie documents to the replacement request.
  // Caller must PUT the file to OVH via the presign endpoint first, then post
  // the returned storageKey here. Base64 ingestion was removed in Phase E.
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

  let request: typeof replacementRequests.$inferSelect;
  try {
    request = db.transaction((tx) => {
      const [created] = tx
        .insert(replacementRequests)
        .values({
          requesterId: reqService.workerId,
          requesterServiceId: parsed.data.requesterServiceId,
          targetId: parsed.data.targetId ?? null,
          restaurantId: restaurant.restaurantId,
          status: initialStatus,
          message: isMedical ? null : parsed.data.message ?? null,
          expiresAt,
          candidateIds: parsed.data.targetId ? null : ranked.map((r) => r.workerId),
          candidateScores: parsed.data.targetId
            ? null
            : Object.fromEntries(ranked.map((r) => [r.workerId, r.score])),
          adminNotifiedAt: now,
          workerNotifiedAt: parsed.data.targetId ? now : null,
          medical: isMedical,
        })
        .returning()
        .all();

      for (const doc of committedDocs) {
        tx.insert(documents).values({
          userId: user.id,
          restaurantId: restaurant.restaurantId,
          replacementRequestId: created.id,
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

  const [requester] = db.select({ name: users.name }).from(users).where(eq(users.id, user.id)).limit(1).all();
  if (parsed.data.targetId && requester) {
    notifyReplacementProposal(parsed.data.targetId, requester.name, reqService.date, restaurant.restaurantId).catch(console.error);
  } else if (requester) {
    // Admin-decision flow: notify the admin with the ranked candidate list.
    const admin = adminRecipientsForRestaurant(restaurant.restaurantId, ["admin"])[0];
    if (admin) {
      notifyAdminReplacementCandidates(
        admin.id,
        requester.name,
        reqService.date,
        reqService.startTime,
        reqService.endTime,
        ranked.map((r) => ({ name: r.name, reasons: r.reasons })),
        restaurant.restaurantId,
      ).catch(console.error);
    }
  }

  const targetUser = parsed.data.targetId
    ? db.select({ name: users.name }).from(users).where(eq(users.id, parsed.data.targetId)).limit(1).all()[0]
    : null;
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "replacement_requests",
    rowId: request.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: targetUser
      ? `Remplacement proposé à ${targetUser.name} pour le ${reqService.date}`
      : `Indisponibilité signalée pour le ${reqService.date} — ${ranked.length} candidat${ranked.length === 1 ? "" : "s"} proposé${ranked.length === 1 ? "" : "s"} au gérant`,
  });

  return c.json({ data: request }, 201);
});

// POST /services/replacement/:id/review — admin picks a candidate, broadcasts, or refuses.
const reviewReplacementSchema = z.object({
  decision: z.enum(["pick", "broadcast", "refuse", "approve_absence"]),
  candidateId: z.string().uuid().nullable().optional(),
});

replacementRoutes.post("/:id/review", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!can(user, "REPLACEMENT_APPROVE")) {
    return c.json({ error: "Seul le gérant peut arbitrer un remplacement." }, 403);
  }

  const body = await c.req.json();
  const parsed = reviewReplacementSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  try {
    const result = await reviewReplacementRequest(user, {
      requestId: id,
      decision: parsed.data.decision,
      candidateId: parsed.data.candidateId,
      source: "dashboard",
    });
    return c.json({ data: result.updated });
  } catch (err) {
    if (err instanceof ReplacementReviewError) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  }
});

// POST /services/replacement/documents/presign — mint an OVH upload URL before POSTing
// either the replacement request itself or the late documents endpoint below.
replacementRoutes.post("/documents/presign", async (c) => {
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

// POST /services/replacement/respond/:id
// POST /services/replacement/:id/documents — late ITT / arrêt maladie upload
const attachDocSchema = z.object({
  documents: z.array(z.object({
    name: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    storageKey: z.string(),
  })).min(1).max(5),
});

replacementRoutes.post("/:id/documents", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = attachDocSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  const [request] = db.select().from(replacementRequests)
    .where(and(eq(replacementRequests.id, id), eq(replacementRequests.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!request) return c.json({ error: "Remplacement introuvable" }, 404);
  if (!canViewMedicalFor(user, request.requesterId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  let inserted = 0;
  for (const doc of parsed.data.documents) {
    let storedSize = doc.size;
    let storageProvider: "ovh" | null = null;
    let confirmedStorageKey: string | null = null;
    try {
      const committed = await commitUploadedObject({
        pendingKey: doc.storageKey,
        restaurantId: restaurant.restaurantId,
        userId: request.requesterId,
        filename: doc.filename,
        expectedMimeType: doc.mimeType,
      });
      storedSize = committed.size;
      storageProvider = "ovh";
      confirmedStorageKey = committed.storageKey;
    } catch (err) {
      if (err instanceof StorageInactiveError) return c.json({ error: "Object storage indisponible" }, 503);
      if (err instanceof InvalidUploadError) return c.json({ error: err.message }, err.status as 400 | 403 | 413);
      throw err;
    }
    db.insert(documents).values({
      userId: request.requesterId,
      restaurantId: restaurant.restaurantId,
      replacementRequestId: request.id,
      name: doc.name,
      type: "medical",
      filename: doc.filename,
      mimeType: doc.mimeType,
      size: storedSize,
      data: "",
      storageProvider,
      storageKey: confirmedStorageKey,
      storageStatus: "ready",
      uploadedBy: user.id,
    }).run();
    inserted++;
  }

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "replacement_requests",
    rowId: id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: `${inserted} document${inserted === 1 ? "" : "s"} médical${inserted === 1 ? "" : "aux"} ajouté${inserted === 1 ? "" : "s"} à la demande de remplacement`,
  });

  return c.json({ data: { inserted } }, 201);
});

replacementRoutes.post("/respond/:id", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = respondReplacementSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  const [request] = db
    .select()
    .from(replacementRequests)
    .where(eq(replacementRequests.id, id))
    .limit(1)
    .all();

  const isOpen = request?.status === "awaiting_admin_decision" || request?.status === "awaiting_worker_reply";
  if (!request || !isOpen) {
    return c.json({ error: "Replacement request not found or already resolved" }, 404);
  }

  // Authorization: only the picked worker, or a broadcast candidate, can accept/refuse here.
  // Admin/manager decisions go through /review so they cannot accidentally assign
  // the service to themselves.
  const rejectedCandidateIds = Array.isArray(request.rejectedCandidateIds) ? request.rejectedCandidateIds : [];
  const isCandidate =
    user.id === request.targetId ||
    (request.targetId === null &&
      request.status === "awaiting_worker_reply" &&
      Array.isArray(request.candidateIds) &&
      request.candidateIds.includes(user.id) &&
      !rejectedCandidateIds.includes(user.id));
  if (!isCandidate) {
    return c.json({ error: "Only the picked candidate can respond to this replacement" }, 403);
  }

  if (request.restaurantId !== restaurant.restaurantId) {
    return c.json({ error: "Replacement request not found" }, 404);
  }

  if (new Date().toISOString() > request.expiresAt) {
    db.update(replacementRequests)
      .set({ status: "expired" })
      .where(eq(replacementRequests.id, id))
      .run();
    return c.json({ error: "Replacement request expired" }, 410);
  }

  const now = new Date().toISOString();

  const [requesterService] = db.select().from(services)
    .where(and(eq(services.id, request.requesterServiceId), eq(services.restaurantId, restaurant.restaurantId)))
    .limit(1)
    .all();
  if (!requesterService) return c.json({ error: "Service non trouvé" }, 404);

  const stillEligible = rankReplacementCandidates({
    restaurantId: restaurant.restaurantId,
    date: requesterService.date,
    startTime: requesterService.startTime,
    endTime: requesterService.endTime,
    role: requesterService.role,
    excludeWorkerIds: [request.requesterId],
  }).some((candidate) => candidate.workerId === user.id);
  if (!stillEligible) {
    return c.json({ error: "Ce remplacement n'est plus disponible pour vous" }, 409);
  }

  const updated = db.transaction((tx) => {
    if (parsed.data.response === "accepted") {
      const acceptorId = user.id;
      tx.update(services)
        .set({ workerId: acceptorId, updatedAt: now })
        .where(and(eq(services.id, request.requesterServiceId), eq(services.restaurantId, restaurant.restaurantId)))
        .run();

      const [result] = tx
        .update(replacementRequests)
        .set({
          status: "accepted",
          respondedAt: now,
          targetId: acceptorId,
        })
        .where(eq(replacementRequests.id, id))
        .returning()
        .all();
      return result;
    }

    const newRejected = rejectedCandidateIds.includes(user.id) ? rejectedCandidateIds : [...rejectedCandidateIds, user.id];
    const [result] = tx
      .update(replacementRequests)
      .set({
        status: request.targetId ? "awaiting_admin_decision" : "awaiting_worker_reply",
        respondedAt: now,
        targetId: request.targetId ? null : request.targetId,
        rejectedCandidateIds: newRejected,
        adminNotifiedAt: request.targetId ? now : request.adminNotifiedAt,
      })
      .where(eq(replacementRequests.id, id))
      .returning()
      .all();
    return result;
  });

  // Notify requester of result (outside transaction — fire-and-forget)
  const responderId = user.id;
  const [responderUser] = db.select({ name: users.name }).from(users).where(eq(users.id, responderId)).limit(1).all();
  if (responderUser && parsed.data.response === "accepted") {
    notifyReplacementResponse(request.requesterId, responderUser.name, true, restaurant.restaurantId).catch(console.error);
  }

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "replacement_requests",
    rowId: id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: { status: { old: request.status, new: parsed.data.response } },
    summary: `Remplacement ${parsed.data.response === "accepted" ? "accepté" : "refusé"} par ${user.name}`,
  });

  return c.json({ data: updated });
});
