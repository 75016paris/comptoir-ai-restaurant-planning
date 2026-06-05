import { describe, expect, test } from "bun:test";
import { assertDemoChatSecretForProduction, isUsableDemoChatSecret } from "./demo-secret.js";

describe("DEMO_CHAT_SECRET guard", () => {
  test("rejects missing and default secrets", () => {
    expect(isUsableDemoChatSecret(undefined)).toBe(false);
    expect(isUsableDemoChatSecret("dev-demo-secret")).toBe(false);
  });

  test("fails startup in production-like environments", () => {
    expect(() => assertDemoChatSecretForProduction({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow("DEMO_CHAT_SECRET");
    expect(() => assertDemoChatSecretForProduction({ NODE_ENV: "staging", DEMO_CHAT_SECRET: "dev-demo-secret" } as NodeJS.ProcessEnv)).toThrow("DEMO_CHAT_SECRET");
  });

  test("allows local development without a secret", () => {
    expect(() => assertDemoChatSecretForProduction({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertDemoChatSecretForProduction({ NODE_ENV: "production", DEMO_CHAT_SECRET: "rotated-secret" } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
