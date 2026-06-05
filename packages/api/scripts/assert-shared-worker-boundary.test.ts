import { describe, expect, test } from "bun:test";
import {
  extractTypeBody,
  findStaffingWorkerLoadResponsePrivacyViolations,
  findRequiredFragmentViolations,
  findShareResponsePrivacyViolations,
  forbiddenStaffingWorkerLoadResponseFields,
  forbiddenShareResponseFields,
  sharedWorkerRoutePrivacyRequirements,
  sharedWorkerToolPrivacyRequirements,
  shareResponsePrivacyContracts,
  staffingWorkerLoadResponsePrivacyContracts,
} from "./shared-worker-boundary-rules.js";

const webApiFile = "packages/web/src/lib/api.ts";
const restaurantsRouteFile = "packages/api/src/routes/restaurants.ts";
const internalWhatsappFile = "packages/api/src/routes/internal-whatsapp.ts";
const cronRouteFile = "packages/api/src/routes/cron.ts";
const scheduleFile = "packages/api/src/routes/schedule.ts";
const servicesFile = "packages/api/src/routes/services.ts";
const settingsFile = "packages/api/src/routes/settings.ts";
const optimizeEngineFile = "packages/api/src/services/optimize-engine.ts";
const holidayAdviceFile = "packages/api/src/services/holiday-advice.ts";
const workerHolidaysServiceFile = "packages/api/src/services/worker-holidays.ts";
const workerPreferencesServiceFile = "packages/api/src/services/worker-preferences.ts";
const workerReplacementsServiceFile = "packages/api/src/services/worker-replacements.ts";
const holidaysRouteFile = "packages/api/src/routes/holidays.ts";
const payrollServiceFile = "packages/api/src/services/payroll.ts";
const dpaeExportServiceFile = "packages/api/src/services/dpae-export.ts";
const monthlyDigestServiceFile = "packages/api/src/services/monthly-digest.ts";
const notificationsServiceFile = "packages/api/src/services/notifications.ts";
const usersRouteFile = "packages/api/src/routes/users.ts";
const onboardingChecklistServiceFile = "packages/api/src/services/onboarding-checklist.ts";
const complianceServiceFile = "packages/api/src/services/compliance.ts";
const timeclockActionsServiceFile = "packages/api/src/services/timeclock-actions.ts";
const timeclockRouteFile = "packages/api/src/routes/timeclock.ts";
const whatsappAdminToolsFile = "packages/whatsapp/src/tools/admin.ts";

describe("shared-worker boundary rules", () => {
  test("pins the web worker-share response contracts", () => {
    expect(shareResponsePrivacyContracts.get(webApiFile)).toEqual([
      "WorkerShareAuthorization",
      "ShareableWorker",
    ]);
    expect(staffingWorkerLoadResponsePrivacyContracts.get(webApiFile)).toEqual([
      "WorkerLoad",
    ]);
  });

  test("pins route-level shared-worker privacy requirements", () => {
    expect(sharedWorkerRoutePrivacyRequirements.get(restaurantsRouteFile)).toEqual([
      "sourceRestaurantId: { new: row.sourceRestaurantId },",
      'changes: { status: { old: "pending", new: "accepted" } },',
      'changes: { status: { old: "pending", new: "revoked" } },',
      "changes: { status: { old: previous?.status ?? null, new: \"revoked\" } },",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(internalWhatsappFile)).toEqual([
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
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(cronRouteFile)).toEqual([
      "restaurantId: restaurantMemberships.restaurantId,",
      ".from(restaurantMemberships)",
      "computeWorkerChecklist(u.id, u.restaurantId)",
      "createOnboardingToken(u.id, u.restaurantId)",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(scheduleFile)).toEqual([
      "function liveSchedulingRosterById(restaurantId: string): LiveSchedulingRosterById",
      "function isVisibleSchedulingService(rosterById: LiveSchedulingRosterById, service: ScheduleVisibleService): boolean",
      "if (!worker.sharedFromRestaurantId) return true;",
      "return worker.role === service.role;",
      'listSchedulingRosterWorkers(restaurantId, ["manager", "kitchen", "floor"])',
      ".filter((service) => isVisibleSchedulingService(visibleRosterById, service))",
      ".filter((service) => isVisibleSchedulingService(visibleRosterById, service))",
      "allServices = allServices.filter((service) => isVisibleSchedulingService(rosterById, service));",
      "workerRole: rosterById.get(w.id)?.role ?? w.role",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(servicesFile)).toEqual([
      "userCanBeScheduledInRestaurant(parsed.data.workerId, restaurant.restaurantId, [parsed.data.role])",
      "(parsed.data.role && parsed.data.role !== existing.role)",
      "userCanBeScheduledInRestaurant(newWorker, restaurant.restaurantId, [newRole as \"kitchen\" | \"floor\"])",
      "userCanBeScheduledInRestaurant(newWorkerId, restaurant.restaurantId, [existing.role as \"kitchen\" | \"floor\"])",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(settingsFile)).toEqual([
      "const directOperationalWorkerIds = new Set(",
      'listRestaurantMemberUserIds(user.activeRestaurantId, { roles: ["kitchen", "floor"] })',
      "filterStaffingWhatIfOverrides(contractParsed.value, directOperationalWorkerIds)",
      "filterStaffingWhatIfOverrides(maxWeeklyParsed.value, directOperationalWorkerIds)",
      "filterStaffingRestrictionOverrides(restrictionParsed.value, directOperationalWorkerIds)",
      "filterStaffingWhatIfOverrides(roleParsed.value, directOperationalWorkerIds)",
      "workerLoads: result.workerLoads.map(stripInternalStaffingWorkerLoadFields)",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(optimizeEngineFile)).toEqual([
      "const employmentActionWorkerLoads = workerLoads.filter((worker) => !worker.sharedFromRestaurantId);",
      "for (const w of employmentActionWorkerLoads)",
      "for (const w of employmentActionWorkerLoads)",
      "for (const w of employmentActionWorkerLoads)",
      "for (const w of employmentActionWorkerLoads)",
      "for (const mate of employmentActionWorkerLoads)",
      "const eligible = employmentActionWorkerLoads",
      "const roleWorkers = employmentActionWorkerLoads.filter(w => w.role === role);",
      "const cands = employmentActionWorkerLoads",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(holidayAdviceFile)).toEqual([
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["kitchen", "floor"] });',
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(workerHolidaysServiceFile)).toEqual([
      "function assertDirectHolidayMembership(user: AuthUser)",
      "userHasActiveRestaurantMembership(user.id, user.activeRestaurantId)",
      "assertDirectHolidayMembership(user);",
      "assertDirectHolidayMembership(user);",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(workerPreferencesServiceFile)).toEqual([
      "function hasDirectPreferenceMembership(user: AuthUser): boolean",
      "function sharedTargetProfile(user: AuthUser)",
      "workerRestaurantProfiles.contractHours",
      "workerRestaurantProfiles.maxWeeklyHours",
      "input.maxWeeklyHours !== undefined && hasDirectMembership",
      "input.maxWeeklyHours !== undefined && !hasDirectMembership",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(workerReplacementsServiceFile)).toEqual([
      "import { userCanBeScheduledInRestaurant } from \"./restaurant-context.js\";",
      "date: services.date",
      "startTime: services.startTime",
      "endTime: services.endTime",
      "role: services.role",
      "role: service.role as \"kitchen\" | \"floor\"",
      "role: services.role }).from(services)",
      "if (!userCanBeScheduledInRestaurant(user.id, user.activeRestaurantId, [sib.role as \"kitchen\" | \"floor\"])) continue;",
      "notifyAdminReplacementCandidates(",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(holidaysRouteFile)).toEqual([
      'userHasActiveRestaurantMembership(parsed.data.workerId, restaurant.restaurantId, ["kitchen", "floor"])',
      'userHasActiveRestaurantMembership(workerId, restaurant.restaurantId, ["kitchen", "floor"])',
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(payrollServiceFile)).toEqual([
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });',
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(dpaeExportServiceFile)).toEqual([
      'const memberIds = new Set(listRestaurantMemberUserIds(input.restaurantId, { roles: ["manager", "kitchen", "floor"] }));',
      "const workerIds = input.workerIds.filter((id) => memberIds.has(id));",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(monthlyDigestServiceFile)).toEqual([
      'const memberIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"] });',
      "inArray(users.id, memberIds)",
      'inArray(users.contractType, ["CDD", "saisonnier"])',
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(notificationsServiceFile)).toEqual([
      ".from(restaurantMemberships)",
      "eq(restaurantMemberships.restaurantId, restaurantId)",
      'if (membershipRows.length > 0 || columnExists("restaurants", "owner_id")) return membershipRows;',
      "function isOpenShiftCandidateStillEligible(shift: typeof openShifts.$inferSelect, workerId: string): boolean",
      "if (!isOpenShiftCandidateStillEligible(shift, targetedCandidateId))",
      "const nextId = candidateIds.find((id) => !rejected.has(id) && !solicited.has(id) && isOpenShiftCandidateStillEligible(shift, id));",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(usersRouteFile)).toEqual([
      'const workerIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: ["manager", "kitchen", "floor"] });',
      "function verifyUserInRestaurant(userId: string, restaurantId: string): boolean",
      "return !!row && userHasActiveRestaurantMembership(userId, restaurantId);",
      "function verifyUserMembershipInRestaurant(userId: string, restaurantId: string): boolean",
      "return !!row && userHasRestaurantMembership(userId, restaurantId);",
      "eq(documents.restaurantId, restaurant.restaurantId)",
      "const roster = listSchedulingRosterWorkers(restaurant.restaurantId, [\"kitchen\", \"floor\"]);",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(onboardingChecklistServiceFile)).toEqual([
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"] });',
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(complianceServiceFile)).toEqual([
      'const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });',
      'for (const worker of listSchedulingRosterWorkers(restaurantId, ["kitchen", "floor"]))',
      "if (knownWorkerIds.has(worker.id)) continue;",
      "adminOtOverride: null",
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(timeclockActionsServiceFile)).toEqual([
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
    ]);
    expect(sharedWorkerRoutePrivacyRequirements.get(timeclockRouteFile)).toEqual([
      'adminRecipientsForRestaurant(restaurantId, ["admin"])',
      "message: messageWithRestaurantContext(admin.id, restaurantId, message)",
      "const restaurant = requestRestaurant(c);",
      "eq(timeClocks.restaurantId, restaurant.restaurantId)",
    ]);
  });

  test("pins WhatsApp leave-tool privacy requirements", () => {
    expect(sharedWorkerToolPrivacyRequirements.get(whatsappAdminToolsFile)).toEqual([
      'resolveInternalWorker(args.worker_name as string, "leave", ctx)',
      'resolveInternalWorker(args.worker_name as string, "leave", ctx)',
    ]);
  });

  test("allows scheduling-identity-only worker-share response fields", () => {
    const text = `
export type WorkerShareAuthorization = {
  id: string;
  ownerId: string;
  sourceRestaurantId: string;
  sourceRestaurantName?: string;
  targetRestaurantId: string;
  targetRestaurantName?: string;
  userId: string;
  workerName?: string;
  role: "kitchen" | "floor";
  status: "pending" | "accepted" | "revoked";
  invitedByUserId: string;
  workerConsentedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ShareableWorker = {
  id: string;
  name: string;
  role: "kitchen" | "floor";
  sourceRestaurantId: string;
  sourceRestaurantName: string;
};
`;

    const result = findShareResponsePrivacyViolations(webApiFile, text);

    expect(result.missingContracts).toEqual([]);
    expect([...result.matchedContracts].sort()).toEqual([
      `${webApiFile}:ShareableWorker`,
      `${webApiFile}:WorkerShareAuthorization`,
    ]);
    expect(result.violations).toEqual([]);
  });

  test("detects sensitive fields added to worker-share response contracts", () => {
    const text = `
export type WorkerShareAuthorization = {
  id: string;
  userId: string;
  workerName?: string;
  email?: string;
  hourlyRate?: number | null;
};

export type ShareableWorker = {
  id: string;
  name: string;
  role: "kitchen" | "floor";
  phone?: string;
  managerNotes?: string | null;
  documentCount?: number;
  medical?: boolean;
};
`;

    const result = findShareResponsePrivacyViolations(webApiFile, text);

    expect(result.violations.map((violation) => ({
      typeName: violation.typeName,
      field: violation.field,
    }))).toEqual([
      { typeName: "WorkerShareAuthorization", field: "email" },
      { typeName: "WorkerShareAuthorization", field: "hourlyRate" },
      { typeName: "ShareableWorker", field: "phone" },
      { typeName: "ShareableWorker", field: "managerNotes" },
      { typeName: "ShareableWorker", field: "documentCount" },
      { typeName: "ShareableWorker", field: "medical" },
    ]);
  });

  test("detects HR identity fields added to worker-share response contracts", () => {
    const text = `
export type WorkerShareAuthorization = {
  id: string;
  userId: string;
  address?: string | null;
  dateOfBirth?: string | null;
  birthPlace?: string | null;
  nationality?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
};

export type ShareableWorker = {
  id: string;
  name: string;
  role: "kitchen" | "floor";
  notes?: string | null;
};
`;

    const result = findShareResponsePrivacyViolations(webApiFile, text);

    expect(result.violations.map((violation) => ({
      typeName: violation.typeName,
      field: violation.field,
    }))).toEqual([
      { typeName: "WorkerShareAuthorization", field: "address" },
      { typeName: "WorkerShareAuthorization", field: "dateOfBirth" },
      { typeName: "WorkerShareAuthorization", field: "birthPlace" },
      { typeName: "WorkerShareAuthorization", field: "nationality" },
      { typeName: "WorkerShareAuthorization", field: "emergencyContact" },
      { typeName: "WorkerShareAuthorization", field: "emergencyPhone" },
      { typeName: "ShareableWorker", field: "notes" },
    ]);
  });

  test("requires all protected response types to stay present", () => {
    const text = `
export type WorkerShareAuthorization = {
  id: string;
};
`;

    const result = findShareResponsePrivacyViolations(webApiFile, text);

    expect(result.missingContracts).toEqual([`${webApiFile}:ShareableWorker`]);
  });

  test("keeps the forbidden field list broad enough for cross-restaurant privacy", () => {
    expect(forbiddenShareResponseFields).toEqual(expect.arrayContaining([
      "email",
      "phone",
      "address",
      "dateOfBirth",
      "permissions",
      "hourlyRate",
      "matricule",
      "iban",
      "nir",
      "managerNotes",
      "subRoles",
      "documentCount",
      "medical",
      "workerActive",
      "sourceRestaurantOwnerId",
    ]));
    expect(forbiddenStaffingWorkerLoadResponseFields).toEqual(expect.arrayContaining([
      "sharedFromRestaurantId",
      "sourceRestaurantId",
      "sourceRestaurantName",
      "sourceRestaurantOwnerId",
    ]));
  });

  test("allows staffing worker-load eligibility without source context", () => {
    const text = `
export type WorkerLoad = {
  workerId: string;
  workerName: string;
  employmentActionEligible?: boolean;
};
`;

    const result = findStaffingWorkerLoadResponsePrivacyViolations(webApiFile, text);

    expect(result.missingContracts).toEqual([]);
    expect([...result.matchedContracts]).toEqual([`${webApiFile}:WorkerLoad`]);
    expect(result.violations).toEqual([]);
  });

  test("detects shared-worker source fields on staffing worker-load response", () => {
    const text = `
export type WorkerLoad = {
  workerId: string;
  sharedFromRestaurantId?: string;
  sourceRestaurantName?: string;
};
`;

    const result = findStaffingWorkerLoadResponsePrivacyViolations(webApiFile, text);

    expect(result.violations.map((violation) => ({
      typeName: violation.typeName,
      field: violation.field,
    }))).toEqual([
      { typeName: "WorkerLoad", field: "sharedFromRestaurantId" },
      { typeName: "WorkerLoad", field: "sourceRestaurantName" },
    ]);
  });

  test("extracts exported type bodies without scanning unrelated user types", () => {
    const text = `
export type User = {
  email: string;
};

export type ShareableWorker = {
  id: string;
};
`;

    const body = extractTypeBody(text, "ShareableWorker");

    expect(body?.body).toContain("id: string");
    expect(body?.body).not.toContain("email");
  });

  test("detects missing route-level shared-worker privacy fragments", () => {
    const requirements = new Map<string, string[]>([
      [internalWhatsappFile, [
        'scope !== "leave" || !w.sharedFromRestaurantId',
        "expect-this-fragment",
      ]],
    ]);

    const result = findRequiredFragmentViolations(
      internalWhatsappFile,
      'const team = rows.filter((w) => scope !== "leave" || !w.sharedFromRestaurantId);',
      requirements,
    );

    expect(result).toEqual([{ file: internalWhatsappFile, fragment: "expect-this-fragment" }]);
  });

  test("detects missing duplicate shared-worker privacy fragments", () => {
    const requirements = new Map<string, string[]>([
      [whatsappAdminToolsFile, [
        'resolveInternalWorker(args.worker_name as string, "leave", ctx)',
        'resolveInternalWorker(args.worker_name as string, "leave", ctx)',
      ]],
    ]);

    const result = findRequiredFragmentViolations(
      whatsappAdminToolsFile,
      'const worker = await resolveInternalWorker(args.worker_name as string, "leave", ctx);',
      requirements,
    );

    expect(result).toEqual([{
      file: whatsappAdminToolsFile,
      fragment: 'resolveInternalWorker(args.worker_name as string, "leave", ctx)',
    }]);
  });
});
