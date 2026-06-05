/**
 * ILP enrichment for staffing analysis — takes raw analysis data + ILP results
 * and computes verdicts, slot statuses, worker loads, and actionable insights.
 *
 * Shared between the staffing-analysis endpoint and the auto-optimize engine
 * to ensure consistent verdicts and recommendations.
 */

import { db } from "../db/connection.js";
import { workerRestrictions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { isoDayOfWeek, timeToMinutes } from "../utils/scheduling.js";
import type { StaffingAnalysis, SlotAnalysis, WorkerLoad, StaffingAction } from "./staffing-analysis.js";
import type { ILPResult, ILPSlot } from "../utils/ilp-solver.js";

const DAY_LABELS = ["", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DAY_NAMES = ["", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

// ── Verdict calculation (shared by analysis + optimize) ──

export type VerdictInputs = {
  surplusHours: number;
  hoursRatio: number;
  otCapacityHours: number;
  effectiveCapacityHours: number;
  totalDemandHours: number;
  understaffedCount: number;
  tightCount: number;
};

export function computeVerdict(inputs: VerdictInputs): "oversized" | "undersized" | "balanced" | "tight" {
  const { surplusHours, hoursRatio, otCapacityHours, effectiveCapacityHours, totalDemandHours, understaffedCount, tightCount } = inputs;
  if (totalDemandHours > effectiveCapacityHours) return "undersized";
  if (understaffedCount > 0) return "tight";
  if (surplusHours > 0 && hoursRatio > 1.2) return "oversized";
  if (surplusHours < 0 && Math.abs(surplusHours) <= otCapacityHours) {
    return tightCount > 0 ? "tight" : "balanced";
  }
  if (surplusHours >= 0 && hoursRatio <= 1.1) {
    return tightCount > 0 ? "tight" : "balanced";
  }
  return "balanced";
}

// ── ILP enrichment: slot statuses, worker loads, verdicts ──

export type ILPEnrichmentInput = {
  result: StaffingAnalysis;
  ilpResult: ILPResult;
  mergedSlots: ILPSlot[];
  existingHoursByWeek: Map<string, number[]>;
  numWeeks: number;

  restaurantId: string;
};

/**
 * Enrich a raw StaffingAnalysis with ILP solve results.
 * Mutates the result in-place: sets slot statuses, worker loads,
 * role summaries, capacity verdicts, and generates actionable insights.
 */
export function enrichWithILP(input: ILPEnrichmentInput): void {
  const { result, ilpResult, mergedSlots, numWeeks, restaurantId } = input;
  const slotMap = new Map(mergedSlots.map(s => [s.id, s]));

  // Build allIlpServices from assignments
  const allIlpServices: Array<{ date: string; workerId: string; workerName: string; role: string; zone: string; startTime: string; endTime: string }> = [];
  for (const a of ilpResult.assignments) {
    const slot = slotMap.get(a.slotId)!;
    allIlpServices.push({
      date: slot.date, workerId: a.workerId, workerName: a.workerName,
      role: slot.role, zone: slot.zone, startTime: slot.startTime, endTime: slot.endTime,
    });
  }

  // ── Slot fill across weeks ──
  const slotFillsPerWeek = new Map<string, number[]>();
  for (let w = 0; w < numWeeks; w++) {
    const weekAssignments = new Map<string, Set<string>>();
    for (const a of ilpResult.assignments) {
      const slot = slotMap.get(a.slotId)!;
      if ((slot.week ?? 0) !== w) continue;
      const key = `${slot.dow}_${slot.role}_${slot.zone}`;
      if (!weekAssignments.has(key)) weekAssignments.set(key, new Set());
      weekAssignments.get(key)!.add(a.workerId);
    }
    const seen = new Set<string>();
    for (const s of mergedSlots) {
      if ((s.week ?? 0) !== w) continue;
      const key = `${s.dow}_${s.role}_${s.zone}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const newFill = weekAssignments.get(key)?.size || 0;
      if (!slotFillsPerWeek.has(key)) slotFillsPerWeek.set(key, []);
      slotFillsPerWeek.get(key)!.push(s.existingFill + newFill);
    }
  }

  // Set slot statuses from fill across N weeks
  for (const slot of result.slots) {
    if (slot.status === "closed" || slot.target === 0) continue;
    const key = `${slot.dayOfWeek}_${slot.role}_${slot.zone}`;
    const fills = slotFillsPerWeek.get(key);
    if (!fills || fills.length === 0) continue;
    const minFill = Math.min(...fills);
    slot.effectiveAvailability = minFill;
    slot.gap = minFill - slot.target;
    slot.fragility = minFill - slot.target;
    if (minFill >= slot.target) {
      slot.status = minFill > slot.target + 2 ? "overstaffed" : "covered";
    } else {
      slot.status = "understaffed";
    }
  }

  // ── Worker loads from multi-week ILP ──
  const ilpWorkerHours = new Map<string, number>();
  const ilpWorkerServices = new Map<string, number>();
  for (const wl of result.workerLoads) {
    const existingPerWeek = input.existingHoursByWeek.get(wl.workerId) || [];
    if (existingPerWeek.length > 0) {
      const avg = existingPerWeek.reduce((a, b) => a + b, 0) / numWeeks;
      ilpWorkerHours.set(wl.workerId, Math.round(avg * 100) / 100);
    }
  }
  if (ilpResult.perWeekWorkerHours && ilpResult.perWeekWorkerServices) {
    for (const [workerId, weeklyHours] of ilpResult.perWeekWorkerHours) {
      const existingPerWeek = input.existingHoursByWeek.get(workerId) || [];
      const totalPerWeek = weeklyHours.map((h, i) => h + (existingPerWeek[i] ?? 0));
      const avg = totalPerWeek.reduce((a, b) => a + b, 0) / numWeeks;
      ilpWorkerHours.set(workerId, Math.round(avg * 100) / 100);
    }
    for (const [workerId, weeklySvcs] of ilpResult.perWeekWorkerServices) {
      const avg = weeklySvcs.reduce((a, b) => a + b, 0) / numWeeks;
      ilpWorkerServices.set(workerId, Math.round(avg * 100) / 100);
    }
  }
  for (const wl of result.workerLoads) {
    const ilpHrs = ilpWorkerHours.get(wl.workerId);
    const ilpSvcs = ilpWorkerServices.get(wl.workerId) || 0;
    if (ilpHrs !== undefined) {
      wl.maxWeeklyHours = ilpHrs;
      wl.maxServices = ilpSvcs;
      wl.demandShare = result.capacity.find(c => c.role === wl.role)?.totalDemand
        ? ilpSvcs / result.capacity.find(c => c.role === wl.role)!.totalDemand
        : 0;
      wl.demandShare = Math.round(wl.demandShare * 100) / 100;
    } else {
      wl.maxWeeklyHours = 0;
      wl.maxServices = 0;
      wl.demandShare = 0;
    }
  }

  // ── Bottleneck detection ──
  const ilpSlotWorkers = new Map<string, Set<string>>();
  for (const s of allIlpServices) {
    const dow = isoDayOfWeek(s.date);
    const key = `${dow}_${s.role}_${s.zone}`;
    if (!ilpSlotWorkers.has(key)) ilpSlotWorkers.set(key, new Set());
    ilpSlotWorkers.get(key)!.add(s.workerId);
  }
  for (const wl of result.workerLoads) {
    const bnSlots: string[] = [];
    for (const slot of result.slots) {
      if (slot.status === "closed" || slot.target === 0) continue;
      if (slot.role !== wl.role) continue;
      const key = `${slot.dayOfWeek}_${slot.role}_${slot.zone}`;
      const workers = ilpSlotWorkers.get(key);
      if (!workers?.has(wl.workerId)) continue;
      if (slot.effectiveAvailability <= slot.target) {
        bnSlots.push(`${DAY_LABELS[slot.dayOfWeek]} ${slot.zone}`);
      }
    }
    wl.isBottleneck = bnSlots.length > 0;
    wl.bottleneckSlots = bnSlots;
  }

  // ── Role summaries + capacity verdicts ──
  for (const roleSummary of result.roles) {
    const roleSlots = result.slots.filter(s => s.role === roleSummary.role && s.status !== "closed" && s.target > 0);
    const understaffed = roleSlots.filter(s => s.status === "understaffed");
    const tight = roleSlots.filter(s => s.status === "tight");
    roleSummary.slotsUnderstaffed = understaffed.length;
    roleSummary.slotsTight = tight.length;
    roleSummary.worstGap = 0;
    roleSummary.worstSlotLabel = "";
    for (const s of roleSlots) {
      if (s.gap < roleSummary.worstGap) {
        roleSummary.worstGap = s.gap;
        roleSummary.worstSlotLabel = `${DAY_LABELS[s.dayOfWeek]} ${s.zone}`;
      }
    }

    const roleCap = result.capacity.find(c => c.role === roleSummary.role);
    const hoursDeficit = roleCap ? roleCap.surplusHours < 0 : false;
    roleSummary.hireNeeded = (roleSummary.worstGap < 0 && hoursDeficit) ? Math.ceil(Math.abs(roleSummary.worstGap)) : 0;

    // Update capacity from ILP
    if (roleCap) {
      roleCap.totalCapacity = roleSlots.reduce((sum, s) => sum + Math.max(0, s.effectiveAvailability), 0);
      roleCap.capacityRatio = roleCap.totalDemand > 0
        ? Math.round((roleCap.totalCapacity / roleCap.totalDemand) * 100) / 100
        : (roleCap.totalCapacity > 0 ? 99 : 0);
      roleCap.surplusServices = roleCap.totalCapacity - roleCap.totalDemand;

      roleCap.verdict = computeVerdict({
        surplusHours: roleCap.surplusHours,
        hoursRatio: roleCap.hoursRatio,
        otCapacityHours: roleCap.otCapacityHours,
        effectiveCapacityHours: roleCap.effectiveCapacityHours,
        totalDemandHours: roleCap.totalDemandHours,
        understaffedCount: understaffed.length,
        tightCount: tight.length,
      });
    }

    // Recommendation text
    if (!roleCap || roleSlots.length === 0) {
      roleSummary.recommendation = "Définissez des objectifs de staffing dans Prefs pour activer l'analyse.";
    } else if (roleCap.verdict === "undersized") {
      const deficit = Math.abs(roleCap.surplusHours);
      const beyondOT = deficit - roleCap.otCapacityHours;
      const needed = Math.round(Math.abs(roleCap.surplusWorkers));
      roleSummary.recommendation = beyondOT > 0
        ? `Déficit de ${deficit}h/sem (dépasse la capacité OT de ${beyondOT}h) — ~${needed} recrutement${needed > 1 ? "s" : ""} nécessaire${needed > 1 ? "s" : ""}.`
        : `Déficit de ${deficit}h/sem mais couvert par les heures supplémentaires disponibles.`;
    } else if (roleCap.verdict === "oversized" && understaffed.length === 0) {
      const excess = Math.round(Math.abs(roleCap.surplusWorkers));
      const pct = Math.round((roleCap.hoursRatio - 1) * 100);
      roleSummary.recommendation = `Équipe surdimensionnée — ${roleCap.surplusHours}h/sem de contrat inutilisé (+${pct}%), soit ~${excess} poste${excess > 1 ? "s" : ""} en trop.`;
    } else if (understaffed.length > 0) {
      roleSummary.recommendation = `${understaffed.length} créneau${understaffed.length > 1 ? "x" : ""} non rempli${understaffed.length > 1 ? "s" : ""} par le solveur — vérifiez disponibilités, restrictions et plafonds horaires.`;
    } else if (tight.length > 0) {
      roleSummary.recommendation = `Tous les créneaux remplis, ${tight.length} juste${tight.length > 1 ? "s" : ""}.`;
    } else {
      roleSummary.recommendation = "Tous les créneaux remplis avec marge.";
    }
  }

  // ── Actionable insights ──
  const actions: StaffingAction[] = [];

  // Fetch restriction data for diagnostics
  const restrictionRows = db.select({
    workerId: workerRestrictions.workerId,
    dayOfWeek: workerRestrictions.dayOfWeek,
    startTime: workerRestrictions.startTime,
    endTime: workerRestrictions.endTime,
  }).from(workerRestrictions)
    .where(eq(workerRestrictions.restaurantId, restaurantId)).all();

  const workerRestrictionsMap = new Map<string, Array<{ dayOfWeek: number; startTime: string | null; endTime: string | null }>>();
  for (const r of restrictionRows) {
    if (!workerRestrictionsMap.has(r.workerId)) workerRestrictionsMap.set(r.workerId, []);
    workerRestrictionsMap.get(r.workerId)!.push(r);
  }

  for (const role of ["kitchen", "floor"] as const) {
    const roleCap = result.capacity.find(c => c.role === role);
    const roleLoads = result.workerLoads.filter(w => w.role === role);

    // 1. Per-worker utilization actions (only when oversized/balanced)
    if (roleCap && (roleCap.verdict === "oversized" || roleCap.verdict === "balanced")) {
      const sorted = [...roleLoads].sort((a, b) => a.maxWeeklyHours - b.maxWeeklyHours);
      const zeroAssigned = sorted.filter(w => w.maxServices === 0);
      const underutilized = sorted.filter(w => w.maxServices > 0 && w.maxWeeklyHours < w.contractHours * 0.5);

      if (zeroAssigned.length > 0) {
        actions.push({
          type: "terminate", priority: "high", role,
          workerIds: zeroAssigned.map(w => w.workerId),
          workerNames: zeroAssigned.map(w => w.workerName),
          workerContractTypes: zeroAssigned.map(w => w.contractType),
          workerSubRoles: zeroAssigned.map(w => w.subRoles),
          message: `${zeroAssigned.map(w => w.workerName).join(", ")} — 0 service assigné par le solveur. Poste${zeroAssigned.length > 1 ? "s" : ""} non nécessaire${zeroAssigned.length > 1 ? "s" : ""} pour couvrir les objectifs actuels.`,
          detail: zeroAssigned.map(w => `${w.workerName}: ${w.contractHours}h contrat, 0h planifié`).join(" · "),
        });
      }

      if (underutilized.length > 0) {
        for (const w of underutilized) {
          const utilPct = Math.round((w.maxWeeklyHours / w.contractHours) * 100);
          const restrictions = workerRestrictionsMap.get(w.workerId) || [];
          if (restrictions.length > 0) {
            const restrictionDays = restrictions.map(r =>
              r.startTime ? `${DAY_NAMES[r.dayOfWeek]} ${r.startTime}-${r.endTime}` : `${DAY_NAMES[r.dayOfWeek]} (indispo.)`
            ).join(", ");
            actions.push({
              type: "check_restrictions", priority: "medium", role,
              workerIds: [w.workerId], workerNames: [w.workerName],
              workerContractTypes: [w.contractType], workerSubRoles: [w.subRoles],
              message: `${w.workerName} — utilisé à ${utilPct}% (${w.maxWeeklyHours}h/${w.contractHours}h). Ses restrictions limitent sa disponibilité.`,
              detail: `Restrictions : ${restrictionDays}`,
            });
          } else {
            actions.push({
              type: "reduce_hours", priority: "medium", role,
              workerIds: [w.workerId], workerNames: [w.workerName],
              workerContractTypes: [w.contractType], workerSubRoles: [w.subRoles],
              message: `${w.workerName} — utilisé à ${utilPct}% (${w.maxWeeklyHours}h/${w.contractHours}h). Réduire le contrat ou réaffecter.`,
            });
          }
        }
      }

      // Fallback: oversized with no individual actions
      if (roleCap.verdict === "oversized" && zeroAssigned.length === 0 && underutilized.length === 0) {
        const excess = Math.round(Math.abs(roleCap.surplusWorkers));
        const byUtilPct = [...roleLoads]
          .filter(w => w.contractHours > 0 && w.maxServices > 0)
          .map(w => ({ ...w, utilPct: w.maxWeeklyHours / w.contractHours }))
          .sort((a, b) => a.utilPct - b.utilPct)
          .filter(w => w.utilPct < 0.8);
        const candidates = byUtilPct.slice(0, Math.min(excess, byUtilPct.length));
        for (const w of candidates) {
          const pct = Math.round(w.utilPct * 100);
          actions.push({
            type: "reduce_hours", priority: "medium", role,
            workerIds: [w.workerId], workerNames: [w.workerName],
            workerContractTypes: [w.contractType], workerSubRoles: [w.subRoles],
            message: `${w.workerName} — utilisé à ${pct}% (${w.maxWeeklyHours}h/${w.contractHours}h). Candidat à réduction dans une équipe surdimensionnée (+${roleCap.surplusHours}h/sem).`,
          });
        }
      }
    }

    // 2. Understaffed slots → hire or check_restrictions
    const understaffedSlots = result.slots.filter(s => s.role === role && s.status === "understaffed" && s.target > 0);
    if (understaffedSlots.length > 0) {
      const slotLabels = understaffedSlots.map(s => `${DAY_NAMES[s.dayOfWeek]} ${s.zone}`);
      const hasSurplus = roleCap && roleCap.surplusHours > 0;
      if (hasSurplus) {
        const slotDiagnostics = buildSlotDiagnostics(
          understaffedSlots, roleLoads, allIlpServices, role, workerRestrictionsMap,
        );
        actions.push({
          type: "check_restrictions", priority: "high", role,
          message: `${understaffedSlots.length} créneaux non rempli${understaffedSlots.length > 1 ? "s" : ""} malgré un surplus de ${roleCap!.surplusHours}h/sem — vérifiez les restrictions et disponibilités pour ${slotLabels.join(", ")}.`,
          detail: understaffedSlots.map(s => `${DAY_NAMES[s.dayOfWeek]} ${s.zone}: ${s.effectiveAvailability}/${s.target}`).join(" · "),
          slotDiagnostics,
        });
      } else {
        actions.push({
          type: "hire", priority: "high", role,
          message: `${understaffedSlots.length} créneaux non rempli${understaffedSlots.length > 1 ? "s" : ""} — recrutement nécessaire pour ${slotLabels.join(", ")}.`,
          detail: understaffedSlots.map(s => `${DAY_NAMES[s.dayOfWeek]} ${s.zone}: ${s.effectiveAvailability}/${s.target}`).join(" · "),
        });
      }

      // Seasonal opportunity
      const dayCounts = new Map<number, number>();
      for (const s of understaffedSlots) dayCounts.set(s.dayOfWeek, (dayCounts.get(s.dayOfWeek) || 0) + 1);
      const peakDays = [...dayCounts.entries()].filter(([, c]) => c >= 2).map(([d]) => DAY_NAMES[d]);
      if (peakDays.length > 0 && peakDays.length <= 2) {
        actions.push({
          type: "convert_seasonal", priority: "low", role,
          message: `Les créneaux non remplis se concentrent sur ${peakDays.join(" et ")} — un extra/saisonnier pourrait suffire.`,
        });
      }
    }

    // 3. Sub-role gap analysis
    const slotsWithSubRoleGaps = result.slots.filter(s =>
      s.role === role && s.subRoleGaps?.some(g => g.gap < 0)
    );
    if (slotsWithSubRoleGaps.length > 0) {
      const subRoleDeficits = new Map<string, number>();
      for (const s of slotsWithSubRoleGaps) {
        for (const g of s.subRoleGaps || []) {
          if (g.gap < 0) {
            const current = subRoleDeficits.get(g.subRole) || 0;
            subRoleDeficits.set(g.subRole, Math.min(current, g.gap));
          }
        }
      }
      for (const [subRole, deficit] of subRoleDeficits) {
        actions.push({
          type: "missing_subrole", priority: "high", role,
          message: `Il manque un ${subRole} — déficit de ${Math.abs(deficit)} sur certains créneaux.`,
          detail: slotsWithSubRoleGaps
            .filter(s => s.subRoleGaps?.some(g => g.subRole === subRole && g.gap < 0))
            .map(s => `${DAY_NAMES[s.dayOfWeek]} ${s.zone}`).join(", "),
        });
      }
    }
  }

  // 4. Key dependency detection
  for (const role of ["kitchen", "floor"] as const) {
    const roleCap = result.capacity.find(c => c.role === role);
    if (!roleCap || roleCap.totalDemand === 0) continue;
    const roleLoads = result.workerLoads.filter(w => w.role === role && w.maxServices > 0);
    const highConcentration = roleLoads.filter(w => w.maxServices / roleCap.totalDemand >= 0.3);
    for (const w of highConcentration) {
      if (actions.some(a => a.workerIds?.includes(w.workerId))) continue;
      const sharePct = Math.round((w.maxServices / roleCap.totalDemand) * 100);
      actions.push({
        type: "key_dependency", priority: "medium", role,
        workerIds: [w.workerId], workerNames: [w.workerName],
        workerContractTypes: [w.contractType], workerSubRoles: [w.subRoles],
        message: `${w.workerName} assure ${sharePct}% de la demande ${role === "kitchen" ? "cuisine" : "floor"} (${w.maxServices} services/${roleCap.totalDemand}). Son absence fragiliserait le planning.`,
        detail: `${w.maxWeeklyHours}h planifiées / ${w.contractHours}h contrat`,
      });
    }
  }

  // Sort: high priority first
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  result.actions = actions;

  // Solver stats. Field name stays `ilpStats` for API compatibility.
  const totalSolveTime = Math.round(ilpResult.solveTimeMs);
  const totalAssignments = ilpResult.assignments.length;
  const solverLabel = ilpResult.solverUsed === "ilp-fallback" ? "CP-SAT → HiGHS fallback" : "CP-SAT";
  (result as any).ilpStats = `${solverLabel}: ${numWeeks}-week multi-week solve, ${totalAssignments} assignments in ${totalSolveTime}ms (${ilpResult.stats.variables} vars, ${ilpResult.stats.constraints} constraints)`;
  (result as any).analysisWeek = null;
  (result as any).theoretical = true;
}

// ── Slot diagnostics builder ──

function buildSlotDiagnostics(
  understaffedSlots: SlotAnalysis[],
  roleLoads: WorkerLoad[],
  allIlpServices: Array<{ date: string; workerId: string; workerName: string; role: string; zone: string; startTime: string; endTime: string }>,
  role: string,
  workerRestrictionsMap: Map<string, Array<{ dayOfWeek: number; startTime: string | null; endTime: string | null }>>,
): StaffingAction["slotDiagnostics"] {
  const ilpWorkerDaySvcs = new Map<string, Array<{ date: string; zone: string; startTime: string; endTime: string }>>();
  for (const s of allIlpServices) {
    if (s.role !== role) continue;
    if (!ilpWorkerDaySvcs.has(s.workerId)) ilpWorkerDaySvcs.set(s.workerId, []);
    ilpWorkerDaySvcs.get(s.workerId)!.push({ date: s.date, zone: s.zone, startTime: s.startTime, endTime: s.endTime });
  }

  const zoneTimes = new Map<string, { startTime: string; endTime: string }>();
  for (const s of allIlpServices) {
    const key = `${isoDayOfWeek(s.date)}_${s.zone}`;
    if (!zoneTimes.has(key)) zoneTimes.set(key, { startTime: s.startTime, endTime: s.endTime });
  }

  const allIlpNewWorkers = new Map<string, Set<string>>();
  for (const s of allIlpServices) {
    const dow = isoDayOfWeek(s.date);
    const key = `${dow}_${s.role}_${s.zone}`;
    if (!allIlpNewWorkers.has(key)) allIlpNewWorkers.set(key, new Set());
    allIlpNewWorkers.get(key)!.add(s.workerId);
  }

  const diagnostics: StaffingAction["slotDiagnostics"] = [];
  for (const slot of understaffedSlots) {
    const slotKey = `${slot.dayOfWeek}_${role}_${slot.zone}`;
    const assignedWorkerIds = allIlpNewWorkers.get(slotKey);
    const assigned = assignedWorkerIds
      ? [...assignedWorkerIds].map(wId => {
          const load = roleLoads.find(w => w.workerId === wId);
          return { workerId: wId, workerName: load?.workerName ?? wId };
        })
      : [];
    const assignedIds = new Set(assigned.map(a => a.workerId));
    const blocked: Array<{ workerId: string; workerName: string; reason: string; detail?: string }> = [];
    const couldCover: Array<{ workerId: string; workerName: string; currentHours: number; contractHours: number }> = [];
    const slotTimes = zoneTimes.get(`${slot.dayOfWeek}_${slot.zone}`);

    for (const w of roleLoads) {
      if (assignedIds.has(w.workerId)) continue;
      const restrictions = workerRestrictionsMap.get(w.workerId) || [];
      const dayRestr = restrictions.filter(r => r.dayOfWeek === slot.dayOfWeek);

      if (dayRestr.some(r => !r.startTime)) {
        blocked.push({ workerId: w.workerId, workerName: w.workerName, reason: "Indisponible", detail: `${DAY_NAMES[slot.dayOfWeek]} (journée)` });
        continue;
      }
      if (slotTimes && dayRestr.length > 0) {
        const sS = timeToMinutes(slotTimes.startTime), sE = timeToMinutes(slotTimes.endTime);
        const overlapping = dayRestr.some(r => r.startTime && r.endTime && timeToMinutes(r.startTime) < sE && timeToMinutes(r.endTime) > sS);
        if (overlapping) {
          blocked.push({ workerId: w.workerId, workerName: w.workerName, reason: "Restriction horaire", detail: dayRestr.map(r => r.startTime ? `${r.startTime}-${r.endTime}` : "journée").join(", ") });
          continue;
        }
      }

      const daySvcs = (ilpWorkerDaySvcs.get(w.workerId) || []).filter(s => isoDayOfWeek(s.date) === slot.dayOfWeek);
      const dayH = daySvcs.reduce((sum, s) => sum + (timeToMinutes(s.endTime) - timeToMinutes(s.startTime)) / 60, 0);
      if (dayH >= 10) {
        blocked.push({ workerId: w.workerId, workerName: w.workerName, reason: "Max heures/jour", detail: `${Math.round(dayH)}h planifiées` });
        continue;
      }

      if (slotTimes && daySvcs.length > 0) {
        const sS = timeToMinutes(slotTimes.startTime), sE = timeToMinutes(slotTimes.endTime);
        if (daySvcs.some(s => timeToMinutes(s.startTime) < sE && timeToMinutes(s.endTime) > sS)) {
          blocked.push({ workerId: w.workerId, workerName: w.workerName, reason: "Chevauchement", detail: `Déjà sur ${daySvcs.map(s => s.zone).join("+")}` });
          continue;
        }
      }

      const weeklyH = w.maxWeeklyHours ?? 0;
      const contractH = w.contractHours ?? 35;
      if (weeklyH >= contractH * 1.15) {
        blocked.push({ workerId: w.workerId, workerName: w.workerName, reason: "Heures sup. max", detail: `${weeklyH}h/${contractH}h` });
        continue;
      }

      const allSvcs = ilpWorkerDaySvcs.get(w.workerId) || [];
      const workingDows = new Set(allSvcs.map(s => isoDayOfWeek(s.date)));
      let consecutive = 1;
      for (let d = 1; d <= 6; d++) {
        const prevDow = ((slot.dayOfWeek - 1 - d + 7) % 7) + 1;
        if (workingDows.has(prevDow)) consecutive++; else break;
      }
      for (let d = 1; d <= 6; d++) {
        const nextDow = ((slot.dayOfWeek - 1 + d) % 7) + 1;
        if (workingDows.has(nextDow)) consecutive++; else break;
      }
      if (consecutive > 6) {
        blocked.push({ workerId: w.workerId, workerName: w.workerName, reason: "6 jours consécutifs", detail: `déjà ${workingDows.size}j travaillés` });
        continue;
      }

      if (slotTimes) {
        const prevDow = ((slot.dayOfWeek - 1 - 1 + 7) % 7) + 1;
        const prevDaySvcs = allSvcs.filter(s => isoDayOfWeek(s.date) === prevDow);
        if (prevDaySvcs.length > 0) {
          const latestEnd = Math.max(...prevDaySvcs.map(s => timeToMinutes(s.endTime)));
          const slotStart = timeToMinutes(slotTimes.startTime);
          const restMinutes = (24 * 60 - latestEnd) + slotStart;
          if (restMinutes < 10 * 60) {
            blocked.push({ workerId: w.workerId, workerName: w.workerName, reason: "Repos min. 10h", detail: `${Math.floor(restMinutes / 60)}h de repos après ${DAY_NAMES[prevDow]}` });
            continue;
          }
        }
      }

      couldCover.push({ workerId: w.workerId, workerName: w.workerName, currentHours: weeklyH, contractHours: contractH });
    }

    diagnostics!.push({
      dayOfWeek: slot.dayOfWeek, zone: slot.zone,
      filled: slot.effectiveAvailability, target: slot.target,
      assigned, blocked, couldCover,
    });
  }
  return diagnostics;
}
