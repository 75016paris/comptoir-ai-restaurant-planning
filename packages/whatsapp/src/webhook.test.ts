import { describe, expect, test } from "bun:test";
import { assertMetaWebhookConfig, extractIncomingText, identityFailureReply, matchRestaurantMention, validateMetaSignatureHeader } from "./webhook.js";

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

describe("Meta webhook signature validation", () => {
  test("rejects missing WHATSAPP_APP_SECRET in production", async () => {
    const ok = await validateMetaSignatureHeader(undefined, "{}", { NODE_ENV: "production" });

    expect(ok).toBe(false);
  });

  test("startup sanity check refuses production/staging without secret", () => {
    expect(() => assertMetaWebhookConfig({ NODE_ENV: "staging" })).toThrow("WHATSAPP_APP_SECRET is required");
  });

  test("rejects invalid signatures", async () => {
    const ok = await validateMetaSignatureHeader("sha256=bad", "{}", {
      NODE_ENV: "production",
      WHATSAPP_APP_SECRET: "secret",
    });

    expect(ok).toBe(false);
  });

  test("accepts valid signatures", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const digest = await hmacSha256Hex("secret", body);
    const ok = await validateMetaSignatureHeader(`sha256=${digest}`, body, {
      NODE_ENV: "production",
      WHATSAPP_APP_SECRET: "secret",
    });

    expect(ok).toBe(true);
  });
});

describe("Meta webhook button parsing", () => {
  test("maps quick-reply payloads to text the agent already understands", () => {
    expect(extractIncomingText({ from: "336", id: "m1", timestamp: "1", type: "button", button: { text: "Oui, je prends", payload: "OPEN_SHIFT_YES" } })).toBe("oui");
    expect(extractIncomingText({ from: "336", id: "m2", timestamp: "1", type: "interactive", interactive: { button_reply: { id: "VIEW_SCHEDULE", title: "Voir mon planning" } } })).toBe("Voir mon planning");
  });

  test("maps leave-proposal button payloads to oui/non", () => {
    expect(extractIncomingText({ from: "336", id: "m3", timestamp: "1", type: "interactive", interactive: { button_reply: { id: "LEAVE_PROPOSAL_YES", title: "Accepter" } } })).toBe("oui");
    expect(extractIncomingText({ from: "336", id: "m4", timestamp: "1", type: "interactive", interactive: { button_reply: { id: "LEAVE_PROPOSAL_NO", title: "Refuser" } } })).toBe("non");
  });

  test("falls back to bare 'Accepter'/'Refuser' button titles when no payload was attached", () => {
    expect(extractIncomingText({ from: "336", id: "m5", timestamp: "1", type: "interactive", interactive: { button_reply: { title: "Accepter" } } })).toBe("oui");
    expect(extractIncomingText({ from: "336", id: "m6", timestamp: "1", type: "interactive", interactive: { button_reply: { title: "Refuser" } } })).toBe("non");
  });
});

describe("Meta webhook identity failures", () => {
  test("keeps API context-selection copy for ambiguous WhatsApp phones", () => {
    expect(identityFailureReply({
      ok: false,
      blocked: false,
      code: "RESTAURANT_CONTEXT_REQUIRED",
      message: "Votre numéro est associé à plusieurs restaurants. Choisissez le restaurant avant de continuer.",
      restaurants: [
        { id: "resto-1", name: "Resto 1", status: "active" },
        { id: "resto-2", name: "Resto 2", status: "active" },
      ],
    })).toBe([
      "Votre numéro est associé à plusieurs restaurants. Choisissez le restaurant avant de continuer.",
      "",
      "Répondez avec le nom du restaurant :",
      "- Resto 1",
      "- Resto 2",
    ].join("\n"));
  });

  test("keeps blocked identity copy and falls back for unknown phones", () => {
    expect(identityFailureReply({ ok: false, blocked: true, message: "Compte bloqué." })).toBe("Compte bloqué.");
    expect(identityFailureReply({ ok: false, blocked: false })).toBe("Numéro non reconnu. Demande à ton responsable d'enregistrer ton numéro dans Comptoir.");
  });
});

describe("Meta webhook restaurant mention matching", () => {
  const restaurants = [
    { id: "resto-1", name: "Comptoir République" },
    { id: "resto-2", name: "Chez Léon - Bastille" },
  ];

  test("matches exactly one named restaurant in an ambiguous text message", () => {
    expect(matchRestaurantMention("Chez Leon Bastille pour demain", restaurants)).toBe("resto-2");
    expect(matchRestaurantMention("planning comptoir republique", restaurants)).toBe("resto-1");
  });

  test("does not guess when the mention is absent or ambiguous", () => {
    expect(matchRestaurantMention("mon planning demain", restaurants)).toBeNull();
    expect(matchRestaurantMention("Comptoir République et Chez Léon Bastille", restaurants)).toBeNull();
  });
});
