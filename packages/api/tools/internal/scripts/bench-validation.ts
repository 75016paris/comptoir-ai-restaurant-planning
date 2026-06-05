/**
 * Deeper weight validation — three hypotheses:
 *
 *  H1. PRESET FIDELITY — does the 5-step semantic scale faithfully reproduce
 *      each named preset? Run each preset both as-is and as quantized through
 *      inferLevels → resolveWeights. Compare solver outputs.
 *
 *  H2. SENSITIVITY on DEFAULT_WEIGHTS — jitter each raw weight ±20% and ±50%
 *      to check whether `equilibre` sits in a valley (insensitive) or on a slope
 *      (could be improved).
 *
 *  H3. CO-TUNING — pairwise extremes of "related" dimensions to catch hidden
 *      interactions (e.g., high bucket0Value × high bucket3Penalty = contract-
 *      first + expensive-OT tension).
 *
 * Runs on the reference restaurant, greenfield week, 1-week solves.
 *
 * Usage:
 *   SOLVER=cpsat CPSAT_SOLVER_URL=http://62.210.195.137:8090 \
 *     DATABASE_URL=/path/to/comptoir.db \
 *     bun scripts/bench-validation.ts
 */

import {
  DEFAULT_WEIGHTS,
  DIMENSION_META,
  PRESETS,
  resolvePreset,
  resolveWeights,
  inferLevels,
  SEMANTIC_SCALE,
  type WeightConfig,
  type TunableDimension,
  type SemanticLevel,
  type CustomWeights,
} from "@comptoir/shared";
import { runMultiWeekSolve } from "../../../src/services/multi-week-solver.js";
import { db } from "../../../src/db/connection.js";
import { users, staffingProfiles } from "../../../src/db/schema.js";
import { eq, and } from "drizzle-orm";
import { fmtDate, getMonday } from "../../../src/utils/scheduling.js";

const RESTAURANT_ID = "6ff8c361-5a74-42a1-9de9-584606ef332e";
const refDate = fmtDate((() => { const d = new Date(); d.setDate(d.getDate() + 56 - d.getDay() + 1); return d; })());
const BASE_MONDAY = getMonday(refDate);

type Metrics = {
  label: string;
  status: string;
  assignmentCount: number;
  kitchenFillPct: number;
  salleFillPct: number;
  totalHours: number;
  otHours: number;
  mismatch: number;
  stddev: number;
  solveMs: number;
};

async function solveWith(label: string, weights: WeightConfig, profileId: string, contractOverrides?: Record<string, number>): Promise<Metrics> {
  const r = await runMultiWeekSolve(RESTAURANT_ID, BASE_MONDAY, 1, { profileIdOverride: profileId, contractOverrides }, undefined, weights);
  const slotMap = new Map(r.mergedSlots.map(s => [s.id, s]));
  const targetByKey = new Map<string, { role: string; target: number; existingFill: number }>();
  for (const s of r.mergedSlots) {
    const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
    const prev = targetByKey.get(key);
    if (!prev) targetByKey.set(key, { role: s.role, target: s.target, existingFill: s.existingFill });
    else prev.existingFill = Math.max(prev.existingFill, s.existingFill);
  }
  const newFillByKey = new Map<string, Set<string>>();
  for (const a of r.ilpResult.assignments) {
    const s = slotMap.get(a.slotId);
    if (!s) continue;
    const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
    if (!newFillByKey.has(key)) newFillByKey.set(key, new Set());
    newFillByKey.get(key)!.add(a.workerId);
  }
  let kT = 0, kF = 0, sT = 0, sF = 0;
  for (const [k, { role, target, existingFill }] of targetByKey) {
    const fill = Math.min(existingFill + (newFillByKey.get(k)?.size || 0), target);
    if (role === "kitchen") { kT += target; kF += fill; } else { sT += target; sF += fill; }
  }

  // Worker hours + OT + subrole mismatch
  let totalHours = 0, otHours = 0;
  const perWorker: number[] = [];
  if (r.ilpResult.perWeekWorkerHours) {
    for (const [, wk] of r.ilpResult.perWeekWorkerHours) {
      const avg = wk.reduce((a, b) => a + b, 0) / wk.length;
      perWorker.push(avg); totalHours += avg; if (avg > 35) otHours += avg - 35;
    }
  }
  const stddev = perWorker.length > 1
    ? Math.sqrt(perWorker.reduce((s, v) => s + (v - totalHours / perWorker.length) ** 2, 0) / perWorker.length)
    : 0;

  // Sub-role mismatch count
  const workerSubs = new Map<string, string[]>();
  for (const w of db.select({ id: users.id, subRoles: users.subRoles }).from(users).where(eq(users.restaurantId, RESTAURANT_ID)).all()) {
    try { workerSubs.set(w.id, w.subRoles ? JSON.parse(w.subRoles) : []); } catch { workerSubs.set(w.id, []); }
  }
  const byKey = new Map<string, Array<{ subs: string[] }>>();
  for (const a of r.ilpResult.assignments) {
    const s = slotMap.get(a.slotId); if (!s) continue;
    const bd = (s as any).roleBreakdown;
    if (!bd || typeof bd !== "object" || !Object.keys(bd).length) continue;
    const key = `${s.week}_${s.dow}_${s.role}_${s.zone}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ subs: workerSubs.get(a.workerId) || [] });
  }
  let mismatch = 0;
  for (const [k, aList] of byKey) {
    const slot = r.mergedSlots.find(s => `${s.week}_${s.dow}_${s.role}_${s.zone}` === k);
    const bd = slot ? (slot as any).roleBreakdown : null;
    if (!bd) continue;
    for (const [sr, need] of Object.entries(bd as Record<string, number>)) {
      const have = aList.filter(a => a.subs.includes(sr)).length;
      if (have < need) mismatch += need - have;
    }
  }

  return {
    label,
    status: r.ilpResult.status,
    assignmentCount: r.ilpResult.assignments.length,
    kitchenFillPct: kT > 0 ? Math.round((kF / kT) * 1000) / 10 : 0,
    salleFillPct: sT > 0 ? Math.round((sF / sT) * 1000) / 10 : 0,
    totalHours: Math.round(totalHours),
    otHours: Math.round(otHours * 10) / 10,
    mismatch,
    stddev: Math.round(stddev * 10) / 10,
    solveMs: Math.round(r.ilpResult.solveTimeMs),
  };
}

function similar(a: Metrics, b: Metrics): { similar: boolean; divergence: number } {
  // Divergence score: sum of normalized metric differences
  const fillDiff = Math.abs(a.kitchenFillPct - b.kitchenFillPct) + Math.abs(a.salleFillPct - b.salleFillPct);
  const otDiff = Math.abs(a.otHours - b.otHours) / Math.max(1, Math.max(a.otHours, b.otHours));
  const mismatchDiff = Math.abs(a.mismatch - b.mismatch);
  const hoursDiff = Math.abs(a.totalHours - b.totalHours) / Math.max(1, a.totalHours);
  const div = fillDiff + otDiff * 100 + mismatchDiff * 2 + hoursDiff * 50;
  return { similar: div < 8, divergence: Math.round(div * 10) / 10 };
}

async function main() {
  console.log(`# Weight validation bench`);
  console.log(``);
  console.log(`- Restaurant: \`${RESTAURANT_ID}\``);
  console.log(`- Base monday: ${BASE_MONDAY} (greenfield — no existing services)`);
  console.log(`- Started: ${new Date().toISOString()}`);
  console.log(``);

  const profiles = db.select({ id: staffingProfiles.id, name: staffingProfiles.name })
    .from(staffingProfiles).where(eq(staffingProfiles.restaurantId, RESTAURANT_ID))
    .orderBy(staffingProfiles.sortOrder).all();
  const profileId = profiles[0].id;
  console.log(`- Profile: ${profiles[0].name}`);
  console.log(``);

  // ── H1. PRESET FIDELITY ──
  console.log(`## H1. Preset fidelity`);
  console.log(``);
  console.log(`For each preset, compare (raw WeightConfig) vs (quantized through semantic scale).`);
  console.log(`Low divergence ⇒ slider UI faithfully represents the preset.`);
  console.log(``);
  console.log(`| Preset | Divergence | Raw fill | Quant fill | Raw OT | Quant OT | Raw mismatch | Quant mismatch | Verdict |`);
  console.log(`|--------|-----------|---------|-----------|-------|---------|-------------|---------------|---------|`);

  for (const [name, rawW] of Object.entries(PRESETS)) {
    const levels = inferLevels(rawW);
    const quantW = resolveWeights("equilibre", levels as CustomWeights);
    const [raw, quant] = await Promise.all([
      solveWith(`preset:${name}:raw`, rawW, profileId),
      solveWith(`preset:${name}:quant`, quantW, profileId),
    ]);
    const s = similar(raw, quant);
    const verdict = s.similar ? "✓ faithful" : "⚠ diverges";
    console.log(`| ${name} | ${s.divergence} | ${raw.kitchenFillPct}/${raw.salleFillPct}% | ${quant.kitchenFillPct}/${quant.salleFillPct}% | ${raw.otHours} | ${quant.otHours} | ${raw.mismatch} | ${quant.mismatch} | ${verdict} |`);
  }
  console.log(``);

  // ── H2. SENSITIVITY ──
  console.log(`## H2. Sensitivity around DEFAULT_WEIGHTS (equilibre)`);
  console.log(``);
  console.log(`For each raw weight, multiply by 0.5, 1.5, 2.0 and compare to the equilibre baseline.`);
  console.log(`Large deviations indicate the default sits on a slope — tuning could matter.`);
  console.log(``);

  const baseline = await solveWith("equilibre-baseline", DEFAULT_WEIGHTS, profileId);
  console.log(`Baseline: cuisine ${baseline.kitchenFillPct}%, salle ${baseline.salleFillPct}%, OT ${baseline.otHours}h, mismatch ${baseline.mismatch}, stddev ${baseline.stddev}`);
  console.log(``);
  console.log(`| Weight | ×0.5 | ×1.5 | ×2.0 | Range |`);
  console.log(`|--------|------|------|------|-------|`);

  const rawWeightKeys: (keyof WeightConfig)[] = [
    "fill", "bucket0Value", "bucket1Value", "bucket2Penalty", "bucket3Penalty",
    "bucket2OtOffset", "bucket3OtOffset", "consistency", "preference", "priority",
    "flexibility", "subroleMismatch", "rolePenalty",
  ];
  for (const k of rawWeightKeys) {
    const base = DEFAULT_WEIGHTS[k];
    const mults = [0.5, 1.5, 2.0];
    const results: Metrics[] = [];
    for (const m of mults) {
      const w: WeightConfig = { ...DEFAULT_WEIGHTS, [k]: k.endsWith("Offset") ? Math.min(1, base * m) : base * m };
      results.push(await solveWith(`${k}×${m}`, w, profileId));
    }
    const fmt = (m: Metrics) => `fill ${m.kitchenFillPct}/${m.salleFillPct}%, OT ${m.otHours}, mis ${m.mismatch}`;
    const fills = [baseline.kitchenFillPct + baseline.salleFillPct, ...results.map(r => r.kitchenFillPct + r.salleFillPct)];
    const range = Math.round((Math.max(...fills) - Math.min(...fills)) * 10) / 10;
    console.log(`| \`${k}\` | ${fmt(results[0])} | ${fmt(results[1])} | ${fmt(results[2])} | Δfill ${range}% |`);
  }
  console.log(``);

  // ── H3. CO-TUNING (pairwise extremes) ──
  console.log(`## H3. Pairwise co-tuning`);
  console.log(``);
  console.log(`Pairs of dimensions at (L0, L0), (L0, L4), (L4, L0), (L4, L4). Each cell shows fill%/OT/mismatch.`);
  console.log(``);

  const pairs: Array<[TunableDimension, TunableDimension]> = [
    ["bucket0Value", "bucket3Penalty"],     // contract-first vs OT-expensive
    ["subroleMismatch", "rolePenalty"],     // strictness × strictness
    ["consistency", "preference"],           // stability × stability
    ["bucket3Penalty", "otOffset"],          // OT penalty × OT-willing concentration
    ["bucket0Value", "subroleMismatch"],     // contract fill vs subrole strictness
  ];
  for (const [d1, d2] of pairs) {
    console.log(`### \`${d1}\` × \`${d2}\``);
    console.log(``);
    console.log(`| ${d1} ↓ / ${d2} → | L0 | L4 |`);
    console.log(`|---|---|---|`);
    for (const lvl1 of [0, 4] as SemanticLevel[]) {
      const cells: string[] = [];
      for (const lvl2 of [0, 4] as SemanticLevel[]) {
        const ov: CustomWeights = { [d1]: lvl1, [d2]: lvl2 } as CustomWeights;
        const w = resolveWeights("equilibre", ov);
        const r = await solveWith(`${d1}=L${lvl1},${d2}=L${lvl2}`, w, profileId);
        cells.push(`${r.kitchenFillPct}/${r.salleFillPct}%, OT ${r.otHours}, mis ${r.mismatch}`);
      }
      console.log(`| L${lvl1} | ${cells[0]} | ${cells[1]} |`);
    }
    console.log(``);
  }

  console.log(`## Done`);
  console.log(`- Completed: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error("FAILED:", e?.message || e, e?.stack);
  process.exit(1);
});
