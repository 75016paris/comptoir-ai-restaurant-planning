import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const srcRoot = path.join(root, "src");

const legacyTenantColumnPattern = /\busers\.restaurantId\b|\busers\.restaurant_id\b/g;
const requestContextTenantAliasPattern = /\b(?:user|auth)\.restaurantId\b/g;
const rawTenantInputName = "(?:restaurantId|sourceRestaurantId|targetRestaurantId)";
const rawRequestTenantInputPatterns = [
  new RegExp(`\\bbody\\.${rawTenantInputName}\\b`, "g"),
  new RegExp(`\\bbody\\s*\\[\\s*["']${rawTenantInputName}["']\\s*\\]`, "g"),
  new RegExp(`\\bconst\\s*\\{[^}]*\\b${rawTenantInputName}\\b[^}]*\\}\\s*=\\s*body\\b`, "g"),
  new RegExp(`\\bc\\.req\\.(?:query|param)\\(\\s*["']${rawTenantInputName}["']\\s*\\)`, "g"),
  /\bc\.req\.header\(\s*["']X-Comptoir-Restaurant-Id["']\s*\)/g,
];

const allowedLegacyColumnFiles = new Map<string, string>([
  ["src/db/owner-leave-audit.ts", "offline audit helper kept on v1 scope until owner leave tooling is migrated"],
  ["src/db/seed.ts", "seed/backfill compatibility"],
  ["src/middleware/auth.ts", "auth compatibility fallback before all sessions have v2 context"],
  ["src/middleware/internal-whatsapp-auth.ts", "internal WhatsApp compatibility fallback for pre-membership schemas"],
  ["src/routes/auth.ts", "login, active-context switching, and owner billing fallback"],
  ["src/routes/cron.ts", "cron fallback for pre-membership schemas"],
  ["src/routes/internal-whatsapp.ts", "WhatsApp identity fallback for pre-membership schemas"],
  ["src/routes/public-onboarding.ts", "old dossier token fallback after membership resolution"],
  ["src/services/notifications.ts", "notification recipient fallback for pre-membership schemas"],
  ["src/services/replacement-candidates.ts", "candidate fallback for pre-membership schemas"],
]);

const allowedRequestContextAliasFiles = new Map<string, string>([
  ["src/routes/auth.ts", "login/demo/login response compatibility before active context is fully established"],
]);

const allowedRawRequestTenantInputFiles = new Map<string, string>([
  ["src/middleware/internal-whatsapp-auth.ts", "internal secret-protected restaurant header resolves through membership-validated WhatsApp auth context"],
  ["src/routes/auth.ts", "active restaurant switch endpoint validates the requested restaurant against authenticated memberships"],
  ["src/routes/internal-whatsapp.ts", "internal secret-protected WhatsApp context selection and uploads validate restaurant membership before use"],
  ["src/routes/restaurants.ts", "restaurant management and worker-share endpoints validate same-owner membership before using source/target restaurant ids"],
]);

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [fullPath];
  }));
  return files.flat();
}

const violations: Array<{ file: string; line: number; match: string }> = [];
const matchedLegacyColumnFiles = new Set<string>();
const matchedRequestContextAliasFiles = new Set<string>();
const matchedRawRequestTenantInputFiles = new Set<string>();

function lineNumberForIndex(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

for (const file of await listSourceFiles(srcRoot)) {
  const relative = path.relative(root, file);
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    const legacyColumnMatches = line.match(legacyTenantColumnPattern);
    if (legacyColumnMatches) {
      if (allowedLegacyColumnFiles.has(relative)) {
        matchedLegacyColumnFiles.add(relative);
      } else {
        for (const match of legacyColumnMatches) violations.push({ file: relative, line: index + 1, match });
      }
    }

    const requestContextMatches = line.match(requestContextTenantAliasPattern);
    if (requestContextMatches) {
      if (allowedRequestContextAliasFiles.has(relative)) {
        matchedRequestContextAliasFiles.add(relative);
      } else {
        for (const match of requestContextMatches) violations.push({ file: relative, line: index + 1, match });
      }
    }
  }

  for (const pattern of rawRequestTenantInputPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (allowedRawRequestTenantInputFiles.has(relative)) {
        matchedRawRequestTenantInputFiles.add(relative);
      } else {
        violations.push({
          file: relative,
          line: lineNumberForIndex(text, match.index ?? 0),
          match: match[0].replace(/\s+/g, " "),
        });
      }
    }
  }
}

const staleAllowlistEntries = [
  ...[...allowedLegacyColumnFiles.keys()]
    .filter((file) => !matchedLegacyColumnFiles.has(file))
    .map((file) => `${file} is listed for legacy users.restaurant_id reads but no longer matches`),
  ...[...allowedRequestContextAliasFiles.keys()]
    .filter((file) => !matchedRequestContextAliasFiles.has(file))
    .map((file) => `${file} is listed for request-context restaurantId aliases but no longer matches`),
  ...[...allowedRawRequestTenantInputFiles.keys()]
    .filter((file) => !matchedRawRequestTenantInputFiles.has(file))
    .map((file) => `${file} is listed for raw request restaurant-id input but no longer matches`),
];

if (violations.length > 0 || staleAllowlistEntries.length > 0) {
  const details = violations
    .map((v) => `- ${v.file}:${v.line} uses ${v.match}`)
    .join("\n");
  const staleDetails = staleAllowlistEntries.map((entry) => `- ${entry}`).join("\n");
  throw new Error([
    "Direct reads of users.restaurantId are restricted to documented compatibility paths.",
    "Request-context user.restaurantId aliases are also restricted; use requestRestaurant(c), activeRestaurantId, or restaurant-context helpers for tenant-scoped logic.",
    "Raw request restaurant ids (restaurantId, sourceRestaurantId, targetRestaurantId) are restricted to endpoints that explicitly validate membership before switching or acting across context.",
    staleDetails ? "Remove stale tenant-scope allowlist entries:" : "",
    staleDetails,
    details,
  ].filter(Boolean).join("\n"));
}

console.log(`Tenant-scope guard passed (${matchedLegacyColumnFiles.size} legacy-column files, ${matchedRequestContextAliasFiles.size} request-alias files, ${matchedRawRequestTenantInputFiles.size} raw request tenant-input files allowlisted).`);
