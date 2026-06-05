const BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Global subscription block signal — set when API returns 403 "Abonnement inactif"
let onSubscriptionBlocked: (() => void) | null = null;
export function setSubscriptionBlockedHandler(handler: () => void) {
  onSubscriptionBlocked = handler;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({
      error: res.status >= 500
        ? "API locale indisponible. Vérifiez que le serveur API tourne sur le port 3000."
        : `HTTP ${res.status}`,
    }));
    if (res.status === 403 && body.subscriptionStatus) {
      onSubscriptionBlocked?.();
    }
    let msg = body.error || `HTTP ${res.status}`;
    const fieldErrors = body?.details?.fieldErrors as Record<string, string[]> | undefined;
    if (fieldErrors) {
      const FIELD_LABELS: Record<string, string> = {
        firstName: "Pr\u00e9nom", lastName: "Nom", name: "Nom",
        email: "E-mail", phone: "T\u00e9l\u00e9phone", role: "R\u00f4le",
        password: "Mot de passe", priority: "Priorit\u00e9",
        contractType: "Type de contrat", contractEndDate: "Fin de contrat", contractHours: "Heures contrat",
        hcrLevel: "Niveau HCR", hourlyRate: "Taux horaire",
        startDate: "Date d'embauche", iban: "IBAN", address: "Adresse",
        emergencyContact: "Contact d'urgence", emergencyPhone: "T\u00e9l urgence",
        subRoles: "Sous-r\u00f4les",
      };
      const parts = Object.entries(fieldErrors)
        .filter(([, errs]) => errs && errs.length > 0)
        .map(([k, errs]) => `${FIELD_LABELS[k] ?? k}: ${errs.join(", ")}`);
      if (parts.length > 0) msg = parts.join(" \u00b7 ");
    }
    throw new ApiError(msg, res.status);
  }

  return res.json();
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  demoLogin: (email: string) =>
    request("/auth/demo-login", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  register: (data: RegisterInput) =>
    request<{ data: { url: string } }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  forgotPassword: (email: string) =>
    request<{ data: { ok: boolean } }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    request<{ data: { ok: boolean } }>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request<{ data: AuthUser }>("/auth/me"),
  listAuthRestaurants: () =>
    request<{ data: { activeRestaurantId: string; restaurants: AccessibleRestaurant[] } }>("/auth/restaurants"),
  switchActiveRestaurant: (restaurantId: string) =>
    request<{ data: { ok: boolean; activeRestaurantId: string; restaurant: AccessibleRestaurant } }>("/auth/active-restaurant", {
      method: "POST",
      body: JSON.stringify({ restaurantId }),
    }),
  createRestaurant: (data: { name: string; address?: string | null; timezone?: string }) =>
    request<{ data: AccessibleRestaurant & { address?: string | null } }>("/restaurants", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateRestaurant: (id: string, data: { name?: string; address?: string | null; timezone?: string }) =>
    request<{ data: AccessibleRestaurant & { address?: string | null } }>(`/restaurants/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  listShareableWorkers: (restaurantId: string, params: { sourceRestaurantId: string; role?: "kitchen" | "floor" }) => {
    const qs = new URLSearchParams({ sourceRestaurantId: params.sourceRestaurantId });
    if (params.role) qs.set("role", params.role);
    return request<{ data: ShareableWorker[] }>(`/restaurants/${restaurantId}/shareable-workers?${qs}`);
  },
  listWorkerShares: (restaurantId: string) =>
    request<{ data: WorkerShareAuthorization[] }>(`/restaurants/${restaurantId}/worker-shares`),
  createWorkerShare: (restaurantId: string, data: { sourceRestaurantId: string; userId: string; role: "kitchen" | "floor" }) =>
    request<{ data: WorkerShareAuthorization }>(`/restaurants/${restaurantId}/worker-shares`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  listMyPendingWorkerShares: () =>
    request<{ data: WorkerShareAuthorization[] }>("/restaurants/worker-shares/pending"),
  acceptWorkerShare: (authorizationId: string) =>
    request<{ data: WorkerShareAuthorization }>(`/restaurants/worker-shares/${authorizationId}/accept`, { method: "POST" }),
  declineWorkerShare: (authorizationId: string) =>
    request<{ data: WorkerShareAuthorization }>(`/restaurants/worker-shares/${authorizationId}/decline`, { method: "POST" }),
  revokeWorkerShare: (authorizationId: string) =>
    request<{ data: WorkerShareAuthorization }>(`/restaurants/worker-shares/${authorizationId}/revoke`, { method: "POST" }),
  acceptOwnerLegal: () => request<{ data: { ok: boolean; ownerLegalAcceptanceRequired: boolean; ownerLegalVersions: LegalVersions } }>("/auth/legal/accept-owner", { method: "POST" }),
  acceptUserNotice: (data: { whatsappOptIn: boolean }) => request<{ data: { ok: boolean; userNoticeAcceptanceRequired: boolean; userNoticeVersion: string; whatsappOptIn: boolean } }>("/auth/legal/accept-user-notice", { method: "POST", body: JSON.stringify(data) }),

  // Billing
  getBilling: () =>
    request<{ data: BillingInfo }>("/auth/billing"),
  getActiveEmployees: (month?: string) =>
    request<{ data: ActiveEmployeesInfo }>(`/auth/billing/active-employees${month ? `?month=${month}` : ""}`),
  createBillingPortal: () =>
    request<{ data: { url: string } }>("/auth/billing/portal", { method: "POST" }),
  resubscribe: () =>
    request<{ data: { url: string } }>("/auth/billing/resubscribe", { method: "POST" }),

  // Users
  listUsers: (opts?: { includeInactive?: boolean }) =>
    request<{ data: User[] }>(`/users${opts?.includeInactive ? "?include=inactive" : ""}`),
  listSchedulingRoster: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    return request<{ data: SchedulingRosterUser[] }>(`/users/scheduling-roster${qs.size ? `?${qs}` : ""}`);
  },
  getUser: (id: string) =>
    request<{ data: User }>(`/users/${id}`),
  deleteUser: (id: string) =>
    request<{ data: { deactivated: boolean } }>(`/users/${id}`, { method: "DELETE" }),
  reactivateUser: (id: string) =>
    request<{ data: { reactivated: boolean } }>(`/users/${id}/reactivate`, { method: "POST" }),
  tempDeactivateUser: (id: string, from: string, until: string) =>
    request<{ data: { tempDeactivated: boolean } }>(`/users/${id}/temp-deactivate`, { method: "POST", body: JSON.stringify({ from, until }) }),
  cancelTempDeactivation: (id: string) =>
    request<{ data: { cancelled: boolean } }>(`/users/${id}/cancel-temp-deactivation`, { method: "POST" }),
  createUser: (data: CreateUserInput) =>
    request<{ data: { id: string; name: string; email: string; phone: string; role: string; temporaryPassword?: string } }>(
      "/users",
      { method: "POST", body: JSON.stringify(data) },
    ),
  updateUser: (id: string, data: Partial<CreateUserInput>) =>
    request(`/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  updateMyProfile: (data: { overtimeWilling?: boolean; coupureWilling?: boolean; multiRestaurantWilling?: boolean; maxWeeklyHours?: number | null; phone?: string; email?: string; address?: string | null; iban?: string | null; emergencyContact?: string | null; emergencyPhone?: string | null; dateOfBirth?: string | null; birthPlace?: string | null; nationality?: string | null; nir?: string | null; notes?: string | null }) =>
    request("/users/me/profile", { method: "PATCH", body: JSON.stringify(data) }),
  inviteWorkerLogin: (id: string) =>
    request<{ data: { sent: boolean } }>(`/users/${id}/login-invite`, { method: "POST" }),
  changeMyPassword: (currentPassword: string, newPassword: string) =>
    request<{ data: { ok: boolean } }>("/users/me/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // Onboarding
  getOnboardingState: () =>
    request<{ data: OnboardingState }>("/onboarding/state"),
  saveOnboardingProfile: (data: OnboardingProfileInput) =>
    request<{ data: { ok: boolean; schoolZone?: string | null; holidayZone?: string | null } }>("/onboarding/profile", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  saveOnboardingSubroles: (data: { kitchenSubRoles: string[]; floorSubRoles: string[] }) =>
    request<{ data: { ok: boolean } }>("/onboarding/subroles", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  saveOnboardingServiceTemplate: (data: { kind: string; kitchenCount?: number; salleCount?: number; openDays?: number[] }) =>
    request<{ data: { ok: boolean; profileId: string | null } }>("/onboarding/service-template", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  saveOnboardingEmployees: (employees: OnboardingEmployeeInput[]) =>
    request<{ data: { created: { id: string; name: string }[] } }>("/onboarding/employees", {
      method: "POST",
      body: JSON.stringify({ employees }),
    }),
  saveOnboardingPreferredStyle: (preferredStyle: OnboardingState["restaurant"]["preferredStyle"]) =>
    request<{ data: { ok: boolean } }>("/onboarding/preferred-style", {
      method: "POST",
      body: JSON.stringify({ preferredStyle }),
    }),
  completeOnboarding: () =>
    request<{ data: { ok: boolean } }>("/onboarding/complete", { method: "POST" }),
  resetOnboarding: () =>
    request<{ data: { ok: boolean } }>("/onboarding/reset", { method: "POST" }),

  // Schedule
  getWeek: (date?: string) =>
    request<{ data: WeekSchedule }>(
      `/schedule/week${date ? `?date=${date}` : ""}`
    ),
  getHours: (params: { workerId?: string; from: string; to: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>);
    return request<{ data: HoursSummary }>(`/schedule/hours?${qs}`);
  },
  whoWorks: (date: string) =>
    request<{ data: WhoWorksEntry[] }>(`/schedule/who-works?date=${date}`),
  getMonthlyRecap: (month: string) =>
    request<{ data: MonthlyRecap }>(`/schedule/monthly-recap?month=${month}`),

  // Services
  getServices: (from: string, to: string) =>
    request<{ data: ServiceRow[] }>(`/services?from=${from}&to=${to}`),
  createService: (data: CreateServiceInput, opts?: { force?: boolean }) =>
    request(`/services${opts?.force ? "?force=true" : ""}`, { method: "POST", body: JSON.stringify(data) }),
  updateService: (id: string, data: Partial<CreateServiceInput>, opts?: { force?: boolean }) =>
    request(`/services/${id}${opts?.force ? "?force=true" : ""}`, { method: "PATCH", body: JSON.stringify(data) }),
  moveService: (data: MoveServiceInput, opts?: { force?: boolean }) =>
    request(`/services/move${opts?.force ? "?force=true" : ""}`, { method: "POST", body: JSON.stringify(data) }),
  deleteService: (id: string, opts?: { force?: boolean }) =>
    request(`/services/${id}${opts?.force ? "?force=true" : ""}`, { method: "DELETE" }),

  // Replacements (admin-mediated; worker reports unavailability, admin picks a replacement).
  findReplacementCandidates: (serviceId: string) =>
    request<{ data: { candidates: Array<{ id: string; name: string; score: number; reasons: string[] }> } }>("/services/replacement/find", {
      method: "POST",
      body: JSON.stringify({ serviceId }),
    }),
  findSlotCandidates: (data: { date: string; startTime: string; endTime: string; role: "kitchen" | "floor"; zone?: string; targetSubRole?: string }) =>
    request<{ data: { candidates: Array<{ id: string; name: string; score: number; reasons: string[] }> } }>("/services/replacement/find", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  requestReplacement: (data: CreateReplacementInput) =>
    request<{ data: ReplacementRequest }>("/services/replacement/request", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  respondReplacement: (id: string, response: "accepted" | "rejected") =>
    request(`/services/replacement/respond/${id}`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
  reviewReplacement: (id: string, decision: ReviewReplacementDecision, candidateId?: string) =>
    request<{ data: ReplacementRequest }>(`/services/replacement/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, candidateId: candidateId ?? null }),
    }),
  attachReplacementDocuments: (
    id: string,
    docs: Array<{ name: string; filename: string; mimeType: string; size: number; storageKey: string }>,
  ) =>
    request<{ data: { inserted: number } }>(`/services/replacement/${id}/documents`, {
      method: "POST",
      body: JSON.stringify({ documents: docs }),
    }),
  pendingReplacements: () => request<{ data: ReplacementRequest[] }>("/services/replacement/pending"),
  allReplacements: () => request<{ data: ReplacementRequest[] }>("/services/replacement/all"),

  // Holidays
  listHolidays: () => request<{ data: HolidayRequest[] }>("/holidays"),
  requestHoliday: (data: {
    startDate: string; endDate: string; reason?: string; medical?: boolean;
    workerId?: string; // admin only — create absence on behalf of a worker
    documents?: Array<{ name: string; filename: string; mimeType: string; size: number; storageKey: string }>;
  }) =>
    request<{ data: { id: string } }>("/holidays", { method: "POST", body: JSON.stringify(data) }),
  getHolidayDocuments: (holidayId: string) =>
    request<{ data: HolidayDocument[] }>(`/holidays/${holidayId}/documents`),
  getHolidayDocument: (holidayId: string, docId: string) =>
    request<{ data: HolidayDocumentBlob }>(`/holidays/${holidayId}/documents/${docId}`),
  reviewHoliday: (id: string, status: "approved" | "rejected") =>
    request(`/holidays/${id}/review`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  proposeHoliday: (data: { workerId: string; startDate: string; endDate: string; reason?: string; impose?: boolean }) =>
    request<{ data: { id: string } }>("/holidays/propose", { method: "POST", body: JSON.stringify(data) }),
  respondToProposal: (id: string, action: "accept" | "reject") =>
    request(`/holidays/${id}/respond`, { method: "PATCH", body: JSON.stringify({ action }) }),
  getHolidayImpact: (id: string) =>
    request<{ data: HolidayImpact }>(`/holidays/${id}/impact`),
  getHolidayBatchImpact: () =>
    request<{ data: BatchHolidayImpact }>("/holidays/batch-impact"),

  // Time Clock
  clockStatus: () => request<{ data: ClockStatus }>("/timeclock/status"),
  tapIn: () => request("/timeclock/tap-in", { method: "POST", body: "{}" }),
  tapOut: () => request("/timeclock/tap-out", { method: "POST", body: "{}" }),
  clockRecords: (from: string, to: string) =>
    request<{ data: ClockRecord[] }>(`/timeclock?from=${from}&to=${to}`),
  pendingTimeclockConfirmations: () =>
    request<{ data: TimeclockConfirmation[] }>("/timeclock/pending-confirmations"),
  confirmTimeclock: (id: string) =>
    request<{ data: ClockRecord }>(`/timeclock/${id}/confirm`, { method: "POST" }),
  getLateness: (from: string, to: string, workerId?: string) => {
    const qs = new URLSearchParams({ from, to });
    if (workerId) qs.set("workerId", workerId);
    return request<{ data: LatenessReport }>(`/timeclock/lateness?${qs.toString()}`);
  },

  // Revenue
  getRevenue: (from: string, to: string) =>
    request<{ data: RevenueEntry[] }>(`/revenue?from=${from}&to=${to}`),
  logRevenue: (data: { date: string; amount: number; notes?: string }) =>
    request("/revenue", { method: "POST", body: JSON.stringify(data) }),
  revenueStats: (from: string, to: string) =>
    request<{ data: RevenueStats }>(`/revenue/stats?from=${from}&to=${to}`),

  // Settings
  getServiceTemplates: () =>
    request<{ data: ServiceTemplate[] }>("/settings/service-templates"),
  updateServiceTemplates: (data: ServiceTemplate[]) =>
    request("/settings/service-templates", { method: "PUT", body: JSON.stringify(data) }),
  getOpenDays: () =>
    request<{ data: Record<string, "both" | "midi" | "soir"> }>("/settings/open-days"),
  updateOpenDays: (days: Record<string, "both" | "midi" | "soir">) =>
    request<{ data: Record<string, "both" | "midi" | "soir"> }>("/settings/open-days", { method: "PUT", body: JSON.stringify(days) }),
  getMedicalMode: () =>
    request<{ data: boolean }>("/settings/medical-mode"),
  setMedicalMode: (enabled: boolean) =>
    request<{ data: boolean }>("/settings/medical-mode", { method: "PUT", body: JSON.stringify({ enabled }) }),
  getPreferences: () =>
    request<{ data: AdminPreferences }>("/settings/preferences"),
  getWorkerConfig: () =>
    request<{ data: WorkerConfig }>("/settings/worker-config"),
  updatePreferences: (data: Partial<AdminPreferences>) =>
    request<{ data: AdminPreferences }>("/settings/preferences", { method: "PUT", body: JSON.stringify(data) }),
  getStaffingTargets: () =>
    request<{ data: StaffingTargetsResponse }>("/settings/staffing-targets"),
  updateStaffingTargets: (profiles: StaffingProfile[], targets: StaffingTarget[], profileTemplates?: ProfileServiceTemplate[]) =>
    request<{ data: StaffingTargetsResponse }>("/settings/staffing-targets", { method: "PUT", body: JSON.stringify({ profiles, targets, profileTemplates }) }),
  getProfileTitulaires: (profileId: string) =>
    request<{ data: TitulairesResponse }>(`/settings/staffing-profiles/${profileId}/titulaires`),
  updateProfileTitulaires: (profileId: string, assignments: TitulaireAssignment[]) =>
    request<{ ok: boolean; count: number }>(`/settings/staffing-profiles/${profileId}/titulaires`, { method: "PUT", body: JSON.stringify({ assignments }) }),
  getStaffingSchedule: (year: number) =>
    request<{ data: StaffingWeekAssignment[] }>(`/settings/staffing-schedule?year=${year}`),
  updateStaffingSchedule: (assignments: StaffingWeekAssignment[]) =>
    request<{ data: StaffingWeekAssignment[] }>("/settings/staffing-schedule", { method: "PUT", body: JSON.stringify({ assignments }) }),
  getClosures: () =>
    request<{ data: RestaurantClosure[] }>("/settings/closures"),
  addClosure: (data: { startDate: string; endDate: string; reason?: string; schedule?: ClosureSchedule; createLeaves?: boolean; confirmShortNotice?: boolean }) =>
    request<{ data: RestaurantClosure & { leavesCreated?: number; leavesSkipped?: number; noticeWarning?: string } }>("/settings/closures", { method: "POST", body: JSON.stringify(data) }),
  updateClosure: (id: string, data: { startDate?: string; endDate?: string; reason?: string }) =>
    request<{ data: RestaurantClosure }>("/settings/closures/" + id, { method: "PATCH", body: JSON.stringify(data) }),
  deleteClosure: (id: string) =>
    request("/settings/closures/" + id, { method: "DELETE" }),

  // User Documents
  getUserDocuments: (userId: string) =>
    request<{ data: Document[] }>(`/users/${userId}/documents`),
  uploadUserDocument: (userId: string, data: { name: string; type: string; filename: string; mimeType: string; size: number; storageKey: string; requirementKey?: string; issuedAt?: string; expiresAt?: string; signedAt?: string }) =>
    request<{ data: Document }>(`/users/${userId}/documents`, { method: "POST", body: JSON.stringify(data) }),
  presignUserDocument: (userId: string, meta: { filename: string; mimeType: string; size: number }) =>
    request<{ data: PresignResult }>(`/users/${userId}/documents/presign`, { method: "POST", body: JSON.stringify(meta) }),
  presignHolidayDocument: (meta: { filename: string; mimeType: string; size: number }) =>
    request<{ data: PresignResult }>(`/holidays/documents/presign`, { method: "POST", body: JSON.stringify(meta) }),
  presignReplacementDocument: (meta: { filename: string; mimeType: string; size: number }) =>
    request<{ data: PresignResult }>(`/services/replacement/documents/presign`, { method: "POST", body: JSON.stringify(meta) }),
  markDocumentSigned: (userId: string, docId: string, signedAt: string | null) =>
    request<{ data: { id: string; signedAt: string | null } }>(`/users/${userId}/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ signedAt }),
    }),
  getUserDocument: (userId: string, docId: string) =>
    request<{ data: DocumentBlob }>(`/users/${userId}/documents/${docId}`),
  deleteUserDocument: (userId: string, docId: string) =>
    request(`/users/${userId}/documents/${docId}`, { method: "DELETE" }),
  confirmUserDocument: (userId: string, docId: string) =>
    request<{ data: { id: string; reviewedAt: string; reviewedBy: string } }>(
      `/users/${userId}/documents/${docId}/confirm`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  // Onboarding checklist
  getUserChecklist: (userId: string) =>
    request<{ data: WorkerChecklist }>(`/users/${userId}/checklist`),
  getExpiringDocsReport: () =>
    request<{ data: ExpiringDocAlert[] }>(`/users/checklist/expiring`),
  getDossierStatus: () =>
    request<{ data: { workers: Array<{ workerId: string; pendingReview: number; missingMandatory: number; readyForDpae: boolean }>; totalPendingReview: number; totalIncompleteDossiers: number } }>(`/users/dossier-status`),

  // Contract generation
  generateContract: (userId: string, data: {
    kind: "CDI" | "CDD" | "saisonnier" | "extra";
    inputs?: Record<string, unknown>;
    templateId?: string;
    save?: boolean;
  }) =>
    request<{ data: { html: string; tokens: Record<string, string>; saved: boolean } }>(
      `/users/${userId}/generate-contract`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  // Worker invitation — emails a link to complete the self-service dossier
  inviteWorker: (userId: string) =>
    request<{ data: { sent: boolean } }>(`/users/${userId}/invite`, { method: "POST" }),

  // DPAE (URSSAF) CSV export for one or more workers
  exportDpaeCsv: async (workerIds: string[], perWorker?: Record<string, { nir?: string; birthDate?: string; birthPlace?: string; nationality?: string }>) => {
    const resp = await fetch(`${BASE}/users/dpae/export`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerIds, perWorker }),
    });
    if (!resp.ok) throw new Error(`DPAE export failed (${resp.status})`);
    return resp.blob();
  },

  // Auto-staffing
  previewSchedule: (date: string, targetOverrides?: StaffingTarget[], profileId?: string) =>
    request<{ data: AutostaffingPlan }>("/autostaffing/preview", { method: "POST", body: JSON.stringify({ date, targetOverrides, profileId }) }),
  generateSchedule: (date: string, overwrite?: boolean, targetOverrides?: StaffingTarget[], profileId?: string, styleOverride?: AdminPreferences["preferredStyle"]) =>
    request<{ data: AutostaffingResult }>("/autostaffing/generate", { method: "POST", body: JSON.stringify({ date, overwrite, targetOverrides, profileId, styleOverride }) }),
  wipeWeek: (date: string, opts?: { force?: boolean }) =>
    request<{ data: { deleted: number } }>(`/schedule/week?date=${date}${opts?.force ? "&force=true" : ""}`, { method: "DELETE" }),
  getWeekPublished: (date: string) =>
    request<{ data: { published: boolean; publishedAt: string | null } }>(`/schedule/week/published?date=${date}`),
  setWeekPublished: (date: string, published: boolean) =>
    request<{ data: { published: boolean; publishedAt: string | null; notifiedWorkers?: number } }>(`/schedule/week/published?date=${date}`, { method: "PUT", body: JSON.stringify({ published }) }),

  // Staffing Analysis
  getStaffingAnalysis: (profileId?: string, contractOverrides?: Record<string, number>, restrictionOverrides?: string[], roleOverrides?: Record<string, string>, maxWeeklyOverrides?: Record<string, number>) => {
    const params = new URLSearchParams();
    if (profileId) params.set("profileId", profileId);
    if (contractOverrides) params.set("contractOverrides", JSON.stringify(contractOverrides));
    if (maxWeeklyOverrides) params.set("maxWeeklyOverrides", JSON.stringify(maxWeeklyOverrides));
    if (restrictionOverrides?.length) params.set("restrictionOverrides", JSON.stringify(restrictionOverrides));
    if (roleOverrides && Object.keys(roleOverrides).length > 0) params.set("roleOverrides", JSON.stringify(roleOverrides));
    const qs = params.toString();
    return request<{ data: StaffingAnalysis }>(`/settings/staffing-analysis${qs ? `?${qs}` : ""}`);
  },

  // Holiday advice — surplus + leave balances + upcoming quiet periods
  getHolidayAdvice: (profileId?: string) => {
    const params = new URLSearchParams();
    if (profileId) params.set("profileId", profileId);
    const qs = params.toString();
    return request<{ data: { advice: HolidayAdvice; balances: LeaveBalance[] } }>(`/settings/holiday-advice${qs ? `?${qs}` : ""}`);
  },

  // Unified leave intelligence — balances, advice, pending clusters, compliance, urgency
  getLeaveIntelligence: (profileId?: string) => {
    const params = new URLSearchParams();
    if (profileId) params.set("profileId", profileId);
    const qs = params.toString();
    return request<{ data: LeaveIntelligence }>(`/holidays/intelligence${qs ? `?${qs}` : ""}`);
  },

  // Staffing Expansion Suggestions
  getStaffingExpansion: (profileId?: string) => {
    const params = new URLSearchParams();
    if (profileId) params.set("profileId", profileId);
    const qs = params.toString();
    return request<{ data: ExpansionInsight[] }>(`/settings/staffing-expansion${qs ? `?${qs}` : ""}`);
  },

  // Weights Preview — compare two configurations side by side
  previewWeights: (sideA: WeightsPreviewSide, sideB: WeightsPreviewSide, opts?: { profileId?: string; numWeeks?: number }) =>
    request<{ data: WeightsPreview }>("/settings/weights-preview", {
      method: "POST",
      body: JSON.stringify({ sideA, sideB, profileId: opts?.profileId, numWeeks: opts?.numWeeks }),
    }),

  // Auto-Optimize
  getAutoOptimize: (profileId?: string, levers?: string[]) => {
    const params = new URLSearchParams();
    if (profileId) params.set("profileId", profileId);
    if (levers && levers.length > 0) params.set("levers", levers.join(","));
    const qs = params.toString();
    return request<{ data: AutoOptimizeResult }>(`/settings/auto-optimize${qs ? `?${qs}` : ""}`);
  },

  // Payroll
  getPayrollExport: (month: string) =>
    request<{ data: PayrollExport }>(`/payroll/export?month=${month}`),
  getPayrollCSVUrl: (month: string) =>
    `${BASE}/payroll/export/csv?month=${month}`,
  getPayrollSilaeUrl: (month: string) =>
    `${BASE}/payroll/export/silae?month=${month}`,

  // Compliance
  checkCompliance: (date: string) =>
    request<{ data: ComplianceResult }>(`/compliance/check?date=${date}`),
  getComplianceRules: () =>
    request<{ data: ComplianceRuleMeta[] }>("/compliance/rules"),

  // Worker Availability
  getAvailability: (userId: string) =>
    request<{ data: WorkerAvailabilityDay[] }>(`/users/${userId}/availability`),
  updateAvailability: (userId: string, data: WorkerAvailabilityDay[]) =>
    request(`/users/${userId}/availability`, { method: "PUT", body: JSON.stringify(data) }),
  getRestrictions: (userId: string) =>
    request<{ data: WorkerRestriction[] }>(`/users/${userId}/restrictions`),
  updateRestrictions: (userId: string, data: WorkerRestriction[]) =>
    request(`/users/${userId}/restrictions`, { method: "PUT", body: JSON.stringify(data) }),
  getPreferredSchedule: (userId: string) =>
    request<{ data: WorkerPreferredDay[] }>(`/users/${userId}/preferred-schedule`),
  updatePreferredSchedule: (userId: string, data: WorkerPreferredDay[]) =>
    request(`/users/${userId}/preferred-schedule`, { method: "PUT", body: JSON.stringify(data) }),

  // Restriction change requests (worker submits; admin approves/rejects)
  listRestrictionRequests: () =>
    request<{ data: RestrictionRequest[] }>("/restriction-requests"),
  createRestrictionRequest: (data: {
    kind: "permanent" | "temporary";
    effectiveFrom?: string | null;
    effectiveUntil?: string | null;
    restrictions: WorkerRestriction[];
    note?: string | null;
  }) =>
    request<{ data: RestrictionRequest }>("/restriction-requests", { method: "POST", body: JSON.stringify(data) }),
  reviewRestrictionRequest: (id: string, action: "approve" | "reject", adminNote?: string | null) =>
    request<{ data: RestrictionRequest }>(`/restriction-requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action, adminNote: adminNote ?? null }),
    }),
  cancelRestrictionRequest: (id: string) =>
    request<{ data: RestrictionRequest }>(`/restriction-requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "cancel" }),
    }),

  // Email recipients (extra dispatch list for comptable, co-admin, etc.)
  listEmailRecipients: () => request<EmailRecipient[]>("/email-recipients"),
  createEmailRecipient: (data: { label: string; email: string; sendMonthlyDigest?: boolean; sendLeaveAlerts?: boolean }) =>
    request<EmailRecipient>("/email-recipients", { method: "POST", body: JSON.stringify(data) }),
  updateEmailRecipient: (id: string, data: Partial<{ label: string; email: string; sendMonthlyDigest: boolean; sendLeaveAlerts: boolean }>) =>
    request<EmailRecipient>(`/email-recipients/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteEmailRecipient: (id: string) =>
    request<{ ok: boolean }>(`/email-recipients/${id}`, { method: "DELETE" }),

  // Weather
  getWeather: (from: string, to: string) =>
    request<{ data: WeatherDay[] }>(`/weather?from=${from}&to=${to}`),
  refreshWeather: () =>
    request<{ data: { updated: number; errors: string[] } }>("/weather/refresh", { method: "POST" }),
  geocodeAddress: (address: string) =>
    request<{ data: { lat: number; lon: number; schoolZone?: string; holidayZone?: string } }>("/weather/geocode", { method: "POST", body: JSON.stringify({ address }) }),

  // Calendar (public holidays + school vacations)
  getCalendarEvents: (from: string, to: string) =>
    request<{ data: CalendarEvent[] }>(`/calendar?from=${from}&to=${to}`),
  refreshCalendarEvents: () =>
    request<{ data: { holidays: number; vacations: number; errors: string[] } }>("/calendar/refresh", { method: "POST" }),

  // Audit logs
  getAuditLogs: (params?: { from?: string; to?: string; tableName?: string; actorId?: string; action?: string; source?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.tableName) qs.set("tableName", params.tableName);
    if (params?.actorId) qs.set("actorId", params.actorId);
    if (params?.action) qs.set("action", params.action);
    if (params?.source) qs.set("source", params.source);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return request<{ data: AuditLogEntry[] }>(`/audit-logs${q ? `?${q}` : ""}`);
  },

  // Cron runs (Aide tab — last-run-per-job dashboard)
  getCronRuns: () => request<{ data: CronRun[] }>("/settings/cron-runs"),

  // Demo chat
  getDemoPhones: () =>
    request<{ data: { admin: DemoPhone | null; worker1: DemoPhone | null; worker2: DemoPhone | null } }>("/demo/chat/phones"),
  demoChatSend: (phone: string, message: string) =>
    request<{ data: DemoChatResponse }>("/demo/chat/send", {
      method: "POST",
      body: JSON.stringify({ phone, message }),
    }),
  demoChatClear: (phone: string) =>
    request<{ data: { ok: boolean } }>("/demo/chat/clear", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),
  demoChatNotifications: (phone: string, since: string) =>
    request<{ data: { notifications: DemoNotification[] } }>(
      `/demo/chat/notifications?phone=${encodeURIComponent(phone)}&since=${encodeURIComponent(since)}`
    ),
  demoChatTranscribe: async (audioBlob: Blob): Promise<{ data: { text: string } }> => {
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.wav");
    const res = await fetch(`${BASE}/demo/chat/transcribe`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
};

// ── Types (client-side) ──

export type RegisterInput = {
  adminName: string;
  email: string;
  phone: string;
  password: string;
};

export type LegalVersions = {
  terms: string;
  dpa: string;
  privacy: string;
  subprocessors: string;
};

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  phone: string;
  ownerId?: string;
  ownerRole?: "owner_admin" | "owner_manager" | "member";
  activeRestaurantId?: string;
  restaurantId: string;
  restaurantName: string;
  restaurantStatus?: "active" | "pending" | "demo" | "suspended";
  restaurantTimezone?: string;
  mustChangePassword?: boolean;
  onboardingCompletedAt?: string | null;
  permissions?: string | null; // JSON-stringified Partial<Record<Permission, boolean>>; null = use role defaults
  ownerLegalAcceptanceRequired?: boolean;
  ownerLegalVersions?: LegalVersions;
  userNoticeAcceptanceRequired?: boolean;
  userNoticeVersion?: string;
  whatsappOptIn?: boolean;
  restaurants?: AccessibleRestaurant[];
};

export type AccessibleRestaurant = {
  id: string;
  ownerId: string;
  ownerRole?: "owner_admin" | "owner_manager" | "member";
  name: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  permissions?: string | null;
  status?: "active" | "pending" | "demo" | "suspended";
  timezone?: string;
  onboardingCompletedAt?: string | null;
};

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

export type OnboardingState = {
  completedAt: string | null;
  restaurant: {
    name: string;
    address: string | null;
    siret: string | null;
    whatsappBotLocale: "fr" | "en" | "es" | "pt";
    schoolZone: string | null;
    holidayZone: string | null;
    openDays: number[];
    colorScheme: string;
    kitchenSubRoles: string[];
    floorSubRoles: string[];
    defaultContractType: "CDI" | "CDD" | "saisonnier";
    defaultContractHours: number;
    preferredStyle: "equilibre" | "equipe-stable" | "economique" | "resilience";
  };
  counts: { employees: number; profiles: number };
};

export type OnboardingProfileInput = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  siret?: string | null;
  whatsappBotLocale?: "fr" | "en" | "es" | "pt";
};

export type OnboardingEmployeeInput = {
  name: string;
  phone: string;
  email?: string;
  role: "kitchen" | "floor";
  subRoles: string[];
  contractType?: "CDI" | "CDD" | "saisonnier" | "extra";
  contractHours?: number;
};

export type DemoPhone = {
  name: string;
  phone: string;
  role: "admin" | "kitchen" | "floor";
};

export type DemoNotification = {
  id: string;
  type: string;
  message: string;
  createdAt: string;
};

export type DemoChatResponse = {
  reply: string;
  identity: { name: string; role: string };
};

export type User = {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  phone: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  priority: number;
  address?: string | null;
  iban?: string | null;
  startDate?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
  dateOfBirth?: string | null;
  birthPlace?: string | null;
  nationality?: string | null;
  nir?: string | null;
  notes?: string | null;
  managerNotes?: string | null;
  subRole?: string | null;
  subRoles?: string[];
  overtimeWilling?: boolean;
  coupureWilling?: boolean;
  multiRestaurantWilling?: boolean;
  matricule?: string | null;
  contractType?: "CDI" | "CDD" | "saisonnier" | "extra" | null;
  contractEndDate?: string | null;
  contractHours?: number | null;
  maxWeeklyHours?: number | null;
  adminOtOverride?: number | null;
  active?: boolean;
  inactiveFrom?: string | null;
  inactiveUntil?: string | null;
  hcrLevel?: string | null; // "I-1".."V-3", null = unassigned
  hourlyRate?: number | null; // cents — admin override; null = resolve from grid[hcrLevel]
  permissions?: string | null; // JSON-stringified Partial<Record<Permission, boolean>>; null = role default. Only meaningful for managers.
  whatsappOptIn?: boolean;
  sharedFromRestaurantId?: string | null;
  primaryRestaurantId?: string | null;
  primaryRestaurantName?: string | null;
  primaryKitchenColor?: string | null;
  primaryFloorColor?: string | null;
  weeklyHours?: number;
};

export type SchedulingRosterUser = Pick<User, "id" | "name" | "email" | "phone" | "role" | "priority" | "subRoles" | "contractHours" | "active"> & {
  restaurantId: string;
  sharedFromRestaurantId?: string | null;
  primaryRestaurantId?: string | null;
  primaryRestaurantName?: string | null;
  primaryKitchenColor?: string | null;
  primaryFloorColor?: string | null;
  weeklyHours?: number;
};

export type ServiceTemplateOverride = {
  dayOfWeek: number; // 1=Mon … 7=Sun
  startTime: string;
  endTime: string;
};

export type ServiceTemplate = {
  role: "kitchen" | "floor";
  zone: string;
  startTime: string;
  endTime: string;
  sortOrder?: number;
  overrides?: ServiceTemplateOverride[];
};

export type ClosureSchedule = {
  days: Record<string, "both" | "midi" | "soir">;
  kitchen: number;
  service: number;
  times: Record<string, { start: string; end: string }>;
};

export type StaffingProfile = {
  id: string;
  name: string;
  sortOrder: number;
  dayPriorities?: Record<string, number>; // {"1":2,"5":1} — lower = higher importance
  preferredAssignments?: TitulaireAssignment[]; // per-slot pinning — manual seed for the équipe-stable preset
};

export type TitulaireStaleness = "inactive" | "temp_inactive" | "contract_ended" | "contract_ending";

export type TitulaireAssignment = {
  workerId: string;
  dayOfWeek: number; // 1..7
  zone: string;
  role: "kitchen" | "floor";
  subRole?: string | null; // optional: pin worker to a specific sub-role slot in the cell
};

export type TitulaireWorker = {
  id: string;
  name: string;
  role: "admin" | "kitchen" | "floor";
  subRoles: string[];
  contractHours: number | null;
  contractType: "CDI" | "CDD" | "saisonnier" | "extra" | null;
  contractEndDate: string | null;
  active: boolean;
  priority: number;
  staleness: TitulaireStaleness | null;
};

export type TitulairesResponse = {
  profile: { id: string; name: string };
  workers: TitulaireWorker[];
  assignments: TitulaireAssignment[];
  needsReview: number;
};

export type StaffingTarget = {
  profileId?: string;
  dayOfWeek: number;
  role: "kitchen" | "floor";
  zone: string;
  count: number;
  roleBreakdown?: Record<string, number>; // {"Chef":1,"Cuisinier":2}
};

export type ProfileServiceTemplate = {
  profileId: string;
  role: "kitchen" | "floor";
  zone: string;
  startTime: string;
  endTime: string;
  sortOrder?: number;
  overrides?: ServiceTemplateOverride[];
};

export type StaffingTargetsResponse = {
  profiles: StaffingProfile[];
  targets: StaffingTarget[];
  profileTemplates?: ProfileServiceTemplate[];
};

export type StaffingWeekAssignment = {
  profileId: string;
  year: number;
  week: number;
};

export type RestaurantClosure = {
  id: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  schedule: ClosureSchedule | null;
};

export type ColorScheme = "classic" | "garden" | "sunset" | "ocean" | "earth" | "candy";

export type WorkerConfig = {
  workerPreferencesEnabled: boolean;
  tapInOutEnabled: boolean;
  colorScheme: ColorScheme;
};

export type OvertimeMode = "strict" | "controlled" | "flexible";
export type OvertimeDistribution = "willing-first" | "by-priority" | "even";

export type CalendarEvent = {
  type: "public_holiday" | "school_vacation";
  date: string;
  endDate: string | null;
  name: string;
};

export type AdminPreferences = {
  restaurantName: string;
  restaurantAddress: string;
  siret: string | null;
  whatsappBotLocale: "fr" | "en" | "es" | "pt";
  tapInOutEnabled: boolean;
  tapInOutAdminConfirmation: boolean;
  tapInOutMode: "sync" | "lateness_only";
  tapInCountsAsHours: boolean;
  reminderFrequency: "off" | "daily" | "weekly";
  includeSilaeInMonthlyDigest: boolean;
  colorScheme: ColorScheme;
  kitchenColor: string;
  floorColor: string;
  workerPreferencesEnabled: boolean;
  autoStaffingWeeks: number; // 0=off, 1-4 = weeks in advance
  disabledComplianceRules: string[]; // array of disabled rule codes
  kitchenSubRoles: string[];
  floorSubRoles: string[];
  overtimeMode: OvertimeMode;
  overtimeWeeklyCap: number; // 39-48h
  overtimeDistribution: OvertimeDistribution;
  hcrGrid: Partial<Record<string, number>>; // per-restaurant HCR rate overrides in cents, keyed by "I-1".."V-3"
  subroleHcrMap: Record<string, string>; // sub-role name → HCR niveau (e.g. "Cuisinier" → "II-2")
  defaultContractType: "CDI" | "CDD" | "saisonnier";
  defaultContractHours: number;
  silaeCodes: Record<"heuresNormales" | "hs110" | "hs120" | "hs150" | "repas" | "congesPayes" | "maladie", string>;
  preferredStyle: "equilibre" | "equipe-stable" | "economique" | "resilience";
  customWeights: Record<string, number>; // TunableDimension → SemanticLevel (0..4)
};

export type WorkerHourSummary = {
  workerId: string;
  workerName: string;
  role: "kitchen" | "floor";
  contractHours: number;
  plannedHours: number;
  deficit: number;
  overtimeHours: number;
};

export type AutostaffingPlan = {
  week: { from: string; to: string };
  services: Array<{
    date: string;
    workerId: string;
    workerName: string;
    role: "kitchen" | "floor";
    zone: string;
    startTime: string;
    endTime: string;
  }>;
  warnings: string[];
  workerHourSummary?: WorkerHourSummary[];
};

export type AutostaffingResult = {
  week: { from: string; to: string };
  created: number;
  skipped: number;
  total: number;
  unfilled?: number;
  warnings?: string[];
};

export type WeatherDay = {
  date: string;
  weatherCode: number | null;
  tempMax: number | null;
  tempMin: number | null;
  sunrise: string | null;
  sunset: string | null;
  normalTempMax: number | null;
  normalTempMin: number | null;
  hourlyWeatherCodes: number[] | null;
  hourlyTemperatures: number[] | null;
  isForecast: boolean;
};

export type WorkerAvailabilityDay = {
  dayOfWeek: number; // 1=Mon, 7=Sun
  midi: boolean;
  soir: boolean;
  midiStart?: string | null;
  midiEnd?: string | null;
  soirStart?: string | null;
  soirEnd?: string | null;
  continuous?: boolean;
  zones?: Record<string, boolean>; // per-zone availability: {"Matin": true, "Continu": false, ...}
};

export type WorkerRestriction = {
  dayOfWeek: number; // 1=Mon, 7=Sun
  startTime?: string | null; // HH:MM or null for full day
  endTime?: string | null;
  reason?: string | null;
  effectiveFrom?: string | null; // YYYY-MM-DD, null = always on (permanent)
  effectiveUntil?: string | null;
};

export type EmailRecipient = {
  id: string;
  restaurantId: string;
  label: string;
  email: string;
  sendMonthlyDigest: boolean;
  sendLeaveAlerts: boolean;
  createdAt: string;
};

export type RestrictionRequest = {
  id: string;
  workerId: string;
  workerName?: string | null; // populated when admin fetches
  restaurantId: string;
  kind: "permanent" | "temporary";
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  restrictions: WorkerRestriction[];
  status: "pending" | "approved" | "rejected" | "cancelled";
  note: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

export type WorkerPreferredDay = {
  dayOfWeek: number; // 1=Mon, 7=Sun
  midi: boolean;
  soir: boolean;
};

export type Document = {
  id: string;
  name: string;
  type: "id" | "contract" | "certificate" | "medical" | "other";
  filename: string;
  mimeType: string;
  size: number;
  data?: string;
  createdAt: string;
  requirementKey?: string | null;
  issuedAt?: string | null;
  expiresAt?: string | null;
  signedAt?: string | null;  // set on type='contract' docs when admin marks as signed
  reviewedAt?: string | null;
  reviewedBy?: string | null;
};

export type PresignResult = {
  documentId: string;
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
};

export type DocumentBlob = Document & ({ data: string } | { url: string; urlExpiresAt: string });

export type RequirementKey =
  | "id_card" | "vital_card" | "residence_proof" | "rib"
  | "work_permit" | "medical_cert" | "haccp_cert" | "parental_auth" | "diploma";

export type ChecklistItemStatus = "missing" | "pending_review" | "uploaded" | "valid" | "expiring_soon" | "expired";

export type ChecklistItem = {
  key: RequirementKey;
  label: string;
  description: string;
  category: "identity" | "administrative" | "medical" | "qualification" | "legal";
  mandatory: boolean;
  status: ChecklistItemStatus;
  documentId?: string;
  uploadedAt?: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  daysUntilExpiry?: number | null;
  hint?: string;
};

export type WorkerChecklist = {
  workerId: string;
  workerName: string;
  items: ChecklistItem[];
  mandatoryTotal: number;
  mandatoryValid: number;
  percentComplete: number;
  readyForDpae: boolean;
  missingDpaeFields: string[];
  missingPayrollFields: string[];
  missingProfileFields: string[];
  expiringWithin30d: number;
  pendingReview: number;
};

export type ExpiringDocAlert = {
  workerId: string;
  workerName: string;
  requirementKey: RequirementKey;
  label: string;
  expiresAt: string;
  daysUntilExpiry: number;
  expired: boolean;
};

export type ServiceRow = {
  id: string;
  workerId: string;
  workerName: string;
  workerRole: string;
  workerSubRoles?: string[];
  date: string;
  startTime: string;
  endTime: string;
  role: string;
  status: string;
  notes: string | null;
  source?: "manual" | "auto";
  filledAs?: string | null; // sub-role this worker fills the slot as, when non-exact substitution
};

export type StaffingInfo = {
  profileId: string | null;
  profileName: string | null;
  hasAuto: boolean;
  hasManual: boolean;
  autoModified: boolean;
};

export type LaborCostSummary = {
  daily: Record<string, number>; // YYYY-MM-DD → euros
  weekly: number;                 // euros
  unpricedWorkerCount: number;    // workers without a resolvable rate (counted in 0)
};

export type WeekSchedule = {
  week: { from: string; to: string };
  weekPast?: boolean;
  weekLocked?: boolean;
  services: ServiceRow[];
  cancelledServices?: ServiceRow[];
  staffingInfo?: StaffingInfo;
  laborCost?: LaborCostSummary;
};

export type HoursSummary = {
  workerId: string;
  workerName: string;
  period: string;
  totalHours: number;
  serviceCount: number;
};

export type WhoWorksEntry = {
  workerId: string;
  workerName: string;
  role: string;
  startTime: string;
  endTime: string;
  status: string;
};

export type CreateUserInput = {
  name?: string; // legacy; prefer firstName + lastName
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  phone: string;
  role: "manager" | "kitchen" | "floor";
  password?: string;
  priority?: number;
  address?: string | null;
  iban?: string | null;
  startDate?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
  dateOfBirth?: string | null;
  birthPlace?: string | null;
  nationality?: string | null;
  nir?: string | null;
  notes?: string | null;
  subRole?: string | null;
  subRoles?: string[];
  overtimeWilling?: boolean;
  contractType?: "CDI" | "CDD" | "saisonnier" | "extra" | null;
  contractEndDate?: string | null;
  contractHours?: number | null;
  hcrLevel?: string | null;
  hourlyRate?: number | null; // cents — admin override; null = resolve from grid[hcrLevel]
  matricule?: string | null;
  adminOtOverride?: number | null;
  managerNotes?: string | null;
};

export type CreateServiceInput = {
  workerId: string;
  date: string;
  startTime: string;
  endTime: string;
  role: "kitchen" | "floor";
  notes?: string | null;
};

export type MoveServiceInput = {
  serviceId: string;
  newDate?: string;
  newStartTime?: string;
  newEndTime?: string;
  newWorkerId?: string;
};

export type CreateReplacementInput = {
  requesterServiceId: string;
  /** Optional. Omit for admin-mediated flow (recommended). */
  targetId?: string | null;
  message?: string | null;
  medical?: boolean;
  documents?: Array<{ name: string; filename: string; mimeType: string; size: number; storageKey: string }>;
};

export type ReplacementStatus =
  | "awaiting_admin_decision"
  | "awaiting_worker_reply"
  | "accepted"
  | "approved_without_replacement"
  | "rejected"
  | "expired"
  | "cancelled";

export type ReplacementRequest = {
  id: string;
  requesterId: string;
  requesterServiceId: string;
  targetId: string | null;
  status: ReplacementStatus;
  message: string | null;
  expiresAt: string;
  createdAt: string;
  candidateIds: string[] | null;
  candidateScores: Record<string, number> | null;
  adminNotifiedAt: string | null;
  workerNotifiedAt: string | null;
  escalationCount: number;
  rejectedCandidateIds: string[];
  medical: boolean;
  ittReminderSentAt: string | null;
  documentCount?: number;
};

export type ReviewReplacementDecision = "pick" | "broadcast" | "refuse" | "approve_absence";

export type HolidayRequest = {
  id: string;
  workerId: string;
  workerName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  medical: boolean;
  documentCount: number;
  status: string;
  source?: "worker" | "admin_proposal";
  createdAt: string;
};

export type HolidayDocument = {
  id: string;
  name: string;
  type: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type HolidayDocumentBlob = HolidayDocument & ({ data: string } | { url: string; urlExpiresAt: string });

export type HolidayImpact = {
  holidayId: string;
  workerName: string;
  workerRole: string;
  startDate: string;
  endDate: string;
  totalServicesAffected: number;
  daysWithImpact: Array<{
    date: string;
    servicesToCancel: number;
    sameRoleTotal: number;
    sameRoleWithout: number;
    belowTarget: boolean;
    targetCount: number;
  }>;
  daysBelowTarget: number;
  overlappingHolidays: Array<{
    workerName: string | null;
    workerRole: string | null;
    startDate: string;
    endDate: string;
    status: string;
  }>;
  hoursImpact?: {
    contractHours: number;
    lostHours: number;
    holidayDays: number;
    canAbsorbWithoutOT: boolean;
    remainingTeamSlack: number;
    canCoverWithOvertime?: boolean;
    overtimeHoursNeeded?: number;
    remainingOvertimeCapacity?: number;
    subRoleCoverage?: Array<{ subRole: string; coveredBy: number; totalNeeded: number }>;
  };
  structuralImpact?: {
    slotsAffected: Array<{
      dayOfWeek: number;
      zone: string;
      role: string;
      baselineFilled: number;
      withoutFilled: number;
      target: number;
      becameUnfillable: boolean;
    }>;
    slotsBecameUnfillable: number;
    baselineUnfillable: number;
    withoutUnfillable: number;
    capacityBefore: { total: number; demand: number; ratio: number } | null;
    isBottleneck: boolean;
    workerDemandShare: number;
    workersAlreadyOut: number;
    solverBacked: boolean;
  };
};

export type BatchHolidayImpact = {
  clusters: Array<{
    holidays: Array<{
      holidayId: string;
      workerName: string;
      workerRole: string;
      startDate: string;
      endDate: string;
      recommendation: "approve" | "deny";
      reason: string;
      unfillableSlots?: Array<{ dayOfWeek: number; zone: string; role: string; filled: number; filledBaseline: number; target: number }>;
    }>;
    approveCount: number;
    denyCount: number;
  }>;
};

export type ClockStatus = {
  clockedIn: boolean;
  current: { id: string; tapIn: string; serviceId: string | null; date: string } | null;
};

export type ClockRecord = {
  id: string;
  userId: string;
  serviceId: string | null;
  tapIn: string;
  tapOut: string | null;
  date: string;
  adminConfirmedAt?: string | null;
  adminConfirmedBy?: string | null;
};

export type TimeclockConfirmation = ClockRecord & {
  userName: string | null;
};

export type LatenessRecord = {
  id: string;
  userId: string;
  userName: string;
  date: string;
  tapIn: string;
  tapOut: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  lateMin: number;
  earlyLeaveMin: number;
};

export type LatenessReport = {
  records: LatenessRecord[];
  totals: { userId: string; userName: string; totalLateMin: number; totalEarlyLeaveMin: number; count: number }[];
};

export type RevenueEntry = {
  id: string;
  date: string;
  amount: number;
  notes: string | null;
};

export type ComplianceViolation = {
  workerId: string;
  workerName: string;
  rule: string;
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  detail: string;
  date?: string;
  value?: number;
  limit?: number;
};

export type OvertimeEntry = {
  workerId: string;
  workerName: string;
  weeklyHours: number;
  overtimeHours: number;
  breakdown: {
    rate110: number;
    rate120: number;
    rate150: number;
  };
};

export type SubRoleGap = {
  subRole: string;
  needed: number;
  available: number;
  gap: number;
};

export type SlotAnalysis = {
  dayOfWeek: number;
  role: "kitchen" | "floor";
  zone: string;
  target: number;
  available: number;
  availableNames: string[];
  gap: number;
  status: "covered" | "tight" | "understaffed" | "overstaffed" | "closed";
  fragility: number;
  effectiveAvailability: number;
  subRoleGaps?: SubRoleGap[];
};

export type RoleSummary = {
  role: "kitchen" | "floor";
  totalWorkers: number;
  worstGap: number;
  worstSlotLabel: string;
  slotsUnderstaffed: number;
  slotsTight: number;
  recommendation: string;
  hireNeeded: number;
};

export type CapacitySummary = {
  role: "kitchen" | "floor";
  totalDemand: number;
  totalCapacity: number;
  capacityRatio: number;
  surplusServices: number;
  totalContractHours?: number;
  totalDemandHours?: number;
  hoursRatio?: number;
  surplusHours?: number;
  surplusWorkers?: number;
  avgContractHours?: number;
  verdict?: "oversized" | "undersized" | "balanced" | "tight";
};

export type WorkerLoad = {
  workerId: string;
  workerName: string;
  role: "kitchen" | "floor";
  availableSlots: number;
  maxServices: number;
  demandShare: number;
  isBottleneck: boolean;
  bottleneckSlots: string[];
  contractType?: string | null;
  contractHours?: number;
  maxWeeklyHours?: number;
  subRoles?: string[];
  employmentActionEligible?: boolean;
};

export type SlotDiagnostic = {
  dayOfWeek: number;
  zone: string;
  filled: number;
  target: number;
  assigned: Array<{ workerId: string; workerName: string }>;
  blocked: Array<{ workerId: string; workerName: string; reason: string; detail?: string }>;
  couldCover: Array<{ workerId: string; workerName: string; currentHours: number; contractHours: number }>;
};

export type StaffingAction = {
  type: "terminate" | "reduce_hours" | "check_restrictions" | "missing_subrole" | "hire" | "convert_seasonal" | "key_dependency";
  priority: "high" | "medium" | "low";
  role: "kitchen" | "floor";
  message: string;
  workerIds?: string[];
  workerNames?: string[];
  workerContractTypes?: (string | null)[];
  workerSubRoles?: string[][];
  detail?: string;
  slotDiagnostics?: SlotDiagnostic[];
};

export type StaffingAnalysis = {
  slots: SlotAnalysis[];
  roles: RoleSummary[];
  capacity: CapacitySummary[];
  workerLoads: WorkerLoad[];
  actions?: StaffingAction[];
  openDays: Record<string, "both" | "midi" | "soir">;
  zones?: string[];
  profiles: Array<{ id: string; name: string }>;
  activeProfileId: string | null;
  analysisWeek: string | null;
  theoretical: boolean;
  ilpStats?: string;
  warnings?: string[];
  longHorizon?: LongHorizonStaffingSummary;
};

export type LongHorizonStaffingSummary = {
  status: "running" | "ok" | "error" | "missing";
  horizonWeeks: number;
  baseMonday: string;
  profileId?: string;
  generatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  cacheKey?: string;
  assignments?: number;
  slots?: number;
  uncoveredSlots?: number;
  shortage?: number;
  solveStatus?: string;
  solveTier?: number;
  relaxations?: string[];
  solverUsed?: string;
  solveTimeMs?: number;
  error?: string;
};

export type QuietPeriodSuggestion = {
  start: string;
  end: string;
  durationDays: number;
  label: string;
  source: "school_vacation" | "public_holiday";
};

export type HolidayAdviceForRole = {
  role: "kitchen" | "floor";
  surplusHoursPerWeek: number;
  workerWeeksAbsorbable: number;
  candidatePeriods: QuietPeriodSuggestion[];
  recommendation: string;
  priority: "high" | "medium" | "low" | "none";
};

export type WorkerLeaveSuggestion = {
  workerId: string;
  workerName: string;
  role: "kitchen" | "floor";
  remainingDays: number;
  expiringSoon: boolean;
  weekStart: string;
  weekEnd: string;
  suggestedDays: number;
  reason: string;
  source: "closure" | "solver";
};

export type HolidayAdvice = {
  generatedAt: string;
  byRole: HolidayAdviceForRole[];
  upcomingQuietPeriods: QuietPeriodSuggestion[];
  workerSuggestions: WorkerLeaveSuggestion[];
};

export type LeaveBalance = {
  workerId: string;
  workerName: string;
  role: "kitchen" | "floor";
  earnedDays: number;
  takenDays: number;
  remainingDays: number;
  expiringDays: number;
  expiringSoon: boolean;
};

export type LeaveUrgency = {
  workerId: string;
  urgency: number;
  remainingDays: number;
  expiringSoon: boolean;
};

export type LeaveComplianceViolation = {
  workerId: string;
  workerName: string;
  code: "HCR-CONGES-PAYES-MINIMUM";
  severity: "warning";
  remainingDays: number;
  daysUntilPeriodEnd: number;
  message: string;
};

export type PendingClusterRecommendation = {
  holidayId: string;
  workerName: string;
  workerRole: string;
  startDate: string;
  endDate: string;
  recommendation: "approve" | "deny";
  reason: string;
  unfillableSlots?: Array<{ dayOfWeek: number; zone: string; role: string; filled: number; filledBaseline: number; target: number }>;
  balanceContext?: {
    remainingDays: number;
    expiringSoon: boolean;
  };
};

export type PendingCluster = {
  holidays: PendingClusterRecommendation[];
  approveCount: number;
  denyCount: number;
};

export type LeaveIntelligence = {
  generatedAt: string;
  balances: LeaveBalance[];
  advice: HolidayAdvice;
  pendingClusters: PendingCluster[];
  compliance: LeaveComplianceViolation[];
  urgency: LeaveUrgency[];
};

export type ExpansionBaselineSource = {
  method: "weekend_cluster" | "weekday_cluster" | "all_days_mean" | "fallback";
  matchedDays: number[];
};

export type ExpansionProposedTarget = {
  dayOfWeek: number;
  role: "kitchen" | "floor";
  zone: string;
  count: number;
  roleBreakdown?: Record<string, number>;
};

export type ExpansionFeasibility = {
  totalAddedSlots: number;
  filledSlots: number;
  unfilledByRole: Record<"kitchen" | "floor", number>;
  otHoursAdded: Record<"kitchen" | "floor", number>;
  hireNeededHours: Record<"kitchen" | "floor", number>;
  hireNeededWorkers: Record<"kitchen" | "floor", number>;
};

export type ExpansionInsight = {
  dayOfWeek: number;
  dayLabel: string;
  shift: "midi" | "soir";
  shiftLabel: string;
  zones: string[];
  addedDemandHours: Record<"kitchen" | "floor", number>;
  baselineSource: ExpansionBaselineSource;
  proposedTargets: ExpansionProposedTarget[];
  feasibility: ExpansionFeasibility;
  verdict: "viable" | "needs_hire" | "not_feasible";
  summary: string;
};

export type WeightsPreviewMetrics = {
  status: string;
  kitchenFillPct: number;
  salleFillPct: number;
  totalHours: number;
  otHours: number;
  subRoleMismatch: number;
};

export type WeightsPreviewAssignmentChange = {
  workerId: string;
  workerName: string;
  hoursDelta: number;
  slotsAdded: Array<{ dayOfWeek: number; role: "kitchen" | "floor"; zone: string }>;
  slotsRemoved: Array<{ dayOfWeek: number; role: "kitchen" | "floor"; zone: string }>;
};

export type WeightsPreviewSide = {
  preset?: string;
  customWeights?: Record<string, number>;
};

export type WeightsPreview = {
  configA: WeightsPreviewMetrics;
  configB: WeightsPreviewMetrics;
  jaccard: number;
  changedWorkerCount: number;
  totalAssignmentsChanged: number;
  sampleChanges: WeightsPreviewAssignmentChange[];
  numWeeks: number;
};

export type OptimizationImpact = {
  surplusHoursDelta: Record<string, number>;
  understaffedSlotsDelta: Record<string, number>;
  verdictChange?: { role: string; from: string; to: string };
  hoursRedistributed: number;
  affectedWorkers: Array<{ workerId: string; workerName: string; hoursDelta: number }>;
};

export type OptimizationRecommendation = {
  id: string;
  type: "reduce_contract" | "remove_restrictions" | "reduce_to_planned" | "increase_hours" | "cross_train" | "intra_train" | "terminate";
  label: string;
  description: string;
  workerId: string;
  workerName: string;
  role: "kitchen" | "floor";
  contractType?: string | null;
  currentValue: number;
  proposedValue: number;
  impact: OptimizationImpact;
  score: number;
  contractOverrides?: Record<string, number>;
  maxWeeklyOverrides?: Record<string, number>;
};

export type CompoundPlan = {
  id: string;
  label: string;
  description: string;
  moveIds: string[];
  actions?: OptimizationRecommendation[];
  totalImpact: OptimizationImpact;
  totalScore: number;
  finalState?: Record<string, { surplus: number; understaffed: number; verdict: string }>;
};

export type HireRecommendation = {
  id: string;
  type: "hire_cdi" | "hire_seasonal";
  label: string;
  description: string;
  role: "kitchen" | "floor";
  contractHours: number;
  neededSlots: Array<{ day: number; dayLabel: string; zone: string; startTime?: string; endTime?: string; subRoles?: string[]; currentFill?: number; target?: number }>;
  idealProfile?: {
    pattern: "midi" | "soir" | "coupure" | "mixte";
    days: string[];
    zones: string[];
    subRoles: string[];
  };
  analysisWeeks?: number;
  overtimeHoursReducedPerWeek?: number;
  overtimeCostReducedCents?: number;
  newHireCostCents?: number;
  netLaborSavingsCents?: number;
  score: number;
};

export type OtPolicyRecommendation = {
  id: string;
  type: "ot_policy_change";
  label: string;
  description: string;
  currentMode: string;
  proposedMode: string;
  proposedCap?: number;
  extraCapacityHours: Record<string, number>;
  score: number;
  direction?: "upgrade" | "downgrade";
};

export type AutoOptimizeResult = {
  recommendations: OptimizationRecommendation[];
  compounds: CompoundPlan[];
  hireRecommendations: HireRecommendation[];
  otPolicyRecommendations: OtPolicyRecommendation[];
  baseline: {
    kitchen: { surplus: number; understaffed: number; verdict: string; totalContract: number; totalCapacity?: number; totalDemand: number; otCapacity?: number };
    floor: { surplus: number; understaffed: number; verdict: string; totalContract: number; totalCapacity?: number; totalDemand: number; otCapacity?: number };
    otMode?: string;
    otWeeklyCap?: number;
    scenariosRun: number;
  } | null;
  profiles: Array<{ id: string; name: string }>;
  activeProfileId: string | null;
  aborted?: boolean;
};

export type ComplianceRuleMeta = {
  code: string;
  label: string;
  description: string;
  lawUrl: string;
};

export type ComplianceResult = {
  week: { from: string; to: string };
  violations: ComplianceViolation[];
  overtime: OvertimeEntry[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    workersChecked: number;
  };
};

export type OTBreakdown = { rate110: number; rate120: number; rate150: number };

export type MonthlyRecapWeek = {
  week: { from: string; to: string };
  hours: number;
  actualHours: number;
  overtime: number;
  actualOvertime: number;
  services: number;
  actualServices: number;
  breakdown: OTBreakdown;
  actualBreakdown: OTBreakdown;
};

export type MonthlyRecapWorker = {
  workerId: string;
  workerName: string;
  workerRole: string;
  contractHours: number | null;
  overtimeWilling: boolean;
  serviceCount: number;
  actualServiceCount: number;
  totalHours: number;
  actualHours: number;
  holidayDays: number;
  actualHolidayDays: number;
  holidayHours: number;
  actualHolidayHours: number;
  overtimeHours: number;
  actualOvertimeHours: number;
  overtimeBreakdown: OTBreakdown;
  actualOvertimeBreakdown: OTBreakdown;
  analytics: Array<{
    restaurantId: string;
    restaurantName: string;
    serviceCount: number;
    actualServiceCount: number;
    totalHours: number;
    actualHours: number;
  }>;
  weeks: MonthlyRecapWeek[];
};

export type MonthlyRecap = {
  month: string;
  today: string;
  workers: MonthlyRecapWorker[];
  totals: {
    serviceCount: number;
    actualServiceCount: number;
    totalHours: number;
    actualHours: number;
    holidayDays: number;
    actualHolidayDays: number;
    holidayHours: number;
    actualHolidayHours: number;
    overtimeHours: number;
    actualOvertimeHours: number;
  };
};

export type PayrollWeek = {
  weekNum: number;
  from: string;
  to: string;
  totalHours: number;
  monthHours: number;
  overtime: number;
  breakdown: { rate110: number; rate120: number; rate150: number };
  straddling: boolean;
};

export type PayrollAbsence = {
  type: "holiday" | "sick";
  startDate: string;
  endDate: string;
  days: number;
};

export type PayrollWorker = {
  workerId: string;
  matricule: string | null;
  name: string;
  role: "kitchen" | "floor";
  baseHours: number;
  totalHours: number;
  overtimeHours: number;
  ot110: number;
  ot120: number;
  ot150: number;
  daysWorked: number;
  servicesWorked: number;
  holidayDays: number;
  sickDays: number;
  absences: PayrollAbsence[];
  mealDays: number;
  weeks: PayrollWeek[];
};

export type PayrollExport = {
  month: string;
  restaurantName: string;
  generatedAt: string;
  baseReference: number;
  otThreshold: number;
  workers: PayrollWorker[];
  totals: {
    baseHours: number;
    totalHours: number;
    overtimeHours: number;
    ot110: number;
    ot120: number;
    ot150: number;
    daysWorked: number;
    holidayDays: number;
    sickDays: number;
  };
};

export type AuditLogEntry = {
  id: string;
  tableName: string;
  rowId: string;
  action: "insert" | "update" | "delete";
  actorId: string | null;
  actorName: string | null;
  source: string;
  changes: Record<string, { old?: unknown; new?: unknown }> | null;
  summary: string | null;
  createdAt: string;
};

export type CronRun = {
  jobName: string;
  attempt: number;
  status: "running" | "ok" | "error";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: string | null;
};

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "cancelled" | "unpaid";

export type BillingInfo = {
  status: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionPeriodEnd: string | null;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  cancelAt: string | null;
};

export type ActiveEmployeesInfo = {
  month: string;
  activeCount: number;
  workers: string[];
  restaurants?: {
    restaurantId: string;
    restaurantName: string;
    activeCount: number;
    workers: string[];
  }[];
  estimatedCost: number;
};

export type RevenueStats = {
  totalRevenue: number;
  daysWithData: number;
  daily: { date: string; amount: number }[];
  avgDaily: number;
  workerStats: {
    workerId: string;
    totalHours: number;
    revenueShare: number;
    daysWorked: number;
    revenuePerHour: number;
  }[];
};
