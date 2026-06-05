import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPhase7BaselineSet } from "../src/db/phase7-baseline-runner.js";

function readArgs() {
  const outIndex = process.argv.indexOf("--out");
  const ownersIndex = process.argv.indexOf("--owners");

  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  const owners = ownersIndex >= 0 ? process.argv[ownersIndex + 1] : undefined;

  if (!out || !owners) {
    throw new Error("Usage: bun scripts/phase7-create-empty-dbs.ts --out <directory> --owners <owner-id,owner-id>");
  }

  return {
    directory: resolve(out),
    owners: owners.split(",").map((owner) => owner.trim()).filter(Boolean),
  };
}

const args = readArgs();

if (args.owners.length === 0) {
  throw new Error("At least one owner id is required.");
}

if (existsSync(args.directory)) {
  throw new Error(`Output directory already exists: ${args.directory}`);
}

const result = createPhase7BaselineSet(args);

console.log(JSON.stringify(result, null, 2));

