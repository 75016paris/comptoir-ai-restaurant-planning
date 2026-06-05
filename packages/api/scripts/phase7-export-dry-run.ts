import { rawDb } from "../src/db/connection.js";
import { collectPhase7DryRunSummary } from "../src/db/phase7-export-dry-run.js";

const summary = collectPhase7DryRunSummary(rawDb);

console.log(JSON.stringify(summary, null, 2));

if (summary.failures.length > 0) {
  throw new Error("Phase 7 export dry-run found rows that cannot be assigned safely.");
}

