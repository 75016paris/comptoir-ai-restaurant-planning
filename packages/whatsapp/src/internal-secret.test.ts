import { describe, expect, test } from "bun:test";
import { assertInternalRouteSecretForProduction, isUsableDemoChatSecret } from "./internal-secret.js";

describe("WhatsApp internal route secret guard", () => {
  test("rejects missing and default secrets", () => {
    expect(isUsableDemoChatSecret(undefined)).toBe(false);
    expect(isUsableDemoChatSecret("dev-demo-secret")).toBe(false);
  });

  test("fails startup in production-like environments", () => {
    expect(() => assertInternalRouteSecretForProduction({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow("DEMO_CHAT_SECRET");
    expect(() => assertInternalRouteSecretForProduction({ NODE_ENV: "staging", DEMO_CHAT_SECRET: "dev-demo-secret" } as NodeJS.ProcessEnv)).toThrow("DEMO_CHAT_SECRET");
  });

  test("allows local development without a secret", () => {
    expect(() => assertInternalRouteSecretForProduction({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertInternalRouteSecretForProduction({ NODE_ENV: "production", DEMO_CHAT_SECRET: "rotated-secret" } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
