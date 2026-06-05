import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-notif-context-test-")), "test.db");
process.env.DEMO_CHAT_SECRET = "test-demo-secret-very-long-and-stable-1234567890";
process.env.WHATSAPP_URL = "http://test-bot.local";

const { rawDb } = await import("../db/connection.js");
const {
  adminRecipientsForRestaurant,
  notifyAdminHolidayRequest,
  notifyHolidayReview,
  notifyScheduleChange,
  notifyWorkersWeekPublished,
  runPlanningNotificationCycle,
} = await import("./notifications.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS services;
  DROP TABLE IF EXISTS worker_share_authorizations;
  DROP TABLE IF EXISTS worker_restaurant_profiles;
  DROP TABLE IF EXISTS restaurant_memberships;
  DROP TABLE IF EXISTS owner_memberships;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  DROP TABLE IF EXISTS published_weeks;
  PRAGMA foreign_keys = ON;

  CREATE TABLE restaurants (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
    status TEXT NOT NULL DEFAULT 'active',
    reminder_frequency TEXT NOT NULL DEFAULT 'daily'
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'floor',
    restaurant_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    sub_roles TEXT NOT NULL DEFAULT '[]',
    contract_hours INTEGER,
    permissions TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE owner_memberships (
    owner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (owner_id, user_id)
  );

  CREATE TABLE restaurant_memberships (
    restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    permissions TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (restaurant_id, user_id)
  );

  CREATE TABLE services (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled'
  );

  CREATE TABLE worker_share_authorizations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    source_restaurant_id TEXT NOT NULL,
    target_restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    invited_by_user_id TEXT NOT NULL,
    worker_consented_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE worker_restaurant_profiles (
    restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    sub_roles TEXT NOT NULL DEFAULT '[]',
    contract_type TEXT,
    contract_hours INTEGER,
    contract_end_date TEXT,
    max_weekly_hours INTEGER,
    admin_ot_override INTEGER,
    hcr_level TEXT,
    hourly_rate INTEGER,
    matricule TEXT,
    manager_notes TEXT,
    multi_restaurant_willing INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (restaurant_id, user_id)
  );

  CREATE TABLE published_weeks (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    week_date TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL,
    type TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    scheduled_for TEXT NOT NULL,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const originalFetch = globalThis.fetch;
let captured: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  rawDb.exec("DELETE FROM notifications; DELETE FROM services; DELETE FROM worker_share_authorizations; DELETE FROM worker_restaurant_profiles; DELETE FROM restaurant_memberships; DELETE FROM owner_memberships; DELETE FROM users; DELETE FROM restaurants; DELETE FROM published_weeks;");
  captured = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    captured.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function insertRestaurant(id: string, name: string, ownerId = "owner-a", status = "active") {
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, timezone, status) VALUES (?, ?, ?, 'Europe/Paris', ?)")
    .run(id, ownerId, name, status);
}

function insertMembership(userId: string, restaurantId: string, role = "floor") {
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, 1)")
    .run(restaurantId, userId, role);
}

function insertTargetProfile(userId: string, restaurantId: string) {
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, multi_restaurant_willing)
    VALUES (?, ?, 1, '[]', 35, 1)
  `).run(restaurantId, userId);
}

function seedNotificationShare() {
  insertRestaurant("resto-a", "Comptoir A");
  insertRestaurant("resto-b", "Comptoir B");
  rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
    .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
  insertMembership("worker-1", "resto-a");
  insertTargetProfile("worker-1", "resto-b");
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
  `).run("share-1", "owner-a", "resto-a", "resto-b", "worker-1", "floor", "admin-1", "2026-05-01T10:00:00.000Z");
}

const staleNotificationShareScenarios = [
  {
    name: "the share is revoked",
    mutate: () => rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-1"),
  },
  {
    name: "worker consent is missing",
    mutate: () => rawDb.prepare("UPDATE worker_share_authorizations SET worker_consented_at = NULL WHERE id = ?")
      .run("share-1"),
  },
  {
    name: "source membership is inactive",
    mutate: () => rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?")
      .run("resto-a", "worker-1"),
  },
  {
    name: "source role drifts away from the accepted share role",
    mutate: () => rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("manager", "resto-a", "worker-1"),
  },
  {
    name: "the worker leaves the owner account",
    mutate: () => rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-a", "worker-1"),
  },
  {
    name: "the worker account becomes inactive",
    mutate: () => rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?")
      .run("worker-1"),
  },
  {
    name: "the source restaurant leaves the authorization owner",
    mutate: () => rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?")
      .run("owner-b", "resto-a"),
  },
  {
    name: "the target restaurant leaves the authorization owner",
    mutate: () => rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?")
      .run("owner-b", "resto-b"),
  },
  {
    name: "the target profile is missing",
    mutate: () => rawDb.prepare("DELETE FROM worker_restaurant_profiles WHERE restaurant_id = ? AND user_id = ?")
      .run("resto-b", "worker-1"),
  },
];

async function expectSourceNotificationWithoutSharedRestaurantContext() {
  await notifyScheduleChange("worker-1", "Ton planning a changé.", { workerName: "Alice Bernard", serviceLabel: "Lundi", newSchedule: "10:00-14:00" }, "resto-a");

  expect(captured).toHaveLength(1);
  expect(captured[0]?.body.message.startsWith("Ton planning")).toBe(true);
  expect(captured[0]?.body.message).not.toContain("*Comptoir A*");
  expect(captured[0]?.body.message).not.toContain("*Comptoir B*");
}

describe("restaurant context in worker notifications", () => {
  test("adds the restaurant name when the recipient belongs to multiple restaurants", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
    insertMembership("worker-1", "resto-a");
    insertMembership("worker-1", "resto-b");
    rawDb.prepare("INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, 'floor', 'scheduled')")
      .run("service-1", "worker-1", "resto-a", "2026-05-25", "09:00", "12:00");

    const sent = await notifyWorkersWeekPublished("resto-a", "2026-05-25");

    expect(sent).toBe(1);
    expect(captured[0]?.body.userId).toBe("worker-1");
    expect(captured[0]?.body.message.startsWith("*Comptoir A*\nTon planning")).toBe(true);
  });

  test("does not add a redundant restaurant name for single-restaurant recipients", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
    insertMembership("worker-1", "resto-a");
    rawDb.prepare("INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, 'floor', 'scheduled')")
      .run("service-1", "worker-1", "resto-a", "2026-05-25", "09:00", "12:00");

    const sent = await notifyWorkersWeekPublished("resto-a", "2026-05-25");

    expect(sent).toBe(1);
    expect(captured[0]?.body.message.startsWith("Ton planning")).toBe(true);
    expect(captured[0]?.body.message).not.toContain("*Comptoir A*");
  });

  test("adds the target restaurant name for accepted shared workers without target membership", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
    insertMembership("worker-1", "resto-a");
    insertTargetProfile("worker-1", "resto-b");
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
    `).run("share-1", "owner-a", "resto-a", "resto-b", "worker-1", "floor", "admin-1", "2026-05-01T10:00:00.000Z");

    await notifyScheduleChange("worker-1", "Ton planning a changé.", { workerName: "Alice Bernard", serviceLabel: "Lundi", newSchedule: "10:00-14:00" }, "resto-b");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.body.userId).toBe("worker-1");
    expect(captured[0]?.body.message.startsWith("*Comptoir B*\nTon planning")).toBe(true);
  });

  test("publishes weekly schedules to accepted shared workers through the live target roster", async () => {
    seedNotificationShare();
    rawDb.prepare("INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, 'floor', 'scheduled')")
      .run("service-shared-target", "worker-1", "resto-b", "2026-05-25", "09:00", "12:00");

    const sent = await notifyWorkersWeekPublished("resto-b", "2026-05-25");

    expect(sent).toBe(1);
    expect(captured[0]?.body.userId).toBe("worker-1");
    expect(captured[0]?.body.message.startsWith("*Comptoir B*\nTon planning")).toBe(true);
  });

  test("does not publish wrong-role target services to accepted shared workers", async () => {
    seedNotificationShare();
    rawDb.prepare("INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, 'kitchen', 'scheduled')")
      .run("service-shared-target-wrong-role", "worker-1", "resto-b", "2026-05-25", "09:00", "12:00");

    const sent = await notifyWorkersWeekPublished("resto-b", "2026-05-25");

    expect(sent).toBe(0);
    expect(captured).toEqual([]);
  });

  for (const scenario of staleNotificationShareScenarios) {
    test(`does not publish weekly schedules to stale shared workers when ${scenario.name}`, async () => {
      seedNotificationShare();
      rawDb.prepare("INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, 'floor', 'scheduled')")
        .run("service-shared-target", "worker-1", "resto-b", "2026-05-25", "09:00", "12:00");
      scenario.mutate();

      const sent = await notifyWorkersWeekPublished("resto-b", "2026-05-25");

      expect(sent).toBe(0);
      expect(captured).toEqual([]);
    });
  }

  test("valid accepted shares make source notifications include restaurant context", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
    insertMembership("worker-1", "resto-a");
    insertTargetProfile("worker-1", "resto-b");
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
    `).run("share-valid", "owner-a", "resto-a", "resto-b", "worker-1", "floor", "admin-1", "2026-05-01T10:00:00.000Z");

    await notifyScheduleChange("worker-1", "Ton planning a changé.", { workerName: "Alice Bernard", serviceLabel: "Lundi", newSchedule: "10:00-14:00" }, "resto-a");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.body.message.startsWith("*Comptoir A*\nTon planning")).toBe(true);
  });

  test("ignores accepted shares without target worker profile when deciding source notification context", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
    insertMembership("worker-1", "resto-a");
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
    `).run("share-no-profile", "owner-a", "resto-a", "resto-b", "worker-1", "floor", "admin-1", "2026-05-01T10:00:00.000Z");

    await notifyScheduleChange("worker-1", "Ton planning a changé.", { workerName: "Alice Bernard", serviceLabel: "Lundi", newSchedule: "10:00-14:00" }, "resto-a");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.body.message.startsWith("Ton planning")).toBe(true);
    expect(captured[0]?.body.message).not.toContain("*Comptoir A*");
    expect(captured[0]?.body.message).not.toContain("*Comptoir B*");
  });

  test("ignores stale accepted shares when deciding whether source notifications need restaurant context", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
    insertMembership("worker-1", "resto-a");
    rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?").run("resto-a", "worker-1");
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
    `).run("share-stale", "owner-a", "resto-a", "resto-b", "worker-1", "floor", "admin-1", "2026-05-01T10:00:00.000Z");

    await notifyScheduleChange("worker-1", "Ton planning a changé.", { workerName: "Alice Bernard", serviceLabel: "Lundi", newSchedule: "10:00-14:00" }, "resto-a");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.body.message.startsWith("Ton planning")).toBe(true);
    expect(captured[0]?.body.message).not.toContain("*Comptoir A*");
    expect(captured[0]?.body.message).not.toContain("*Comptoir B*");
  });

  for (const scenario of staleNotificationShareScenarios) {
    test(`ignores accepted shares for notification context when ${scenario.name}`, async () => {
      seedNotificationShare();
      scenario.mutate();

      await expectSourceNotificationWithoutSharedRestaurantContext();
    });
  }

  test("uses restaurant memberships when sending admin publish reminders", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B", "owner-a", "inactive");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'admin', ?, 1)")
      .run("admin-1", "Admin Owner", "admin@example.com", "+3362", "resto-b");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'admin-1', 'owner_admin')").run();
    insertMembership("admin-1", "resto-a", "admin");
    insertMembership("admin-1", "resto-b", "admin");

    const report = await runPlanningNotificationCycle(new Date("2026-05-10T08:00:00.000Z"), true);

    expect(report.publishReminders).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body.userId).toBe("admin-1");
    expect(captured[0]?.body.message.startsWith("*Comptoir A*\nPlanning à publier")).toBe(true);
  });

  test("admin recipients ignore legacy restaurant_id when owner tenancy is available", () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'admin', ?, 1)")
      .run("admin-legacy", "Legacy Admin", "legacy@example.com", "+3362", "resto-b");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'admin', ?, 1)")
      .run("admin-member", "Member Admin", "member@example.com", "+3363", "resto-b");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'admin-legacy', 'owner_admin')").run();
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'admin-member', 'owner_admin')").run();
    insertMembership("admin-member", "resto-a", "admin");

    expect(adminRecipientsForRestaurant("resto-a", ["admin"])).toEqual([{ id: "admin-member" }]);
  });

  test("adds restaurant context to direct holiday review notifications", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'floor', ?, 1)")
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'worker-1', 'member')").run();
    insertMembership("worker-1", "resto-a");
    insertMembership("worker-1", "resto-b");

    await notifyHolidayReview("worker-1", "2026-08-04", "2026-08-08", true, "resto-a");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.body.userId).toBe("worker-1");
    expect(captured[0]?.body.message.startsWith("*Comptoir A*\n✅ Ton congé")).toBe(true);
  });

  test("adds restaurant context to admin holiday request notifications", async () => {
    insertRestaurant("resto-a", "Comptoir A");
    insertRestaurant("resto-b", "Comptoir B");
    rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, 'admin', ?, 1)")
      .run("admin-1", "Admin Owner", "admin@example.com", "+3362", "resto-a");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'admin-1', 'owner_admin')").run();
    insertMembership("admin-1", "resto-a", "admin");
    insertMembership("admin-1", "resto-b", "admin");

    await notifyAdminHolidayRequest("admin-1", "Alice Bernard", "2026-08-04", "2026-08-08", false, "resto-a");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.body.userId).toBe("admin-1");
    expect(captured[0]?.body.message.startsWith("*Comptoir A*\n📋 *Alice Bernard*")).toBe(true);
  });
});
