// ── Roles ──
export type Role = "admin" | "manager" | "kitchen" | "floor";

// ── User ──
export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: Role;
  restaurantId: string;
  priority: number;
  address: string | null;
  iban: string | null;
  startDate: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  notes: string | null;
  managerNotes: string | null;
  subRole: string | null; // deprecated
  subRoles: string[];
  overtimeWilling: boolean;
  matricule: string | null;
  active: boolean;
  inactiveFrom: string | null;
  inactiveUntil: string | null;
  permissions: string | null; // JSON-stringified Partial<Record<Permission, boolean>>; null = use role defaults
  createdAt: string;
}

// ── Restaurant ──
export type RestaurantStatus = "active" | "pending" | "demo" | "suspended";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "cancelled" | "unpaid";
export type ColorScheme = "classic" | "garden" | "sunset" | "ocean" | "earth" | "candy";
export type ReminderFrequency = "off" | "daily" | "weekly";
export type OvertimeMode = "strict" | "controlled" | "flexible";
export type OvertimeDistribution = "willing-first" | "by-priority" | "even";

export interface Restaurant {
  id: string;
  name: string;
  address: string | null;
  schoolZone: string | null;
  holidayZone: string | null;
  timezone: string;
  status: RestaurantStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAt: string | null;
  openDays: string; // JSON array of day numbers
  medicalMode: boolean;
  tapInOutEnabled: boolean;
  reminderFrequency: ReminderFrequency;
  colorScheme: ColorScheme;
  workerPreferencesEnabled: boolean;
  autoStaffingWeeks: number;
  disabledComplianceRules: string; // JSON array of rule codes
  overtimeMode: OvertimeMode;
  overtimeWeeklyCap: number;
  overtimeDistribution: OvertimeDistribution;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
}

// ── Service ──
export type ServiceStatus = "scheduled" | "replacement_pending" | "completed" | "cancelled";

export type ServiceSource = "manual" | "auto";

export interface Service {
  id: string;
  workerId: string;
  restaurantId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  role: Role;
  status: ServiceStatus;
  source: ServiceSource;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Replacement Request ──
export type ReplacementStatus =
  | "awaiting_admin_decision"
  | "awaiting_worker_reply"
  | "accepted"
  | "approved_without_replacement"
  | "rejected"
  | "expired"
  | "cancelled";

export interface ReplacementRequest {
  id: string;
  requesterId: string;
  requesterServiceId: string;
  targetId: string | null; // null until admin picks; stays null for broadcast
  restaurantId: string;
  status: ReplacementStatus;
  message: string | null;
  respondedAt: string | null;
  expiresAt: string;
  createdAt: string;
  candidateIds: string[] | null;
  candidateScores: Record<string, number> | null;
  adminNotifiedAt: string | null;
  workerNotifiedAt: string | null;
  escalationCount: number;
  rejectedCandidateIds: string[];
  medical: boolean;
  ittReminderSentAt: string | null;
  documentCount?: number;
}

// ── Holiday / Time Off ──
export type HolidayStatus = "pending" | "approved" | "rejected";

export interface HolidayRequest {
  id: string;
  workerId: string;
  restaurantId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  reason: string | null;
  medical: boolean;
  status: HolidayStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

// ── Notification ──
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
  | "subscription_cancelled";

export type NotificationChannel = "whatsapp" | "sms";
export type NotificationStatus = "queued" | "sent" | "failed";

export interface Notification {
  id: string;
  recipientId: string;
  type: NotificationType;
  channel: NotificationChannel;
  message: string;
  status: NotificationStatus;
  scheduledFor: string;
  sentAt: string | null;
  createdAt: string;
}

// ── Document ──
export interface Document {
  id: string;
  userId: string;
  restaurantId: string;
  holidayRequestId: string | null;
  name: string;
  type: "id" | "contract" | "certificate" | "medical" | "other";
  filename: string;
  mimeType: string;
  size: number;
  data: string; // base64
  uploadedBy: string;
  createdAt: string;
}

// ── Time Clock ──
export interface TimeClock {
  id: string;
  userId: string;
  restaurantId: string;
  serviceId: string | null;
  tapIn: string;
  tapOut: string | null;
  date: string;
  createdAt: string;
}

// ── Revenue ──
export interface DailyRevenue {
  id: string;
  restaurantId: string;
  date: string;
  amount: number; // cents
  notes: string | null;
  createdAt: string;
}

// ── Service Template ──
export interface ServiceTemplate {
  id: string;
  restaurantId: string;
  profileId: string | null;
  role: Role;
  zone: string;
  startTime: string;
  endTime: string;
  sortOrder: number;
}

// ── Worker Availability ──
export interface WorkerAvailability {
  id: string;
  workerId: string;
  restaurantId: string;
  dayOfWeek: number; // 1=Mon, 7=Sun
  midi: boolean;
  soir: boolean;
  midiStart: string | null;
  midiEnd: string | null;
  soirStart: string | null;
  soirEnd: string | null;
  continuous: boolean;
  zones: string; // JSON
}

// ── Staffing ──
export interface StaffingProfile {
  id: string;
  restaurantId: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}

export interface StaffingSchedule {
  id: string;
  restaurantId: string;
  profileId: string;
  year: number;
  week: number;
}

export interface StaffingTarget {
  id: string;
  restaurantId: string;
  profileId: string | null;
  dayOfWeek: number;
  role: Role;
  zone: string;
  count: number;
}

// ── Calendar ──
export interface CalendarEvent {
  id: string;
  restaurantId: string;
  type: "public_holiday" | "school_vacation";
  date: string;
  endDate: string | null;
  name: string;
  zone: string | null;
  year: number;
  createdAt: string;
}

// ── Restaurant Closure ──
export interface RestaurantClosure {
  id: string;
  restaurantId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  schedule: string | null; // JSON
  createdAt: string;
}

// ── Weather ──
export interface WeatherData {
  id: string;
  restaurantId: string;
  date: string;
  weatherCode: number | null;
  tempMax: number | null;
  tempMin: number | null;
  sunrise: string | null;
  sunset: string | null;
  normalTempMax: number | null;
  normalTempMin: number | null;
  hourlyWeatherCodes: string | null; // JSON array
  hourlyTemperatures: string | null; // JSON array
  isForecast: boolean;
  fetchedAt: string;
}

// ── Chat Messages ──
export interface ChatMessage {
  id: string;
  userId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls: string | null; // JSON
  createdAt: string;
}

// ── Worker Preferred Schedule ──
export interface WorkerPreferredSchedule {
  id: string;
  workerId: string;
  restaurantId: string;
  dayOfWeek: number;
  midi: boolean;
  soir: boolean;
  zones: string; // JSON
}

// ── Auth ──
export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface PendingRegistration {
  id: string;
  restaurantName: string;
  adminName: string;
  email: string;
  phone: string;
  passwordHash: string;
  stripeSessionId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  token: string;
  used: boolean;
  createdAt: string;
  expiresAt: string;
}

// ── API response wrappers ──
export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  details?: string;
}

// ── Hours summary ──
export interface HoursSummary {
  workerId: string;
  workerName: string;
  period: string;
  totalHours: number;
  serviceCount: number;
}
