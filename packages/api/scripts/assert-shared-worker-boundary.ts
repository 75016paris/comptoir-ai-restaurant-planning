import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  findRequiredFragmentViolations,
  findShareResponsePrivacyViolations,
  findStaffingWorkerLoadResponsePrivacyViolations,
  sharedWorkerRoutePrivacyRequirements,
  sharedWorkerToolPrivacyRequirements,
  shareResponsePrivacyContracts,
  staffingWorkerLoadResponsePrivacyContracts,
} from "./shared-worker-boundary-rules.js";

const repoRoot = path.resolve(import.meta.dir, "../../..");

const scanRoots = [
  "packages/api/src",
  "packages/api/drizzle",
  "packages/shared/src",
  "packages/web/src",
  "packages/whatsapp/src",
];

const preferencePatterns = [
  /\bmultiRestaurantWilling\b/g,
  /\bmulti_restaurant_willing\b/g,
];

const broadScheduleEligibilityPattern =
  /userCanBeScheduledInRestaurant\([\s\S]{0,240}\[\s*["']kitchen["']\s*,\s*["']floor["']\s*\]/g;
const acceptedShareTablePattern = /\b(?:worker_share_authorizations|workerShareAuthorizations)\b/;
const acceptedShareStatusPattern = /(?:wsa\.status\s*=\s*'accepted'|workerShareAuthorizations\.status,\s*["']accepted["']|status:\s*["']accepted["'])/;

const allowedFiles = new Map<string, string>([
  ["packages/api/drizzle/0059_coupure_multi_resto.sql", "legacy preference column migration"],
  ["packages/api/drizzle/0115_multi_restaurant_foundation.sql", "profile preference backfill into the v2 compatibility table"],
  ["packages/api/drizzle/phase7/owner/0000_owner_baseline.sql", "Phase 7 owner baseline preserves the profile preference as data, not eligibility"],
  ["packages/api/src/db/phase7-core-snapshot.ts", "Phase 7 snapshot copies the profile preference as data, not eligibility"],
  ["packages/api/src/db/schema.ts", "schema exposes the preference on users and worker_restaurant_profiles"],
  ["packages/api/src/routes/users.ts", "profile read/write payload exposes the worker preference only"],
  ["packages/api/src/services/baseline-cache.ts", "cache fingerprint includes scheduling-relevant worker preferences"],
  ["packages/api/src/services/replacement-candidates.ts", "candidate payload can surface the preference, but restaurant membership still gates eligibility"],
  ["packages/shared/src/validation.ts", "API validation accepts profile preference edits"],
  ["packages/web/src/lib/api.ts", "typed API client exposes profile preference fields"],
]);

const allowedAcceptedShareLifecycleFiles = new Map<string, string>([
  ["packages/api/src/routes/restaurants.ts", "worker-share invite/accept/revoke route orchestration"],
  ["packages/api/src/services/worker-sharing.ts", "worker-share lifecycle service, not scheduling eligibility"],
]);

const acceptedShareEligibilityRequirements = new Map<string, string[]>([
  ["packages/api/src/services/baseline-cache.ts", [
    "INNER JOIN owner_memberships om",
    "INNER JOIN restaurant_memberships source_membership",
    "source_membership.role = wsa.role",
    "source_membership.active = 1",
    "INNER JOIN worker_restaurant_profiles target_profile",
    "wsa.status = 'accepted'",
    "wsa.worker_consented_at IS NOT NULL",
    "wsa.revoked_at IS NULL",
    "u.active = 1",
    "target_restaurant.owner_id = wsa.owner_id",
    "source_restaurant.owner_id = wsa.owner_id",
    "NOT EXISTS (",
    "local_membership.active = 1",
  ]],
  ["packages/api/src/services/restaurant-context.ts", [
    "INNER JOIN owner_memberships om",
    "INNER JOIN restaurant_memberships source_membership",
    "source_membership.role = wsa.role",
    "source_membership.active = 1",
    "INNER JOIN worker_restaurant_profiles target_profile",
    "wsa.status = 'accepted'",
    "wsa.worker_consented_at IS NOT NULL",
    "wsa.revoked_at IS NULL",
    "u.active = 1",
    "target_restaurant.owner_id = wsa.owner_id",
    "source_restaurant.owner_id = wsa.owner_id",
    "NOT EXISTS (",
    "local_membership.active = 1",
  ]],
  ["packages/api/src/services/notifications.ts", [
    "INNER JOIN owner_memberships owner_membership",
    "INNER JOIN restaurant_memberships source_membership",
    "source_membership.role = wsa.role",
    "source_membership.active = 1",
    "INNER JOIN worker_restaurant_profiles target_profile",
    "wsa.status = 'accepted'",
    "wsa.worker_consented_at IS NOT NULL",
    "wsa.revoked_at IS NULL",
    "recipient.active = 1",
    "target_restaurant.owner_id = wsa.owner_id",
    "source_restaurant.owner_id = wsa.owner_id",
    "NOT EXISTS (",
    "local_membership.active = 1",
    'listSchedulingRosterWorkers(restaurantId, ["kitchen", "floor"])',
    "const rosterById = new Map(listSchedulingRosterWorkers(restaurantId, [\"kitchen\", \"floor\"]).map((worker) => [worker.id, worker]));",
    "if (!worker.sharedFromRestaurantId) return true;",
    "return worker.role === row.role;",
  ]],
  ["packages/api/src/services/replacement-candidates.ts", [
    "innerJoin(ownerMemberships",
    "innerJoin(workerRestaurantProfiles",
    "innerJoin(restaurantMemberships",
    "eq(restaurantMemberships.role, workerShareAuthorizations.role)",
    "eq(restaurantMemberships.active, true)",
    "eq(workerShareAuthorizations.ownerId, restaurant.ownerId)",
    "eq(workerShareAuthorizations.status, \"accepted\")",
    "isNotNull(workerShareAuthorizations.workerConsentedAt)",
    "isNull(workerShareAuthorizations.revokedAt)",
    "eq(users.active, true)",
    "!targetMemberIds.has",
    "ownerRestaurantIds.includes",
  ]],
  ["packages/api/src/routes/autostaffing.ts", [
    "innerJoin(ownerMemberships",
    "innerJoin(workerRestaurantProfiles",
    "innerJoin(restaurantMemberships",
    "eq(restaurantMemberships.role, workerShareAuthorizations.role)",
    "eq(restaurantMemberships.active, true)",
    "eq(workerShareAuthorizations.ownerId, restaurant.ownerId)",
    "eq(workerShareAuthorizations.status, \"accepted\")",
    "isNotNull(workerShareAuthorizations.workerConsentedAt)",
    "isNull(workerShareAuthorizations.revokedAt)",
    "eq(users.active, true)",
    "!targetMemberIds.has",
    "ownerRestaurantIds.includes",
  ]],
]);

async function listFiles(dir: string): Promise<string[]> {
  const fullDir = path.join(repoRoot, dir);
  const entries = await readdir(fullDir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(fullDir, entry.name);
    if (entry.isDirectory()) return listFiles(path.relative(repoRoot, fullPath));
    if (!entry.isFile()) return [];
    if (!/\.(ts|tsx|sql)$/.test(entry.name)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [fullPath];
  }));
  return files.flat();
}

function lineNumberForIndex(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

const violations: Array<{ file: string; line: number; match: string }> = [];
const broadEligibilityViolations: Array<{ file: string; line: number }> = [];
const acceptedShareViolations: string[] = [];
const shareResponsePrivacyViolations: string[] = [];
const staffingWorkerLoadPrivacyViolations: string[] = [];
const routePrivacyViolations: string[] = [];
const toolPrivacyViolations: string[] = [];
const matchedAllowedFiles = new Set<string>();
const matchedAcceptedShareEligibilityFiles = new Set<string>();
const matchedShareResponsePrivacyContracts = new Set<string>();
const matchedStaffingWorkerLoadPrivacyContracts = new Set<string>();
const matchedRoutePrivacyRequirementFiles = new Set<string>();
const matchedToolPrivacyRequirementFiles = new Set<string>();

for (const root of scanRoots) {
  for (const file of await listFiles(root)) {
    const relative = path.relative(repoRoot, file);
    const text = await readFile(file, "utf8");

    for (const pattern of preferencePatterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (allowedFiles.has(relative)) {
          matchedAllowedFiles.add(relative);
        } else {
          violations.push({
            file: relative,
            line: lineNumberForIndex(text, match.index ?? 0),
            match: match[0],
          });
        }
      }
    }

    const shareResponsePrivacyResult = findShareResponsePrivacyViolations(relative, text);
    for (const matched of shareResponsePrivacyResult.matchedContracts) {
      matchedShareResponsePrivacyContracts.add(matched);
    }
    for (const missing of shareResponsePrivacyResult.missingContracts) {
      shareResponsePrivacyViolations.push(`${missing} is missing protected share response type`);
    }
    for (const violation of shareResponsePrivacyResult.violations) {
      shareResponsePrivacyViolations.push(
        `${violation.file}:${violation.line} exposes forbidden field ${violation.field} on ${violation.typeName}`,
      );
    }

    const staffingWorkerLoadPrivacyResult = findStaffingWorkerLoadResponsePrivacyViolations(relative, text);
    for (const matched of staffingWorkerLoadPrivacyResult.matchedContracts) {
      matchedStaffingWorkerLoadPrivacyContracts.add(matched);
    }
    for (const missing of staffingWorkerLoadPrivacyResult.missingContracts) {
      staffingWorkerLoadPrivacyViolations.push(`${missing} is missing protected staffing worker-load response type`);
    }
    for (const violation of staffingWorkerLoadPrivacyResult.violations) {
      staffingWorkerLoadPrivacyViolations.push(
        `${violation.file}:${violation.line} exposes forbidden field ${violation.field} on ${violation.typeName}`,
      );
    }

    const routePrivacyResult = findRequiredFragmentViolations(relative, text);
    if (sharedWorkerRoutePrivacyRequirements.has(relative)) {
      matchedRoutePrivacyRequirementFiles.add(relative);
    }
    for (const violation of routePrivacyResult) {
      routePrivacyViolations.push(`${violation.file} is missing required shared-worker route privacy fragment: ${violation.fragment}`);
    }

    const toolPrivacyResult = findRequiredFragmentViolations(relative, text, sharedWorkerToolPrivacyRequirements);
    if (sharedWorkerToolPrivacyRequirements.has(relative)) {
      matchedToolPrivacyRequirementFiles.add(relative);
    }
    for (const violation of toolPrivacyResult) {
      toolPrivacyViolations.push(`${violation.file} is missing required shared-worker tool privacy fragment: ${violation.fragment}`);
    }

    broadScheduleEligibilityPattern.lastIndex = 0;
    for (const match of text.matchAll(broadScheduleEligibilityPattern)) {
      broadEligibilityViolations.push({
        file: relative,
        line: lineNumberForIndex(text, match.index ?? 0),
      });
    }

    if (acceptedShareTablePattern.test(text) && acceptedShareStatusPattern.test(text)) {
      const requirements = acceptedShareEligibilityRequirements.get(relative);
      if (requirements) {
        matchedAcceptedShareEligibilityFiles.add(relative);
        const missing = requirements.filter((fragment) => !text.includes(fragment));
        if (missing.length > 0) {
          acceptedShareViolations.push([
            `${relative} is missing required accepted-share eligibility/context checks:`,
            ...missing.map((fragment) => `  - ${fragment}`),
          ].join("\n"));
        }
      } else if (!allowedAcceptedShareLifecycleFiles.has(relative)) {
        acceptedShareViolations.push(`${relative} reads accepted worker shares but is not classified as eligibility/context or lifecycle code`);
      }
    }
  }
}

const staleAllowlistEntries = [...allowedFiles.keys()]
  .filter((file) => !matchedAllowedFiles.has(file))
  .map((file) => `${file} is listed for multiRestaurantWilling usage but no longer matches`);
const staleAcceptedShareEligibilityEntries = [...acceptedShareEligibilityRequirements.keys()]
  .filter((file) => !matchedAcceptedShareEligibilityFiles.has(file))
  .map((file) => `${file} is listed for accepted-share eligibility checks but no longer reads accepted worker shares`);
const staleShareResponsePrivacyEntries = [...shareResponsePrivacyContracts.entries()]
  .flatMap(([file, typeNames]) => typeNames.map((typeName) => `${file}:${typeName}`))
  .filter((entry) => !matchedShareResponsePrivacyContracts.has(entry))
  .map((entry) => `${entry} is listed for share-response privacy checks but no longer matches`);
const staleStaffingWorkerLoadPrivacyEntries = [...staffingWorkerLoadResponsePrivacyContracts.entries()]
  .flatMap(([file, typeNames]) => typeNames.map((typeName) => `${file}:${typeName}`))
  .filter((entry) => !matchedStaffingWorkerLoadPrivacyContracts.has(entry))
  .map((entry) => `${entry} is listed for staffing worker-load privacy checks but no longer matches`);
const staleRoutePrivacyEntries = [...sharedWorkerRoutePrivacyRequirements.keys()]
  .filter((file) => !matchedRoutePrivacyRequirementFiles.has(file))
  .map((file) => `${file} is listed for shared-worker route privacy checks but was not scanned`);
const staleToolPrivacyEntries = [...sharedWorkerToolPrivacyRequirements.keys()]
  .filter((file) => !matchedToolPrivacyRequirementFiles.has(file))
  .map((file) => `${file} is listed for shared-worker tool privacy checks but was not scanned`);

if (
  violations.length > 0
  || staleAllowlistEntries.length > 0
  || broadEligibilityViolations.length > 0
  || acceptedShareViolations.length > 0
  || staleAcceptedShareEligibilityEntries.length > 0
  || shareResponsePrivacyViolations.length > 0
  || staleShareResponsePrivacyEntries.length > 0
  || staffingWorkerLoadPrivacyViolations.length > 0
  || staleStaffingWorkerLoadPrivacyEntries.length > 0
  || routePrivacyViolations.length > 0
  || staleRoutePrivacyEntries.length > 0
  || toolPrivacyViolations.length > 0
  || staleToolPrivacyEntries.length > 0
) {
  const details = violations
    .map((v) => `- ${v.file}:${v.line} uses ${v.match}`)
    .join("\n");
  const staleDetails = staleAllowlistEntries.map((entry) => `- ${entry}`).join("\n");
  const broadEligibilityDetails = broadEligibilityViolations
    .map((v) => `- ${v.file}:${v.line} calls userCanBeScheduledInRestaurant with broad kitchen/floor roles`)
    .join("\n");
  const acceptedShareDetails = acceptedShareViolations.map((entry) => `- ${entry}`).join("\n");
  const staleAcceptedShareDetails = staleAcceptedShareEligibilityEntries.map((entry) => `- ${entry}`).join("\n");
  const shareResponsePrivacyDetails = shareResponsePrivacyViolations.map((entry) => `- ${entry}`).join("\n");
  const staleShareResponsePrivacyDetails = staleShareResponsePrivacyEntries.map((entry) => `- ${entry}`).join("\n");
  const staffingWorkerLoadPrivacyDetails = staffingWorkerLoadPrivacyViolations.map((entry) => `- ${entry}`).join("\n");
  const staleStaffingWorkerLoadPrivacyDetails = staleStaffingWorkerLoadPrivacyEntries.map((entry) => `- ${entry}`).join("\n");
  const routePrivacyDetails = routePrivacyViolations.map((entry) => `- ${entry}`).join("\n");
  const staleRoutePrivacyDetails = staleRoutePrivacyEntries.map((entry) => `- ${entry}`).join("\n");
  const toolPrivacyDetails = toolPrivacyViolations.map((entry) => `- ${entry}`).join("\n");
  const staleToolPrivacyDetails = staleToolPrivacyEntries.map((entry) => `- ${entry}`).join("\n");
  throw new Error([
    "`multiRestaurantWilling` is a worker preference only, not shared-worker authorization.",
    "Do not use it to make a worker eligible in another restaurant without an explicit Phase 6 share/consent model.",
    broadEligibilityDetails ? "Use exact service/request roles when validating shared-worker scheduling eligibility:" : "",
    broadEligibilityDetails,
    acceptedShareDetails ? "Accepted worker-share eligibility/context reads must keep the full boundary shape:" : "",
    acceptedShareDetails,
    shareResponsePrivacyDetails ? "Worker-share response contracts must stay scheduling-identity only:" : "",
    shareResponsePrivacyDetails,
    staffingWorkerLoadPrivacyDetails ? "Staffing worker-load response contracts must not expose shared-worker source context:" : "",
    staffingWorkerLoadPrivacyDetails,
    routePrivacyDetails ? "Shared-worker route privacy fragments must stay in place:" : "",
    routePrivacyDetails,
    toolPrivacyDetails ? "Shared-worker WhatsApp tool privacy fragments must stay in place:" : "",
    toolPrivacyDetails,
    staleDetails ? "Remove stale shared-worker boundary allowlist entries:" : "",
    staleDetails,
    staleAcceptedShareDetails ? "Remove stale accepted worker-share eligibility entries:" : "",
    staleAcceptedShareDetails,
    staleShareResponsePrivacyDetails ? "Remove stale worker-share response privacy entries:" : "",
    staleShareResponsePrivacyDetails,
    staleStaffingWorkerLoadPrivacyDetails ? "Remove stale staffing worker-load privacy entries:" : "",
    staleStaffingWorkerLoadPrivacyDetails,
    staleRoutePrivacyDetails ? "Remove stale shared-worker route privacy entries:" : "",
    staleRoutePrivacyDetails,
    staleToolPrivacyDetails ? "Remove stale shared-worker tool privacy entries:" : "",
    staleToolPrivacyDetails,
    details,
  ].filter(Boolean).join("\n"));
}

console.log(`Shared-worker boundary guard passed (${matchedAllowedFiles.size} preference files allowlisted, ${matchedAcceptedShareEligibilityFiles.size} accepted-share eligibility/context files guarded, ${matchedShareResponsePrivacyContracts.size} share response contracts guarded, ${matchedStaffingWorkerLoadPrivacyContracts.size} staffing worker-load contracts guarded, ${matchedRoutePrivacyRequirementFiles.size} route privacy files guarded, ${matchedToolPrivacyRequirementFiles.size} tool privacy files guarded, exact role eligibility enforced).`);
