const REPLACEMENT_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Candidate reply deadlines start when the request is actually sent to workers,
 * not when the requester first reported the absence.
 */
export function replacementReplyExpiresAt(sentAt: Date = new Date()): string {
  return new Date(sentAt.getTime() + REPLACEMENT_REPLY_WINDOW_MS).toISOString();
}
