import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { db } from "../db/connection.js";
import { users, sessions, restaurants, pendingRegistrations, passwordResetTokens, legalAcceptances, auditLogs, owners, ownerMemberships, restaurantMemberships } from "../db/schema.js";
import { eq, and, gt, or } from "drizzle-orm";
import { verify, hash } from "argon2";
import { randomBytes } from "crypto";
import Stripe from "stripe";
import { requireAuth, requireAdmin, requireOwnerAdmin, type AppEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { InvalidBillingMonthError, reportUsageToStripe, countActiveForOwner, resolveBillingMonth } from "../services/billing.js";
import { queueNotification, sendPasswordResetSMS } from "../services/notifications.js";
import { sendCancellationAlertEmail, sendPasswordResetEmail, sendWelcomeEmail } from "../services/email.js";
import { hashToken, isHashedToken, redactSensitiveString } from "../utils/token-security.js";
import { OWNER_LEGAL_VERSIONS, USER_NOTICE_VERSION, hasCurrentOwnerLegalAcceptance, ownerLegalState, userNoticeState } from "../services/legal-acceptance.js";
import { columnExists, listAccessibleRestaurants, resolveRestaurantContext, resolveSessionRestaurantContext, setSessionActiveRestaurant } from "../services/restaurant-context.js";
import { DEFAULT_CONTRACT_HOURS, DEFAULT_CONTRACT_TYPE } from "@comptoir/shared";

// Rate limiters for sensitive endpoints
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: "Trop de tentatives de connexion. Réessayez dans 15 minutes." });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: "Trop de tentatives d'inscription. Réessayez plus tard." });
const demoLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: "Trop de connexions démo. Réessayez dans quelques minutes." });
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: "Trop de demandes de réinitialisation. Réessayez dans 15 minutes." });

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const STRIPE_BASE_PRICE_ID = process.env.STRIPE_BASE_PRICE_ID || "";
const STRIPE_SEAT_PRICE_ID = process.env.STRIPE_SEAT_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const CANCELLATION_ALERT_EMAIL = process.env.CANCELLATION_ALERT_EMAIL || "info@cosmobot.fr";

export function isProductionLikeRegistrationEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || (!!env.FRONTEND_URL?.startsWith("https://") && !env.FRONTEND_URL.includes("localhost"));
}

export function validateRegistrationBillingConfig(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; bypass: boolean }
  | { ok: false; error: string; missing: string[]; invalid: string[] } {
  if (!isProductionLikeRegistrationEnv(env)) return { ok: true, bypass: env.REGISTRATION_BILLING_BYPASS === "true" };

  const secretKey = env.STRIPE_SECRET_KEY || "";
  const basePriceId = env.STRIPE_BASE_PRICE_ID || "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || "";
  const missing = [
    ["STRIPE_SECRET_KEY", secretKey],
    ["STRIPE_BASE_PRICE_ID", basePriceId],
    ["STRIPE_WEBHOOK_SECRET", webhookSecret],
  ].filter(([, value]) => !value).map(([name]) => name);
  const invalid = [
    secretKey && !/^sk_(test|live)_/.test(secretKey) ? "STRIPE_SECRET_KEY" : "",
    basePriceId && !basePriceId.startsWith("price_") ? "STRIPE_BASE_PRICE_ID" : "",
    webhookSecret && !webhookSecret.startsWith("whsec_") ? "STRIPE_WEBHOOK_SECRET" : "",
  ].filter(Boolean);

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, error: "Stripe registration billing is not configured", missing, invalid };
  }
  return { ok: true, bypass: false };
}

// Known demo accounts — auto-login allowed without password
// Any user in a restaurant with status="demo" can demo-login,
// but we whitelist emails here as an extra safety layer
const DEMO_EMAILS: string[] = [];
const DEMO_LOGIN_OPEN = true; // when true, skip email whitelist — rely on restaurant.status === "demo"

export const authRoutes = new Hono<AppEnv>();

function requestIp(c: any): string | null {
  return (c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || null);
}

function createSession(userId: string, c: any) {
  const sessionId = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  db.insert(sessions)
    .values({ id: sessionId, userId, expiresAt })
    .run();

  const isProduction = !!process.env.FRONTEND_URL?.startsWith("https");
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isProduction,
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });

  return sessionId;
}

// POST /auth/login
authRoutes.post("/login", loginLimiter, async (c) => {
  const { email, password } = await c.req.json();

  const [user] = db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all();

  if (!user) {
    return c.json({ error: "Identifiants invalides" }, 401);
  }

  if (user.active === false) {
    return c.json({ error: "Ce compte a été désactivé. Contactez votre responsable." }, 403);
  }

  const valid = await verify(user.passwordHash, password);
  if (!valid) {
    return c.json({ error: "Identifiants invalides" }, 401);
  }

  const sessionId = createSession(user.id, c);

  const restaurantContext = resolveSessionRestaurantContext(user.id, user.restaurantId, sessionId);
  if (!restaurantContext) {
    return c.json({ error: "Restaurant inaccessible" }, 403);
  }

  return c.json({
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: restaurantContext.role,
      phone: user.phone,
      ownerId: restaurantContext.ownerId,
      ownerRole: restaurantContext.ownerRole,
      activeRestaurantId: restaurantContext.restaurantId,
      restaurantId: restaurantContext.restaurantId,
      restaurantName: restaurantContext.name,
      restaurantStatus: restaurantContext.status,
      restaurantTimezone: restaurantContext.timezone,
      mustChangePassword: user.mustChangePassword,
      onboardingCompletedAt: restaurantContext.onboardingCompletedAt,
      permissions: restaurantContext.permissions ?? user.permissions,
      restaurants: listAccessibleRestaurants(user.id),
      ...ownerLegalState(restaurantContext.role, restaurantContext.status, restaurantContext.restaurantId, restaurantContext.ownerId, restaurantContext.ownerRole),
      ...userNoticeState({ role: restaurantContext.role, ownerRole: restaurantContext.ownerRole, restaurantStatus: restaurantContext.status, userNoticeVersion: user.userNoticeVersion, userNoticeAcceptedAt: user.userNoticeAcceptedAt, whatsappOptIn: user.whatsappOptIn }),
    },
  });
});

// POST /auth/demo-login — auto-login for demo accounts (no password)
authRoutes.post("/demo-login", demoLoginLimiter, async (c) => {
  const { email } = await c.req.json();

  if (!DEMO_LOGIN_OPEN && !DEMO_EMAILS.includes(email)) {
    return c.json({ error: "Compte démo non trouvé" }, 403);
  }

  const [user] = db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all();

  if (!user) {
    return c.json({ error: "Compte démo non disponible" }, 404);
  }

  const restaurantContext = resolveRestaurantContext(user.id, user.restaurantId) ?? resolveRestaurantContext(user.id);
  if (!restaurantContext || restaurantContext.status !== "demo") {
    return c.json({ error: "Compte démo non disponible" }, 403);
  }
  createSession(user.id, c);

  return c.json({
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: restaurantContext.role,
      phone: user.phone,
      ownerId: restaurantContext.ownerId,
      ownerRole: restaurantContext.ownerRole,
      activeRestaurantId: restaurantContext.restaurantId,
      restaurantId: restaurantContext.restaurantId,
      restaurantName: restaurantContext.name,
      restaurantStatus: restaurantContext.status,
      restaurantTimezone: restaurantContext.timezone,
      mustChangePassword: user.mustChangePassword,
      onboardingCompletedAt: restaurantContext.onboardingCompletedAt,
      permissions: restaurantContext.permissions ?? user.permissions,
      restaurants: listAccessibleRestaurants(user.id),
      ...ownerLegalState(restaurantContext.role, restaurantContext.status, restaurantContext.restaurantId, restaurantContext.ownerId, restaurantContext.ownerRole),
      ...userNoticeState({ role: restaurantContext.role, ownerRole: restaurantContext.ownerRole, restaurantStatus: restaurantContext.status, userNoticeVersion: user.userNoticeVersion, userNoticeAcceptedAt: user.userNoticeAcceptedAt, whatsappOptIn: user.whatsappOptIn }),
    },
  });
});

// POST /auth/register — create pending registration + Stripe checkout
authRoutes.post("/register", registerLimiter, async (c) => {
  const { restaurantName, adminName, email, phone, password } = await c.req.json();

  // Validate required fields (restaurantName captured later in onboarding step 1)
  if (!adminName || !email || !phone || !password) {
    return c.json({ error: "Tous les champs sont requis" }, 400);
  }
  const effectiveRestaurantName = (restaurantName && typeof restaurantName === "string" && restaurantName.trim()) || "Mon restaurant";
  if (password.length < 8) {
    return c.json({ error: "Le mot de passe doit contenir au moins 8 caractères" }, 400);
  }

  const billingConfig = validateRegistrationBillingConfig();
  if (!billingConfig.ok) {
    console.error("[stripe] Registration blocked: billing config invalid", {
      missing: billingConfig.missing,
      invalid: billingConfig.invalid,
    });
    return c.json({ error: "Inscription temporairement indisponible" }, 503);
  }

  // Check email not already taken
  const [existingEmail] = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all();

  if (existingEmail) {
    return c.json({ error: "Cet e-mail est déjà utilisé" }, 409);
  }

  // Clean up stale pending registration with same email (ST-02)
  const [existingPending] = db
    .select({ id: pendingRegistrations.id })
    .from(pendingRegistrations)
    .where(eq(pendingRegistrations.email, email))
    .limit(1)
    .all();
  if (existingPending) {
    db.delete(pendingRegistrations).where(eq(pendingRegistrations.id, existingPending.id)).run();
  }

  // Check phone not already used by another admin (trial abuse prevention)
  const [existingPhone] = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, phone), eq(users.role, "admin")))
    .limit(1)
    .all();

  if (existingPhone) {
    return c.json({ error: "Ce numéro de téléphone est déjà associé à un compte" }, 409);
  }

  const passwordHash = await hash(password);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Create pending registration
  const [pending] = db
    .insert(pendingRegistrations)
    .values({
      restaurantName: effectiveRestaurantName,
      adminName,
      email,
      phone,
      passwordHash,
      expiresAt,
    })
    .returning()
    .all();

  // If Stripe is configured, create checkout session
  if (stripe && STRIPE_BASE_PRICE_ID) {
    try {
      const TRIAL_DAYS = 60; // 2-month free trial

      const lineItems: { price: string; quantity?: number }[] = [
        { price: STRIPE_BASE_PRICE_ID, quantity: 1 },
      ];
      // Metered seat price — no quantity (reported via meter events)
      if (STRIPE_SEAT_PRICE_ID) {
        lineItems.push({ price: STRIPE_SEAT_PRICE_ID });
      }

      // Stripe Tax is opt-in via STRIPE_TAX_ENABLED. Off until the seller has a
      // TVA intracommunautaire number AND Tax is activated in the dashboard;
      // turning it on without dashboard config breaks checkout creation.
      const taxEnabled = process.env.STRIPE_TAX_ENABLED === "true";

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: lineItems,
        customer_email: email,
        metadata: { pendingRegistrationId: pending.id },
        subscription_data: {
          trial_period_days: TRIAL_DAYS,
        },
        ...(taxEnabled
          ? {
              automatic_tax: { enabled: true },
              tax_id_collection: { enabled: true },
              billing_address_collection: "required" as const,
            }
          : {}),
        success_url: `${FRONTEND_URL}/?registered=1`,
        cancel_url: `${FRONTEND_URL}/register?cancelled=1`,
      });

      // Store stripe session ID
      db.update(pendingRegistrations)
        .set({ stripeSessionId: session.id })
        .where(eq(pendingRegistrations.id, pending.id))
        .run();

      return c.json({ data: { url: session.url } });
    } catch (err: any) {
      console.error("Stripe error:", redactSensitiveString(err.message));
      return c.json({ error: "Erreur de paiement. Réessayez." }, 500);
    }
  }

  // No Stripe configured — create account directly only in explicit non-production bypass mode.
  if (!billingConfig.bypass) {
    return c.json({ error: "Inscription temporairement indisponible" }, 503);
  }
  console.log("⚠️  Registration billing bypass enabled — creating account directly");
  const account = activateRegistration(pending.id);
  if (!account) {
    return c.json({ error: "Erreur lors de la création du compte" }, 500);
  }

  sendWelcomeEmail(account.email, account.adminName, account.restaurantName).catch((err) =>
    console.error(`[welcome-email] Failed for ${redactSensitiveString(account.email)}:`, redactSensitiveString(err.message))
  );

  return c.json({ data: { url: `${FRONTEND_URL}/?registered=1` } });
});

// POST /auth/stripe-webhook — handle Stripe events
authRoutes.post("/stripe-webhook", async (c) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: "Stripe not configured" }, 500);
  }

  const sig = c.req.header("stripe-signature");
  if (!sig) {
    return c.json({ error: "Missing signature" }, 400);
  }

  const rawBody = await c.req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error("Webhook signature verification failed:", redactSensitiveString(err.message));
    return c.json({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const pendingId = session.metadata?.pendingRegistrationId;
        const resubscribeRestaurantId = session.metadata?.restaurantId;

        if (resubscribeRestaurantId) {
          // Resubscribe flow — link the new subscription to the existing restaurant.
          const [restaurant] = db.select({ ownerId: restaurants.ownerId })
            .from(restaurants)
            .where(eq(restaurants.id, resubscribeRestaurantId))
            .limit(1)
            .all();
          if (restaurant?.ownerId) {
            db.update(owners)
              .set({
                stripeSubscriptionId: session.subscription as string,
                subscriptionStatus: "active",
              })
              .where(eq(owners.id, restaurant.ownerId))
              .run();
          }
          db.update(restaurants)
            .set({
              stripeSubscriptionId: session.subscription as string,
              subscriptionStatus: "active",
            })
            .where(eq(restaurants.id, resubscribeRestaurantId))
            .run();
          console.log(`✓ Resubscribe completed for restaurant ${resubscribeRestaurantId}`);
          break;
        }

        if (!pendingId) {
          console.error("Webhook: no pendingRegistrationId or restaurantId in metadata");
          break;
        }

        const account = activateRegistration(pendingId, {
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: session.subscription as string,
        });

        if (!account) {
          console.error("Webhook: failed to activate registration", pendingId);
        } else {
          console.log(`✓ Account activated: ${redactSensitiveString(account.email)} (${account.restaurantName})`);
          sendWelcomeEmail(account.email, account.adminName, account.restaurantName).catch((err) =>
            console.error(`[welcome-email] Failed for ${redactSensitiveString(account.email)}:`, redactSensitiveString(err.message))
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        syncSubscriptionStatus(sub);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        syncSubscriptionStatus(sub);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        if (customerId) {
          syncCustomerSubscriptionStatus(customerId, "past_due");
          notifyBillingEvent(
            customerId,
            "payment_failed",
            (name) =>
              `Le paiement de votre abonnement Comptoir pour ${name} a échoué. Mettez à jour vos informations de paiement dans votre espace facturation pour éviter une suspension.`
          );
          console.log(`⚠ Payment failed for customer ${customerId}`);
        }
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as any;
        const pendingId = session.metadata?.pendingRegistrationId;
        if (pendingId) {
          db.delete(pendingRegistrations)
            .where(eq(pendingRegistrations.id, pendingId))
            .run();
          console.log(`🧹 Cleaned up expired checkout for pending registration ${pendingId}`);
        }
        break;
      }

      case "invoice.payment_action_required": {
        const invoice = event.data.object as any;
        const customerId = invoice.customer as string;
        if (customerId) {
          notifyBillingEvent(
            customerId,
            "payment_failed",
            (name) =>
              `Votre paiement Comptoir pour ${name} nécessite une confirmation de votre banque (3D Secure). Ouvrez votre espace facturation pour valider la transaction.`
          );
          console.warn(`⚠ Payment action required for customer ${customerId} — 3D Secure or SCA may be needed`);
        }
        break;
      }

      case "customer.subscription.trial_will_end": {
        const sub = event.data.object as any;
        const customerId = sub.customer as string;
        const restaurant = primaryBillingRestaurantForCustomer(customerId);
        if (restaurant) {
          const [admin] = billingAdminRecipientsForRestaurant(restaurant.id);
          if (admin) {
            queueNotification({
              recipientId: admin.id,
              type: "trial_ending",
              channel: "whatsapp",
              message: `Votre période d'essai pour ${restaurant.name} se termine bientôt. Pensez à mettre à jour vos informations de paiement.`,
              scheduledFor: new Date().toISOString(),
              restaurantId: restaurant.id,
            });
            console.log(`✉ Trial ending notification queued for restaurant ${restaurant.name}`);
          }
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        if (customerId) {
          syncCustomerSubscriptionStatus(customerId, "active");
          console.log(`✓ Payment succeeded for customer ${customerId}`);
        }
        break;
      }

      default:
        console.log(`Unhandled webhook event: ${event.type}`);
    }
  } catch (err) {
    console.error(`Stripe webhook handler error for event ${event.type}:`, err);
    // Return 200 to prevent Stripe from retrying a permanently failing event
  }

  return c.json({ received: true });
});

// GET /auth/billing — subscription info for current admin
authRoutes.get("/billing", requireAuth, requireOwnerAdmin, async (c) => {
  const user = c.get("user");

  const [owner] = db
    .select({
      subscriptionStatus: owners.subscriptionStatus,
      subscriptionPeriodEnd: owners.subscriptionPeriodEnd,
      trialEndsAt: owners.trialEndsAt,
      stripeCustomerId: owners.stripeCustomerId,
      stripeSubscriptionId: owners.stripeSubscriptionId,
      cancelAt: owners.cancelAt,
    })
    .from(owners)
    .where(eq(owners.id, user.ownerId))
    .limit(1)
    .all();

  if (!owner) {
    return c.json({ error: "Owner not found" }, 404);
  }

  return c.json({ data: { status: user.restaurantStatus, ...owner } });
});

// POST /auth/billing/portal — create Stripe billing portal session
authRoutes.post("/billing/portal", requireAuth, requireOwnerAdmin, async (c) => {
  if (!stripe) {
    return c.json({ error: "Stripe not configured" }, 500);
  }

  const user = c.get("user");

  const [owner] = db
    .select({ stripeCustomerId: owners.stripeCustomerId })
    .from(owners)
    .where(eq(owners.id, user.ownerId))
    .limit(1)
    .all();

  if (!owner?.stripeCustomerId) {
    return c.json({ error: "No billing account linked" }, 400);
  }

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: owner.stripeCustomerId,
      return_url: `${FRONTEND_URL}/preferences`,
    });

    return c.json({ data: { url: portalSession.url } });
  } catch (err) {
    console.error("Stripe billing portal error:", err);
    return c.json({ error: "Impossible de créer la session de facturation. Réessayez." }, 500);
  }
});

// POST /auth/billing/resubscribe — create a checkout session for an existing
// customer whose subscription is cancelled or unpaid. Returns a Stripe-hosted
// checkout URL that, on success, fires checkout.session.completed → webhook
// updates the restaurant's stripeSubscriptionId and status.
authRoutes.post("/billing/resubscribe", requireAuth, requireOwnerAdmin, async (c) => {
  if (!stripe || !STRIPE_BASE_PRICE_ID) {
    return c.json({ error: "Stripe not configured" }, 500);
  }

  const user = c.get("user");
  const restaurantId = user.activeRestaurantId;

  const [owner] = db
    .select({
      id: owners.id,
      stripeCustomerId: owners.stripeCustomerId,
      subscriptionStatus: owners.subscriptionStatus,
    })
    .from(owners)
    .where(eq(owners.id, user.ownerId))
    .limit(1)
    .all();

  if (!owner?.stripeCustomerId) {
    return c.json({ error: "No billing account linked" }, 400);
  }
  if (owner.subscriptionStatus !== "cancelled" && owner.subscriptionStatus !== "unpaid") {
    return c.json({ error: "Subscription is not in a resumable state" }, 400);
  }

  const lineItems: { price: string; quantity?: number }[] = [
    { price: STRIPE_BASE_PRICE_ID, quantity: 1 },
  ];
  if (STRIPE_SEAT_PRICE_ID) {
    lineItems.push({ price: STRIPE_SEAT_PRICE_ID });
  }

  try {
    const taxEnabled = process.env.STRIPE_TAX_ENABLED === "true";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: lineItems,
      customer: owner.stripeCustomerId,
      metadata: { ownerId: owner.id, restaurantId },
      ...(taxEnabled
        ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } }
        : {}),
      success_url: `${FRONTEND_URL}/preferences?resubscribed=1`,
      cancel_url: `${FRONTEND_URL}/preferences`,
    });
    return c.json({ data: { url: session.url } });
  } catch (err: any) {
    console.error("Stripe resubscribe error:", redactSensitiveString(err.message));
    return c.json({ error: "Erreur de paiement. Réessayez." }, 500);
  }
});

// POST /auth/billing/report-usage — report active employees to Stripe (cron or manual)
authRoutes.post("/billing/report-usage", async (c) => {
  // Secured by a simple bearer token (for cron), not session auth
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { month } = await c.req.json().catch(() => ({ month: undefined }));
  try {
    const result = await reportUsageToStripe(typeof month === "string" ? month : undefined);
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof InvalidBillingMonthError) {
      return c.json({ error: "Mois de facturation invalide. Format attendu: YYYY-MM." }, 400);
    }
    throw err;
  }
});

// GET /auth/billing/active-employees — preview active count (admin only)
authRoutes.get("/billing/active-employees", requireAuth, requireOwnerAdmin, async (c) => {
  const month = c.req.query("month");
  const user = c.get("user");

  let targetMonth: string;
  try {
    targetMonth = resolveBillingMonth(month);
  } catch (err) {
    if (err instanceof InvalidBillingMonthError) {
      return c.json({ error: "Mois de facturation invalide. Format attendu: YYYY-MM." }, 400);
    }
    throw err;
  }

  const result = countActiveForOwner(user.ownerId, targetMonth);

  return c.json({
    data: {
      month: targetMonth,
      activeCount: result.activeCount,
      workers: result.workers,
      restaurants: result.restaurants,
      estimatedCost: 19 + result.activeCount * 3,
    },
  });
});

// POST /auth/forgot-password
authRoutes.post("/forgot-password", passwordResetLimiter, async (c) => {
  const { email } = await c.req.json();

  if (!email) {
    return c.json({ error: "E-mail requis" }, 400);
  }

  // Always return success to prevent email enumeration
  const [user] = db
    .select({ id: users.id, name: users.name, phone: users.phone })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all();

  if (user) {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.insert(passwordResetTokens)
      .values({ userId: user.id, token: hashToken(token), expiresAt })
      .run();

    const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`;

    // Send reset link via email (primary), SMS as fallback
    sendPasswordResetEmail(email, user.name, resetUrl).then((sent) => {
      if (!sent) {
        // Email not configured or failed — fall back to SMS
        sendPasswordResetSMS(user.phone, resetUrl).catch((err) =>
          console.error(`[password-reset] SMS send failed for ${redactSensitiveString(email)}:`, redactSensitiveString(err.message))
        );
      }
    }).catch((err) => {
      console.error(`[password-reset] Email failed for ${redactSensitiveString(email)}:`, redactSensitiveString(err.message));
      sendPasswordResetSMS(user.phone, resetUrl).catch(() => {});
    });
  }

  return c.json({ data: { ok: true } });
});

// POST /auth/reset-password
authRoutes.post("/reset-password", passwordResetLimiter, async (c) => {
  const { token, password } = await c.req.json();

  if (!token || !password) {
    return c.json({ error: "Token et mot de passe requis" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "Le mot de passe doit contenir au moins 8 caractères" }, 400);
  }

  const hashedToken = hashToken(token);
  const [resetToken] = db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        or(eq(passwordResetTokens.token, hashedToken), eq(passwordResetTokens.token, token))!,
        eq(passwordResetTokens.used, false),
        gt(passwordResetTokens.expiresAt, new Date().toISOString())
      )
    )
    .limit(1)
    .all();

  if (!resetToken) {
    return c.json({ error: "Lien expiré ou invalide. Demandez un nouveau lien." }, 400);
  }
  if (!isHashedToken(resetToken.token)) {
    db.update(passwordResetTokens).set({ token: hashedToken }).where(eq(passwordResetTokens.id, resetToken.id)).run();
  }

  const passwordHash = await hash(password);

  db.update(users)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(users.id, resetToken.userId))
    .run();

  db.update(passwordResetTokens)
    .set({ used: true })
    .where(eq(passwordResetTokens.id, resetToken.id))
    .run();

  // Invalidate all existing sessions for this user (BG-05)
  db.delete(sessions).where(eq(sessions.userId, resetToken.userId)).run();

  return c.json({ data: { ok: true } });
});

// POST /auth/logout
authRoutes.post("/logout", async (c) => {
  const sessionId = getCookie(c, "session");
  if (sessionId) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  deleteCookie(c, "session");
  return c.json({ data: { ok: true } });
});

// GET /auth/me
authRoutes.get("/me", async (c) => {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ data: null });
  }

  const result = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      phone: users.phone,
      restaurantId: users.restaurantId,
      mustChangePassword: users.mustChangePassword,
      permissions: users.permissions,
      userNoticeVersion: users.userNoticeVersion,
      userNoticeAcceptedAt: users.userNoticeAcceptedAt,
      whatsappOptIn: users.whatsappOptIn,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, new Date().toISOString())
      )
    )
    .limit(1)
    .all();

  if (result.length === 0) {
    return c.json({ data: null });
  }

  const row = result[0];
  const restaurantContext = resolveSessionRestaurantContext(row.id, row.restaurantId, sessionId);
  if (!restaurantContext) {
    return c.json({ data: null });
  }
  const restaurantsForUser = listAccessibleRestaurants(row.id);
  const activeRow = {
    ...row,
    role: restaurantContext.role,
    restaurantId: restaurantContext.restaurantId,
    restaurantName: restaurantContext.name,
    restaurantStatus: restaurantContext.status,
    restaurantTimezone: restaurantContext.timezone,
    onboardingCompletedAt: restaurantContext.onboardingCompletedAt,
    permissions: restaurantContext.permissions ?? row.permissions,
    ownerRole: restaurantContext.ownerRole,
  };

  return c.json({
    data: {
      ...activeRow,
      ownerId: restaurantContext.ownerId,
      ownerRole: restaurantContext.ownerRole,
      activeRestaurantId: restaurantContext.restaurantId,
      restaurants: restaurantsForUser,
      ...ownerLegalState(activeRow.role!, activeRow.restaurantStatus, activeRow.restaurantId, restaurantContext.ownerId, restaurantContext.ownerRole),
      ...userNoticeState(activeRow),
    },
  });
});

// GET /auth/restaurants — restaurants available to the current user
authRoutes.get("/restaurants", requireAuth, async (c) => {
  const user = c.get("user");
  return c.json({
    data: {
      activeRestaurantId: user.activeRestaurantId,
      restaurants: listAccessibleRestaurants(user.id),
    },
  });
});

// POST /auth/active-restaurant — switch active restaurant for this session
authRoutes.post("/active-restaurant", requireAuth, async (c) => {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const restaurantId = typeof body.restaurantId === "string" ? body.restaurantId : "";
  if (!restaurantId) {
    return c.json({ error: "restaurantId requis" }, 400);
  }

  const user = c.get("user");
  const restaurantContext = listAccessibleRestaurants(user.id)
    .find((restaurant) => restaurant.id === restaurantId);
  if (!restaurantContext) {
    return c.json({ error: "Restaurant inaccessible" }, 403);
  }

  try {
    setSessionActiveRestaurant(sessionId, restaurantId);
  } catch {
    return c.json({ error: "Contexte de session non migré" }, 500);
  }

  return c.json({
    data: {
      ok: true,
      activeRestaurantId: restaurantId,
      restaurant: restaurantContext,
    },
  });
});

// POST /auth/legal/accept-user-notice — worker/manager acknowledges privacy/user notice and chooses optional WhatsApp consent
authRoutes.post("/legal/accept-user-notice", requireAuth, async (c) => {
  const user = c.get("user");
  const restaurantId = user.activeRestaurantId;

  const [restaurant] = db
    .select({ status: restaurants.status })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();

  if (user.role === "admin" || restaurant?.status === "demo") {
    return c.json({ data: { ok: true, userNoticeAcceptanceRequired: false, userNoticeVersion: USER_NOTICE_VERSION, whatsappOptIn: !!user.whatsappOptIn } });
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const whatsappOptIn = body.whatsappOptIn === true;
  const now = new Date().toISOString();

  db.update(users).set({
    userNoticeVersion: USER_NOTICE_VERSION,
    userNoticeAcceptedAt: now,
    userNoticeIpAddress: requestIp(c),
    userNoticeUserAgent: c.req.header("user-agent") ?? null,
    whatsappOptIn,
    whatsappOptInAt: whatsappOptIn ? now : null,
    whatsappOptOutAt: whatsappOptIn ? null : now,
  }).where(eq(users.id, user.id)).run();

  return c.json({ data: { ok: true, userNoticeAcceptanceRequired: false, userNoticeVersion: USER_NOTICE_VERSION, whatsappOptIn } });
});

// POST /auth/legal/accept-owner — owner/legal representative accepts current CGU/DPA pack
authRoutes.post("/legal/accept-owner", requireAuth, async (c) => {
  const user = c.get("user");
  const restaurantId = user.activeRestaurantId;
  if (user.role !== "admin" && user.ownerRole !== "owner_admin") {
    return c.json({ error: "Forbidden — owner admin only" }, 403);
  }

  const [restaurant] = db
    .select({ status: restaurants.status })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();

  if (restaurant?.status === "demo") {
    return c.json({ data: { ok: true, ownerLegalAcceptanceRequired: false, ownerLegalVersions: OWNER_LEGAL_VERSIONS } });
  }

  if (!hasCurrentOwnerLegalAcceptance(restaurantId, user.ownerId)) {
    db.insert(legalAcceptances).values({
      ownerId: user.ownerId,
      restaurantId,
      userId: user.id,
      acceptanceType: "owner_terms",
      termsVersion: OWNER_LEGAL_VERSIONS.terms,
      dpaVersion: OWNER_LEGAL_VERSIONS.dpa,
      privacyVersion: OWNER_LEGAL_VERSIONS.privacy,
      subprocessorsVersion: OWNER_LEGAL_VERSIONS.subprocessors,
      ipAddress: requestIp(c),
      userAgent: c.req.header("user-agent") ?? null,
    }).run();
  }

  return c.json({ data: { ok: true, ownerLegalAcceptanceRequired: false, ownerLegalVersions: OWNER_LEGAL_VERSIONS } });
});

type StripeCancellationDetails = {
  cancellationReason: string | null;
  cancellationFeedback: string | null;
  cancellationComment: string | null;
  cancellationRequestedAt: string | null;
};

function optionalString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function extractStripeCancellationDetails(sub: Stripe.Subscription): StripeCancellationDetails {
  const details = (sub as any).cancellation_details ?? {};
  return {
    cancellationReason: optionalString(details.reason),
    cancellationFeedback: optionalString(details.feedback),
    cancellationComment: optionalString(details.comment),
    cancellationRequestedAt: (sub as any).canceled_at
      ? new Date((sub as any).canceled_at * 1000).toISOString()
      : null,
  };
}

function primaryRestaurantForOwner(ownerId: string) {
  return db.select({ id: restaurants.id, name: restaurants.name })
    .from(restaurants)
    .where(eq(restaurants.ownerId, ownerId))
    .limit(1)
    .all()[0] ?? null;
}

function primaryBillingRestaurantForCustomer(customerId: string) {
  const [owner] = db.select({ id: owners.id })
    .from(owners)
    .where(eq(owners.stripeCustomerId, customerId))
    .limit(1)
    .all();
  if (owner) return primaryRestaurantForOwner(owner.id);

  return db.select({ id: restaurants.id, name: restaurants.name })
    .from(restaurants)
    .where(eq(restaurants.stripeCustomerId, customerId))
    .limit(1)
    .all()[0] ?? null;
}

export function billingAdminRecipientsForRestaurant(restaurantId: string): Array<{ id: string }> {
  const hasOwnerContext = columnExists("restaurants", "owner_id");
  if (columnExists("restaurant_memberships", "restaurant_id")) {
    const membershipRows = db.select({ id: users.id })
      .from(restaurantMemberships)
      .innerJoin(users, eq(restaurantMemberships.userId, users.id))
      .where(and(
        eq(restaurantMemberships.restaurantId, restaurantId),
        eq(restaurantMemberships.role, "admin"),
        eq(restaurantMemberships.active, true),
        eq(users.active, true),
      ))
      .all();
    if (membershipRows.length > 0 || hasOwnerContext) return membershipRows;
  }

  return db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.restaurantId, restaurantId), eq(users.role, "admin"), eq(users.active, true)))
    .all();
}

function syncCustomerSubscriptionStatus(customerId: string, subscriptionStatus: "active" | "past_due") {
  const [owner] = db.select({ id: owners.id })
    .from(owners)
    .where(eq(owners.stripeCustomerId, customerId))
    .limit(1)
    .all();

  if (owner) {
    db.update(owners)
      .set({ subscriptionStatus })
      .where(eq(owners.id, owner.id))
      .run();
    db.update(restaurants)
      .set({ subscriptionStatus })
      .where(eq(restaurants.ownerId, owner.id))
      .run();
    return;
  }

  db.update(restaurants)
    .set({ subscriptionStatus })
    .where(eq(restaurants.stripeCustomerId, customerId))
    .run();
}

// ── Helper: sync subscription status from Stripe sub object ──
function syncSubscriptionStatus(sub: Stripe.Subscription) {
  type SubStatus = "active" | "trialing" | "past_due" | "cancelled" | "unpaid";
  const statusMap: Record<string, SubStatus> = {
    active: "active",
    trialing: "trialing",
    past_due: "past_due",
    canceled: "cancelled",
    unpaid: "unpaid",
    incomplete: "past_due",
    incomplete_expired: "cancelled",
    paused: "past_due",
  };

  const subscriptionStatus: SubStatus = statusMap[sub.status] || "active";
  const periodEnd = (sub as any).current_period_end
    ? new Date((sub as any).current_period_end * 1000).toISOString()
    : null;
  const trialEnd = sub.trial_end
    ? new Date(sub.trial_end * 1000).toISOString()
    : null;

  const cancelAt = (sub as any).cancel_at
    ? new Date((sub as any).cancel_at * 1000).toISOString()
    : null;
  const cancellation = extractStripeCancellationDetails(sub);

  const [previousOwner] = db.select({
    id: owners.id,
    name: owners.name,
    subscriptionStatus: owners.subscriptionStatus,
    subscriptionPeriodEnd: owners.subscriptionPeriodEnd,
    cancelAt: owners.cancelAt,
    stripeCustomerId: owners.stripeCustomerId,
    stripeSubscriptionId: owners.stripeSubscriptionId,
  })
    .from(owners)
    .where(eq(owners.stripeSubscriptionId, sub.id))
    .limit(1)
    .all();

  // Read a mirrored restaurant row for audit/cancellation-detail compatibility.
  const [previousRestaurant] = db.select({
    id: restaurants.id,
    name: restaurants.name,
    subscriptionStatus: restaurants.subscriptionStatus,
    subscriptionPeriodEnd: restaurants.subscriptionPeriodEnd,
    cancelAt: restaurants.cancelAt,
    stripeCustomerId: restaurants.stripeCustomerId,
    stripeSubscriptionId: restaurants.stripeSubscriptionId,
    cancellationReason: restaurants.cancellationReason,
    cancellationFeedback: restaurants.cancellationFeedback,
    cancellationComment: restaurants.cancellationComment,
    cancellationRequestedAt: restaurants.cancellationRequestedAt,
  })
    .from(restaurants)
    .where(previousOwner ? eq(restaurants.ownerId, previousOwner.id) : eq(restaurants.stripeSubscriptionId, sub.id))
    .limit(1).all();

  db.update(owners)
    .set({
      subscriptionStatus,
      subscriptionPeriodEnd: periodEnd,
      trialEndsAt: trialEnd,
      cancelAt,
    })
    .where(eq(owners.stripeSubscriptionId, sub.id))
    .run();

  db.update(restaurants)
    .set({
      subscriptionStatus,
      subscriptionPeriodEnd: periodEnd,
      trialEndsAt: trialEnd,
      cancelAt,
      ...cancellation,
    })
    .where(previousOwner ? eq(restaurants.ownerId, previousOwner.id) : eq(restaurants.stripeSubscriptionId, sub.id))
    .run();

  console.log(`↻ Subscription ${sub.id}: ${sub.status} → ${subscriptionStatus}`);

  const previous = previousRestaurant
    ? {
      ...previousRestaurant,
      name: previousOwner?.name ?? previousRestaurant.name,
      subscriptionStatus: previousOwner?.subscriptionStatus ?? previousRestaurant.subscriptionStatus,
      subscriptionPeriodEnd: previousOwner?.subscriptionPeriodEnd ?? previousRestaurant.subscriptionPeriodEnd,
      cancelAt: previousOwner?.cancelAt ?? previousRestaurant.cancelAt,
      stripeCustomerId: previousOwner?.stripeCustomerId ?? previousRestaurant.stripeCustomerId,
      stripeSubscriptionId: previousOwner?.stripeSubscriptionId ?? previousRestaurant.stripeSubscriptionId,
    }
    : null;

  const scheduledCancellationStarted = !!previous && !previous.cancelAt && !!cancelAt;
  const becameCancelled = !!previous && previous.subscriptionStatus !== "cancelled" && subscriptionStatus === "cancelled";
  const cancellationDetailsChanged = !!previous && (
    previous.cancellationReason !== cancellation.cancellationReason ||
    previous.cancellationFeedback !== cancellation.cancellationFeedback ||
    previous.cancellationComment !== cancellation.cancellationComment ||
    previous.cancellationRequestedAt !== cancellation.cancellationRequestedAt
  );
  const cancellationDetailsBecameAvailable = !!previous
    && (cancelAt || subscriptionStatus === "cancelled")
    && !previous.cancellationReason
    && !previous.cancellationFeedback
    && !previous.cancellationComment
    && !!(cancellation.cancellationReason || cancellation.cancellationFeedback || cancellation.cancellationComment);

  if (previous && (scheduledCancellationStarted || becameCancelled || cancellationDetailsChanged)) {
    db.insert(auditLogs).values({
      restaurantId: previous.id,
      tableName: "restaurants",
      rowId: previous.id,
      action: "update",
      actorId: null,
      actorName: "Stripe",
      source: "stripe-webhook",
      changes: JSON.stringify({
        subscriptionStatus: { old: previous.subscriptionStatus, new: subscriptionStatus },
        cancelAt: { old: previous.cancelAt, new: cancelAt },
        cancellationReason: { old: previous.cancellationReason, new: cancellation.cancellationReason },
        cancellationFeedback: { old: previous.cancellationFeedback, new: cancellation.cancellationFeedback },
        cancellationComment: { old: previous.cancellationComment, new: cancellation.cancellationComment },
        cancellationRequestedAt: { old: previous.cancellationRequestedAt, new: cancellation.cancellationRequestedAt },
      }),
      summary: `Stripe subscription cancellation update for ${previous.name}`,
    }).run();
  }

  if (previous && (scheduledCancellationStarted || becameCancelled || cancellationDetailsBecameAvailable)) {
    if (CANCELLATION_ALERT_EMAIL) {
      sendCancellationAlertEmail(CANCELLATION_ALERT_EMAIL, {
        restaurantName: previous.name,
        restaurantId: previous.id,
        subscriptionStatus,
        stripeCustomerId: previous.stripeCustomerId,
        stripeSubscriptionId: previous.stripeSubscriptionId,
        periodEnd,
        cancelAt,
        requestedAt: cancellation.cancellationRequestedAt,
        reason: cancellation.cancellationReason,
        feedback: cancellation.cancellationFeedback,
        comment: cancellation.cancellationComment,
      }).catch((err) => console.error("[cancellation-alert-email] failed:", redactSensitiveString(err.message)));
    }
  }

  if (
    previous?.stripeCustomerId &&
    previous.subscriptionStatus !== subscriptionStatus &&
    (subscriptionStatus === "unpaid" || subscriptionStatus === "cancelled")
  ) {
    notifyBillingEvent(
      previous.stripeCustomerId,
      "subscription_cancelled",
      (name) =>
        `Votre abonnement Comptoir pour ${name} a été suspendu. Mettez à jour votre moyen de paiement dans votre espace facturation pour rétablir l'accès.`
    );
  }
}

// Queue a WhatsApp notification to a restaurant's admin for a billing event.
function notifyBillingEvent(
  customerId: string,
  type: "payment_failed" | "subscription_cancelled",
  message: (restaurantName: string) => string
) {
  try {
    const restaurant = primaryBillingRestaurantForCustomer(customerId);
    if (!restaurant) return;

    const [admin] = billingAdminRecipientsForRestaurant(restaurant.id);
    if (!admin) return;

    queueNotification({
      recipientId: admin.id,
      type,
      channel: "whatsapp",
      message: message(restaurant.name),
      scheduledFor: new Date().toISOString(),
      restaurantId: restaurant.id,
    });
    console.log(`✉ ${type} notification queued for restaurant ${restaurant.name}`);
  } catch (err) {
    console.error(`[notifyBillingEvent ${type}] failed:`, err);
  }
}

// ── Helper: activate a pending registration into a real account (ST-01: idempotent + transactional) ──
function activateRegistration(
  pendingId: string,
  stripeInfo?: { stripeCustomerId: string; stripeSubscriptionId: string }
) {
  return db.transaction((tx) => {
    // Idempotency guard — if already activated via this Stripe customer, skip
    if (stripeInfo?.stripeCustomerId) {
      const [existingOwner] = tx.select({ id: owners.id })
        .from(owners)
        .where(eq(owners.stripeCustomerId, stripeInfo.stripeCustomerId))
        .limit(1).all();
      if (existingOwner) {
        console.log(`↻ Registration already activated for Stripe customer ${stripeInfo.stripeCustomerId}, skipping`);
        return null;
      }
    }

    const [pending] = tx
      .select()
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, pendingId))
      .limit(1)
      .all();

    if (!pending) return null;

    const [owner] = tx
      .insert(owners)
      .values({
        name: pending.restaurantName,
        stripeCustomerId: stripeInfo?.stripeCustomerId || null,
        stripeSubscriptionId: stripeInfo?.stripeSubscriptionId || null,
        subscriptionStatus: "active",
      })
      .returning()
      .all();

    // Create restaurant
    const [restaurant] = tx
      .insert(restaurants)
      .values({
        ownerId: owner.id,
        name: pending.restaurantName,
        status: "active",
        stripeCustomerId: stripeInfo?.stripeCustomerId || null,
        stripeSubscriptionId: stripeInfo?.stripeSubscriptionId || null,
        autoStaffingWeeks: 3,
        preferredStyle: "equipe-stable",
        defaultContractType: DEFAULT_CONTRACT_TYPE,
        defaultContractHours: DEFAULT_CONTRACT_HOURS,
      })
      .returning()
      .all();

    // Create admin user
    const [admin] = tx
      .insert(users)
      .values({
        name: pending.adminName,
        email: pending.email,
        phone: pending.phone,
        passwordHash: pending.passwordHash,
        role: "admin",
        restaurantId: restaurant.id,
        priority: 1,
      })
      .returning()
      .all();

    tx.insert(ownerMemberships).values({
      ownerId: owner.id,
      userId: admin.id,
      role: "owner_admin",
    }).onConflictDoNothing().run();

    tx.insert(restaurantMemberships).values({
      restaurantId: restaurant.id,
      userId: admin.id,
      role: "admin",
      permissions: null,
      active: true,
    }).onConflictDoNothing().run();

    // Clean up pending registration
    tx.delete(pendingRegistrations)
      .where(eq(pendingRegistrations.id, pendingId))
      .run();

    return {
      email: admin.email,
      adminName: admin.name,
      restaurantName: restaurant.name,
      restaurantId: restaurant.id,
      userId: admin.id,
    };
  });
}
