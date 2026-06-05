/**
 * One-shot: send a monthly digest email to TO using the local DB + SMTP env.
 * Picks the first restaurant unless RESTAURANT_ID is set.
 *
 *   cd packages/api && TO=paulyacha@gmail.com bun run scripts/test-monthly-digest.ts
 *   TO=foo@bar.com MONTH=2026-04 RESTAURANT_ID=... bun run scripts/test-monthly-digest.ts
 */
import { computeMonthlyDigest, lastCompletedMonth } from "../../../src/services/monthly-digest.js";
import { sendMonthlyDigestEmail } from "../../../src/services/email.js";
import { db } from "../../../src/db/connection.js";
import { restaurants } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";

const TO = process.env.TO || "paulyacha@gmail.com";
const MONTH = process.env.MONTH || lastCompletedMonth();
const RESTAURANT_ID = process.env.RESTAURANT_ID;

const r = RESTAURANT_ID
  ? db.select({ id: restaurants.id, name: restaurants.name })
      .from(restaurants).where(eq(restaurants.id, RESTAURANT_ID)).get()
  : db.select({ id: restaurants.id, name: restaurants.name })
      .from(restaurants).get();

if (!r) { console.error("no restaurant found"); process.exit(1); }

console.log(`restaurant: ${r.id}  ${r.name}`);
console.log(`month:      ${MONTH}`);
console.log(`to:         ${TO}\n`);

const digest = computeMonthlyDigest(r.id, MONTH);
if (!digest) { console.error("computeMonthlyDigest returned null"); process.exit(1); }

console.log("digest summary:", JSON.stringify({
  hours: digest.hours,
  overtime: digest.overtime,
  coverage: digest.coverage,
  leave: digest.leave,
  workerCount: digest.workers.length,
  topWorkers: digest.workers.slice(0, 3).map(w => `${w.name} (${w.role}) ${w.totalHours}h${w.overtimeHours > 0 ? ` +${w.overtimeHours} HS` : ""}`),
  cancellations: digest.cancellations,
  replacements: digest.replacements,
  lateness: { incidents: digest.lateness.incidents, totalLateMin: digest.lateness.totalLateMinutes, totalEarlyMin: digest.lateness.totalEarlyLeaveMinutes, top: digest.lateness.topWorkers.length },
  docs: { expired: digest.docs.expiredCount, expiringSoon: digest.docs.expiringSoonCount, top: digest.docs.topItems.length },
  contractsEndingNextMonth: digest.contracts.endingNextMonth.length,
}, null, 2));
console.log("");

const ok = await sendMonthlyDigestEmail(TO, digest);
console.log(ok ? `✓ sent to ${TO}` : `✗ send failed (check SMTP env)`);
process.exit(ok ? 0 : 1);
