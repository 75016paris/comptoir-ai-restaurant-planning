import { describe, expect, test } from "bun:test";
import { calendarDaysBetween, formatInstantInTimeZone, todayInTimeZone, zonedDateTimeToUtc } from "./date-time.js";

describe("restaurant timezone helpers", () => {
  test("todayInTimeZone uses the restaurant day, not the server day", () => {
    expect(todayInTimeZone("Europe/Paris", new Date("2026-05-08T22:30:00.000Z"))).toBe("2026-05-09");
  });

  test("formatInstantInTimeZone formats UTC instants in restaurant time", () => {
    expect(formatInstantInTimeZone("2026-05-08T14:05:00.000Z", "fr-FR", "Europe/Paris")).toContain("16:05");
  });

  test("zonedDateTimeToUtc handles French summer offset", () => {
    expect(zonedDateTimeToUtc("2026-05-08", "16:05", "Europe/Paris").toISOString()).toBe("2026-05-08T14:05:00.000Z");
  });

  test("calendarDaysBetween compares date-only business days", () => {
    expect(calendarDaysBetween("2026-05-08", "2026-05-23")).toBe(15);
    expect(calendarDaysBetween("2026-05-10", "2026-05-08")).toBe(-2);
  });
});
