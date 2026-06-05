import { rawDb } from "../src/db/connection.js";
import { collectPhase7DocumentStorageAudit } from "../src/db/phase7-document-storage-audit.js";

const audit = collectPhase7DocumentStorageAudit(rawDb);

console.log(JSON.stringify(audit, null, 2));

if (audit.issues.length > 0) {
  throw new Error("Phase 7 document storage audit found unsafe document storage rows.");
}

