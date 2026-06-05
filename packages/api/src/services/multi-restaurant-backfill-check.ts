import type { Database } from "bun:sqlite";

function tableExists(db: Database, table: string): boolean {
  const row = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !!row;
}

function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function count(db: Database, label: string, sql: string): number {
  const row = db.query(sql).get() as Record<string, number> | undefined;
  return Number(row?.[label] ?? 0);
}

const requiredTables = [
  "owners",
  "owner_memberships",
  "restaurant_memberships",
  "worker_restaurant_profiles",
  "worker_share_authorizations",
  "whatsapp_context_sessions",
];

const requiredColumns: Array<[string, string]> = [
  ["restaurants", "owner_id"],
  ["sessions", "active_restaurant_id"],
  ["legal_acceptances", "owner_id"],
  ["onboarding_tokens", "restaurant_id"],
];

export function collectMultiRestaurantBackfillFailures(db: Database): string[] {
  const failures: string[] = [];

  for (const table of requiredTables) {
    if (!tableExists(db, table)) failures.push(`missing table: ${table}`);
  }

  for (const [table, column] of requiredColumns) {
    if (!columnExists(db, table, column)) failures.push(`missing column: ${table}.${column}`);
  }

  if (failures.length === 0) {
    const checks = [
      {
        label: "restaurants_without_owner",
        sql: `
          SELECT COUNT(*) AS restaurants_without_owner
          FROM restaurants
          WHERE owner_id IS NULL
        `,
      },
      {
        label: "active_users_without_membership",
        sql: `
          SELECT COUNT(*) AS active_users_without_membership
          FROM users u
          WHERE u.active = 1
            AND NOT EXISTS (
              SELECT 1
              FROM restaurant_memberships rm
              WHERE rm.user_id = u.id
                AND rm.restaurant_id = u.restaurant_id
                AND rm.active = 1
            )
        `,
      },
      {
        label: "sessions_without_active_restaurant",
        sql: `
          SELECT COUNT(*) AS sessions_without_active_restaurant
          FROM sessions
          WHERE active_restaurant_id IS NULL
        `,
      },
      {
        label: "legal_acceptances_without_owner",
        sql: `
          SELECT COUNT(*) AS legal_acceptances_without_owner
          FROM legal_acceptances
          WHERE restaurant_id IS NOT NULL
            AND owner_id IS NULL
        `,
      },
      {
        label: "onboarding_tokens_without_restaurant",
        sql: `
          SELECT COUNT(*) AS onboarding_tokens_without_restaurant
          FROM onboarding_tokens
          WHERE user_id IS NOT NULL
            AND restaurant_id IS NULL
        `,
      },
      {
        label: "active_memberships_without_owner_membership",
        sql: `
          SELECT COUNT(*) AS active_memberships_without_owner_membership
          FROM restaurant_memberships rm
          INNER JOIN restaurants r ON r.id = rm.restaurant_id
          WHERE rm.active = 1
            AND r.owner_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM owner_memberships om
              WHERE om.owner_id = r.owner_id
                AND om.user_id = rm.user_id
            )
        `,
      },
    ];

    for (const check of checks) {
      const value = count(db, check.label, check.sql);
      if (value !== 0) failures.push(`${check.label}: ${value}`);
    }
  }

  return failures;
}
