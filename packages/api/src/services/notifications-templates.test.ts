import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-notif-templates-test-")), "test.db");
process.env.DEMO_CHAT_SECRET = "test-demo-secret-very-long-and-stable-1234567890";
process.env.WHATSAPP_URL = "http://test-bot.local";

const { rawDb } = await import("../db/connection.js");
const {
  missingDocumentTemplate,
  leaveProposalTemplate,
  timeclockReminderTemplate,
  notifyHolidayProposal,
} = await import("./notifications.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS users;
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'floor', restaurant_id TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE notifications (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, type TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', scheduled_for TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const originalFetch = globalThis.fetch;
let captured: { url: string; body: any } | null = null;

beforeEach(() => {
  rawDb.exec("DELETE FROM users; DELETE FROM notifications;");
  captured = null;
  globalThis.fetch = (async (url: any, init?: any) => {
    captured = { url: String(url), body: init?.body ? JSON.parse(init.body) : null };
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("template helpers", () => {
  test("missingDocumentTemplate carries params in the right order", () => {
    const tpl = missingDocumentTemplate("Alice Bernard", "Comptoir des Halles", "Adresse, IBAN", "https://x/y", );
    expect(tpl.name).toBe("missing_document_fr");
    expect(tpl.language).toBe("fr");
    expect(tpl.body).toEqual(["Alice", "Comptoir des Halles", "Adresse, IBAN", "https://x/y", "72"]);
    expect(tpl.buttonPayloads).toBeUndefined();
  });

  test("leaveProposalTemplate formats dates and carries button payloads", () => {
    const tpl = leaveProposalTemplate("Alice Bernard", "2026-08-04", "2026-08-08");
    expect(tpl.name).toBe("leave_proposal_fr");
    expect(tpl.body[0]).toBe("Alice");
    expect(tpl.body[1]).toBe("Le gérant");
    // formatTemplateDate yields FR "weekday day month" — exact wording depends on Intl, just sanity-check non-empty.
    expect(tpl.body[2]).toMatch(/août/);
    expect(tpl.body[3]).toMatch(/août/);
    expect(tpl.buttonPayloads).toEqual(["LEAVE_PROPOSAL_YES", "LEAVE_PROPOSAL_NO"]);
  });

  test("timeclockReminderTemplate uses role-localized label and start time", () => {
    expect(timeclockReminderTemplate("Bob Martin", "kitchen", "11:30").body).toEqual(["Bob", "en cuisine", "11:30"]);
    expect(timeclockReminderTemplate("Bob Martin", "floor", "18:00").body).toEqual(["Bob", "en salle", "18:00"]);
  });
});

describe("notifyHolidayProposal", () => {
  test("sends leave_proposal_fr template with worker's first name and formatted dates", async () => {
    rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run("worker-1", "Alice Bernard", "alice@example.com", "+3361", "floor", "resto-1");

    await notifyHolidayProposal("worker-1", "2026-08-04", "2026-08-08");

    expect(captured?.url).toBe("http://test-bot.local/notify");
    expect(captured?.body.userId).toBe("worker-1");
    expect(captured?.body.type).toBe("holiday_proposal");
    expect(captured?.body.template?.name).toBe("leave_proposal_fr");
    expect(captured?.body.template?.body[0]).toBe("Alice");
    expect(captured?.body.template?.body[1]).toBe("Le gérant");
    expect(captured?.body.template?.body[2]).toMatch(/août/);
    expect(captured?.body.template?.body[3]).toMatch(/août/);
    expect(captured?.body.template?.buttonPayloads).toEqual(["LEAVE_PROPOSAL_YES", "LEAVE_PROPOSAL_NO"]);
  });
});
