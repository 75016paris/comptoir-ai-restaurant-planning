import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { onboardingTokens } from "../db/schema.js";
import { hashToken } from "../utils/token-security.js";
import { columnExists } from "./restaurant-context.js";

export const ONBOARDING_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

export function onboardingTokenExpiresAt(nowMs = Date.now()): string {
  return new Date(nowMs + ONBOARDING_TOKEN_TTL_MS).toISOString();
}

export function revokeOnboardingTokensForUser(userId: string): void {
  db.delete(onboardingTokens).where(eq(onboardingTokens.userId, userId)).run();
}

export function createOnboardingToken(userId: string, restaurantId?: string | null): { token: string; expiresAt: string } {
  revokeOnboardingTokensForUser(userId);
  const token = randomBytes(32).toString("hex");
  const expiresAt = onboardingTokenExpiresAt();
  const values = columnExists("onboarding_tokens", "restaurant_id")
    ? { userId, restaurantId: restaurantId ?? null, token: hashToken(token), expiresAt }
    : { userId, token: hashToken(token), expiresAt };
  db.insert(onboardingTokens).values(values).run();
  return { token, expiresAt };
}
