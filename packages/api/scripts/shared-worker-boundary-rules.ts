export { forbiddenShareResponseFields } from "../src/test/shared-worker-privacy-fields.js";

export type ShareResponsePrivacyViolation = {
  file: string;
  line: number;
  typeName: string;
  field: string;
};

export type RequiredFragmentViolation = {
  file: string;
  fragment: string;
};

export const shareResponsePrivacyContracts = new Map<string, string[]>([
  ["packages/web/src/lib/api.ts", ["WorkerShareAuthorization", "ShareableWorker"]],
]);

export const staffingWorkerLoadResponsePrivacyContracts = new Map<string, string[]>([
  ["packages/web/src/lib/api.ts", ["WorkerLoad"]],
]);

export const forbiddenStaffingWorkerLoadResponseFields = [
  "sharedFromRestaurantId",
  "sourceRestaurantId",
  "sourceRestaurantName",
  "sourceRestaurantOwnerId",
];

export const sharedWorkerRoutePrivacyRequirements = new Map<string, string[]>([
  [
    "packages/api/src/routes/restaurants.ts",
    [
      "sourceRestaurantId: { new: row.sourceRestaurantId },",
      'changes: { status: { old: "pending", new: "accepted" } },',
      'changes: { status: { old: "pending", new: "revoked" } },',
      "changes: { status: { old: previous?.status ?? null, new: \"revoked\" } },",
    ],
  ],
  [
    "packages/api/src/routes/internal-whatsapp.ts",
    [
      'scope !== "leave" || !w.sharedFromRestaurantId',
      "function activeTeamRosterById(restaurantId: string): Map<string, ActiveTeamRow>",
      "function isVisibleTeamService(rosterById: Map<string, ActiveTeamRow>, service: VisibleTeamService): boolean",
      "function isVisibleWorkerService(worker: Pick<ActiveTeamRow, \"role\" | \"sharedFromRestaurantId\"> | null | undefined, service: Pick<VisibleTeamService, \"role\">): boolean",
      "function isVisibleReplacementRequester(rosterById: Map<string, ActiveTeamRow>, request: { requesterId: string; requesterServiceId?: string | null; restaurantId?: string | null }): boolean",
      "if (!worker.sharedFromRestaurantId) return true;",
      "return worker.role === service.role;",
      ".filter((s) => isVisibleTeamService(rosterById, s))",
      ".filter((s) => isVisibleWorkerService(worker, s))",
      ".filter((service) => isVisibleWorkerService(ownWorkerContext, service))",
      ".filter((request) => isVisibleReplacementRequester(rosterById, request))",
      "if (worker.role !== role) {",
      "if (worker.role !== role) {",
    ],
  ],
  [
    "packages/api/src/routes/cron.ts",
    [
      "restaurantId: restaurantMemberships.restaurantId,",
      ".from(restaurantMemberships)",
      "computeWorkerChecklist(u.id, u.restaurantId)",
      "createOnboardingToken(u.id, u.restaurantId)",
    ],
  ],
  [
    "packages/api/src/routes/schedule.ts",
    [
      "function liveSchedulingRosterById(restaurantId: string): LiveSchedulingRosterById",
      "function isVisibleSchedulingService(rosterById: LiveSchedulingRosterById, service: ScheduleVisibleService): boolean",
      "if (!worker.sharedFromRestaurantId) return true;",
      "return worker.role === service.role;",
      'listSchedulingRosterWorkers(restaurantId, ["manager", "kitchen", "floor"])',
      ".filter((service) => isVisibleSchedulingService(visibleRosterById, service))",
      ".filter((service) => isVisibleSchedulingService(visibleRosterById, service))",
      "allServices = allServices.filter((service) => isVisibleSchedulingService(rosterById, service));",
      "workerRole: rosterById.get(w.id)?.role ?? w.role",
    ],
  ],
  [
    "packages/api/src/routes/services.ts",
    [
      "userCanBeScheduledInRestaurant(parsed.data.workerId, restaurant.restaurantId, [parsed.data.role])",
      "(parsed.data.role && parsed.data.role !== existing.role)",
      "userCanBeScheduledInRestaurant(newWorker, restaurant.restaurantId, [newRole as \"kitchen\" | \"floor\"])",
      "userCanBeScheduledInRestaurant(newWorkerId, restaurant.restaurantId, [existing.role as \"kitchen\" | \"floor\"])",
    ],
  ],
  [
    "packages/api/src/routes/settings.ts",
    [
      "const directOperationalWorkerIds = new Set(",
      'listRestaurantMemberUserIds(user.activeRestaurantId, { roles: ["kitchen", "floor"] })',
      "filterStaffingWhatIfOverrides(contractParsed.value, directOperationalWorkerIds)",
      "filterStaffingWhatIfOverrides(maxWeeklyParsed.value, directOperationalWorkerIds)",
      "filterStaffingRestrictionOverrides(restrictionParsed.value, directOperationalWorkerIds)",
      "filterStaffingWhatIfOverrides(roleParsed.value, directOperationalWorkerIds)",
      "workerLoads: result.workerLoads.map(stripInternalStaffingWorkerLoadFields)",
    ],
  ],
  [
    "packages/api/src/services/optimize-engine.ts",
    [
      "const employmentActionWorkerLoads = workerLoads.filter((worker) => !worker.sharedFromRestaurantId);",
      "for (const w of employmentActionWorkerLoads)",
      "for (const w of employmentActionWorkerLoads)",
      "for (const w of employmentActionWorkerLoads)",
      "for (const w of employmentActionWorkerLoads)",
      "for (const mate of employmentActionWorkerLoads)",
      "const eligible = employmentActionWorkerLoads",
      "const roleWorkers = employmentActionWorkerLoads.filter(w => w.role === role);",
      "const cands = employmentActionWorkerLoads",
    ],
  ],
  [
    "packages/api/src/services/holiday-advice.ts",
    [
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["kitchen", "floor"] });',
    ],
  ],
  [
    "packages/api/src/services/worker-holidays.ts",
    [
      "function assertDirectHolidayMembership(user: AuthUser)",
      "userHasActiveRestaurantMembership(user.id, user.activeRestaurantId)",
      "assertDirectHolidayMembership(user);",
      "assertDirectHolidayMembership(user);",
    ],
  ],
  [
    "packages/api/src/services/worker-preferences.ts",
    [
      "function hasDirectPreferenceMembership(user: AuthUser): boolean",
      "function sharedTargetProfile(user: AuthUser)",
      "workerRestaurantProfiles.contractHours",
      "workerRestaurantProfiles.maxWeeklyHours",
      "input.maxWeeklyHours !== undefined && hasDirectMembership",
      "input.maxWeeklyHours !== undefined && !hasDirectMembership",
    ],
  ],
  [
    "packages/api/src/services/worker-replacements.ts",
    [
      "import { userCanBeScheduledInRestaurant } from \"./restaurant-context.js\";",
      "date: services.date",
      "startTime: services.startTime",
      "endTime: services.endTime",
      "role: services.role",
      "role: service.role as \"kitchen\" | \"floor\"",
      "role: services.role }).from(services)",
      "if (!userCanBeScheduledInRestaurant(user.id, user.activeRestaurantId, [sib.role as \"kitchen\" | \"floor\"])) continue;",
      "notifyAdminReplacementCandidates(",
    ],
  ],
  [
    "packages/api/src/routes/holidays.ts",
    [
      'userHasActiveRestaurantMembership(parsed.data.workerId, restaurant.restaurantId, ["kitchen", "floor"])',
      'userHasActiveRestaurantMembership(workerId, restaurant.restaurantId, ["kitchen", "floor"])',
    ],
  ],
  [
    "packages/api/src/services/payroll.ts",
    [
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });',
    ],
  ],
  [
    "packages/api/src/services/dpae-export.ts",
    [
      'const memberIds = new Set(listRestaurantMemberUserIds(input.restaurantId, { roles: ["manager", "kitchen", "floor"] }));',
      "const workerIds = input.workerIds.filter((id) => memberIds.has(id));",
    ],
  ],
  [
    "packages/api/src/services/monthly-digest.ts",
    [
      'const memberIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"] });',
      "inArray(users.id, memberIds)",
      'inArray(users.contractType, ["CDD", "saisonnier"])',
    ],
  ],
  [
    "packages/api/src/services/notifications.ts",
    [
      ".from(restaurantMemberships)",
      "eq(restaurantMemberships.restaurantId, restaurantId)",
      'if (membershipRows.length > 0 || columnExists("restaurants", "owner_id")) return membershipRows;',
      "function isOpenShiftCandidateStillEligible(shift: typeof openShifts.$inferSelect, workerId: string): boolean",
      "if (!isOpenShiftCandidateStillEligible(shift, targetedCandidateId))",
      "const nextId = candidateIds.find((id) => !rejected.has(id) && !solicited.has(id) && isOpenShiftCandidateStillEligible(shift, id));",
    ],
  ],
  [
    "packages/api/src/routes/users.ts",
    [
      'const workerIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: ["manager", "kitchen", "floor"] });',
      "function verifyUserInRestaurant(userId: string, restaurantId: string): boolean",
      "return !!row && userHasActiveRestaurantMembership(userId, restaurantId);",
      "function verifyUserMembershipInRestaurant(userId: string, restaurantId: string): boolean",
      "return !!row && userHasRestaurantMembership(userId, restaurantId);",
      "eq(documents.restaurantId, restaurant.restaurantId)",
      "const roster = listSchedulingRosterWorkers(restaurant.restaurantId, [\"kitchen\", \"floor\"]);",
    ],
  ],
  [
    "packages/api/src/services/onboarding-checklist.ts",
    [
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"] });',
    ],
  ],
  [
    "packages/api/src/services/compliance.ts",
    [
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });',
      'for (const worker of listSchedulingRosterWorkers(restaurantId, ["kitchen", "floor"]))',
      "if (knownWorkerIds.has(worker.id)) continue;",
      "adminOtOverride: null",
    ],
  ],
  [
    "packages/api/src/services/timeclock-actions.ts",
    [
      "function isVisibleOwnService(user: AuthUser, service: { role: string }): boolean",
      "userHasActiveRestaurantMembership(user.id, user.activeRestaurantId)",
      "return user.role === service.role;",
      "function closestServiceForClockIn(user: AuthUser, now: Date): string | null",
      "const [admin] = adminRecipientsForRestaurant(restaurantId);",
      "message: messageWithRestaurantContext(admin.id, restaurantId, message),",
      "eq(services.restaurantId, user.activeRestaurantId)",
      "eq(timeClocks.restaurantId, user.activeRestaurantId)",
      "restaurantId: user.activeRestaurantId,",
      'source: options.source ?? "dashboard",',
    ],
  ],
  [
    "packages/api/src/routes/timeclock.ts",
    [
      'adminRecipientsForRestaurant(restaurantId, ["admin"])',
      "message: messageWithRestaurantContext(admin.id, restaurantId, message)",
      "const restaurant = requestRestaurant(c);",
      "eq(timeClocks.restaurantId, restaurant.restaurantId)",
    ],
  ],
]);

export const sharedWorkerToolPrivacyRequirements = new Map<string, string[]>([
  [
    "packages/whatsapp/src/tools/admin.ts",
    [
      'resolveInternalWorker(args.worker_name as string, "leave", ctx)',
      'resolveInternalWorker(args.worker_name as string, "leave", ctx)',
    ],
  ],
]);

import { forbiddenShareResponseFields } from "../src/test/shared-worker-privacy-fields.js";

export function lineNumberForIndex(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

export function extractTypeBody(text: string, typeName: string): { body: string; index: number } | null {
  const typeStartPattern = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{`, "g");
  const match = typeStartPattern.exec(text);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const bodyEnd = text.indexOf("\n};", bodyStart);
  if (bodyEnd === -1) return null;
  return { body: text.slice(bodyStart, bodyEnd), index: bodyStart };
}

export function findShareResponsePrivacyViolations(file: string, text: string) {
  const protectedShareTypes = shareResponsePrivacyContracts.get(file);
  const violations: ShareResponsePrivacyViolation[] = [];
  const matchedContracts = new Set<string>();
  const missingContracts: string[] = [];

  if (!protectedShareTypes) return { violations, matchedContracts, missingContracts };

  for (const typeName of protectedShareTypes) {
    const typeBody = extractTypeBody(text, typeName);
    if (!typeBody) {
      missingContracts.push(`${file}:${typeName}`);
      continue;
    }
    matchedContracts.add(`${file}:${typeName}`);
    for (const field of forbiddenShareResponseFields) {
      const fieldPattern = new RegExp(`\\b${field}\\??\\s*:`);
      if (fieldPattern.test(typeBody.body)) {
        violations.push({
          file,
          line: lineNumberForIndex(text, typeBody.index),
          typeName,
          field,
        });
      }
    }
  }

  return { violations, matchedContracts, missingContracts };
}

export function findStaffingWorkerLoadResponsePrivacyViolations(file: string, text: string) {
  const protectedTypes = staffingWorkerLoadResponsePrivacyContracts.get(file);
  const violations: ShareResponsePrivacyViolation[] = [];
  const matchedContracts = new Set<string>();
  const missingContracts: string[] = [];

  if (!protectedTypes) return { violations, matchedContracts, missingContracts };

  for (const typeName of protectedTypes) {
    const typeBody = extractTypeBody(text, typeName);
    if (!typeBody) {
      missingContracts.push(`${file}:${typeName}`);
      continue;
    }
    matchedContracts.add(`${file}:${typeName}`);
    for (const field of forbiddenStaffingWorkerLoadResponseFields) {
      const fieldPattern = new RegExp(`\\b${field}\\??\\s*:`);
      if (fieldPattern.test(typeBody.body)) {
        violations.push({
          file,
          line: lineNumberForIndex(text, typeBody.index),
          typeName,
          field,
        });
      }
    }
  }

  return { violations, matchedContracts, missingContracts };
}

export function findRequiredFragmentViolations(
  file: string,
  text: string,
  requirements = sharedWorkerRoutePrivacyRequirements,
): RequiredFragmentViolation[] {
  const requiredFragments = requirements.get(file) ?? [];
  const expectedCounts = new Map<string, number>();
  for (const fragment of requiredFragments) {
    expectedCounts.set(fragment, (expectedCounts.get(fragment) ?? 0) + 1);
  }

  const violations: RequiredFragmentViolation[] = [];
  for (const [fragment, expectedCount] of expectedCounts) {
    let count = 0;
    let index = text.indexOf(fragment);
    while (index !== -1) {
      count += 1;
      index = text.indexOf(fragment, index + fragment.length);
    }
    if (count < expectedCount) {
      violations.push({ file, fragment });
    }
  }
  return violations;
}
