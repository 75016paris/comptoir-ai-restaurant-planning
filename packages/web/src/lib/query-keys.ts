// Query-key catalog for @tanstack/react-query.
//
// Restaurant-scoped keys are hierarchical under ["restaurant", activeRestaurantId].
// Invalidating qk.employees.all(), for example, only drops employees for the
// currently active restaurant.
//
// Convention: every mutation handler ends with one
//   queryClient.invalidateQueries({ queryKey: qk.<resource>.all() })
// matching the affected resource. No more hand-rolled fetchData() calls.

let activeRestaurantQueryScope: string | null = null;

export function setActiveRestaurantQueryScope(restaurantId: string | null | undefined) {
  activeRestaurantQueryScope = restaurantId?.trim() || null;
}

const restaurantScoped = <T extends readonly unknown[]>(...parts: T) =>
  ["restaurant", activeRestaurantQueryScope ?? "pending", ...parts] as const;

export const qk = {
  restaurant: {
    all: () => ["restaurant"] as const,
  },
  auth: {
    me: () => ["auth", "me"] as const,
  },
  billing: {
    summary: () => ["billing", "summary"] as const,
    activeEmployees: (month?: string) => ["billing", "active-employees", month ?? null] as const,
  },
  workerShares: {
    all: () => restaurantScoped("worker-shares"),
    list: () => restaurantScoped("worker-shares", "list"),
    ownerList: (targetRestaurantIds: string) => restaurantScoped("worker-shares", "owner-list", targetRestaurantIds),
    employeeTargets: (userId?: string | null, activeRestaurantId?: string | null, targetRestaurantIds?: string | null) =>
      restaurantScoped("worker-shares", "employee-targets", userId ?? null, activeRestaurantId ?? null, targetRestaurantIds ?? null),
    shareableWorkers: (sourceRestaurantId?: string | null, role?: "kitchen" | "floor" | null) =>
      restaurantScoped("worker-shares", "shareable-workers", sourceRestaurantId ?? null, role ?? null),
    pendingMine: () => restaurantScoped("worker-shares", "pending-mine"),
  },
  onboarding: {
    state: () => restaurantScoped("onboarding", "state"),
  },
  employees: {
    all: () => restaurantScoped("employees"),
    list: (includeInactive?: boolean) => restaurantScoped("employees", "list", includeInactive ?? false),
    detail: (id: string) => restaurantScoped("employees", "detail", id),
    checklist: (id: string) => restaurantScoped("employees", "checklist", id),
    expiringDocs: () => restaurantScoped("employees", "expiring-docs"),
    dossierStatus: () => restaurantScoped("employees", "dossier-status"),
    documents: (userId: string) => restaurantScoped("employees", "documents", userId),
    availability: (userId: string) => restaurantScoped("employees", "availability", userId),
    restrictions: (userId: string) => restaurantScoped("employees", "restrictions", userId),
    preferredSchedule: (userId: string) => restaurantScoped("employees", "preferred-schedule", userId),
  },
  schedule: {
    all: () => restaurantScoped("schedule"),
    week: (date?: string) => restaurantScoped("schedule", "week", date ?? null),
    services: (from: string, to: string) => restaurantScoped("schedule", "services", from, to),
    weekPublished: (date: string) => restaurantScoped("schedule", "week-published", date),
    whoWorks: (date: string) => restaurantScoped("schedule", "who-works", date),
  },
  hours: {
    all: () => restaurantScoped("hours"),
    range: (params: { workerId?: string; from: string; to: string }) =>
      restaurantScoped("hours", "range", params.workerId ?? null, params.from, params.to),
    monthlyRecap: (month: string) => restaurantScoped("hours", "monthly-recap", month),
  },
  holidays: {
    all: () => restaurantScoped("holidays"),
    list: () => restaurantScoped("holidays", "list"),
    documents: (holidayId: string) => restaurantScoped("holidays", "documents", holidayId),
    impact: (id: string) => restaurantScoped("holidays", "impact", id),
    batchImpact: () => restaurantScoped("holidays", "batch-impact"),
    advice: (profileId?: string) => restaurantScoped("holidays", "advice", profileId ?? null),
    intelligence: (profileId?: string) => restaurantScoped("holidays", "intelligence", profileId ?? null),
  },
  replacements: {
    all: () => restaurantScoped("replacements"),
    pending: () => restaurantScoped("replacements", "pending"),
    list: () => restaurantScoped("replacements", "all"),
  },
  restrictionRequests: {
    all: () => restaurantScoped("restriction-requests"),
    list: () => restaurantScoped("restriction-requests", "list"),
  },
  timeclock: {
    status: () => restaurantScoped("timeclock", "status"),
    records: (from: string, to: string) => restaurantScoped("timeclock", "records", from, to),
    pendingConfirmations: () => restaurantScoped("timeclock", "pending-confirmations"),
  },
  revenue: {
    all: () => restaurantScoped("revenue"),
    range: (from: string, to: string) => restaurantScoped("revenue", "range", from, to),
    stats: (from: string, to: string) => restaurantScoped("revenue", "stats", from, to),
  },
  settings: {
    all: () => restaurantScoped("settings"),
    pageLoad: (userId?: string | null) => restaurantScoped("settings", "page-load", userId ?? null),
    serviceTemplates: () => restaurantScoped("settings", "service-templates"),
    openDays: () => restaurantScoped("settings", "open-days"),
    medicalMode: () => restaurantScoped("settings", "medical-mode"),
    preferences: () => restaurantScoped("settings", "preferences"),
    workerConfig: () => restaurantScoped("settings", "worker-config"),
    closures: () => restaurantScoped("settings", "closures"),
  },
  staffing: {
    all: () => restaurantScoped("staffing"),
    calendarLoad: (profileId?: string | null) => restaurantScoped("staffing", "calendar-load", profileId ?? null),
    targets: () => restaurantScoped("staffing", "targets"),
    schedule: (year: number) => restaurantScoped("staffing", "schedule", year),
    titulaires: (profileId: string) => restaurantScoped("staffing", "titulaires", profileId),
    analysis: (profileId?: string, contractOverrides?: unknown, restrictionOverrides?: unknown, roleOverrides?: unknown) =>
      restaurantScoped("staffing", "analysis", profileId ?? null, contractOverrides ?? null, restrictionOverrides ?? null, roleOverrides ?? null),
    expansion: (profileId?: string) => restaurantScoped("staffing", "expansion", profileId ?? null),
    optimize: (profileId?: string, levers?: string[]) => restaurantScoped("staffing", "optimize", profileId ?? null, levers ?? null),
  },
  payroll: {
    monthly: (month: string) => restaurantScoped("payroll", "monthly", month),
  },
  compliance: {
    all: () => restaurantScoped("compliance"),
    week: (date: string) => restaurantScoped("compliance", "week", date),
    rules: () => restaurantScoped("compliance", "rules"),
  },
  weather: {
    range: (from: string, to: string) => restaurantScoped("weather", "range", from, to),
  },
  calendar: {
    range: (from: string, to: string) => restaurantScoped("calendar", "range", from, to),
  },
  emailRecipients: {
    all: () => restaurantScoped("email-recipients"),
    list: () => restaurantScoped("email-recipients", "list"),
  },
  audit: {
    list: (params?: unknown) => restaurantScoped("audit", "list", params ?? null),
  },
  cron: {
    runs: () => restaurantScoped("cron", "runs"),
  },
} as const;
