/**
 * Meta WhatsApp Cloud API webhook handler.
 * Validates HMAC-SHA256 signature on the raw body, parses JSON,
 * resolves identity, runs the agent async, replies via Graph REST API.
 *
 * Async pattern: Meta retries on non-200 responses, so we ack 200 immediately
 * and process in the background. LLM calls (5–20s) cannot run inline.
 */
import type { Context } from "hono";
import { resolveIdentity, type IdentityResult } from "./identity.js";
import { runAgent } from "./agent.js";
import { expireOldMessages, saveUploadedDocument } from "./webhook-storage.js";
import { sendWhatsAppMessage, sendWhatsAppReply, sendTypingIndicator, fetchMetaMedia } from "./meta.js";
import { transcribeAudio } from "./stt.js";
import { formatLogMessagePreview, redactSensitiveString } from "@comptoir/shared";

const WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";

export function isProductionLikeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (env.NODE_ENV || "").toLowerCase();
  const appEnv = (env.APP_ENV || env.ENVIRONMENT || "").toLowerCase();
  const frontendUrl = env.FRONTEND_URL || "";
  return nodeEnv === "production"
    || nodeEnv === "staging"
    || appEnv === "production"
    || appEnv === "staging"
    || frontendUrl === "https://comptoir.cosmobot.fr"
    || frontendUrl === "https://staging.comptoir.cosmobot.fr";
}

export function assertMetaWebhookConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (isProductionLikeEnv(env) && !env.WHATSAPP_APP_SECRET) {
    throw new Error("WHATSAPP_APP_SECRET is required in production/staging for Meta webhook signature validation");
  }
}

// ── Input sanitization (PI-01) ──

const MAX_INPUT_LENGTH = 500;
const INJECTION_LINE_PATTERN = /^\s*(?:\[SYSTEM|\[ASSISTANT|\[TOOL|---|SYSTEM:|ASSISTANT:)/i;
const INJECTION_BLOCK_PATTERN = /\n\n(?:###|---)/g;

function sanitizeInput(text: string): string {
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  cleaned = cleaned.replace(INJECTION_BLOCK_PATTERN, "\n\n");
  cleaned = cleaned
    .split("\n")
    .filter((line) => !INJECTION_LINE_PATTERN.test(line))
    .join("\n");
  if (cleaned.length > MAX_INPUT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_INPUT_LENGTH);
  }
  return cleaned.trim();
}

// ── Per-user rate limiting ──

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(phone: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(phone);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(phone, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return true;
  }

  return false;
}

export function identityFailureReply(result: Extract<IdentityResult, { ok: false }>): string {
  if (result.blocked) return result.message;
  if (result.code === "RESTAURANT_CONTEXT_REQUIRED" && result.message && result.restaurants?.length) {
    const names = result.restaurants.map((restaurant) => `- ${restaurant.name}`).join("\n");
    return `${result.message}\n\nRépondez avec le nom du restaurant :\n${names}`;
  }
  if (result.message) return result.message;
  return "Numéro non reconnu. Demande à ton responsable d'enregistrer ton numéro dans Comptoir.";
}

function normalizeRestaurantText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function matchRestaurantMention(
  message: string,
  restaurants: Array<{ id: string; name: string }>,
): string | null {
  const normalizedMessage = normalizeRestaurantText(message);
  if (!normalizedMessage) return null;
  const matches = restaurants.filter((restaurant) => {
    const normalizedName = normalizeRestaurantText(restaurant.name);
    return normalizedName.length >= 3
      && (normalizedMessage === normalizedName || normalizedMessage.includes(normalizedName));
  });
  return matches.length === 1 ? matches[0].id : null;
}

// ── Meta signature validation (HMAC-SHA256 over raw body) ──

async function hmacSha256Hex(key: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function validateMetaSignatureHeader(
  sigHeader: string | undefined,
  rawBody: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const secret = env.WHATSAPP_APP_SECRET || "";
  if (!secret) {
    if (isProductionLikeEnv(env)) {
      console.error("[SECURITY] Meta signature validation unavailable — WHATSAPP_APP_SECRET missing in production/staging.");
      return false;
    }
    console.warn("[SECURITY] Meta signature validation SKIPPED — WHATSAPP_APP_SECRET not set. Local/dev only.");
    return true;
  }
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return constantTimeEqual(`sha256=${expected}`, sigHeader);
}

async function validateMetaSignature(c: Context, rawBody: string): Promise<boolean> {
  return validateMetaSignatureHeader(c.req.header("x-hub-signature-256"), rawBody);
}

// ── GET verify handshake ──

export async function handleVerify(c: Context): Promise<Response> {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return c.text(challenge ?? "", 200);
  }
  console.warn("[webhook] Verify handshake failed");
  return c.text("Forbidden", 403);
}

// ── Main webhook handler ──

type MetaMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  image?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string; caption?: string };
};

type MetaMedia = { id: string; mimeType: string; caption?: string };

const BUTTON_PAYLOAD_TO_TEXT: Record<string, string> = {
  OPEN_SHIFT_YES: "oui",
  OPEN_SHIFT_NO: "non",
  REPLACEMENT_YES: "accepter",
  REPLACEMENT_NO: "refuser",
  LEAVE_PROPOSAL_YES: "oui",
  LEAVE_PROPOSAL_NO: "non",
  Accepter: "oui",
  Refuser: "non",
  VIEW_SCHEDULE: "Voir mon planning",
};

export function extractIncomingText(message: MetaMessage): string {
  const raw = message.text?.body
    ?? message.interactive?.button_reply?.id
    ?? message.interactive?.button_reply?.title
    ?? message.interactive?.list_reply?.id
    ?? message.interactive?.list_reply?.title
    ?? message.button?.payload
    ?? message.button?.text
    ?? "";
  return (BUTTON_PAYLOAD_TO_TEXT[raw] ?? raw).trim();
}

export async function handleIncoming(c: Context): Promise<Response> {
  const rawBody = await c.req.text();

  const valid = await validateMetaSignature(c, rawBody);
  if (!valid) {
    console.warn("[webhook] Invalid Meta signature — rejecting");
    return c.text("Forbidden", 403);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.text("Bad Request", 400);
  }

  const change = payload?.entry?.[0]?.changes?.[0];
  const value = change?.value;

  // Meta sends both `messages` and `statuses` arrays on the same endpoint.
  // Statuses are delivery receipts — log briefly and ack.
  if (Array.isArray(value?.statuses) && value.statuses.length > 0) {
    for (const s of value.statuses) {
      console.log(`[status] ${redactSensitiveString(s.id)}: ${redactSensitiveString(s.status)}`);
    }
    return c.body(null, 200);
  }

  const message: MetaMessage | undefined = value?.messages?.[0];
  if (!message) {
    return c.body(null, 200);
  }

  const from = message.from.startsWith("+") ? message.from : `+${message.from}`;
  const messageId = message.id;
  const text = extractIncomingText(message);

  // Voice notes route to their own path: transcribe → echo back → run agent.
  const audio = message.audio;

  // Documents/images/videos remain on the dossier-upload path.
  const media: MetaMedia[] = [];
  if (message.image) media.push({ id: message.image.id, mimeType: message.image.mime_type ?? "image/jpeg", caption: message.image.caption });
  if (message.document) media.push({ id: message.document.id, mimeType: message.document.mime_type ?? "application/pdf", caption: message.document.caption });
  if (message.video) media.push({ id: message.video.id, mimeType: message.video.mime_type ?? "video/mp4", caption: message.video.caption });

  console.log(`[webhook] From: ${redactSensitiveString(from)} | Body: ${formatLogMessagePreview(text)}${audio ? " | Audio" : ""}${media.length > 0 ? ` | Media: ${media.length}` : ""}`);

  if (isRateLimited(from)) {
    console.warn(`[webhook] Rate limited: ${redactSensitiveString(from)}`);
    return c.body(null, 200);
  }

  // ── Voice-note flow ──
  if (audio) {
    const result = await resolveIdentity(from);
    if (!result.ok) {
      const reply = identityFailureReply(result);
      sendWhatsAppMessage(from, reply).catch((e) => console.error("[webhook] reply failed:", e));
      return c.body(null, 200);
    }
    processVoiceAsync(from, result.identity, audio.id, audio.mime_type ?? "audio/ogg", messageId);
    return c.body(null, 200);
  }

  // ── Document/image/video upload flow ──
  if (media.length > 0) {
    const result = await resolveIdentity(from);
    if (!result.ok) {
      const reply = identityFailureReply(result);
      // Fire-and-forget reply via REST — Meta has no inline-reply mode.
      sendWhatsAppMessage(from, reply).catch((e) => console.error("[webhook] reply failed:", e));
      return c.body(null, 200);
    }
    // Caption may live on any media object; fall back to message-level text.
    const caption = media.find((m) => m.caption)?.caption ?? text;
    processMediaAsync(from, result.identity, media, caption);
    return c.body(null, 200);
  }

  if (!text) {
    sendWhatsAppMessage(from, "Envoie-moi un message et je t'aide avec ton planning !")
      .catch((e) => console.error("[webhook] reply failed:", e));
    return c.body(null, 200);
  }

  const sanitized = sanitizeInput(text);
  if (!sanitized) {
    sendWhatsAppMessage(from, "Envoie-moi un message et je t'aide avec ton planning !")
      .catch((e) => console.error("[webhook] reply failed:", e));
    return c.body(null, 200);
  }

  let result = await resolveIdentity(from);
  if (!result.ok) {
    const selectedRestaurantId = !result.blocked && result.code === "RESTAURANT_CONTEXT_REQUIRED"
      ? matchRestaurantMention(sanitized, result.restaurants ?? [])
      : null;
    if (selectedRestaurantId) {
      result = await resolveIdentity(from, selectedRestaurantId);
      if (result.ok) {
        expireOldMessages().catch((e) => console.error("[webhook] message expiry failed:", e));
        processAsync(from, result.identity, sanitized, messageId);
        return c.body(null, 200);
      }
    }
    const reply = identityFailureReply(result);
    sendWhatsAppMessage(from, reply).catch((e) => console.error("[webhook] reply failed:", e));
    return c.body(null, 200);
  }

  expireOldMessages().catch((e) => console.error("[webhook] message expiry failed:", e));
  processAsync(from, result.identity, sanitized, messageId);

  return c.body(null, 200);
}

/** Process media attachments asynchronously — download each, store to documents, reply with confirmation. */
async function processMediaAsync(from: string, identity: any, media: MetaMedia[], caption: string) {
  const savedNames: string[] = [];
  try {
    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      const { bytes, contentType } = await fetchMetaMedia(m.id);
      if (bytes.byteLength > 5 * 1024 * 1024) {
        await sendWhatsAppMessage(from, "Fichier trop volumineux (max 5 Mo). Réessaie avec une image plus petite.");
        continue;
      }

      const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg"
        : contentType.includes("png") ? "png"
        : contentType.includes("pdf") ? "pdf"
        : contentType.includes("webp") ? "webp"
        : contentType.includes("ogg") ? "ogg"
        : contentType.includes("mp4") ? "mp4"
        : "bin";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const isSignedContract = /\b(sign[ée]|signed|contrat\s*sign[ée])\b/i.test(caption);
      const filename = `whatsapp-${timestamp}-${i + 1}.${ext}`;
      const name = caption || `Document envoyé par WhatsApp le ${new Date().toLocaleDateString("fr-FR")}`;

      let binary = "";
      for (let j = 0; j < bytes.byteLength; j++) binary += String.fromCharCode(bytes[j]);
      const base64 = btoa(binary);
      await saveUploadedDocument({
        userId: identity.userId,
        restaurantId: identity.restaurantId,
        name: name.slice(0, 200),
        filename,
        mimeType: contentType,
        size: bytes.byteLength,
        base64,
        isSignedContract,
      });
      savedNames.push(filename);
    }

    if (savedNames.length === 0) {
      await sendWhatsAppMessage(from, "Aucun document n'a pu être enregistré — réessaie.");
      return;
    }
    const plural = savedNames.length > 1 ? "s" : "";
    await sendWhatsAppMessage(
      from,
      `Merci ${identity.name.split(" ")[0]} ! ${savedNames.length} document${plural} reçu${plural} et ajouté${plural} à ton dossier. Ton responsable le${plural} classera dans la checklist d'onboarding.`,
    );
  } catch (err: any) {
    console.error("[webhook] Media upload failed:", err?.message || err);
    await sendWhatsAppMessage(from, "Oups, je n'ai pas pu enregistrer ton document. Réessaie dans quelques instants.");
  }
}

/**
 * Show Meta's native "typing…" indicator while processing. The indicator clears
 * on the next outbound message OR after ~25s, so we refresh it every 20s with
 * the same inbound messageId until processing finishes.
 *
 * Returns a function that stops the refresh loop.
 */
function startTypingIndicator(messageId: string | undefined): () => void {
  if (!messageId) return () => {};
  sendTypingIndicator(messageId).catch((e) => console.error("[webhook] typing failed:", e));
  const interval = setInterval(() => {
    sendTypingIndicator(messageId).catch((e) => console.error("[webhook] typing refresh failed:", e));
  }, 20_000);
  return () => clearInterval(interval);
}

/** Process message in background, send reply via Meta REST API */
async function processAsync(from: string, identity: any, text: string, messageId?: string) {
  const stopTyping = startTypingIndicator(messageId);
  try {
    const start = Date.now();
    const reply = await runAgent(identity, text);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[agent] ${redactSensitiveString(identity.userId ?? identity.name)}: ${formatLogMessagePreview(text)} → ${elapsed}s`);
    stopTyping();
    await sendWhatsAppReply(from, reply);
  } catch (err: any) {
    stopTyping();
    console.error("[agent] Error:", redactSensitiveString(err.message));
    await sendWhatsAppMessage(from, "Désolé, une erreur est survenue. Réessaie dans quelques instants.");
  }
}

/**
 * Voice-note flow:
 *  1) arm typing indicator immediately (single window covers transcription + LLM)
 *  2) download audio bytes from Meta
 *  3) reject if too big (cheap proxy for "too long")
 *  4) transcribe via DeepInfra Whisper
 *  5) hand the transcription straight to the agent — Bernardo's answer replaces
 *     any explicit transcription echo. The user already sees their own voice
 *     note above the response in the chat, and the answer naturally restates
 *     intent ("d'accord, je préviens ton responsable que tu ne peux pas demain").
 *
 * Meta's typing_indicator is coupled with `status: read` and works exactly once
 * per inbound messageId. processAsync's redundant arm below is a silent no-op.
 */
async function processVoiceAsync(
  from: string,
  identity: any,
  audioId: string,
  mimeType: string,
  messageId: string,
) {
  const stopTyping = startTypingIndicator(messageId);
  let transcription = "";
  try {
    const { bytes, contentType } = await fetchMetaMedia(audioId);

    // Soft cap: OGG/Opus voice notes at ~24kbps are ~180 KB/min; 5 MB ≈ 4 min worst case.
    // Beyond that the user is dictating a saga and Bernardo isn't the right tool.
    if (bytes.byteLength > 5 * 1024 * 1024) {
      stopTyping();
      await sendWhatsAppMessage(from, "Ton message vocal est trop long. Envoie-moi un texte ou un vocal plus court (< 1 min).");
      return;
    }

    transcription = (await transcribeAudio(bytes, contentType || mimeType)).trim();
  } catch (err: any) {
    stopTyping();
    console.error("[voice] Transcription failed:", redactSensitiveString(err?.message ?? String(err)));
    await sendWhatsAppMessage(from, "Je n'ai pas pu lire ton message vocal. Réessaie ou écris-moi.");
    return;
  }

  if (!transcription || transcription.length < 2) {
    stopTyping();
    await sendWhatsAppMessage(from, "Je n'ai pas bien compris ton message vocal. Peux-tu répéter ou m'écrire ?");
    return;
  }

  const sanitized = sanitizeInput(transcription);
  if (!sanitized) {
    stopTyping();
    await sendWhatsAppMessage(from, "Je n'ai pas pu interpréter ton message. Reformule s'il te plaît.");
    return;
  }

  expireOldMessages().catch((e) => console.error("[webhook] message expiry failed:", e));
  // Hand off; processAsync's typing arm is a silent no-op (already read).
  // We stop our own refresh interval here to avoid two parallel intervals
  // hammering Meta with already-read 400s.
  stopTyping();
  await processAsync(from, identity, sanitized, messageId);
}
