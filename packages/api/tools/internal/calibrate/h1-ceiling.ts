// H1 diagnostic: measure empirical ceiling on dowPatternStability.
//
// For each (worker, dow) tuple in a solution, compares the actual assignment
// count across weeks (numerator of V2) to the "availability ceiling" — the
// number of weeks where that worker has at least one feasible slot on that
// dow (availability + role match, ignoring simultaneous-slot constraints).
//
// If actual/max is near 1.0, dowPatternStability is input-bound: the hard
// constraints already force the solver to the ceiling, so no objective
// change can lift it. If actual/max is ~0.5, there's significant objective
// headroom and the wow/template terms are simply pointing at the wrong thing.
//
// Usage:
//   bun run packages/api/tools/internal/calibrate/h1-ceiling.ts <sweep.jsonl> [--weeks 12]

import { generateRestaurant } from "./generate.js";
import { buildScenario, setScenarioWeeks, type ScenarioName } from "./scenarios.js";

interface Row {
  weightName: string;
  restaurant: { id: string; seed: number; [k: string]: any };
  scenario: ScenarioName;
  assignments: [string, number][];
  metrics: { dowPatternStability: number; [k: string]: any };
}

async function main() {
  const argv = process.argv.slice(2);
  const path = argv[0];
  if (!path) { console.error("usage: h1-ceiling.ts <sweep.jsonl> [--weeks N]"); process.exit(1); }
  const wi = argv.indexOf("--weeks");
  const weeks = wi >= 0 ? Number(argv[wi + 1]) : 12;
  setScenarioWeeks(weeks);

  const text = await Bun.file(path).text();
  const rows: Row[] = text.split("\n").filter(Boolean).map(l => JSON.parse(l));

  // Scenario cache: (seed, scenario) → rebuilt inputs.
  const scenarioCache = new Map<string, ReturnType<typeof buildScenario>>();
  function scenarioFor(row: Row) {
    const key = `${row.restaurant.seed}|${row.scenario}`;
    const hit = scenarioCache.get(key);
    if (hit) return hit;
    const r = generateRestaurant(row.restaurant.seed, row.restaurant as any);
    const s = buildScenario(r, row.scenario);
    scenarioCache.set(key, s);
    return s;
  }

  // Availability ceiling per (worker, dow): count of weeks where the worker has
  // ≥1 feasible slot (role match + availability) on that dow. Cached per scenario.
  const ceilCache = new Map<string, Map<string, number>>();
  function ceilFor(row: Row) {
    const key = `${row.restaurant.seed}|${row.scenario}`;
    const hit = ceilCache.get(key);
    if (hit) return hit;
    const inputs = scenarioFor(row);
    const byWorkerDowWeek = new Map<string, Set<number>>(); // key: wId|dow → set of weeks with ≥1 feasible slot
    for (const w of inputs.workers) {
      for (const s of inputs.slots) {
        if (w.role !== s.role) continue;
        if (!inputs.checker.isAvailable(w.id, s)) continue;
        // Exclude pre-existing services overlap (matches solveCPSAT's pre-filter)
        const existing = w.existingServicesByDate.get(s.date);
        if (existing?.some(e => {
          const toMin = (t: string) => Number(t.slice(0,2))*60 + Number(t.slice(3,5));
          const [aS, aE] = [toMin(e.startTime), toMin(e.endTime)];
          const [bS, bE] = [toMin(s.startTime), toMin(s.endTime)];
          return aS < bE && bS < aE;
        })) continue;
        const k = `${w.id}|${s.dow}`;
        if (!byWorkerDowWeek.has(k)) byWorkerDowWeek.set(k, new Set());
        byWorkerDowWeek.get(k)!.add(s.week ?? 0);
      }
    }
    const out = new Map<string, number>();
    for (const [k, wks] of byWorkerDowWeek) out.set(k, wks.size);
    ceilCache.set(key, out);
    return out;
  }

  // Actual counts per (worker, dow) from assignments + slotId→dow/week lookup.
  function actualCountsFor(row: Row) {
    const inputs = scenarioFor(row);
    const meta = new Map<number, { dow: number; week: number }>();
    for (const s of inputs.slots) meta.set(s.id, { dow: s.dow, week: s.week ?? 0 });
    const dowByWorkerWeek = new Map<string, Set<number>>();
    for (const [wId, sId] of row.assignments) {
      const m = meta.get(sId); if (!m) continue;
      const k = `${wId}_${m.week}`;
      if (!dowByWorkerWeek.has(k)) dowByWorkerWeek.set(k, new Set());
      dowByWorkerWeek.get(k)!.add(m.dow);
    }
    const counts = new Map<string, number>(); // key: wId|dow → count of weeks
    for (const [k, dows] of dowByWorkerWeek) {
      const [wId] = k.split("_");
      for (const d of dows) {
        const kk = `${wId}|${d}`;
        counts.set(kk, (counts.get(kk) ?? 0) + 1);
      }
    }
    return counts;
  }

  // Aggregate per-preset utilization.
  type Agg = {
    utilizations: number[];   // actual/ceiling for each (w,d) seen in solution
    dowStabV2: number[];      // from metrics
    tuplesSeen: number[];
    ceilingMeanV2: number[];  // hypothetical V2 if all (w,d) tuples hit ceiling
  };
  const byPreset = new Map<string, Agg>();

  for (const row of rows) {
    if (row.assignments.length === 0) continue;
    const ceiling = ceilFor(row);
    const actual = actualCountsFor(row);

    // Per-solution utilization
    const utils: number[] = [];
    let tuplesSeen = 0;
    let sumActualOverWeeks = 0;
    let sumCeilOverWeeks = 0;
    for (const [k, count] of actual) {
      const max = ceiling.get(k) ?? count; // fallback; should always be ≥ count
      tuplesSeen++;
      utils.push(max > 0 ? count / max : 1);
      sumActualOverWeeks += count / weeks;
      sumCeilOverWeeks += Math.min(max, weeks) / weeks;
    }
    const meanUtil = utils.length > 0 ? utils.reduce((a,b)=>a+b,0)/utils.length : 1;
    const ceilingV2 = tuplesSeen === 0 ? 1 : sumCeilOverWeeks / tuplesSeen;

    const name = row.weightName;
    if (!byPreset.has(name)) byPreset.set(name, { utilizations: [], dowStabV2: [], tuplesSeen: [], ceilingMeanV2: [] });
    const agg = byPreset.get(name)!;
    agg.utilizations.push(meanUtil);
    agg.dowStabV2.push(row.metrics.dowPatternStability);
    agg.tuplesSeen.push(tuplesSeen);
    agg.ceilingMeanV2.push(ceilingV2);
  }

  const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
  const stdev = (xs: number[]) => {
    const m = mean(xs);
    return xs.length > 1 ? Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/xs.length) : 0;
  };

  const presets = [...byPreset.keys()].sort();
  console.log(`# H1 ceiling analysis  file=${path}  weeks=${weeks}\n`);
  console.log(`${"preset".padEnd(16)} ${"n".padStart(4)}  ${"dowStabV2".padStart(10)} ${"util".padStart(10)} ${"ceilingV2".padStart(10)} ${"tuples".padStart(7)}`);
  for (const p of presets) {
    const a = byPreset.get(p)!;
    console.log(`${p.padEnd(16)} ${String(a.dowStabV2.length).padStart(4)}  ${mean(a.dowStabV2).toFixed(4).padStart(10)} ${mean(a.utilizations).toFixed(4).padStart(10)} ${mean(a.ceilingMeanV2).toFixed(4).padStart(10)} ${mean(a.tuplesSeen).toFixed(1).padStart(7)}`);
  }
  console.log(`\n# util = actual(w,d count) / availability ceiling per (w,d)`);
  console.log(`# ceilingV2 = hypothetical dowStabV2 if every (w,d) tuple in-solution hit its availability ceiling`);
  console.log(`# Gap = ceilingV2 − dowStabV2. Narrow gap → input-bound. Wide gap → objective room.`);

  // Explicit gap line
  console.log(`\n${"preset".padEnd(16)} ${"actual".padStart(10)} ${"ceiling".padStart(10)} ${"headroom".padStart(10)}`);
  for (const p of presets) {
    const a = byPreset.get(p)!;
    const act = mean(a.dowStabV2), ceil = mean(a.ceilingMeanV2);
    console.log(`${p.padEnd(16)} ${act.toFixed(4).padStart(10)} ${ceil.toFixed(4).padStart(10)} ${(ceil-act).toFixed(4).padStart(10)}`);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
