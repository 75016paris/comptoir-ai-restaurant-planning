import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvailabilityChecker, ILPConfig, ILPSlot, ILPWorker } from "../utils/ilp-solver.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-autostaff-diag-")), "test.db");

const { buildUnfilledSlotDiagnostics } = await import("./autostaffing.js");

const config: ILPConfig = {
  maxDailyHoursCompound: 12,
  minRestHours: 10,
  maxConsecutiveDays: 6,
  maxRollingWorkDays: 5,
  max12WeekAvgHours: 46,
  otCap: 39,
  disabledRules: new Set(),
  otDistribution: "controlled",
  dayPriorityMap: {},
  prefEnabled: false,
  templates: [],
};

const checker = (available = true): AvailabilityChecker => ({
  isAvailable: () => available,
  prefersSlot: () => false,
});

function worker(overrides: Partial<ILPWorker> = {}): ILPWorker {
  return {
    id: "w1",
    name: "Alice",
    role: "floor",
    priority: 1,
    overtimeWilling: false,
    contractHours: 35,
    subRoles: ["Serveur"],
    existingWeeklyHours: 0,
    existingWorkDates: new Set(),
    existingDailyHours: new Map(),
    existingLastEnd: new Map(),
    existingFirstStart: new Map(),
    existingServicesByDate: new Map(),
    historicalHours: 0,
    historicalWeeks: 0,
    consistency: new Map(),
    flexibility: 1,
    ...overrides,
  };
}

function slot(overrides: Partial<ILPSlot> = {}): ILPSlot {
  return {
    id: 1,
    date: "2026-05-18",
    dow: 1,
    zone: "Soir",
    role: "floor",
    startTime: "18:00",
    endTime: "23:00",
    hours: 5,
    target: 1,
    existingFill: 0,
    compound: false,
    ...overrides,
  };
}

describe("buildUnfilledSlotDiagnostics", () => {
  test("explains availability bottleneck", () => {
    const diagnostics = buildUnfilledSlotDiagnostics([worker()], [slot()], [], checker(false), config);
    expect(diagnostics[0].message).toContain("Poste non pourvu");
    expect(diagnostics[0].message).toContain("indisponibles");
  });

  test("explains sub-role shortage", () => {
    const diagnostics = buildUnfilledSlotDiagnostics(
      [worker({ subRoles: ["Runner"] })],
      [slot({ roleBreakdown: { Barman: 1 } })],
      [],
      checker(true),
      config,
    );
    expect(diagnostics[0].message).toContain("compétence requise insuffisante");
    expect(diagnostics[0].message).toContain("Barman");
  });

  test("explains hours cap bottleneck", () => {
    const diagnostics = buildUnfilledSlotDiagnostics(
      [worker({ existingWeeklyHours: 38 })],
      [slot({ hours: 5 })],
      [],
      checker(true),
      config,
    );
    expect(diagnostics[0].message).toContain("plafond d'heures");
  });

  test("does not report fully covered slots", () => {
    const diagnostics = buildUnfilledSlotDiagnostics(
      [worker()],
      [slot()],
      [{ workerId: "w1", slotId: 1 }],
      checker(true),
      config,
    );
    expect(diagnostics).toEqual([]);
  });
});
