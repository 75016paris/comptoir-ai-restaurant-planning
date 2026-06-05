import { rawDb } from "../src/db/connection.js";
import { verifyPhase7DocumentStoragePostMove } from "../src/db/phase7-document-storage-audit.js";

const verification = verifyPhase7DocumentStoragePostMove(rawDb);

console.log(JSON.stringify(verification, null, 2));

if (verification.issues.length > 0) {
  throw new Error("Phase 7 document storage post-move verification found unsafe rows.");
}
