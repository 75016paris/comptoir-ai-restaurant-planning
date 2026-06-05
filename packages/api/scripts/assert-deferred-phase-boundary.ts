import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  deferredPhaseAllowlistedFiles,
  deferredPhaseScanFiles,
  deferredPhaseScanRoots,
  findDeferredPhaseViolations,
  isDeferredPhaseScanCandidate,
  sortDeferredPhaseViolations,
  type DeferredPhaseViolation,
} from "./deferred-phase-boundary-rules.js";

const repoRoot = path.resolve(import.meta.dir, "../../..");

async function listFiles(dir: string): Promise<string[]> {
  const fullDir = path.join(repoRoot, dir);
  const entries = await readdir(fullDir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(fullDir, entry.name);
    if (entry.isDirectory()) return listFiles(path.relative(repoRoot, fullPath));
    if (!entry.isFile()) return [];
    if (!isDeferredPhaseScanCandidate(entry.name)) return [];
    return [fullPath];
  }));
  return files.flat();
}

const violations: DeferredPhaseViolation[] = [];

for (const root of deferredPhaseScanRoots) {
  for (const file of await listFiles(root)) {
    const relative = path.relative(repoRoot, file);
    if (deferredPhaseAllowlistedFiles.has(relative)) continue;
    const text = await readFile(file, "utf8");
    violations.push(...findDeferredPhaseViolations(relative, text));
  }
}

for (const relative of deferredPhaseScanFiles) {
  if (deferredPhaseAllowlistedFiles.has(relative)) continue;
  if (!isDeferredPhaseScanCandidate(relative)) continue;
  const text = await readFile(path.join(repoRoot, relative), "utf8");
  violations.push(...findDeferredPhaseViolations(relative, text));
}

if (violations.length > 0) {
  const details = sortDeferredPhaseViolations(violations)
    .map((v) => `- ${v.file}:${v.line} uses ${v.match}`)
    .join("\n");
  throw new Error([
    "This release slice must not implement deferred Phase 7 or owner-level payroll capabilities.",
    "Per-owner DB extraction and owner-level payroll stay out of this branch.",
    "If a future branch intentionally starts Phase 7 or owner-level payroll, update or remove this guard with the product decision.",
    details,
  ].join("\n"));
}

console.log("Deferred Phase 7/payroll boundary guard passed.");
