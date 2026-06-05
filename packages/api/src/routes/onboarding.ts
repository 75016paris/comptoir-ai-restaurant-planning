import { Hono } from "hono";
import { eq, and, ne, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  restaurants,
  staffingProfiles,
  serviceTemplates,
  staffingTargets,
  users,
  ownerMemberships,
  restaurantMemberships,
  workerRestaurantProfiles,
} from "../db/schema.js";
import { requireAuth, requireAdmin, type AppEnv } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { detectZonesFromPostcode } from "../services/calendar.js";
import { syncSiretToStripe } from "../services/billing.js";
import { listRestaurantMemberUserIds } from "../services/restaurant-context.js";
import { DEFAULT_SUBROLE_TO_HCR, KITCHEN_DEFAULT_SUBROLES, FLOOR_DEFAULT_SUBROLES, highestHcrFromSubRoles } from "@comptoir/shared/hcr";
import { DEFAULT_CONTRACT_HOURS, DEFAULT_CONTRACT_TYPE } from "@comptoir/shared";
import { hash } from "argon2";
import { randomBytes } from "node:crypto";
import type { HcrLevel } from "@comptoir/shared/hcr";

export const onboardingRoutes = new Hono<AppEnv>();

onboardingRoutes.use("*", requireAuth, requireAdmin);

// GET /onboarding/state — current snapshot for the admin's restaurant
onboardingRoutes.get("/state", (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const [r] = db.select().from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();
  if (!r) return c.json({ error: "Restaurant introuvable" }, 404);

  const employeeIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: ["manager", "kitchen", "floor"] });
  const employeeCount = employeeIds.length > 0
    ? db.select({ id: users.id }).from(users)
      .where(and(
        inArray(users.id, employeeIds),
        ne(users.role, "admin"),
        eq(users.active, true),
      )).all().length
    : 0;
  const profileCount = db.select({ id: staffingProfiles.id }).from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurant.restaurantId)).all().length;

  return c.json({
    data: {
      completedAt: r.onboardingCompletedAt,
      restaurant: {
        name: r.name,
        address: r.address,
        siret: r.siret,
        whatsappBotLocale: r.whatsappBotLocale,
        schoolZone: r.schoolZone,
        holidayZone: r.holidayZone,
        openDays: JSON.parse(r.openDays || "[]"),
        colorScheme: r.colorScheme,
        kitchenSubRoles: JSON.parse(r.kitchenSubRoles || "[]"),
        floorSubRoles: JSON.parse(r.floorSubRoles || "[]"),
        defaultContractType: r.defaultContractType,
        defaultContractHours: r.defaultContractHours,
        preferredStyle: r.preferredStyle,
      },
      counts: { employees: employeeCount, profiles: profileCount },
    },
  });
});

// POST /onboarding/profile — step 1
onboardingRoutes.post("/profile", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const { name, street, postalCode, city, siret, whatsappBotLocale, openDays, defaultContractType, defaultContractHours } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return c.json({ error: "Nom du restaurant requis" }, 400);
  }
  if (!street || typeof street !== "string" || !street.trim()) {
    return c.json({ error: "Rue requise" }, 400);
  }
  if (!postalCode || typeof postalCode !== "string" || !/^\d{5}$/.test(postalCode.trim())) {
    return c.json({ error: "Code postal invalide (5 chiffres attendus)" }, 400);
  }
  if (!city || typeof city !== "string" || !city.trim()) {
    return c.json({ error: "Ville requise" }, 400);
  }

  // SIRET is optional in onboarding (admin may not have it on hand). When provided,
  // must be exactly 14 digits per URSSAF spec.
  let siretCleaned: string | null | undefined;
  if (siret !== undefined) {
    if (siret === null || (typeof siret === "string" && siret.trim() === "")) {
      siretCleaned = null;
    } else if (typeof siret === "string") {
      const c2 = siret.replace(/\s+/g, "");
      if (!/^\d{14}$/.test(c2)) {
        return c.json({ error: "SIRET invalide (14 chiffres requis)" }, 400);
      }
      siretCleaned = c2;
    }
  }

  const zones = detectZonesFromPostcode(postalCode.trim());
  const address = `${street.trim()}, ${postalCode.trim()} ${city.trim()}`;

  const setData: Record<string, unknown> = {
    name: name.trim(),
    address,
    schoolZone: zones?.schoolZone ?? null,
    holidayZone: zones?.holidayZone ?? null,
  };
  if (siretCleaned !== undefined) setData.siret = siretCleaned;
  if (typeof whatsappBotLocale === "string" && ["fr", "en", "es", "pt"].includes(whatsappBotLocale)) {
    setData.whatsappBotLocale = whatsappBotLocale;
  }
  if (Array.isArray(openDays) && openDays.length > 0) {
    setData.openDays = JSON.stringify(openDays);
  }
  if (defaultContractType) setData.defaultContractType = defaultContractType;
  if (defaultContractHours) setData.defaultContractHours = Number(defaultContractHours);

  db.update(restaurants)
    .set(setData)
    .where(eq(restaurants.id, restaurant.restaurantId))
    .run();

  if (siretCleaned !== undefined) {
    syncSiretToStripe(restaurant.restaurantId, siretCleaned);
  }

  return c.json({ data: { ok: true, schoolZone: zones?.schoolZone, holidayZone: zones?.holidayZone } });
});

// POST /onboarding/subroles — step 2
onboardingRoutes.post("/subroles", async (c) => {
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const { kitchenSubRoles, floorSubRoles } = body;

  if (!Array.isArray(kitchenSubRoles) || !Array.isArray(floorSubRoles)) {
    return c.json({ error: "Listes invalides" }, 400);
  }
  if (kitchenSubRoles.length === 0 && floorSubRoles.length === 0) {
    return c.json({ error: "Sélectionnez au moins un sous-rôle" }, 400);
  }

  const map: Record<string, HcrLevel> = {};
  for (const sr of [...kitchenSubRoles, ...floorSubRoles]) {
    const lvl = DEFAULT_SUBROLE_TO_HCR[sr];
    if (lvl) map[sr] = lvl;
  }

  db.update(restaurants)
    .set({
      kitchenSubRoles: JSON.stringify(kitchenSubRoles),
      floorSubRoles: JSON.stringify(floorSubRoles),
      subroleHcrMap: JSON.stringify(map),
    })
    .where(eq(restaurants.id, restaurant.restaurantId))
    .run();

  return c.json({ data: { ok: true } });
});

// POST /onboarding/service-template — step 3
// shape: { kind: "midi" | "soir" | "midi-soir" | "coupure" | "custom", kitchenCount, salleCount }
onboardingRoutes.post("/service-template", async (c) => {
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const { kind, kitchenCount = 1, salleCount = 1, openDays } = body;

  // Persist open days first if the gérant picked them in this step.
  if (Array.isArray(openDays) && openDays.length > 0) {
    const valid = openDays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (valid.length > 0) {
      db.update(restaurants)
        .set({ openDays: JSON.stringify(valid.sort()) })
        .where(eq(restaurants.id, restaurant.restaurantId))
        .run();
    }
  }

  // Wipe any prior onboarding-created profile to keep this idempotent.
  // We DON'T touch profiles created later via /preferences.
  const [existing] = db.select({ id: staffingProfiles.id })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurant.restaurantId))
    .limit(1).all();

  let profileId: string;
  if (existing) {
    profileId = existing.id;
    db.delete(serviceTemplates).where(eq(serviceTemplates.profileId, profileId)).run();
    db.delete(staffingTargets).where(eq(staffingTargets.profileId, profileId)).run();
    db.update(staffingProfiles).set({ name: "Service par défaut" }).where(eq(staffingProfiles.id, profileId)).run();
  } else {
    const [created] = db.insert(staffingProfiles).values({
      restaurantId: restaurant.restaurantId,
      name: "Service par défaut",
      sortOrder: 0,
    }).returning().all();
    profileId = created.id;
  }

  // Custom = empty profile created above; admin will fill it on /preferences/objectif/:id
  if (kind === "custom") {
    return c.json({ data: { ok: true, profileId } });
  }

  // Service definitions per quick-pick
  type Tpl = { zone: string; startTime: string; endTime: string; sortOrder: number };
  let templates: Tpl[] = [];
  switch (kind) {
    case "midi":
      templates = [{ zone: "Midi", startTime: "11:00", endTime: "15:00", sortOrder: 0 }];
      break;
    case "soir":
      templates = [{ zone: "Soir", startTime: "18:00", endTime: "23:00", sortOrder: 0 }];
      break;
    case "midi-soir":
      templates = [
        { zone: "Midi", startTime: "11:00", endTime: "15:00", sortOrder: 0 },
        { zone: "Soir", startTime: "18:00", endTime: "23:00", sortOrder: 1 },
      ];
      break;
    case "coupure":
      // Two legs same sortOrder = coupure (split shift) per the stack-view convention
      templates = [
        { zone: "Coupure", startTime: "11:00", endTime: "15:00", sortOrder: 0 },
        { zone: "Coupure", startTime: "18:00", endTime: "23:00", sortOrder: 0 },
      ];
      break;
    default:
      return c.json({ error: "Type de service inconnu" }, 400);
  }

  // Insert templates for both roles
  const openDaysArr: number[] = JSON.parse(
    (db.select({ openDays: restaurants.openDays }).from(restaurants)
      .where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all()[0]?.openDays) || "[]"
  );

  for (const t of templates) {
    for (const role of ["kitchen", "floor"] as const) {
      db.insert(serviceTemplates).values({
        restaurantId: restaurant.restaurantId,
        profileId,
        role,
        zone: t.zone,
        startTime: t.startTime,
        endTime: t.endTime,
        sortOrder: t.sortOrder,
      }).run();
    }
  }

  // Coupure has 2 legs in the same zone — staffing_targets is keyed (zone, role, day),
  // so insert one row per unique zone, not per template leg.
  const uniqueZones = Array.from(new Set(templates.map((t) => t.zone)));
  for (const zone of uniqueZones) {
    for (const role of ["kitchen", "floor"] as const) {
      for (const dow of openDaysArr) {
        db.insert(staffingTargets).values({
          restaurantId: restaurant.restaurantId,
          profileId,
          dayOfWeek: dow,
          role,
          zone,
          count: role === "kitchen" ? kitchenCount : salleCount,
          roleBreakdown: "{}",
        }).run();
      }
    }
  }

  return c.json({ data: { ok: true, profileId } });
});

// POST /onboarding/employees — step 4
// shape: { employees: [{ name, phone, email?, role, subRoles[], contractType?, contractHours? }] }
onboardingRoutes.post("/employees", async (c) => {
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const { employees } = body;

  if (!Array.isArray(employees) || employees.length === 0) {
    return c.json({ error: "Ajoutez au moins un employé" }, 400);
  }

  const [resto] = db.select({
    subroleHcrMap: restaurants.subroleHcrMap,
    defaultContractType: restaurants.defaultContractType,
    defaultContractHours: restaurants.defaultContractHours,
  }).from(restaurants).where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();

  const map = JSON.parse(resto?.subroleHcrMap || "{}") as Record<string, HcrLevel>;

  const created: { id: string; name: string }[] = [];
  for (const emp of employees) {
    if (!emp.name || !emp.phone || !emp.role) continue;
    if (!["kitchen", "floor"].includes(emp.role)) continue;

    const subRoles: string[] = Array.isArray(emp.subRoles) ? emp.subRoles.filter(Boolean) : [];
    const hcrLevel = highestHcrFromSubRoles(subRoles, map);

    const email = emp.email && typeof emp.email === "string" && emp.email.includes("@")
      ? emp.email
      : `worker-${crypto.randomUUID().slice(0, 8)}@noemail.local`;

    const temporaryPassword = randomBytes(12).toString("hex");
    const passwordHash = await hash(temporaryPassword);
    const [u] = db.transaction((tx) => {
      const [createdUser] = tx.insert(users).values({
        name: emp.name,
        email,
        phone: emp.phone,
        passwordHash,
        role: emp.role,
        restaurantId: restaurant.restaurantId,
        subRoles: JSON.stringify(subRoles),
        hcrLevel,
        contractType: emp.contractType || resto?.defaultContractType || DEFAULT_CONTRACT_TYPE,
        contractHours: Number(emp.contractHours) || resto?.defaultContractHours || DEFAULT_CONTRACT_HOURS,
        mustChangePassword: true,
        priority: 1,
      }).returning().all();

      tx.insert(ownerMemberships).values({
        ownerId: restaurant.ownerId,
        userId: createdUser.id,
        role: "member",
      }).onConflictDoNothing().run();

      tx.insert(restaurantMemberships).values({
        restaurantId: restaurant.restaurantId,
        userId: createdUser.id,
        role: createdUser.role,
        permissions: null,
        active: true,
      }).onConflictDoNothing().run();

      tx.insert(workerRestaurantProfiles).values({
        restaurantId: restaurant.restaurantId,
        userId: createdUser.id,
        priority: createdUser.priority,
        subRoles: createdUser.subRoles,
        contractType: createdUser.contractType,
        contractHours: createdUser.contractHours,
        contractEndDate: createdUser.contractEndDate,
        maxWeeklyHours: createdUser.maxWeeklyHours,
        adminOtOverride: createdUser.adminOtOverride,
        hcrLevel: createdUser.hcrLevel,
        hourlyRate: createdUser.hourlyRate,
        matricule: createdUser.matricule,
        managerNotes: createdUser.managerNotes,
        multiRestaurantWilling: createdUser.multiRestaurantWilling,
      }).onConflictDoNothing().run();

      return [createdUser];
    });

    created.push({ id: u.id, name: u.name });
  }

  return c.json({ data: { created } });
});

// POST /onboarding/preferred-style — between services and finish
onboardingRoutes.post("/preferred-style", async (c) => {
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const allowed = ["equilibre", "equipe-stable", "economique", "resilience"] as const;
  if (typeof body.preferredStyle !== "string" || !allowed.includes(body.preferredStyle as typeof allowed[number])) {
    return c.json({ error: "Style invalide" }, 400);
  }
  db.update(restaurants)
    .set({ preferredStyle: body.preferredStyle as typeof allowed[number] })
    .where(eq(restaurants.id, restaurant.restaurantId))
    .run();
  return c.json({ data: { ok: true } });
});

// POST /onboarding/complete — step 5: mark done
onboardingRoutes.post("/complete", (c) => {
  const restaurant = requestRestaurant(c);
  db.update(restaurants)
    .set({ onboardingCompletedAt: new Date().toISOString() })
    .where(eq(restaurants.id, restaurant.restaurantId))
    .run();
  return c.json({ data: { ok: true } });
});

// POST /onboarding/reset — dev/test helper, nulls onboarding flag
onboardingRoutes.post("/reset", (c) => {
  if (process.env.NODE_ENV === "production") {
    return c.json({ error: "Désactivé en production" }, 403);
  }
  const restaurant = requestRestaurant(c);
  db.update(restaurants)
    .set({ onboardingCompletedAt: null })
    .where(eq(restaurants.id, restaurant.restaurantId))
    .run();
  return c.json({ data: { ok: true } });
});

// Re-export for convenience
export const KITCHEN_SUBROLES = KITCHEN_DEFAULT_SUBROLES;
export const SALLE_SUBROLES = FLOOR_DEFAULT_SUBROLES;
