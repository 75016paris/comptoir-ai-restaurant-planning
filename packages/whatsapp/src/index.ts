import { Hono } from "hono";
import { logger } from "hono/logger";
import { assertMetaWebhookConfig, handleIncoming, handleVerify } from "./webhook.js";
import { resolveIdentity } from "./identity.js";
import { runAgent } from "./agent.js";
import { apiPostInternal } from "./api-client.js";
import { notifyInChat, type NotificationType } from "./notify.js";
import { assertInternalRouteSecretForProduction, isUsableDemoChatSecret } from "./internal-secret.js";
import { formatLogMessagePreview, isProductionLikeLogEnv, redactSensitiveString } from "@comptoir/shared";

assertMetaWebhookConfig();
assertInternalRouteSecretForProduction();

const app = new Hono();
app.use("*", logger((str, ...rest) => console.log(redactSensitiveString(str), ...rest.map(redactSensitiveString))));

const DEMO_CHAT_SECRET = process.env.DEMO_CHAT_SECRET;

function validInternalSecret(secret: string | undefined): boolean {
  return isUsableDemoChatSecret(DEMO_CHAT_SECRET) && secret === DEMO_CHAT_SECRET;
}

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "comptoir-whatsapp" }));

// Meta WhatsApp Cloud API webhook
app.get("/webhook/whatsapp", handleVerify);
app.post("/webhook/whatsapp", handleIncoming);

// Legacy Twilio path — kept one deploy as 410 Gone for clean rollback signal.
// Remove once prod has been on Meta ≥7 days.
app.all("/webhook/twilio", (c) => {
  console.warn("[webhook] Legacy Twilio path hit — Meta migration in effect");
  return c.text("Gone — webhook moved to /webhook/whatsapp", 410);
});

// Demo chat — direct agent call without Twilio (used by web demo page)
app.post("/chat", async (c) => {
  const secret = c.req.header("x-demo-secret");
  if (!validInternalSecret(secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { phone, message, restaurantId } = await c.req.json<{ phone: string; message: string; restaurantId?: string }>();
  if (!phone || !message) {
    return c.json({ error: "phone and message required" }, 400);
  }

  const result = await resolveIdentity(phone, restaurantId);
  if (!result.ok) {
    return c.json({ error: "Identity not found" }, 404);
  }

  const { identity } = result;
  if (restaurantId && identity.restaurantId !== restaurantId) {
    return c.json({ error: "Identity not found" }, 404);
  }
  try {
    const start = Date.now();
    const reply = await runAgent(identity, message);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const actor = isProductionLikeLogEnv() ? identity.userId : redactSensitiveString(identity.name);
    console.log(`[demo-chat] ${actor}: ${formatLogMessagePreview(message)} → ${elapsed}s`);
    return c.json({ reply, identity: { name: identity.name, role: identity.role } });
  } catch (err: any) {
    console.error("[demo-chat] Error:", redactSensitiveString(err.message));
    const isConnect = err.message?.includes("Unable to connect") || err.code === "ConnectionRefused";
    const msg = isConnect
      ? "Le serveur IA est temporairement indisponible. Réessayez dans quelques minutes."
      : "Erreur interne du bot.";
    return c.json({ reply: `⚠️ ${msg}`, identity: { name: identity.name, role: identity.role } }, 200);
  }
});

// Demo chat — notifications for a phone (used by demo page polling)
app.get("/chat/notifications", async (c) => {
  const secret = c.req.header("x-demo-secret");
  if (!validInternalSecret(secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const phone = c.req.query("phone");
  const sinceRaw = c.req.query("since");
  const restaurantId = c.req.query("restaurantId");
  if (!phone || !sinceRaw) {
    return c.json({ error: "phone and since required" }, 400);
  }

  const result = await resolveIdentity(phone, restaurantId);
  if (!result.ok) return c.json({ data: { notifications: [] } });
  if (restaurantId && result.identity.restaurantId !== restaurantId) {
    return c.json({ data: { notifications: [] } });
  }

  const rows = await apiPostInternal<{ data: { notifications: Array<{ id: string; type: string; message: string; createdAt: string }> } }>("/notifications/list", {
    userId: result.identity.userId,
    since: sinceRaw,
  });

  return c.json(rows);
});

// ── In-chat notification delivery (called by API) ──

app.post("/notify", async (c) => {
  const secret = c.req.header("x-demo-secret");
  if (!validInternalSecret(secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { userId, message, type, template } = await c.req.json<{
    userId: string;
    message: string;
    type: NotificationType;
    template?: Parameters<typeof notifyInChat>[0]["template"];
  }>();

  if (!userId || !message || !type) {
    return c.json({ error: "userId, message, and type required" }, 400);
  }

  try {
    await notifyInChat({ recipientId: userId, message, type, template });
    return c.json({ ok: true });
  } catch (err: any) {
    console.error("[notify] Error:", redactSensitiveString(err.message));
    return c.json({ error: "Notification failed" }, 500);
  }
});

// Demo chat — clear history for a phone number
app.post("/chat/clear", async (c) => {
  const secret = c.req.header("x-demo-secret");
  if (!validInternalSecret(secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { phone, restaurantId } = await c.req.json<{ phone: string; restaurantId?: string }>();
  const result = await resolveIdentity(phone, restaurantId);
  if (!result.ok) return c.json({ error: "Identity not found" }, 404);
  if (restaurantId && result.identity.restaurantId !== restaurantId) {
    return c.json({ error: "Identity not found" }, 404);
  }
  await apiPostInternal("/chat/clear", { userId: result.identity.userId });
  return c.json({ ok: true });
});

const port = Number(process.env.WHATSAPP_PORT) || 3002;
console.log(`📱 Comptoir WhatsApp bot on http://localhost:${port}`);

export default { port, fetch: app.fetch };
