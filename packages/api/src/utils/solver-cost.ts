// Canonical cost-awareness objective contribution.
// Used by both the HiGHS ILP and CP-SAT backends so the two solvers see the
// same cost signal. Formulation: -weight × slotHours × (hourlyRateCents / 100).
// Units are "euros × weight" — a €5/h cheaper worker is worth 5× a €1/h one.

import type { ILPWorker } from "./ilp-solver.js";

export function costCoeff(worker: ILPWorker, slotHours: number, weight: number): number {
  if (!weight || !worker.hourlyRateCents || worker.hourlyRateCents <= 0) return 0;
  return -weight * slotHours * (worker.hourlyRateCents / 100);
}
