import { db } from "./connection.js";
import { auditLogs } from "./schema.js";

export type AuditAction = "insert" | "update" | "delete";
export type AuditSource = "dashboard" | "bot:admin" | "bot:worker" | "auto-scheduler" | "cron";

export interface AuditEntry {
  restaurantId: string;
  tableName: string;
  rowId: string;
  action: AuditAction;
  actorId?: string | null;
  actorName?: string | null;
  source: AuditSource;
  changes?: Record<string, { old?: unknown; new?: unknown }> | null;
  summary?: string | null;
}

/** Compute diff between old and new objects — only changed fields */
export function diff(
  oldObj: Record<string, unknown> | null | undefined,
  newObj: Record<string, unknown> | null | undefined,
): Record<string, { old?: unknown; new?: unknown }> | null {
  if (!oldObj && !newObj) return null;
  if (!oldObj) {
    // insert — record all new values
    const out: Record<string, { new: unknown }> = {};
    for (const [k, v] of Object.entries(newObj!)) {
      if (k === "updatedAt" || k === "createdAt") continue;
      out[k] = { new: v };
    }
    return Object.keys(out).length ? out : null;
  }
  if (!newObj) {
    // delete — record all old values
    const out: Record<string, { old: unknown }> = {};
    for (const [k, v] of Object.entries(oldObj)) {
      if (k === "updatedAt" || k === "createdAt") continue;
      out[k] = { old: v };
    }
    return Object.keys(out).length ? out : null;
  }
  // update — only changed fields
  const out: Record<string, { old: unknown; new: unknown }> = {};
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const k of allKeys) {
    if (k === "updatedAt" || k === "createdAt") continue;
    const o = oldObj[k];
    const n = newObj[k];
    if (JSON.stringify(o) !== JSON.stringify(n)) {
      out[k] = { old: o, new: n };
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Insert an audit log entry. Fire-and-forget — never throws. */
export function logAudit(entry: AuditEntry): void {
  try {
    db.insert(auditLogs).values({
      restaurantId: entry.restaurantId,
      tableName: entry.tableName,
      rowId: entry.rowId,
      action: entry.action,
      actorId: entry.actorId ?? null,
      actorName: entry.actorName ?? null,
      source: entry.source,
      changes: entry.changes ? JSON.stringify(entry.changes) : null,
      summary: entry.summary ?? null,
    }).run();
  } catch (e) {
    console.error("[audit] Failed to write audit log:", e);
  }
}
