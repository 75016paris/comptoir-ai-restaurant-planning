/**
 * In-chat notification delivery — sends a Bernardo message into a user's
 * WhatsApp conversation thread.
 *
 * The API owns notification/chat persistence and user phone lookup. The bot
 * only records through the internal API, then sends via Meta Cloud API so the
 * message lands in Bernardo's WhatsApp thread.
 */
import { apiPostInternal } from "./api-client.js";
import { sendWhatsAppReply, sendWhatsAppTemplate, type WhatsAppTemplateRequest } from "./meta.js";
import type { NotificationType } from "./types/notification.js";
import { formatLogMessagePreview, redactSensitiveString } from "@comptoir/shared";

export type { NotificationType };

export interface NotifyParams {
  recipientId: string;
  message: string;
  type: NotificationType;
  template?: WhatsAppTemplateRequest;
}

type RecordNotificationResponse = {
  data: { phone: string; hasOpenServiceWindow: boolean };
};

/** Deliver a notification as a Bernardo in-chat message. */
export async function notifyInChat(params: NotifyParams): Promise<void> {
  const { recipientId, message, type, template } = params;

  const res = await apiPostInternal<RecordNotificationResponse>("/notifications/record", {
    userId: recipientId,
    message,
    type,
  });

  try {
    const to = res.data.phone.startsWith("+") ? res.data.phone : `+${res.data.phone}`;
    if (template && !res.data.hasOpenServiceWindow) {
      await sendWhatsAppTemplate(to, template);
      console.log(`[notify] Template ${template.name} → ${redactSensitiveString(res.data.phone)}: ${formatLogMessagePreview(message.slice(0, 60))}...`);
    } else {
      await sendWhatsAppReply(to, message);
      console.log(`[notify] In-chat → ${redactSensitiveString(res.data.phone)}: ${formatLogMessagePreview(message.slice(0, 60))}...`);
    }
  } catch (err: any) {
    console.error(`[notify] Meta send failed for ${redactSensitiveString(recipientId)}:`, redactSensitiveString(err.message));
  }
}
