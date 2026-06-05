import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { rawDb } from "../src/db/connection.js";
import {
  createPhase7CoreSnapshot,
  verifyPhase7CoreSnapshot,
} from "../src/db/phase7-core-snapshot.js";

const outIndex = process.argv.indexOf("--out");
const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

if (!out) {
  throw new Error("Usage: bun scripts/phase7-extract-core-snapshot.ts --out <directory>");
}

const directory = resolve(out);
if (existsSync(directory)) {
  throw new Error(`Output directory already exists: ${directory}`);
}

const result = createPhase7CoreSnapshot({ source: rawDb, directory });
const failures = verifyPhase7CoreSnapshot(result);

console.log(JSON.stringify({ ...result, verificationFailures: failures }, null, 2));

if (failures.length > 0) {
  throw new Error("Phase 7 core snapshot verification failed.");
}

