import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "../db/connection.js";
import { replacementRequests, services, users } from "../db/schema.js";
import type { AuthUser } from "../middleware/auth.js";
import { logAudit, type AuditSource } from "../db/audit.js";
import { adminRecipientsForRestaurant, messageWithRestaurantContext, notify, notifyAdminReplacementCandidates, notifyReplacementResponse } from "./notifications.js";
import { rankReplacementCandidates } from "./replacement-candidates.js";
import { userCanBeScheduledInRestaurant } from "./restaurant-context.js";

export class WorkerReplacementError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 410, message: string) {
    super(message);
    this.name = "WorkerReplacementError";
  }
}

function dayName(dateStr: string): string {
  return ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"][new Date(`${dateStr}T12:00:00`).getDay()];
}

function looksMedicalReason(reason: string | null | undefined): boolean {
  return /m[eé]dical|maladie|malade|arr[eê]t.?maladie|itt|sick/i.test(reason || "");
}

function canWorkerStillTakeReplacement(user: AuthUser, replacement: typeof replacementRequests.$inferSelect): boolean {
  const [service] = db.select({ date: services.date, startTime: services.startTime, endTime: services.endTime, role: services.role })
    .from(services)
    .where(and(eq(services.id, replacement.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId)))
    .limit(1)
    .all();
  if (!service) return false;

  return rankReplacementCandidates({
    restaurantId: user.activeRestaurantId,
    date: service.date,
    startTime: service.startTime,
    endTime: service.endTime,
    role: service.role as "kitchen" | "floor",
    excludeWorkerIds: [replacement.requesterId],
  }).some((candidate) => candidate.workerId === user.id);
}

function canWorkerAnswerBroadcast(replacement: typeof replacementRequests.$inferSelect, workerId: string): boolean {
  const candidateIds = Array.isArray(replacement.candidateIds) ? replacement.candidateIds : [];
  const rejectedCandidateIds = Array.isArray(replacement.rejectedCandidateIds) ? replacement.rejectedCandidateIds : [];
  return candidateIds.includes(workerId) && !rejectedCandidateIds.includes(workerId);
}

function isReplacementExpired(replacement: typeof replacementRequests.$inferSelect, nowIso = new Date().toISOString()): boolean {
  return nowIso > replacement.expiresAt;
}

export function listWorkerPendingReplacements(user: AuthUser) {
  const nowIso = new Date().toISOString();
  const openStatuses = or(
    eq(replacementRequests.status, "awaiting_admin_decision"),
    eq(replacementRequests.status, "awaiting_worker_reply"),
  )!;

  const sent = db.select().from(replacementRequests)
    .where(and(eq(replacementRequests.requesterId, user.id), eq(replacementRequests.restaurantId, user.activeRestaurantId), openStatuses))
    .all();
  const receivedDirect = db.select().from(replacementRequests)
    .where(and(eq(replacementRequests.targetId, user.id), eq(replacementRequests.restaurantId, user.activeRestaurantId), eq(replacementRequests.status, "awaiting_worker_reply")))
    .all()
    .filter((r) => !isReplacementExpired(r, nowIso))
    .filter((r) => canWorkerStillTakeReplacement(user, r));
  const broadcastOpen = db.select().from(replacementRequests)
    .where(and(isNull(replacementRequests.targetId), eq(replacementRequests.restaurantId, user.activeRestaurantId), eq(replacementRequests.status, "awaiting_worker_reply")))
    .all()
    .filter((r) => !isReplacementExpired(r, nowIso))
    .filter((r) => canWorkerAnswerBroadcast(r, user.id))
    .filter((r) => canWorkerStillTakeReplacement(user, r));

  const sentRows = sent.map((r) => {
    const [service] = db.select({ date: services.date, startTime: services.startTime, endTime: services.endTime })
      .from(services).where(and(eq(services.id, r.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId))).limit(1).all();
    return { id: r.id, service, phase: r.status === "awaiting_admin_decision" ? "en attente du gérant" : "proposé à un collègue" };
  });
  const receivedRows = [...receivedDirect, ...broadcastOpen].map((r) => {
    const [requester] = db.select({ name: users.name }).from(users).where(eq(users.id, r.requesterId)).limit(1).all();
    const [service] = db.select({ date: services.date, startTime: services.startTime, endTime: services.endTime })
      .from(services).where(and(eq(services.id, r.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId))).limit(1).all();
    return { id: r.id, requesterName: requester?.name ?? null, service };
  });
  return { sent: sentRows, received: receivedRows };
}

export async function reportUnavailable(user: AuthUser, input: {
  requesterServiceId: string;
  date: string;
  startTime: string;
  endTime: string;
  role: "kitchen" | "floor";
  reason?: string | null;
  isCoupure?: boolean;
}, options: { source?: AuditSource } = {}) {
  const [service] = db.select({
    id: services.id,
    workerId: services.workerId,
    restaurantId: services.restaurantId,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
  })
    .from(services)
    .where(and(eq(services.id, input.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId)))
    .limit(1).all();
  if (!service || service.workerId !== user.id) throw new WorkerReplacementError(404, "Service introuvable");

  const existing = db.select({ id: replacementRequests.id })
    .from(replacementRequests)
    .where(and(
      eq(replacementRequests.requesterServiceId, input.requesterServiceId),
      or(eq(replacementRequests.status, "awaiting_admin_decision"), eq(replacementRequests.status, "awaiting_worker_reply"))!,
    ))
    .limit(1).all();
  if (existing.length > 0) throw new WorkerReplacementError(409, "Une demande de remplacement est déjà en cours pour ce service.");

  const candidates = rankReplacementCandidates({
    restaurantId: user.activeRestaurantId,
    date: service.date,
    startTime: service.startTime,
    endTime: service.endTime,
    role: service.role as "kitchen" | "floor",
    excludeWorkerIds: [user.id],
  });
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
  const isMedical = looksMedicalReason(reason);
  const [request] = db.insert(replacementRequests).values({
    requesterId: user.id,
    requesterServiceId: input.requesterServiceId,
    targetId: null,
    restaurantId: user.activeRestaurantId,
    status: "awaiting_admin_decision",
    message: isMedical ? null : reason,
    expiresAt,
    candidateIds: candidates.map((c) => c.workerId),
    candidateScores: Object.fromEntries(candidates.map((c) => [c.workerId, c.score])),
    adminNotifiedAt: now,
    medical: isMedical,
  }).returning().all();

  const [admin] = adminRecipientsForRestaurant(user.activeRestaurantId, ["admin"]);
  if (admin) {
    notifyAdminReplacementCandidates(
      admin.id,
      user.name,
      service.date,
      service.startTime,
      service.endTime,
      candidates.map((c) => ({ name: c.name, reasons: c.reasons })),
      user.activeRestaurantId,
    ).catch(console.error);
  }

  const timeLabel = input.isCoupure ? `coupure ${service.startTime}-${service.endTime}` : `${service.startTime}-${service.endTime}`;
  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "replacement_requests",
    rowId: request.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    summary: `${user.name} signale indisponibilité ${service.date} (${timeLabel}) — ${candidates.length} candidat${candidates.length === 1 ? "" : "s"} proposé${candidates.length === 1 ? "" : "s"} au gérant`,
  });

  return { replacementId: request.id, candidateCount: candidates.length, timeLabel };
}

export async function respondToReplacement(user: AuthUser, decision: "accepted" | "rejected", options: { source?: AuditSource } = {}) {
  const now = new Date().toISOString();
  const directRows = db.select().from(replacementRequests)
    .where(and(eq(replacementRequests.targetId, user.id), eq(replacementRequests.restaurantId, user.activeRestaurantId), eq(replacementRequests.status, "awaiting_worker_reply")))
    .orderBy(desc(replacementRequests.createdAt))
    .all();
  const liveDirectRow = directRows.find((row) => !isReplacementExpired(row, now) && canWorkerStillTakeReplacement(user, row)) ?? null;
  const staleDirectRow = directRows[0] ?? null;
  const broadcastRows = !liveDirectRow
    ? db.select().from(replacementRequests)
      .where(and(isNull(replacementRequests.targetId), eq(replacementRequests.restaurantId, user.activeRestaurantId), eq(replacementRequests.status, "awaiting_worker_reply")))
      .orderBy(desc(replacementRequests.createdAt))
      .all()
    : [];
  const liveBroadcastRow = broadcastRows.find((row) => !isReplacementExpired(row, now) && canWorkerAnswerBroadcast(row, user.id) && canWorkerStillTakeReplacement(user, row)) ?? null;
  const staleBroadcastRow = broadcastRows.find((row) => canWorkerAnswerBroadcast(row, user.id)) ?? null;

  const replacement = liveDirectRow ?? liveBroadcastRow ?? staleDirectRow ?? staleBroadcastRow;
  const directRow = replacement?.targetId === user.id ? replacement : null;
  if (!replacement) throw new WorkerReplacementError(404, "Aucune proposition de remplacement en attente pour toi.");
  if (isReplacementExpired(replacement, now)) {
    db.update(replacementRequests).set({ status: "expired" }).where(eq(replacementRequests.id, replacement.id)).run();
    throw new WorkerReplacementError(410, "Cette proposition de remplacement a expiré.");
  }

  const [requester] = db.select({ name: users.name }).from(users).where(eq(users.id, replacement.requesterId)).limit(1).all();
  const [service] = db.select({ date: services.date, startTime: services.startTime, endTime: services.endTime, role: services.role })
    .from(services).where(and(eq(services.id, replacement.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId))).limit(1).all();
  if (!service) throw new WorkerReplacementError(404, "Service introuvable.");

  if (!canWorkerStillTakeReplacement(user, replacement)) {
    throw new WorkerReplacementError(409, "Ce remplacement n'est plus disponible pour toi.");
  }

  if (decision === "rejected") {
    const rejected = Array.isArray(replacement.rejectedCandidateIds) ? replacement.rejectedCandidateIds : [];
    const newRejected = rejected.includes(user.id) ? rejected : [...rejected, user.id];
    if (directRow) {
      db.update(replacementRequests).set({
        status: "awaiting_admin_decision",
        targetId: null,
        rejectedCandidateIds: newRejected,
        adminNotifiedAt: now,
      }).where(eq(replacementRequests.id, replacement.id)).run();
      const [admin] = adminRecipientsForRestaurant(user.activeRestaurantId, ["admin"]);
      if (admin) {
        const message = `⚠️ *${user.name}* refuse de remplacer *${requester?.name ?? "?"}* le ${service.date}. Réponds avec un nom ou *tous* pour broadcaster.`;
        notify({
          recipientId: admin.id,
          type: "replacement_request",
          message: messageWithRestaurantContext(admin.id, user.activeRestaurantId, message),
        }).catch(console.error);
      }
    } else {
      db.update(replacementRequests).set({ rejectedCandidateIds: newRejected }).where(eq(replacementRequests.id, replacement.id)).run();
    }
    logAudit({
      restaurantId: user.activeRestaurantId,
      tableName: "replacement_requests",
      rowId: replacement.id,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source: options.source ?? "dashboard",
      changes: { status: { old: "awaiting_worker_reply", new: directRow ? "awaiting_admin_decision" : "awaiting_worker_reply" } },
      summary: `Remplacement refusé par ${user.name} pour le service de ${requester?.name ?? "?"}`,
    });
    return { decision, requesterName: requester?.name ?? null, service };
  }

  db.transaction((tx) => {
    tx.update(replacementRequests).set({ targetId: user.id, status: "accepted", respondedAt: now })
      .where(eq(replacementRequests.id, replacement.id)).run();
    tx.update(services).set({ workerId: user.id, updatedAt: now })
      .where(and(eq(services.id, replacement.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId))).run();
    const siblings = tx.select({ id: services.id, role: services.role }).from(services)
      .where(and(eq(services.workerId, replacement.requesterId), eq(services.restaurantId, user.activeRestaurantId), eq(services.date, service.date), ne(services.id, replacement.requesterServiceId), ne(services.status, "cancelled"))).all();
    for (const sib of siblings) {
      if (!userCanBeScheduledInRestaurant(user.id, user.activeRestaurantId, [sib.role as "kitchen" | "floor"])) continue;
      tx.update(services).set({ workerId: user.id, updatedAt: now }).where(eq(services.id, sib.id)).run();
    }
  });

  notifyReplacementResponse(replacement.requesterId, user.name, true, user.activeRestaurantId).catch(console.error);
  const [admin] = adminRecipientsForRestaurant(user.activeRestaurantId, ["admin"]);
  if (admin) {
    const message = `✅ *${user.name}* prend le service de *${requester?.name || "?"}* le *${dayName(service.date)} ${service.date}*.`;
    notify({
      recipientId: admin.id,
      type: "replacement_accepted",
      message: messageWithRestaurantContext(admin.id, user.activeRestaurantId, message),
    }).catch(console.error);
  }

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "replacement_requests",
    rowId: replacement.id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    changes: { status: { old: "awaiting_worker_reply", new: "accepted" }, targetId: { old: replacement.targetId, new: user.id } },
    summary: `Remplacement accepté: service ${service.date} (${service.startTime}-${service.endTime}) de ${requester?.name ?? "?"} pris par ${user.name}`,
  });
  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "services",
    rowId: replacement.requesterServiceId,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    changes: { workerId: { old: replacement.requesterId, new: user.id } },
    summary: `Service ${service.date} (${service.startTime}-${service.endTime}) transféré de ${requester?.name ?? "?"} à ${user.name}`,
  });

  return { decision, requesterName: requester?.name ?? null, service };
}
