// Profile-aware prompt registry.
//
// AGENT_PROFILE selects which prompt set to use:
//   legacy_14b — verbatim qwen3:14b production prompts (default, safe)
//   qwen3_32b  — workflow-based prompts tuned for Qwen3-32B-FP8 on vLLM
//
// Tools and the agent loop are profile-agnostic; only the prompts differ.

import { buildAdminPrompt as adminLegacy } from "./admin-14b.js";
import { buildWorkerPrompt as workerLegacy } from "./worker-14b.js";
import { buildAdminPrompt as adminQwen3 } from "./admin-qwen3.js";
import { buildWorkerPrompt as workerQwen3 } from "./worker-qwen3.js";
import type { PromptCtx, WorkerPromptCtx } from "./shared.js";

export type AgentProfile = "legacy_14b" | "qwen3_32b";

export function resolveProfile(): AgentProfile {
  const v = (process.env.AGENT_PROFILE || "legacy_14b").toLowerCase();
  return v === "qwen3_32b" ? "qwen3_32b" : "legacy_14b";
}

export function buildAdminPrompt(ctx: PromptCtx, profile: AgentProfile = resolveProfile()): string {
  return profile === "qwen3_32b" ? adminQwen3(ctx) : adminLegacy(ctx);
}

export function buildWorkerPrompt(ctx: WorkerPromptCtx, profile: AgentProfile = resolveProfile()): string {
  return profile === "qwen3_32b" ? workerQwen3(ctx) : workerLegacy(ctx);
}
