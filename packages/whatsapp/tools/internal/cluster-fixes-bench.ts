/**
 * Re-test the 32B failure clusters fixed on 2026-04-29:
 *   - add_service template-fragment leak (#52, #64, #428(removed), #818, #822, #825)
 *   - DD/MM date format ("personne" vs "service" / day-of-week) (#12, #407, #694, #695)
 *
 * Usage:
 *   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=qwen3-32b \
 *     bun run tools/internal/cluster-fixes-bench.ts
 */
import { resolveIdentity } from "../../src/identity.js";
import { runAgent } from "../../src/agent.js";
import { db, chatMessages } from "../../src/db.js";
import { eq } from "drizzle-orm";

const MODEL = process.env.OLLAMA_MODEL || "qwen3:14b";
const PROFILE = process.env.AGENT_PROFILE || "legacy_14b";

function hasAny(r: string, ...words: string[]): boolean {
  const l = r.toLowerCase();
  return words.some(w => l.includes(w.toLowerCase()));
}
function hasDate(r: string): boolean {
  return /\d{4}-\d{2}-\d{2}/.test(r) || /lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche/i.test(r);
}
function clearHistory(userId: string) {
  db.delete(chatMessages).where(eq(chatMessages.userId, userId)).run();
}

const R1_ADMIN  = "+33600100001";
const R2_ADMIN  = "+33600200001";
const R1_OMAR   = "+33600100005";

type Step = { send: string; check: (r: string) => "PASS" | "FAIL" };
type Test = { id: number; cat: string; name: string; phone: string; steps: Step[] };

// add_service tests use "Matin" — a zone that doesn't exist in R2 (Midi/Soir/Coupure).
// After the fix, the bot must ask the user to clarify with one of the available zones.
const passZoneAsk = (worker: string) => (r: string): "PASS" | "FAIL" =>
  hasAny(r, "midi", "soir", "coupure") && hasAny(r, "zone", "quelle", "préciser", worker.toLowerCase()) ? "PASS" : "FAIL";

const TESTS: Test[] = [
  {
    id: 52, cat: "admin-add-service", name: "R2 Add De Niro matin 06-15", phone: R2_ADMIN,
    steps: [{ send: "Ajoute De Niro en Matin le 2026-06-15", check: passZoneAsk("de niro") }],
  },
  {
    id: 64, cat: "admin-add-service", name: "R2 Add Streep matin 06-19", phone: R2_ADMIN,
    steps: [{ send: "Ajoute Meryl Streep en Matin le 2026-06-19", check: passZoneAsk("streep") }],
  },
  {
    id: 818, cat: "gen-add-service", name: "R2 Add De Niro Matin 2026-08-12", phone: R2_ADMIN,
    steps: [{ send: "Ajoute De Niro en Matin le 2026-08-12", check: passZoneAsk("de niro") }],
  },
  {
    id: 822, cat: "gen-add-service", name: "R2 Add Pitt Matin 2026-08-16", phone: R2_ADMIN,
    steps: [{ send: "Ajoute Pitt en Matin le 2026-08-16", check: passZoneAsk("pitt") }],
  },
  {
    id: 825, cat: "gen-add-service", name: "R2 Add Chalamet Soir 2026-08-19 (now Jolie)", phone: R2_ADMIN,
    // Chalamet was removed; reuse the spirit of the test with Jolie + Matin (still non-existent zone)
    steps: [{ send: "Ajoute Jolie en Matin le 2026-08-19", check: passZoneAsk("jolie") }],
  },
  // DD/MM and "20 avril" date tests — bot should now say day-of-week.
  {
    id: 12, cat: "admin-schedule", name: "French date format", phone: R1_ADMIN,
    steps: [{ send: "Le planning du 20 avril", check: r => hasDate(r) || hasAny(r, "service", "aucun") ? "PASS" : "FAIL" }],
  },
  {
    id: 407, cat: "admin-schedule", name: "DD/MM format", phone: R1_ADMIN,
    steps: [{ send: "Le planning du 20/04", check: r => hasDate(r) || hasAny(r, "service", "aucun") ? "PASS" : "FAIL" }],
  },
  {
    id: 694, cat: "gen-admin-dates", name: "R1 date: L'équipe du 20/04", phone: R1_ADMIN,
    steps: [{ send: "L'équipe du 20/04", check: r => hasDate(r) || hasAny(r, "service", "aucun") ? "PASS" : "FAIL" }],
  },
  {
    id: 695, cat: "gen-admin-dates", name: "R2 date: L'équipe du 20/04", phone: R2_ADMIN,
    steps: [{ send: "L'équipe du 20/04", check: r => hasDate(r) || hasAny(r, "service", "aucun") ? "PASS" : "FAIL" }],
  },
];

console.log(`\n══ cluster-fixes mini-bench ══`);
console.log(`  model:   ${MODEL}`);
console.log(`  profile: ${PROFILE}`);
console.log(`  tests:   ${TESTS.length}\n`);

let pass = 0;
for (const t of TESTS) {
  const r = await resolveIdentity(t.phone);
  if (!r.ok) { console.error(`  #${t.id} identity error (${t.phone})`); continue; }
  const id = r.identity;
  clearHistory(id.userId);

  let lastReply = "";
  let stepStatus: "PASS" | "FAIL" = "PASS";
  for (const step of t.steps) {
    lastReply = await runAgent(id, step.send);
    if (step.check(lastReply) === "FAIL") { stepStatus = "FAIL"; break; }
  }
  if (stepStatus === "PASS") pass++;

  const icon = stepStatus === "PASS" ? "✅" : "❌";
  console.log(`${icon} #${t.id} [${t.cat}] ${t.name}`);
  console.log(`   Q: ${t.steps[t.steps.length - 1].send}`);
  console.log(`   A: ${lastReply.replace(/\n/g, " ").slice(0, 220)}`);
  console.log();
}

console.log(`══ result: ${pass}/${TESTS.length} PASS ══\n`);
process.exit(pass === TESTS.length ? 0 : 1);
