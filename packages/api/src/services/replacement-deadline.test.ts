import { describe, expect, test } from "bun:test";
import { replacementReplyExpiresAt } from "./replacement-deadline.js";

describe("replacementReplyExpiresAt", () => {
  test("starts the 24h reply window from the worker notification instant", () => {
    const sentAt = new Date("2026-05-08T14:05:00.000Z");
    expect(replacementReplyExpiresAt(sentAt)).toBe("2026-05-09T14:05:00.000Z");
  });
});
