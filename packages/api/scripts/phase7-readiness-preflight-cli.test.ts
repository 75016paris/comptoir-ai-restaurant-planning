import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const scriptPath = join(import.meta.dir, "phase7-readiness-preflight.ts");

function runPreflight(args: string[], cwd: string) {
  return Bun.spawnSync({
    cmd: ["bun", scriptPath, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("phase7 readiness preflight CLI", () => {
  test("validates required args before opening the default database", () => {
    const cwd = mkdtempSync(join(tmpdir(), "comptoir-phase7-preflight-cli-"));

    const result = runPreflight([], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Usage: bun scripts/phase7-readiness-preflight.ts");
    expect(existsSync(join(cwd, "comptoir.db"))).toBe(false);
  });

  test("rejects missing option values before opening the default database", () => {
    const cwd = mkdtempSync(join(tmpdir(), "comptoir-phase7-preflight-cli-"));

    const result = runPreflight(["--out", "--report", join(cwd, "preflight.json")], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Missing value for --out");
    expect(existsSync(join(cwd, "comptoir.db"))).toBe(false);
  });

  test("refuses to overwrite an existing report before opening the default database", () => {
    const cwd = mkdtempSync(join(tmpdir(), "comptoir-phase7-preflight-cli-"));
    const reportPath = join(cwd, "preflight.json");
    writeFileSync(reportPath, "{}\n");

    const result = runPreflight(["--out", join(cwd, "snapshot"), "--report", reportPath], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`Report file already exists: ${reportPath}`);
    expect(existsSync(join(cwd, "comptoir.db"))).toBe(false);
  });
});
