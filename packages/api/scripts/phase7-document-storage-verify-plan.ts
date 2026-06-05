import { readFileSync } from "node:fs";
import { rawDb } from "../src/db/connection.js";
import { verifyPhase7DocumentStoragePlan, type Phase7DocumentStoragePlan } from "../src/db/phase7-document-storage-audit.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const planPath = argValue("--plan");
if (!planPath) {
  throw new Error("Usage: bun scripts/phase7-document-storage-verify-plan.ts --plan <path-to-plan.json>");
}

const plan = JSON.parse(readFileSync(planPath, "utf8")) as Phase7DocumentStoragePlan;
const verification = verifyPhase7DocumentStoragePlan(rawDb, plan);

console.log(JSON.stringify(verification, null, 2));

if (verification.issues.length > 0) {
  throw new Error("Phase 7 document storage plan verification failed.");
}
