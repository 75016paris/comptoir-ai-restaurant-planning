import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPhase7ReadinessPreflight } from "../src/db/phase7-readiness-preflight.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

const out = argValue("--out");
const report = argValue("--report");

if (out === null) {
  throw new Error("Usage: bun scripts/phase7-readiness-preflight.ts --out <snapshot-directory> [--report <report-json-path>]");
}

const directory = resolve(out);
if (existsSync(directory)) {
  throw new Error(`Output directory already exists: ${directory}`);
}

const reportPath = report ? resolve(report) : null;
if (reportPath && existsSync(reportPath)) {
  throw new Error(`Report file already exists: ${reportPath}`);
}

const { rawDb } = await import("../src/db/connection.js");
const result = runPhase7ReadinessPreflight({ source: rawDb, directory });
const output = `${JSON.stringify(result, null, 2)}\n`;

if (reportPath) {
  writeFileSync(reportPath, output);
}

console.log(output.trimEnd());

if (result.status !== "pass") {
  throw new Error("Phase 7 readiness preflight failed.");
}
