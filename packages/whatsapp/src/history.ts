import { apiPostInternal } from "./api-client.js";

type ChatRole = "user" | "assistant" | "tool";
type HistoryMessage = { role: string; content: string };

export async function getHistory(userId: string): Promise<HistoryMessage[]> {
  const res = await apiPostInternal<{ data: { messages: HistoryMessage[] } }>("/chat/history", { userId });
  return res.data.messages;
}

export async function saveMessage(userId: string, role: ChatRole, content: string, toolCalls?: string): Promise<void> {
  await apiPostInternal("/chat/messages", { userId, role, content, toolCalls });
}

export async function resetHistoryAfterConfirmation(userId: string): Promise<void> {
  await apiPostInternal("/chat/reset-after-confirmation", { userId });
}

export async function trimHistory(userId: string): Promise<void> {
  await apiPostInternal("/chat/trim", { userId });
}
