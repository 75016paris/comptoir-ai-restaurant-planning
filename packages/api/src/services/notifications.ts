/**
 * Notification service — queues messages in DB and delivers via WhatsApp bot or SMS.
 *
 * Delivery modes:
 * 1. In-chat (default): /notify on the WhatsApp bot → Bernardo posts in the
 *    user's conversation thread (Meta Cloud API under the hood).
 * 2. SMS: OVH SMS API (transactional, e.g. password reset).
 */
import crypto from "node:crypto";
import { db, rawDb } from "../db/connection.js";
import { chatMessages, notifications, openShifts, users, restaurants, restaurantMemberships, services, publishedWeeks } from "../db/schema.js";
import { eq, and, lte, gte, ne, or } from "drizzle-orm";
import { fmtDateUTC, getMonday, parseDateUTC, weekDates } from "../utils/scheduling.js";
import { isUsableDemoChatSecret } from "../utils/demo-secret.js";
import { formatLogMessagePreview, redactSensitiveString, todayInTimeZone } from "@comptoir/shared";
import { columnExists, listAccessibleRestaurants, listSchedulingRosterWorkers } from "./restaurant-context.js";
import { rankReplacementCandidates } from "./replacement-candidates.js";

// ── OVH SMS sender ──
//
// API: POST https://eu.api.ovh.com/1.0/sms/{service}/jobs
// Auth: SHA1("AS+secret+CK+method+url+body+timestamp") → X-Ovh-Signature
// Server timestamp from /1.0/auth/time avoids clock-skew rejections.

const OVH_API_BASE = "https://eu.api.ovh.com/1.0";

function getOvhSmsConfig() {
  const appKey = process.env.OVH_APP_KEY;
  const appSecret = process.env.OVH_APP_SECRET;
  const consumerKey = process.env.OVH_CONSUMER_KEY;
  const serviceName = process.env.OVH_SMS_SERVICE_NAME;
  const sender = process.env.OVH_SMS_SENDER || "Comptoir";
  if (!appKey || !appSecret || !consumerKey || !serviceName) return null;
  return { appKey, appSecret, consumerKey, serviceName, sender };
}

async function ovhSmsSend(to: string, message: string): Promise<boolean> {
  const cfg = getOvhSmsConfig();
  if (!cfg) {
    const preview = formatLogMessagePreview(message.slice(0, 80));
    console.log(`[ovh-sms] (no credentials) → ${redactSensitiveString(to)}: ${preview}...`);
    return false;
  }

  const url = `${OVH_API_BASE}/sms/${cfg.serviceName}/jobs`;
  const body = JSON.stringify({
    message,
    sender: cfg.sender,
    receivers: [to],
    charset: "UTF-8",
    coding: "7bit",
    noStopClause: true, // transactional only — STOP clause not required
    priority: "high",
  });

  const timeRes = await fetch(`${OVH_API_BASE}/auth/time`);
  const timestamp = (await timeRes.text()).trim();

  const toSign = `${cfg.appSecret}+${cfg.consumerKey}+POST+${url}+${body}+${timestamp}`;
  const sig = "$1$" + crypto.createHash("sha1").update(toSign).digest("hex");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Ovh-Application": cfg.appKey,
      "X-Ovh-Consumer": cfg.consumerKey,
      "X-Ovh-Timestamp": timestamp,
      "X-Ovh-Signature": sig,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[ovh-sms] Send failed ${res.status}: ${redactSensitiveString(err)}`);
    return false;
  }
  console.log(`[ovh-sms] Sent to ${redactSensitiveString(to)}`);
  return true;
}

// ── Types ──

export type NotificationType =
  | "service_reminder"
  | "replacement_proposal"
  | "replacement_accepted"
  | "replacement_rejected"
  | "replacement_expired"
  | "schedule_change"
  | "holiday_approved"
  | "holiday_rejected"
  | "holiday_request"
  | "holiday_proposal"
  | "replacement_request"
  | "trial_ending"
  | "payment_failed"
  | "subscription_cancelled"
  | "time_clock_confirm"
  | "open_shift_broadcast"
  | "open_shift_claimed"
  | "open_shift_no_response"
  | "dossier_reminder";

export type Channel = "whatsapp" | "sms";

type WhatsAppTemplateRequest = {
  name: string;
  language?: string;
  body: string[];
  buttonPayloads?: string[];
};

interface QueueParams {
  recipientId: string;
  type: NotificationType;
  message: string;
  channel?: Channel;
  scheduledFor?: string; // ISO datetime, defaults to now
  template?: WhatsAppTemplateRequest;
  ownerId?: string | null;
  restaurantId?: string | null;
}

export function messageWithRestaurantContext(userId: string, restaurantId: string, message: string): string {
  const accessibleRestaurants = notificationContextRestaurants(userId);
  if (accessibleRestaurants.length <= 1 && accessibleRestaurants.some((restaurant) => restaurant.id === restaurantId)) return message;

  const restaurantName = accessibleRestaurants.find((restaurant) => restaurant.id === restaurantId)?.name
    ?? db.select({ name: restaurants.name }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).get()?.name;
  if (!restaurantName) return message;

  return `*${restaurantName}*\n${message}`;
}

function notificationContextRestaurants(userId: string): Array<{ id: string; name: string }> {
  const byId = new Map(listAccessibleRestaurants(userId).map((restaurant) => [restaurant.id, { id: restaurant.id, name: restaurant.name }]));
  if (
    columnExists("worker_share_authorizations", "target_restaurant_id")
    && columnExists("worker_share_authorizations", "owner_id")
    && columnExists("restaurant_memberships", "restaurant_id")
    && columnExists("owner_memberships", "owner_id")
    && columnExists("worker_restaurant_profiles", "restaurant_id")
    && columnExists("restaurants", "owner_id")
  ) {
    const rows = rawDb.query(`
      SELECT target_restaurant.id, target_restaurant.name
      FROM worker_share_authorizations wsa
      INNER JOIN users recipient ON recipient.id = wsa.user_id
      INNER JOIN owner_memberships owner_membership
        ON owner_membership.owner_id = wsa.owner_id
        AND owner_membership.user_id = wsa.user_id
      INNER JOIN restaurant_memberships source_membership
        ON source_membership.restaurant_id = wsa.source_restaurant_id
        AND source_membership.user_id = wsa.user_id
        AND source_membership.role = wsa.role
        AND source_membership.active = 1
      INNER JOIN worker_restaurant_profiles target_profile
        ON target_profile.restaurant_id = wsa.target_restaurant_id
        AND target_profile.user_id = wsa.user_id
      INNER JOIN restaurants target_restaurant ON target_restaurant.id = wsa.target_restaurant_id
      INNER JOIN restaurants source_restaurant ON source_restaurant.id = wsa.source_restaurant_id
      WHERE wsa.user_id = ?
        AND wsa.status = 'accepted'
        AND wsa.worker_consented_at IS NOT NULL
        AND wsa.revoked_at IS NULL
        AND recipient.active = 1
        AND target_restaurant.owner_id = wsa.owner_id
        AND source_restaurant.owner_id = wsa.owner_id
        AND NOT EXISTS (
          SELECT 1
          FROM restaurant_memberships local_membership
          WHERE local_membership.restaurant_id = wsa.target_restaurant_id
            AND local_membership.user_id = wsa.user_id
            AND local_membership.active = 1
        )
    `).all(userId) as Array<{ id: string; name: string }>;
    for (const row of rows) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function withOptionalRestaurantContext(userId: string, restaurantId: string | null | undefined, message: string): string {
  return restaurantId ? messageWithRestaurantContext(userId, restaurantId, message) : message;
}

// ── Queue a notification ──

function ownerIdForRestaurant(restaurantId: string | null | undefined): string | null {
  if (!restaurantId || !columnExists("restaurants", "owner_id")) return null;
  const row = rawDb.query("SELECT owner_id FROM restaurants WHERE id = ?").get(restaurantId) as { owner_id?: string | null } | undefined;
  return row?.owner_id ?? null;
}

export function queueNotification(params: QueueParams): string {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const columns = ["id", "recipient_id", "type", "message", "channel", "status", "scheduled_for"];
  const values: (string | null)[] = [
    id,
    params.recipientId,
    params.type,
    params.message,
    params.channel || "whatsapp",
    "queued",
    params.scheduledFor || now,
  ];
  if (columnExists("notifications", "owner_id")) {
    columns.push("owner_id");
    values.push(params.ownerId ?? ownerIdForRestaurant(params.restaurantId) ?? null);
  }
  if (columnExists("notifications", "restaurant_id")) {
    columns.push("restaurant_id");
    values.push(params.restaurantId ?? null);
  }
  const placeholders = columns.map(() => "?").join(", ");
  rawDb.prepare(`INSERT INTO notifications (${columns.join(", ")}) VALUES (${placeholders})`).run(...values);
  return id;
}

// ── Send a single notification ──

async function sendOne(notifId: string): Promise<boolean> {
  const [notif] = db.select({
    id: notifications.id,
    recipientId: notifications.recipientId,
    message: notifications.message,
    channel: notifications.channel,
    type: notifications.type,
  }).from(notifications).where(eq(notifications.id, notifId)).limit(1).all();

  if (!notif) return false;

  const [recipient] = db.select({ phone: users.phone, name: users.name })
    .from(users).where(eq(users.id, notif.recipientId)).limit(1).all();

  if (!recipient?.phone) {
    db.update(notifications).set({ status: "failed" }).where(eq(notifications.id, notifId)).run();
    console.warn(`[notifications] No phone for recipient ${notif.recipientId}`);
    return false;
  }

  let ok = false;
  if (notif.channel === "whatsapp") {
    // WhatsApp transport is the bot (Meta Cloud API). Retry the bot's /notify;
    // if still unreachable, leave queued for processQueue to try again later.
    ok = await notifyViaBot(notif.recipientId, notif.message, notif.type as NotificationType);
    if (!ok) {
      console.log(`[notifications] [whatsapp] bot unreachable, leaving queued: ${notifId}`);
      return false; // keep status=queued, no DB change
    }
  } else {
    // SMS via OVH
    ok = await ovhSmsSend(recipient.phone, notif.message);
  }

  if (ok) {
    db.update(notifications).set({ status: "sent", sentAt: new Date().toISOString() })
      .where(eq(notifications.id, notifId)).run();
    return true;
  }
  db.update(notifications).set({ status: "failed" }).where(eq(notifications.id, notifId)).run();
  return false;
}

// ── Process all queued notifications that are due ──

export async function processQueue(): Promise<{ sent: number; failed: number }> {
  const now = new Date().toISOString();
  const queued = db.select({ id: notifications.id })
    .from(notifications)
    .where(and(
      eq(notifications.status, "queued"),
      lte(notifications.scheduledFor, now),
    ))
    .all();

  let sent = 0, failed = 0;
  for (const n of queued) {
    const ok = await sendOne(n.id);
    if (ok) sent++; else failed++;
  }
  return { sent, failed };
}

// ── Convenience: queue + send immediately ──

export async function notify(params: QueueParams): Promise<string> {
  // Try in-chat delivery first (via WhatsApp bot)
  // The bot creates its own notification record + chat_messages entry
  const inChatOk = await notifyViaBot(params.recipientId, params.message, params.type, params.template);
  if (inChatOk) {
    // Bot handled everything — no need for API-side notification record
    return "bot-delivered";
  }
  // Fallback: queue + send via legacy Twilio (bot unreachable)
  const id = queueNotification(params);
  await sendOne(id);
  return id;
}

// ── In-chat delivery via WhatsApp bot ──

function currentWhatsappUrl(): string {
  return process.env.WHATSAPP_URL || "http://localhost:3002";
}
function currentDemoChatSecret(): string | undefined {
  return process.env.DEMO_CHAT_SECRET;
}

/**
 * Deliver a notification as a Bernardo in-chat message via the WhatsApp bot.
 * The bot saves to chat_messages (conversation context) + sends via Twilio
 * from the same WhatsApp number (same thread).
 * Returns true if the bot accepted the request, false if unreachable.
 */
async function notifyViaBot(userId: string, message: string, type: NotificationType, template?: WhatsAppTemplateRequest): Promise<boolean> {
  const secret = currentDemoChatSecret();
  if (!isUsableDemoChatSecret(secret)) return false;
  try {
    const res = await fetch(`${currentWhatsappUrl()}/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-demo-secret": secret,
      },
      body: JSON.stringify({ userId, message, type, template }),
    });
    if (!res.ok) {
      console.warn(`[notifications] Bot /notify returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[notifications] Bot unreachable for in-chat delivery: ${err.message}`);
    return false;
  }
}

// ── High-level notification helpers (Bernardo tone) ──

/** Notify a worker about a replacement proposal */
export async function notifyReplacementProposal(targetId: string, requesterName: string, serviceDate: string, restaurantId?: string) {
  const message = `🔄 *${requesterName}* te demande de remplacer son service le ${serviceDate}. Réponds *accepter remplacement* pour confirmer.`;
  return notify({
    recipientId: targetId,
    type: "replacement_proposal",
    message: withOptionalRestaurantContext(targetId, restaurantId, message),
    restaurantId,
  });
}

/** Notify replacement response */
export async function notifyReplacementResponse(requesterId: string, targetName: string, accepted: boolean, restaurantId?: string) {
  const message = `${accepted ? "✅" : "❌"} *${targetName}* a ${accepted ? "accepté" : "refusé"} ta demande de remplacement.`;
  return notify({
    recipientId: requesterId,
    type: accepted ? "replacement_accepted" : "replacement_rejected",
    message: withOptionalRestaurantContext(requesterId, restaurantId, message),
    restaurantId,
  });
}

/** Notify a worker that the admin has proposed leave for them. */
export async function notifyHolidayProposal(workerId: string, startDate: string, endDate: string, restaurantId?: string) {
  const workerName = userName(workerId);
  const message = `📅 Ton employeur te propose des congés du ${startDate} au ${endDate}. Ouvre ton planning pour répondre *oui* ou *non*.`;
  return notify({
    recipientId: workerId,
    type: "holiday_proposal",
    message: withOptionalRestaurantContext(workerId, restaurantId, message),
    restaurantId,
    template: leaveProposalTemplate(workerName, startDate, endDate),
  });
}

/** Notify a worker that the admin has IMPOSED leave (congé imposé — L3141-16).
 *  Not an accept/reject — a done fact. Tone reflects that. */
export async function notifyHolidayImposed(workerId: string, startDate: string, endDate: string, legalReference = "Code du travail art. L3141-16", restaurantId?: string) {
  const message = `📌 Congés imposés du ${startDate} au ${endDate} par ton employeur (${legalReference}). Ces dates sont désormais bloquées dans ton planning.`;
  return notify({
    recipientId: workerId,
    type: "holiday_proposal",
    message: withOptionalRestaurantContext(workerId, restaurantId, message),
    restaurantId,
  });
}

/** Notify holiday review result */
export async function notifyHolidayReview(workerId: string, startDate: string, endDate: string, approved: boolean, restaurantId?: string) {
  const message = `${approved ? "✅" : "❌"} Ton congé du ${startDate} au ${endDate} a été ${approved ? "approuvé" : "refusé"}.`;
  return notify({
    recipientId: workerId,
    type: approved ? "holiday_approved" : "holiday_rejected",
    message: withOptionalRestaurantContext(workerId, restaurantId, message),
    restaurantId,
  });
}

/** Notify a worker that the owner directly added approved leave for them. */
export async function notifyHolidayAssigned(workerId: string, startDate: string, endDate: string, reason?: string | null, restaurantId?: string) {
  const suffix = reason ? ` Motif : ${reason}.` : "";
  const message = `✅ Ton employeur a ajouté un congé du ${startDate} au ${endDate}.${suffix} Ces dates sont désormais bloquées dans ton planning.`;
  return notify({
    recipientId: workerId,
    type: "holiday_approved",
    message: withOptionalRestaurantContext(workerId, restaurantId, message),
    restaurantId,
  });
}

/** Notify schedule change (service moved, created, or deleted) */
export async function notifyScheduleChange(
  workerId: string,
  message: string,
  templateInfo?: { workerName?: string | null; serviceLabel?: string; newSchedule?: string },
  restaurantId?: string,
) {
  const workerName = templateInfo?.workerName ?? userName(workerId);
  return notify({
    recipientId: workerId,
    type: "schedule_change",
    message: withOptionalRestaurantContext(workerId, restaurantId, message),
    restaurantId,
    template: scheduleChangedTemplate(
      workerName,
      templateInfo?.serviceLabel ?? "Planning",
      templateInfo?.newSchedule ?? "mis à jour",
    ),
  });
}

/** Notify admin that a worker requested a holiday */
export async function notifyAdminHolidayRequest(adminId: string, workerName: string, startDate: string, endDate: string, medical = false, restaurantId?: string) {
  const suffix = medical ? " (congé médical — approuvé automatiquement)" : "";
  const message = `📋 *${workerName}* a demandé un congé du ${startDate} au ${endDate}${suffix}. Réponds *demandes* pour gérer les congés en attente.`;
  return notify({
    recipientId: adminId,
    type: "holiday_request",
    message: withOptionalRestaurantContext(adminId, restaurantId, message),
    restaurantId,
  });
}

/** Notify admin that a worker reported unavailable / requested a replacement */
export async function notifyAdminReplacementRequest(adminId: string, workerName: string, serviceDate: string, restaurantId?: string) {
  const message = `🔄 *${workerName}* a signalé une indisponibilité pour le ${serviceDate} (remplacement à organiser).`;
  return notify({
    recipientId: adminId,
    type: "replacement_request",
    message: withOptionalRestaurantContext(adminId, restaurantId, message),
    restaurantId,
  });
}

/** Notify a candidate about a broadcast replacement proposal */
export async function notifyReplacementCandidate(candidateId: string, requesterName: string, serviceDate: string, startTime: string, endTime: string, replacementRequestId: string, restaurantId?: string) {
  const candidateName = userName(candidateId);
  const message = `🔄 *${requesterName}* cherche quelqu'un pour prendre son service du ${serviceDate} (${startTime}-${endTime}). Réponds *accepter remplacement* pour le prendre.`;
  return notify({
    recipientId: candidateId,
    type: "replacement_proposal",
    message: withOptionalRestaurantContext(candidateId, restaurantId, message),
    restaurantId,
    template: replacementRequestTemplate(candidateName, requesterName, "service", serviceDate, startTime, endTime),
  });
}

/** Admin-mediated replacement: notify the admin with a ranked candidate list. */
export async function notifyAdminReplacementCandidates(
  adminId: string,
  requesterName: string,
  serviceDate: string,
  startTime: string,
  endTime: string,
  candidates: Array<{ name: string; reasons: string[] }>,
  restaurantId?: string,
) {
  let message: string;
  if (candidates.length === 0) {
    message = `⚠️ *${requesterName}* ne peut pas venir le ${serviceDate} (${startTime}-${endTime}). Aucun remplaçant disponible — ouvre le dashboard pour annuler ou gérer manuellement.`;
  } else {
    const lines = candidates.map((c, i) => {
      const tag = c.reasons.length > 0 ? `  _${c.reasons.slice(0, 2).join(", ")}_` : "";
      return `${i + 1}. *${c.name}*${tag}`;
    });
    message = `⚠️ *${requesterName}* ne peut pas venir le ${serviceDate} (${startTime}-${endTime}).\n\nRemplaçants possibles :\n${lines.join("\n")}\n\nRéponds avec un nom pour proposer à un seul, *tous* pour broadcaster, ou ouvre le dashboard pour décider.`;
  }
  return notify({
    recipientId: adminId,
    type: "replacement_request",
    message: withOptionalRestaurantContext(adminId, restaurantId, message),
    restaurantId,
  });
}

/** Admin picked this worker to take a colleague's shift — ping them. */
export async function notifyReplacementProposed(
  workerId: string,
  requesterName: string,
  serviceDate: string,
  startTime: string,
  endTime: string,
  role = "service",
  restaurantId?: string,
) {
  const workerName = userName(workerId);
  const message = `🔄 Le gérant te propose de remplacer *${requesterName}* le ${serviceDate} (${startTime}-${endTime}). Réponds *accepter* ou *refuser*.`;
  return notify({
    recipientId: workerId,
    type: "replacement_proposal",
    message: withOptionalRestaurantContext(workerId, restaurantId, message),
    restaurantId,
    template: replacementRequestTemplate(workerName, requesterName, role, serviceDate, startTime, endTime),
  });
}

/** Admin broadcasted the replacement to a list of candidates. */
export async function notifyReplacementBroadcast(
  candidateIds: string[],
  requesterName: string,
  serviceDate: string,
  startTime: string,
  endTime: string,
  role = "service",
  restaurantId?: string,
) {
  await Promise.all(
    candidateIds.map((cid) => {
      const candidateName = userName(cid);
      const message = `🔄 Le gérant cherche quelqu'un pour remplacer *${requesterName}* le ${serviceDate} (${startTime}-${endTime}). Réponds *accepter* pour le prendre (premier arrivé, premier servi).`;
      return notify({
        recipientId: cid,
        type: "replacement_proposal",
        message: withOptionalRestaurantContext(cid, restaurantId, message),
        restaurantId,
        template: replacementRequestTemplate(candidateName, requesterName, role, serviceDate, startTime, endTime),
      }).catch((err) => console.error(`[notify-broadcast] ${cid}`, err));
    }),
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function firstNameOrFallback(name: string | null | undefined): string {
  return firstName(name ?? "").trim() || "là";
}

function userName(userId: string): string | null {
  return db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1).all()[0]?.name ?? null;
}

function roleLabel(role: "kitchen" | "floor" | "manager" | "admin" | string): string {
  if (role === "kitchen") return "cuisine";
  if (role === "floor") return "salle";
  return "service";
}

function formatTemplateDate(date: string): string {
  const d = parseDateUTC(date);
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function scheduleChangedTemplate(workerName: string | null | undefined, serviceLabel: string, newSchedule: string): WhatsAppTemplateRequest {
  return {
    name: "schedule_changed_fr",
    // Meta dashboard currently shows this French template under language "English".
    language: "en",
    body: [firstNameOrFallback(workerName), serviceLabel, newSchedule],
  };
}

function weeklyScheduleTemplate(workerName: string, weekLabel: string): WhatsAppTemplateRequest {
  return {
    name: "weekly_schedule_published_fr",
    language: "fr",
    body: [firstNameOrFallback(workerName), weekLabel],
  };
}

function nextDayReminderTemplate(workerName: string, services: ScheduleServiceRow[]): WhatsAppTemplateRequest | undefined {
  if (services.length === 0) return undefined;
  const first = services[0]!;
  const last = services[services.length - 1]!;
  return {
    name: "next_day_shift_reminder_fr",
    language: "fr",
    body: [
      firstNameOrFallback(workerName),
      services.length === 1 ? roleLabel(first.role) : `${services.length} services`,
      first.startTime,
      last.endTime,
    ],
  };
}

function replacementRequestTemplate(
  workerName: string | null | undefined,
  requesterName: string,
  role: string,
  serviceDate: string,
  startTime: string,
  endTime: string,
): WhatsAppTemplateRequest {
  return {
    name: "replacement_request_fr",
    language: "fr",
    body: [firstNameOrFallback(workerName), requesterName, role, formatTemplateDate(serviceDate), startTime, endTime, "Le gérant"],
    buttonPayloads: ["REPLACEMENT_YES", "REPLACEMENT_NO"],
  };
}

export function missingDocumentTemplate(
  workerName: string | null | undefined,
  restaurantName: string,
  missingSummary: string,
  onboardingUrl: string,
): WhatsAppTemplateRequest {
  return {
    name: "missing_document_fr",
    language: "fr",
    body: [firstNameOrFallback(workerName), restaurantName, missingSummary, onboardingUrl, "72"],
  };
}

export function leaveProposalTemplate(
  workerName: string | null | undefined,
  startDate: string,
  endDate: string,
): WhatsAppTemplateRequest {
  return {
    name: "leave_proposal_fr",
    language: "fr",
    body: [firstNameOrFallback(workerName), "Le gérant", formatTemplateDate(startDate), formatTemplateDate(endDate)],
    buttonPayloads: ["LEAVE_PROPOSAL_YES", "LEAVE_PROPOSAL_NO"],
  };
}

export function timeclockReminderTemplate(
  workerName: string,
  role: "kitchen" | "floor" | string,
  startTime: string,
): WhatsAppTemplateRequest {
  return {
    name: "timeclock_reminder_fr",
    language: "fr",
    body: [firstName(workerName), role === "kitchen" ? "en cuisine" : "en salle", startTime],
  };
}

function openShiftMessage(adminName: string, date: string, startTime: string, endTime: string, role: "kitchen" | "floor", message: string | null): string {
  const roleLabel = role === "kitchen" ? "cuisine" : "salle";
  const extra = message ? ` (${message})` : "";
  return `📣 ${adminName} te propose un service ${roleLabel} le ${date} ${startTime}-${endTime}${extra}. Réponds *oui* / *je prends* pour accepter, ou *non* pour refuser. Je préviens le gérant dès ta réponse.`;
}

async function notifyOpenShiftCandidate(shift: typeof openShifts.$inferSelect, workerId: string): Promise<boolean> {
  const [worker] = db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, workerId)).limit(1).all();
  const [admin] = db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, shift.createdBy)).limit(1).all();
  if (!worker || !admin) return false;

  const role = shift.role as "kitchen" | "floor";
  const roleLabel = role === "kitchen" ? "cuisine" : "salle";
  const message = openShiftMessage(admin.name, shift.date, shift.startTime, shift.endTime, role, shift.message);
  await notify({
    recipientId: worker.id,
    type: "open_shift_broadcast",
    message: messageWithRestaurantContext(worker.id, shift.restaurantId, message),
    restaurantId: shift.restaurantId,
    template: {
      name: "open_shift_request_fr",
      language: "fr",
      body: [firstName(worker.name), admin.name, roleLabel, formatTemplateDate(shift.date), shift.startTime, shift.endTime],
      buttonPayloads: ["OPEN_SHIFT_YES", "OPEN_SHIFT_NO"],
    },
  });

  const solicited = Array.isArray(shift.solicitedCandidateIds) ? shift.solicitedCandidateIds : [];
  const nextSolicited = solicited.includes(worker.id) ? solicited : [...solicited, worker.id];
  db.update(openShifts)
    .set({ solicitedCandidateIds: nextSolicited, lastSolicitedAt: new Date().toISOString() })
    .where(eq(openShifts.id, shift.id))
    .run();
  return true;
}

const OPEN_SHIFT_SOLICITATION_INTERVAL_MS = 5 * 60 * 1000;
const TARGETED_OPEN_SHIFT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

function isOpenShiftCandidateStillEligible(shift: typeof openShifts.$inferSelect, workerId: string): boolean {
  return rankReplacementCandidates({
    restaurantId: shift.restaurantId,
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
    role: shift.role as "kitchen" | "floor",
    requiredSubRoles: Array.isArray(shift.requiredSubRoles) ? shift.requiredSubRoles : [],
  }).some((candidate) => candidate.workerId === workerId);
}

export async function solicitNextOpenShiftCandidate(openShiftId: string, now = new Date()): Promise<"sent" | "waiting" | "done" | "missing"> {
  const [shift] = db.select().from(openShifts).where(eq(openShifts.id, openShiftId)).limit(1).all();
  if (!shift) return "missing";
  if (shift.status !== "open") return "done";

  const serviceStart = new Date(`${shift.date}T${shift.startTime}:00`).getTime();
  if (Number.isFinite(serviceStart) && now.getTime() > serviceStart) {
    db.update(openShifts).set({ status: "expired" }).where(eq(openShifts.id, shift.id)).run();
    return "done";
  }

  const candidateIds = Array.isArray(shift.candidateIds) ? shift.candidateIds : [];
  const rejected = new Set(Array.isArray(shift.rejectedCandidateIds) ? shift.rejectedCandidateIds : []);
  const solicited = new Set(Array.isArray(shift.solicitedCandidateIds) ? shift.solicitedCandidateIds : []);
  const targetedCandidateId = candidateIds.length === 1 ? candidateIds[0] : null;
  if (targetedCandidateId && shift.lastSolicitedAt && solicited.has(targetedCandidateId) && !rejected.has(targetedCandidateId)) {
    if (!isOpenShiftCandidateStillEligible(shift, targetedCandidateId)) {
      db.update(openShifts)
        .set({ status: "expired" })
        .where(and(eq(openShifts.id, shift.id), eq(openShifts.status, "open")))
        .run();
      return "done";
    }
    const last = new Date(shift.lastSolicitedAt).getTime();
    if (Number.isFinite(last)) {
      if (now.getTime() - last < TARGETED_OPEN_SHIFT_RESPONSE_TIMEOUT_MS) return "waiting";
      const updated = db.update(openShifts)
        .set({ status: "expired" })
        .where(and(eq(openShifts.id, shift.id), eq(openShifts.status, "open")))
        .returning({ id: openShifts.id })
        .all();
      if (updated.length === 1) {
        await notifyOpenShiftNoResponse(shift.createdBy, targetedCandidateId, shift.date, shift.startTime, shift.endTime, shift.restaurantId)
          .catch((err) => console.error("[open-shift-timeout] admin notify failed:", err));
      }
      return "done";
    }
  }
  if (shift.lastSolicitedAt && solicited.size > 0) {
    const last = new Date(shift.lastSolicitedAt).getTime();
    if (Number.isFinite(last) && now.getTime() - last < OPEN_SHIFT_SOLICITATION_INTERVAL_MS) return "waiting";
  }

  const nextId = candidateIds.find((id) => !rejected.has(id) && !solicited.has(id) && isOpenShiftCandidateStillEligible(shift, id));
  if (!nextId) {
    db.update(openShifts)
      .set({ status: "expired" })
      .where(and(eq(openShifts.id, shift.id), eq(openShifts.status, "open")))
      .run();
    return "done";
  }
  const notified = await notifyOpenShiftCandidate(shift, nextId);
  if (notified) return "sent";

  db.update(openShifts)
    .set({ status: "expired" })
    .where(and(eq(openShifts.id, shift.id), eq(openShifts.status, "open")))
    .run();
  return "done";
}

export async function processOpenShiftSolicitations(now = new Date()): Promise<{ sent: number; waiting: number; done: number }> {
  const rows = db.select({ id: openShifts.id }).from(openShifts).where(eq(openShifts.status, "open")).all();
  let sent = 0, waiting = 0, done = 0;
  for (const row of rows) {
    const status = await solicitNextOpenShiftCandidate(row.id, now);
    if (status === "sent") sent++;
    else if (status === "waiting") waiting++;
    else done++;
  }
  return { sent, waiting, done };
}

/** Admin posted a vacant slot — sequentially solicit eligible workers, first-come claim wins. */
export async function notifyOpenShiftBroadcast(openShiftId: string) {
  const status = await solicitNextOpenShiftCandidate(openShiftId);
  if (status !== "sent") console.log(`[notify-open-shift] ${openShiftId}: ${status}`);
}

/** Worker claimed an open shift — tell the admin. */
export async function notifyOpenShiftClaimed(
  adminId: string,
  workerName: string,
  date: string,
  startTime: string,
  endTime: string,
  restaurantId?: string,
) {
  const message = `✅ *${workerName}* a pris le service ouvert du ${date} ${startTime}-${endTime}.`;
  return notify({
    recipientId: adminId,
    type: "open_shift_claimed",
    message: restaurantId ? messageWithRestaurantContext(adminId, restaurantId, message) : message,
    restaurantId,
  });
}

/** Targeted open-shift ask timed out — tell the admin proactively. */
export async function notifyOpenShiftNoResponse(
  adminId: string,
  workerId: string,
  date: string,
  startTime: string,
  endTime: string,
  restaurantId?: string,
) {
  const [worker] = db.select({ name: users.name }).from(users).where(eq(users.id, workerId)).limit(1).all();
  const workerName = worker?.name ?? "l'employé";
  const message = `⏱️ Pas de réponse de *${workerName}* après ~10 minutes pour le service du ${date} ${startTime}-${endTime}. Tu peux me demander de proposer le service à quelqu'un d'autre.`;
  return notify({
    recipientId: adminId,
    type: "open_shift_no_response",
    message: restaurantId ? messageWithRestaurantContext(adminId, restaurantId, message) : message,
    restaurantId,
  });
}

/** Admin accepted the absence without finding a replacement — tell the requester. */
export async function notifyReplacementApprovedWithoutReplacement(requesterId: string, serviceDate: string, restaurantId?: string) {
  const message = `✅ Ta demande de remplacement pour le ${serviceDate} a été acceptée sans remplacement. Tu n'es pas attendu sur ce service.`;
  return notify({
    recipientId: requesterId,
    type: "replacement_accepted",
    message: withOptionalRestaurantContext(requesterId, restaurantId, message),
    restaurantId,
  });
}

/** Admin refused or escalation exhausted — tell the requester. */
export async function notifyReplacementCancelled(requesterId: string, serviceDate: string, restaurantId?: string) {
  const message = `❌ Ta demande de remplacement pour le ${serviceDate} a été refusée. Il faudra venir comme prévu, ou en discuter directement avec le gérant.`;
  return notify({
    recipientId: requesterId,
    type: "replacement_rejected",
    message: withOptionalRestaurantContext(requesterId, restaurantId, message),
    restaurantId,
  });
}

/** Send password reset link via SMS. Falls back to console.log without OVH credentials. */
export async function sendPasswordResetSMS(phone: string, resetUrl: string): Promise<void> {
  const body = `Comptoir — Réinitialisez votre mot de passe :\n${resetUrl}\n\nCe lien expire dans 1 heure.`;
  const ok = await ovhSmsSend(phone, body);
  if (ok) console.log(`[password-reset] SMS sent to ${redactSensitiveString(phone)}`);
}

type ScheduleServiceRow = {
  workerId: string;
  workerName: string;
  date: string;
  startTime: string;
  endTime: string;
  role: "kitchen" | "floor" | "manager" | "admin";
};

type PlanningNotificationRosterWorker = ReturnType<typeof listSchedulingRosterWorkers>[number];

type PlanningNotificationReport = {
  restaurants: number;
  publishReminders: number;
  dailyReminders: number;
  weeklyReminders: number;
};

const DAY_LABELS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];

function addDays(dateStr: string, days: number): string {
  const d = parseDateUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtDateUTC(d);
}

function dayLabel(dateStr: string): string {
  const d = parseDateUTC(dateStr);
  return `${DAY_LABELS[d.getUTCDay()]} ${dateStr.slice(8, 10)}/${dateStr.slice(5, 7)}`;
}

function weekRangeLabel(weekStart: string): string {
  const dates = weekDates(weekStart);
  return `${dayLabel(dates[0])} → ${dayLabel(dates[6])}`;
}

function groupByWorker(rows: ScheduleServiceRow[]): Map<string, { name: string; services: ScheduleServiceRow[] }> {
  const grouped = new Map<string, { name: string; services: ScheduleServiceRow[] }>();
  for (const row of rows) {
    if (!grouped.has(row.workerId)) grouped.set(row.workerId, { name: row.workerName, services: [] });
    grouped.get(row.workerId)!.services.push(row);
  }
  return grouped;
}

function formatServices(rows: ScheduleServiceRow[]): string {
  return rows
    .map((s) => `• ${dayLabel(s.date)} : ${s.startTime}–${s.endTime}`)
    .join("\n");
}

function scheduledServicesForRange(restaurantId: string, from: string, to: string): ScheduleServiceRow[] {
  const rosterById = new Map(listSchedulingRosterWorkers(restaurantId, ["kitchen", "floor"]).map((worker) => [worker.id, worker]));
  return db.select({
    workerId: services.workerId,
    workerName: users.name,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    role: services.role,
  })
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(and(
      eq(services.restaurantId, restaurantId),
      gte(services.date, from),
      lte(services.date, to),
      eq(services.status, "scheduled"),
      eq(users.active, true),
      ne(users.role, "admin"),
      ne(users.role, "manager"),
    ))
    .orderBy(services.date, services.startTime)
    .all()
    .filter((row) => {
      const worker = rosterById.get(row.workerId) as PlanningNotificationRosterWorker | undefined;
      if (!worker) return false;
      if (!worker.sharedFromRestaurantId) return true;
      return worker.role === row.role;
    }) as ScheduleServiceRow[];
}

export function adminRecipientsForRestaurant(restaurantId: string, roles: Array<"admin" | "manager"> = ["admin", "manager"]): Array<{ id: string }> {
  const membershipRoleCondition = roles.length === 1
    ? eq(restaurantMemberships.role, roles[0])
    : or(...roles.map((role) => eq(restaurantMemberships.role, role)))!;
  const legacyRoleCondition = roles.length === 1
    ? eq(users.role, roles[0])
    : or(...roles.map((role) => eq(users.role, role)))!;

  if (columnExists("restaurant_memberships", "restaurant_id")) {
    const membershipRows = db.select({ id: users.id })
      .from(restaurantMemberships)
      .innerJoin(users, eq(restaurantMemberships.userId, users.id))
      .where(and(
        eq(restaurantMemberships.restaurantId, restaurantId),
        eq(restaurantMemberships.active, true),
        eq(users.active, true),
        membershipRoleCondition,
      ))
      .all();
    if (membershipRows.length > 0 || columnExists("restaurants", "owner_id")) return membershipRows;
  }

  return db.select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.restaurantId, restaurantId),
      eq(users.active, true),
      legacyRoleCondition,
    ))
    .all();
}

export function isWeekPublished(restaurantId: string, weekStart: string): boolean {
  const row = db.select({ id: publishedWeeks.id })
    .from(publishedWeeks)
    .where(and(
      eq(publishedWeeks.restaurantId, restaurantId),
      eq(publishedWeeks.weekDate, weekStart),
    ))
    .get();
  return !!row;
}

async function notifyGroupedSchedules(
  restaurantId: string,
  rows: ScheduleServiceRow[],
  buildMessage: (workerName: string, services: ScheduleServiceRow[]) => string,
  type: NotificationType = "schedule_change",
  buildTemplate?: (workerName: string, services: ScheduleServiceRow[]) => WhatsAppTemplateRequest | undefined,
): Promise<number> {
  let sent = 0;
  for (const [workerId, group] of groupByWorker(rows)) {
    await notify({
      recipientId: workerId,
      type,
      message: messageWithRestaurantContext(workerId, restaurantId, buildMessage(group.name, group.services)),
      restaurantId,
      template: buildTemplate?.(group.name, group.services),
    }).catch((err) => console.error(`[planning-notify] ${workerId}`, err));
    sent++;
  }
  return sent;
}

export async function notifyWorkersWeekPublished(restaurantId: string, weekStart: string): Promise<number> {
  const rows = scheduledServicesForRange(restaurantId, weekStart, addDays(weekStart, 6));
  const weekLabel = weekRangeLabel(weekStart);
  return notifyGroupedSchedules(restaurantId, rows, (_name, workerServices) => (
    `Ton planning pour la semaine ${weekLabel} est publié.\n\n${formatServices(workerServices)}\n\nRéponds à Bernardo si tu as une question.`
  ), "schedule_change", (workerName) => weeklyScheduleTemplate(workerName, weekLabel));
}

async function notifyWorkersDailyReminder(restaurantId: string, dateStr: string): Promise<number> {
  const weekStart = getMonday(dateStr);
  if (!isWeekPublished(restaurantId, weekStart)) return 0;
  const rows = scheduledServicesForRange(restaurantId, dateStr, dateStr);
  return notifyGroupedSchedules(restaurantId, rows, (_name, workerServices) => (
    `Rappel planning — demain ${dayLabel(dateStr)} :\n\n${formatServices(workerServices)}`
  ), "service_reminder", nextDayReminderTemplate);
}

async function notifyWorkersWeeklyReminder(restaurantId: string, weekStart: string): Promise<number> {
  if (!isWeekPublished(restaurantId, weekStart)) return 0;
  const rows = scheduledServicesForRange(restaurantId, weekStart, addDays(weekStart, 6));
  const weekLabel = weekRangeLabel(weekStart);
  return notifyGroupedSchedules(restaurantId, rows, (_name, workerServices) => (
    `Rappel planning de la semaine ${weekLabel} :\n\n${formatServices(workerServices)}`
  ), "service_reminder", (workerName) => weeklyScheduleTemplate(workerName, weekLabel));
}

async function notifyAdminsToPublishWeek(restaurantId: string, weekStart: string): Promise<number> {
  if (isWeekPublished(restaurantId, weekStart)) return 0;

  const admins = adminRecipientsForRestaurant(restaurantId);
  if (admins.length === 0) return 0;

  const serviceCount = scheduledServicesForRange(restaurantId, weekStart, addDays(weekStart, 6)).length;
  const draftLine = serviceCount > 0
    ? `Le brouillon contient ${serviceCount} service(s). Relis les manquants puis publie.`
    : "Aucun service n'est encore généré : utilise Auto sur le planning, relis, puis publie.";
  const botLine = serviceCount > 0
    ? "Tu peux aussi répondre *publier* ici : Bernardo te demandera confirmation puis enverra le planning aux employés."
    : "Dès qu'un brouillon est prêt, tu pourras répondre *publier* ici pour le communiquer aux employés.";
  const message = `Planning à publier — semaine ${weekRangeLabel(weekStart)}.\n\nPour respecter HCR-L3171-1, ce planning doit être communiqué au moins 15 jours avant le début de la période. ${draftLine}\n\n${botLine}\n\nAprès publication, chaque employé recevra son planning individuel sur WhatsApp.`;

  let sent = 0;
  for (const admin of admins) {
    await notify({ recipientId: admin.id, type: "schedule_change", message: messageWithRestaurantContext(admin.id, restaurantId, message), restaurantId })
      .catch((err) => console.error(`[planning-publish-reminder] ${admin.id}`, err));
    sent++;
  }
  return sent;
}

export async function runPlanningNotificationCycle(now: Date = new Date(), forceSunday = false): Promise<PlanningNotificationReport> {
  const activeRestaurants = db.select({
    id: restaurants.id,
    timezone: restaurants.timezone,
    reminderFrequency: restaurants.reminderFrequency,
  })
    .from(restaurants)
    .where(eq(restaurants.status, "active"))
    .all();

  const report: PlanningNotificationReport = {
    restaurants: activeRestaurants.length,
    publishReminders: 0,
    dailyReminders: 0,
    weeklyReminders: 0,
  };

  for (const r of activeRestaurants) {
    const today = todayInTimeZone(r.timezone, now);
    const tomorrow = addDays(today, 1);
    const day = parseDateUTC(today).getUTCDay();
    const isSunday = day === 0;

    if (forceSunday || isSunday) {
      const dueWeek = getMonday(addDays(today, 15));
      report.publishReminders += await notifyAdminsToPublishWeek(r.id, dueWeek);

      if (r.reminderFrequency === "weekly") {
        const nextWeek = getMonday(tomorrow);
        report.weeklyReminders += await notifyWorkersWeeklyReminder(r.id, nextWeek);
      }
    }

    if (r.reminderFrequency === "daily") {
      report.dailyReminders += await notifyWorkersDailyReminder(r.id, tomorrow);
    }
  }

  return report;
}

/** Queue service reminders for tomorrow's services. Deprecated: use runPlanningNotificationCycle(). */
export function queueServiceReminders(restaurantId: string) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return notifyWorkersDailyReminder(restaurantId, tomorrow.toISOString().split("T")[0]);
}
