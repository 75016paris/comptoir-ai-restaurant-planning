/**
 * Shared confirmation system for destructive WhatsApp bot actions.
 * Both worker and admin tools use this to require "oui" before executing mutations.
 * Internal handlers are registered by each tool manifest at module load time.
 */
import type { ToolContext, ToolDef } from "./types.js";

// Pending confirmations — queue (supports batch: "ajoute Omar et Romain")
type PendingItem = { action: string; params: Record<string, unknown>; expiresAt: number };
const pendingQueues = new Map<string, PendingItem[]>();

export function setPending(userId: string, action: string, params: Record<string, unknown>) {
  const key = `${userId}:pending`;
  const queue = pendingQueues.get(key) || [];
  // Deduplicate: skip if same action + workerId already queued (batch add_service bug)
  if (params.workerId) {
    const dup = queue.find(p => p.action === action && p.params.workerId === params.workerId && p.expiresAt >= Date.now());
    if (dup) return;
  }
  queue.push({ action, params, expiresAt: Date.now() + 300_000 });
  pendingQueues.set(key, queue);
}

export function getPending(userId: string): { action: string; params: Record<string, unknown> } | null {
  const key = `${userId}:pending`;
  const queue = pendingQueues.get(key);
  if (!queue || queue.length === 0) { pendingQueues.delete(key); return null; }
  // Clean expired
  while (queue.length > 0 && queue[0].expiresAt < Date.now()) queue.shift();
  if (queue.length === 0) { pendingQueues.delete(key); return null; }
  return { action: queue[0].action, params: queue[0].params };
}

export function clearPending(userId: string) {
  const key = `${userId}:pending`;
  const queue = pendingQueues.get(key);
  if (queue) {
    queue.shift(); // Remove first (just confirmed/cancelled)
    if (queue.length === 0) pendingQueues.delete(key);
  }
}

export function pendingCount(userId: string): number {
  const queue = pendingQueues.get(`${userId}:pending`);
  return queue ? queue.filter(p => p.expiresAt >= Date.now()).length : 0;
}

export function clearAllPending(userId: string) {
  pendingQueues.delete(`${userId}:pending`);
}

// Registry of internal handlers (populated by admin.ts and worker.ts)
const internalHandlers = new Map<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>>();

export function registerHandler(name: string, handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>) {
  internalHandlers.set(name, handler);
}

export function getHandler(name: string) {
  return internalHandlers.get(name);
}

// The confirm_action tool definition — shared by both worker and admin manifests
export const confirmActionTool: ToolDef = {
  name: "confirm_action",
  description: "Confirme ou annule une action en attente. APPELLE cet outil quand l'utilisateur dit 'oui', 'confirme', 'ok' ou 'non', 'annule' en réponse à une demande de confirmation.",
  parameters: {
    confirmed: { type: "boolean", description: "true si l'utilisateur confirme, false s'il annule" },
  },
  async execute(args, ctx) {
    const pending = getPending(ctx.userId);
    if (!pending) return "Aucune action en attente de confirmation.";
    clearPending(ctx.userId);
    if (!args.confirmed) return "Action annulée.";
    const handler = getHandler(pending.action);
    if (!handler) return "Erreur: action expirée ou invalide.";
    return handler(pending.params, ctx);
  },
};
