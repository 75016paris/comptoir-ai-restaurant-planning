/**
 * Public no-auth API for the magic-link worker onboarding page.
 * The worker lands on /dossier/<token> from their invitation email; the page
 * calls these endpoints with the raw token in the URL — no session, no password.
 *
 * Security model: token is 32 random bytes (hex), unguessable, expires after 72h,
 * scoped to a single user. Endpoints only ever read/write that one user's profile,
 * upload documents into that user's record, and notify their admin.
 */
import { Hono } from "hono";
import { eq, and, isNull, or } from "drizzle-orm";
import { db, rawDb } from "../db/connection.js";
import { users, restaurants, onboardingTokens, documents, adminAlerts } from "../db/schema.js";
import { can, selfUpdateUserSchema, flattenZodError } from "@comptoir/shared";
import {
  InvalidUploadError,
  StorageInactiveError,
  proxyUploadDocument,
} from "../services/document-uploads.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { revokeOnboardingTokensForUser } from "../services/onboarding-tokens.js";
import { hashToken, isHashedToken } from "../utils/token-security.js";
import { columnExists } from "../services/restaurant-context.js";
import { adminRecipientsForRestaurant } from "../services/notifications.js";

const publicOnboardingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: "Trop de requêtes. Réessayez dans 15 minutes." });

export const publicOnboardingRoutes = new Hono();
publicOnboardingRoutes.use("*", publicOnboardingLimiter);

// Worker-editable fields on the public page. `address` is computed from the
// three split parts; we deliberately exclude `email`/`phone` (changing those
// is auth-shaped) and `iban` updates require workers to also confirm via
// authenticated /my-profile if the IBAN format is suspect.
const PUBLIC_FIELDS = [
  "iban", "emergencyContact", "emergencyPhone",
  "addressStreet", "addressPostalCode", "addressCity",
  "dateOfBirth", "birthPlace", "nationality", "nir",
] as const;

const DOCUMENT_TYPES = ["id", "contract", "certificate", "medical", "other"] as const;
type PublicDocumentType = (typeof DOCUMENT_TYPES)[number];
function isPublicDocumentType(value: string): value is PublicDocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

function concatAddress(street: string | null, postal: string | null, city: string | null): string | null {
  const parts = [street?.trim(), [postal?.trim(), city?.trim()].filter(Boolean).join(" ")].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

type PublicOnboardingToken = {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  restaurantId: string | null;
};

function lookupValidToken(rawToken: string): PublicOnboardingToken | null {
  const now = new Date().toISOString();
  const hashedToken = hashToken(rawToken);
  const restaurantSelect = columnExists("onboarding_tokens", "restaurant_id")
    ? "restaurant_id AS restaurantId"
    : "NULL AS restaurantId";
  const row = rawDb.query(`
    SELECT
      id,
      user_id AS userId,
      token,
      expires_at AS expiresAt,
      ${restaurantSelect}
    FROM onboarding_tokens
    WHERE (token = ? OR token = ?) AND expires_at > ?
    LIMIT 1
  `).get(hashedToken, rawToken, now) as PublicOnboardingToken | null;
  if (row && !isHashedToken(row.token)) {
    db.update(onboardingTokens).set({ token: hashedToken }).where(eq(onboardingTokens.id, row.id)).run();
  }
  return row ?? null;
}

function activeMembershipRestaurantIds(userId: string): string[] {
  if (!columnExists("restaurant_memberships", "restaurant_id")) return [];
  const activeCondition = columnExists("restaurant_memberships", "active") ? "AND active = 1" : "";
  const rows = rawDb.query(`
    SELECT restaurant_id AS restaurantId
    FROM restaurant_memberships
    WHERE user_id = ? ${activeCondition}
    ORDER BY restaurant_id
  `).all(userId) as Array<{ restaurantId: string }>;
  return rows.map((row) => row.restaurantId);
}

function resolveTokenRestaurantId(userId: string, tokenRestaurantId: string | null, legacyRestaurantId: string): string | null {
  const membershipRestaurantIds = activeMembershipRestaurantIds(userId);
  if (tokenRestaurantId) {
    if (membershipRestaurantIds.length > 0 && !membershipRestaurantIds.includes(tokenRestaurantId)) return null;
    return tokenRestaurantId;
  }
  if (membershipRestaurantIds.length === 1) return membershipRestaurantIds[0];
  if (membershipRestaurantIds.includes(legacyRestaurantId)) return legacyRestaurantId;
  if (membershipRestaurantIds.length > 1) return null;
  return legacyRestaurantId;
}

// GET /public/onboarding/:token — landing data for the page
publicOnboardingRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const tok = lookupValidToken(token);
  if (!tok) return c.json({ error: "Lien invalide ou expiré" }, 404);

  const [u] = db.select().from(users).where(eq(users.id, tok.userId)).limit(1).all();
  if (!u || !u.active) return c.json({ error: "Compte inactif" }, 404);
  const restaurantId = resolveTokenRestaurantId(tok.userId, tok.restaurantId, u.restaurantId);
  if (!restaurantId) return c.json({ error: "Lien dossier ambigu. Demandez un nouveau lien au gérant." }, 409);
  const [r] = db.select({ name: restaurants.name }).from(restaurants)
    .where(eq(restaurants.id, restaurantId)).limit(1).all();

  // Build the onboarding checklist so the page can show "missing X documents".
  // Computed lazily — checklist module reads its own data and is safe in this scope.
  let checklist: { items: Array<{ key: string; label: string; description: string; mandatory: boolean; status: string; category: string }>; readyForDpae: boolean } = { items: [], readyForDpae: false };
  try {
    const { computeWorkerChecklist } = await import("../services/onboarding-checklist.js");
    const c = computeWorkerChecklist(tok.userId, restaurantId);
    checklist = {
      items: c.items.map(i => ({ key: i.key, label: i.label, description: i.description, mandatory: i.mandatory, status: i.status, category: i.category })),
      readyForDpae: c.readyForDpae,
    };
  } catch { /* checklist optional */ }

  return c.json({
    data: {
      worker: {
        firstName: u.firstName,
        lastName: u.lastName,
        name: u.name,
        email: u.email,
        addressStreet: u.addressStreet,
        addressPostalCode: u.addressPostalCode,
        addressCity: u.addressCity,
        iban: u.iban,
        emergencyContact: u.emergencyContact,
        emergencyPhone: u.emergencyPhone,
        dateOfBirth: u.dateOfBirth,
        birthPlace: u.birthPlace,
        nationality: u.nationality,
        nir: u.nir,
      },
      restaurantName: r?.name ?? "votre restaurant",
      expiresAt: tok.expiresAt,
      checklist,
    },
  });
});

// PATCH /public/onboarding/:token — save worker-completed profile fields.
// Also enqueues an admin alert + email when the worker first reaches the
// "ready for DPAE" threshold (all mandatory fields + docs present).
publicOnboardingRoutes.patch("/:token", async (c) => {
  const token = c.req.param("token");
  const tok = lookupValidToken(token);
  if (!tok) return c.json({ error: "Lien invalide ou expiré" }, 404);
  const [tokenUser] = db.select({ restaurantId: users.restaurantId, active: users.active })
    .from(users)
    .where(eq(users.id, tok.userId))
    .limit(1)
    .all();
  if (!tokenUser || !tokenUser.active) return c.json({ error: "Compte inactif" }, 404);
  const restaurantId = resolveTokenRestaurantId(tok.userId, tok.restaurantId, tokenUser.restaurantId);
  if (!restaurantId) return c.json({ error: "Lien dossier ambigu. Demandez un nouveau lien au gérant." }, 409);

  const body = await c.req.json();
  const parsed = selfUpdateUserSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  const setData: Record<string, unknown> = {};
  for (const k of PUBLIC_FIELDS) {
    if (k in parsed.data) setData[k] = (parsed.data as Record<string, unknown>)[k];
  }
  if (Object.keys(setData).length === 0) {
    return c.json({ error: "Aucun champ à mettre à jour" }, 400);
  }

  // Mirror the three address parts into the legacy single-line `address` column
  // so DPAE export, /staff list, etc. keep working without per-field changes.
  if ("addressStreet" in setData || "addressPostalCode" in setData || "addressCity" in setData) {
    const [u] = db.select({
      addressStreet: users.addressStreet,
      addressPostalCode: users.addressPostalCode,
      addressCity: users.addressCity,
    }).from(users).where(eq(users.id, tok.userId)).limit(1).all();
    const street = ("addressStreet" in setData ? setData.addressStreet : u?.addressStreet) as string | null;
    const postal = ("addressPostalCode" in setData ? setData.addressPostalCode : u?.addressPostalCode) as string | null;
    const city = ("addressCity" in setData ? setData.addressCity : u?.addressCity) as string | null;
    setData.address = concatAddress(street ?? null, postal ?? null, city ?? null);
  }

  db.update(users).set(setData).where(eq(users.id, tok.userId)).run();

  await maybeNotifyDossierCompletion(tok.userId, restaurantId);

  return c.json({ data: { ok: true } });
});

// POST /public/onboarding/:token/documents — multipart upload (proxied via API).
// Browser cannot PUT directly to OVH because the bucket lacks CORS rules for
// the public dossier origin; the API receives the bytes and forwards them.
publicOnboardingRoutes.post("/:token/documents", async (c) => {
  const token = c.req.param("token");
  const tok = lookupValidToken(token);
  if (!tok) return c.json({ error: "Lien invalide ou expiré" }, 404);
  const [u] = db.select({ restaurantId: users.restaurantId, active: users.active })
    .from(users).where(eq(users.id, tok.userId)).limit(1).all();
  if (!u || !u.active) return c.json({ error: "Compte inactif" }, 404);
  const restaurantId = resolveTokenRestaurantId(tok.userId, tok.restaurantId, u.restaurantId);
  if (!restaurantId) return c.json({ error: "Lien dossier ambigu. Demandez un nouveau lien au gérant." }, 409);

  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.json({ error: "Multipart form requis" }, 400);
  const file = form.file;
  const name = typeof form.name === "string" ? form.name : "";
  const type = typeof form.type === "string" ? form.type : "";
  const requirementKey = typeof form.requirementKey === "string" ? form.requirementKey : "";
  if (!(file instanceof File) || !name || !type) {
    return c.json({ error: "Champs requis : file, name, type" }, 400);
  }
  if (!isPublicDocumentType(type)) {
    return c.json({ error: "Type de document invalide" }, 400);
  }

  let storageKey: string;
  let size: number;
  try {
    const uploaded = await proxyUploadDocument({
      restaurantId,
      userId: tok.userId,
      filename: file.name,
      mimeType: file.type,
      body: Buffer.from(await file.arrayBuffer()),
    });
    storageKey = uploaded.storageKey;
    size = uploaded.size;
  } catch (err) {
    if (err instanceof StorageInactiveError) return c.json({ error: "Object storage indisponible" }, 503);
    if (err instanceof InvalidUploadError) return c.json({ error: err.message }, err.status as 400 | 403 | 413);
    throw err;
  }

  const [doc] = db.insert(documents).values({
    userId: tok.userId,
    restaurantId,
    name,
    type,
    filename: file.name,
    mimeType: file.type,
    size,
    data: "",
    storageProvider: "ovh",
    storageKey,
    storageStatus: "ready",
    uploadedBy: tok.userId,
    requirementKey: requirementKey.length > 0 ? requirementKey : null,
  }).returning({
    id: documents.id, name: documents.name, type: documents.type, filename: documents.filename, createdAt: documents.createdAt,
  }).all();

  await notifyDossierDocUploaded(tok.userId, restaurantId, name, type);
  await maybeNotifyDossierCompletion(tok.userId, restaurantId);

  return c.json({ data: doc }, 201);
});

// ── Admin notifications ──

// Per-doc upload nudge: tells admins a worker just dropped a document that
// needs review. Idempotent on UNSEEN alerts so a flurry of uploads collapses
// into one popup; once the admin dismisses, the next upload creates a new one.
async function notifyDossierDocUploaded(workerId: string, restaurantId: string, docLabel: string, docType: string): Promise<void> {
  const [worker] = db.select({ id: users.id, name: users.name })
    .from(users).where(eq(users.id, workerId)).limit(1).all();
  if (!worker) return;

  const recipientIds = adminRecipientsForRestaurant(restaurantId).map((r) => r.id);
  const recipients = recipientIds.map((id) => db.select({ id: users.id, role: users.role, permissions: users.permissions })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .get())
    .filter((r): r is { id: string; role: "admin" | "manager" | "kitchen" | "floor"; permissions: string | null } => !!r)
    .filter((r) => docType !== "medical" || can(r, "MEDICAL_DOC_VIEW"));

  const title = `Document à valider — ${worker.name}`;
  const body = `${worker.name} a déposé "${docLabel}". À valider sur sa fiche.`;
  const actionUrl = `/staff/${worker.id}`;

  for (const r of recipients) {
    const [existing] = db.select({ id: adminAlerts.id }).from(adminAlerts)
      .where(and(
        eq(adminAlerts.recipientId, r.id),
        eq(adminAlerts.workerId, worker.id),
        eq(adminAlerts.type, "dossier_doc_uploaded"),
        isNull(adminAlerts.seenAt),
      )).limit(1).all();
    if (existing) {
      // Refresh title/body so the admin sees the latest doc name.
      db.update(adminAlerts).set({ title, body, createdAt: new Date().toISOString().replace("T", " ").slice(0, 19) })
        .where(eq(adminAlerts.id, existing.id)).run();
      continue;
    }
    db.insert(adminAlerts).values({
      restaurantId,
      recipientId: r.id,
      workerId: worker.id,
      type: "dossier_doc_uploaded",
      title, body, actionUrl,
    }).run();
  }
}

// Fires email + admin_alerts row to all admins/managers in the restaurant when
// the worker's dossier first reaches DPAE-ready (mandatory profile + docs).
// Idempotent: if an unseen alert of this type already exists for this worker,
// we no-op so re-saves don't spam the admin.
async function maybeNotifyDossierCompletion(workerId: string, restaurantId: string): Promise<void> {
  let ready = false;
  try {
    const { computeWorkerChecklist } = await import("../services/onboarding-checklist.js");
    ready = computeWorkerChecklist(workerId, restaurantId).readyForDpae;
  } catch { return; }
  if (!ready) return;

  revokeOnboardingTokensForUser(workerId);

  const [worker] = db.select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, workerId))
    .limit(1)
    .all();
  if (!worker) return;

  // Fan-out to admins + managers in the same restaurant.
  const recipientIds = adminRecipientsForRestaurant(restaurantId).map((r) => r.id);
  const recipients = recipientIds.map((id) => db.select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .get())
    .filter((r): r is { id: string; name: string; email: string } => !!r);
  if (recipients.length === 0) return;

  const [resto] = db.select({ name: restaurants.name }).from(restaurants)
    .where(eq(restaurants.id, restaurantId)).limit(1).all();

  const title = `Dossier complété — ${worker.name}`;
  const body = `${worker.name} a fini de remplir son dossier. Vous pouvez maintenant générer la DPAE.`;
  const actionUrl = `/staff/${worker.id}`;

  for (const r of recipients) {
    // Idempotency check per recipient.
    const [existing] = db.select({ id: adminAlerts.id }).from(adminAlerts)
      .where(and(
        eq(adminAlerts.recipientId, r.id),
        eq(adminAlerts.workerId, worker.id),
        eq(adminAlerts.type, "dossier_completed"),
      )).limit(1).all();
    if (existing) continue;

    db.insert(adminAlerts).values({
      restaurantId,
      recipientId: r.id,
      workerId: worker.id,
      type: "dossier_completed",
      title,
      body,
      actionUrl,
    }).run();
  }

  // Email is best-effort; if SMTP is down we still have the in-app popup.
  try {
    const { sendDossierCompletedEmail } = await import("../services/email.js");
    for (const r of recipients) {
      if (!r.email) continue;
      sendDossierCompletedEmail(r.email, r.name, worker.name, resto?.name || "votre restaurant").catch(() => {});
    }
  } catch (err) {
    console.warn("[dossier-completed] email send skipped:", err);
  }
}
