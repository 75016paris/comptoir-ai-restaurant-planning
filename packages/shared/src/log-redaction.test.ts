import { describe, expect, test } from "bun:test";
import { formatLogMessagePreview, formatLogObject, redactSensitiveString } from "./log-redaction.js";

describe("log redaction", () => {
  test("redacts token-bearing paths and query params", () => {
    expect(redactSensitiveString("GET /public/onboarding/abc123?x=1 /reset-password?token=def456 /dossier/ghi789?hub.verify_token=meta-secret"))
      .toBe("GET /public/onboarding/[redacted]?x=1 /reset-password?token=[redacted] /dossier/[redacted]?hub.verify_token=[redacted]");
  });

  test("redacts contact query params, emails, and phone numbers", () => {
    expect(redactSensitiveString("POST /chat?phone=+33612345678&email=a@example.com to +33 6 12 34 56 78 / 0612345678 user test@example.fr"))
      .toBe("POST /chat?phone=[redacted]&email=[redacted] to [phone:redacted] / [phone:redacted] user [email:redacted]");
  });

  test("redacts message previews and object values in production-like environments", () => {
    const env = { NODE_ENV: "production" };
    expect(formatLogMessagePreview("hello +33612345678", env)).toBe("[message:redacted chars=18]");
    expect(formatLogObject({ workerName: "Jane", message: "secret" }, env)).toBe("[object:redacted keys=workerName,message]");
  });
});
