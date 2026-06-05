// One-off sweep: compare perfection-score-based plan acceptance under the
// old (×300) vs new (×60) understaffing penalty. Generates a plausible
// distribution of (baseline state, candidate move) tuples, scores each under
// both weights, and reports how many plan decisions flip.
//
// Run:  bun run packages/api/tools/internal/calibrate/perfection-sweep.ts

import { computePerfectionScore } from "../../../src/services/optimize-engine.js";

type Scenario = {
  baseSurplus: { kitchen: number; floor: number };
  baseUnderstaffed: { kitchen: number; floor: number };
  otCapacity: { kitchen: number; floor: number };
  impact: {
    surplusHoursDelta: { kitchen?: number; floor?: number };
    understaffedSlotsDelta: { kitchen?: number; floor?: number };
  };
  moveCost: number;
  label: string;
};

// Rebuild scorer with a custom understaffed weight — lets us replay the old 300 value.
function scoreWith(s: Scenario, understaffedWeight: number) {
  if (understaffedWeight === 60) {
    return computePerfectionScore({
      baseSurplusByRole: s.baseSurplus,
      baseUnderstaffedByRole: s.baseUnderstaffed,
      otCapacityByRole: s.otCapacity,
      impact: {
        surplusHoursDelta: s.impact.surplusHoursDelta,
        understaffedSlotsDelta: s.impact.understaffedSlotsDelta,
      } as any,
      moveCostTotal: s.moveCost,
    });
  }
  // Hand-coded clone using the given weight — mirrors optimize-engine.ts exactly.
  let score = 1000;
  for (const role of ["kitchen", "floor"] as const) {
    const otCap = s.otCapacity[role];
    const finalSurplus = s.baseSurplus[role] + (s.impact.surplusHoursDelta[role] ?? 0);
    if (finalSurplus > 0) score -= finalSurplus * 3;
    else if (Math.abs(finalSurplus) <= otCap) score -= Math.abs(finalSurplus) * 1.5;
    else score -= (Math.abs(finalSurplus) - otCap) * 25;
    const finalUnder = s.baseUnderstaffed[role] + (s.impact.understaffedSlotsDelta[role] ?? 0);
    score -= Math.max(0, finalUnder) * understaffedWeight;
  }
  score -= s.moveCost;
  return Math.round(score);
}

// Generate scenarios covering realistic operator situations.
const scenarios: Scenario[] = [];

// Baseline states: { surplus, understaffed } for kitchen. Salle is always balanced.
const baselineStates = [
  { surplus: 0,   understaffed: 0, label: "balanced" },
  { surplus: 10,  understaffed: 0, label: "light-surplus" },
  { surplus: 30,  understaffed: 0, label: "moderate-surplus" },
  { surplus: 60,  understaffed: 0, label: "heavy-surplus" },
  { surplus: 120, understaffed: 0, label: "extreme-surplus" },
  { surplus: 10,  understaffed: 1, label: "surplus-with-gap" },
  { surplus: 30,  understaffed: 2, label: "surplus-with-gaps" },
  { surplus: -20, understaffed: 1, label: "tight" },
];

// Candidate moves: what the optimizer might propose.
// Signed surplusDelta: negative = cutting hours, positive = adding.
const moveTypes = [
  { surplusDelta: -10, understaffedDelta: 0, moveCost: 5,  label: "cut-10h-safe" },
  { surplusDelta: -30, understaffedDelta: 0, moveCost: 8,  label: "cut-30h-safe" },
  { surplusDelta: -60, understaffedDelta: 0, moveCost: 12, label: "cut-60h-safe" },
  { surplusDelta: -10, understaffedDelta: 1, moveCost: 5,  label: "cut-10h-risk-1-slot" },
  { surplusDelta: -30, understaffedDelta: 1, moveCost: 8,  label: "cut-30h-risk-1-slot" },
  { surplusDelta: -60, understaffedDelta: 1, moveCost: 12, label: "cut-60h-risk-1-slot" },
  { surplusDelta: -30, understaffedDelta: 2, moveCost: 8,  label: "cut-30h-risk-2-slots" },
  { surplusDelta: -90, understaffedDelta: 2, moveCost: 15, label: "cut-90h-risk-2-slots" },
  { surplusDelta: 35,  understaffedDelta: -1, moveCost: 20, label: "hire-35h-fills-1-slot" },
  { surplusDelta: 20,  understaffedDelta: -1, moveCost: 15, label: "hire-20h-fills-1-slot" },
  { surplusDelta: 10,  understaffedDelta: -1, moveCost: 10, label: "hire-10h-fills-1-slot" },
  { surplusDelta: 35,  understaffedDelta: -2, moveCost: 25, label: "hire-35h-fills-2-slots" },
];

for (const b of baselineStates) {
  for (const m of moveTypes) {
    scenarios.push({
      baseSurplus:     { kitchen: b.surplus, floor: 0 },
      baseUnderstaffed:{ kitchen: b.understaffed, floor: 0 },
      otCapacity:      { kitchen: 20, floor: 20 },
      impact: {
        surplusHoursDelta:    { kitchen: m.surplusDelta },
        understaffedSlotsDelta:{ kitchen: m.understaffedDelta },
      },
      moveCost: m.moveCost,
      label: `${b.label} + ${m.label}`,
    });
  }
}

// Score each scenario under both weights, compare to no-op baseline.
type Row = {
  label: string;
  noop: number;
  scoreOld: number;
  scoreNew: number;
  oldAccepted: boolean;
  newAccepted: boolean;
  flip: "same-accept" | "same-reject" | "newly-accepted" | "newly-rejected";
};

const rows: Row[] = [];
for (const s of scenarios) {
  const noopScenario: Scenario = {
    ...s,
    impact: { surplusHoursDelta: {}, understaffedSlotsDelta: {} },
    moveCost: 0,
  };
  const noopOld = scoreWith(noopScenario, 300);
  const noopNew = scoreWith(noopScenario, 60);
  const scoreOld = scoreWith(s, 300);
  const scoreNew = scoreWith(s, 60);
  const oldAccepted = scoreOld > noopOld;
  const newAccepted = scoreNew > noopNew;
  const flip: Row["flip"] =
    oldAccepted && newAccepted ? "same-accept" :
    !oldAccepted && !newAccepted ? "same-reject" :
    !oldAccepted && newAccepted ? "newly-accepted" :
    "newly-rejected";
  rows.push({
    label: s.label,
    noop: noopNew,
    scoreOld, scoreNew,
    oldAccepted, newAccepted,
    flip,
  });
}

// Summary.
const counts = {
  "same-accept": 0,
  "same-reject": 0,
  "newly-accepted": 0,
  "newly-rejected": 0,
};
for (const r of rows) counts[r.flip]++;

console.log(`\nSweep: ${rows.length} (baseline × move) scenarios\n`);
console.log("Decision flips between understaffedWeight=300 (old) and =60 (new):");
console.log(`  same-accept:     ${counts["same-accept"].toString().padStart(3)}  (both accept — move improves state)`);
console.log(`  same-reject:     ${counts["same-reject"].toString().padStart(3)}  (both reject — move makes things worse)`);
console.log(`  newly-accepted:  ${counts["newly-accepted"].toString().padStart(3)}  (old rejected; new accepts — previously blocked)`);
console.log(`  newly-rejected:  ${counts["newly-rejected"].toString().padStart(3)}  (old accepted; new rejects — previously over-hired)`);

console.log("\nFlipped scenarios (the business-relevant ones):\n");
const flipped = rows.filter(r => r.flip === "newly-accepted" || r.flip === "newly-rejected");
for (const r of flipped) {
  const arrow = r.flip === "newly-accepted" ? "▲ accept" : "▼ reject";
  console.log(`  ${arrow}  ${r.label.padEnd(50)}  old=${r.scoreOld.toString().padStart(5)} new=${r.scoreNew.toString().padStart(5)}`);
}

// Break out by move category.
const byMoveCat: Record<string, { total: number; newlyAccepted: number; newlyRejected: number }> = {};
for (const r of rows) {
  const cat = r.label.split(" + ")[1].split("-")[0]; // cut | hire
  if (!byMoveCat[cat]) byMoveCat[cat] = { total: 0, newlyAccepted: 0, newlyRejected: 0 };
  byMoveCat[cat].total++;
  if (r.flip === "newly-accepted") byMoveCat[cat].newlyAccepted++;
  if (r.flip === "newly-rejected") byMoveCat[cat].newlyRejected++;
}

console.log("\nBy move category:");
for (const [cat, c] of Object.entries(byMoveCat)) {
  console.log(`  ${cat.padEnd(10)} total=${c.total}  newly-accepted=${c.newlyAccepted}  newly-rejected=${c.newlyRejected}`);
}
