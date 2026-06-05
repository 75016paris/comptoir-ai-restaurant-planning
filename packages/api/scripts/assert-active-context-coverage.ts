import { readdir, access } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const routesRoot = path.join(root, "src/routes");

const directCoverage = new Map<string, string[]>([
  ["admin-alerts.ts", ["admin-alerts-active-context.test.ts"]],
  ["audit.ts", ["audit-active-context.test.ts"]],
  ["autostaffing.ts", ["autostaffing-active-context.test.ts"]],
  ["calendar.ts", ["calendar-revenue-active-context.test.ts"]],
  ["compliance.ts", ["compliance-active-context.test.ts"]],
  ["demo-chat.ts", ["demo-chat-active-context.test.ts"]],
  ["email-recipients.ts", ["email-recipients-active-context.test.ts"]],
  ["holidays.ts", ["holidays-active-context.test.ts"]],
  ["notifications.ts", ["notifications-active-context.test.ts"]],
  ["onboarding.ts", ["onboarding-active-context.test.ts"]],
  ["open-shifts.ts", ["open-shifts-active-context.test.ts"]],
  ["payroll.ts", ["payroll-active-context.test.ts"]],
  ["public-onboarding.ts", ["public-onboarding-active-context.test.ts"]],
  ["replacements.ts", ["replacements-active-context.test.ts"]],
  ["restaurants.ts", ["restaurants-active-context.test.ts"]],
  ["restriction-requests.ts", ["restriction-requests-active-context.test.ts"]],
  ["revenue.ts", ["calendar-revenue-active-context.test.ts"]],
  ["schedule.ts", ["schedule-active-context.test.ts"]],
  ["services.ts", ["services-active-context.test.ts"]],
  ["settings.ts", ["settings-active-context.test.ts"]],
  ["timeclock.ts", ["timeclock-active-context.test.ts"]],
  ["users.ts", ["users-active-context.test.ts"]],
  ["weather.ts", ["weather-active-context.test.ts"]],
]);

const specializedCoverage = new Map<string, string[]>([
  ["auth.ts", ["auth-active-restaurant.test.ts"]],
  ["internal-whatsapp.ts", ["internal-whatsapp.test.ts", "internal-whatsapp-worker-replacements.test.ts"]],
]);

const trackedFollowUp = new Map<string, string>();
const expectedTrackedFollowUps = 0;
const intentionallyUnscopedRoutes = new Map<string, string>([
  ["cron.ts", "secret-protected VPS cron fan-out across restaurants; not tied to a user active restaurant session"],
  ["debug-cache.ts", "dev-only baseline-cache introspection; 404s in production and does not accept tenant input"],
  ["health-solver.ts", "solver health endpoint exposes process-level circuit state, not restaurant data"],
]);

const routeFiles = (await readdir(routesRoot))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .sort();

async function fileExists(file: string) {
  try {
    await access(path.join(routesRoot, file));
    return true;
  } catch {
    return false;
  }
}

const missingTests: string[] = [];
for (const [route, tests] of [...directCoverage, ...specializedCoverage]) {
  if (!routeFiles.includes(route)) {
    missingTests.push(`${route} is listed for active-context coverage but the route file no longer exists`);
  }
  for (const test of tests) {
    if (!(await fileExists(test))) {
      missingTests.push(`${route} expects ${test}, but that test file does not exist`);
    }
  }
}

const undocumentedTenantRoutes = routeFiles.filter((route) =>
  !directCoverage.has(route) &&
  !specializedCoverage.has(route) &&
  !trackedFollowUp.has(route) &&
  !intentionallyUnscopedRoutes.has(route)
);

const staleFollowUps = [...trackedFollowUp.keys()].filter((route) => !routeFiles.includes(route));
const staleUnscopedRoutes = [...intentionallyUnscopedRoutes.keys()].filter((route) => !routeFiles.includes(route));
const unexpectedFollowUps = trackedFollowUp.size === expectedTrackedFollowUps
  ? []
  : [`expected ${expectedTrackedFollowUps} tracked active-context follow-ups, found ${trackedFollowUp.size}`];

if (missingTests.length > 0 || undocumentedTenantRoutes.length > 0 || staleFollowUps.length > 0 || staleUnscopedRoutes.length > 0 || unexpectedFollowUps.length > 0) {
  throw new Error([
    "Active restaurant route coverage map is out of date.",
    ...missingTests.map((entry) => `- ${entry}`),
    ...undocumentedTenantRoutes.map((route) => `- ${route} is not classified as directly covered, specially covered, or tracked follow-up`),
    ...staleFollowUps.map((route) => `- ${route} is tracked as follow-up but no longer exists`),
    ...staleUnscopedRoutes.map((route) => `- ${route} is intentionally unscoped but no longer exists`),
    ...unexpectedFollowUps.map((entry) => `- ${entry}`),
  ].join("\n"));
}

console.log(`Active-context coverage map passed (${directCoverage.size} direct routes, ${specializedCoverage.size} specialized routes, ${intentionallyUnscopedRoutes.size} intentionally unscoped routes, ${trackedFollowUp.size} tracked follow-ups).`);
