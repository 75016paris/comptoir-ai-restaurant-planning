/**
 * Phone → User identity resolution.
 * The security boundary lives in the API; WhatsApp only calls the internal
 * identity endpoint with the server-owned internal secret.
 */
import { apiPostInternal } from "./api-client.js";

export type Identity = {
  userId: string;
  name: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  restaurantId: string;
  restaurantName: string;
  restaurantTimezone: string;
  phone: string;
  permissions: string | null; // JSON-stringified Partial<Record<Permission, boolean>>; null = role default
};

export type IdentityResult =
  | { ok: true; identity: Identity }
  | { ok: false; blocked: true; message: string }
  | {
      ok: false;
      blocked: false;
      code?: "RESTAURANT_CONTEXT_REQUIRED" | string;
      message?: string;
      restaurants?: Array<{ id: string; name: string; status?: string }>;
    };

type InternalIdentityRow = Identity & {
  restaurantStatus?: string;
  subscriptionStatus?: string;
};

type InternalIdentityResponse =
  | { ok: true; identity: InternalIdentityRow }
  | { ok: false; blocked: true; message: string }
  | { ok: false; blocked: false };

function toIdentity(row: InternalIdentityRow): Identity {
  return {
    userId: row.userId,
    name: row.name,
    role: row.role,
    restaurantId: row.restaurantId,
    restaurantName: row.restaurantName,
    restaurantTimezone: row.restaurantTimezone,
    phone: row.phone,
    permissions: row.permissions,
  };
}

/**
 * Resolve a phone number to a Comptoir user.
 * Returns { ok, identity, blocked, message } for the webhook to handle.
 */
export async function resolveIdentity(rawPhone: string, restaurantId?: string | null): Promise<IdentityResult> {
  const body = restaurantId ? { phone: rawPhone, restaurantId } : { phone: rawPhone };
  const result = await apiPostInternal<InternalIdentityResponse>("/identity/resolve", body);
  if (!result.ok) return result;
  return { ok: true, identity: toIdentity(result.identity) };
}
