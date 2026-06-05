import { resolve } from "node:path";
import { verifyPhase7CoreSnapshotDirectory } from "../src/db/phase7-core-snapshot-verifier.js";

const dirIndex = process.argv.indexOf("--dir");
const dir = dirIndex >= 0 ? process.argv[dirIndex + 1] : undefined;

if (!dir) {
  throw new Error("Usage: bun scripts/phase7-verify-core-snapshot.ts --dir <snapshot-directory>");
}

const result = verifyPhase7CoreSnapshotDirectory(resolve(dir));

console.log(JSON.stringify(result, null, 2));

if (result.failures.length > 0) {
  throw new Error("Phase 7 core snapshot verification failed.");
}

