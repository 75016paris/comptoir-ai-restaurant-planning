/**
 * DPAE (Déclaration Préalable À l'Embauche) export.
 *
 * Produces a CSV the admin can import into the URSSAF net-entreprises portal,
 * or consult when filing a DPAE manually. Replaces the ex-DUE (Déclaration
 * Unique d'Embauche), now unified under DPAE for all hires.
 *
 * Legal mandate: Code du travail L1221-10. Missing a DPAE = up to 1125€
 * fine per employee per day of lateness (2025 rate, check current).
 *
 * CSV columns match the URSSAF fields that admins typically need to fill
 * manually. NIR is prompted-but-optional: if the worker doesn't yet have
 * one, the employer submits with "NNA" (numéro non attribué) — the URSSAF
 * assigns a provisional one.
 */

import { db } from "../db/connection.js";
import { users, restaurants } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { listRestaurantMemberUserIds } from "./restaurant-context.js";

export type DpaeRow = {
  // Employer fields
  employerName: string;
  employerSiret: string;        // 14 digits from restaurants.siret; placeholder if admin hasn't set it yet
  employerAddress: string;
  employerCode: string;         // code APE/NAF — "5610A" for restauration traditionnelle
  // Worker fields
  workerLastName: string;
  workerFirstName: string;
  workerBirthDate: string;      // YYYY-MM-DD or "" if not captured
  workerBirthPlace: string;     // "" unless captured
  workerNationality: string;    // "FR" default
  workerNir: string;            // 13 digits or "NNA" — prompted separately
  workerAddress: string;
  // Contract fields
  contractType: string;          // CDI | CDD | saisonnier | extra
  position: string;              // functions description
  hcrLevel: string;              // Niveau Échelon
  startDate: string;             // YYYY-MM-DD
  endDate: string | "";          // CDD/saisonnier/extra only
  weeklyHours: string;           // "35", "39"
  hourlyRate: string;            // "13.50"
  probationPeriod: string;       // "2 mois" (CDI) / "1 mois" (CDD)
  // Regime fields
  healthInsurance: string;       // "Régime général"
  medicalService: string;        // the occupational medicine service name if known
};

export type DpaeExportInput = {
  restaurantId: string;
  workerIds: string[];           // workers to include
  // per-worker overrides the UI can collect at export time
  perWorker?: Record<string, {
    nir?: string;
    birthDate?: string;
    birthPlace?: string;
    nationality?: string;
  }>;
};

const CSV_HEADERS: Array<keyof DpaeRow> = [
  "employerName", "employerSiret", "employerAddress", "employerCode",
  "workerLastName", "workerFirstName", "workerBirthDate", "workerBirthPlace",
  "workerNationality", "workerNir", "workerAddress",
  "contractType", "position", "hcrLevel",
  "startDate", "endDate", "weeklyHours", "hourlyRate", "probationPeriod",
  "healthInsurance", "medicalService",
];

const FR_HEADERS: Record<keyof DpaeRow, string> = {
  employerName: "Raison sociale employeur",
  employerSiret: "SIRET",
  employerAddress: "Adresse employeur",
  employerCode: "Code APE/NAF",
  workerLastName: "Nom salarié",
  workerFirstName: "Prénom salarié",
  workerBirthDate: "Date de naissance",
  workerBirthPlace: "Lieu de naissance",
  workerNationality: "Nationalité",
  workerNir: "NIR (n° sécurité sociale)",
  workerAddress: "Adresse salarié",
  contractType: "Type de contrat",
  position: "Emploi (fonctions)",
  hcrLevel: "Niveau HCR (échelon)",
  startDate: "Date d'embauche",
  endDate: "Date de fin (CDD)",
  weeklyHours: "Durée hebdo (h)",
  hourlyRate: "Taux horaire brut (€)",
  probationPeriod: "Période d'essai",
  healthInsurance: "Régime maladie",
  medicalService: "Service médecine du travail",
};

function escapeCsv(s: string): string {
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function generateDpaeRows(input: DpaeExportInput): DpaeRow[] {
  const [restaurant] = db.select({
    name: restaurants.name,
    siret: restaurants.siret,
    address: restaurants.address,
  }).from(restaurants).where(eq(restaurants.id, input.restaurantId)).limit(1).all();
  if (!restaurant) throw new Error("Restaurant not found");

  if (input.workerIds.length === 0) return [];
  const memberIds = new Set(listRestaurantMemberUserIds(input.restaurantId, { roles: ["manager", "kitchen", "floor"] }));
  const workerIds = input.workerIds.filter((id) => memberIds.has(id));
  const workers = workerIds.length > 0
    ? db.select({
      id: users.id,
      name: users.name,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      subRoles: users.subRoles,
      dateOfBirth: users.dateOfBirth,
      birthPlace: users.birthPlace,
      nationality: users.nationality,
      nir: users.nir,
      address: users.address,
      contractType: users.contractType,
      hcrLevel: users.hcrLevel,
      startDate: users.startDate,
      contractEndDate: users.contractEndDate,
      contractHours: users.contractHours,
      hourlyRate: users.hourlyRate,
    }).from(users).where(inArray(users.id, workerIds)).all()
    : [];

  const rows: DpaeRow[] = [];
  for (const w of workers) {
    if (w.role === "admin") continue;
    const override = input.perWorker?.[w.id] ?? {};
    const firstName = w.firstName ?? "";
    const lastName = w.lastName ?? w.name;

    let subRoles: string[] = [];
    try { subRoles = w.subRoles ? JSON.parse(w.subRoles) : []; } catch { /* ignore */ }
    const position = subRoles.length > 0
      ? `${w.role === "kitchen" ? "Cuisine" : "Salle"} — ${subRoles.join(", ")}`
      : w.role === "kitchen" ? "Cuisinier" : "Serveur";

    rows.push({
      employerName: restaurant.name,
      employerSiret: restaurant.siret ?? "[SIRET À COMPLÉTER]",
      employerAddress: restaurant.address ?? "",
      employerCode: "5610A",  // Restauration traditionnelle — most common APE for restaurants
      workerLastName: lastName,
      workerFirstName: firstName,
      // Per-export overrides win, then the stored profile fields the worker fills via /my-profile.
      workerBirthDate: override.birthDate ?? w.dateOfBirth ?? "",
      workerBirthPlace: override.birthPlace ?? w.birthPlace ?? "",
      workerNationality: override.nationality ?? w.nationality ?? "FR",
      workerNir: override.nir ?? w.nir ?? "NNA",
      workerAddress: w.address ?? "",
      contractType: w.contractType ?? "CDI",
      position,
      hcrLevel: w.hcrLevel ?? "",
      startDate: w.startDate ?? "",
      endDate: w.contractEndDate ?? "",
      weeklyHours: String(w.contractHours ?? 35),
      hourlyRate: w.hourlyRate != null ? (w.hourlyRate / 100).toFixed(2) : "",
      probationPeriod: w.contractType === "CDI" ? "2 mois" : "1 mois",
      healthInsurance: "Régime général",
      medicalService: "",
    });
  }
  return rows;
}

export function rowsToCsv(rows: DpaeRow[]): string {
  if (rows.length === 0) return "";
  const header = CSV_HEADERS.map(k => escapeCsv(FR_HEADERS[k])).join(";");
  const body = rows.map(r => CSV_HEADERS.map(k => escapeCsv(String(r[k] ?? ""))).join(";")).join("\n");
  // UTF-8 BOM so Excel FR opens it with the right encoding
  return "\uFEFF" + header + "\n" + body + "\n";
}
