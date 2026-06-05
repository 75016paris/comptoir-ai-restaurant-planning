import type { Database } from "bun:sqlite";

export const INTERNAL_WHATSAPP_TEST_TABLES = [
  "whatsapp_context_sessions",
  "notifications",
  "audit_logs",
  "chat_messages",
  "open_shifts",
  "time_clocks",
  "replacement_requests",
  "holiday_requests",
  "worker_availability",
  "worker_restrictions",
  "worker_preferred_schedule",
  "worker_share_authorizations",
  "worker_restaurant_profiles",
  "weather_data",
  "calendar_events",
  "daily_revenue",
  "restaurant_closures",
  "published_weeks",
  "staffing_targets",
  "staffing_schedule",
  "staffing_profiles",
  "service_templates",
  "services",
  "restaurant_memberships",
  "owner_memberships",
  "users",
  "restaurants",
  "owners",
];

export function resetSqliteTables(rawDb: Database, tables = INTERNAL_WHATSAPP_TEST_TABLES) {
  const existing = new Set(
    rawDb
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );

  rawDb.exec("PRAGMA foreign_keys = OFF;");
  try {
    for (const table of tables) {
      if (existing.has(table)) rawDb.exec(`DELETE FROM "${table}";`);
    }
  } finally {
    rawDb.exec("PRAGMA foreign_keys = ON;");
  }
}
