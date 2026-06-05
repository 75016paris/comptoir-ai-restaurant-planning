/**
 * WhatsApp dev/bench DB access.
 * Production runtime routes data access through the internal API.
 */
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as apiSchema from "../../api/src/db/schema.js";

// Re-export API schema for dev/bench adapters.
export const { users, services, restaurants, replacementRequests, holidayRequests,
  serviceTemplates, workerAvailability, staffingTargets, workerPreferredSchedule,
  restaurantClosures, timeClocks, notifications, dailyRevenue, sessions,
  documents, chatMessages, calendarEvents, weatherData, auditLogs,
  staffingProfiles, openShifts, publishedWeeks } = apiSchema;

// ── Connection ──

const dbPath = process.env.DATABASE_URL || "../api/comptoir.db";
const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA busy_timeout = 5000;");

export const db = drizzle(sqlite, {
  schema: apiSchema,
});

// Safety net — create table if migrations haven't run (e.g. fresh dev setup)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_calls TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
