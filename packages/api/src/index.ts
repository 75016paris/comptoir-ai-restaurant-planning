import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { authRoutes } from "./routes/auth.js";
import { serviceRoutes } from "./routes/services.js";
import { replacementRoutes } from "./routes/replacements.js";
import { holidayRoutes } from "./routes/holidays.js";
import { userRoutes } from "./routes/users.js";
import { scheduleRoutes } from "./routes/schedule.js";
import { revenueRoutes } from "./routes/revenue.js";
import { timeClockRoutes } from "./routes/timeclock.js";
import { settingsRoutes } from "./routes/settings.js";
import { autostaffingRoutes } from "./routes/autostaffing.js";
import { notificationRoutes } from "./routes/notifications.js";
import { complianceRoutes } from "./routes/compliance.js";
import { payrollRoutes } from "./routes/payroll.js";
import { weatherRoutes } from "./routes/weather.js";
import { calendarRoutes } from "./routes/calendar.js";
import { demoChatRoutes } from "./routes/demo-chat.js";
import { auditRoutes } from "./routes/audit.js";
import { restrictionRequestRoutes } from "./routes/restriction-requests.js";
import { emailRecipientRoutes } from "./routes/email-recipients.js";
import { cronRoutes } from "./routes/cron.js";
import { healthSolverRoutes } from "./routes/health-solver.js";
import { debugCacheRoutes } from "./routes/debug-cache.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { openShiftRoutes } from "./routes/open-shifts.js";
import { publicOnboardingRoutes } from "./routes/public-onboarding.js";
import { adminAlertsRoutes } from "./routes/admin-alerts.js";
import { internalWhatsappRoutes } from "./routes/internal-whatsapp.js";
import { restaurantRoutes } from "./routes/restaurants.js";
import { requireJsonContentType } from "./middleware/csrf.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { existsSync } from "fs";
import { resolve } from "path";
import { db } from "./db/connection.js";
import { sessions, pendingRegistrations, passwordResetTokens } from "./db/schema.js";
import { lt } from "drizzle-orm";
import { assertDemoChatSecretForProduction } from "./utils/demo-secret.js";
import { redactSensitiveString } from "./utils/token-security.js";
import { migrateStoredTokensToHashes } from "./services/token-maintenance.js";

assertDemoChatSecretForProduction();

const app = new Hono();

// ── Middleware ──
app.use("*", logger((str, ...rest) => console.log(redactSensitiveString(str), ...rest.map(redactSensitiveString))));
app.use("*", securityHeaders);

const FRONTEND_URL = process.env.FRONTEND_URL || "";
const corsOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  ...(FRONTEND_URL ? [FRONTEND_URL] : []),
  // Add staging if prod is set
  ...(FRONTEND_URL?.includes("comptoir.cosmobot.fr") ? ["https://staging.comptoir.cosmobot.fr"] : []),
].filter(Boolean);

app.use(
  "*",
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);

// CSRF: reject mutating requests without Content-Type: application/json
app.use("*", requireJsonContentType);

// ── Health ──
app.get("/health", (c) => c.json({ status: "ok", service: "comptoir-api" }));
app.route("/health/solver", healthSolverRoutes);
app.route("/debug/baseline-cache", debugCacheRoutes);

// ── API Routes (under /api prefix for production, Vite proxy strips it in dev) ──
const api = new Hono();
api.get("/health", (c) => c.json({ status: "ok", service: "comptoir-api" }));
api.route("/health/solver", healthSolverRoutes);
api.route("/debug/baseline-cache", debugCacheRoutes);
api.route("/auth", authRoutes);
api.route("/onboarding", onboardingRoutes);
api.route("/users", userRoutes);
api.route("/services", serviceRoutes);
api.route("/services/replacement", replacementRoutes);
api.route("/open-shifts", openShiftRoutes);
api.route("/holidays", holidayRoutes);
api.route("/schedule", scheduleRoutes);
api.route("/revenue", revenueRoutes);
api.route("/timeclock", timeClockRoutes);
api.route("/settings", settingsRoutes);
api.route("/autostaffing", autostaffingRoutes);
api.route("/notifications", notificationRoutes);
api.route("/compliance", complianceRoutes);
api.route("/payroll", payrollRoutes);
api.route("/weather", weatherRoutes);
api.route("/calendar", calendarRoutes);
api.route("/demo/chat", demoChatRoutes);
api.route("/audit-logs", auditRoutes);
api.route("/email-recipients", emailRecipientRoutes);
api.route("/restriction-requests", restrictionRequestRoutes);
api.route("/cron", cronRoutes);
api.route("/public/onboarding", publicOnboardingRoutes);
api.route("/admin-alerts", adminAlertsRoutes);
api.route("/internal/whatsapp", internalWhatsappRoutes);
api.route("/restaurants", restaurantRoutes);
app.route("/api", api);

// Production: Caddy proxies /api/* → localhost:3000/api/*
// Development: Vite proxy strips /api prefix, so routes must also be at root
app.route("/auth", authRoutes);
app.route("/onboarding", onboardingRoutes);
app.route("/users", userRoutes);
app.route("/services", serviceRoutes);
app.route("/services/replacement", replacementRoutes);
app.route("/open-shifts", openShiftRoutes);
app.route("/holidays", holidayRoutes);
app.route("/schedule", scheduleRoutes);
app.route("/revenue", revenueRoutes);
app.route("/timeclock", timeClockRoutes);
app.route("/settings", settingsRoutes);
app.route("/autostaffing", autostaffingRoutes);
app.route("/notifications", notificationRoutes);
app.route("/compliance", complianceRoutes);
app.route("/restriction-requests", restrictionRequestRoutes);
app.route("/payroll", payrollRoutes);
app.route("/weather", weatherRoutes);
app.route("/calendar", calendarRoutes);
app.route("/demo/chat", demoChatRoutes);
app.route("/audit-logs", auditRoutes);
app.route("/email-recipients", emailRecipientRoutes);
app.route("/cron", cronRoutes);
app.route("/public/onboarding", publicOnboardingRoutes);
app.route("/admin-alerts", adminAlertsRoutes);
app.route("/internal/whatsapp", internalWhatsappRoutes);
app.route("/restaurants", restaurantRoutes);

// ── Static frontend (production) ──
const distPath = resolve(import.meta.dir, "../../web/dist");

// All root-level API prefixes (keep in sync — used for SPA fallback)
const API_PREFIXES = [
  "/api/", "/auth", "/onboarding", "/users", "/services", "/holidays", "/schedule",
  "/revenue", "/timeclock", "/settings", "/autostaffing",
  "/notifications", "/compliance", "/payroll", "/weather",
  "/calendar", "/demo", "/health", "/public/", "/rgpd", "/admin-alerts", "/internal/", "/restaurants",
];

if (existsSync(distPath)) {
  app.use("/assets/*", serveStatic({ root: distPath, rewriteRequestPath: (p) => p }));
  app.get("/favicon.svg", serveStatic({ root: distPath, path: "/favicon.svg" }));
  app.get("/cgu.html", serveStatic({ root: distPath, path: "/cgu.html" }));
  app.get("/confidentialite.html", serveStatic({ root: distPath, path: "/confidentialite.html" }));
  app.get("/rgpd", serveStatic({ root: distPath, path: "/rgpd/index.html" }));
  app.get("/rgpd/", serveStatic({ root: distPath, path: "/rgpd/index.html" }));
  app.get("/rgpd/*", serveStatic({ root: distPath, rewriteRequestPath: (p) => p }));
  // SPA fallback: serve index.html for non-API, non-asset routes
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (API_PREFIXES.some((p) => path.startsWith(p) || path === p)) {
      return next();
    }
    const file = Bun.file(resolve(distPath, "index.html"));
    return new Response(file, { headers: { "Content-Type": "text/html" } });
  });
}

// ── Periodic cleanup: expired sessions, pending registrations, used password tokens ──
function purgeExpired() {
  const now = new Date().toISOString();
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  db.delete(pendingRegistrations).where(lt(pendingRegistrations.expiresAt, now)).run();
  db.delete(passwordResetTokens).where(lt(passwordResetTokens.expiresAt, now)).run();
  console.log(`🧹 Purge check completed`);
}
purgeExpired();
migrateStoredTokensToHashes();
setInterval(purgeExpired, 6 * 60 * 60 * 1000); // every 6 hours

// ── Stripe key/mode sanity check ──
// Catch the two ways a test→live cutover goes wrong: prod running on test keys
// (no real revenue captured) and dev running on live keys (real charges from
// test runs). Staging mirrors prod's NODE_ENV but legitimately uses test keys,
// so we identify "live prod" via FRONTEND_URL pointing at the canonical
// customer-facing host (the deploy script sets this).
{
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const frontend = process.env.FRONTEND_URL ?? "";
  const isLiveProd = process.env.NODE_ENV === "production" && !frontend.includes("staging") && !frontend.includes("localhost");
  if (key.startsWith("sk_test_") && isLiveProd) {
    console.error("[stripe] FATAL: STRIPE_SECRET_KEY is a test key on live production. Refusing to start.");
    process.exit(1);
  }
  if (key.startsWith("sk_live_") && !isLiveProd) {
    console.warn("[stripe] WARNING: STRIPE_SECRET_KEY is a LIVE key outside live production. Real charges may occur.");
  }
}

// ── Start ──
const port = Number(process.env.PORT) || 3000;
const serverConfig = {
  port,
  fetch: app.fetch,
  idleTimeout: 30,
};

if (import.meta.main) {
  Bun.serve(serverConfig);
  console.log(`🚀 Comptoir running on http://localhost:${port}`);
}

export { app, serverConfig };
