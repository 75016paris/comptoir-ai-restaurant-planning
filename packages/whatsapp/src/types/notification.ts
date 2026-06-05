/** Notification types — matches the schema enum in packages/api/src/db/schema.ts */
export type NotificationType =
  | "service_reminder"
  | "replacement_proposal"
  | "replacement_accepted"
  | "replacement_rejected"
  | "replacement_expired"
  | "schedule_change"
  | "holiday_approved"
  | "holiday_rejected"
  | "holiday_request"
  | "replacement_request"
  | "trial_ending"
  | "payment_failed"
  | "subscription_cancelled"
  | "open_shift_broadcast"
  | "open_shift_claimed"
  | "open_shift_no_response";
