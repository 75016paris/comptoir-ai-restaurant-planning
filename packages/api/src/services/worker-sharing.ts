import { and, desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db/connection.js";
import type { AppDatabase } from "../db/connection.js";
import {
  ownerMemberships,
  restaurantMemberships,
  restaurants,
  users,
  workerRestaurantProfiles,
  workerShareAuthorizations,
} from "../db/schema.js";

type WorkerShareRole = "kitchen" | "floor";

export class WorkerShareAuthorizationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "WorkerShareAuthorizationError";
  }
}

interface CreateWorkerShareAuthorizationInput {
  ownerId: string;
  sourceRestaurantId: string;
  targetRestaurantId: string;
  userId: string;
  role: WorkerShareRole;
  invitedByUserId: string;
  autoAccept?: boolean;
  db?: AppDatabase;
}

interface AcceptWorkerShareAuthorizationInput {
  authorizationId: string;
  userId: string;
  ownerId?: string;
  db?: AppDatabase;
}

interface ListWorkerShareAuthorizationsInput {
  ownerId: string;
  targetRestaurantId?: string;
  userId?: string;
  actionableOnly?: boolean;
  db?: AppDatabase;
}

interface RevokeWorkerShareAuthorizationInput {
  authorizationId: string;
  ownerId: string;
  actorUserId: string;
  db?: AppDatabase;
}

interface DeclineWorkerShareAuthorizationInput {
  authorizationId: string;
  userId: string;
  ownerId?: string;
  db?: AppDatabase;
}

function assertRestaurantsStillBelongToOwner(
  db: AppDatabase,
  ownerId: string,
  sourceRestaurantId: string,
  targetRestaurantId: string,
) {
  const restaurantRows = db
    .select({ id: restaurants.id, ownerId: restaurants.ownerId })
    .from(restaurants)
    .where(inArray(restaurants.id, [sourceRestaurantId, targetRestaurantId]))
    .all();
  const byId = new Map(restaurantRows.map((row) => [row.id, row]));
  const source = byId.get(sourceRestaurantId);
  const target = byId.get(targetRestaurantId);
  if (!source || !target) {
    throw new WorkerShareAuthorizationError("Both restaurants must still exist.", "restaurant_not_found");
  }
  if (!source.ownerId || source.ownerId !== ownerId || target.ownerId !== ownerId) {
    throw new WorkerShareAuthorizationError("Worker sharing is limited to restaurants under the same owner.", "owner_mismatch");
  }
}

function canWorkerStillAnswerShare(
  db: AppDatabase,
  authorization: {
    ownerId: string;
    sourceRestaurantId: string;
    targetRestaurantId: string;
    userId: string;
    role: WorkerShareRole;
    workerActive: boolean | null;
  },
): boolean {
  if (!authorization.workerActive) return false;
  const sourceMembership = db
    .select({ role: restaurantMemberships.role })
    .from(restaurantMemberships)
    .where(and(
      eq(restaurantMemberships.restaurantId, authorization.sourceRestaurantId),
      eq(restaurantMemberships.userId, authorization.userId),
      eq(restaurantMemberships.role, authorization.role),
      eq(restaurantMemberships.active, true),
    ))
    .get();
  if (!sourceMembership) return false;

  const ownerMembership = db
    .select({ role: ownerMemberships.role })
    .from(ownerMemberships)
    .where(and(
      eq(ownerMemberships.ownerId, authorization.ownerId),
      eq(ownerMemberships.userId, authorization.userId),
    ))
    .get();
  if (!ownerMembership) return false;

  const targetMembership = db
    .select({ role: restaurantMemberships.role })
    .from(restaurantMemberships)
    .where(and(
      eq(restaurantMemberships.restaurantId, authorization.targetRestaurantId),
      eq(restaurantMemberships.userId, authorization.userId),
      eq(restaurantMemberships.active, true),
    ))
    .get();
  return !targetMembership;
}

function ensureTargetSchedulingProfile(
  db: AppDatabase,
  authorization: {
    sourceRestaurantId: string;
    targetRestaurantId: string;
    userId: string;
  },
) {
  db.insert(workerRestaurantProfiles)
    .values({
      restaurantId: authorization.targetRestaurantId,
      userId: authorization.userId,
      priority: 1,
      subRoles: "[]",
    })
    .onConflictDoNothing()
    .run();
}

export function createWorkerShareAuthorization(input: CreateWorkerShareAuthorizationInput) {
  const db = input.db ?? defaultDb;
  if (input.sourceRestaurantId === input.targetRestaurantId) {
    throw new WorkerShareAuthorizationError("Source and target restaurants must differ.", "same_restaurant");
  }

  const restaurantRows = db
    .select({ id: restaurants.id, ownerId: restaurants.ownerId })
    .from(restaurants)
    .where(inArray(restaurants.id, [input.sourceRestaurantId, input.targetRestaurantId]))
    .all();
  const byId = new Map(restaurantRows.map((row) => [row.id, row]));
  const source = byId.get(input.sourceRestaurantId);
  const target = byId.get(input.targetRestaurantId);
  if (!source || !target) {
    throw new WorkerShareAuthorizationError("Both restaurants must exist.", "restaurant_not_found");
  }
  if (!source.ownerId || source.ownerId !== input.ownerId || target.ownerId !== input.ownerId) {
    throw new WorkerShareAuthorizationError("Worker sharing is limited to restaurants under the same owner.", "owner_mismatch");
  }

  const inviter = db
    .select({ role: ownerMemberships.role })
    .from(ownerMemberships)
    .where(and(
      eq(ownerMemberships.ownerId, input.ownerId),
      eq(ownerMemberships.userId, input.invitedByUserId),
    ))
    .get();
  if (!inviter || (inviter.role !== "owner_admin" && inviter.role !== "owner_manager")) {
    throw new WorkerShareAuthorizationError("Only owner admins or managers can invite shared workers.", "inviter_not_allowed");
  }

  const sourceMembership = db
    .select({ role: restaurantMemberships.role })
    .from(restaurantMemberships)
    .where(and(
      eq(restaurantMemberships.restaurantId, input.sourceRestaurantId),
      eq(restaurantMemberships.userId, input.userId),
      eq(restaurantMemberships.role, input.role),
      eq(restaurantMemberships.active, true),
    ))
    .get();
  if (!sourceMembership) {
    throw new WorkerShareAuthorizationError("Worker must have an active source-restaurant membership for this role.", "source_membership_required");
  }
  const sourceUser = db
    .select({ active: users.active, multiRestaurantWilling: users.multiRestaurantWilling })
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!sourceUser?.active) {
    throw new WorkerShareAuthorizationError("Worker must be active before being shared.", "source_membership_required");
  }
  if (!sourceUser.multiRestaurantWilling) {
    throw new WorkerShareAuthorizationError("Worker has not authorized cross-restaurant scheduling.", "worker_opt_in_required");
  }
  const sourceOwnerMembership = db
    .select({ role: ownerMemberships.role })
    .from(ownerMemberships)
    .where(and(
      eq(ownerMemberships.ownerId, input.ownerId),
      eq(ownerMemberships.userId, input.userId),
    ))
    .get();
  if (!sourceOwnerMembership) {
    throw new WorkerShareAuthorizationError("Worker must belong to the owner account before being shared.", "source_membership_required");
  }

  const targetMembership = db
    .select({ role: restaurantMemberships.role })
    .from(restaurantMemberships)
    .where(and(
      eq(restaurantMemberships.restaurantId, input.targetRestaurantId),
      eq(restaurantMemberships.userId, input.userId),
      eq(restaurantMemberships.active, true),
    ))
    .get();
  if (targetMembership) {
    throw new WorkerShareAuthorizationError("Worker is already an active member of the target restaurant.", "target_membership_exists");
  }

  const existing = db
    .select({
      id: workerShareAuthorizations.id,
      ownerId: workerShareAuthorizations.ownerId,
      sourceRestaurantId: workerShareAuthorizations.sourceRestaurantId,
      targetRestaurantId: workerShareAuthorizations.targetRestaurantId,
      userId: workerShareAuthorizations.userId,
      role: workerShareAuthorizations.role,
      status: workerShareAuthorizations.status,
      workerActive: users.active,
    })
    .from(workerShareAuthorizations)
    .innerJoin(users, eq(users.id, workerShareAuthorizations.userId))
    .where(and(
      eq(workerShareAuthorizations.ownerId, input.ownerId),
      eq(workerShareAuthorizations.targetRestaurantId, input.targetRestaurantId),
      eq(workerShareAuthorizations.userId, input.userId),
      eq(workerShareAuthorizations.role, input.role),
    ))
    .get();
  const nextStatus = input.autoAccept ? "accepted" : "pending";
  const nextWorkerConsentedAt = input.autoAccept ? new Date().toISOString() : null;

  if (existing && existing.status !== "revoked" && canWorkerStillAnswerShare(db, existing)) {
    const now = new Date().toISOString();
    if (existing.status !== nextStatus || existing.sourceRestaurantId !== input.sourceRestaurantId) {
      db.update(workerShareAuthorizations)
        .set({
          sourceRestaurantId: input.sourceRestaurantId,
          status: nextStatus,
          invitedByUserId: input.invitedByUserId,
          workerConsentedAt: input.autoAccept ? now : null,
          revokedAt: null,
          updatedAt: now,
        })
        .where(eq(workerShareAuthorizations.id, existing.id))
        .run();
    }
    ensureTargetSchedulingProfile(db, {
      sourceRestaurantId: input.sourceRestaurantId,
      targetRestaurantId: input.targetRestaurantId,
      userId: input.userId,
    });
    return db.select().from(workerShareAuthorizations).where(eq(workerShareAuthorizations.id, existing.id)).get()!;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (existing) {
    db.update(workerShareAuthorizations)
      .set({
        ownerId: input.ownerId,
        sourceRestaurantId: input.sourceRestaurantId,
        targetRestaurantId: input.targetRestaurantId,
        status: nextStatus,
        invitedByUserId: input.invitedByUserId,
        workerConsentedAt: input.autoAccept ? now : null,
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(workerShareAuthorizations.id, existing.id))
      .run();
    ensureTargetSchedulingProfile(db, {
      sourceRestaurantId: input.sourceRestaurantId,
      targetRestaurantId: input.targetRestaurantId,
      userId: input.userId,
    });
    return db.select().from(workerShareAuthorizations).where(eq(workerShareAuthorizations.id, existing.id)).get()!;
  }

  db.insert(workerShareAuthorizations).values({
    id,
    ownerId: input.ownerId,
    sourceRestaurantId: input.sourceRestaurantId,
    targetRestaurantId: input.targetRestaurantId,
    userId: input.userId,
    role: input.role,
    status: nextStatus,
    invitedByUserId: input.invitedByUserId,
    workerConsentedAt: nextWorkerConsentedAt,
    createdAt: now,
    updatedAt: now,
  }).run();
  ensureTargetSchedulingProfile(db, {
    sourceRestaurantId: input.sourceRestaurantId,
    targetRestaurantId: input.targetRestaurantId,
    userId: input.userId,
  });
  return db.select().from(workerShareAuthorizations).where(eq(workerShareAuthorizations.id, id)).get()!;
}

export function acceptWorkerShareAuthorization(input: AcceptWorkerShareAuthorizationInput) {
  const db = input.db ?? defaultDb;
  const authorization = db
    .select()
    .from(workerShareAuthorizations)
    .where(eq(workerShareAuthorizations.id, input.authorizationId))
    .get();
  if (!authorization || authorization.userId !== input.userId || authorization.status !== "pending") {
    throw new WorkerShareAuthorizationError("Pending worker share authorization not found for this worker.", "authorization_not_pending");
  }
  if (input.ownerId && authorization.ownerId !== input.ownerId) {
    throw new WorkerShareAuthorizationError("Worker share authorization belongs to a different owner context.", "owner_mismatch");
  }

  assertRestaurantsStillBelongToOwner(
    db,
    authorization.ownerId,
    authorization.sourceRestaurantId,
    authorization.targetRestaurantId,
  );

  const sourceMembership = db
    .select({ role: restaurantMemberships.role })
    .from(restaurantMemberships)
    .where(and(
      eq(restaurantMemberships.restaurantId, authorization.sourceRestaurantId),
      eq(restaurantMemberships.userId, authorization.userId),
      eq(restaurantMemberships.role, authorization.role),
      eq(restaurantMemberships.active, true),
    ))
    .get();
  if (!sourceMembership) {
    throw new WorkerShareAuthorizationError("Worker no longer has an active source-restaurant membership for this role.", "source_membership_required");
  }
  const sourceUser = db
    .select({ active: users.active })
    .from(users)
    .where(eq(users.id, authorization.userId))
    .get();
  if (!sourceUser?.active) {
    throw new WorkerShareAuthorizationError("Worker is no longer active.", "source_membership_required");
  }
  const sourceOwnerMembership = db
    .select({ role: ownerMemberships.role })
    .from(ownerMemberships)
    .where(and(
      eq(ownerMemberships.ownerId, authorization.ownerId),
      eq(ownerMemberships.userId, authorization.userId),
    ))
    .get();
  if (!sourceOwnerMembership) {
    throw new WorkerShareAuthorizationError("Worker no longer belongs to the owner account.", "source_membership_required");
  }

  const targetMembership = db
    .select({ role: restaurantMemberships.role })
    .from(restaurantMemberships)
    .where(and(
      eq(restaurantMemberships.restaurantId, authorization.targetRestaurantId),
      eq(restaurantMemberships.userId, authorization.userId),
      eq(restaurantMemberships.active, true),
    ))
    .get();
  if (targetMembership) {
    throw new WorkerShareAuthorizationError("Worker is already an active member of the target restaurant.", "target_membership_exists");
  }

  const now = new Date().toISOString();
  db.update(workerShareAuthorizations)
    .set({ status: "accepted", workerConsentedAt: now, revokedAt: null, updatedAt: now })
    .where(eq(workerShareAuthorizations.id, input.authorizationId))
    .run();
  ensureTargetSchedulingProfile(db, authorization);

  return db.select().from(workerShareAuthorizations).where(eq(workerShareAuthorizations.id, input.authorizationId)).get()!;
}

export function listWorkerShareAuthorizations(input: ListWorkerShareAuthorizationsInput) {
  const db = input.db ?? defaultDb;
  const filters = [eq(workerShareAuthorizations.ownerId, input.ownerId)];
  if (input.targetRestaurantId) filters.push(eq(workerShareAuthorizations.targetRestaurantId, input.targetRestaurantId));
  if (input.userId) filters.push(eq(workerShareAuthorizations.userId, input.userId));

  const rows = db
    .select({
      id: workerShareAuthorizations.id,
      ownerId: workerShareAuthorizations.ownerId,
      sourceRestaurantId: workerShareAuthorizations.sourceRestaurantId,
      sourceRestaurantName: restaurants.name,
      sourceRestaurantOwnerId: restaurants.ownerId,
      targetRestaurantId: workerShareAuthorizations.targetRestaurantId,
      userId: workerShareAuthorizations.userId,
      workerName: users.name,
      workerActive: users.active,
      role: workerShareAuthorizations.role,
      status: workerShareAuthorizations.status,
      invitedByUserId: workerShareAuthorizations.invitedByUserId,
      workerConsentedAt: workerShareAuthorizations.workerConsentedAt,
      revokedAt: workerShareAuthorizations.revokedAt,
      createdAt: workerShareAuthorizations.createdAt,
      updatedAt: workerShareAuthorizations.updatedAt,
    })
    .from(workerShareAuthorizations)
    .innerJoin(users, eq(workerShareAuthorizations.userId, users.id))
    .innerJoin(restaurants, eq(workerShareAuthorizations.sourceRestaurantId, restaurants.id))
    .where(and(...filters))
    .orderBy(desc(workerShareAuthorizations.updatedAt), desc(workerShareAuthorizations.createdAt), desc(workerShareAuthorizations.id))
    .all();
  const targetIds = [...new Set(rows.map((row) => row.targetRestaurantId))];
  const targetNames = targetIds.length > 0
    ? new Map(db
      .select({ id: restaurants.id, name: restaurants.name, ownerId: restaurants.ownerId })
      .from(restaurants)
      .where(inArray(restaurants.id, targetIds))
      .all()
      .map((row) => [row.id, row]))
    : new Map<string, { id: string; name: string; ownerId: string | null }>();
  return rows
    .filter((row) => row.sourceRestaurantOwnerId === row.ownerId)
    .filter((row) => targetNames.get(row.targetRestaurantId)?.ownerId === row.ownerId)
    .filter((row) => row.status === "revoked" || canWorkerStillAnswerShare(db, row))
    .filter((row) => !input.actionableOnly || row.status === "pending")
    .map(({ sourceRestaurantOwnerId: _sourceRestaurantOwnerId, workerActive: _workerActive, ...row }) => ({
      ...row,
      targetRestaurantName: targetNames.get(row.targetRestaurantId)?.name ?? row.targetRestaurantId,
    }));
}

export function revokeWorkerShareAuthorization(input: RevokeWorkerShareAuthorizationInput) {
  const db = input.db ?? defaultDb;
  const actor = db
    .select({ role: ownerMemberships.role })
    .from(ownerMemberships)
    .where(and(
      eq(ownerMemberships.ownerId, input.ownerId),
      eq(ownerMemberships.userId, input.actorUserId),
    ))
    .get();
  if (!actor || (actor.role !== "owner_admin" && actor.role !== "owner_manager")) {
    throw new WorkerShareAuthorizationError("Only owner admins or managers can revoke worker shares.", "revoker_not_allowed");
  }

  const existing = db
    .select({
      id: workerShareAuthorizations.id,
      ownerId: workerShareAuthorizations.ownerId,
      sourceRestaurantId: workerShareAuthorizations.sourceRestaurantId,
      targetRestaurantId: workerShareAuthorizations.targetRestaurantId,
      status: workerShareAuthorizations.status,
    })
    .from(workerShareAuthorizations)
    .where(eq(workerShareAuthorizations.id, input.authorizationId))
    .get();
  if (!existing || existing.ownerId !== input.ownerId) {
    throw new WorkerShareAuthorizationError("Worker share authorization not found.", "authorization_not_found");
  }
  assertRestaurantsStillBelongToOwner(
    db,
    existing.ownerId,
    existing.sourceRestaurantId,
    existing.targetRestaurantId,
  );
  if (existing.status === "revoked") {
    return db.select().from(workerShareAuthorizations).where(eq(workerShareAuthorizations.id, input.authorizationId)).get()!;
  }

  const now = new Date().toISOString();
  db.update(workerShareAuthorizations)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(eq(workerShareAuthorizations.id, input.authorizationId))
    .run();

  return db.select().from(workerShareAuthorizations).where(eq(workerShareAuthorizations.id, input.authorizationId)).get()!;
}

export function declineWorkerShareAuthorization(input: DeclineWorkerShareAuthorizationInput) {
  const db = input.db ?? defaultDb;
  const authorization = db
    .select()
    .from(workerShareAuthorizations)
    .where(eq(workerShareAuthorizations.id, input.authorizationId))
    .get();
  if (!authorization || authorization.userId !== input.userId || authorization.status !== "pending") {
    throw new WorkerShareAuthorizationError("Pending worker share authorization not found for this worker.", "authorization_not_pending");
  }
  if (input.ownerId && authorization.ownerId !== input.ownerId) {
    throw new WorkerShareAuthorizationError("Worker share authorization belongs to a different owner context.", "owner_mismatch");
  }
  assertRestaurantsStillBelongToOwner(
    db,
    authorization.ownerId,
    authorization.sourceRestaurantId,
    authorization.targetRestaurantId,
  );

  const now = new Date().toISOString();
  db.update(workerShareAuthorizations)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(eq(workerShareAuthorizations.id, input.authorizationId))
    .run();

  return db.select().from(workerShareAuthorizations).where(eq(workerShareAuthorizations.id, input.authorizationId)).get()!;
}
