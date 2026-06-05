/**
 * Speech-to-text via DeepInfra's OpenAI-compatible audio endpoint.
 * Receives raw OGG/Opus bytes from Meta voice notes, returns plain French text.
 *
 * The same OPENAI_API_KEY used by agent.ts works here — DeepInfra accepts one
 * key across the chat + audio endpoints.
 */

import { formatLogMessagePreview } from "@comptoir/shared";

function sttBaseUrl(): string { return process.env.STT_BASE_URL || "https://api.deepinfra.com/v1/openai"; }
function sttModel(): string { return process.env.STT_MODEL || "openai/whisper-large-v3-turbo"; }
function sttApiKey(): string { return process.env.STT_API_KEY || process.env.OPENAI_API_KEY || ""; }
function sttLanguage(): string { return process.env.STT_LANGUAGE || "fr"; }

/** Best-effort filename for the multipart upload — Whisper inspects the extension. */
function filenameForMime(mime: string): string {
  if (mime.includes("ogg")) return "voice.ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "voice.mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "voice.m4a";
  if (mime.includes("wav")) return "voice.wav";
  if (mime.includes("webm")) return "voice.webm";
  return "voice.ogg";
}

/**
 * Transcribe an audio buffer to text. Throws on transport / 5xx errors so the
 * caller can decide what to tell the user.
 */
export async function transcribeAudio(bytes: Uint8Array, mimeType: string): Promise<string> {
  const key = sttApiKey();
  if (!key) {
    throw new Error("STT misconfigured: STT_API_KEY (or OPENAI_API_KEY) is required");
  }
  const language = sttLanguage();
  const model = sttModel();

  const form = new FormData();
  const blob = new Blob([bytes as BlobPart], { type: mimeType || "audio/ogg" });
  form.append("file", blob, filenameForMime(mimeType));
  form.append("model", model);
  if (language) form.append("language", language);
  form.append("response_format", "json");

  const url = `${sttBaseUrl().replace(/\/$/, "")}/audio/transcriptions`;
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`STT ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json() as { text?: string };
  const text = (data.text || "").trim();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[stt] ${bytes.byteLength}B ${mimeType} → ${text.length} chars in ${elapsed}s · ${formatLogMessagePreview(text)}`);
  return text;
}

export function isSttConfigured(): boolean {
  return !!sttApiKey();
}
