import { resolve } from "node:path";
import { buildPhase7SnapshotReport } from "../src/db/phase7-snapshot-report.js";

const dirIndex = process.argv.indexOf("--dir");
const dir = dirIndex >= 0 ? process.argv[dirIndex + 1] : undefined;

if (!dir) {
  throw new Error("Usage: bun scripts/phase7-snapshot-report.ts --dir <snapshot-directory>");
}

const report = buildPhase7SnapshotReport(resolve(dir));

console.log(JSON.stringify(report, null, 2));

if (report.status !== "pass") {
  throw new Error("Phase 7 snapshot report failed verification.");
}
