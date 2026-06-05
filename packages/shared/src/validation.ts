import { z } from "zod";

export const roleEnum = z.enum(["admin", "manager", "kitchen", "floor"]);
export const serviceRoleEnum = z.enum(["kitchen", "floor"]);
// Roles selectable when creating a new employee from the AddEmployeeModal (admins
// promote/demote between manager/worker via the same flow). Excludes "admin"
// since admins are created via signup, not via the team page.
export const employeeRoleEnum = z.enum(["manager", "kitchen", "floor"]);
export const timeHHMMSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

// ── Users ──
export const createUserSchema = z.object({
  name: z.string().min(2).max(100).optional(), // legacy: when firstName+lastName given, server computes name
  firstName: z.string().min(1).max(60).nullable().optional(),
  lastName: z.string().min(1).max(60).nullable().optional(),
  email: z.email(),
  phone: z.string().min(6).max(20),
  role: employeeRoleEnum,
  password: z.string().min(6).max(100).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  address: z.string().max(500).nullable().optional(),
  iban: z.string().max(34).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  emergencyContact: z.string().max(100).nullable().optional(),
  emergencyPhone: z.string().max(20).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  birthPlace: z.string().max(100).nullable().optional(),
  nationality: z.string().min(2).max(60).nullable().optional(),
  nir: z.string().min(13).max(15).regex(/^[0-9]+$/).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  managerNotes: z.string().max(2000).nullable().optional(),
  subRole: z.string().max(50).nullable().optional(),
  subRoles: z.array(z.string().max(50)).optional(),
  matricule: z.string().max(20).nullable().optional(),
  contractType: z.enum(["CDI", "CDD", "saisonnier", "extra"]).nullable().optional(),
  contractEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  contractHours: z.number().int().min(0).max(48).nullable().optional(),
  overtimeWilling: z.boolean().optional(),
  coupureWilling: z.boolean().optional(),
  multiRestaurantWilling: z.boolean().optional(),
  maxWeeklyHours: z.number().int().min(1).max(48).nullable().optional(),
  adminOtOverride: z.number().int().min(39).max(48).nullable().optional(),
  hcrLevel: z.enum(["I-1","I-2","I-3","II-1","II-2","II-3","III-1","III-2","III-3","IV-1","IV-2","IV-3","V-1","V-2","V-3"]).nullable().optional(),
  hourlyRate: z.number().int().min(0).max(100000).nullable().optional(), // cents
  rateEffectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const updateUserSchema = createUserSchema.partial().omit({ password: true });

// ── Service Templates ──
export const serviceTemplateOverrideSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  startTime: timeHHMMSchema,
  endTime: timeHHMMSchema,
});

export const serviceTemplateSchema = z.object({
  role: serviceRoleEnum,
  zone: z.string().min(1).max(50),
  startTime: timeHHMMSchema,
  endTime: timeHHMMSchema,
  sortOrder: z.number().int().min(0).optional(),
  overrides: z.array(serviceTemplateOverrideSchema).max(7).optional(),
});

export const upsertServiceTemplatesSchema = z.array(serviceTemplateSchema).min(1).max(20);

// ── Worker Availability ──
export const workerAvailabilitySchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  midi: z.boolean(),
  soir: z.boolean(),
  midiStart: z.string().nullable().optional(),
  midiEnd: z.string().nullable().optional(),
  soirStart: z.string().nullable().optional(),
  soirEnd: z.string().nullable().optional(),
  continuous: z.boolean().optional(),
  zones: z.record(z.string(), z.boolean()).optional(),
});

export const upsertAvailabilitySchema = z.array(workerAvailabilitySchema).min(1).max(7);

// ── Worker Restrictions (time-slot based) ──
export const workerRestrictionSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  startTime: timeHHMMSchema.nullable().optional(), // null = full day
  endTime: timeHHMMSchema.nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
});

export const upsertRestrictionsSchema = z.array(workerRestrictionSchema).max(50);

// Self-update: fields a worker can change on their own profile
export const selfUpdateUserSchema = z.object({
  phone: z.string().min(6).max(20).optional(),
  email: z.email().optional(),
  address: z.string().max(500).nullable().optional(),
  iban: z.string().max(34).nullable().optional(),
  emergencyContact: z.string().max(100).nullable().optional(),
  emergencyPhone: z.string().max(20).nullable().optional(),
  addressStreet: z.string().max(200).nullable().optional(),
  addressPostalCode: z.string().regex(/^\d{5}$/).nullable().optional(),
  addressCity: z.string().max(100).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  birthPlace: z.string().max(100).nullable().optional(),
  nationality: z.string().min(2).max(60).nullable().optional(),
  nir: z.string().min(13).max(15).regex(/^[0-9]+$/).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  overtimeWilling: z.boolean().optional(),
  coupureWilling: z.boolean().optional(),
  multiRestaurantWilling: z.boolean().optional(),
  maxWeeklyHours: z.number().int().min(1).max(48).nullable().optional(),
});

// ── Services ──
export const createServiceSchema = z.object({
  workerId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeHHMMSchema,
  endTime: timeHHMMSchema,
  role: serviceRoleEnum,
  notes: z.string().nullable().optional(),
});

export const updateServiceSchema = createServiceSchema.partial();

export const moveServiceSchema = z.object({
  serviceId: z.uuid(),
  newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  newStartTime: timeHHMMSchema.optional(),
  newEndTime: timeHHMMSchema.optional(),
  newWorkerId: z.uuid().optional(),
});

// ── Replacement ──
// Admin-mediated: requester says "can't come", admin picks a replacement.
// targetId is null until the admin picks (or stays null for broadcast).
export const createReplacementRequestSchema = z.object({
  requesterServiceId: z.uuid(),
  targetId: z.uuid().nullable().optional(),
  message: z.string().max(500).nullable().optional(),
  medical: z.boolean().optional(),
  documents: z.array(z.object({
    name: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    storageKey: z.string(),
  })).max(5).optional(),
});

export const respondReplacementSchema = z.object({
  response: z.enum(["accepted", "rejected"]),
});

// ── Holidays ──
export const createHolidayRequestSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(500).nullable().optional(),
  medical: z.boolean().optional(),
  workerId: z.uuid().optional(), // admin only — create absence on behalf of a worker
});

export const reviewHolidaySchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

// ── Queries ──
export const weekQuerySchema = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/).optional(), // e.g. 2026-W12
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const hoursQuerySchema = z.object({
  workerId: z.uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Zod 4 removed `ZodError.prototype.flatten()`. Use this helper at route boundaries.
export function flattenZodError(error: z.ZodError) {
  return z.flattenError(error);
}
