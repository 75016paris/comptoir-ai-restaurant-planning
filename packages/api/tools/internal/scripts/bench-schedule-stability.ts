/**
 * Schedule stability — measures how different the ACTUAL assignments are
 * between weight configs, not just the aggregate metrics.
 *
 * Two schedules can both have fill=98% and OT=53h but assign totally different
 * workers to Monday soir. This script computes the set of (worker, date, role, zone)
 * tuples each weight config produces and reports pairwise overlap (Jaccard).
 *
 * Jaccard ≈ 1.0 → schedules are identical
 * Jaccard ≈ 0.5 → half the assignments are different
 * Jaccard ≈ 0.0 → completely different schedules
 */

import {
  DEFAULT_WEIGHTS,
  PRESETS,
  resolveWeights,
  type WeightConfig,
  type CustomWeights,
} from "@comptoir/shared";
import { runMultiWeekSolve } from "../../../src/services/multi-week-solver.js";
import { db } from "../../../src/db/connection.js";
import { staffingProfiles, users } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { fmtDate, getMonday } from "../../../src/utils/scheduling.js";

const RESTAURANT_ID = "6ff8c361-5a74-42a1-9de9-584606ef332e";
const refDate = fmtDate((() => { const d = new Date(); d.setDate(d.getDate() + 56 - d.getDay() + 1); return d; })());
const BASE_MONDAY = getMonday(refDate);

type AssignmentSet = Set<string>;

async function solveAndExtract(label: string, weights: WeightConfig, profileId: string): Promise<AssignmentSet> {
  const r = await runMultiWeekSolve(RESTAURANT_ID, BASE_MONDAY, 1, { profileIdOverride: profileId }, undefined, weights);
  const slotMap = new Map(r.mergedSlots.map(s => [s.id, s]));
  const set = new Set<string>();
  for (const a of r.ilpResult.assignments) {
    const s = slotMap.get(a.slotId);
    if (!s) continue;
    // (worker, dow, role, zone) — we dedupe compound halves into one key
    set.add(`${a.workerId}|${s.dow}|${s.role}|${s.zone}`);
  }
  return set;
}

function jaccard(a: AssignmentSet, b: AssignmentSet): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function symmetricDiff(a: AssignmentSet, b: AssignmentSet): string[] {
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const x of a) if (!b.has(x)) onlyA.push(x);
  for (const x of b) if (!a.has(x)) onlyB.push(x);
  return [...onlyA.map(x => `- ${x}`), ...onlyB.map(x => `+ ${x}`)];
}

async function main() {
  console.log(`# Schedule stability bench`);
  console.log(``);
  console.log(`Comparing actual worker assignments (not aggregates) across weight configs.`);
  console.log(`- Restaurant: ${RESTAURANT_ID}, week starting ${BASE_MONDAY}`);
  console.log(``);

  const [profile] = db.select({ id: staffingProfiles.id, name: staffingProfiles.name })
    .from(staffingProfiles).where(eq(staffingProfiles.restaurantId, RESTAURANT_ID))
    .orderBy(staffingProfiles.sortOrder).limit(1).all();

  // Worker id → name for readability
  const workers = new Map<string, string>();
  for (const w of db.select({ id: users.id, name: users.name }).from(users).where(eq(users.restaurantId, RESTAURANT_ID)).all()) {
    workers.set(w.id, w.name);
  }

  const scenarios: Array<{ label: string; weights: WeightConfig }> = [
    { label: "equilibre",       weights: PRESETS["equilibre"] },
    { label: "equipe-stable",   weights: PRESETS["equipe-stable"] },
    { label: "economique",      weights: PRESETS["economique"] },
    { label: "resilience",      weights: PRESETS["resilience"] },
    { label: "rigid-max",       weights: resolveWeights("equilibre", { rolePenalty: 4, subroleMismatch: 4 } as CustomWeights) },
    { label: "loose-max",       weights: resolveWeights("equilibre", { rolePenalty: 0, subroleMismatch: 0, bucket3Penalty: 0 } as CustomWeights) },
    { label: "consistency-max", weights: resolveWeights("equilibre", { consistency: 4, preference: 4 } as CustomWeights) },
  ];

  // Solve each and collect assignment sets
  const sets: Record<string, AssignmentSet> = {};
  for (const s of scenarios) {
    sets[s.label] = await solveAndExtract(s.label, s.weights, profile.id);
    console.log(`- \`${s.label}\`: ${sets[s.label].size} assignments`);
  }
  console.log(``);

  // Pairwise Jaccard matrix
  console.log(`## Jaccard similarity matrix`);
  console.log(``);
  console.log(`*1.0 = identical schedules; 0.5 = half the (worker, slot) pairs differ.*`);
  console.log(``);
  const header = ["|"].concat(scenarios.map(s => s.label)).concat(["|"]).join(" | ");
  const sep = ["|"].concat(scenarios.map(() => "---")).concat(["|"]).join(" | ");
  console.log(header);
  console.log(sep);
  for (const row of scenarios) {
    const cells = scenarios.map(col => {
      if (col.label === row.label) return "—";
      const j = jaccard(sets[row.label], sets[col.label]);
      return j.toFixed(2);
    });
    console.log(`| **${row.label}** | ${cells.join(" | ")} |`);
  }
  console.log(``);

  // For a few key pairs, show concrete differences
  const pairs: Array<[string, string]> = [
    ["equilibre", "equipe-stable"],
    ["equilibre", "rigid-max"],
    ["equilibre", "loose-max"],
    ["equilibre", "resilience"],
    ["rigid-max", "loose-max"],
  ];

  console.log(`## Sample diffs (vs equilibre where applicable)`);
  console.log(``);
  for (const [a, b] of pairs) {
    const diff = symmetricDiff(sets[a], sets[b]);
    const pctChanged = Math.round(((diff.length / 2) / sets[a].size) * 100);
    console.log(`### \`${a}\` vs \`${b}\` — ${diff.length / 2} assignments changed (${pctChanged}% of schedule)`);
    console.log(``);
    // Convert "workerId|dow|role|zone" to readable and show a sample
    const readable = diff.slice(0, 20).map(line => {
      const [sign, ...rest] = line.split(" ");
      const [wid, dow, role, zone] = rest.join(" ").split("|");
      const days = ["", "lun", "mar", "mer", "jeu", "ven", "sam", "dim"];
      return `${sign} ${workers.get(wid) || wid} — ${days[Number(dow)]} ${role} ${zone}`;
    });
    for (const line of readable) console.log(`  ${line}`);
    if (diff.length > 20) console.log(`  … +${diff.length - 20} more`);
    console.log(``);
  }

  console.log(`## Done`);
}

main().catch(e => {
  console.error("FAILED:", e?.message || e, e?.stack);
  process.exit(1);
});
