/**
 * Meta WhatsApp Cloud API client — sends messages and fetches media via Graph API.
 * Replaces the previous Twilio integration. Same exported surface
 * (sendWhatsAppMessage, sendWhatsAppReply, splitMessage) so callers don't change.
 */

import { formatLogMessagePreview, redactSensitiveString } from "@comptoir/shared";

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type WhatsAppTemplateRequest = {
  name: string;
  language?: string;
  body: string[];
  buttonPayloads?: string[];
};

/** Send a WhatsApp text message via Meta Cloud API */
export async function sendWhatsAppMessage(to: string, message: string): Promise<void> {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[meta] (no credentials) → ${redactSensitiveString(to)}: ${formatLogMessagePreview(message.slice(0, 80))}...`);
    return;
  }

  // Meta caps body at 4096 chars; we split first and clamp here as a safety net.
  const text = message.length > 4096 ? message.slice(0, 4093) + "..." : message;
  const url = `${GRAPH_API_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[meta] Send failed ${res.status}: ${redactSensitiveString(err)}`);
  } else {
    const data = await res.json() as { messages?: { id: string }[] };
    const id = data.messages?.[0]?.id;
    console.log(`[meta] Sent ${redactSensitiveString(id ?? "(no id)")} to ${redactSensitiveString(to)}`);
  }
}

export async function sendWhatsAppTemplate(to: string, template: WhatsAppTemplateRequest): Promise<void> {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[meta] (no credentials) template ${template.name} → ${redactSensitiveString(to)}: ${formatLogMessagePreview(template.body.join(" | "))}`);
    return;
  }

  const components: any[] = [];
  if (template.body.length > 0) {
    components.push({
      type: "body",
      parameters: template.body.map((text) => ({ type: "text", text })),
    });
  }
  for (const [index, payload] of (template.buttonPayloads ?? []).entries()) {
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(index),
      parameters: [{ type: "payload", payload }],
    });
  }

  const res = await fetch(`${GRAPH_API_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language ?? "fr" },
        components,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[meta] Template ${template.name} failed ${res.status}: ${redactSensitiveString(err)}`);
  } else {
    const data = await res.json() as { messages?: { id: string }[] };
    const id = data.messages?.[0]?.id;
    console.log(`[meta] Sent template ${template.name} ${redactSensitiveString(id ?? "(no id)")} to ${redactSensitiveString(to)}`);
  }
}

const WHATSAPP_MAX_LENGTH = 4000;

/** Split long messages at paragraph boundaries for Meta's 4096-char limit */
export function splitMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > WHATSAPP_MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n\n", WHATSAPP_MAX_LENGTH);
    if (splitAt < 200) splitAt = remaining.lastIndexOf("\n", WHATSAPP_MAX_LENGTH);
    if (splitAt < 200) splitAt = remaining.lastIndexOf(" ", WHATSAPP_MAX_LENGTH);
    if (splitAt < 200) splitAt = WHATSAPP_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Mark an inbound message as read AND show a "typing…" indicator to the user.
 * Meta auto-dismisses the indicator when the next outbound message is sent,
 * or after ~25s. Refresh by calling again with the same messageId.
 *
 * No-op (logged only) when credentials are missing, so local dev never errors.
 */
export async function sendTypingIndicator(messageId: string): Promise<void> {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[meta] (no credentials) typing_indicator for ${redactSensitiveString(messageId)}`);
    return;
  }
  const url = `${GRAPH_API_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    // Meta returns 400 if the message is already too old / already acknowledged —
    // not actionable here, just log at warn so prod doesn't spam errors.
    console.warn(`[meta] typing_indicator ${res.status} for ${redactSensitiveString(messageId)}: ${redactSensitiveString(err.slice(0, 200))}`);
  }
}

/** Send a (potentially long) message as multiple WhatsApp chunks */
export async function sendWhatsAppReply(to: string, message: string): Promise<void> {
  const chunks = splitMessage(message);
  for (let i = 0; i < chunks.length; i++) {
    await sendWhatsAppMessage(to, chunks[i]);
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Download a media attachment from Meta. Two-step:
 *   1. GET /{media_id} → returns { url, mime_type }
 *   2. GET <url> with Bearer token → bytes
 */
export async function fetchMetaMedia(mediaId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error("Meta credentials missing — cannot fetch media");
  }

  const metaRes = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`Meta media metadata fetch failed ${metaRes.status}`);
  const meta = await metaRes.json() as { url: string; mime_type: string };

  const binRes = await fetch(meta.url, {
    headers: { "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!binRes.ok) throw new Error(`Meta media binary fetch failed ${binRes.status}`);
  const contentType = binRes.headers.get("content-type") ?? meta.mime_type ?? "application/octet-stream";
  const bytes = new Uint8Array(await binRes.arrayBuffer());
  return { bytes, contentType };
}
