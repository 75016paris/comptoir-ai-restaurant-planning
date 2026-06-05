/**
 * Agent v2 — minimal agent loop.
 * Clean slate: short prompt, no filters, no fast-paths.
 * Complexity earns its way back through bench failures.
 */
import type { Identity } from "./identity.js";
import { getHistory, saveMessage, trimHistory, resetHistoryAfterConfirmation } from "./history.js";
import { apiGet, apiPost, WhatsAppApiError } from "./api-client.js";
import { WORKER_TOOLS } from "./tools/worker.js";
import { ADMIN_TOOLS } from "./tools/admin.js";
import { toOllamaTools } from "./tools/types.js";
import type { ToolDef, ToolContext } from "./tools/types.js";
import { getPending, clearPending, clearAllPending, getHandler } from "./tools/confirmation.js";
import { normalizeSms } from "./sms-normalize.js";
import { can } from "@comptoir/shared";
import { formatInstantInTimeZone, formatLogObject, redactSensitiveString, todayInTimeZone } from "@comptoir/shared";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen3:14b";

// Inference backend selector. `ollama` (default) keeps the local-dev /
// Scaleway Mac path live. `openai-compat` calls a hosted OpenAI-shape endpoint
// (today: OVH AI Endpoints serving Qwen3-32B, validated 2026-05-05 at 9.7/10).
const LLM_PROVIDER: "ollama" | "openai-compat" =
  process.env.LLM_PROVIDER === "openai-compat" ? "openai-compat" : "ollama";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OVH_API_TOKEN || "";

if (LLM_PROVIDER === "openai-compat" && (!OPENAI_BASE_URL || !OPENAI_API_KEY)) {
  console.error("[agent] LLM_PROVIDER=openai-compat requires OPENAI_BASE_URL and OPENAI_API_KEY (or OVH_API_TOKEN)");
}

// ── Ollama stats (kept for bench compatibility) ──

export type OllamaStats = {
  promptTokens: number;
  evalTokens: number;
  toolCalls: number;
  totalMs: number;
  evalMs: number;
  tps: number;
};

let ollamaStatsLog: OllamaStats[] = [];
export function getOllamaStats(): OllamaStats[] { return ollamaStatsLog; }
export function clearOllamaStats() { ollamaStatsLog = []; }
export function getAggregateOllamaStats(): OllamaStats {
  const s = ollamaStatsLog;
  if (!s.length) return { promptTokens: 0, evalTokens: 0, toolCalls: 0, totalMs: 0, evalMs: 0, tps: 0 };
  const sum = s.reduce((a, b) => ({
    promptTokens: a.promptTokens + b.promptTokens,
    evalTokens: a.evalTokens + b.evalTokens,
    toolCalls: a.toolCalls + b.toolCalls,
    totalMs: a.totalMs + b.totalMs,
    evalMs: a.evalMs + b.evalMs,
    tps: 0,
  }));
  sum.tps = sum.evalMs > 0 ? sum.evalTokens / (sum.evalMs / 1000) : 0;
  return sum;
}

// ── Helpers ──

function todayHeader(timeZone: string): { todayStr: string; isoDate: string } {
  const now = new Date();
  return {
    todayStr: formatInstantInTimeZone(now, "fr-FR", timeZone, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: undefined,
      minute: undefined,
    }),
    isoDate: todayInTimeZone(timeZone, now),
  };
}

// ── Output sanitization (defense in depth against prompt injection) ──
//
// The system prompt instructs Bernardo to refuse identity-substitution, prompt-leak, and
// fake-approval attempts. This is a last-line filter for cases where the model
// complies anyway. Replaces the offending reply with a neutral refusal rather
// than letting it through.
const INJECTION_LEAK_PATTERNS: RegExp[] = [
  /\bje suis (?:chat ?gpt|gpt-?\d|claude|gemini|llama|mistral|qwen|bard)\b/i,
  /\b(?:here is|voici) (?:my|ma|mon) (?:complete |full |full system )?(?:system )?(?:prompt|configuration|config)/i,
  /^voici ma configuration\b/im,
  /\bmes (?:règles|rules) (?:sont |are )?(?:updatées?|updated)\b/i,
  /^(?:mode )?debug\s*[:\-]/im,
];

function sanitizeAssistantReply(reply: string): string {
  for (const pat of INJECTION_LEAK_PATTERNS) {
    if (pat.test(reply)) {
      return "Je ne peux pas faire ça. Je suis Bernardo, ton assistant planning. Que puis-je faire pour toi ?";
    }
  }
  return reply;
}

// ── Restaurant context (shared by both prompts) ──

type PromptContext = { zones: string[]; team: { kitchen: string[]; floor: string[] } };

type PromptContextCacheEntry = { expiresAt: number; value: PromptContext };
const PROMPT_CONTEXT_CACHE_TTL_MS = Math.max(0, Number(process.env.AGENT_CONTEXT_CACHE_TTL_MS || 60_000));
const promptContextCache = new Map<string, PromptContextCacheEntry>();

function promptContextCacheKey(identity: Identity): string {
  return [identity.userId, identity.restaurantId, identity.role, identity.permissions ?? ""].join(":");
}

async function getPromptContext(identity: Identity): Promise<PromptContext> {
  const cacheKey = promptContextCacheKey(identity);
  const cached = promptContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const res = await apiGet<{ data: PromptContext }>("/context", {
      userId: identity.userId,
      restaurantId: identity.restaurantId,
      restaurantTimezone: identity.restaurantTimezone,
      role: identity.role,
      userName: identity.name,
      permissions: identity.permissions,
    });
    if (PROMPT_CONTEXT_CACHE_TTL_MS > 0) {
      promptContextCache.set(cacheKey, { expiresAt: Date.now() + PROMPT_CONTEXT_CACHE_TTL_MS, value: res.data });
    }
    return res.data;
  } catch (err) {
    console.error("[agent] Failed to load prompt context from internal API", redactSensitiveString(err));
    return { zones: [], team: { kitchen: [], floor: [] } };
  }
}

function formatTeamList(team: PromptContext["team"]): string {
  return `Cuisine: ${team.kitchen.join(", ")}\nSalle: ${team.floor.join(", ")}`;
}

// ── System prompts ──
//
// Two profiles selectable via AGENT_PROFILE env var:
//   legacy_14b (default) — verbatim qwen3:14b production prompts
//   qwen3_32b           — workflow-based, tuned for Qwen3-32B-FP8 on vLLM
// Implementations live in ./prompts/*.

import { buildAdminPrompt as buildAdminPromptForProfile, buildWorkerPrompt as buildWorkerPromptForProfile } from "./prompts/index.js";

// Reasoning toggle. Default OFF: WhatsApp UX requires sub-10s latency, and bench data shows tool-
// routing quality holds without thinking once data (zones, team) is correct. Override via
// AGENT_THINK=1 for offline evals on hard tool-routing cases. vLLM honors enable_thinking via
// chat_template_kwargs; the proxy translates body.think → chat_template_kwargs.enable_thinking.
const AGENT_THINK = process.env.AGENT_THINK === "1" || process.env.AGENT_THINK === "true";

// Context window per model size. Small/medium dense models (Qwen3.5 9.7B, Qwen3 14B) on the
// 16 GB Scaleway Mac run at 16K to keep KV in RAM with margin. The 32B FP8 endpoint on RunPod
// L40S has the headroom for 32K. AGENT_NUM_CTX env var overrides for one-off evals.
function resolveNumCtx(model: string): number {
  const override = Number(process.env.AGENT_NUM_CTX);
  if (Number.isFinite(override) && override > 0) return override;
  return /32b/i.test(model) ? 32768 : 16384;
}

async function buildAdminPrompt(identity: Identity): Promise<string> {
  const { todayStr, isoDate } = todayHeader(identity.restaurantTimezone);
  const context = await getPromptContext(identity);
  return buildAdminPromptForProfile({
    identity, todayStr, isoDate,
    zones: context.zones,
    team: formatTeamList(context.team),
  });
}

function buildWorkerPrompt(identity: Identity): string {
  const { todayStr, isoDate } = todayHeader(identity.restaurantTimezone);
  return buildWorkerPromptForProfile({ identity, todayStr, isoDate });
}

// ── LLM API ──

type OllamaMessage = { role: string; content: string; tool_calls?: any[] };

async function ollamaChat(messages: OllamaMessage[], tools: any[]): Promise<{ message: OllamaMessage }> {
  const body: any = {
    model: MODEL,
    messages,
    stream: false,
    think: AGENT_THINK,
    keep_alive: -1,
    options: { num_ctx: resolveNumCtx(MODEL) },
  };
  if (tools.length > 0) body.tools = tools;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Stats
  const promptTokens = data.prompt_eval_count || 0;
  const evalTokens = data.eval_count || 0;
  const totalMs = Math.round((data.total_duration || 0) / 1e6);
  const evalMs = Math.round((data.eval_duration || 0) / 1e6);
  const tps = evalMs > 0 ? parseFloat((evalTokens / (evalMs / 1000)).toFixed(1)) : 0;
  const toolCalls = data.message?.tool_calls?.length || 0;
  console.error(`  📊 prompt:${promptTokens}tok eval:${evalTokens}tok tools:${toolCalls} time:${totalMs}ms (${tps} tok/s)`);
  ollamaStatsLog.push({ promptTokens, evalTokens, toolCalls, totalMs, evalMs, tps });

  return { message: data.message };
}

// OpenAI-compat path (OVH AI Endpoints today; provider-agnostic protocol).
// Mirrors the protocol shape validated by /tmp/ollama-ovh-proxy.ts during the
// 2026-05-05 mega-bench (9.7/10 vs the 9.8 RunPod baseline).

// OVH-specific: OVH rejects chat_template_kwargs and reasoning_effort on
// Qwen3-32B. Inject /no_think into the LAST system message instead (Qwen3
// directive, produces an empty <think>\n\n</think> block we strip below).
function injectNoThink(messages: OllamaMessage[], think: boolean): OllamaMessage[] {
  if (think) return messages;
  const out = messages.slice();
  let lastSysIdx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "system") { lastSysIdx = i; break; }
  }
  if (lastSysIdx >= 0) {
    out[lastSysIdx] = { ...out[lastSysIdx], content: `${out[lastSysIdx].content}\n\n/no_think` };
  } else {
    out.unshift({ role: "system", content: "/no_think" });
  }
  return out;
}

function ollamaToOpenAIMessage(msg: OllamaMessage, idx: number): any {
  if (msg.role === "tool") {
    return { role: "tool", content: msg.content, tool_call_id: `t${idx}` };
  }
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    return {
      role: "assistant",
      content: msg.content || "",
      tool_calls: msg.tool_calls.map((tc: any, i: number) => ({
        id: `call_${idx}_${i}`,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {}),
        },
      })),
    };
  }
  return { role: msg.role, content: msg.content };
}

// Tool messages need their tool_call_id to match the prior assistant message's
// tool_calls[].id. We re-thread the IDs after the per-message conversion above.
function attachToolCallIds(openAiMessages: any[]): any[] {
  let lastIds: string[] = [];
  let cursor = 0;
  return openAiMessages.map((m) => {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      lastIds = m.tool_calls.map((tc: any) => tc.id);
      cursor = 0;
      return m;
    }
    if (m.role === "tool") {
      const id = lastIds[cursor++] || `call_${cursor}`;
      return { ...m, tool_call_id: id };
    }
    return m;
  });
}

async function openAiCompatChat(messages: OllamaMessage[], tools: any[]): Promise<{ message: OllamaMessage }> {
  if (!OPENAI_BASE_URL || !OPENAI_API_KEY) {
    throw new Error("openai-compat provider misconfigured: OPENAI_BASE_URL and OPENAI_API_KEY required");
  }

  const t0 = performance.now();
  const prepared = injectNoThink(messages, AGENT_THINK);
  const openAiMessages = attachToolCallIds(prepared.map((m, i) => ollamaToOpenAIMessage(m, i)));

  const body: any = {
    model: OPENAI_MODEL,
    messages: openAiMessages,
    stream: false,
    temperature: 0.3,
    max_tokens: AGENT_THINK ? 8192 : 4096,
  };
  if (tools.length > 0) body.tools = tools;

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openai-compat error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data: any = await res.json();
  const t1 = performance.now();
  const totalMs = Math.round(t1 - t0);

  const ch = data.choices?.[0]?.message ?? {};
  // Strip empty (or non-empty) <think> blocks the model emits when /no_think is
  // honored or when the model thinks anyway.
  const cleanContent = (ch.content || "").replace(/<think>[\s\S]*?<\/think>\s*/g, "");

  const message: OllamaMessage = { role: "assistant", content: cleanContent };
  if (Array.isArray(ch.tool_calls) && ch.tool_calls.length) {
    message.tool_calls = ch.tool_calls.map((tc: any) => ({
      function: {
        name: tc.function.name,
        arguments: (() => {
          try { return JSON.parse(tc.function.arguments); }
          catch { return tc.function.arguments; }
        })(),
      },
    }));
  }

  // Stats
  const promptTokens = data.usage?.prompt_tokens || 0;
  const evalTokens = data.usage?.completion_tokens || 0;
  const evalMs = totalMs; // No server-side eval timing in OpenAI shape; client wall-clock is the closest proxy.
  const tps = evalMs > 0 ? parseFloat((evalTokens / (evalMs / 1000)).toFixed(1)) : 0;
  const toolCalls = message.tool_calls?.length || 0;
  console.error(`  📊 prompt:${promptTokens}tok eval:${evalTokens}tok tools:${toolCalls} time:${totalMs}ms (${tps} tok/s)`);
  ollamaStatsLog.push({ promptTokens, evalTokens, toolCalls, totalMs, evalMs, tps });

  return { message };
}

async function llmChat(messages: OllamaMessage[], tools: any[]): Promise<{ message: OllamaMessage }> {
  return LLM_PROVIDER === "openai-compat"
    ? openAiCompatChat(messages, tools)
    : ollamaChat(messages, tools);
}

// ── Tool execution ──

async function executeToolCalls(
  toolCalls: any[],
  toolMap: Map<string, ToolDef>,
  ctx: ToolContext,
): Promise<OllamaMessage[]> {
  const results: OllamaMessage[] = [];
  for (const call of toolCalls) {
    const fn = call.function;
    console.error(`  🔨 ${fn.name}(${formatLogObject(fn.arguments)})`);
    const tool = toolMap.get(fn.name);
    if (!tool) {
      results.push({ role: "tool", content: `Erreur: outil "${fn.name}" non trouvé.` });
      continue;
    }
    try {
      const result = await tool.execute(fn.arguments || {}, ctx);
      results.push({ role: "tool", content: result });
    } catch (err: any) {
      console.error(`[agent] Tool ${fn.name} failed:`, redactSensitiveString(err));
      results.push({ role: "tool", content: "Erreur: l'opération a échoué." });
    }
  }
  return results;
}

// ── Confirmation handling ──

const CONFIRM_YES = /^\s*(oui|yes|ok|d'accord|dac|confirme|vas-y|go|ouais|yep|c'est bon)\s*[!.]*\s*$/i;
const CONFIRM_NO = /^\s*(non|no|annule|cancel|stop|nan|nope|laisse tomber)\s*[!.]*\s*$/i;
const OPEN_SHIFT_YES = /^\s*(oui(?:,?\s+je prends)?|yes|ok|d'accord|dac|ouais|yep|je prends|j'y vais|je peux le faire|ok pour moi|c'est bon)\s*[!.]*\s*$/i;
const OPEN_SHIFT_NO = /^\s*(non|no|nan|nope|pas dispo|je peux pas|désolé|desole|refuse)\s*[!.]*\s*$/i;
const OPEN_SHIFT_PROMPT = /(service ouvert|te propose un service|réponds \*oui\*\s*\/\s*\*je prends\*|premier qui répond \*je prends\*)/i;

async function handleOpenShiftReply(
  identity: Identity,
  normalizedMessage: string,
  history: Awaited<ReturnType<typeof getHistory>>,
  ctx: ToolContext,
): Promise<string | null> {
  if (identity.role === "admin" || identity.role === "manager") return null;
  const isYes = OPEN_SHIFT_YES.test(normalizedMessage);
  const isNo = OPEN_SHIFT_NO.test(normalizedMessage);
  if (!isYes && !isNo) return null;

  const recentAssistantMessages = history
    .filter((m) => m.role === "assistant")
    .slice(-4)
    .map((m) => m.content)
    .join("\n");
  if (!OPEN_SHIFT_PROMPT.test(recentAssistantMessages)) return null;

  try {
    if (isYes) {
      const res = await apiPost<{ data: { date: string; startTime: string; endTime: string } }>("/me/open-shifts/claim", {}, ctx);
      return `C'est noté ! Service confirmé le ${res.data.date} de ${res.data.startTime} à ${res.data.endTime}. Le gérant est prévenu.`;
    }
    const res = await apiPost<{ data: { date: string; startTime: string; endTime: string } }>("/me/open-shifts/decline", {}, ctx);
    return `C'est noté, j'ai prévenu le gérant que tu refuses le service du ${res.data.date} ${res.data.startTime}-${res.data.endTime}.`;
  } catch (err) {
    if (err instanceof WhatsAppApiError && err.status >= 400 && err.status < 500) {
      const body = err.body as { error?: string } | undefined;
      return body?.error || err.message;
    }
    return "Erreur: l'opération a échoué.";
  }
}

async function handleConfirmation(identity: Identity, userMessage: string): Promise<string | null> {
  const pending = getPending(identity.userId);
  if (!pending) return null;

  if (CONFIRM_YES.test(userMessage)) {
    clearPending(identity.userId);
    const handler = getHandler(pending.action);
    if (!handler) return null;
    const ctx: ToolContext = {
      userId: identity.userId, restaurantId: identity.restaurantId,
      restaurantTimezone: identity.restaurantTimezone,
      role: identity.role, userName: identity.name,
      permissions: identity.permissions,
    };
    const result = await handler(pending.params, ctx);
    await saveMessage(identity.userId, "user", userMessage);
    await saveMessage(identity.userId, "assistant", result);
    await resetHistoryAfterConfirmation(identity.userId);
    return result;
  }

  if (CONFIRM_NO.test(userMessage)) {
    clearAllPending(identity.userId);
    await saveMessage(identity.userId, "user", userMessage);
    await saveMessage(identity.userId, "assistant", "Action annulée.");
    await resetHistoryAfterConfirmation(identity.userId);
    return "Action annulée.";
  }

  // Not a clear yes/no — clear pending and let the LLM handle normally
  clearAllPending(identity.userId);
  return null;
}

// ── Main agent function ──

export async function runAgent(identity: Identity, userMessage: string): Promise<string> {
  // Confirmation flow (architectural, not a guardrail)
  const confirmResult = await handleConfirmation(identity, userMessage);
  if (confirmResult) return confirmResult;

  // Normalize SMS speak before the LLM sees it
  const normalizedMessage = normalizeSms(userMessage);

  // Select tools by role. Manager shares the admin tool set; per-tool permission
  // checks (id:m9rl) gate billing/settings/role-management calls inside each tool.
  const allTools = (identity.role === "admin" || identity.role === "manager") ? ADMIN_TOOLS : WORKER_TOOLS;
  const tools = allTools.filter((tool) => !tool.requiredPermission || can(identity, tool.requiredPermission));
  const toolMap = new Map(tools.map(t => [t.name, t]));
  const ollamaTools = toOllamaTools(tools);

  // Context
  const ctx: ToolContext = {
    userId: identity.userId,
    restaurantId: identity.restaurantId,
    restaurantTimezone: identity.restaurantTimezone,
    role: identity.role,
    userName: identity.name,
    permissions: identity.permissions,
    lastUserMessage: normalizedMessage,
  };

  const isAdminLike = identity.role === "admin" || identity.role === "manager";
  const historyPromise = getHistory(identity.userId);
  const systemPromptPromise = isAdminLike
    ? buildAdminPrompt(identity)
    : Promise.resolve(buildWorkerPrompt(identity));

  const history = await historyPromise;
  const openShiftResult = await handleOpenShiftReply(identity, normalizedMessage, history, ctx);
  if (openShiftResult) {
    await saveMessage(identity.userId, "user", userMessage);
    await saveMessage(identity.userId, "assistant", openShiftResult);
    await trimHistory(identity.userId);
    return openShiftResult;
  }

  // System prompt — admin and manager share the admin prompt (manager is the
  // executive Responsable; the prompt acknowledges them via `identity.role`).
  const systemPrompt = await systemPromptPromise;

  const saveUserPromise = saveMessage(identity.userId, "user", userMessage);

  // Build messages
  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: normalizedMessage },
  ];

  // LLM call → tool loop (max 3 rounds). Persist the user message in parallel
  // with the first inference call; this hides one internal API roundtrip without
  // changing the prompt the model sees.
  const [initialResponse] = await Promise.all([llmChat(messages, ollamaTools), saveUserPromise]);
  let response = initialResponse;
  let rounds = 0;

  while (response.message.tool_calls?.length && rounds < 3) {
    rounds++;
    const toolResults = await executeToolCalls(response.message.tool_calls, toolMap, ctx);

    // If a tool returned a confirmation prompt, pass it through directly
    const confirmationResult = toolResults.find(tr =>
      tr.content.includes("pour confirmer") && tr.content.includes("pour annuler")
    );
    if (confirmationResult) {
      await saveMessage(identity.userId, "assistant", confirmationResult.content);
      return confirmationResult.content;
    }

    // Add assistant + tool results to context
    messages.push(response.message);
    for (const tr of toolResults) {
      messages.push(tr);
    }

    // Follow-up LLM call
    response = await llmChat(messages, ollamaTools);
  }

  // Extract reply
  const rawReply = response.message.content || "Désolé, je n'ai pas compris. Reformule ta question ?";
  const reply = sanitizeAssistantReply(rawReply).trim() || "Désolé, je n'ai pas compris. Reformule ta question ?";

  await saveMessage(identity.userId, "assistant", reply);
  await trimHistory(identity.userId);

  return reply;
}
