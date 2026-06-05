import { qk, setActiveRestaurantQueryScope } from "../src/lib/query-keys";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

setActiveRestaurantQueryScope("resto-a");
assertEqual(qk.schedule.week("2026-05-18"), ["restaurant", "resto-a", "schedule", "week", "2026-05-18"], "schedule key uses restaurant A");
assertEqual(qk.employees.list(true), ["restaurant", "resto-a", "employees", "list", true], "employee key uses restaurant A");

setActiveRestaurantQueryScope("resto-b");
assertEqual(qk.schedule.week("2026-05-18"), ["restaurant", "resto-b", "schedule", "week", "2026-05-18"], "schedule key uses restaurant B");
assertEqual(qk.employees.list(true), ["restaurant", "resto-b", "employees", "list", true], "employee key uses restaurant B");

assertEqual(qk.auth.me(), ["auth", "me"], "auth key is global");
assertEqual(qk.billing.summary(), ["billing", "summary"], "billing summary key is global");
assertEqual(qk.billing.activeEmployees("2026-05"), ["billing", "active-employees", "2026-05"], "billing active employees key is global");
assertEqual(qk.workerShares.list(), ["restaurant", "resto-b", "worker-shares", "list"], "worker-share management key is restaurant-scoped");
assertEqual(qk.workerShares.shareableWorkers("resto-a", "kitchen"), ["restaurant", "resto-b", "worker-shares", "shareable-workers", "resto-a", "kitchen"], "shareable-worker key is restaurant-scoped");
assertEqual(qk.workerShares.pendingMine(), ["restaurant", "resto-b", "worker-shares", "pending-mine"], "worker pending-share key is active-owner scoped through the active restaurant");

setActiveRestaurantQueryScope(null);
assertEqual(qk.settings.preferences(), ["restaurant", "pending", "settings", "preferences"], "pending scope is explicit");

const srcRoot = path.resolve(import.meta.dir, "../src");
const queryKeyPattern = /\bqueryKey\s*:(?!\s*qk\.)/;
const invalidationPattern = /\b(?:invalidateQueries|removeQueries|refetchQueries)\s*\(\s*\{\s*queryKey\s*:(?!\s*qk\.)/;
const directCacheLiteralPattern = /\b(?:setQueryData|getQueryData|ensureQueryData|prefetchQuery|fetchQuery)\s*(?:<[^;]*?>)?\s*\(\s*\[/g;
const broadCacheClearPattern = /\bqueryClient\.clear\s*\(/;
const allowedBroadCacheClearFiles = new Map<string, string>([
  ["src/hooks/auth-provider.tsx", "logout and active-restaurant switch intentionally clear all cached tenant data"],
]);

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [fullPath];
  }));
  return files.flat();
}

function lineNumberForIndex(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

const violations: string[] = [];
const matchedBroadCacheClearFiles = new Set<string>();
for (const file of await listSourceFiles(srcRoot)) {
  if (file.endsWith("src/lib/query-keys.ts")) continue;
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  const relative = path.relative(path.resolve(import.meta.dir, ".."), file);
  for (const [index, line] of lines.entries()) {
    if (broadCacheClearPattern.test(line)) {
      if (allowedBroadCacheClearFiles.has(relative)) {
        matchedBroadCacheClearFiles.add(relative);
      } else {
        violations.push(`${relative}:${index + 1}: broad queryClient.clear() is only allowed in auth context changes`);
        continue;
      }
    }
    if (!queryKeyPattern.test(line) && !invalidationPattern.test(line)) continue;
    violations.push(`${relative}:${index + 1}: ${line.trim()}`);
  }

  directCacheLiteralPattern.lastIndex = 0;
  for (const match of text.matchAll(directCacheLiteralPattern)) {
    violations.push(`${relative}:${lineNumberForIndex(text, match.index ?? 0)}: direct cache key literal array must use qk`);
  }
}

const staleAllowlistEntries = [...allowedBroadCacheClearFiles.keys()]
  .filter((file) => !matchedBroadCacheClearFiles.has(file))
  .map((file) => `${file} is listed for broad queryClient.clear() but no longer matches`);

if (violations.length > 0 || staleAllowlistEntries.length > 0) {
  throw new Error([
    "React Query keys must use the qk catalog so restaurant-scoped data carries the active restaurant prefix.",
    staleAllowlistEntries.length > 0 ? "Remove stale query-key allowlist entries:" : "",
    ...staleAllowlistEntries.map((entry) => `- ${entry}`),
    ...violations.map((v) => `- ${v}`),
  ].filter(Boolean).join("\n"));
}

console.log(`Query-key guard passed (${matchedBroadCacheClearFiles.size} broad cache-clear files allowlisted).`);
