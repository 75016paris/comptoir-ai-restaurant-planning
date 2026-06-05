#!/usr/bin/env bun
/**
 * One-shot chat — send a single message, get the reply.
 * Usage: bun run src/chat.ts <phone> <message>
 *        bun run src/chat.ts --clear <phone>     # clear history
 *        bun run src/chat.ts --db-check <query>   # raw SQL select
 */
import { resolveIdentity } from "./identity.js";
import { runAgent } from "./agent.js";
import { db, chatMessages, services, holidayRequests, restaurantClosures, replacementRequests, users } from "./db.js";
import { eq, and, gte, ne, desc, sql } from "drizzle-orm";

const args = process.argv.slice(2);

// Clear history mode
if (args[0] === "--clear") {
  const phone = args[1];
  const result = await resolveIdentity(phone);
  if (result.ok) {
    db.delete(chatMessages).where(eq(chatMessages.userId, result.identity.userId)).run();
    console.log(`🧹 History cleared for ${result.identity.name}`);
  }
  process.exit(0);
}

// DB check mode — check services/holidays/closures for a date + restaurant
if (args[0] === "--db-services") {
  const restaurantId = args[1];
  const date = args[2];
  const rows = db.select({ workerName: users.name, date: services.date, start: services.startTime, end: services.endTime, status: services.status, role: services.role })
    .from(services).innerJoin(users, eq(services.workerId, users.id))
    .where(and(eq(services.restaurantId, restaurantId), date ? eq(services.date, date) : gte(services.date, "2026-06-01"), ne(services.status, "cancelled")))
    .orderBy(services.date, services.startTime).all();
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (args[0] === "--db-holidays") {
  const restaurantId = args[1];
  const rows = db.select({ workerName: users.name, start: holidayRequests.startDate, end: holidayRequests.endDate, status: holidayRequests.status, reason: holidayRequests.reason })
    .from(holidayRequests).innerJoin(users, eq(holidayRequests.workerId, users.id))
    .where(eq(holidayRequests.restaurantId, restaurantId))
    .orderBy(desc(holidayRequests.createdAt)).limit(10).all();
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (args[0] === "--db-closures") {
  const restaurantId = args[1];
  const rows = db.select({ start: restaurantClosures.startDate, end: restaurantClosures.endDate, reason: restaurantClosures.reason })
    .from(restaurantClosures).where(eq(restaurantClosures.restaurantId, restaurantId)).all();
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (args[0] === "--db-replacements") {
  const restaurantId = args[1];
  const rows = db.select({ requester: users.name, status: replacementRequests.status, message: replacementRequests.message })
    .from(replacementRequests).innerJoin(users, eq(replacementRequests.requesterId, users.id))
    .where(eq(replacementRequests.restaurantId, restaurantId))
    .orderBy(desc(replacementRequests.createdAt)).limit(10).all();
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// Get restaurant IDs
if (args[0] === "--restaurants") {
  const { restaurants } = await import("./db.js");
  const rows = db.select({ id: restaurants.id, name: restaurants.name }).from(restaurants).all();
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// Normal chat mode
const phone = args[0];
const message = args.slice(1).join(" ");

if (!phone || !message) {
  console.error('Usage: bun run src/chat.ts <phone> "message"');
  process.exit(1);
}

const result = await resolveIdentity(phone);
if (!result.ok) { console.error(`❌ No user for ${phone}`); process.exit(1); }

const identity = result.identity;
const start = Date.now();
const reply = await runAgent(identity, message);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`[${identity.name} (${identity.role}) → ${identity.restaurantName}]`);
console.log(`Q: ${message}`);
console.log(`A (${elapsed}s): ${reply}`);
