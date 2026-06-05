import { createHash } from "node:crypto";
import { redactSensitiveString } from "@comptoir/shared";

export { redactSensitiveString };

const TOKEN_HASH_PREFIX = "sha256:";

export function hashToken(rawToken: string): string {
  return `${TOKEN_HASH_PREFIX}${createHash("sha256").update(rawToken).digest("hex")}`;
}

export function isHashedToken(value: string): boolean {
  return value.startsWith(TOKEN_HASH_PREFIX);
}

