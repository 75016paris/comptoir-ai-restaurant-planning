import { rawDb } from "../src/db/connection.js";
import { buildPhase7DocumentStoragePlan } from "../src/db/phase7-document-storage-audit.js";

const plan = buildPhase7DocumentStoragePlan(rawDb);

console.log(JSON.stringify(plan, null, 2));

if (plan.issues.length > 0) {
  throw new Error("Phase 7 document storage plan found unsafe document storage rows.");
}
