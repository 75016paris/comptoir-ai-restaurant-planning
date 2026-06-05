// Rescore existing sweep jsonl with alternative résilience metrics — no solver re-run.
//
// Hypothesis: the current `resilience` metric (backup pool per assignment = other workers
// same-role + eligible + not-same-date) is mostly a function of input eligibility, not of
// solver choices. That would explain why the lex two-pass preset barely moves it (+0.001).
//
// This tool recomputes two stricter metrics from assignments already on disk:
//
//   trueBackupMean:
//     per assignment, count workers who can actually replace the primary — same role,
//     checker-eligible, not already assigned an overlapping slot (same date × time), AND
//     have hours slack left in the same week (currentAssignedInWeek + slot.hours ≤ OT cap).
//     The hours-slack filter is what the base metric misses; a worker already at 47h can't
//     really "back up" a cancelation.
//
//   versatileSpareRatio:
//     fraction of versatile workers' contract-hours that remain unassigned across the horizon.
//     Versatile = subRoles.length ≥ 2. Direct proxy for "reserves held back by the solver."
//     A higher value means the plan concentrates load on specialists, leaving multi-skilled
//     workers free to cover last-minute cancels.
//
// Usage:
//   bun run packages/api/tools/internal/calibrate/rescore-resilience.ts \
//     --input packages/api/tools/internal/calibrate/results/presets-20260421-1008.jsonl \
//     --weeks 4
//   Prints per-preset aggregate table to stdout.

import { readFileSync } from "node:fs";
import { generateRestaurant } from "./generate.js";
import { buildScenario, setScenarioWeeks, type ScenarioName } from "./scenarios.js";

interface RowIn {
  weightIdx: number;
  weightName: string;
  restaurant: any; // RestaurantConfig
  scenario: ScenarioName;
  status: string;
  assignments: Array<[string, number]>;
  metrics: Record<string, number>;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (f: string, d?: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const input = get("--input");
  if (!input) throw new Error("--input <jsonl> required");
  const weeks = Number(get("--weeks", "4"));
  return { input, weeks };
}

// Same helper the solver uses for weekly OT cap (HCR 48h hard).
function weekKey(dateISO: string): string {
  // ISO week key = YYYY-Wnn. Good enough for synthetic grouping.
  const d = new Date(dateISO + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

const OT_WEEK_CAP = 48; // HCR weekly hard cap

function rescoreRow(row: RowIn, weeks: number): { trueBackupMean: number; versatileSpareRatio: number } | null {
  if (row.status === "infeasible" || row.status === "error") return null;
  const r = generateRestaurant(row.restaurant.seed, row.restaurant);
  setScenarioWeeks(weeks);
  const inputs = buildScenario(r, row.scenario);
  const slotsById = new Map(inputs.slots.map(s => [s.id, s]));
  const workersById = new Map(inputs.workers.map(w => [w.id, w]));

  // Build per-worker weekly-hours map from the solved assignments.
  const weeklyHours = new Map<string, Map<string, number>>(); // worker → weekKey → hours
  const workerAssignedSlots = new Map<string, number[]>();    // worker → [slotId]
  const totalAssignedByWorker = new Map<string, number>();
  for (const [wid, sid] of row.assignments) {
    const s = slotsById.get(sid);
    if (!s) continue;
    const wk = weekKey(s.date);
    if (!weeklyHours.has(wid)) weeklyHours.set(wid, new Map());
    const wm = weeklyHours.get(wid)!;
    wm.set(wk, (wm.get(wk) ?? 0) + s.hours);
    if (!workerAssignedSlots.has(wid)) workerAssignedSlots.set(wid, []);
    workerAssignedSlots.get(wid)!.push(sid);
    totalAssignedByWorker.set(wid, (totalAssignedByWorker.get(wid) ?? 0) + s.hours);
  }

  // Slots by (worker, date) for overlap check.
  const slotsByWorkerDate = new Map<string, Set<number>>();
  for (const [wid, sid] of row.assignments) {
    const s = slotsById.get(sid);
    if (!s) continue;
    const k = `${wid}|${s.date}`;
    if (!slotsByWorkerDate.has(k)) slotsByWorkerDate.set(k, new Set());
    slotsByWorkerDate.get(k)!.add(sid);
  }

  // ── trueBackupMean ──
  let backupSum = 0, backupCount = 0;
  for (const [wid, sid] of row.assignments) {
    const slot = slotsById.get(sid);
    if (!slot) continue;
    const wk = weekKey(slot.date);
    let backups = 0;
    for (const other of inputs.workers) {
      if (other.id === wid) continue;
      if (other.role !== slot.role) continue;
      if (!inputs.checker.isAvailable(other.id, slot)) continue;
      // Not already assigned that same date (any time).
      if (slotsByWorkerDate.get(`${other.id}|${slot.date}`)?.size) continue;
      // Has hours slack that week.
      const curWeekHours = weeklyHours.get(other.id)?.get(wk) ?? 0;
      if (curWeekHours + slot.hours > OT_WEEK_CAP) continue;
      backups++;
    }
    backupSum += backups;
    backupCount++;
  }
  const trueBackupMean = backupCount === 0 ? 0 : backupSum / backupCount;

  // ── versatileSpareRatio ──
  // Versatile = ≥2 subRoles. Spare = contract × weeks − total assigned.
  let versatileContract = 0, versatileAssigned = 0;
  for (const w of inputs.workers) {
    if (w.subRoles.length < 2) continue;
    versatileContract += w.contractHours * weeks;
    versatileAssigned += totalAssignedByWorker.get(w.id) ?? 0;
  }
  const versatileSpareRatio = versatileContract === 0
    ? 0
    : Math.max(0, versatileContract - versatileAssigned) / versatileContract;

  return { trueBackupMean, versatileSpareRatio };
}

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }

async function main() {
  const { input, weeks } = parseArgs();
  const text = readFileSync(input, "utf8");
  const rows: RowIn[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  console.log(`rescoring ${rows.length} rows from ${input} (${weeks}w horizon)`);

  const byPreset = new Map<string, { base: number[]; backup: number[]; spare: number[] }>();
  let skipped = 0;
  for (const row of rows) {
    const r = rescoreRow(row, weeks);
    if (!r) { skipped++; continue; }
    if (!byPreset.has(row.weightName)) byPreset.set(row.weightName, { base: [], backup: [], spare: [] });
    const g = byPreset.get(row.weightName)!;
    g.base.push(row.metrics.resilience);
    g.backup.push(r.trueBackupMean);
    g.spare.push(r.versatileSpareRatio);
  }

  console.log(`skipped ${skipped} (infeasible/error)\n`);
  const header = ["preset", "n", "res_base", "trueBkpMean", "versSpareRatio"];
  const pad = [20, 5, 10, 14, 16];
  console.log(header.map((h, i) => h.padEnd(pad[i])).join(""));
  const names = [...byPreset.keys()].sort();
  for (const name of names) {
    const g = byPreset.get(name)!;
    const vals = [
      name,
      String(g.base.length),
      mean(g.base).toFixed(3),
      mean(g.backup).toFixed(2),
      mean(g.spare).toFixed(3),
    ];
    console.log(vals.map((v, i) => v.padEnd(pad[i])).join(""));
  }

  // Spreads
  console.log("\nspreads (max − min):");
  const baseVals = names.map(n => mean(byPreset.get(n)!.base));
  const backupVals = names.map(n => mean(byPreset.get(n)!.backup));
  const spareVals = names.map(n => mean(byPreset.get(n)!.spare));
  console.log(`  res_base:        ${(Math.max(...baseVals) - Math.min(...baseVals)).toFixed(4)}`);
  console.log(`  trueBkpMean:     ${(Math.max(...backupVals) - Math.min(...backupVals)).toFixed(3)}`);
  console.log(`  versSpareRatio:  ${(Math.max(...spareVals) - Math.min(...spareVals)).toFixed(4)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
