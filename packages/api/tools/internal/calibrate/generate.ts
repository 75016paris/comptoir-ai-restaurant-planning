// Synthetic restaurant + scenario generator for calibration sweeps.
//
// Produces self-contained ILP solver inputs (workers, slots, config, checker)
// without touching the database. Each restaurant is reproducible from its seed.
//
// Axes (8): team size, contract mix, role split, service complexity,
// OT willingness, restrictions density, sub-role hierarchy, demand pressure.

import type {
  ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker, MultiWeekConfig, Role,
} from "../../../src/utils/ilp-solver.js";
import { serviceHours } from "../../../src/utils/scheduling.js";
import { makeRng, pick, range, rangeInt, chance, latinHypercube } from "./prng.js";

// ── Axis enums ──

export const TEAM_SIZES = [6, 15, 30, 50] as const;
export const CONTRACT_MIXES = ["all-cdi", "cdi-cdd", "seasonal-heavy"] as const;
export const ROLE_SPLITS = ["kitchen-heavy", "balanced", "floor-heavy"] as const;
export const SERVICE_COMPLEXITIES = ["single", "midi-soir", "three-zone"] as const;
export const OT_WILLINGNESS = ["all-willing", "all-unwilling", "mixed"] as const;
export const RESTRICTIONS_DENSITY = ["sparse", "medium", "heavy"] as const;
export const SUBROLE_HIERARCHY = ["flat", "two-tier", "four-tier"] as const;
export const DEMAND_PRESSURE = ["comfortable", "tight", "stretched"] as const;

export interface RestaurantConfig {
  id: string;
  seed: number;
  teamSize: typeof TEAM_SIZES[number];
  contractMix: typeof CONTRACT_MIXES[number];
  roleSplit: typeof ROLE_SPLITS[number];
  serviceComplexity: typeof SERVICE_COMPLEXITIES[number];
  otWillingness: typeof OT_WILLINGNESS[number];
  restrictionsDensity: typeof RESTRICTIONS_DENSITY[number];
  subroleHierarchy: typeof SUBROLE_HIERARCHY[number];
  demandPressure: typeof DEMAND_PRESSURE[number];
}

export interface SyntheticRestaurant {
  cfg: RestaurantConfig;
  workers: ILPWorker[];
  weekTemplate: SlotTemplate[];      // one week of demand (multiplied per planning week)
  ilpConfig: ILPConfig;
  checker: AvailabilityChecker;
  // Restrictions: workerId → Set<"dow_zone"> the worker cannot work
  restrictions: Map<string, Set<string>>;
}

// One weekly recurring slot template (date filled in at expansion time).
export interface SlotTemplate {
  dow: number;       // 1..7 (ISO Monday=1)
  zone: string;
  role: Role;
  startTime: string;
  endTime: string;
  target: number;
  compound: boolean;
  compoundPairKey?: string;   // template-side key matching another template (e.g., "midi-coupure")
  roleBreakdown?: Record<string, number>;
}

// ── Sub-role taxonomies ──

const SUBROLES_BY_HIERARCHY = {
  flat: { kitchen: ["cuisinier"], floor: ["serveur"] },
  "two-tier": { kitchen: ["chef", "cuisinier"], floor: ["chef-rang", "serveur"] },
  "four-tier": {
    kitchen: ["chef", "sous-chef", "cuisinier", "plongeur"],
    floor: ["chef-rang", "sous-chef-rang", "serveur", "runner"],
  },
} as const;

// ── Worker generator ──

function makeWorker(
  rng: () => number,
  cfg: RestaurantConfig,
  idx: number,
  role: Role,
  roleIdx: number,
): ILPWorker {
  // No underscores in worker IDs — solver helper splitKey() splits on the first "_".
  const id = `w${cfg.id}n${String(idx).padStart(3, "0")}`;

  // Contract hours: bimodal distribution (35h CDI dominant, 24h CDD/seasonal secondary).
  let contractHours: number;
  if (cfg.contractMix === "all-cdi") {
    contractHours = pick(rng, [35, 35, 35, 39] as const);
  } else if (cfg.contractMix === "cdi-cdd") {
    contractHours = chance(rng, 0.7) ? pick(rng, [35, 35, 39] as const) : pick(rng, [20, 24, 28] as const);
  } else {
    contractHours = chance(rng, 0.4) ? pick(rng, [35, 39] as const) : pick(rng, [15, 20, 24, 28] as const);
  }

  // Sub-roles: lower role-local index workers get the "senior" labels (chef, sous-chef, etc.).
  // One chef per role (kitchen + salle) when hierarchy permits, plus a sous-chef per role at four-tier.
  // Versatility: some workers hold adjacent sub-roles too (e.g. a chef-de-partie who can also work
  // as commis). Synthetic distribution mirrors real restaurants where multi-skilled staff are common
  // — without this, the "versatile worker" concept has no representation and résilience-style presets
  // have no lever. Rates kept modest so the baseline solver scenario still reflects specialist-heavy
  // kitchens; production data will naturally have whatever mix the restaurant actually employs.
  const tax = SUBROLES_BY_HIERARCHY[cfg.subroleHierarchy][role];
  const subRoleIdx = Math.min(roleIdx, tax.length - 1);
  const subRoles: string[] = [tax[subRoleIdx]];
  if (cfg.subroleHierarchy !== "flat" && tax.length >= 2) {
    // Probability of holding a second subrole; four-tier has more overlap than two-tier.
    const versatilityChance = cfg.subroleHierarchy === "four-tier" ? 0.35 : 0.25;
    if (chance(rng, versatilityChance)) {
      // Pick an adjacent tier (primary ± 1) so a chef picks up sous-chef, not chef ↔ plongeur.
      const adjacent: number[] = [];
      if (subRoleIdx - 1 >= 0) adjacent.push(subRoleIdx - 1);
      if (subRoleIdx + 1 < tax.length) adjacent.push(subRoleIdx + 1);
      if (adjacent.length > 0) {
        const secondary = tax[pick(rng, adjacent)];
        if (!subRoles.includes(secondary)) subRoles.push(secondary);
      }
    }
    // A smaller slice of four-tier workers holds three subroles (real generalists).
    if (cfg.subroleHierarchy === "four-tier" && subRoles.length === 2 && chance(rng, 0.3)) {
      const idxA = tax.indexOf(subRoles[0]);
      const idxB = tax.indexOf(subRoles[1]);
      const candidates: string[] = [];
      for (let i = 0; i < tax.length; i++) {
        if (i !== idxA && i !== idxB && Math.abs(i - idxA) <= 2) candidates.push(tax[i]);
      }
      if (candidates.length > 0) subRoles.push(pick(rng, candidates));
    }
  }

  // Priority: senior workers (role-local) higher priority (1 = best, 10 = worst).
  const priority = Math.min(10, 1 + Math.floor(roleIdx / 3));

  // OT willingness from axis.
  let overtimeWilling: boolean;
  if (cfg.otWillingness === "all-willing") overtimeWilling = true;
  else if (cfg.otWillingness === "all-unwilling") overtimeWilling = false;
  else overtimeWilling = chance(rng, 0.5);

  // Hourly rate from sub-role band (French restaurant realistic, 2026 SMIC ≈ €11.88).
  // Intra-band noise gives equivalent-skill workers ≠ equivalent wage → cost-aware solver
  // has room to prefer one over another. Ranges overlap deliberately between tiers so
  // a senior at the bottom of their band can undercut a junior at the top of theirs.
  const hourlyRateCents = sampleWage(rng, subRoles[0]);

  return {
    id,
    name: `${role === "kitchen" ? "K" : "S"}${idx}-${cfg.id}`,
    role,
    priority,
    overtimeWilling,
    contractHours,
    otCap: null,
    subRoles,
    existingWeeklyHours: 0,
    existingWorkDates: new Set(),
    existingDailyHours: new Map(),
    existingLastEnd: new Map(),
    existingFirstStart: new Map(),
    existingServicesByDate: new Map(),
    historicalHours: 0,
    historicalWeeks: 0,
    consistency: new Map(),
    flexibility: 0, // computed after slots exist
    hourlyRateCents,
  };
}

// Wage bands in cents per hour by sub-role label. Uniform sample within [lo, hi].
// Bands overlap intentionally so intra-role ordering isn't fully determined by tier.
const WAGE_BANDS: Record<string, [number, number]> = {
  plongeur:         [1200, 1350],
  runner:           [1200, 1450],
  cuisinier:        [1300, 1700],
  serveur:          [1250, 1600],
  "sous-chef-rang": [1500, 1800],
  "chef-rang":      [1600, 2000],
  "sous-chef":      [1700, 2200],
  chef:             [2000, 2800],
};

function sampleWage(rng: () => number, subRole: string): number {
  const band = WAGE_BANDS[subRole] ?? [1300, 1700];
  return Math.round(band[0] + rng() * (band[1] - band[0]));
}

// ── Service template generator ──

function makeWeekTemplate(rng: () => number, cfg: RestaurantConfig): SlotTemplate[] {
  const templates: SlotTemplate[] = [];

  const closedDow = chance(rng, 0.6) ? pick(rng, [1, 2, 7] as const) : 0; // 60% chance of one weekly closure
  const dows = [1, 2, 3, 4, 5, 6, 7].filter(d => d !== closedDow);

  // Weekend boost (Fri/Sat target ×1.5, Sun ×1.2 if open)
  const weekendBoost = (dow: number) => (dow === 5 || dow === 6 ? 1.5 : dow === 7 ? 1.2 : 1.0);

  // Demand pressure scales the base target.
  const pressureScale =
    cfg.demandPressure === "comfortable" ? 0.9 :
    cfg.demandPressure === "tight" ? 1.0 :
    1.15;

  // Role split shapes per-zone targets.
  const kitchenScale =
    cfg.roleSplit === "kitchen-heavy" ? 1.3 :
    cfg.roleSplit === "floor-heavy" ? 0.7 :
    1.0;
  const salleScale = 2.0 - kitchenScale; // mirror

  // Realistic roleBreakdown requirement: chef/sous-chef demand must be feasible given
  // the restaurant's typical senior-staff count (1 chef per role + 1 sous-chef per role
  // at four-tier). Chef is required only on "premium" slots (soir), not every slot.
  const subRolesNeeded = (role: Role, base: number, isPremium: boolean): Record<string, number> | undefined => {
    if (cfg.subroleHierarchy === "flat") return undefined;
    const tax = SUBROLES_BY_HIERARCHY[cfg.subroleHierarchy][role];
    const out: Record<string, number> = {};
    // Chef (tax[0]) only required on premium slots; others fill with mid-tier.
    if (isPremium) out[tax[0]] = 1;
    // Sous-chef (tax[1]) only in four-tier and only on premium slots with base ≥ 3.
    if (cfg.subroleHierarchy === "four-tier" && isPremium && base >= 3) out[tax[1]] = 1;
    // Remaining slots go to mid-tier (tax[1] in two-tier, tax[2] in four-tier).
    const seniorCount = (out[tax[0]] ?? 0) + (out[tax[1]] ?? 0);
    const remaining = Math.max(0, base - seniorCount);
    if (remaining > 0) {
      const midIdx = cfg.subroleHierarchy === "four-tier" ? 2 : 1;
      out[tax[midIdx]] = (out[tax[midIdx]] ?? 0) + remaining;
    }
    return out;
  };

  for (const dow of dows) {
    // Premium slots are weekend-soir or any single-service day (only one chance to cover).
    if (cfg.serviceComplexity === "single") {
      // Single 11h service per day — premium only on weekend.
      for (const role of ["kitchen", "floor"] as const) {
        const baseTarget = role === "kitchen" ? 2 : 3;
        const target = Math.max(1, Math.round(baseTarget * weekendBoost(dow) * pressureScale * (role === "kitchen" ? kitchenScale : salleScale)));
        const isPremium = dow === 5 || dow === 6 || dow === 7;
        templates.push({
          dow, zone: "service", role,
          startTime: "11:00", endTime: "22:00",
          target, compound: false,
          roleBreakdown: subRolesNeeded(role, target, isPremium),
        });
      }
    } else if (cfg.serviceComplexity === "midi-soir") {
      // 2 services: midi (11-15) + soir (18-23) — soir is premium.
      for (const [zone, start, end] of [["midi", "11:00", "15:00"], ["soir", "18:00", "23:00"]] as const) {
        for (const role of ["kitchen", "floor"] as const) {
          const baseTarget = role === "kitchen" ? (zone === "midi" ? 2 : 2) : (zone === "midi" ? 2 : 3);
          const target = Math.max(1, Math.round(baseTarget * weekendBoost(dow) * pressureScale * (role === "kitchen" ? kitchenScale : salleScale)));
          const isPremium = zone === "soir";
          templates.push({
            dow, zone, role,
            startTime: start, endTime: end,
            target, compound: false,
            roleBreakdown: subRolesNeeded(role, target, isPremium),
          });
        }
      }
    } else {
      // three-zone: midi (11-15) + coupure (18-22) + soir (22-23:30) — no, simpler:
      // midi + soir + a coupure marker that pairs midi & soir for a worker doing both.
      // We model it as midi + soir slots PLUS optional "coupure" pairs (compound).
      const isWeekend = dow === 5 || dow === 6 || dow === 7;
      const zones = isWeekend
        ? [["midi", "11:00", "15:00"], ["soir", "18:30", "23:30"], ["coupure", "11:00", "23:30"]] as const
        : [["midi", "11:30", "14:30"], ["soir", "18:30", "22:30"], ["coupure", "11:30", "22:30"]] as const;
      for (const [zone, start, end] of zones) {
        for (const role of ["kitchen", "floor"] as const) {
          const isCoupure = zone === "coupure";
          const baseTarget = role === "kitchen"
            ? (isCoupure ? 1 : 2)
            : (isCoupure ? 1 : zone === "soir" ? 3 : 2);
          const target = Math.max(1, Math.round(baseTarget * weekendBoost(dow) * pressureScale * (role === "kitchen" ? kitchenScale : salleScale)));
          const isPremium = zone === "soir" || isCoupure;
          templates.push({
            dow, zone, role,
            startTime: start, endTime: end,
            target, compound: isCoupure,
            roleBreakdown: subRolesNeeded(role, target, isPremium),
          });
        }
      }
    }
  }
  return templates;
}

// ── Restrictions generator ──

function makeRestrictions(rng: () => number, cfg: RestaurantConfig, workers: ILPWorker[], templates: SlotTemplate[]): Map<string, Set<string>> {
  const density = cfg.restrictionsDensity;
  const perWorkerProb =
    density === "sparse" ? 0.10 :
    density === "medium" ? 0.30 :
    0.55;
  const maxPerWorker =
    density === "sparse" ? 2 :
    density === "medium" ? 5 :
    9;

  const dowZones = new Set<string>();
  for (const t of templates) dowZones.add(`${t.dow}_${t.zone}`);
  const dowZoneList = [...dowZones];

  const out = new Map<string, Set<string>>();
  for (const w of workers) {
    if (!chance(rng, perWorkerProb)) continue;
    const n = rangeInt(rng, 1, maxPerWorker);
    const set = new Set<string>();
    for (let i = 0; i < n; i++) set.add(pick(rng, dowZoneList));
    out.set(w.id, set);
  }
  return out;
}

// ── Composite checker ──

function makeChecker(restrictions: Map<string, Set<string>>): AvailabilityChecker {
  return {
    isAvailable(workerId, slot) {
      const r = restrictions.get(workerId);
      if (!r) return true;
      return !r.has(`${slot.dow}_${slot.zone}`);
    },
    prefersSlot(_workerId, _dow, _zone) {
      // Synthetic restaurants have no preferences (calibration tests the FILL/OT logic, not preference matching).
      return false;
    },
  };
}

// ── Main generator ──

export function generateRestaurant(seed: number, axes: Omit<RestaurantConfig, "id" | "seed">): SyntheticRestaurant {
  const rng = makeRng(seed);
  const cfg: RestaurantConfig = { id: `r${seed}n0`, seed, ...axes };

  // Worker count + role split.
  const total = cfg.teamSize;
  const kitchenShare =
    cfg.roleSplit === "kitchen-heavy" ? 0.55 :
    cfg.roleSplit === "floor-heavy" ? 0.40 :
    0.48;
  const kitchenCount = Math.max(1, Math.round(total * kitchenShare));
  const salleCount = Math.max(1, total - kitchenCount);

  const workers: ILPWorker[] = [];
  for (let i = 0; i < kitchenCount; i++) workers.push(makeWorker(rng, cfg, i, "kitchen", i));
  for (let i = 0; i < salleCount; i++) workers.push(makeWorker(rng, cfg, kitchenCount + i, "floor", i));

  const weekTemplate = makeWeekTemplate(rng, cfg);
  const restrictions = makeRestrictions(rng, cfg, workers, weekTemplate);
  const checker = makeChecker(restrictions);

  // Compute flexibility: how many distinct dow_zone combos this worker can fill.
  for (const w of workers) {
    const r = restrictions.get(w.id);
    let count = 0;
    for (const t of weekTemplate) {
      if (t.role !== w.role) continue;
      if (r?.has(`${t.dow}_${t.zone}`)) continue;
      count++;
    }
    w.flexibility = count;
  }

  const ilpConfig: ILPConfig = {
    maxDailyHoursCompound: 13,
    minRestHours: 10,
    maxConsecutiveDays: 6,
    maxRollingWorkDays: 5,
    max12WeekAvgHours: 46,
    otCap: 48,
    disabledRules: new Set(),
    otDistribution: "willing-first",
    dayPriorityMap: { "1": 1, "2": 1, "3": 1, "4": 1, "5": 1.2, "6": 1.5, "7": 1.2 },
    useRoleBasedStaffing: cfg.subroleHierarchy !== "flat",
    prefEnabled: false,
    templates: weekTemplate.map(t => ({ role: t.role, zone: t.zone, startTime: t.startTime, endTime: t.endTime })),
  };

  return { cfg, workers, weekTemplate, ilpConfig, checker, restrictions };
}

// ── Multi-week slot expansion ──

export function expandWeekTemplate(
  templates: SlotTemplate[],
  baseMonday: string,
  numWeeks: number,
): { slots: ILPSlot[]; multiWeek: MultiWeekConfig | undefined } {
  const slots: ILPSlot[] = [];
  let id = 1;

  for (let week = 0; week < numWeeks; week++) {
    // Per-week pair lookup: zone "coupure" template pair to itself? No — compound implies two halves.
    // For our simple model, we mark `compound:true` slots; the solver handles them via C2 within the same date if compoundPairId is set.
    // We don't generate splits here — single coupure slot represents the full split.
    const compoundIds = new Map<string, number>();
    for (const t of templates) {
      const date = addDays(baseMonday, week * 7 + (t.dow - 1));
      const slot: ILPSlot = {
        id: id++,
        date,
        dow: t.dow,
        zone: t.zone,
        role: t.role,
        startTime: t.startTime,
        endTime: t.endTime,
        hours: serviceHours(t.startTime, t.endTime),
        target: t.target,
        existingFill: 0,
        compound: t.compound,
        roleBreakdown: t.roleBreakdown,
        week,
      };
      slots.push(slot);
      if (t.compoundPairKey) {
        const key = `${week}_${t.dow}_${t.compoundPairKey}`;
        if (compoundIds.has(key)) {
          const partner = compoundIds.get(key)!;
          slot.compoundPairId = partner;
          const partnerSlot = slots.find(s => s.id === partner);
          if (partnerSlot) partnerSlot.compoundPairId = slot.id;
        } else {
          compoundIds.set(key, slot.id);
        }
      }
    }
  }

  // Per-week existing hours map (all zeros — synthetic baseline)
  const existingHoursByWeek = new Map<string, number[]>();
  // c9 history: empty (synthetic restaurant has no prior weeks unless scenario adds them)
  const c9BaseHours = new Map<string, number[]>();
  const c9BaseWeeks = new Map<string, number[]>();

  const multiWeek: MultiWeekConfig | undefined = numWeeks > 1
    ? { numWeeks, existingHoursByWeek, c9BaseHours, c9BaseWeeks }
    : undefined;

  return { slots, multiWeek };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── LHS-driven population sampler ──

export function sampleAxes(seed: number, n: number): RestaurantConfig[] {
  const rng = makeRng(seed);
  const samples = latinHypercube(rng, n, 8);
  const out: RestaurantConfig[] = [];
  for (let i = 0; i < n; i++) {
    const [s0, s1, s2, s3, s4, s5, s6, s7] = samples[i];
    out.push({
      id: `r${seed}n${i}`,
      seed: seed * 1000 + i,
      teamSize: TEAM_SIZES[Math.min(TEAM_SIZES.length - 1, Math.floor(s0 * TEAM_SIZES.length))],
      contractMix: CONTRACT_MIXES[Math.min(CONTRACT_MIXES.length - 1, Math.floor(s1 * CONTRACT_MIXES.length))],
      roleSplit: ROLE_SPLITS[Math.min(ROLE_SPLITS.length - 1, Math.floor(s2 * ROLE_SPLITS.length))],
      serviceComplexity: SERVICE_COMPLEXITIES[Math.min(SERVICE_COMPLEXITIES.length - 1, Math.floor(s3 * SERVICE_COMPLEXITIES.length))],
      otWillingness: OT_WILLINGNESS[Math.min(OT_WILLINGNESS.length - 1, Math.floor(s4 * OT_WILLINGNESS.length))],
      restrictionsDensity: RESTRICTIONS_DENSITY[Math.min(RESTRICTIONS_DENSITY.length - 1, Math.floor(s5 * RESTRICTIONS_DENSITY.length))],
      subroleHierarchy: SUBROLE_HIERARCHY[Math.min(SUBROLE_HIERARCHY.length - 1, Math.floor(s6 * SUBROLE_HIERARCHY.length))],
      demandPressure: DEMAND_PRESSURE[Math.min(DEMAND_PRESSURE.length - 1, Math.floor(s7 * DEMAND_PRESSURE.length))],
    });
  }
  return out;
}
