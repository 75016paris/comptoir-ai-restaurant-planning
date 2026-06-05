import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-notification-scope-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { queueNotification } = await import("./notifications.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  DROP TABLE IF EXISTS owners;
  PRAGMA foreign_keys = ON;

  CREATE TABLE owners (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE restaurants (
    id TEXT PRIMARY KEY,
    owner_id TEXT
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    recipient_id TEXT NOT NULL,
    owner_id TEXT,
    restaurant_id TEXT,
    type TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    scheduled_for TEXT NOT NULL,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

beforeEach(() => {
  rawDb.exec(`
    DELETE FROM notifications;
    DELETE FROM users;
    DELETE FROM restaurants;
    DELETE FROM owners;
    INSERT INTO owners (id) VALUES ('owner-a');
    INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
    INSERT INTO users (id, name, email, phone, active) VALUES ('worker-a', 'Worker A', 'worker@example.test', '+331', 1);
  `);
});

describe("notification scope metadata", () => {
  test("queueNotification stores restaurant and inferred owner scope", () => {
    const id = queueNotification({
      recipientId: "worker-a",
      type: "schedule_change",
      message: "Planning modifie",
      restaurantId: "resto-a",
    });

    expect(rawDb.query(`
      SELECT recipient_id, owner_id, restaurant_id, type, status
      FROM notifications
      WHERE id = ?
    `).get(id)).toEqual({
      recipient_id: "worker-a",
      owner_id: "owner-a",
      restaurant_id: "resto-a",
      type: "schedule_change",
      status: "queued",
    });
  });

  test("explicit owner scope is preserved for owner-level notifications", () => {
    const id = queueNotification({
      recipientId: "worker-a",
      type: "payment_failed",
      message: "Paiement a verifier",
      ownerId: "owner-a",
    });

    expect(rawDb.query(`
      SELECT owner_id, restaurant_id
      FROM notifications
      WHERE id = ?
    `).get(id)).toEqual({
      owner_id: "owner-a",
      restaurant_id: null,
    });
  });
});
