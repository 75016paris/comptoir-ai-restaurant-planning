import { readFile } from "node:fs/promises";
import path from "node:path";

const requiredErrorCodes = [
  "same_restaurant",
  "restaurant_not_found",
  "source_restaurant_required",
  "invalid_role",
  "invalid_worker_share_payload",
  "owner_mismatch",
  "owner_manager_required",
  "inviter_not_allowed",
  "revoker_not_allowed",
  "source_membership_required",
  "target_membership_exists",
  "authorization_not_pending",
  "authorization_not_found",
];

const locales = ["fr", "en", "es", "pt"];
const missing: string[] = [];

for (const locale of locales) {
  const file = path.resolve(import.meta.dir, `../src/i18n/locales/${locale}/preferences.json`);
  const json = JSON.parse(await readFile(file, "utf8"));
  const errors = json.workerShares?.errors ?? {};
  for (const code of requiredErrorCodes) {
    if (typeof errors[code] !== "string" || errors[code].trim().length === 0) {
      missing.push(`${locale}: preferences.workerShares.errors.${code}`);
    }
  }
}

if (missing.length > 0) {
  throw new Error([
    "Worker-share API errors must have localized preferences copy in every supported locale.",
    ...missing.map((entry) => `- ${entry}`),
  ].join("\n"));
}

console.log(`Worker-share locale guard passed (${requiredErrorCodes.length} errors across ${locales.length} locales).`);
