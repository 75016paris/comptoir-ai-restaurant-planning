/**
 * Cron endpoints — triggered by OS-level cron on the VPS.
 * Guarded by a shared secret in the X-Cron-Secret header; no user auth.
 *
 * VPS setup:
 *   ./scripts/deploy.sh crons
 *
 * The installer manages production + staging entries for monthly digest,
 * auto-fill, planning notifications, open-shift solicitations, backups, billing,
 * and demo reset without overwriting unrelated user crons.
 *
 * Each handler is wrapped by runCron() (Phase A of id:67f8) which writes a
 * cron_runs row per attempt, retries on throw with backoff, and surfaces the
 * result to the Aide-tab dashboard via GET /cron/runs.
 */

import { Hono } from "hono";
import { db } from "../db/connection.js";
import { restaurants, users, emailRecipients, restaurantMemberships } from "../db/schema.js";
import { eq, and, ne, lt, isNull, or, desc } from "drizzle-orm";
import { computeMonthlyDigest, lastCompletedMonth } from "../services/monthly-digest.js";
import { sendMonthlyDigestEmail, sendDossierReminderEmail } from "../services/email.js";
import { observeTrainingOutcomes } from "../services/sub-role-training-cost.js";
import { runCron } from "../services/cron-runner.js";
import { computeWorkerChecklist } from "../services/onboarding-checklist.js";
import { createOnboardingToken } from "../services/onboarding-tokens.js";
import { processOpenShiftSolicitations, runPlanningNotificationCycle, notify, missingDocumentTemplate } from "../services/notifications.js";
import { runAutoFill } from "./autostaffing.js";
import { warmLongHorizonStaffingAnalysisCache } from "../services/staffing-analysis-cache.js";
import { columnExists } from "../services/restaurant-context.js";

export const cronRoutes = new Hono();

/** Build the dossier-reminder missing-items summary used in the WhatsApp template body. */
export function buildDossierMissingSummary(personalInfoNeeded: string[], missingDocLabels: string[]): string {
  const items = [...personalInfoNeeded, ...missingDocLabels];
  return items.length > 3 ? `${items.slice(0, 3).join(", ")}, etc.` : items.join(", ");
}

function cronSecret(): string {
  return process.env.CRON_SECRET || "";
}

function monthlyDigestAdminEmails(restaurantId: string): string[] {
  if (columnExists("restaurant_memberships", "restaurant_id")) {
    return db.select({ email: users.email })
      .from(restaurantMemberships)
      .innerJoin(users, eq(restaurantMemberships.userId, users.id))
      .where(and(
        eq(restaurantMemberships.restaurantId, restaurantId),
        eq(restaurantMemberships.role, "admin"),
        eq(restaurantMemberships.active, true),
        eq(users.active, true),
      ))
      .all()
      .map((admin) => admin.email)
      .filter(Boolean);
  }

  const admin = db.select({ email: users.email })
    .from(users)
    .where(and(eq(users.restaurantId, restaurantId), eq(users.role, "admin")))
    .get();

  return admin?.email ? [admin.email] : [];
}

cronRoutes.use("*", async (c, next) => {
  const secret = cronSecret();
  if (!secret) {
    return c.json({ error: "cron_not_configured" }, 503);
  }
  if (c.req.header("X-Cron-Secret") !== secret) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

// POST /cron/monthly-digest — sends end-of-month recap to every active restaurant's admin
// + opted-in extra recipients. Idempotent-ish: fine to call multiple times on the same
// day; each call re-dispatches. Cron should fire once on the last day of the month.
cronRoutes.post("/monthly-digest", async (c) => {
  const month = (await c.req.json().catch(() => ({}))).month || lastCompletedMonth();

  const outcome = await runCron("monthly-digest", async () => {
    const activeRestos = db.select({ id: restaurants.id, name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.status, "active"))
      .all();

    const report: Array<{ restaurantId: string; sent: number; failed: number }> = [];

    for (const r of activeRestos) {
      const digest = computeMonthlyDigest(r.id, month);
      if (!digest) continue;

      const extras = db.select({ email: emailRecipients.email })
        .from(emailRecipients)
        .where(and(
          eq(emailRecipients.restaurantId, r.id),
          eq(emailRecipients.sendMonthlyDigest, true),
        ))
        .all();

      const targets = new Set<string>();
      for (const email of monthlyDigestAdminEmails(r.id)) targets.add(email);
      for (const e of extras) targets.add(e.email);

      let sent = 0, failed = 0;
      for (const to of targets) {
        const ok = await sendMonthlyDigestEmail(to, digest);
        if (ok) sent++; else failed++;
      }
      report.push({ restaurantId: r.id, sent, failed });
    }

    return { month, restaurants: report };
  });

  if (!outcome.ok) return c.json({ error: outcome.error }, 500);
  return c.json(outcome.result);
});

// POST /cron/training-outcomes — scan applied cross_train / intra_train moves
// from the last 30 days, classify success/failure, and fold each into the
// per-restaurant sub_role_training_costs row. Idempotent — already-observed
// moves are skipped via observed_at IS NOT NULL. Fire nightly.
cronRoutes.post("/training-outcomes", async (c) => {
  const outcome = await runCron("training-outcomes", async () => {
    const activeRestos = db.select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.status, "active"))
      .all();

    const report: Array<{ restaurantId: string; processed: number; successes: number; failures: number }> = [];
    for (const r of activeRestos) {
      const res = observeTrainingOutcomes({ restaurantId: r.id });
      if (res.processed > 0) {
        report.push({ restaurantId: r.id, ...res });
      }
    }
    return { restaurants: report };
  });

  if (!outcome.ok) return c.json({ error: outcome.error }, 500);
  return c.json(outcome.result);
});

// POST /cron/auto-fill — fill upcoming draft weeks according to each restaurant's
// autoStaffingWeeks setting. Runs before publication/reminder notifications.
cronRoutes.post("/auto-fill", async (c) => {
  const outcome = await runCron("auto-fill", async () => runAutoFill());

  if (!outcome.ok) return c.json({ error: outcome.error }, 500);
  return c.json(outcome.result);
});

// POST /cron/staffing-analysis-cache — refresh heavier 12-week staffing
// solves outside the interactive /staff request path.
cronRoutes.post("/staffing-analysis-cache", async (c) => {
  const outcome = await runCron("staffing-analysis-cache", async () => {
    return warmLongHorizonStaffingAnalysisCache();
  });

  if (!outcome.ok) return c.json({ error: outcome.error }, 500);
  return c.json(outcome.result);
});

// POST /cron/planning-notifications — evening planning workflow.
// Daily: sends tomorrow reminders when Notifications = quotidien.
// Sunday: reminds admins/managers to publish the week due for HCR-L3171-1
// and sends next-week worker recaps when Notifications = hebdo.
cronRoutes.post("/planning-notifications", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { forceSunday?: boolean };
  const outcome = await runCron("planning-notifications", async () => {
    return runPlanningNotificationCycle(new Date(), !!body.forceSunday);
  });

  if (!outcome.ok) return c.json({ error: outcome.error }, 500);
  return c.json(outcome.result);
});

// POST /cron/open-shift-solicitations — advance open-shift sequential solicitation.
// Run every 5 minutes in production once Meta templates are approved.
cronRoutes.post("/open-shift-solicitations", async (c) => {
  const outcome = await runCron("open-shift-solicitations", async () => {
    return processOpenShiftSolicitations(new Date());
  });

  if (!outcome.ok) return c.json({ error: outcome.error }, 500);
  return c.json(outcome.result);
});

// POST /cron/dossier-reminders — every 3 days, ping non-admin workers whose
// dossier (DPAE fields + mandatory docs) is still incomplete. Mints a fresh
// 72h magic-link token per ping so the worker doesn't need the original
// invitation email. Throttled by users.last_dossier_reminder_at, so safe to
// fire daily — each worker is only emailed when ≥3 days have elapsed since
// their last reminder. Fire daily at 09:00 (Europe/Paris).
cronRoutes.post("/dossier-reminders", async (c) => {
  const outcome = await runCron("dossier-reminders", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Candidates: active workers (kitchen|floor) with a real email, who either
    // have never been reminded or whose last reminder is older than 3 days.
    const candidates = (columnExists("restaurant_memberships", "restaurant_id") && columnExists("restaurants", "owner_id")
      ? db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        restaurantId: restaurantMemberships.restaurantId,
        restaurantName: restaurants.name,
        address: users.address,
        iban: users.iban,
        emergencyContact: users.emergencyContact,
        emergencyPhone: users.emergencyPhone,
        dateOfBirth: users.dateOfBirth,
        birthPlace: users.birthPlace,
        nationality: users.nationality,
        nir: users.nir,
      })
        .from(restaurantMemberships)
        .innerJoin(users, eq(restaurantMemberships.userId, users.id))
        .innerJoin(restaurants, eq(restaurants.id, restaurantMemberships.restaurantId))
        .where(and(
          eq(restaurantMemberships.active, true),
          ne(restaurantMemberships.role, "admin"),
          ne(restaurantMemberships.role, "manager"),
          eq(users.active, true),
          eq(restaurants.status, "active"),
          // Skip placeholder workers seeded without a real address (worker-*@noemail.local).
          // We match on suffix to avoid blasting fake addresses.
          // Drizzle has no `notLike` here — encode via raw filter below.
          or(isNull(users.lastDossierReminderAt), lt(users.lastDossierReminderAt, threeDaysAgo)),
        ))
        .all()
      : db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        restaurantId: users.restaurantId,
        restaurantName: restaurants.name,
        address: users.address,
        iban: users.iban,
        emergencyContact: users.emergencyContact,
        emergencyPhone: users.emergencyPhone,
        dateOfBirth: users.dateOfBirth,
        birthPlace: users.birthPlace,
        nationality: users.nationality,
        nir: users.nir,
      })
        .from(users)
        .innerJoin(restaurants, eq(restaurants.id, users.restaurantId))
        .where(and(
          eq(users.active, true),
          ne(users.role, "admin"),
          ne(users.role, "manager"),
          eq(restaurants.status, "active"),
          // Skip placeholder workers seeded without a real address (worker-*@noemail.local).
          // We match on suffix to avoid blasting fake addresses.
          // Drizzle has no `notLike` here — encode via raw filter below.
          or(isNull(users.lastDossierReminderAt), lt(users.lastDossierReminderAt, threeDaysAgo)),
        ))
        .all())
      .filter((u) => !!u.email && !u.email.endsWith("@noemail.local"));

    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
    const now = new Date().toISOString();
    let pinged = 0;
    let skippedComplete = 0;
    let failed = 0;

    for (const u of candidates) {
      // Authoritative check: only ping if the dossier is genuinely incomplete.
      let checklist;
      try { checklist = computeWorkerChecklist(u.id, u.restaurantId); } catch { continue; }

      const personalInfoNeeded: string[] = [];
      if (!u.address) personalInfoNeeded.push("Adresse postale");
      if (!u.iban) personalInfoNeeded.push("IBAN");
      if (!u.emergencyContact || !u.emergencyPhone) personalInfoNeeded.push("Contact d'urgence");
      if (!u.dateOfBirth) personalInfoNeeded.push("Date de naissance");
      if (!u.birthPlace) personalInfoNeeded.push("Lieu de naissance");
      if (!u.nationality) personalInfoNeeded.push("Nationalité");

      const missingDocs = checklist.items
        .filter((i) => i.mandatory && i.status === "missing")
        .map((i) => ({ label: i.label, description: i.description }));

      if (personalInfoNeeded.length === 0 && missingDocs.length === 0) {
        skippedComplete++;
        continue;
      }

      // Mint a fresh 72h token and revoke older dossier links for this worker.
      const { token } = createOnboardingToken(u.id, u.restaurantId);
      const onboardingUrl = `${FRONTEND_URL}/dossier/${token}`;

      const emailOk = await sendDossierReminderEmail(
        u.email!,
        u.name,
        u.restaurantName,
        onboardingUrl,
        { personalInfoNeeded, missingDocs },
      );

      const missingSummary = buildDossierMissingSummary(personalInfoNeeded, missingDocs.map((d) => d.label));
      const firstName = u.name.trim().split(/\s+/)[0] || u.name;
      const waOk = await notify({
        recipientId: u.id,
        type: "dossier_reminder",
        message: `📋 Bonjour ${firstName}, ton dossier pour ${u.restaurantName} n'est pas encore complet. Termine via ${onboardingUrl} (lien actif 72 h).`,
        template: missingDocumentTemplate(u.name, u.restaurantName, missingSummary, onboardingUrl),
      }).then(() => true).catch(() => false);

      if (emailOk || waOk) {
        db.update(users).set({ lastDossierReminderAt: now }).where(eq(users.id, u.id)).run();
        pinged++;
      } else {
        failed++;
      }
    }

    return { candidates: candidates.length, pinged, skippedComplete, failed };
  });

  if (!outcome.ok) return c.json({ error: outcome.error }, 500);
  return c.json(outcome.result);
});
