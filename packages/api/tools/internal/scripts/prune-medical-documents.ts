import { rawDb } from "../../../src/db/connection.js";
import { deleteStoredObject } from "../../../src/services/document-uploads.js";

type MedicalDocRow = {
  id: string;
  storage_provider: "ovh" | "sqlite" | null;
  storage_key: string | null;
};

function cutoffDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 12);
  return d.toISOString().slice(0, 10);
}

const cutoff = process.env.MEDICAL_DOC_CUTOFF_DATE || cutoffDate();

const rows = rawDb.query(`
  SELECT d.id, d.storage_provider, d.storage_key
  FROM documents d
  LEFT JOIN holiday_requests h ON h.id = d.holiday_request_id
  LEFT JOIN replacement_requests r ON r.id = d.replacement_request_id
  LEFT JOIN services s ON s.id = r.requester_service_id
  WHERE d.type = 'medical'
    AND (
      (d.holiday_request_id IS NOT NULL AND h.status IN ('approved', 'rejected') AND h.end_date < ?)
      OR
      (d.replacement_request_id IS NOT NULL AND r.status NOT IN ('awaiting_admin_decision', 'awaiting_worker_reply') AND s.date < ?)
    )
`).all(cutoff, cutoff) as MedicalDocRow[];

for (const row of rows) {
  if (row.storage_provider === "ovh" && row.storage_key) {
    await deleteStoredObject(row.storage_key);
  }
  rawDb.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
}

console.log(`Pruned ${rows.length} medical/ITT document(s) before ${cutoff}.`);
