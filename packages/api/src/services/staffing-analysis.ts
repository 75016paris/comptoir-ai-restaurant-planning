/**
 * Staffing data preparation — loads targets, workers, availability, and builds
 * slot structure for ILP enrichment. No heuristic scheduling logic.
 * The ILP solver (in the endpoint) is the sole authority for slot fillability,
 * worker loads, capacity verdicts, and recommendations.
 */

import { db } from "../db/connection.js";
import {
  users, restaurants, workerAvailability, workerRestrictions, staffingTargets, staffingProfiles,
  serviceTemplates, serviceTemplateOverrides,
} from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { zoneToAvailSlot, parseOpenDays, buildAvailabilityMap, isWorkerAvailable, buildRestrictionMap, isAvailableByRestrictions, serviceHours } from "../utils/scheduling.js";
import { listSchedulingRosterWorkers } from "./restaurant-context.js";

type Role = "kitchen" | "floor";

export type SubRoleGap = {
  subRole: string;
  needed: number;
  available: number;
  gap: number;
};

export type SlotAnalysis = {
  dayOfWeek: number; // 1=Mon..7=Sun
  role: Role;
  zone: string;
  target: number;        // desired headcount
  available: number;     // workers available for this slot (from availability records)
  availableNames: string[]; // for detail view
  gap: number;           // ILP-set: filled - target
  status: "covered" | "tight" | "understaffed" | "overstaffed" | "closed";
  fragility: number;             // ILP-set: filled - target
  effectiveAvailability: number; // ILP-solved fill count
  subRoleGaps?: SubRoleGap[];   // per-sub-role coverage
};

export type RoleSummary = {
  role: Role;
  totalWorkers: number;
  worstGap: number;        // most negative gap across all slots
  worstSlotLabel: string;  // e.g. "Fri soir"
  slotsUnderstaffed: number;
  slotsTight: number;
  recommendation: string;  // hiring recommendation
  hireNeeded: number;      // how many to hire (0 if covered)
};

export type CapacitySummary = {
  role: Role;
  totalDemand: number;      // sum of targets across all open slots for the week
  totalCapacity: number;    // ILP-set: sum of worker assigned services
  capacityRatio: number;    // ILP-set: capacity / demand
  surplusServices: number;  // ILP-set: capacity - demand
  totalContractHours: number;  // sum of contract hours for this role
  totalDemandHours: number;    // weekly demand in hours (target × zone hours)
  hoursRatio: number;          // totalContractHours / totalDemandHours
  surplusHours: number;        // totalContractHours - totalDemandHours
  surplusWorkers: number;      // estimated excess(+) or deficit(-) headcount from hours balance
  avgContractHours: number;    // average contract hours per worker in this role
  otCapacityHours: number;     // max OT hours available for this role (based on OT policy)
  effectiveCapacityHours: number; // totalContractHours + otCapacityHours
  verdict: "oversized" | "undersized" | "balanced" | "tight";
};

export type WorkerLoad = {
  workerId: string;
  workerName: string;
  role: Role;
  availableSlots: number;   // how many demanding slots they can fill (from availability)
  maxServices: number;      // ILP-set
  demandShare: number;      // ILP-set
  isBottleneck: boolean;    // ILP-set
  bottleneckSlots: string[];// ILP-set
  contractType: string | null; // CDI, CDD, saisonnier
  contractEndDate: string | null; // CDD/saisonnier end date (YYYY-MM-DD)
  contractHours: number;    // weekly contract hours (default 35)
  maxWeeklyHours: number;   // ILP-set
  subRoles: string[];       // worker's sub-role capabilities
  employmentActionEligible?: boolean;
  sharedFromRestaurantId?: string;
};

export type ActionType =
  | "terminate"       // worker gets 0 or near-0 ILP hours — strong reduction candidate
  | "reduce_hours"    // worker significantly underutilized — reduce contract
  | "check_restrictions" // restrictions block high-demand slots, limiting utilization
  | "missing_subrole" // role needs a sub-role (plongeur, barman) nobody or too few can fill
  | "hire"            // understaffed slots that ILP can't fill — need new hire
  | "convert_seasonal" // demand only on specific days — seasonal worker could help
  | "key_dependency";  // worker carries >30% of role demand — concentration risk

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
  type: ActionType;
  priority: "high" | "medium" | "low";
  role: Role;
  message: string;            // human-readable French recommendation
  workerIds?: string[];       // affected workers (for terminate/reduce/restrictions)
  workerNames?: string[];     // for display
  workerContractTypes?: (string | null)[];  // CDI/CDD/saisonnier per worker
  workerSubRoles?: string[][]; // sub-roles per worker
  detail?: string;            // extra context (restriction days, sub-role name, etc.)
  slotDiagnostics?: SlotDiagnostic[];  // per-slot breakdown for understaffed+surplus actions
};

export type StaffingAnalysis = {
  slots: SlotAnalysis[];
  roles: RoleSummary[];
  capacity: CapacitySummary[];
  workerLoads: WorkerLoad[];
  actions: StaffingAction[];
  openDays: Record<string, "both" | "midi" | "soir">;
  zones: string[];
  profiles: Array<{ id: string; name: string }>;
  activeProfileId: string | null;
  warnings?: string[];
  ilpStats?: string;
};

export function analyzeStaffing(
  restaurantId: string,
  profileId?: string,
  excludeWorkerIds?: string[],
  excludeByDay?: Map<string, Set<number>>,
  closedDays?: Set<number>,
  contractOverrides?: Record<string, number>,
  roleOverrides?: Record<string, string>,
  maxWeeklyOverrides?: Record<string, number>,
  restrictionOverrides?: string[],
): StaffingAnalysis {
  const excludeSet = new Set(excludeWorkerIds || []);

  // ── Restaurant config ──
  const [restaurant] = db
    .select({
      openDays: restaurants.openDays,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();
  const openDays = restaurant ? parseOpenDays(restaurant.openDays) : {};

  // ── Profiles ──
  const allProfiles = db
    .select({ id: staffingProfiles.id, name: staffingProfiles.name })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurantId))
    .orderBy(staffingProfiles.sortOrder)
    .all();

  const activeProfileId = profileId || allProfiles[0]?.id || null;

  // ── Targets ──
  const targets = activeProfileId
    ? db.select({
        dayOfWeek: staffingTargets.dayOfWeek,
        role: staffingTargets.role,
        zone: staffingTargets.zone,
        count: staffingTargets.count,
        roleBreakdown: staffingTargets.roleBreakdown,
      })
      .from(staffingTargets)
      .where(and(eq(staffingTargets.restaurantId, restaurantId), eq(staffingTargets.profileId, activeProfileId)))
      .all()
    : [];

  const targetMap = new Map<string, number>();
  const roleBreakdownMap = new Map<string, Record<string, number>>();
  for (const t of targets) {
    const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
    targetMap.set(key, t.count);
    if (t.roleBreakdown) {
      try {
        const bd = typeof t.roleBreakdown === "string" ? JSON.parse(t.roleBreakdown) : t.roleBreakdown;
        if (Object.keys(bd).length > 0) roleBreakdownMap.set(key, bd);
      } catch { /* ignore */ }
    }
  }

  // ── Workers ──
  const rosterWorkers = listSchedulingRosterWorkers(restaurantId, ["kitchen", "floor"]);
  const rosterById = new Map(rosterWorkers.map((worker) => [worker.id, worker]));
  const workerIds = rosterWorkers.map((worker) => worker.id);
  const allWorkers = workerIds.length > 0
    ? db
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        contractType: users.contractType,
        contractEndDate: users.contractEndDate,
        contractHours: users.contractHours,
        maxWeeklyHours: users.maxWeeklyHours,
        adminOtOverride: users.adminOtOverride,
        subRoles: users.subRoles,
      })
      .from(users)
      .where(inArray(users.id, workerIds))
      .all()
    : [];
  const workersWithRosterContext = allWorkers.map((worker): typeof worker & { sharedFromRestaurantId?: string } => {
    const rosterWorker = rosterById.get(worker.id);
    if (!rosterWorker) return worker;
    return {
      ...worker,
      role: rosterWorker.role,
      contractType: rosterWorker.sharedFromRestaurantId ? null : worker.contractType,
      contractEndDate: rosterWorker.sharedFromRestaurantId ? null : worker.contractEndDate,
      contractHours: rosterWorker.contractHours ?? worker.contractHours,
      maxWeeklyHours: rosterWorker.maxWeeklyHours ?? worker.maxWeeklyHours,
      adminOtOverride: null,
      subRoles: rosterWorker.subRoles ?? worker.subRoles,
      sharedFromRestaurantId: rosterWorker.sharedFromRestaurantId,
    };
  });
  const workersFiltered = workersWithRosterContext.filter(w => !excludeSet.has(w.id));
  const workersWithContracts = contractOverrides
    ? workersFiltered.map(w => contractOverrides[w.id] != null ? { ...w, contractHours: contractOverrides[w.id] } : w)
    : workersFiltered;
  const workersWithMax = maxWeeklyOverrides
    ? workersWithContracts.map(w => maxWeeklyOverrides[w.id] != null ? { ...w, maxWeeklyHours: maxWeeklyOverrides[w.id], adminOtOverride: maxWeeklyOverrides[w.id] } : w)
    : workersWithContracts;
  const workers = roleOverrides
    ? workersWithMax.map(w => roleOverrides[w.id] ? { ...w, role: roleOverrides[w.id] } : w)
    : workersWithMax;
  const ignoreRestrictions = new Set(restrictionOverrides ?? []);

  function parseSubRoles(raw: string | null): string[] {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  // ── Availability & Restrictions ──
  const avail = db
    .select({
      workerId: workerAvailability.workerId,
      dayOfWeek: workerAvailability.dayOfWeek,
      midi: workerAvailability.midi,
      soir: workerAvailability.soir,
      zones: workerAvailability.zones,
    })
    .from(workerAvailability)
    .where(eq(workerAvailability.restaurantId, restaurantId))
    .all();
  const availMap = buildAvailabilityMap(avail);

  const restrictionRows = db.select({
    workerId: workerRestrictions.workerId,
    dayOfWeek: workerRestrictions.dayOfWeek,
    startTime: workerRestrictions.startTime,
    endTime: workerRestrictions.endTime,
  }).from(workerRestrictions)
    .where(eq(workerRestrictions.restaurantId, restaurantId)).all();
  const restrictionMap = buildRestrictionMap(restrictionRows);

  // ── Templates (from active profile) ──
  const templatesRaw = activeProfileId
    ? db.select({ id: serviceTemplates.id, zone: serviceTemplates.zone, startTime: serviceTemplates.startTime, endTime: serviceTemplates.endTime })
        .from(serviceTemplates)
        .where(and(
          eq(serviceTemplates.restaurantId, restaurantId),
          eq(serviceTemplates.profileId, activeProfileId),
        ))
        .all()
    : [];

  const overrideMap = new Map<string, Map<number, { startTime: string; endTime: string }>>();
  if (templatesRaw.length > 0) {
    const overrides = db.select({
      templateId: serviceTemplateOverrides.templateId,
      dayOfWeek: serviceTemplateOverrides.dayOfWeek,
      startTime: serviceTemplateOverrides.startTime,
      endTime: serviceTemplateOverrides.endTime,
    }).from(serviceTemplateOverrides)
      .where(inArray(serviceTemplateOverrides.templateId, templatesRaw.map(t => t.id)))
      .all();
    for (const o of overrides) {
      if (!overrideMap.has(o.templateId)) overrideMap.set(o.templateId, new Map());
      overrideMap.get(o.templateId)!.set(o.dayOfWeek, { startTime: o.startTime, endTime: o.endTime });
    }
  }

  const templates = templatesRaw.map(({ id, ...rest }) => rest);

  // Template rows carry role; filter by role so kitchen/salle Coupure don't alias.
  const templatesRawWithRole = activeProfileId
    ? db.select({
        id: serviceTemplates.id,
        zone: serviceTemplates.zone,
        role: serviceTemplates.role,
        startTime: serviceTemplates.startTime,
        endTime: serviceTemplates.endTime,
      })
        .from(serviceTemplates)
        .where(and(
          eq(serviceTemplates.restaurantId, restaurantId),
          eq(serviceTemplates.profileId, activeProfileId),
        ))
        .all()
    : [];

  function resolveZoneTimes(zone: string, role: Role, dow: number): { startTime: string; endTime: string } | undefined {
    const tpl = templatesRawWithRole.find(t => t.zone === zone && t.role === role);
    if (!tpl) return undefined;
    const dayOv = overrideMap.get(tpl.id)?.get(dow);
    return dayOv || { startTime: tpl.startTime, endTime: tpl.endTime };
  }

  // Sum hours across all halves (compound zones have 2 templates per role — morning + evening).
  function resolveZoneHours(zone: string, role: Role, dow: number): number {
    const matches = templatesRawWithRole.filter(t => t.zone === zone && t.role === role);
    if (matches.length === 0) return 0;
    let total = 0;
    for (const tpl of matches) {
      const dayOv = overrideMap.get(tpl.id)?.get(dow);
      const st = dayOv?.startTime ?? tpl.startTime;
      const et = dayOv?.endTime ?? tpl.endTime;
      total += serviceHours(st, et);
    }
    return total;
  }

  const uniqueZones = [...new Set(templates.map(t => t.zone))];
  if (uniqueZones.length === 0) uniqueZones.push("midi", "soir");

  // ── Build slot structure ──
  const slots: SlotAnalysis[] = [];

  for (let day = 1; day <= 7; day++) {
    const dayMode = openDays[String(day)];
    const dayClosed = closedDays?.has(day) ?? false;

    for (const role of ["kitchen", "floor"] as Role[]) {
      for (const zone of uniqueZones) {
        const availSlot = zoneToAvailSlot(zone, templates);
        const zoneActive = !dayClosed && dayMode && (dayMode === "both" || dayMode === availSlot);

        if (!zoneActive) {
          slots.push({
            dayOfWeek: day, role, zone,
            target: 0, available: 0, availableNames: [],
            gap: 0, status: "closed", fragility: 0, effectiveAvailability: 0,
          });
          continue;
        }

        const target = targetMap.get(`${day}_${role}_${zone}`) || 0;

        const availableWorkers = workers
          .filter(w => w.role === role)
          .filter(w => !excludeByDay?.get(w.id)?.has(day))
          .filter(w => isWorkerAvailable(availMap, w.id, day, zone, templates))
          .filter(w => {
            const zt = resolveZoneTimes(zone, role, day);
            return ignoreRestrictions.has(w.id) || !zt || isAvailableByRestrictions(restrictionMap, w.id, day, zt.startTime, zt.endTime);
          });

        const available = availableWorkers.length;
        const availableNames = availableWorkers.map(w => w.name);

        // Sub-role gap analysis when role-based staffing is active
        let subRoleGaps: SubRoleGap[] | undefined;
        const breakdown = roleBreakdownMap.get(`${day}_${role}_${zone}`);
        if (breakdown && Object.keys(breakdown).length > 0) {
          subRoleGaps = Object.entries(breakdown).map(([subRole, needed]) => {
            const matching = availableWorkers.filter(w => {
              const roles = parseSubRoles(w.subRoles);
              return roles.length === 0 || roles.includes(subRole);
            });
            return { subRole, needed, available: matching.length, gap: matching.length - needed };
          });
        }

        // Neutral defaults — ILP enrichment sets status, gap, fragility, effectiveAvailability
        slots.push({
          dayOfWeek: day, role, zone,
          target, available, availableNames,
          gap: 0, status: target === 0 ? "covered" : "covered",
          fragility: 0, effectiveAvailability: 0,
          subRoleGaps,
        });
      }
    }
  }

  // ── Capacity: hours arithmetic (not heuristic — pure math from contracts vs demand) ──
  const capacity: CapacitySummary[] = (["kitchen", "floor"] as Role[]).map(role => {
    const roleWorkers = workers.filter(w => w.role === role);
    const totalDemand = slots
      .filter(s => s.role === role && s.target > 0)
      .reduce((s, sl) => s + sl.target, 0);

    const totalContractHours = roleWorkers.reduce((s, w) => s + (w.contractHours ?? 35), 0);
    const totalDemandHours = slots
      .filter(s => s.role === role && s.target > 0 && s.status !== "closed")
      .reduce((s, sl) => s + sl.target * resolveZoneHours(sl.zone, role, sl.dayOfWeek), 0);
    const hoursRatio = totalDemandHours > 0
      ? Math.round((totalContractHours / totalDemandHours) * 100) / 100
      : (totalContractHours > 0 ? 99 : 0);

    const surplusHours = Math.round(totalContractHours - totalDemandHours);
    const avgContract = roleWorkers.length > 0 ? totalContractHours / roleWorkers.length : 35;
    const surplusWorkers = avgContract > 0 ? Math.round((surplusHours / avgContract) * 10) / 10 : 0;

    return {
      role,
      totalDemand,
      totalCapacity: 0,       // ILP-set
      capacityRatio: 0,       // ILP-set
      surplusServices: 0,     // ILP-set
      totalContractHours: Math.round(totalContractHours),
      totalDemandHours: Math.round(totalDemandHours * 10) / 10,
      hoursRatio,
      surplusHours,
      surplusWorkers,
      avgContractHours: Math.round(avgContract * 10) / 10,
      otCapacityHours: 0,     // set by route (needs OT settings)
      effectiveCapacityHours: Math.round(totalContractHours), // default = contract only
      verdict: "balanced",    // ILP-set
    };
  });

  // ── Worker list (basic info — ILP enrichment sets load/bottleneck fields) ──
  const workerLoads: WorkerLoad[] = workers.map(w => {
    const availableSlots = slots.filter(s =>
      s.role === w.role && s.target > 0 && s.status !== "closed" && s.availableNames.includes(w.name)
    ).length;

    return {
      workerId: w.id,
      workerName: w.name,
      role: w.role as Role,
      availableSlots,
      maxServices: 0,        // ILP-set
      demandShare: 0,        // ILP-set
      isBottleneck: false,    // ILP-set
      bottleneckSlots: [],    // ILP-set
      contractType: w.contractType || null,
      contractEndDate: w.contractEndDate || null,
      contractHours: w.contractHours ?? 35,
      maxWeeklyHours: w.adminOtOverride ?? w.maxWeeklyHours ?? 0,     // ILP-set
      subRoles: parseSubRoles(w.subRoles),
      employmentActionEligible: !w.sharedFromRestaurantId,
      sharedFromRestaurantId: w.sharedFromRestaurantId,
    };
  });

  // ── Role summaries (neutral defaults — ILP enrichment overrides) ──
  const roles: RoleSummary[] = (["kitchen", "floor"] as Role[]).map(role => {
    const totalWorkers = workers.filter(w => w.role === role).length;
    const hasTargets = slots.some(s => s.role === role && s.target > 0 && s.status !== "closed");
    return {
      role,
      totalWorkers,
      worstGap: 0,
      worstSlotLabel: "",
      slotsUnderstaffed: 0,
      slotsTight: 0,
      recommendation: hasTargets ? "Analyse ILP en cours…" : "Définissez des objectifs de staffing dans Prefs pour activer l'analyse.",
      hireNeeded: 0,
    };
  });

  return { slots, roles, capacity, workerLoads, actions: [], openDays, zones: uniqueZones, profiles: allProfiles, activeProfileId };
}
