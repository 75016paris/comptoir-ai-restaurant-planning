import { and, eq } from "drizzle-orm";
import { can } from "@comptoir/shared";
import type { AuditSource } from "../db/audit.js";
import { logAudit } from "../db/audit.js";
import { db } from "../db/connection.js";
import { replacementRequests, services, users } from "../db/schema.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  messageWithRestaurantContext,
  notify,
  notifyReplacementApprovedWithoutReplacement,
  notifyReplacementBroadcast,
  notifyReplacementCancelled,
  notifyReplacementProposed,
} from "./notifications.js";
import { replacementReplyExpiresAt } from "./replacement-deadline.js";
import { rankReplacementCandidates } from "./replacement-candidates.js";

export type ReviewReplacementDecision = "pick" | "broadcast" | "refuse" | "approve_absence";

export class ReplacementReviewError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ReplacementReviewError";
  }
}

type ReviewReplacementInput = {
  requestId: string;
  decision: ReviewReplacementDecision;
  candidateId?: string | null;
  source?: AuditSource;
  notifyRequesterProgress?: boolean;
};

export type ReviewReplacementResult = {
  updated: typeof replacementRequests.$inferSelect;
  decision: ReviewReplacementDecision;
  requesterId: string;
  requesterName: string | null;
  service: { date: string; startTime: string; endTime: string } | null;
  pickedName?: string | null;
  candidateCount?: number;
};

export async function reviewReplacementRequest(user: AuthUser, input: ReviewReplacementInput): Promise<ReviewReplacementResult> {
  const source = input.source ?? "dashboard";
  if (!can(user, "REPLACEMENT_APPROVE")) {
    throw new ReplacementReviewError(403, "Seul le gérant peut arbitrer un remplacement.");
  }

  const [request] = db.select().from(replacementRequests)
    .where(and(eq(replacementRequests.id, input.requestId), eq(replacementRequests.restaurantId, user.activeRestaurantId)))
    .limit(1).all();
  if (!request) throw new ReplacementReviewError(404, "Remplacement introuvable");
  if (request.status !== "awaiting_admin_decision") {
    throw new ReplacementReviewError(409, "Cette demande n'est plus en attente de décision");
  }

  const [reqService] = db.select().from(services)
    .where(and(eq(services.id, request.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId)))
    .limit(1).all();
  const [requesterUser] = db.select({ name: users.name }).from(users)
    .where(eq(users.id, request.requesterId))
    .limit(1).all();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const replyExpiresAt = replacementReplyExpiresAt(nowDate);
  const serviceSummary = reqService ? { date: reqService.date, startTime: reqService.startTime, endTime: reqService.endTime } : null;

  if (input.decision === "refuse") {
    const [updated] = db.update(replacementRequests).set({
      status: "cancelled",
      respondedAt: now,
    }).where(eq(replacementRequests.id, input.requestId)).returning().all();

    if (reqService) notifyReplacementCancelled(request.requesterId, reqService.date, user.activeRestaurantId).catch(console.error);

    logAudit({
      restaurantId: user.activeRestaurantId,
      tableName: "replacement_requests",
      rowId: input.requestId,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source,
      changes: { status: { old: "awaiting_admin_decision", new: "cancelled" } },
      summary: `Remplacement de ${requesterUser?.name ?? "?"} le ${reqService?.date ?? "?"} refusé par le gérant`,
    });

    return { updated, decision: input.decision, requesterId: request.requesterId, requesterName: requesterUser?.name ?? null, service: serviceSummary };
  }

  if (input.decision === "approve_absence") {
    const [updated] = db.update(replacementRequests).set({
      status: "approved_without_replacement",
      respondedAt: now,
    }).where(eq(replacementRequests.id, input.requestId)).returning().all();

    if (reqService) {
      db.update(services).set({ status: "cancelled", updatedAt: now })
        .where(and(eq(services.id, request.requesterServiceId), eq(services.restaurantId, user.activeRestaurantId))).run();
      notifyReplacementApprovedWithoutReplacement(request.requesterId, reqService.date, user.activeRestaurantId).catch(console.error);
    }

    logAudit({
      restaurantId: user.activeRestaurantId,
      tableName: "replacement_requests",
      rowId: input.requestId,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source,
      changes: {
        status: { old: "awaiting_admin_decision", new: "approved_without_replacement" },
        serviceStatus: { old: reqService?.status ?? null, new: "cancelled" },
      },
      summary: `Absence de ${requesterUser?.name ?? "?"} le ${reqService?.date ?? "?"} acceptée sans remplaçant`,
    });

    return { updated, decision: input.decision, requesterId: request.requesterId, requesterName: requesterUser?.name ?? null, service: serviceSummary };
  }

  const candidateIds = Array.isArray(request.candidateIds) ? request.candidateIds : [];
  const rejected = Array.isArray(request.rejectedCandidateIds) ? request.rejectedCandidateIds : [];
  const liveCandidateIds = reqService
    ? new Set(rankReplacementCandidates({
      restaurantId: user.activeRestaurantId,
      date: reqService.date,
      startTime: reqService.startTime,
      endTime: reqService.endTime,
      role: reqService.role as "kitchen" | "floor",
      excludeWorkerIds: [request.requesterId],
    }).map((candidate) => candidate.workerId))
    : new Set<string>();
  const remaining = candidateIds.filter((cid) => !rejected.includes(cid) && liveCandidateIds.has(cid));

  if (input.decision === "pick") {
    const candidateId = input.candidateId;
    if (!candidateId) throw new ReplacementReviewError(400, "candidateId requis pour decision=pick");
    if (!remaining.includes(candidateId)) {
      throw new ReplacementReviewError(400, "Candidat non disponible pour cette demande");
    }

    const [updated] = db.update(replacementRequests).set({
      targetId: candidateId,
      status: "awaiting_worker_reply",
      workerNotifiedAt: now,
      expiresAt: replyExpiresAt,
    }).where(eq(replacementRequests.id, input.requestId)).returning().all();

    const [pickedUser] = db.select({ name: users.name }).from(users)
      .where(eq(users.id, candidateId))
      .limit(1).all();
    if (pickedUser && requesterUser && reqService) {
      const replacementRole = reqService.role === "kitchen" ? "cuisine" : reqService.role === "floor" ? "salle" : "service";
      notifyReplacementProposed(candidateId, requesterUser.name, reqService.date, reqService.startTime, reqService.endTime, replacementRole, user.activeRestaurantId).catch(console.error);
    }
    if (input.notifyRequesterProgress && pickedUser && reqService) {
      notify({
        recipientId: request.requesterId,
        type: "replacement_request",
        message: messageWithRestaurantContext(
          request.requesterId,
          user.activeRestaurantId,
          `🔄 Le gérant a proposé *${pickedUser.name}* pour ton service du ${reqService.date}. En attente de sa réponse.`,
        ),
      }).catch(console.error);
    }

    logAudit({
      restaurantId: user.activeRestaurantId,
      tableName: "replacement_requests",
      rowId: input.requestId,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source,
      changes: {
        status: { old: "awaiting_admin_decision", new: "awaiting_worker_reply" },
        targetId: { old: null, new: candidateId },
      },
      summary: `Gérant propose ${pickedUser?.name ?? "?"} pour remplacer ${requesterUser?.name ?? "?"} le ${reqService?.date ?? "?"}`,
    });

    return { updated, decision: input.decision, requesterId: request.requesterId, requesterName: requesterUser?.name ?? null, service: serviceSummary, pickedName: pickedUser?.name ?? null };
  }

  if (remaining.length === 0) {
    throw new ReplacementReviewError(400, "Aucun candidat disponible pour broadcaster");
  }

  const [updated] = db.update(replacementRequests).set({
    targetId: null,
    status: "awaiting_worker_reply",
    workerNotifiedAt: now,
    expiresAt: replyExpiresAt,
    candidateIds: remaining,
  }).where(eq(replacementRequests.id, input.requestId)).returning().all();

  if (requesterUser && reqService) {
    const replacementRole = reqService.role === "kitchen" ? "cuisine" : reqService.role === "floor" ? "salle" : "service";
    notifyReplacementBroadcast(remaining, requesterUser.name, reqService.date, reqService.startTime, reqService.endTime, replacementRole, user.activeRestaurantId).catch(console.error);
  }
  if (input.notifyRequesterProgress && reqService) {
    notify({
      recipientId: request.requesterId,
      type: "replacement_request",
      message: messageWithRestaurantContext(
        request.requesterId,
        user.activeRestaurantId,
        `🔄 Le gérant cherche un remplaçant pour ton service du ${reqService.date}. ${remaining.length} collègue${remaining.length > 1 ? "s" : ""} ont été contacté${remaining.length > 1 ? "s" : ""}.`,
      ),
    }).catch(console.error);
  }

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "replacement_requests",
    rowId: input.requestId,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source,
    changes: {
      status: { old: "awaiting_admin_decision", new: "awaiting_worker_reply" },
      candidateIds: { old: candidateIds, new: remaining },
    },
    summary: `Gérant broadcaste le service de ${requesterUser?.name ?? "?"} le ${reqService?.date ?? "?"} à ${remaining.length} candidats`,
  });

  return { updated, decision: input.decision, requesterId: request.requesterId, requesterName: requesterUser?.name ?? null, service: serviceSummary, candidateCount: remaining.length };
}
