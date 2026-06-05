import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-onboarding-token-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { ONBOARDING_TOKEN_TTL_MS, createOnboardingToken, onboardingTokenExpiresAt } = await import("./onboarding-tokens.js");

beforeEach(() => {
  rawDb.exec(`
    DROP TABLE IF EXISTS onboarding_tokens;
    CREATE TABLE onboarding_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restaurant_id TEXT,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `);
});

describe("onboarding token TTL", () => {
  test("new dossier magic links expire after 72 hours", () => {
    expect(ONBOARDING_TOKEN_TTL_MS).toBe(72 * 60 * 60 * 1000);
    expect(onboardingTokenExpiresAt(0)).toBe(new Date(72 * 60 * 60 * 1000).toISOString());
  });

  test("stores the restaurant context that minted the dossier link", () => {
    createOnboardingToken("worker-1", "resto-2");

    const row = rawDb.query("SELECT user_id AS userId, restaurant_id AS restaurantId FROM onboarding_tokens").get();
    expect(row).toEqual({ userId: "worker-1", restaurantId: "resto-2" });
  });
});
