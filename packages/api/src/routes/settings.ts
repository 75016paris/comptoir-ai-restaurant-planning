import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { serviceTemplates, serviceTemplateOverrides, restaurants, restaurantClosures, staffingTargets, staffingProfiles, staffingSchedule, users, holidayRequests } from "../db/schema.js";
import { eq, and, gte, lte, ne, or, inArray, sql } from "drizzle-orm";
import { getMonday, fmtDate } from "../utils/scheduling.js";
import { requireAuth, requirePermission, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { upsertServiceTemplatesSchema, resolveWeights, parseCustomWeights, DIMENSION_META, flattenZodError } from "@comptoir/shared";
import { DEFAULT_CONTRACT_HOURS, DEFAULT_CONTRACT_TYPE } from "@comptoir/shared";
import { analyzeStaffing } from "../services/staffing-analysis.js";
import { logAudit } from "../db/audit.js";
import { runMultiWeekSolve, computeOtCapacity, type MultiWeekSolveResult } from "../services/multi-week-solver.js";
import { bumpCacheVersion } from "../services/baseline-cache.js";
import { enrichWithILP } from "../services/staffing-enrichment.js";
import { computeExpansionInsights } from "../services/expansion-suggestions.js";
import { computeWeightsPreview } from "../services/weights-preview.js";
import { runAutoOptimize } from "../services/optimize-engine.js";
import { recordTrainingMove } from "../services/sub-role-training-cost.js";
import { notifyHolidayImposed } from "../services/notifications.js";
import { getLatestCronRuns } from "../services/cron-runner.js";
import { syncSiretToStripe } from "../services/billing.js";
import { normalizeSilaeCodes, SILAE_DEFAULT_CODES } from "../services/payroll.js";
import { replaceStaffingTargetsConfiguration } from "../services/staffing-target-persistence.js";
import { listRestaurantMemberUserIds, listSchedulingRosterWorkers } from "../services/restaurant-context.js";
import {
  getLongHorizonStaffingAnalysis,
  refreshLongHorizonStaffingAnalysisInBackground,
} from "../services/staffing-analysis-cache.js";

export const settingsRoutes = new Hono<AppEnv>();

export function parseStaffingAnalysisJsonParam<T>(name: string, raw: string | undefined): { ok: true; value: T | undefined } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, error: `${name} doit être un JSON valide` };
  }
}

export function filterStaffingWhatIfOverrides<T>(
  overrides: Record<string, T> | undefined,
  allowedWorkerIds: Set<string>,
): Record<string, T> | undefined {
  if (!overrides) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(overrides).filter(([workerId]) => allowedWorkerIds.has(workerId)),
  ) as Record<string, T>;
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function filterStaffingRestrictionOverrides(
  overrides: string[] | undefined,
  allowedWorkerIds: Set<string>,
): string[] | undefined {
  if (!overrides) return undefined;
  const filtered = overrides.filter((workerId) => allowedWorkerIds.has(workerId));
  return filtered.length > 0 ? filtered : undefined;
}

export function stripInternalStaffingWorkerLoadFields<T extends { sharedFromRestaurantId?: unknown }>(
  worker: T,
): Omit<T, "sharedFromRestaurantId"> {
  const { sharedFromRestaurantId: _sharedFromRestaurantId, ...safeWorker } = worker;
  return safeWorker;
}

function hasUsableStaffingSolve(solve: MultiWeekSolveResult, hasDemand: boolean): boolean {
  if (!hasDemand) return true;
  const status = solve.ilpResult.status;
  if (status !== "optimal" && status !== "feasible") return false;
  const assignedBySlot = new Map<number, number>();
  for (const a of solve.ilpResult.assignments) {
    assignedBySlot.set(a.slotId, (assignedBySlot.get(a.slotId) ?? 0) + 1);
  }
  return solve.mergedSlots.every(s => {
    if (s.compound && s.compoundPairId !== undefined && s.id > s.compoundPairId) return true;
    const target = Math.max(0, s.target - s.existingFill);
    return target === 0 || (assignedBySlot.get(s.id) ?? 0) >= target;
  });
}

settingsRoutes.use("*", requireAuth);
// Subscription check on all mutating routes — GET preferences exempt so admins can resubscribe
settingsRoutes.use("/service-templates", requireActiveSubscription);
settingsRoutes.use("/open-days", requireActiveSubscription);
settingsRoutes.use("/medical-mode", requireActiveSubscription);
settingsRoutes.use("/closures/*", requireActiveSubscription);
settingsRoutes.use("/closures", requireActiveSubscription);
settingsRoutes.use("/staffing-targets", requireActiveSubscription);
settingsRoutes.use("/staffing-analysis", requireActiveSubscription);
// PUT preferences requires subscription (GET exempt so admins can view billing/resubscribe)
settingsRoutes.put("/preferences", requireActiveSubscription);

// GET /settings/service-templates — returns the active profile's templates
settingsRoutes.get("/service-templates", async (c) => {
  const restaurant = requestRestaurant(c);

  // Resolve active profile (first by sort order)
  const activeProfile = db.select({ id: staffingProfiles.id })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurant.restaurantId))
    .orderBy(staffingProfiles.sortOrder)
    .limit(1).all()[0];

  if (!activeProfile) return c.json({ data: [] });

  const rows = db
    .select({
      id: serviceTemplates.id,
      role: serviceTemplates.role,
      zone: serviceTemplates.zone,
      startTime: serviceTemplates.startTime,
      endTime: serviceTemplates.endTime,
      sortOrder: serviceTemplates.sortOrder,
    })
    .from(serviceTemplates)
    .where(and(
      eq(serviceTemplates.restaurantId, restaurant.restaurantId),
      eq(serviceTemplates.profileId, activeProfile.id),
    ))
    .orderBy(serviceTemplates.sortOrder, serviceTemplates.role)
    .all();

  // Fetch overrides for these templates
  const templateIds = rows.map(r => r.id);
  const overrideRows = templateIds.length > 0
    ? db.select({
        templateId: serviceTemplateOverrides.templateId,
        dayOfWeek: serviceTemplateOverrides.dayOfWeek,
        startTime: serviceTemplateOverrides.startTime,
        endTime: serviceTemplateOverrides.endTime,
      }).from(serviceTemplateOverrides)
        .where(sql`${serviceTemplateOverrides.templateId} IN (${sql.join(templateIds.map(id => sql`${id}`), sql`, `)})`)
        .all()
    : [];

  // Group overrides by templateId
  const overrideMap = new Map<string, { dayOfWeek: number; startTime: string; endTime: string }[]>();
  for (const o of overrideRows) {
    if (!overrideMap.has(o.templateId)) overrideMap.set(o.templateId, []);
    overrideMap.get(o.templateId)!.push({ dayOfWeek: o.dayOfWeek, startTime: o.startTime, endTime: o.endTime });
  }

  const data = rows.map(({ id, ...rest }) => ({
    ...rest,
    overrides: overrideMap.get(id) || [],
  }));

  return c.json({ data });
});

// PUT /settings/service-templates — replace active profile's templates (admin only)
settingsRoutes.put("/service-templates", requirePermission("RESTAURANT_SETTINGS"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const parsed = upsertServiceTemplatesSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  // Resolve active profile
  const activeProfile = db.select({ id: staffingProfiles.id })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurant.restaurantId))
    .orderBy(staffingProfiles.sortOrder)
    .limit(1).all()[0];

  if (!activeProfile) {
    return c.json({ error: "No staffing profile found" }, 400);
  }

  const profileId = activeProfile.id;

  const templateInputs = parsed.data.map((t, i) => ({
    restaurantId: restaurant.restaurantId,
    profileId,
    role: t.role,
    zone: t.zone,
    startTime: t.startTime,
    endTime: t.endTime,
    sortOrder: t.sortOrder ?? i,
    overrides: t.overrides || [],
  }));

  const insertedTemplates: { id: string; role: string; zone: string; startTime: string; endTime: string; sortOrder: number; overrides: { dayOfWeek: number; startTime: string; endTime: string }[] }[] = [];

  db.transaction((tx) => {
    // Delete overrides for existing profile templates
    const existingIds = tx.select({ id: serviceTemplates.id }).from(serviceTemplates)
      .where(and(
        eq(serviceTemplates.restaurantId, restaurant.restaurantId),
        eq(serviceTemplates.profileId, profileId),
      )).all().map(r => r.id);
    for (const eid of existingIds) {
      tx.delete(serviceTemplateOverrides).where(eq(serviceTemplateOverrides.templateId, eid)).run();
    }

    tx.delete(serviceTemplates)
      .where(and(
        eq(serviceTemplates.restaurantId, restaurant.restaurantId),
        eq(serviceTemplates.profileId, profileId),
      ))
      .run();

    for (const t of templateInputs) {
      const { overrides, ...templateData } = t;
      const [inserted] = tx.insert(serviceTemplates).values(templateData).returning({ id: serviceTemplates.id }).all();

      const savedOverrides: { dayOfWeek: number; startTime: string; endTime: string }[] = [];
      for (const o of overrides) {
        tx.insert(serviceTemplateOverrides).values({
          templateId: inserted.id,
          dayOfWeek: o.dayOfWeek,
          startTime: o.startTime,
          endTime: o.endTime,
        }).run();
        savedOverrides.push({ dayOfWeek: o.dayOfWeek, startTime: o.startTime, endTime: o.endTime });
      }

      insertedTemplates.push({
        id: inserted.id,
        role: templateData.role,
        zone: templateData.zone,
        startTime: templateData.startTime,
        endTime: templateData.endTime,
        sortOrder: templateData.sortOrder,
        overrides: savedOverrides,
      });
    }
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: insertedTemplates.map(({ id, ...rest }) => rest) });
});

// Day mode: "both" | "midi" | "soir"; absent key = closed
type DayMode = "both" | "midi" | "soir";
type OpenDaysMap = Record<string, DayMode>;

/** Migrate old format (number[]) to new map format */
function parseOpenDays(raw: string): OpenDaysMap {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    // Legacy: [2,3,4,5,6,7] → { "2":"both", "3":"both", ... }
    const map: OpenDaysMap = {};
    for (const d of parsed) map[String(d)] = "both";
    return map;
  }
  return parsed as OpenDaysMap;
}

// GET /settings/open-days
settingsRoutes.get("/open-days", async (c) => {
  const restaurant = requestRestaurant(c);
  const [row] = db.select({ openDays: restaurants.openDays })
    .from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();
  const days = row ? parseOpenDays(row.openDays) : parseOpenDays("[2,3,4,5,6,7]");
  return c.json({ data: days });
});

// PUT /settings/open-days — set day modes (admin only)
settingsRoutes.put("/open-days", requirePermission("RESTAURANT_SETTINGS"), async (c) => {
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const validModes = ["both", "midi", "soir"];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Expected object mapping day numbers to modes" }, 400);
  }
  for (const [k, v] of Object.entries(body)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1 || n > 7 || !validModes.includes(v as string)) {
      return c.json({ error: `Invalid entry: ${k}=${v}` }, 400);
    }
  }
  db.update(restaurants).set({ openDays: JSON.stringify(body) })
    .where(eq(restaurants.id, restaurant.restaurantId)).run();
  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: body });
});

// ── Medical Mode ──

// GET /settings/medical-mode
settingsRoutes.get("/medical-mode", async (c) => {
  const restaurant = requestRestaurant(c);
  const [row] = db.select({ medicalMode: restaurants.medicalMode })
    .from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();
  return c.json({ data: row?.medicalMode ?? false });
});

// PUT /settings/medical-mode (admin only)
settingsRoutes.put("/medical-mode", requirePermission("RESTAURANT_SETTINGS"), async (c) => {
  const restaurant = requestRestaurant(c);
  const { enabled } = await c.req.json();
  if (typeof enabled !== "boolean") return c.json({ error: "enabled must be boolean" }, 400);
  db.update(restaurants).set({ medicalMode: enabled })
    .where(eq(restaurants.id, restaurant.restaurantId)).run();
  return c.json({ data: enabled });
});

// ── Admin Preferences ──

// GET /settings/worker-config — non-sensitive restaurant flags for workers
settingsRoutes.get("/worker-config", async (c) => {
  const restaurant = requestRestaurant(c);
  const [row] = db.select({
    workerPreferencesEnabled: restaurants.workerPreferencesEnabled,
    tapInOutEnabled: restaurants.tapInOutEnabled,
    colorScheme: restaurants.colorScheme,
    kitchenColor: restaurants.kitchenColor,
    floorColor: restaurants.floorColor,
  }).from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();

  return c.json({
    data: row ?? { workerPreferencesEnabled: false, tapInOutEnabled: true, colorScheme: "classic", kitchenColor: "amber", floorColor: "sky" },
  });
});

// GET /settings/preferences (admin only — internal restaurant config)
settingsRoutes.get("/preferences", requirePermission("RESTAURANT_SETTINGS"), async (c) => {
  const restaurant = requestRestaurant(c);
  const [row] = db.select({
    restaurantName: restaurants.name,
    restaurantAddress: restaurants.address,
    siret: restaurants.siret,
    whatsappBotLocale: restaurants.whatsappBotLocale,
    tapInOutEnabled: restaurants.tapInOutEnabled,
    tapInOutAdminConfirmation: restaurants.tapInOutAdminConfirmation,
    tapInOutMode: restaurants.tapInOutMode,
    tapInCountsAsHours: restaurants.tapInCountsAsHours,
    reminderFrequency: restaurants.reminderFrequency,
    includeSilaeInMonthlyDigest: restaurants.includeSilaeInMonthlyDigest,
    colorScheme: restaurants.colorScheme,
    kitchenColor: restaurants.kitchenColor,
    floorColor: restaurants.floorColor,
    workerPreferencesEnabled: restaurants.workerPreferencesEnabled,
    autoStaffingWeeks: restaurants.autoStaffingWeeks,
    disabledComplianceRules: restaurants.disabledComplianceRules,
    kitchenSubRoles: restaurants.kitchenSubRoles,
    floorSubRoles: restaurants.floorSubRoles,
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
    overtimeDistribution: restaurants.overtimeDistribution,
    hcrGrid: restaurants.hcrGrid,
    subroleHcrMap: restaurants.subroleHcrMap,
    defaultContractType: restaurants.defaultContractType,
    defaultContractHours: restaurants.defaultContractHours,
    silaeCodes: restaurants.silaeCodes,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
  }).from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();

  // Parse JSON fields for the response
  const parsed = row ? {
    ...row,
    disabledComplianceRules: JSON.parse(row.disabledComplianceRules || "[]") as string[],
    kitchenSubRoles: JSON.parse(row.kitchenSubRoles || "[]") as string[],
    floorSubRoles: JSON.parse(row.floorSubRoles || "[]") as string[],
    hcrGrid: JSON.parse(row.hcrGrid || "{}") as Record<string, number>,
    subroleHcrMap: JSON.parse(row.subroleHcrMap || "{}") as Record<string, string>,
    silaeCodes: normalizeSilaeCodes(JSON.parse(row.silaeCodes || "{}")),
    customWeights: parseCustomWeights(row.customWeights),
  } : { restaurantName: "", restaurantAddress: "", siret: null as string | null, whatsappBotLocale: "fr" as const, tapInOutEnabled: false, tapInOutAdminConfirmation: false, tapInOutMode: "lateness_only" as const, tapInCountsAsHours: false, reminderFrequency: "off", includeSilaeInMonthlyDigest: false, colorScheme: "classic", kitchenColor: "amber", floorColor: "sky", workerPreferencesEnabled: true, autoStaffingWeeks: 3, disabledComplianceRules: ["HCR-L3121-16"] as string[], kitchenSubRoles: ["Chef","Cuisinier"] as string[], floorSubRoles: ["Chef de rang","Serveur"] as string[], overtimeMode: "flexible", overtimeWeeklyCap: 48, overtimeDistribution: "willing-first", hcrGrid: {} as Record<string, number>, subroleHcrMap: {} as Record<string, string>, defaultContractType: DEFAULT_CONTRACT_TYPE, defaultContractHours: DEFAULT_CONTRACT_HOURS, silaeCodes: SILAE_DEFAULT_CODES, preferredStyle: "equipe-stable", customWeights: {} as Record<string, number> };

  return c.json({ data: parsed });
});

// PUT /settings/preferences (admin only)
settingsRoutes.put("/preferences", requirePermission("RESTAURANT_SETTINGS"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();

  const updates: Record<string, boolean | string | number | null> = {};
  if (typeof body.restaurantName === "string" && body.restaurantName.trim()) updates.name = body.restaurantName.trim();
  if (typeof body.restaurantAddress === "string") updates.address = body.restaurantAddress.trim();
  if (body.siret !== undefined) {
    // Empty string clears, otherwise must be exactly 14 digits (URSSAF spec). Strip whitespace.
    if (body.siret === null || (typeof body.siret === "string" && body.siret.trim() === "")) {
      updates.siret = null;
    } else if (typeof body.siret === "string") {
      const cleaned = body.siret.replace(/\s+/g, "");
      if (!/^\d{14}$/.test(cleaned)) {
        return c.json({ error: "SIRET invalide (14 chiffres requis)" }, 400);
      }
      updates.siret = cleaned;
    }
  }
  if (typeof body.whatsappBotLocale === "string" && ["fr", "en", "es", "pt"].includes(body.whatsappBotLocale)) {
    updates.whatsappBotLocale = body.whatsappBotLocale;
  }
  if (typeof body.tapInOutEnabled === "boolean") updates.tapInOutEnabled = body.tapInOutEnabled;
  if (typeof body.tapInOutAdminConfirmation === "boolean") updates.tapInOutAdminConfirmation = body.tapInOutAdminConfirmation;
  if (typeof body.tapInOutMode === "string" && ["sync", "lateness_only"].includes(body.tapInOutMode)) {
    updates.tapInOutMode = body.tapInOutMode;
  }
  if (typeof body.tapInCountsAsHours === "boolean") updates.tapInCountsAsHours = body.tapInCountsAsHours;
  if (body.reminderFrequency && ["off", "daily", "weekly"].includes(body.reminderFrequency)) {
    updates.reminderFrequency = body.reminderFrequency;
  }
  if (typeof body.includeSilaeInMonthlyDigest === "boolean") {
    updates.includeSilaeInMonthlyDigest = body.includeSilaeInMonthlyDigest;
  }
  if (body.colorScheme && ["classic", "garden", "sunset", "ocean", "earth", "candy"].includes(body.colorScheme)) {
    updates.colorScheme = body.colorScheme;
  }
  if (typeof body.kitchenColor === "string" && ["amber","sky","lime","violet","teal","emerald","rose","slate"].includes(body.kitchenColor)) {
    updates.kitchenColor = body.kitchenColor;
  }
  if (typeof body.floorColor === "string" && ["amber","sky","lime","violet","teal","emerald","rose","slate"].includes(body.floorColor)) {
    updates.floorColor = body.floorColor;
  }
  if (typeof body.workerPreferencesEnabled === "boolean") {
    updates.workerPreferencesEnabled = body.workerPreferencesEnabled;
  }
  if (typeof body.autoStaffingWeeks === "number" && [0, 1, 2, 3, 4].includes(body.autoStaffingWeeks)) {
    updates.autoStaffingWeeks = body.autoStaffingWeeks;
  }
  if (Array.isArray(body.disabledComplianceRules)) {
    updates.disabledComplianceRules = JSON.stringify(body.disabledComplianceRules);
  }

  if (Array.isArray(body.kitchenSubRoles)) {
    updates.kitchenSubRoles = JSON.stringify(body.kitchenSubRoles);
  }
  if (Array.isArray(body.floorSubRoles)) {
    updates.floorSubRoles = JSON.stringify(body.floorSubRoles);
  }
  if (body.overtimeMode && ["strict", "controlled", "flexible"].includes(body.overtimeMode)) {
    updates.overtimeMode = body.overtimeMode;
  }
  if (typeof body.overtimeWeeklyCap === "number" && body.overtimeWeeklyCap >= 39 && body.overtimeWeeklyCap <= 48) {
    updates.overtimeWeeklyCap = body.overtimeWeeklyCap;
  }
  if (body.overtimeDistribution && ["willing-first", "by-priority", "even"].includes(body.overtimeDistribution)) {
    updates.overtimeDistribution = body.overtimeDistribution;
  }
  if (body.hcrGrid && typeof body.hcrGrid === "object" && !Array.isArray(body.hcrGrid)) {
    // Rates stored as integer cents (project convention). Accept 0-100000 cents = €0-€1000/h.
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.hcrGrid)) {
      if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100000) clean[k] = v;
    }
    updates.hcrGrid = JSON.stringify(clean);
  }
  if (body.subroleHcrMap && typeof body.subroleHcrMap === "object" && !Array.isArray(body.subroleHcrMap)) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.subroleHcrMap)) {
      if (typeof v === "string" && v) clean[k] = v;
    }
    updates.subroleHcrMap = JSON.stringify(clean);
  }
  if (body.defaultContractType && ["CDI", "CDD", "saisonnier"].includes(body.defaultContractType)) {
    updates.defaultContractType = body.defaultContractType;
  }
  if (typeof body.defaultContractHours === "number" && body.defaultContractHours > 0 && body.defaultContractHours <= 60) {
    updates.defaultContractHours = Math.round(body.defaultContractHours);
  }
  if (body.silaeCodes && typeof body.silaeCodes === "object" && !Array.isArray(body.silaeCodes)) {
    updates.silaeCodes = JSON.stringify(normalizeSilaeCodes(body.silaeCodes));
  }
  if (typeof body.preferredStyle === "string" && ["equilibre", "equipe-stable", "economique", "resilience"].includes(body.preferredStyle)) {
    updates.preferredStyle = body.preferredStyle;
  }
  if (body.customWeights !== undefined) {
    // null / {} → clear overrides; object → validate against DIMENSION_META keys and 0..4 levels
    if (body.customWeights === null || (typeof body.customWeights === "object" && Object.keys(body.customWeights).length === 0)) {
      updates.customWeights = null as any;
    } else if (body.customWeights && typeof body.customWeights === "object") {
      const validKeys = new Set(DIMENSION_META.map(m => m.key));
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(body.customWeights)) {
        if (!validKeys.has(k as any)) continue;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 4) continue;
        cleaned[k] = v;
      }
      updates.customWeights = JSON.stringify(cleaned);
    }
  }

  if (Object.keys(updates).length === 0) return c.json({ error: "Nothing to update" }, 400);

  db.update(restaurants).set(updates).where(eq(restaurants.id, restaurant.restaurantId)).run();
  bumpCacheVersion(restaurant.restaurantId);

  if ("siret" in updates) {
    syncSiretToStripe(restaurant.restaurantId, updates.siret as string | null);
  }

  const changesObj: Record<string, { new: unknown }> = {};
  for (const [k, v] of Object.entries(updates)) changesObj[k] = { new: v };
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "restaurants",
    rowId: restaurant.restaurantId,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: changesObj,
    summary: `Préférences modifiées : ${Object.keys(updates).join(", ")}`,
  });

  const [row] = db.select({
    restaurantName: restaurants.name,
    restaurantAddress: restaurants.address,
    siret: restaurants.siret,
    whatsappBotLocale: restaurants.whatsappBotLocale,
    tapInOutEnabled: restaurants.tapInOutEnabled,
    tapInOutAdminConfirmation: restaurants.tapInOutAdminConfirmation,
    tapInOutMode: restaurants.tapInOutMode,
    tapInCountsAsHours: restaurants.tapInCountsAsHours,
    reminderFrequency: restaurants.reminderFrequency,
    includeSilaeInMonthlyDigest: restaurants.includeSilaeInMonthlyDigest,
    colorScheme: restaurants.colorScheme,
    kitchenColor: restaurants.kitchenColor,
    floorColor: restaurants.floorColor,
    workerPreferencesEnabled: restaurants.workerPreferencesEnabled,
    autoStaffingWeeks: restaurants.autoStaffingWeeks,
    disabledComplianceRules: restaurants.disabledComplianceRules,
    kitchenSubRoles: restaurants.kitchenSubRoles,
    floorSubRoles: restaurants.floorSubRoles,
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
    overtimeDistribution: restaurants.overtimeDistribution,
    hcrGrid: restaurants.hcrGrid,
    subroleHcrMap: restaurants.subroleHcrMap,
    defaultContractType: restaurants.defaultContractType,
    defaultContractHours: restaurants.defaultContractHours,
    silaeCodes: restaurants.silaeCodes,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
  }).from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();

  return c.json({
    data: {
      ...row,
      disabledComplianceRules: JSON.parse(row?.disabledComplianceRules || "[]"),
      kitchenSubRoles: JSON.parse(row?.kitchenSubRoles || "[]"),
      floorSubRoles: JSON.parse(row?.floorSubRoles || "[]"),
      hcrGrid: JSON.parse(row?.hcrGrid || "{}"),
      subroleHcrMap: JSON.parse(row?.subroleHcrMap || "{}"),
      silaeCodes: normalizeSilaeCodes(JSON.parse(row?.silaeCodes || "{}")),
      customWeights: parseCustomWeights(row?.customWeights),
    },
  });
});

// ── Restaurant Closures ──

// GET /settings/closures
settingsRoutes.get("/closures", async (c) => {
  const restaurant = requestRestaurant(c);
  const rows = db.select({
    id: restaurantClosures.id,
    startDate: restaurantClosures.startDate,
    endDate: restaurantClosures.endDate,
    reason: restaurantClosures.reason,
    schedule: restaurantClosures.schedule,
  }).from(restaurantClosures)
    .where(eq(restaurantClosures.restaurantId, restaurant.restaurantId))
    .all();
  return c.json({
    data: rows.map((r) => ({
      ...r,
      schedule: r.schedule ? JSON.parse(r.schedule) : null,
    })),
  });
});

// POST /settings/closures — add a closure period (admin only)
// When `createLeaves: true` is passed, auto-inserts an approved holiday_request
// for every active worker for the closure range, skipping workers who already
// have an overlapping approved/pending leave.
settingsRoutes.post("/closures", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const { startDate, endDate, reason, schedule, createLeaves, confirmShortNotice } = await c.req.json();
  if (!startDate || !endDate) return c.json({ error: "startDate and endDate required" }, 400);
  if (endDate < startDate) return c.json({ error: "endDate must be after startDate" }, 400);

  // Block overlapping closures
  const overlap = db.select({ id: restaurantClosures.id }).from(restaurantClosures)
    .where(and(
      eq(restaurantClosures.restaurantId, restaurant.restaurantId),
      lte(restaurantClosures.startDate, endDate),
      gte(restaurantClosures.endDate, startDate),
    )).limit(1).all();
  if (overlap.length > 0) {
    return c.json({ error: "Une fermeture existe déjà pour ces dates" }, 409);
  }

  let noticeWarning: string | undefined;
  if (createLeaves === true) {
    // Legal guardrail (Code du travail L3141-13): imposing leave for a closure
    // requires at least 30 days' notice. Shorter notice is blocked unless the
    // caller sends an explicit legal override after showing the warning.
    const today = new Date();
    const daysUntilStart = Math.floor((new Date(startDate + "T00:00:00").getTime() - today.getTime()) / (24 * 3600 * 1000));
    if (daysUntilStart < 30) {
      noticeWarning = daysUntilStart < 7
        ? `Délai de prévenance très court (${daysUntilStart} jours) — le Code du travail L3141-13 exige au moins 30 jours pour un congé imposé lors d'une fermeture.`
        : `Délai de prévenance de ${daysUntilStart} jours — le Code du travail L3141-13 exige au moins 30 jours pour un congé imposé lors d'une fermeture.`;
      if (confirmShortNotice !== true) {
        return c.json({ error: noticeWarning, code: "SHORT_NOTICE", daysUntilStart }, 422);
      }
    }
  }

  const [row] = db.insert(restaurantClosures).values({
    restaurantId: restaurant.restaurantId,
    startDate, endDate,
    reason: reason || null,
    schedule: schedule ? JSON.stringify(schedule) : null,
  }).returning({
    id: restaurantClosures.id,
    startDate: restaurantClosures.startDate,
    endDate: restaurantClosures.endDate,
    reason: restaurantClosures.reason,
    schedule: restaurantClosures.schedule,
  }).all();

  let leavesCreated = 0;
  let leavesSkipped = 0;
  if (createLeaves === true) {

    const memberWorkerIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: ["manager", "kitchen", "floor"] });
    const activeWorkers = memberWorkerIds.length > 0
      ? db.select({ id: users.id, name: users.name })
        .from(users)
        .where(and(
          inArray(users.id, memberWorkerIds),
          ne(users.role, "admin"),
          eq(users.active, true),
        ))
        .all()
      : [];

    // Find which workers already have overlapping approved/pending leaves
    const existing = db.select({ workerId: holidayRequests.workerId })
      .from(holidayRequests)
      .where(and(
        eq(holidayRequests.restaurantId, restaurant.restaurantId),
        inArray(holidayRequests.status, ["approved", "pending"]),
        lte(holidayRequests.startDate, endDate),
        gte(holidayRequests.endDate, startDate),
      ))
      .all();
    const existingSet = new Set(existing.map(e => e.workerId));

    const toInsert = activeWorkers
      .filter(w => !existingSet.has(w.id))
      .map(w => ({
        workerId: w.id,
        restaurantId: restaurant.restaurantId,
        startDate,
        endDate,
        reason: `Congé imposé — fermeture${reason ? ` (${reason})` : ""} — Art. L3141-13 CT + art. 24 HCR`,
        status: "approved" as const,
        reviewedBy: user.id,
        reviewedAt: new Date().toISOString(),
      }));
    if (toInsert.length > 0) {
      db.insert(holidayRequests).values(toInsert).run();
      leavesCreated = toInsert.length;
      // Fire WhatsApp + in-app notification for each worker who got an imposed
      // leave from the closure. Fire-and-forget; the /my-schedule card is the
      // source of truth, the push is just attention-getting.
      for (const row of toInsert) {
        notifyHolidayImposed(row.workerId, row.startDate, row.endDate, "Code du travail art. L3141-13", restaurant.restaurantId).catch(console.error);
      }
    }
    leavesSkipped = activeWorkers.length - leavesCreated;
  }

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "restaurant_closures",
    rowId: row.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: `Fermeture ajoutée ${startDate} → ${endDate}${reason ? ` (${reason})` : ""}${leavesCreated > 0 ? ` — ${leavesCreated} congés créés, ${leavesSkipped} ignorés` : ""}`,
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({
    data: {
      ...row,
      schedule: row.schedule ? JSON.parse(row.schedule) : null,
      leavesCreated,
      leavesSkipped,
      noticeWarning,
    },
  }, 201);
});

// PATCH /settings/closures/:id — update a closure (admin only)
settingsRoutes.patch("/closures/:id", requirePermission("PLANNING_EDIT"), async (c) => {
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const { startDate, endDate, reason } = await c.req.json();

  const updates: Record<string, string | null> = {};
  if (startDate) updates.startDate = startDate;
  if (endDate) updates.endDate = endDate;
  if (reason !== undefined) updates.reason = reason || null;

  if (Object.keys(updates).length === 0) return c.json({ error: "Nothing to update" }, 400);

  // Resolve final dates (merge existing + updates) for overlap check
  const [existing] = db.select({ startDate: restaurantClosures.startDate, endDate: restaurantClosures.endDate })
    .from(restaurantClosures)
    .where(and(eq(restaurantClosures.id, id), eq(restaurantClosures.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!existing) return c.json({ error: "Not found" }, 404);
  const finalStart = updates.startDate || existing.startDate;
  const finalEnd = updates.endDate || existing.endDate;
  const overlap = db.select({ id: restaurantClosures.id }).from(restaurantClosures)
    .where(and(
      eq(restaurantClosures.restaurantId, restaurant.restaurantId),
      ne(restaurantClosures.id, id),
      lte(restaurantClosures.startDate, finalEnd),
      gte(restaurantClosures.endDate, finalStart),
    )).limit(1).all();
  if (overlap.length > 0) {
    return c.json({ error: "Une fermeture existe déjà pour ces dates" }, 409);
  }

  const [updated] = db.update(restaurantClosures)
    .set(updates)
    .where(and(eq(restaurantClosures.id, id), eq(restaurantClosures.restaurantId, restaurant.restaurantId)))
    .returning({
      id: restaurantClosures.id,
      startDate: restaurantClosures.startDate,
      endDate: restaurantClosures.endDate,
      reason: restaurantClosures.reason,
      schedule: restaurantClosures.schedule,
    })
    .all();

  if (!updated) return c.json({ error: "Not found" }, 404);
  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: { ...updated, schedule: updated.schedule ? JSON.parse(updated.schedule) : null } });
});

// DELETE /settings/closures/:id — remove a closure (admin only)
settingsRoutes.delete("/closures/:id", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const deleted = db.delete(restaurantClosures)
    .where(and(eq(restaurantClosures.id, id), eq(restaurantClosures.restaurantId, restaurant.restaurantId)))
    .returning({ id: restaurantClosures.id, startDate: restaurantClosures.startDate, endDate: restaurantClosures.endDate }).all();
  if (deleted.length === 0) return c.json({ error: "Not found" }, 404);

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "restaurant_closures",
    rowId: id,
    action: "delete",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: `Fermeture supprimée ${deleted[0].startDate} → ${deleted[0].endDate}`,
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: { deleted: true } });
});

// ── Staffing Targets ──

// GET /settings/staffing-targets (admin only — internal planning data)
settingsRoutes.get("/staffing-targets", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");

  const profiles = db.select({
    id: staffingProfiles.id,
    name: staffingProfiles.name,
    sortOrder: staffingProfiles.sortOrder,
    dayPriorities: staffingProfiles.dayPriorities,
    preferredAssignments: staffingProfiles.preferredAssignments,
  }).from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, user.activeRestaurantId))
    .orderBy(staffingProfiles.sortOrder)
    .all();

  const targets = db.select({
    profileId: staffingTargets.profileId,
    dayOfWeek: staffingTargets.dayOfWeek,
    role: staffingTargets.role,
    zone: staffingTargets.zone,
    count: staffingTargets.count,
    roleBreakdown: staffingTargets.roleBreakdown,
  }).from(staffingTargets)
    .where(eq(staffingTargets.restaurantId, user.activeRestaurantId))
    .all();

  // Per-profile service templates (profileId NOT NULL) with overrides
  const rawPT = db.select({
    id: serviceTemplates.id,
    profileId: serviceTemplates.profileId,
    role: serviceTemplates.role,
    zone: serviceTemplates.zone,
    startTime: serviceTemplates.startTime,
    endTime: serviceTemplates.endTime,
    sortOrder: serviceTemplates.sortOrder,
  }).from(serviceTemplates)
    .where(and(
      eq(serviceTemplates.restaurantId, user.activeRestaurantId),
      sql`${serviceTemplates.profileId} IS NOT NULL`,
    ))
    .orderBy(serviceTemplates.sortOrder, serviceTemplates.role)
    .all();

  const ptIds = rawPT.map(t => t.id);
  const ptOverrides = ptIds.length > 0
    ? db.select({
        templateId: serviceTemplateOverrides.templateId,
        dayOfWeek: serviceTemplateOverrides.dayOfWeek,
        startTime: serviceTemplateOverrides.startTime,
        endTime: serviceTemplateOverrides.endTime,
      }).from(serviceTemplateOverrides)
        .where(sql`${serviceTemplateOverrides.templateId} IN (${sql.join(ptIds.map(id => sql`${id}`), sql`, `)})`)
        .all()
    : [];

  const profileTemplates = rawPT.map(t => ({
    profileId: t.profileId,
    role: t.role,
    zone: t.zone,
    startTime: t.startTime,
    endTime: t.endTime,
    sortOrder: t.sortOrder,
    overrides: ptOverrides.filter(o => o.templateId === t.id).map(o => ({ dayOfWeek: o.dayOfWeek, startTime: o.startTime, endTime: o.endTime })),
  }));

  return c.json({ data: { profiles, targets, profileTemplates } });
});

// PUT /settings/staffing-targets (admin only)
// Body: { profiles: [{ id?, name, sortOrder }], targets: [...], profileTemplates?: [...] }
settingsRoutes.put("/staffing-targets", requirePermission("RESTAURANT_SETTINGS"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { profiles: inProfiles, targets: inTargets, profileTemplates: inProfileTemplates } = body;

  // Backward compat: old format { targets: [...] } without profiles
  if (Array.isArray(body.targets) && !body.profiles) {
    // Legacy: single unnamed profile. Reuse the first existing profile when
    // present so even old clients do not wipe titulaire pins by forcing a new
    // profile ID.
    db.transaction((tx) => {
      const [existingProfile] = tx.select({
        id: staffingProfiles.id,
        name: staffingProfiles.name,
        sortOrder: staffingProfiles.sortOrder,
        dayPriorities: staffingProfiles.dayPriorities,
      })
        .from(staffingProfiles)
        .where(eq(staffingProfiles.restaurantId, user.activeRestaurantId))
        .orderBy(staffingProfiles.sortOrder)
        .limit(1)
        .all();
      const profileId = existingProfile?.id || crypto.randomUUID();
      replaceStaffingTargetsConfiguration(tx, {
        restaurantId: user.activeRestaurantId,
        profiles: [{
          id: profileId,
          name: existingProfile?.name || "",
          sortOrder: existingProfile?.sortOrder ?? 0,
          dayPriorities: existingProfile?.dayPriorities || "{}",
        }],
        targets: body.targets.map((t: any) => ({ ...t, profileId })),
      });
    });
  } else {
    if (!Array.isArray(inProfiles)) return c.json({ error: "profiles array required" }, 400);
    if (!Array.isArray(inTargets)) return c.json({ error: "targets array required" }, 400);

    // Validate: if >1 profile, all must have non-empty names
    if (inProfiles.length > 1 && inProfiles.some((p: any) => !p.name?.trim())) {
      return c.json({ error: "Tous les profils doivent avoir un nom" }, 400);
    }

    // Validate: no duplicate profile names
    const names = inProfiles.map((p: any) => (p.name?.trim() || "").toLowerCase()).filter(Boolean);
    const dupes = names.filter((n: string, i: number) => names.indexOf(n) !== i);
    if (dupes.length > 0) {
      const unique = [...new Set(dupes)];
      return c.json({ error: `Nom de profil en double : ${unique.join(", ")}` }, 400);
    }

    // Validate: all target/template profileIds must reference a sent profile
    const profileIds = new Set(inProfiles.map((p: any) => p.id).filter(Boolean));
    const orphanTarget = inTargets.find((t: any) => t.profileId && !profileIds.has(t.profileId));
    if (orphanTarget) {
      return c.json({ error: "Données obsolètes — rechargez la page et réessayez" }, 400);
    }
    if (Array.isArray(inProfileTemplates)) {
      const orphanTpl = inProfileTemplates.find((t: any) => t.profileId && !profileIds.has(t.profileId));
      if (orphanTpl) {
        return c.json({ error: "Données obsolètes — rechargez la page et réessayez" }, 400);
      }
    }

    try {
      db.transaction((tx) => {
        replaceStaffingTargetsConfiguration(tx, {
          restaurantId: user.activeRestaurantId,
          profiles: inProfiles,
          targets: inTargets,
          profileTemplates: inProfileTemplates,
        });
      });
    } catch (err: any) {
      console.error("Staffing save error:", err);
      if (err?.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        return c.json({ error: "Données obsolètes — rechargez la page et réessayez" }, 400);
      }
      return c.json({ error: "Erreur lors de l'enregistrement" }, 500);
    }
  }

  // Return updated
  const profiles = db.select({
    id: staffingProfiles.id,
    name: staffingProfiles.name,
    sortOrder: staffingProfiles.sortOrder,
    dayPriorities: staffingProfiles.dayPriorities,
    preferredAssignments: staffingProfiles.preferredAssignments,
  }).from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, user.activeRestaurantId))
    .orderBy(staffingProfiles.sortOrder)
    .all();

  const targets = db.select({
    profileId: staffingTargets.profileId,
    dayOfWeek: staffingTargets.dayOfWeek,
    role: staffingTargets.role,
    zone: staffingTargets.zone,
    count: staffingTargets.count,
    roleBreakdown: staffingTargets.roleBreakdown,
  }).from(staffingTargets)
    .where(eq(staffingTargets.restaurantId, user.activeRestaurantId))
    .all();

  const rawPT2 = db.select({
    id: serviceTemplates.id,
    profileId: serviceTemplates.profileId,
    role: serviceTemplates.role,
    zone: serviceTemplates.zone,
    startTime: serviceTemplates.startTime,
    endTime: serviceTemplates.endTime,
    sortOrder: serviceTemplates.sortOrder,
  }).from(serviceTemplates)
    .where(and(
      eq(serviceTemplates.restaurantId, user.activeRestaurantId),
      sql`${serviceTemplates.profileId} IS NOT NULL`,
    ))
    .orderBy(serviceTemplates.sortOrder, serviceTemplates.role)
    .all();

  const ptIds2 = rawPT2.map(t => t.id);
  const ptOverrides2 = ptIds2.length > 0
    ? db.select({
        templateId: serviceTemplateOverrides.templateId,
        dayOfWeek: serviceTemplateOverrides.dayOfWeek,
        startTime: serviceTemplateOverrides.startTime,
        endTime: serviceTemplateOverrides.endTime,
      }).from(serviceTemplateOverrides)
        .where(sql`${serviceTemplateOverrides.templateId} IN (${sql.join(ptIds2.map(id => sql`${id}`), sql`, `)})`)
        .all()
    : [];

  const profileTemplates = rawPT2.map(t => ({
    profileId: t.profileId,
    role: t.role,
    zone: t.zone,
    startTime: t.startTime,
    endTime: t.endTime,
    sortOrder: t.sortOrder,
    overrides: ptOverrides2.filter(o => o.templateId === t.id).map(o => ({ dayOfWeek: o.dayOfWeek, startTime: o.startTime, endTime: o.endTime })),
  }));

  bumpCacheVersion(user.activeRestaurantId);
  return c.json({ data: { profiles, targets, profileTemplates } });
});

// ── Titulaires per profile (équipe-stable seed) ──
// Date offset (ms) the titulaire is considered "contract ending soon".
const TITULAIRE_CDD_WARNING_DAYS = 28;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function titulaireStaleness(
  worker: {
    active: boolean;
    inactiveFrom: string | null;
    inactiveUntil: string | null;
    contractType: string | null;
    contractEndDate: string | null;
  },
  today: string,
  warnHorizonISO: string,
): { stale: true; reason: "inactive" | "temp_inactive" | "contract_ended" | "contract_ending" } | { stale: false } {
  if (!worker.active) return { stale: true, reason: "inactive" };
  if (worker.inactiveFrom && worker.inactiveUntil && worker.inactiveFrom <= today && today <= worker.inactiveUntil) {
    return { stale: true, reason: "temp_inactive" };
  }
  if (worker.contractEndDate && (worker.contractType === "CDD" || worker.contractType === "saisonnier")) {
    if (worker.contractEndDate < today) return { stale: true, reason: "contract_ended" };
    if (worker.contractEndDate <= warnHorizonISO) return { stale: true, reason: "contract_ending" };
  }
  return { stale: false };
}

settingsRoutes.get("/staffing-profiles/:profileId/titulaires", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const profileId = c.req.param("profileId");

  const prof = db.select({
    id: staffingProfiles.id,
    name: staffingProfiles.name,
    preferredAssignments: staffingProfiles.preferredAssignments,
  })
    .from(staffingProfiles)
    .where(and(eq(staffingProfiles.id, profileId), eq(staffingProfiles.restaurantId, user.activeRestaurantId)))
    .limit(1).all();
  if (!prof[0]) return c.json({ error: "Profil introuvable" }, 404);

  type Assignment = { workerId: string; dayOfWeek: number; zone: string; role: "kitchen" | "floor" };
  let assignments: Assignment[] = [];
  try {
    const parsed = JSON.parse(prof[0].preferredAssignments);
    if (Array.isArray(parsed)) {
      assignments = parsed.filter((a: unknown): a is Assignment =>
        !!a && typeof a === "object"
        && typeof (a as any).workerId === "string"
        && typeof (a as any).dayOfWeek === "number" && (a as any).dayOfWeek >= 1 && (a as any).dayOfWeek <= 7
        && typeof (a as any).zone === "string"
        && ((a as any).role === "kitchen" || (a as any).role === "floor")
      );
    }
  } catch { /* ignore */ }

  const today = todayISO();
  const warn = new Date();
  warn.setDate(warn.getDate() + TITULAIRE_CDD_WARNING_DAYS);
  const warnISO = warn.toISOString().slice(0, 10);

  const memberWorkerIds = listRestaurantMemberUserIds(user.activeRestaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });
  const memberWorkerIdSet = new Set(memberWorkerIds);
  const memberWorkers = memberWorkerIds.length > 0 ? db.select({
    id: users.id,
    name: users.name,
    role: users.role,
    subRoles: users.subRoles,
    contractHours: users.contractHours,
    contractType: users.contractType,
    contractEndDate: users.contractEndDate,
    active: users.active,
    inactiveFrom: users.inactiveFrom,
    inactiveUntil: users.inactiveUntil,
    priority: users.priority,
  })
    .from(users)
    .where(and(
      inArray(users.id, memberWorkerIds),
      sql`${users.role} != 'admin'`,
    ))
    .all() : [];
  const sharedWorkers = listSchedulingRosterWorkers(user.activeRestaurantId, ["kitchen", "floor"])
    .filter((worker) => worker.sharedFromRestaurantId && !memberWorkerIdSet.has(worker.id))
    .map((worker) => ({
      id: worker.id,
      name: worker.name,
      role: worker.role,
      subRoles: worker.subRoles,
      contractHours: worker.contractHours,
      contractType: null,
      contractEndDate: null,
      active: true,
      inactiveFrom: null,
      inactiveUntil: null,
      priority: worker.priority,
    }));
  const allWorkers = [...memberWorkers, ...sharedWorkers];

  const workers = allWorkers.map(w => {
    const stale = titulaireStaleness(w, today, warnISO);
    let parsedSubRoles: string[] = [];
    try {
      const p = JSON.parse(w.subRoles);
      if (Array.isArray(p)) parsedSubRoles = p.filter((x): x is string => typeof x === "string");
    } catch { /* ignore */ }
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      subRoles: parsedSubRoles,
      contractHours: w.contractHours ?? null,
      contractType: w.contractType ?? null,
      contractEndDate: w.contractEndDate ?? null,
      active: !!w.active,
      priority: w.priority,
      staleness: stale.stale ? stale.reason : null,
    };
  });

  // Drop assignments that reference workers no longer present (deleted, etc).
  const validIds = new Set(workers.map(w => w.id));
  assignments = assignments.filter(a => validIds.has(a.workerId));

  // needsReview = unique pinned workers who are stale.
  const pinnedIds = new Set(assignments.map(a => a.workerId));
  const needsReview = workers.filter(w => pinnedIds.has(w.id) && w.staleness !== null).length;

  return c.json({
    data: {
      profile: { id: prof[0].id, name: prof[0].name },
      workers,
      assignments,
      needsReview,
    },
  });
});

settingsRoutes.put("/staffing-profiles/:profileId/titulaires", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const profileId = c.req.param("profileId");
  const body = await c.req.json();
  type Assignment = { workerId: string; dayOfWeek: number; zone: string; role: "kitchen" | "floor"; subRole?: string };
  const raw = Array.isArray(body?.assignments) ? body.assignments : null;
  if (!raw) return c.json({ error: "assignments: array requis" }, 400);
  const assignments: Assignment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    if (typeof a.workerId !== "string") continue;
    if (typeof a.dayOfWeek !== "number" || a.dayOfWeek < 1 || a.dayOfWeek > 7) continue;
    if (typeof a.zone !== "string" || a.zone.length === 0) continue;
    if (a.role !== "kitchen" && a.role !== "floor") continue;
    const out: Assignment = { workerId: a.workerId, dayOfWeek: a.dayOfWeek, zone: a.zone, role: a.role };
    if (typeof a.subRole === "string" && a.subRole.length > 0 && a.subRole.length <= 40) out.subRole = a.subRole;
    assignments.push(out);
  }

  const prof = db.select({ id: staffingProfiles.id })
    .from(staffingProfiles)
    .where(and(eq(staffingProfiles.id, profileId), eq(staffingProfiles.restaurantId, user.activeRestaurantId)))
    .limit(1).all();
  if (!prof[0]) return c.json({ error: "Profil introuvable" }, 404);

  // Validate every workerId belongs to a worker of this restaurant.
  const uniqueWorkerIds = [...new Set(assignments.map(a => a.workerId))];
  if (uniqueWorkerIds.length > 0) {
    const memberIds = new Set([
      ...listRestaurantMemberUserIds(user.activeRestaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true }),
      ...listSchedulingRosterWorkers(user.activeRestaurantId, ["kitchen", "floor"]).map((worker) => worker.id),
    ]);
    const found = uniqueWorkerIds.filter((id) => memberIds.has(id));
    if (found.length !== uniqueWorkerIds.length) {
      return c.json({ error: "Un ou plusieurs employés sont introuvables" }, 400);
    }
  }

  // Dedupe (workerId, dow, zone, role) tuples.
  const seen = new Set<string>();
  const deduped: Assignment[] = [];
  for (const a of assignments) {
    const k = `${a.workerId}|${a.dayOfWeek}|${a.zone}|${a.role}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(a);
  }

  db.update(staffingProfiles)
    .set({ preferredAssignments: JSON.stringify(deduped) })
    .where(eq(staffingProfiles.id, profileId))
    .run();

  bumpCacheVersion(user.activeRestaurantId);
  return c.json({ ok: true, count: deduped.length });
});

// ── Staffing Schedule (week → profile assignments) ──

settingsRoutes.use("/staffing-schedule", requireActiveSubscription);

// GET /settings/staffing-schedule?year=2026 (admin only)
settingsRoutes.get("/staffing-schedule", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const year = Number(c.req.query("year")) || new Date().getFullYear();

  const rows = db.select({
    profileId: staffingSchedule.profileId,
    year: staffingSchedule.year,
    week: staffingSchedule.week,
  }).from(staffingSchedule)
    .where(and(
      eq(staffingSchedule.restaurantId, user.activeRestaurantId),
      eq(staffingSchedule.year, year),
    ))
    .all();

  return c.json({ data: rows });
});

// PUT /settings/staffing-schedule (admin only)
// Body: { assignments: [{ year, week, profileId }] }
settingsRoutes.put("/staffing-schedule", requirePermission("RESTAURANT_SETTINGS"), async (c) => {
  const user = c.get("user");
  const { assignments } = await c.req.json();
  if (!Array.isArray(assignments)) return c.json({ error: "assignments array required" }, 400);

  const profileIds = [...new Set(assignments.map((a: any) => a?.profileId).filter((id: any) => id && id !== "none"))];
  if (profileIds.length > 0) {
    const ownedProfiles = db.select({ id: staffingProfiles.id })
      .from(staffingProfiles)
      .where(eq(staffingProfiles.restaurantId, user.activeRestaurantId))
      .all();
    const ownedIds = new Set(ownedProfiles.map((p) => p.id));
    const invalid = profileIds.find((id) => !ownedIds.has(id));
    if (invalid) return c.json({ error: "Profil de staffing non trouvé" }, 404);
  }

  db.transaction((tx) => {
    for (const a of assignments) {
      if (typeof a.year !== "number" || typeof a.week !== "number" || !a.profileId) continue;
      // Upsert: delete then insert
      tx.delete(staffingSchedule)
        .where(and(
          eq(staffingSchedule.restaurantId, user.activeRestaurantId),
          eq(staffingSchedule.year, a.year),
          eq(staffingSchedule.week, a.week),
        ))
        .run();
      if (a.profileId !== "none") {
        tx.insert(staffingSchedule).values({
          restaurantId: user.activeRestaurantId,
          profileId: a.profileId,
          year: a.year,
          week: a.week,
        }).run();
      }
    }
  });
  bumpCacheVersion(user.activeRestaurantId);

  // Return updated for the years touched
  const years = [...new Set(assignments.map((a: any) => a.year).filter(Number.isFinite))];
  const rows = years.length > 0
    ? db.select({
        profileId: staffingSchedule.profileId,
        year: staffingSchedule.year,
        week: staffingSchedule.week,
      }).from(staffingSchedule)
        .where(eq(staffingSchedule.restaurantId, user.activeRestaurantId))
        .all()
    : [];

  return c.json({ data: rows });
});

// ── Staffing Analysis ──
// 6-week theoretical CP-SAT solve for accurate capacity analysis.
// Heavy logic lives in services/staffing-enrichment.ts and services/multi-week-solver.ts.


// GET /settings/staffing-analysis (6-week theoretical, with 1-week fallback)
settingsRoutes.get("/staffing-analysis", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const profileId = c.req.query("profileId") || undefined;
  const contractParsed = parseStaffingAnalysisJsonParam<Record<string, number>>("contractOverrides", c.req.query("contractOverrides") || undefined);
  if (!contractParsed.ok) return c.json({ error: contractParsed.error }, 400);
  const maxWeeklyParsed = parseStaffingAnalysisJsonParam<Record<string, number>>("maxWeeklyOverrides", c.req.query("maxWeeklyOverrides") || undefined);
  if (!maxWeeklyParsed.ok) return c.json({ error: maxWeeklyParsed.error }, 400);
  const restrictionParsed = parseStaffingAnalysisJsonParam<string[]>("restrictionOverrides", c.req.query("restrictionOverrides") || undefined);
  if (!restrictionParsed.ok) return c.json({ error: restrictionParsed.error }, 400);
  const roleParsed = parseStaffingAnalysisJsonParam<Record<string, string>>("roleOverrides", c.req.query("roleOverrides") || undefined);
  if (!roleParsed.ok) return c.json({ error: roleParsed.error }, 400);

  const directOperationalWorkerIds = new Set(
    listRestaurantMemberUserIds(user.activeRestaurantId, { roles: ["kitchen", "floor"] }),
  );
  const contractOverrides = filterStaffingWhatIfOverrides(contractParsed.value, directOperationalWorkerIds);
  const maxWeeklyOverrides = filterStaffingWhatIfOverrides(maxWeeklyParsed.value, directOperationalWorkerIds);
  const restrictionOverrides = filterStaffingRestrictionOverrides(restrictionParsed.value, directOperationalWorkerIds);
  const roleOverrides = filterStaffingWhatIfOverrides(roleParsed.value, directOperationalWorkerIds);
  const hasWhatIfOverrides = !!contractOverrides || !!maxWeeklyOverrides || !!restrictionOverrides || !!roleOverrides;

  const result = analyzeStaffing(user.activeRestaurantId, profileId, undefined, undefined, undefined, contractOverrides, roleOverrides, maxWeeklyOverrides, restrictionOverrides);

  // Load OT settings for capacity computation
  const otRow = db.select({
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
  }).from(restaurants).where(eq(restaurants.id, user.activeRestaurantId)).limit(1).all();
  const otMode = otRow[0]?.overtimeMode ?? "flexible";
  const otWeeklyCap = otRow[0]?.overtimeWeeklyCap ?? 48;
  const styleWeights = resolveWeights(otRow[0]?.preferredStyle, parseCustomWeights(otRow[0]?.customWeights));

  // Enrich capacity with OT capacity
  for (const cap of result.capacity) {
    const roleWorkers = result.workerLoads.filter(w => w.role === cap.role);
    cap.otCapacityHours = Math.round(computeOtCapacity(roleWorkers, otMode, otWeeklyCap));
    cap.effectiveCapacityHours = cap.totalContractHours + cap.otCapacityHours;
  }

  // 6-week solver enrichment
  try {
    const baseRefDate = fmtDate((() => {
      const d = new Date(); d.setDate(d.getDate() + 28 - d.getDay() + 1); return d;
    })());
    const basePlanOpts = (hasWhatIfOverrides || profileId)
      ? { contractOverrides, maxWeeklyOverrides, restrictionOverrides, roleOverrides, profileIdOverride: profileId } : undefined;

    const NUM_WEEKS = 6;
    const baseMonday = getMonday(baseRefDate);
    const hasDemand = result.slots.some(s => s.target > 0);

    let solve = await runMultiWeekSolve(
      user.activeRestaurantId, baseMonday, NUM_WEEKS, basePlanOpts, undefined, styleWeights, 1, otRow[0]?.preferredStyle,
    );

    if (!hasUsableStaffingSolve(solve, hasDemand)) {
      console.warn(`[staffing-analysis] ${NUM_WEEKS}-week solve unusable (${solve.ilpResult.status}, ${solve.ilpResult.assignments.length} assignments); retrying 1-week fallback`);
      solve = await runMultiWeekSolve(
        user.activeRestaurantId, baseMonday, 1, basePlanOpts, undefined, styleWeights, 1, otRow[0]?.preferredStyle,
      );
    }

    if (!hasUsableStaffingSolve(solve, hasDemand)) {
      throw new Error(`Solver returned ${solve.ilpResult.status} with ${solve.ilpResult.assignments.length} assignments`);
    }

    enrichWithILP({
      result,
      ilpResult: solve.ilpResult,
      mergedSlots: solve.mergedSlots,
      existingHoursByWeek: solve.existingHoursByWeek,
      numWeeks: solve.mergedSlots.reduce((max, s) => Math.max(max, (s.week ?? 0) + 1), 0) || NUM_WEEKS,
      restaurantId: user.activeRestaurantId,
    });

    result.warnings = result.warnings || [];

    if (!hasWhatIfOverrides) {
      const longHorizonInput = {
        restaurantId: user.activeRestaurantId,
        profileId,
        baseMonday,
        weights: styleWeights,
        presetName: otRow[0]?.preferredStyle,
      };
      const longHorizon = getLongHorizonStaffingAnalysis(longHorizonInput);
      refreshLongHorizonStaffingAnalysisInBackground(longHorizonInput);
      (result as any).longHorizon = longHorizon.status === "missing"
        ? { ...longHorizon, status: "running" }
        : longHorizon;
    }
  } catch (e: any) {
    console.error("Staffing analysis solver failed:", e?.message || e);
    result.warnings = result.warnings || [];
    result.warnings.push("Analyse solveur indisponible — réessayez dans quelques instants.");
    (result as any).ilpStats = `Solver error: ${e.message || e}`;
  }

  return c.json({
    data: {
      ...result,
      workerLoads: result.workerLoads.map(stripInternalStaffingWorkerLoadFields),
    },
  });
});

// ── Holiday Advice ──
// Computes leave scheduling recommendations based on team surplus + upcoming
// quiet periods. Reuses the current staffing analysis for surplus calculation.
settingsRoutes.use("/holiday-advice", requireActiveSubscription);
settingsRoutes.get("/holiday-advice", requirePermission("LEAVE_APPROVE"), async (c) => {
  const user = c.get("user");
  const profileId = c.req.query("profileId") || undefined;
  try {
    const { computeHolidayAdvice, computeLeaveBalances } = await import("../services/holiday-advice.js");
    const { analyzeStaffing } = await import("../services/staffing-analysis.js");
    const analysis = analyzeStaffing(user.activeRestaurantId, profileId);
    // Run a quick ILP enrichment so capacity has surplusHours filled in
    const otRow = db.select({
      overtimeMode: restaurants.overtimeMode,
      overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
    }).from(restaurants).where(eq(restaurants.id, user.activeRestaurantId)).limit(1).all();
    const otMode = otRow[0]?.overtimeMode ?? "flexible";
    const otWeeklyCap = otRow[0]?.overtimeWeeklyCap ?? 48;
    for (const cap of analysis.capacity) {
      const roleWorkers = analysis.workerLoads.filter(w => w.role === cap.role);
      cap.otCapacityHours = Math.round(computeOtCapacity(roleWorkers, otMode, otWeeklyCap));
      cap.effectiveCapacityHours = cap.totalContractHours + cap.otCapacityHours;
    }
    const advice = computeHolidayAdvice(user.activeRestaurantId, analysis);
    const balances = computeLeaveBalances(user.activeRestaurantId);
    return c.json({ data: { advice, balances } });
  } catch (e: any) {
    console.error("Holiday advice failed:", e?.message || e);
    return c.json({ error: e?.message || "holiday advice failed" }, 500);
  }
});

// ── Staffing Expansion Suggestions ──
// Suggests closed (day, shift) combos worth opening given current team surplus.
// Each suggestion includes a solver-verified feasibility check.

settingsRoutes.use("/staffing-expansion", requireActiveSubscription);
settingsRoutes.get("/staffing-expansion", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const profileId = c.req.query("profileId") || undefined;
  try {
    const insights = await computeExpansionInsights(user.activeRestaurantId, profileId);
    return c.json({ data: insights });
  } catch (e: any) {
    console.error("Staffing expansion failed:", e?.message || e);
    return c.json({ error: e?.message || "expansion failed" }, 500);
  }
});

// ── Weights Preview ──
// POST /settings/weights-preview { customWeights?: CustomWeights, profileId?: string }
// Runs two 1-week solves (stored-weights vs proposed-weights) and returns aggregate
// metrics + assignment-level diff so admins can see real-world impact before saving.
settingsRoutes.use("/weights-preview", requireActiveSubscription);
settingsRoutes.post("/weights-preview", requirePermission("OPTIMIZE_RUN"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const sideA = body.sideA || { preset: body.comparisonPreset };                      // back-compat
    const sideB = body.sideB || { customWeights: body.customWeights };                  // back-compat
    const preview = await computeWeightsPreview(user.activeRestaurantId, sideA, sideB, {
      profileId: body.profileId,
      numWeeks: body.numWeeks,
    });
    return c.json({ data: preview });
  } catch (e: any) {
    console.error("Weights preview failed:", e?.message || e);
    return c.json({ error: e?.message || "preview failed" }, 500);
  }
});

// ── Auto-Optimize ──
// Runs multiple ILP scenarios to find optimal configuration changes.
// Heavy logic lives in services/optimize-engine.ts.

settingsRoutes.use("/auto-optimize", requireActiveSubscription);
settingsRoutes.get("/auto-optimize", requirePermission("OPTIMIZE_RUN"), async (c) => {
  const user = c.get("user");
  const profileId = c.req.query("profileId") || undefined;
  const leversParam = c.req.query("levers");
  const allowedLevers = new Set(
    leversParam ? leversParam.split(",") : ["reduce", "terminate", "cross_train", "remove_restrictions"]
  );
  const roleFilterParam = c.req.query("roleFilter") as "kitchen" | "floor" | undefined;
  const roleFilter = roleFilterParam === "kitchen" || roleFilterParam === "floor" ? roleFilterParam : undefined;
  const useSSE = c.req.query("stream") === "1";

  if (!useSSE) {
    const data = await runAutoOptimize(user.activeRestaurantId, profileId, allowedLevers, undefined, undefined, roleFilter);
    return c.json({ data });
  }

  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort());
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    // Heartbeat keeps SSE alive during long CP-SAT solves
    const heartbeat = setInterval(async () => {
      try { await stream.writeSSE({ event: "heartbeat", data: "" }); } catch {}
    }, 10_000);
    try {
      const data = await runAutoOptimize(user.activeRestaurantId, profileId, allowedLevers, async (evt) => {
        await stream.writeSSE({ event: "progress", data: JSON.stringify(evt) });
      }, abortController.signal, roleFilter);
      if (!abortController.signal.aborted) {
        await stream.writeSSE({ event: "result", data: JSON.stringify({ data }) });
      }
    } finally {
      clearInterval(heartbeat);
    }
  });
});

// POST /settings/auto-optimize/record-applied
// Records that the admin accepted a cross_train / intra_train suggestion.
// Payload is the minimal subset needed for outcome classification — the
// nightly cron (/cron/training-outcomes) picks it up 30 days later.
// Non-training move types are accepted but no-op'd; only cross_train and
// intra_train feed the learning loop.
settingsRoutes.post("/auto-optimize/record-applied", requirePermission("OPTIMIZE_RUN"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null) as {
    type?: string;
    workerId?: string;
    fromRole?: string;
    toRole?: string;
  } | null;
  if (!body || !body.type || !body.workerId || !body.fromRole || !body.toRole) {
    return c.json({ error: "missing_fields" }, 400);
  }
  if (body.type !== "cross_train" && body.type !== "intra_train") {
    return c.json({ recorded: false, reason: "not_a_training_move" });
  }
  recordTrainingMove({
    restaurantId: user.activeRestaurantId,
    workerId: body.workerId,
    moveType: body.type,
    fromRole: body.fromRole,
    toRole: body.toRole,
  });
  return c.json({ recorded: true });
});

// GET /settings/cron-runs — Aide tab dashboard. Returns the most recent run
// per known job_name. AUDIT_VIEW (admin + manager) gates it.
settingsRoutes.get("/cron-runs", requirePermission("AUDIT_VIEW"), async (c) => {
  return c.json({ data: getLatestCronRuns() });
});
