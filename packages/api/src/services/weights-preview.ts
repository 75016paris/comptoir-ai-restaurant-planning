/**
 * Weights preview — runs two N-week solves (configurable) and reports both
 * aggregate metrics AND worker-level assignment changes.
 *
 * Used by the slider UI's "Tester" button so admins can see the real-world
 * effect of their weight tuning or preset choice before committing it.
 *
 * Multi-week default (4 weeks) captures compliance-sensitive behavior
 * (rolling-average C9, consecutive-day rest, OT caps) that a 1-week solve
 * would miss.
 */

import { db } from "../db/connection.js";
import { restaurants, staffingProfiles, users } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { fmtDate, getMonday } from "../utils/scheduling.js";
import { runMultiWeekSolve } from "./multi-week-solver.js";
import { resolveWeights, DIMENSION_META, type CustomWeights, type WeightConfig } from "@comptoir/shared";
import { listSchedulingRosterWorkers } from "./restaurant-context.js";

type Role = "kitchen" | "floor";

export type PreviewMetrics = {
  status: string;
  kitchenFillPct: number;
  salleFillPct: number;
  totalHours: number;     // avg per-week total across the window
  otHours: number;        // avg per-week OT (>35h per worker) summed across team
  subRoleMismatch: number;// total across the window
};

export type AssignmentChange = {
  workerId: string;
  workerName: string;
  hoursDelta: number;      // avg-per-week hours delta (B - A)
  slotsAdded: Array<{ dayOfWeek: number; role: Role; zone: string }>;
  slotsRemoved: Array<{ dayOfWeek: number; role: Role; zone: string }>;
};

export type WeightsPreview = {
  configA: PreviewMetrics;
  configB: PreviewMetrics;
  jaccard: number;
  changedWorkerCount: number;
  totalAssignmentsChanged: number;
  sampleChanges: AssignmentChange[];
  numWeeks: number;
};

export type PreviewSideInput = {
  preset?: string;
  customWeights?: unknown;
};

type Assignment = string; // "workerId|dow|role|zone"

function validateCustomWeights(raw: unknown): CustomWeights {
  if (!raw || typeof raw !== "object") return {};
  const valid = new Set(DIMENSION_META.map(m => m.key));
  const out: CustomWeights = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!valid.has(k as any)) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 4) continue;
    (out as any)[k] = v;
  }
  return out;
}

async function solveForMetrics(
  restaurantId: string,
  baseMonday: string,
  numWeeks: number,
  profileId: string,
  weights: WeightConfig,
  presetName: string | null | undefined,
): Promise<{
  metrics: PreviewMetrics;
  assignments: Set<Assignment>;
  hoursByWorker: Map<string, number>;
  workerNames: Map<string, string>;
}> {
  const r = await runMultiWeekSolve(restaurantId, baseMonday, numWeeks, { profileIdOverride: profileId }, undefined, weights, 1, presetName);
  const slotMap = new Map(r.mergedSlots.map(s => [s.id, s]));

  // Fill counters — dedupe per (week, dow, role, zone)
  const targetByKey = new Map<string, { role: Role; target: number; existingFill: number }>();
  for (const s of r.mergedSlots) {
    const k = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
    const prev = targetByKey.get(k);
    if (!prev) targetByKey.set(k, { role: s.role as Role, target: s.target, existingFill: s.existingFill });
    else prev.existingFill = Math.max(prev.existingFill, s.existingFill);
  }
  const fillByKey = new Map<string, Set<string>>();
  // For assignment comparison (schedule shape), we dedupe across weeks — dow pattern is what matters for "who works when"
  const scheduleShape = new Set<Assignment>();
  for (const a of r.ilpResult.assignments) {
    const s = slotMap.get(a.slotId);
    if (!s) continue;
    const k = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
    if (!fillByKey.has(k)) fillByKey.set(k, new Set());
    fillByKey.get(k)!.add(a.workerId);
    // Shape key without week — captures recurring patterns like "worker X on Mon soir"
    scheduleShape.add(`${a.workerId}|${s.dow}|${s.role}|${s.zone}`);
  }

  let kT = 0, kF = 0, sT = 0, sF = 0;
  for (const [k, { role, target, existingFill }] of targetByKey) {
    const fill = Math.min(existingFill + (fillByKey.get(k)?.size || 0), target);
    if (role === "kitchen") { kT += target; kF += fill; } else { sT += target; sF += fill; }
  }

  // Worker hours averaged per week, total OT
  const hoursByWorker = new Map<string, number>();
  let totalHours = 0, otHours = 0;
  if (r.ilpResult.perWeekWorkerHours) {
    for (const [wid, weeklyHours] of r.ilpResult.perWeekWorkerHours) {
      const avg = weeklyHours.reduce((a, b) => a + b, 0) / weeklyHours.length;
      hoursByWorker.set(wid, Math.round(avg * 10) / 10);
      totalHours += avg;
      // OT computed per-week: if avg-per-week > 35h it's OT
      for (const wh of weeklyHours) if (wh > 35) otHours += wh - 35;
    }
    otHours = otHours / numWeeks;  // normalize to per-week
  }

  // Sub-role mismatch across all weeks
  const rosterWorkers = listSchedulingRosterWorkers(restaurantId, ["kitchen", "floor"]);
  const rosterById = new Map(rosterWorkers.map((worker) => [worker.id, worker]));
  const workerIds = rosterWorkers.map((worker) => worker.id);
  const workerRows = workerIds.length > 0
    ? db.select({ id: users.id, name: users.name, subRoles: users.subRoles })
      .from(users).where(inArray(users.id, workerIds)).all()
    : [];
  const workerNames = new Map<string, string>();
  const workerSubs = new Map<string, string[]>();
  for (const w of workerRows) {
    const rosterWorker = rosterById.get(w.id);
    workerNames.set(w.id, rosterWorker?.name ?? w.name);
    try { workerSubs.set(w.id, (rosterWorker?.subRoles ?? w.subRoles) ? JSON.parse(rosterWorker?.subRoles ?? w.subRoles ?? "[]") : []); }
    catch { workerSubs.set(w.id, []); }
  }
  let mismatch = 0;
  const byKey = new Map<string, Array<string[]>>();
  for (const a of r.ilpResult.assignments) {
    const s = slotMap.get(a.slotId); if (!s) continue;
    const bd = (s as any).roleBreakdown;
    if (!bd || typeof bd !== "object" || !Object.keys(bd).length) continue;
    const k = `${s.week}_${s.dow}_${s.role}_${s.zone}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(workerSubs.get(a.workerId) || []);
  }
  for (const [k, subsList] of byKey) {
    const slot = r.mergedSlots.find(s => `${s.week}_${s.dow}_${s.role}_${s.zone}` === k);
    const bd = slot ? (slot as any).roleBreakdown : null;
    if (!bd) continue;
    for (const [sr, need] of Object.entries(bd as Record<string, number>)) {
      const have = subsList.filter(subs => subs.includes(sr)).length;
      if (have < need) mismatch += need - have;
    }
  }

  return {
    metrics: {
      status: r.ilpResult.status,
      kitchenFillPct: kT > 0 ? Math.round((kF / kT) * 1000) / 10 : 0,
      salleFillPct: sT > 0 ? Math.round((sF / sT) * 1000) / 10 : 0,
      totalHours: Math.round(totalHours / numWeeks),
      otHours: Math.round(otHours * 10) / 10,
      subRoleMismatch: Math.round(mismatch / numWeeks),
    },
    assignments: scheduleShape,
    hoursByWorker,
    workerNames,
  };
}

function jaccard(a: Set<Assignment>, b: Set<Assignment>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function parseAssignment(key: string): { dayOfWeek: number; role: Role; zone: string } {
  const [, dow, role, ...zoneParts] = key.split("|");
  return { dayOfWeek: Number(dow), role: role as Role, zone: zoneParts.join("|") };
}

function buildChanges(
  a: { assignments: Set<Assignment>; hoursByWorker: Map<string, number> },
  b: { assignments: Set<Assignment>; hoursByWorker: Map<string, number> },
  names: Map<string, string>,
): { workerCount: number; totalChanged: number; sample: AssignmentChange[] } {
  const perWorker = new Map<string, { removed: string[]; added: string[] }>();
  for (const x of a.assignments) {
    if (!b.assignments.has(x)) {
      const [wid] = x.split("|");
      if (!perWorker.has(wid)) perWorker.set(wid, { removed: [], added: [] });
      perWorker.get(wid)!.removed.push(x);
    }
  }
  for (const x of b.assignments) {
    if (!a.assignments.has(x)) {
      const [wid] = x.split("|");
      if (!perWorker.has(wid)) perWorker.set(wid, { removed: [], added: [] });
      perWorker.get(wid)!.added.push(x);
    }
  }

  // Include workers with hour deltas even if their slot pattern didn't change (rare but possible)
  const allIds = new Set<string>([...perWorker.keys(), ...a.hoursByWorker.keys(), ...b.hoursByWorker.keys()]);
  const list: AssignmentChange[] = [];
  for (const wid of allIds) {
    const { removed = [], added = [] } = perWorker.get(wid) || {};
    const hoursA = a.hoursByWorker.get(wid) || 0;
    const hoursB = b.hoursByWorker.get(wid) || 0;
    const delta = Math.round((hoursB - hoursA) * 10) / 10;
    // Skip workers whose schedule AND hours are unchanged
    if (removed.length === 0 && added.length === 0 && Math.abs(delta) < 0.5) continue;
    list.push({
      workerId: wid,
      workerName: names.get(wid) || wid,
      hoursDelta: delta,
      slotsRemoved: removed.map(parseAssignment),
      slotsAdded: added.map(parseAssignment),
    });
  }
  // Rank by magnitude: slot changes + hour delta
  list.sort((x, y) => {
    const xMag = x.slotsAdded.length + x.slotsRemoved.length + Math.abs(x.hoursDelta) / 5;
    const yMag = y.slotsAdded.length + y.slotsRemoved.length + Math.abs(y.hoursDelta) / 5;
    return yMag - xMag;
  });

  const totalChanged = list.reduce((s, c) => s + c.slotsAdded.length + c.slotsRemoved.length, 0);

  return { workerCount: list.length, totalChanged, sample: list.slice(0, 15) };
}

export async function computeWeightsPreview(
  restaurantId: string,
  sideA: PreviewSideInput,
  sideB: PreviewSideInput,
  opts?: { profileId?: string; numWeeks?: number },
): Promise<WeightsPreview> {
  const [restaurant] = db.select({
    preferredStyle: restaurants.preferredStyle,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  if (!restaurant) throw new Error("Restaurant not found");

  const profiles = db.select({ id: staffingProfiles.id })
    .from(staffingProfiles).where(eq(staffingProfiles.restaurantId, restaurantId))
    .orderBy(staffingProfiles.sortOrder).all();
  const activeProfileId = opts?.profileId || profiles[0]?.id;
  if (!activeProfileId) throw new Error("No staffing profile");

  const defaultPreset = restaurant.preferredStyle;
  const weightsA = resolveWeights(sideA.preset || defaultPreset, validateCustomWeights(sideA.customWeights));
  const weightsB = resolveWeights(sideB.preset || defaultPreset, validateCustomWeights(sideB.customWeights));

  const numWeeks = Math.max(1, Math.min(6, opts?.numWeeks ?? 4));

  // Reference monday ~8 weeks out — greenfield so the solver has full freedom.
  const refDate = fmtDate((() => { const d = new Date(); d.setDate(d.getDate() + 56 - d.getDay() + 1); return d; })());
  const baseMonday = getMonday(refDate);

  const presetA = sideA.preset || defaultPreset;
  const presetB = sideB.preset || defaultPreset;
  const [resA, resB] = await Promise.all([
    solveForMetrics(restaurantId, baseMonday, numWeeks, activeProfileId, weightsA, presetA),
    solveForMetrics(restaurantId, baseMonday, numWeeks, activeProfileId, weightsB, presetB),
  ]);

  const j = jaccard(resA.assignments, resB.assignments);
  const changes = buildChanges(resA, resB, resB.workerNames);

  return {
    configA: resA.metrics,
    configB: resB.metrics,
    jaccard: Math.round(j * 100) / 100,
    changedWorkerCount: changes.workerCount,
    totalAssignmentsChanged: changes.totalChanged,
    sampleChanges: changes.sample,
    numWeeks,
  };
}
