/**
 * Demo chat proxy — forwards messages to WhatsApp bot server.
 * Only accessible for authenticated users in demo restaurants.
 */
import { Hono } from "hono";
import { requireAuth, type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { restaurants, users } from "../db/schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import { rateLimit } from "../middleware/rate-limit.js";
import { isUsableDemoChatSecret } from "../utils/demo-secret.js";
import { listRestaurantMemberUserIds } from "../services/restaurant-context.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";

const WHATSAPP_URL = process.env.WHATSAPP_URL || "http://localhost:3002";
const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:8080";
const DEMO_CHAT_SECRET = process.env.DEMO_CHAT_SECRET;
const MAX_DEMO_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_DEMO_MESSAGE_CHARS = 1000;

const demoChatLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, message: "Trop de messages démo. Réessayez dans quelques minutes." });
const demoTranscribeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: "Trop de transcriptions démo. Réessayez dans quelques minutes." });

export function validateDemoAudioUpload(file: { size: number }): { ok: true } | { ok: false; error: string; status: 413 } {
  if (file.size > MAX_DEMO_AUDIO_BYTES) {
    return { ok: false, error: "Audio trop volumineux pour la démo", status: 413 };
  }
  return { ok: true };
}

export function validateDemoMessage(message: string): { ok: true } | { ok: false; error: string; status: 413 } {
  if (message.length > MAX_DEMO_MESSAGE_CHARS) {
    return { ok: false, error: "Message trop long pour la démo", status: 413 };
  }
  return { ok: true };
}

export const demoChatRoutes = new Hono<AppEnv>();

// All routes require auth + demo restaurant
demoChatRoutes.use("*", requireAuth);

async function isDemoRestaurant(restaurantId: string): Promise<boolean> {
  const row = db
    .select({ status: restaurants.status })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .get();
  return row?.status === "demo";
}

function getDemoSecret(): string | null {
  return isUsableDemoChatSecret(DEMO_CHAT_SECRET) ? DEMO_CHAT_SECRET : null;
}

function phoneBelongsToDemoRestaurant(phone: string, restaurantId: string): boolean {
  const memberIds = listRestaurantMemberUserIds(restaurantId);
  if (memberIds.length === 0) return false;
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, phone), inArray(users.id, memberIds), eq(users.active, true)))
    .get();
  return !!row;
}

// Get available demo phones (admin + kitchen + server from same restaurant)
demoChatRoutes.get("/phones", async (c) => {
  const restaurant = requestRestaurant(c);
  if (!(await isDemoRestaurant(restaurant.restaurantId))) {
    return c.json({ error: "Demo only" }, 403);
  }

  const memberIds = listRestaurantMemberUserIds(restaurant.restaurantId);
  const allUsers = memberIds.length === 0 ? [] : db
    .select({ id: users.id, name: users.name, phone: users.phone, role: users.role })
    .from(users)
    .where(inArray(users.id, memberIds))
    .all();

  const admin = allUsers.find((u) => u.role === "admin");
  const salles = allUsers.filter((u) => u.role === "floor");

  const fmt = (u: typeof allUsers[0]) => ({ name: u.name, phone: u.phone, role: u.role });

  return c.json({
    data: {
      admin: admin ? fmt(admin) : null,
      worker1: salles[0] ? fmt(salles[0]) : null,
      worker2: salles[1] ? fmt(salles[1]) : null,
    },
  });
});

// Forward chat message to WhatsApp bot
demoChatRoutes.post("/send", demoChatLimiter, async (c) => {
  const restaurant = requestRestaurant(c);
  if (!(await isDemoRestaurant(restaurant.restaurantId))) {
    return c.json({ error: "Demo only" }, 403);
  }

  const demoSecret = getDemoSecret();
  if (!demoSecret) return c.json({ error: "Demo chat secret not configured" }, 503);

  const { phone, message } = await c.req.json<{ phone: string; message: string }>();
  if (!phone || !message) {
    return c.json({ error: "phone and message required" }, 400);
  }
  const messageValidation = validateDemoMessage(message);
  if (!messageValidation.ok) return c.json({ error: messageValidation.error }, messageValidation.status);
  if (!phoneBelongsToDemoRestaurant(phone, restaurant.restaurantId)) {
    return c.json({ error: "Phone not available for this demo restaurant" }, 403);
  }

  try {
    const res = await fetch(`${WHATSAPP_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-demo-secret": demoSecret,
      },
      body: JSON.stringify({ phone, message, restaurantId: restaurant.restaurantId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      return c.json(err, res.status as any);
    }

    const data = await res.json();
    return c.json({ data });
  } catch (err: any) {
    console.error("[demo-chat proxy] Error:", err.message);
    return c.json({ error: "WhatsApp bot unavailable" }, 502);
  }
});

// Speech-to-text via whisper.cpp server
demoChatRoutes.post("/transcribe", demoTranscribeLimiter, async (c) => {
  const restaurant = requestRestaurant(c);
  if (!(await isDemoRestaurant(restaurant.restaurantId))) {
    return c.json({ error: "Demo only" }, 403);
  }

  try {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json({ error: "audio file required" }, 400);
    }
    const audioValidation = validateDemoAudioUpload(file);
    if (!audioValidation.ok) return c.json({ error: audioValidation.error }, audioValidation.status);

    // Convert webm/ogg → wav using ffmpeg (whisper.cpp needs wav)
    const tmpId = randomUUID();
    const inputPath = `/tmp/stt-${tmpId}.webm`;
    const outputPath = `/tmp/stt-${tmpId}.wav`;

    try {
      const arrayBuf = await file.arrayBuffer();
      await Bun.write(inputPath, arrayBuf);

      const proc = Bun.spawn(["ffmpeg", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outputPath], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;

      if (!existsSync(outputPath)) {
        return c.json({ error: "Audio conversion failed" }, 400);
      }

      // Send wav to whisper.cpp
      const wavFile = Bun.file(outputPath);
      const formData = new FormData();
      formData.append("file", wavFile, "audio.wav");
      formData.append("language", "fr");
      formData.append("response_format", "json");

      const res = await fetch(`${WHISPER_URL}/inference`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.text();
        console.error("[whisper proxy] Error:", res.status, err);
        return c.json({ error: "Transcription failed" }, 502);
      }

      const data = await res.json() as { text: string };
      return c.json({ data: { text: data.text } });
    } finally {
      // Cleanup temp files
      try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch {}
      try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {}
    }
  } catch (err: any) {
    console.error("[whisper proxy] Error:", err.message);
    return c.json({ error: "Whisper unavailable" }, 502);
  }
});

// Poll notifications — proxy to WhatsApp bot (which has the correct DB)
demoChatRoutes.get("/notifications", async (c) => {
  const restaurant = requestRestaurant(c);
  if (!(await isDemoRestaurant(restaurant.restaurantId))) {
    return c.json({ error: "Demo only" }, 403);
  }

  const demoSecret = getDemoSecret();
  if (!demoSecret) return c.json({ error: "Demo chat secret not configured" }, 503);

  const phone = c.req.query("phone");
  const since = c.req.query("since");
  if (!phone || !since) {
    return c.json({ error: "phone and since required" }, 400);
  }
  if (!phoneBelongsToDemoRestaurant(phone, restaurant.restaurantId)) {
    return c.json({ data: { notifications: [] } });
  }

  try {
    const params = new URLSearchParams({
      phone,
      since,
      restaurantId: restaurant.restaurantId,
    });
    const res = await fetch(
      `${WHATSAPP_URL}/chat/notifications?${params.toString()}`,
      { headers: { "x-demo-secret": demoSecret } },
    );
    if (!res.ok) return c.json({ data: { notifications: [] } });
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ data: { notifications: [] } });
  }
});

// Clear chat history
demoChatRoutes.post("/clear", async (c) => {
  const restaurant = requestRestaurant(c);
  if (!(await isDemoRestaurant(restaurant.restaurantId))) {
    return c.json({ error: "Demo only" }, 403);
  }

  const demoSecret = getDemoSecret();
  if (!demoSecret) return c.json({ error: "Demo chat secret not configured" }, 503);

  const { phone } = await c.req.json<{ phone: string }>();
  if (!phone || !phoneBelongsToDemoRestaurant(phone, restaurant.restaurantId)) {
    return c.json({ error: "Phone not available for this demo restaurant" }, 403);
  }

  try {
    const res = await fetch(`${WHATSAPP_URL}/chat/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-demo-secret": demoSecret,
      },
      body: JSON.stringify({ phone, restaurantId: restaurant.restaurantId }),
    });

    if (!res.ok) {
      return c.json({ error: "Failed to clear" }, res.status as any);
    }

    return c.json({ data: { ok: true } });
  } catch {
    return c.json({ error: "WhatsApp bot unavailable" }, 502);
  }
});
