/**
 * Unit tests for the French date resolver.
 * Uses deterministic "today" injection via Date mocking.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveRelativeDate } from "./date-resolver.js";

// Fix "today" to Wednesday 2026-04-08 for deterministic tests
const FIXED_NOW = new Date(2026, 3, 8, 14, 30, 0); // Wed Apr 8 2026, 14:30

const OrigDate = globalThis.Date;

beforeEach(() => {
  // Mock Date constructor to return fixed date for new Date() (no args)
  const MockDate = function (...args: any[]) {
    if (args.length === 0) return new OrigDate(FIXED_NOW);
    // @ts-ignore
    return new OrigDate(...args);
  } as any;
  MockDate.prototype = OrigDate.prototype;
  MockDate.now = () => FIXED_NOW.getTime();
  MockDate.parse = OrigDate.parse;
  MockDate.UTC = OrigDate.UTC;
  globalThis.Date = MockDate;
});

afterEach(() => {
  globalThis.Date = OrigDate;
});

// ── Helpers ──

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// With fixed date = Wed 2026-04-08:
// Monday of this week = 2026-04-06
// Sunday of this week = 2026-04-12

describe("resolveRelativeDate", () => {
  // ── Null / empty ──
  describe("null / empty", () => {
    it("returns null for empty string", () => expect(resolveRelativeDate("")).toBeNull());
    it("returns null for null-ish", () => expect(resolveRelativeDate(null as any)).toBeNull());
    it("returns null for nonsense", () => expect(resolveRelativeDate("blurbleflurp")).toBeNull());
  });

  // ── ISO dates ──
  describe("ISO YYYY-MM-DD", () => {
    it("passes through valid ISO", () => expect(resolveRelativeDate("2026-04-10")).toBe("2026-04-10"));
    it("passes through past ISO", () => expect(resolveRelativeDate("2025-01-01")).toBe("2025-01-01"));
  });

  // ── DD/MM and DD/MM/YYYY ──
  describe("DD/MM and DD/MM/YYYY", () => {
    it("resolves 05/04/2026", () => expect(resolveRelativeDate("05/04/2026")).toBe("2026-04-05"));
    it("resolves 15/04 (future this month)", () => expect(resolveRelativeDate("15/04")).toBe("2026-04-15"));
    it("resolves 01/01 (past → next year)", () => expect(resolveRelativeDate("01/01")).toBe("2027-01-01"));
    it("resolves DD.MM.YYYY (dot separator)", () => expect(resolveRelativeDate("25.12.2026")).toBe("2026-12-25"));
    it("resolves single digits 5/4 (past → next year)", () => expect(resolveRelativeDate("5/4")).toBe("2027-04-05"));
  });

  // ── Relative days ──
  describe("relative days", () => {
    it("aujourd'hui", () => expect(resolveRelativeDate("aujourd'hui")).toBe("2026-04-08"));
    it("aujourdhui (no apostrophe)", () => expect(resolveRelativeDate("aujourdhui")).toBe("2026-04-08"));
    it("ajd (SMS)", () => expect(resolveRelativeDate("ajd")).toBe("2026-04-08"));
    it("ojd (SMS)", () => expect(resolveRelativeDate("ojd")).toBe("2026-04-08"));
    it("ce soir", () => expect(resolveRelativeDate("ce soir")).toBe("2026-04-08"));

    it("demain", () => expect(resolveRelativeDate("demain")).toBe("2026-04-09"));
    it("2main (SMS)", () => expect(resolveRelativeDate("2main")).toBe("2026-04-09"));
    it("2min (SMS)", () => expect(resolveRelativeDate("2min")).toBe("2026-04-09"));

    it("après-demain", () => expect(resolveRelativeDate("après-demain")).toBe("2026-04-10"));
    it("apres demain (no accent)", () => expect(resolveRelativeDate("apres demain")).toBe("2026-04-10"));
    it("après demain (space)", () => expect(resolveRelativeDate("après demain")).toBe("2026-04-10"));

    it("hier", () => expect(resolveRelativeDate("hier")).toBe("2026-04-07"));
    it("avant-hier", () => expect(resolveRelativeDate("avant-hier")).toBe("2026-04-06"));
    it("avant hier (space)", () => expect(resolveRelativeDate("avant hier")).toBe("2026-04-06"));
    it("avanthier (no separator)", () => expect(resolveRelativeDate("avanthier")).toBe("2026-04-06"));
  });

  // ── Day names ──
  // Fixed = Wednesday Apr 8
  describe("day names — next occurrence", () => {
    it("jeudi (tomorrow)", () => expect(resolveRelativeDate("jeudi")).toBe("2026-04-09"));
    it("vendredi (in 2 days)", () => expect(resolveRelativeDate("vendredi")).toBe("2026-04-10"));
    it("samedi (in 3 days)", () => expect(resolveRelativeDate("samedi")).toBe("2026-04-11"));
    it("dimanche (in 4 days)", () => expect(resolveRelativeDate("dimanche")).toBe("2026-04-12"));
    it("lundi (next week, diff < 0)", () => expect(resolveRelativeDate("lundi")).toBe("2026-04-13"));
    it("mardi (next week, diff < 0)", () => expect(resolveRelativeDate("mardi")).toBe("2026-04-14"));
    it("mercredi (same day → next week)", () => expect(resolveRelativeDate("mercredi")).toBe("2026-04-15"));
  });

  describe("day names — prochain", () => {
    it("lundi prochain", () => expect(resolveRelativeDate("lundi prochain")).toBe("2026-04-13"));
    it("vendredi prochain", () => expect(resolveRelativeDate("vendredi prochain")).toBe("2026-04-10"));
    it("mercredi prochain (same day → next week)", () => expect(resolveRelativeDate("mercredi prochain")).toBe("2026-04-15"));
    it("samedi prochain", () => expect(resolveRelativeDate("samedi prochain")).toBe("2026-04-11"));
  });

  describe("day names — dernier", () => {
    it("lundi dernier", () => expect(resolveRelativeDate("lundi dernier")).toBe("2026-04-06"));
    it("mardi dernier", () => expect(resolveRelativeDate("mardi dernier")).toBe("2026-04-07"));
    it("mercredi dernier (same day → last week)", () => expect(resolveRelativeDate("mercredi dernier")).toBe("2026-04-01"));
    it("vendredi dernier", () => expect(resolveRelativeDate("vendredi dernier")).toBe("2026-04-03"));
    it("samedi dernier", () => expect(resolveRelativeDate("samedi dernier")).toBe("2026-04-04"));
    it("dimanche dernier", () => expect(resolveRelativeDate("dimanche dernier")).toBe("2026-04-05"));
    it("vendredi passé", () => expect(resolveRelativeDate("vendredi passé")).toBe("2026-04-03"));
  });

  describe("day names — ce [jour]", () => {
    it("ce lundi (past this week)", () => expect(resolveRelativeDate("ce lundi")).toBe("2026-04-06"));
    it("ce mercredi (today)", () => expect(resolveRelativeDate("ce mercredi")).toBe("2026-04-08"));
    it("ce vendredi (future this week)", () => expect(resolveRelativeDate("ce vendredi")).toBe("2026-04-10"));
    it("ce samedi", () => expect(resolveRelativeDate("ce samedi")).toBe("2026-04-11"));
  });

  // ── dans N / il y a N ──
  describe("dans N / il y a N", () => {
    it("dans 3 jours", () => expect(resolveRelativeDate("dans 3 jours")).toBe("2026-04-11"));
    it("dans 1 jour", () => expect(resolveRelativeDate("dans 1 jour")).toBe("2026-04-09"));
    it("dans 10 jours", () => expect(resolveRelativeDate("dans 10 jours")).toBe("2026-04-18"));
    it("dans 2 semaines", () => expect(resolveRelativeDate("dans 2 semaines")).toBe("2026-04-22"));
    it("dans 1 semaine", () => expect(resolveRelativeDate("dans 1 semaine")).toBe("2026-04-15"));
    it("il y a 3 jours", () => expect(resolveRelativeDate("il y a 3 jours")).toBe("2026-04-05"));
    it("il y a 1 semaine", () => expect(resolveRelativeDate("il y a 1 semaine")).toBe("2026-04-01"));
    it("il y a 2 semaines", () => expect(resolveRelativeDate("il y a 2 semaines")).toBe("2026-03-25"));
  });

  // ── Week-relative ──
  // Monday of this week = 2026-04-06
  describe("week-relative", () => {
    it("cette semaine", () => expect(resolveRelativeDate("cette semaine")).toBe("2026-04-06"));
    it("semaine prochaine", () => expect(resolveRelativeDate("semaine prochaine")).toBe("2026-04-13"));
    it("semaine dernière", () => expect(resolveRelativeDate("semaine dernière")).toBe("2026-03-30"));
    it("la semaine (bare)", () => expect(resolveRelativeDate("la semaine")).toBe("2026-04-06"));
    // SMS variants
    it("samine prochene (SMS)", () => expect(resolveRelativeDate("samine prochene")).toBe("2026-04-13"));
    it("samaine derniere (SMS)", () => expect(resolveRelativeDate("samaine derniere")).toBe("2026-03-30"));
  });

  describe("semaine du [date]", () => {
    it("semaine du 14 avril", () => expect(resolveRelativeDate("semaine du 14 avril")).toBe("2026-04-13"));
    it("semaine du 1er mars", () => expect(resolveRelativeDate("semaine du 1 mars")).toBe("2026-02-23"));
    it("semaine du 20", () => expect(resolveRelativeDate("semaine du 20")).toBe("2026-04-20"));
  });

  // ── Weekend ──
  describe("weekend", () => {
    it("ce weekend", () => expect(resolveRelativeDate("ce weekend")).toBe("2026-04-11"));
    it("le weekend", () => expect(resolveRelativeDate("le weekend")).toBe("2026-04-11"));
    it("ce week-end", () => expect(resolveRelativeDate("ce week-end")).toBe("2026-04-11"));
    it("weekend prochain", () => expect(resolveRelativeDate("weekend prochain")).toBe("2026-04-11"));
  });

  // ── Month start/end ──
  describe("month start/end", () => {
    it("fin du mois (April → Apr 30)", () => expect(resolveRelativeDate("fin du mois")).toBe("2026-04-30"));
    it("fin avril", () => expect(resolveRelativeDate("fin avril")).toBe("2026-04-30"));
    it("fin mai", () => expect(resolveRelativeDate("fin mai")).toBe("2026-05-31"));
    it("fin février (non-leap)", () => expect(resolveRelativeDate("fin février")).toBe("2027-02-28"));
    it("fin de décembre", () => expect(resolveRelativeDate("fin de décembre")).toBe("2026-12-31"));
    it("début du mois", () => expect(resolveRelativeDate("début du mois")).toBe("2026-04-01"));
    it("début mai", () => expect(resolveRelativeDate("début mai")).toBe("2026-05-01"));
    it("début de janvier (past → next year)", () => expect(resolveRelativeDate("début de janvier")).toBe("2027-01-01"));
  });

  // ── mois prochain/dernier ──
  describe("mois prochain/dernier", () => {
    it("mois prochain", () => expect(resolveRelativeDate("mois prochain")).toBe("2026-05-01"));
    it("mois dernier", () => expect(resolveRelativeDate("mois dernier")).toBe("2026-03-01"));
  });

  // ── French dates ──
  describe("French dates", () => {
    it("1er janvier 2025", () => expect(resolveRelativeDate("1er janvier 2025")).toBe("2025-01-01"));
    it("15 avril", () => expect(resolveRelativeDate("15 avril")).toBe("2026-04-15"));
    it("5 mars 2026", () => expect(resolveRelativeDate("5 mars 2026")).toBe("2026-03-05"));
    it("25 décembre", () => expect(resolveRelativeDate("25 décembre")).toBe("2026-12-25"));
    it("1er août 2027", () => expect(resolveRelativeDate("1er août 2027")).toBe("2027-08-01"));
    it("3e avril", () => expect(resolveRelativeDate("3e avril")).toBe("2026-04-03"));
    it("15 janvier (past month → next year)", () => expect(resolveRelativeDate("15 janvier")).toBe("2027-01-15"));
  });

  // ── "le N" ──
  describe("le N", () => {
    it("le 15 (future this month)", () => expect(resolveRelativeDate("le 15")).toBe("2026-04-15"));
    it("le 3 (past this month → next month)", () => expect(resolveRelativeDate("le 3")).toBe("2026-05-03"));
    it("le 8 (today = 8th → today)", () => expect(resolveRelativeDate("le 8")).toBe("2026-04-08"));
    it("le 30", () => expect(resolveRelativeDate("le 30")).toBe("2026-04-30"));
  });

  // ── Embedded in longer text (LLM passes full phrases) ──
  describe("embedded in context", () => {
    it("qui travaille demain", () => expect(resolveRelativeDate("qui travaille demain")).toBe("2026-04-09"));
    it("le planning de la semaine prochaine", () => expect(resolveRelativeDate("le planning de la semaine prochaine")).toBe("2026-04-13"));
    it("service du vendredi prochain", () => expect(resolveRelativeDate("service du vendredi prochain")).toBe("2026-04-10"));
    it("congé fin avril", () => expect(resolveRelativeDate("congé fin avril")).toBe("2026-04-30"));
  });
});
