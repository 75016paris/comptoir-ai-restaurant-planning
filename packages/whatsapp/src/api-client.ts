import type { ToolContext } from "./tools/types.js";

const DEFAULT_INTERNAL_PREFIX = "/internal/whatsapp";

export class WhatsAppApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

function baseUrl(): string {
  return (process.env.API_INTERNAL_URL || "http://localhost:3000").replace(/\/+$/, "");
}

function internalPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.startsWith("/internal/whatsapp") || normalized.startsWith("/api/internal/whatsapp")) {
    return normalized;
  }
  return `${DEFAULT_INTERNAL_PREFIX}${normalized}`;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function apiRequest<T>(method: "GET" | "POST", path: string, body: unknown, ctx?: ToolContext): Promise<T> {
  const secret = process.env.WHATSAPP_INTERNAL_API_SECRET || "";
  if (!secret) {
    throw new WhatsAppApiError(0, "WHATSAPP_INTERNAL_API_SECRET is not configured");
  }

  const headers: Record<string, string> = {
    "Accept": "application/json",
    "X-WhatsApp-Internal-Secret": secret,
  };
  if (ctx) {
    headers["X-Comptoir-User-Id"] = ctx.userId;
    headers["X-Comptoir-Restaurant-Id"] = ctx.restaurantId;
  }
  const init: RequestInit = { method, headers };

  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }

  const res = await fetch(`${baseUrl()}${internalPath(path)}`, init);
  const parsed = await parseBody(res);

  if (!res.ok) {
    const message = typeof parsed === "object" && parsed && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `Internal API request failed with ${res.status}`;
    throw new WhatsAppApiError(res.status, message, parsed);
  }

  return parsed as T;
}

export function apiGet<T>(path: string, ctx: ToolContext): Promise<T> {
  return apiRequest<T>("GET", path, undefined, ctx);
}

export function apiPost<T>(path: string, body: unknown, ctx: ToolContext): Promise<T> {
  return apiRequest<T>("POST", path, body, ctx);
}

export function apiPostInternal<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>("POST", path, body);
}
