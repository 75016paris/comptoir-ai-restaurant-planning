import { describe, expect, test } from "bun:test";
import {
  missingSilaeMatricules,
  payrollToSilae,
  SILAE_DEFAULT_CODES,
  type PayrollExport,
} from "./payroll";

function basePayroll(overrides: Partial<PayrollExport> = {}): PayrollExport {
  return {
    month: "2026-05",
    restaurantName: "Comptoir Test",
    generatedAt: "2026-05-31T10:00:00.000Z",
    baseReference: 151.67,
    otThreshold: 39,
    workers: [
      {
        workerId: "worker-1",
        matricule: "001",
        name: "Audrey Tautou",
        role: "floor",
        baseHours: 84,
        totalHours: 89.5,
        overtimeHours: 5.5,
        ot110: 4,
        ot120: 1.5,
        ot150: 0,
        daysWorked: 14,
        servicesWorked: 18,
        holidayDays: 3,
        sickDays: 2,
        absences: [
          { type: "holiday", startDate: "2026-05-01", endDate: "2026-05-03", days: 3 },
          { type: "sick", startDate: "2026-05-11", endDate: "2026-05-12", days: 2 },
        ],
        mealDays: 14,
        analytics: [
          {
            restaurantId: "restaurant-1",
            restaurantName: "Comptoir Test",
            serviceCount: 18,
            daysWorked: 14,
            totalHours: 89.5,
            baseHours: 84,
            ot110: 4,
            ot120: 1.5,
            ot150: 0,
          },
        ],
        weeks: [],
      },
    ],
    totals: {
      baseHours: 84,
      totalHours: 89.5,
      overtimeHours: 5.5,
      ot110: 4,
      ot120: 1.5,
      ot150: 0,
      daysWorked: 14,
      holidayDays: 3,
      sickDays: 2,
    },
    ...overrides,
  };
}

describe("payrollToSilae", () => {
  test("exports a single flat Silae import table with prefixed codes and French decimals", () => {
    const csv = payrollToSilae(basePayroll());

    expect(csv).toBe([
      "Matricule;Code;Valeur;Date début;Date fin;Section analytique",
      "001;HS-HN;84,00;01/05/2026;;Comptoir Test",
      "001;HS-HS10;4,00;01/05/2026;;Comptoir Test",
      "001;HS-HS20;1,50;01/05/2026;;Comptoir Test",
      "001;EV-RepasServis;14,00;01/05/2026;;Comptoir Test",
      "001;AB-300;3,00;01/05/2026;03/05/2026;Comptoir Test",
      "001;AB-100;2,00;11/05/2026;12/05/2026;Comptoir Test",
    ].join("\r\n"));

    expect(csv).not.toContain("EXPORT PAIE");
    expect(csv).not.toContain("TOTAL");
    expect(csv).not.toContain("DETAIL HEBDOMADAIRE");
    expect(csv).not.toContain("84.00");
  });

  test("requires a real Silae matricule instead of generating one", () => {
    const data = basePayroll({
      workers: [{ ...basePayroll().workers[0], matricule: null }],
    });

    expect(missingSilaeMatricules(data)).toEqual(["Audrey Tautou"]);
    expect(() => payrollToSilae(data)).toThrow("matricule manquant pour Audrey Tautou");
  });

  test("keeps Silae codes configurable per dossier", () => {
    const csv = payrollToSilae(basePayroll(), {
      ...SILAE_DEFAULT_CODES,
      heuresNormales: "HS-CUSTOM",
      repas: "EV-CUSTOM",
    });

    expect(csv).toContain("001;HS-CUSTOM;84,00;01/05/2026;;Comptoir Test");
    expect(csv).toContain("001;EV-CUSTOM;14,00;01/05/2026;;Comptoir Test");
  });
});
