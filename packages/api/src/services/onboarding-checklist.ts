/**
 * Worker onboarding document checklist.
 *
 * Defines the canonical set of required documents per worker profile
 * (role, contract type, nationality) and reports which ones are uploaded,
 * valid, expiring soon, or missing.
 *
 * Sources:
 * - Code du travail L1221-10 (registre du personnel), L1262 (étrangers)
 * - Convention collective HCR (IDCC 1979) — cert. aptitude médicale, HACCP
 * - Règlement Alimentaire Européen 852/2004 (HACCP tous les 3 ans)
 */

import { db } from "../db/connection.js";
import { documents, users } from "../db/schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { listRestaurantMemberUserIds } from "./restaurant-context.js";

export type RequirementKey =
  | "id_card"            // CNI ou passeport (recto-verso)
  | "vital_card"         // Carte vitale ou attestation de droits
  | "residence_proof"    // Justificatif de domicile < 3 mois
  | "rib"                // Relevé d'identité bancaire (IBAN)
  | "work_permit"        // Autorisation de travail — non-UE/EEE uniquement
  | "medical_cert"       // Certificat médical d'aptitude — obligatoire HCR cuisine
  | "haccp_cert"         // Formation HCR hygiène HACCP — valide 3 ans, kitchen uniquement
  | "parental_auth"      // Autorisation parentale — mineurs 16-18 ans
  | "diploma";           // CAP / BTS / diplôme restauration (optionnel, utile pour conventions collectives niveau)

export type RequirementCategory = "identity" | "administrative" | "medical" | "qualification" | "legal";

export type RequirementDef = {
  key: RequirementKey;
  label: string;
  description: string;
  category: RequirementCategory;
  mandatory: boolean;            // blocks contract finalization if missing
  appliesToRoles: Array<"admin" | "kitchen" | "floor">;  // empty = all roles
  requiresIssuedAt: boolean;     // must capture issue date (e.g. residence proof)
  maxAgeMonths?: number;         // reject issuedAt older than N months (residence proof ≤ 3)
  requiresExpiresAt: boolean;    // must capture expiry date
  validityMonths?: number;       // default validity from issue if expires_at not provided (medical ~12, HACCP 36)
};

export const REQUIREMENTS: readonly RequirementDef[] = [
  {
    key: "id_card",
    label: "Pièce d'identité",
    description: "CNI (recto-verso) ou passeport en cours de validité",
    category: "identity",
    mandatory: true,
    appliesToRoles: [],
    requiresIssuedAt: false,
    requiresExpiresAt: true,
  },
  {
    key: "vital_card",
    label: "Carte vitale",
    description: "Carte vitale ou attestation de droits Assurance Maladie",
    category: "administrative",
    mandatory: true,
    appliesToRoles: [],
    requiresIssuedAt: false,
    requiresExpiresAt: false,
  },
  {
    key: "residence_proof",
    label: "Justificatif de domicile",
    description: "Facture EDF/eau/téléphone, quittance de loyer… de moins de 3 mois",
    category: "administrative",
    mandatory: true,
    appliesToRoles: [],
    requiresIssuedAt: true,
    maxAgeMonths: 3,
    requiresExpiresAt: false,
  },
  {
    key: "rib",
    label: "RIB",
    description: "Relevé d'identité bancaire pour le virement du salaire",
    category: "administrative",
    mandatory: true,
    appliesToRoles: [],
    requiresIssuedAt: false,
    requiresExpiresAt: false,
  },
  {
    key: "work_permit",
    label: "Autorisation de travail",
    description: "Titre de séjour ou visa long-séjour autorisant le travail (salariés hors UE/EEE/Suisse)",
    category: "legal",
    mandatory: false, // conditional — set to mandatory when nationality is non-EU
    appliesToRoles: [],
    requiresIssuedAt: false,
    requiresExpiresAt: true,
  },
  {
    key: "medical_cert",
    label: "Certificat médical d'aptitude",
    description: "Aptitude à la manipulation des denrées alimentaires — obligatoire HCR",
    category: "medical",
    mandatory: true,
    appliesToRoles: ["kitchen"],
    requiresIssuedAt: true,
    validityMonths: 24,  // typical 2-year validity depending on convention
    requiresExpiresAt: true,
  },
  {
    key: "haccp_cert",
    label: "Formation HACCP",
    description: "Attestation formation hygiène alimentaire — valide 3 ans (règlement CE 852/2004)",
    category: "qualification",
    mandatory: true,
    appliesToRoles: ["kitchen"],
    requiresIssuedAt: true,
    validityMonths: 36,
    requiresExpiresAt: true,
  },
  {
    key: "parental_auth",
    label: "Autorisation parentale",
    description: "Requise pour les mineurs (16-18 ans) — signée par un représentant légal",
    category: "legal",
    mandatory: false, // conditional — mandatory for minors
    appliesToRoles: [],
    requiresIssuedAt: false,
    requiresExpiresAt: false,
  },
  {
    key: "diploma",
    label: "Diplôme",
    description: "CAP cuisine, BTS hôtellerie, ou autre diplôme pertinent (facultatif mais utile pour le niveau HCR)",
    category: "qualification",
    mandatory: false,
    appliesToRoles: [],
    requiresIssuedAt: false,
    requiresExpiresAt: false,
  },
];

export type ChecklistItemStatus = "missing" | "pending_review" | "uploaded" | "valid" | "expiring_soon" | "expired";

export type ChecklistItem = {
  key: RequirementKey;
  label: string;
  description: string;
  category: RequirementCategory;
  mandatory: boolean;
  status: ChecklistItemStatus;
  documentId?: string;         // if uploaded
  uploadedAt?: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  daysUntilExpiry?: number | null;  // negative if expired
  hint?: string;               // what needs fixing (e.g. "doc de plus de 3 mois", "expire dans 12j")
};

export type WorkerChecklist = {
  workerId: string;
  workerName: string;
  items: ChecklistItem[];
  mandatoryTotal: number;
  mandatoryValid: number;       // uploaded + not expired + within recency rules
  percentComplete: number;
  readyForDpae: boolean;        // all mandatory docs valid + DPAE profile fields present
  missingDpaeFields: string[];  // profile fields legally required for DPAE (URSSAF declaration)
  missingPayrollFields: string[]; // profile fields needed for payroll / internal HR (not DPAE)
  missingProfileFields: string[]; // deprecated: union of DPAE + payroll — kept for back-compat
  expiringWithin30d: number;    // count of docs expiring within 30 days
  pendingReview: number;        // count of uploaded-but-unconfirmed docs (mandatory + optional)
};

const EXPIRY_WARNING_DAYS = 30;

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / (24 * 3600 * 1000));
}

function isRequirementApplicable(def: RequirementDef, workerRole: string): boolean {
  if (def.appliesToRoles.length === 0) return true;
  return def.appliesToRoles.includes(workerRole as any);
}

export function computeWorkerChecklist(workerId: string, restaurantId?: string | null): WorkerChecklist {
  const [worker] = db.select({
    id: users.id,
    name: users.name,
    role: users.role,
    address: users.address,
    iban: users.iban,
    emergencyContact: users.emergencyContact,
    emergencyPhone: users.emergencyPhone,
    dateOfBirth: users.dateOfBirth,
    birthPlace: users.birthPlace,
    nationality: users.nationality,
  }).from(users).where(eq(users.id, workerId)).limit(1).all();
  if (!worker) throw new Error("Worker not found");

  const workerDocs = db.select({
    id: documents.id,
    requirementKey: documents.requirementKey,
    createdAt: documents.createdAt,
    issuedAt: documents.issuedAt,
    expiresAt: documents.expiresAt,
    reviewedAt: documents.reviewedAt,
  }).from(documents).where(restaurantId
    ? and(eq(documents.userId, workerId), eq(documents.restaurantId, restaurantId))
    : eq(documents.userId, workerId)).all();

  const docsByKey = new Map<string, typeof workerDocs[number]>();
  for (const d of workerDocs) {
    if (!d.requirementKey) continue;
    const prev = docsByKey.get(d.requirementKey);
    if (!prev || (d.createdAt > prev.createdAt)) docsByKey.set(d.requirementKey, d);
  }

  const today = new Date().toISOString().slice(0, 10);
  const items: ChecklistItem[] = [];
  let mandatoryTotal = 0, mandatoryValid = 0, expiringSoon = 0, pendingReview = 0;

  for (const def of REQUIREMENTS) {
    if (!isRequirementApplicable(def, worker.role)) continue;

    const base: ChecklistItem = {
      key: def.key,
      label: def.label,
      description: def.description,
      category: def.category,
      mandatory: def.mandatory,
      status: "missing",
    };

    const doc = docsByKey.get(def.key);
    if (!doc) {
      if (def.mandatory) mandatoryTotal++;
      items.push(base);
      continue;
    }

    base.documentId = doc.id;
    base.uploadedAt = doc.createdAt;
    base.issuedAt = doc.issuedAt;
    base.expiresAt = doc.expiresAt;
    base.status = "uploaded";

    // Admin review gate. Worker uploads land as pending_review until an
    // admin/manager confirms via POST /users/:id/documents/:docId/confirm.
    if (!doc.reviewedAt) {
      base.status = "pending_review";
      base.hint = "En attente de validation par le responsable";
      pendingReview++;
      if (def.mandatory) mandatoryTotal++;
      items.push(base);
      continue;
    }

    // Recency check (issuedAt within maxAgeMonths)
    if (def.requiresIssuedAt && def.maxAgeMonths != null && doc.issuedAt) {
      const ageMonths = daysBetween(today, doc.issuedAt) / 30.44;
      if (ageMonths > def.maxAgeMonths) {
        base.status = "expired";
        base.hint = `Document de plus de ${def.maxAgeMonths} mois — demandez un justificatif plus récent`;
      }
    }

    // Expiry check
    if (doc.expiresAt && base.status === "uploaded") {
      const days = daysBetween(doc.expiresAt, today);
      base.daysUntilExpiry = days;
      if (days < 0) {
        base.status = "expired";
        base.hint = `Expiré depuis ${Math.abs(days)} jours`;
      } else if (days <= EXPIRY_WARNING_DAYS) {
        base.status = "expiring_soon";
        base.hint = `Expire dans ${days} jour${days > 1 ? "s" : ""} — renouvellement à prévoir`;
        expiringSoon++;
      } else {
        base.status = "valid";
      }
    } else if (base.status === "uploaded") {
      base.status = "valid";
    }

    if (def.mandatory) {
      mandatoryTotal++;
      if (base.status === "valid" || base.status === "expiring_soon") mandatoryValid++;
    }
    items.push(base);
  }

  // DPAE-required (Code du travail L.1221-10 / R.1221-1): identity + postal address.
  const missingDpaeFields: string[] = [];
  if (!worker.address) missingDpaeFields.push("Adresse postale");
  if (!worker.dateOfBirth) missingDpaeFields.push("Date de naissance");
  if (!worker.birthPlace) missingDpaeFields.push("Lieu de naissance");
  if (!worker.nationality) missingDpaeFields.push("Nationalité");

  // Payroll / internal HR — not part of the URSSAF declaration.
  const missingPayrollFields: string[] = [];
  if (!worker.iban) missingPayrollFields.push("IBAN");
  if (!worker.emergencyContact || !worker.emergencyPhone) missingPayrollFields.push("Contact d'urgence");

  const missingProfileFields = [...missingDpaeFields, ...missingPayrollFields];

  const percentComplete = mandatoryTotal > 0 ? Math.round((mandatoryValid / mandatoryTotal) * 100) : 100;
  const readyForDpae = mandatoryValid === mandatoryTotal && missingDpaeFields.length === 0;

  return {
    workerId: worker.id,
    workerName: worker.name,
    items,
    mandatoryTotal,
    mandatoryValid,
    percentComplete,
    readyForDpae,
    missingDpaeFields,
    missingPayrollFields,
    missingProfileFields,
    expiringWithin30d: expiringSoon,
    pendingReview,
  };
}

/** Restaurant-level view: workers with expiring or expired mandatory docs. */
export function computeExpiringDocsReport(restaurantId: string): Array<{
  workerId: string;
  workerName: string;
  requirementKey: RequirementKey;
  label: string;
  expiresAt: string;
  daysUntilExpiry: number;
  expired: boolean;
}> {
  const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"] });
  const workers = workerIds.length > 0
    ? db.select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(inArray(users.id, workerIds))
      .all()
    : [];

  const alerts: Array<any> = [];
  for (const w of workers) {
    if (w.role === "admin") continue;
    const cl = computeWorkerChecklist(w.id, restaurantId);
    for (const item of cl.items) {
      if ((item.status === "expiring_soon" || item.status === "expired") && item.expiresAt) {
        alerts.push({
          workerId: w.id,
          workerName: w.name,
          requirementKey: item.key,
          label: item.label,
          expiresAt: item.expiresAt,
          daysUntilExpiry: item.daysUntilExpiry ?? 0,
          expired: item.status === "expired",
        });
      }
    }
  }
  alerts.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  return alerts;
}
