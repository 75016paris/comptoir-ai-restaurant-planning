import { db } from "../db/connection.js";
import { onboardingTokens, passwordResetTokens } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { hashToken, isHashedToken } from "../utils/token-security.js";

export function migrateStoredTokensToHashes(): void {
  for (const row of db.select({ id: passwordResetTokens.id, token: passwordResetTokens.token }).from(passwordResetTokens).all()) {
    if (!isHashedToken(row.token)) {
      db.update(passwordResetTokens).set({ token: hashToken(row.token) }).where(eq(passwordResetTokens.id, row.id)).run();
    }
  }
  for (const row of db.select({ id: onboardingTokens.id, token: onboardingTokens.token }).from(onboardingTokens).all()) {
    if (!isHashedToken(row.token)) {
      db.update(onboardingTokens).set({ token: hashToken(row.token) }).where(eq(onboardingTokens.id, row.id)).run();
    }
  }
}
