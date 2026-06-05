import { describe, test, expect } from "bun:test";
import { normalizeSms } from "./sms-normalize.js";

describe("normalizeSms", () => {
  // ── Single word mappings ──

  test("2min → demain", () => {
    expect(normalizeSms("2min")).toBe("demain");
  });

  test("2main → demain", () => {
    expect(normalizeSms("2main")).toBe("demain");
  });

  test("cb → combien", () => {
    expect(normalizeSms("cb")).toBe("combien");
  });

  test("pr → pour", () => {
    expect(normalizeSms("pr")).toBe("pour");
  });

  test("ki → qui", () => {
    expect(normalizeSms("ki")).toBe("qui");
  });

  test("kel → quel", () => {
    expect(normalizeSms("kel")).toBe("quel");
  });

  test("kan → quand", () => {
    expect(normalizeSms("kan")).toBe("quand");
  });

  test("samine → semaine", () => {
    expect(normalizeSms("samine")).toBe("semaine");
  });

  test("prochene → prochaine", () => {
    expect(normalizeSms("prochene")).toBe("prochaine");
  });

  test("atan → attente", () => {
    expect(normalizeSms("atan")).toBe("attente");
  });

  test("conger → congé", () => {
    expect(normalizeSms("conger")).toBe("congé");
  });

  test("travay → travaille", () => {
    expect(normalizeSms("travay")).toBe("travaille");
  });

  test("planing → planning", () => {
    expect(normalizeSms("planing")).toBe("planning");
  });

  test("fé → fait", () => {
    expect(normalizeSms("fé")).toBe("fait");
  });

  test("tan → temps", () => {
    expect(normalizeSms("tan")).toBe("temps");
  });

  // ── Compound patterns ──

  test("jbosse → je bosse", () => {
    expect(normalizeSms("jbosse")).toBe("je bosse");
  });

  test("jboss → je bosse", () => {
    expect(normalizeSms("jboss")).toBe("je bosse");
  });

  test("dheures → d'heures", () => {
    expect(normalizeSms("dheures")).toBe("d'heures");
  });

  test("ya → il y a", () => {
    expect(normalizeSms("ya")).toBe("il y a");
  });

  test("ojd → aujourd'hui", () => {
    expect(normalizeSms("ojd")).toBe("aujourd'hui");
  });

  test("ajd → aujourd'hui", () => {
    expect(normalizeSms("ajd")).toBe("aujourd'hui");
  });

  // ── Full sentences (bench scenarios) ──

  test("ki bosse 2min → qui bosse demain", () => {
    expect(normalizeSms("ki bosse 2min")).toBe("qui bosse demain");
  });

  test("planing samine prochene → planning semaine prochaine", () => {
    expect(normalizeSms("planing samine prochene")).toBe("planning semaine prochaine");
  });

  test("cb dheures pr omar → combien d'heures pour omar", () => {
    expect(normalizeSms("cb dheures pr omar")).toBe("combien d'heures pour omar");
  });

  test("ya de conger en atan → il y a de congé en attente", () => {
    expect(normalizeSms("ya de conger en atan")).toBe("il y a de congé en attente");
  });

  test("kel tan il fé 2min → quel temps il fait demain", () => {
    expect(normalizeSms("kel tan il fé 2min")).toBe("quel temps il fait demain");
  });

  test("kan je travay cet samine → quand je travaille cet semaine", () => {
    expect(normalizeSms("kan je travay cet samine")).toBe("quand je travaille cet semaine");
  });

  test("jboss kan 2min → je bosse quand demain", () => {
    expect(normalizeSms("jboss kan 2min")).toBe("je bosse quand demain");
  });

  test("ajd on et conbien o travay → aujourd'hui on et combien o travaille", () => {
    expect(normalizeSms("ajd on et conbien o travay")).toBe("aujourd'hui on et combien o travaille");
  });

  test("combian de gens en cuisine → combien de gens en cuisine", () => {
    expect(normalizeSms("combian de gens en cuisine")).toBe("combien de gens en cuisine");
  });

  test("met Dujardin 2min midi → mets Dujardin demain midi", () => {
    expect(normalizeSms("met Dujardin 2min midi")).toBe("mets Dujardin demain midi");
  });

  // ── No-op on proper French ──

  test("proper French unchanged: combien", () => {
    expect(normalizeSms("Combien d'heures pour Omar ?")).toBe("Combien d'heures pour Omar ?");
  });

  test("proper French unchanged: demain", () => {
    expect(normalizeSms("Qui bosse demain ?")).toBe("Qui bosse demain ?");
  });

  test("proper French unchanged: semaine prochaine", () => {
    expect(normalizeSms("Le planning de la semaine prochaine")).toBe("Le planning de la semaine prochaine");
  });

  // ── False positive safety: names ──

  test("employee name Omar unchanged", () => {
    expect(normalizeSms("Heures d'Omar ce mois")).toBe("Heures d'Omar ce mois");
  });

  test("employee name Marion unchanged", () => {
    expect(normalizeSms("Marion travaille demain")).toBe("Marion travaille demain");
  });

  test("employee name Dujardin unchanged", () => {
    expect(normalizeSms("Dujardin est en congé")).toBe("Dujardin est en congé");
  });

  // ── Case insensitivity ──

  test("case insensitive: KI BOSSE 2MIN", () => {
    expect(normalizeSms("KI BOSSE 2MIN")).toBe("qui BOSSE demain");
  });

  test("case insensitive: Cb Dheures", () => {
    expect(normalizeSms("Cb Dheures")).toBe("combien d'heures");
  });
});
