import { rawDb } from "../db/connection.js";
import { columnExists } from "./restaurant-context.js";

export const USER_NOTICE_VERSION = "2026-05-11" as const;

export const OWNER_LEGAL_VERSIONS = {
  terms: "2026-05-11",
  dpa: "2026-05-11",
  privacy: "2026-05-11",
  subprocessors: "2026-05-11",
} as const;

export function hasCurrentOwnerLegalAcceptance(restaurantId: string, ownerId?: string | null): boolean {
  const clauses = [
    "acceptance_type = ?",
    "terms_version = ?",
    "dpa_version = ?",
    "privacy_version = ?",
    "subprocessors_version = ?",
  ];
  const params: string[] = [
    "owner_terms",
    OWNER_LEGAL_VERSIONS.terms,
    OWNER_LEGAL_VERSIONS.dpa,
    OWNER_LEGAL_VERSIONS.privacy,
    OWNER_LEGAL_VERSIONS.subprocessors,
  ];

  if (ownerId && columnExists("legal_acceptances", "owner_id")) {
    clauses.push("(owner_id = ? OR (owner_id IS NULL AND restaurant_id = ?))");
    params.push(ownerId, restaurantId);
  } else {
    clauses.push("restaurant_id = ?");
    params.push(restaurantId);
  }

  const row = rawDb.query(`
    SELECT id
    FROM legal_acceptances
    WHERE ${clauses.join(" AND ")}
    LIMIT 1
  `).get(...params);
  return !!row;
}

export function hasCurrentUserNoticeAcceptance(row: { role: string; userNoticeVersion?: string | null; userNoticeAcceptedAt?: string | null }): boolean {
  if (row.role === "admin") return true;
  return row.userNoticeVersion === USER_NOTICE_VERSION && !!row.userNoticeAcceptedAt;
}

export function ownerLegalState(role: string, restaurantStatus: string | null | undefined, restaurantId: string, ownerId?: string | null, ownerRole?: string | null) {
  const required = (role === "admin" || ownerRole === "owner_admin") && restaurantStatus !== "demo";
  const accepted = !required || hasCurrentOwnerLegalAcceptance(restaurantId, ownerId);
  return {
    ownerLegalAcceptanceRequired: required && !accepted,
    ownerLegalVersions: OWNER_LEGAL_VERSIONS,
  };
}

export function userNoticeState(row: { role: string; ownerRole?: string | null; restaurantStatus?: string | null; userNoticeVersion?: string | null; userNoticeAcceptedAt?: string | null; whatsappOptIn?: boolean | null }) {
  const required = row.role !== "admin" && row.ownerRole !== "owner_admin" && row.restaurantStatus !== "demo";
  const accepted = !required || hasCurrentUserNoticeAcceptance(row);
  return {
    userNoticeAcceptanceRequired: required && !accepted,
    userNoticeVersion: USER_NOTICE_VERSION,
    whatsappOptIn: !!row.whatsappOptIn,
  };
}
