import { randomUUID } from "node:crypto";
import { getStorage, buildDocumentKey } from "../../../src/services/storage";

async function main() {
  const storage = getStorage();
  if (storage.provider !== "ovh") {
    console.error(
      `STORAGE_PROVIDER must be 'ovh' to run this smoke test (got '${storage.provider}')`,
    );
    process.exit(1);
  }

  const docId = randomUUID();
  const key = buildDocumentKey({
    restaurantId: 0,
    userId: 0,
    documentId: docId,
    filename: "smoke.txt",
  });

  const body = Buffer.from(`hello from comptoir storage-smoke @ ${new Date().toISOString()}\n`);
  console.log(`> putObject ${key} (${body.length} bytes)`);
  await storage.putObject(key, body, "text/plain");

  console.log(`> headObject ${key}`);
  const head = await storage.headObject(key);
  console.log("  ", head);
  if (!head || head.size !== body.length) {
    throw new Error("head mismatch");
  }

  console.log(`> presignGet ${key}`);
  const url = await storage.presignGet(key, 60);
  console.log("  ", url.split("?")[0] + "?...");

  console.log("> fetch via presigned URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`presigned GET failed: ${res.status}`);
  const text = await res.text();
  if (text !== body.toString()) throw new Error("body mismatch");

  console.log(`> deleteObject ${key}`);
  await storage.deleteObject(key);

  const headAfter = await storage.headObject(key);
  if (headAfter !== null) throw new Error("object still present after delete");

  console.log("✅ storage-smoke OK");
}

main().catch((err) => {
  console.error("❌ storage-smoke failed:", err);
  process.exit(1);
});
