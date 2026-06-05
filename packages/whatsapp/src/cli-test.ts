#!/usr/bin/env bun
/**
 * CLI test mode — simulate WhatsApp conversations without Twilio.
 * Usage: bun run src/cli-test.ts "+33612345678"
 *
 * Resolves the phone to a user and starts an interactive loop.
 * Uses the same agent, tools, and DB as the real webhook.
 */
import { resolveIdentity } from "./identity.js";
import { runAgent } from "./agent.js";
import { createInterface } from "readline";

const phone = process.argv[2];
if (!phone) {
  console.error("Usage: bun run src/cli-test.ts <phone>");
  console.error('  e.g. bun run src/cli-test.ts "+33612345678"');
  process.exit(1);
}

const result = await resolveIdentity(phone);
if (!result.ok) {
  if (result.blocked) {
    console.error(`❌ Blocked: ${result.message}`);
  } else {
    console.error(`❌ No user found for phone: ${phone}`);
    // List available phones
    const { db, users } = await import("./db.js");
    const all = db.select({ name: users.name, phone: users.phone, role: users.role }).from(users).all();
    console.error("\nAvailable users:");
    for (const u of all) console.error(`  ${u.phone} — ${u.name} (${u.role})`);
  }
  process.exit(1);
}
const identity = result.identity;

console.log(`\n📱 Comptoir WhatsApp CLI — ${identity.name} (${identity.role})`);
console.log(`   Restaurant: ${identity.restaurantName}`);
console.log(`   Ollama: ${process.env.OLLAMA_URL || "http://localhost:11434"} / ${process.env.OLLAMA_MODEL || "qwen3:14b"}`);
console.log(`   Type "quit" to exit\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });

function prompt() {
  rl.question(`${identity!.name}> `, async (input) => {
    const text = input.trim();
    if (!text || text === "quit" || text === "exit") {
      rl.close();
      process.exit(0);
    }

    const start = Date.now();
    try {
      const reply = await runAgent(identity!, text);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`\nBot (${elapsed}s):\n${reply}\n`);
    } catch (err: any) {
      console.error(`\nError: ${err.message}\n`);
    }
    prompt();
  });
}

prompt();
