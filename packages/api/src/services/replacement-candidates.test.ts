import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as schema from "../db/schema.js";
import { rankReplacementCandidates } from "./replacement-candidates.js";
import { acceptWorkerShareAuthorization, createWorkerShareAuthorization, revokeWorkerShareAuthorization } from "./worker-sharing.js";

// In-memory DB fully migrated. Each test inserts its own fixtures.
const sqlite = new Database(":memory:");
sqlite.exec("PRAGMA journal_mode = MEMORY;");
sqlite.exec("PRAGMA foreign_keys = ON;");
const db = drizzle(sqlite, { schema });

beforeAll(() => {
  const dir = join(import.meta.dir, "../../drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
});

const RESTO_ID = "r1";
const REQ_ID = "req1";

const seed = (workers: Array<Partial<typeof schema.users.$inferInsert>>) => {
  sqlite.exec("DELETE FROM replacement_requests");
  sqlite.exec("DELETE FROM holiday_requests");
  sqlite.exec("DELETE FROM services");
  sqlite.exec("DELETE FROM worker_availability");
  sqlite.exec("DELETE FROM worker_restrictions");
  sqlite.exec("DELETE FROM worker_preferred_schedule");
  sqlite.exec("DELETE FROM worker_share_authorizations");
  sqlite.exec("DELETE FROM worker_restaurant_profiles");
  sqlite.exec("DELETE FROM restaurant_memberships");
  sqlite.exec("DELETE FROM owner_memberships");
  sqlite.exec("DELETE FROM users");
  sqlite.exec("DELETE FROM restaurants");
  sqlite.exec("DELETE FROM owners");

  db.insert(schema.restaurants).values({
    id: RESTO_ID,
    name: "Test",
    address: "x",
    timezone: "Europe/Paris",
    overtimeWeeklyCap: 48,
  } as any).run();

  db.insert(schema.users).values({
    id: REQ_ID,
    restaurantId: RESTO_ID,
    name: "Requester",
    role: "kitchen",
    email: "req@x",
    phone: "+33000000000",
    passwordHash: "x",
    active: true,
    priority: 1,
    subRoles: JSON.stringify(["Cuisinier"]),
  } as any).run();
  db.insert(schema.restaurantMemberships).values({
    restaurantId: RESTO_ID,
    userId: REQ_ID,
    role: "kitchen",
    active: true,
  } as any).run();

  for (const w of workers) {
    db.insert(schema.users).values({
      id: w.id!,
      restaurantId: RESTO_ID,
      name: w.name!,
      role: w.role ?? "kitchen",
      email: `${w.id}@x`,
      phone: `+330000${w.id}`,
      passwordHash: "x",
      active: w.active ?? true,
      priority: w.priority ?? 2,
      subRoles: w.subRoles ?? JSON.stringify(["Cuisinier"]),
      overtimeWilling: w.overtimeWilling ?? false,
      coupureWilling: w.coupureWilling ?? false,
      contractHours: w.contractHours ?? null,
      maxWeeklyHours: w.maxWeeklyHours ?? null,
      adminOtOverride: w.adminOtOverride ?? null,
      contractEndDate: w.contractEndDate ?? null,
    } as any).run();
    db.insert(schema.restaurantMemberships).values({
      restaurantId: RESTO_ID,
      userId: w.id!,
      role: w.role ?? "kitchen",
      active: w.active ?? true,
    } as any).run();
  }
};

const SAT_2026_05_02 = "2026-05-02"; // Saturday

describe("rankReplacementCandidates", () => {
  test("priority-1 worker outranks priority-3 worker, all else equal", () => {
    seed([
      { id: "w_high", name: "Alice High", priority: 1 },
      { id: "w_low", name: "Bob Low", priority: 3 },
    ]);

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.length).toBe(2);
    expect(ranked[0].workerId).toBe("w_high");
    expect(ranked[1].workerId).toBe("w_low");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test("worker over personal OT cap is excluded", () => {
    seed([
      { id: "w_overcap", name: "Cap Hit", priority: 1, maxWeeklyHours: 30 },
      { id: "w_room", name: "Has Room", priority: 2, maxWeeklyHours: 50 },
    ]);

    // Pre-fill 28h on w_overcap that week (Mon + Tue services, 14h each)
    // Saturday is 2026-05-02, Monday of that week is 2026-04-27
    db.insert(schema.services).values([
      { id: "s1", restaurantId: RESTO_ID, workerId: "w_overcap", date: "2026-04-27", startTime: "08:00", endTime: "22:00", role: "kitchen", status: "scheduled" } as any,
      { id: "s2", restaurantId: RESTO_ID, workerId: "w_overcap", date: "2026-04-28", startTime: "08:00", endTime: "22:00", role: "kitchen", status: "scheduled" } as any,
    ]).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00", // 4h, would push w_overcap to 32h > 30 cap
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    const ids = ranked.map((r) => r.workerId);
    expect(ids).not.toContain("w_overcap");
    expect(ids).toContain("w_room");
  });

  test("exact sub-role match outranks generic match", () => {
    seed([
      { id: "w_chef", name: "Chef Match", priority: 2, subRoles: JSON.stringify(["Chef"]) },
      { id: "w_souschef", name: "Sous-chef Fallback", priority: 2, subRoles: JSON.stringify(["Sous-chef"]) },
    ]);

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      requiredSubRoles: ["Chef"],
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked[0].workerId).toBe("w_chef");
    expect(ranked.find((r) => r.workerId === "w_chef")!.score).toBeGreaterThan(
      ranked.find((r) => r.workerId === "w_souschef")!.score,
    );
  });

  test("worker with overlapping service that day is excluded", () => {
    seed([
      { id: "w_busy", name: "Already Working", priority: 1 },
      { id: "w_free", name: "Free", priority: 2 },
    ]);

    db.insert(schema.services).values([
      { id: "sX", restaurantId: RESTO_ID, workerId: "w_busy", date: SAT_2026_05_02, startTime: "10:00", endTime: "14:00", role: "kitchen", status: "scheduled" } as any,
    ]).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    const ids = ranked.map((r) => r.workerId);
    expect(ids).not.toContain("w_busy");
    expect(ids).toContain("w_free");
  });

  test("overnight service blocks early next-day replacement", () => {
    seed([
      { id: "w_overnight", name: "Night Busy", priority: 1 },
      { id: "w_free", name: "Free", priority: 2 },
    ]);

    db.insert(schema.services).values([
      { id: "sNight", restaurantId: RESTO_ID, workerId: "w_overnight", date: "2026-05-01", startTime: "22:00", endTime: "02:00", role: "kitchen", status: "scheduled" } as any,
    ]).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "01:00",
      endTime: "03:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    const ids = ranked.map((r) => r.workerId);
    expect(ids).not.toContain("w_overnight");
    expect(ids).toContain("w_free");
  });

  test("active restaurant membership makes a worker eligible even when legacy restaurant_id differs", () => {
    seed([
      { id: "w_shared", name: "Shared Worker", priority: 1 },
      { id: "w_local", name: "Local Worker", priority: 2 },
    ]);
    db.insert(schema.restaurants).values({
      id: "legacy-r",
      name: "Legacy Home",
      address: "y",
      timezone: "Europe/Paris",
    } as any).run();
    db.update(schema.users).set({ restaurantId: "legacy-r" }).where(eq(schema.users.id, "w_shared")).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).toContain("w_shared");
    expect(ranked[0].workerId).toBe("w_shared");
  });
});

const seedOwnerGroupForSharing = () => {
  seed([]);

  db.insert(schema.owners).values({ id: "owner-a", name: "Owner A" } as any).run();
  db.update(schema.restaurants).set({ ownerId: "owner-a" }).where(eq(schema.restaurants.id, RESTO_ID)).run();
  db.insert(schema.restaurants).values({
    id: "source-r",
    ownerId: "owner-a",
    name: "Source",
    address: "source",
    timezone: "Europe/Paris",
  } as any).run();

  db.insert(schema.users).values({
    id: "admin-a",
    restaurantId: RESTO_ID,
    name: "Owner Admin",
    role: "admin",
    email: "admin-a@x",
    phone: "+33111111111",
    passwordHash: "x",
    active: true,
  } as any).run();
  db.insert(schema.ownerMemberships).values({
    ownerId: "owner-a",
    userId: "admin-a",
    role: "owner_admin",
  } as any).run();

  db.insert(schema.users).values({
    id: "w_source",
    restaurantId: "source-r",
    name: "Source Worker",
    role: "kitchen",
    email: "w_source@x",
    phone: "+33111111112",
    passwordHash: "x",
    active: true,
    priority: 1,
    subRoles: JSON.stringify(["Cuisinier"]),
    multiRestaurantWilling: true,
  } as any).run();
  db.insert(schema.ownerMemberships).values({
    ownerId: "owner-a",
    userId: "w_source",
    role: "member",
  } as any).run();
  db.insert(schema.restaurantMemberships).values({
    restaurantId: "source-r",
    userId: "w_source",
    role: "kitchen",
    active: true,
  } as any).run();
  db.insert(schema.workerAvailability).values({
    id: "target-availability-w-source",
    restaurantId: RESTO_ID,
    workerId: "w_source",
    dayOfWeek: 6,
    midi: true,
    soir: true,
  } as any).run();
};

describe("rankReplacementCandidates shared-worker authorization", () => {
  test("multiRestaurantWilling alone does not make a sibling-restaurant worker eligible", () => {
    seedOwnerGroupForSharing();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted same-owner worker share makes a source-restaurant worker eligible", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });

    let ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });
    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");

    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).toContain("w_source");
    expect(ranked.find((r) => r.workerId === "w_source")?.reasons).toContain("partagé");
  });

  test("accepted shared worker is excluded when busy in the source restaurant", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });

    db.insert(schema.services).values({
      id: "source-service",
      restaurantId: "source-r",
      workerId: "w_source",
      date: SAT_2026_05_02,
      startTime: "10:00",
      endTime: "14:00",
      role: "kitchen",
      status: "scheduled",
    } as any).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is excluded without explicit target availability", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.delete(schema.workerAvailability)
      .where(eq(schema.workerAvailability.workerId, "w_source"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker follows target availability for the requested zone", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.workerAvailability)
      .set({ midi: false, soir: true })
      .where(eq(schema.workerAvailability.workerId, "w_source"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is excluded after source membership becomes inactive", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.restaurantMemberships)
      .set({ active: false })
      .where(eq(schema.restaurantMemberships.userId, "w_source"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is excluded after source membership role changes", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.restaurantMemberships)
      .set({ role: "floor" })
      .where(eq(schema.restaurantMemberships.userId, "w_source"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is excluded after source user becomes inactive", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.users)
      .set({ active: false })
      .where(eq(schema.users.id, "w_source"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is excluded after owner membership is removed", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.delete(schema.ownerMemberships)
      .where(eq(schema.ownerMemberships.userId, "w_source"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is excluded after source restaurant leaves the owner account", () => {
    seedOwnerGroupForSharing();
    db.insert(schema.owners).values({ id: "owner-b", name: "Owner B" } as any).run();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.restaurants)
      .set({ ownerId: "owner-b" })
      .where(eq(schema.restaurants.id, "source-r"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is excluded after target restaurant leaves the authorization owner", () => {
    seedOwnerGroupForSharing();
    db.insert(schema.owners).values({ id: "owner-b", name: "Owner B" } as any).run();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.restaurants)
      .set({ ownerId: "owner-b" })
      .where(eq(schema.restaurants.id, RESTO_ID))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker is treated as local after joining target restaurant directly", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.insert(schema.restaurantMemberships).values({
      restaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      active: true,
    } as any).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).toContain("w_source");
    expect(ranked.find((r) => r.workerId === "w_source")?.reasons).not.toContain("partagé");
  });

  test("accepted shared worker is not used after joining target restaurant directly with another role", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.insert(schema.restaurantMemberships).values({
      restaurantId: RESTO_ID,
      userId: "w_source",
      role: "floor",
      active: true,
    } as any).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker uses target profile sub-roles instead of source user row", () => {
    seedOwnerGroupForSharing();
    db.update(schema.users)
      .set({ subRoles: JSON.stringify(["Chef"]) })
      .where(eq(schema.users.id, "w_source"))
      .run();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });

    let ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      requiredSubRoles: ["Chef"],
      excludeWorkerIds: [REQ_ID],
      db,
    });
    expect(ranked.find((r) => r.workerId === "w_source")?.reasons).not.toContain("sous-rôle exact");

    db.update(schema.workerRestaurantProfiles)
      .set({ subRoles: JSON.stringify(["Chef"]) })
      .where(eq(schema.workerRestaurantProfiles.userId, "w_source"))
      .run();
    ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      requiredSubRoles: ["Chef"],
      excludeWorkerIds: [REQ_ID],
      db,
    });
    expect(ranked.find((r) => r.workerId === "w_source")?.reasons).toContain("sous-rôle exact");
  });

  test("accepted shared worker uses target profile weekly cap instead of source user row", () => {
    seedOwnerGroupForSharing();
    db.update(schema.users)
      .set({ maxWeeklyHours: 60 })
      .where(eq(schema.users.id, "w_source"))
      .run();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.workerRestaurantProfiles)
      .set({ maxWeeklyHours: 3 })
      .where(eq(schema.workerRestaurantProfiles.userId, "w_source"))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("accepted shared worker weekly cap counts source-restaurant services", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.workerRestaurantProfiles)
      .set({ maxWeeklyHours: 30 })
      .where(eq(schema.workerRestaurantProfiles.userId, "w_source"))
      .run();

    db.insert(schema.services).values([
      { id: "source-hours-1", restaurantId: "source-r", workerId: "w_source", date: "2026-04-27", startTime: "08:00", endTime: "22:00", role: "kitchen", status: "scheduled" } as any,
      { id: "source-hours-2", restaurantId: "source-r", workerId: "w_source", date: "2026-04-28", startTime: "08:00", endTime: "22:00", role: "kitchen", status: "scheduled" } as any,
    ]).run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("revoked shared worker authorization removes target-restaurant eligibility", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    revokeWorkerShareAuthorization({
      authorizationId: authorization.id,
      ownerId: "owner-a",
      actorUserId: "admin-a",
      db,
    });

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });

  test("stale accepted shared worker authorization with revoked timestamp removes eligibility", () => {
    seedOwnerGroupForSharing();
    const authorization = createWorkerShareAuthorization({
      ownerId: "owner-a",
      sourceRestaurantId: "source-r",
      targetRestaurantId: RESTO_ID,
      userId: "w_source",
      role: "kitchen",
      invitedByUserId: "admin-a",
      db,
    });
    acceptWorkerShareAuthorization({ authorizationId: authorization.id, userId: "w_source", db });
    db.update(schema.workerShareAuthorizations)
      .set({ revokedAt: "2026-05-02T10:00:00.000Z" })
      .where(eq(schema.workerShareAuthorizations.id, authorization.id))
      .run();

    const ranked = rankReplacementCandidates({
      restaurantId: RESTO_ID,
      date: SAT_2026_05_02,
      startTime: "11:00",
      endTime: "15:00",
      role: "kitchen",
      excludeWorkerIds: [REQ_ID],
      db,
    });

    expect(ranked.map((r) => r.workerId)).not.toContain("w_source");
  });
});
