/**
 * Tool definition types — shared by worker and admin manifests.
 * Each tool is a sandboxed function that the LLM can call.
 * Auth (userId, restaurantId) is pre-injected — the LLM never handles credentials.
 */

export type ToolParam = {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  enum?: string[];
};

import type { Permission } from "@comptoir/shared";

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, ToolParam>;
  requiredPermission?: Permission;
  execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string>;
};

/** Injected into every tool call — the LLM never sees or controls these */
export type ToolContext = {
  userId: string;
  restaurantId: string;
  restaurantTimezone: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  userName: string;
  /** JSON-stringified Partial<Record<Permission, boolean>> per-user override; null = role default. */
  permissions: string | null;
  /** Original user message — used by tools to extract hints the model missed (e.g. zone) */
  lastUserMessage?: string;
};

/** Convert our ToolDef[] to Ollama-compatible tool format */
export function toOllamaTools(tools: ToolDef[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [
            k,
            { type: v.type, description: v.description, ...(v.enum ? { enum: v.enum } : {}) },
          ])
        ),
        required: Object.entries(t.parameters)
          .filter(([, v]) => v.required !== false)
          .map(([k]) => k),
      },
    },
  }));
}
