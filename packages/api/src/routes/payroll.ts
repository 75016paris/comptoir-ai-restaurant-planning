import { Hono } from "hono";
import { type AppEnv, requireAuth, requireAdmin, requireActiveSubscription } from "../middleware/auth.js";
import { restaurants } from "../db/schema.js";
import { db } from "../db/connection.js";
import { eq } from "drizzle-orm";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { computePayroll, missingSilaeMatricules, normalizeSilaeCodes, payrollToCSV, payrollToSilae, SILAE_DEFAULT_CODES } from "../services/payroll.js";

export const payrollRoutes = new Hono<AppEnv>();

payrollRoutes.use("*", requireAuth);
payrollRoutes.use("*", requireActiveSubscription);
payrollRoutes.use("*", requireAdmin);

// GET /payroll/export?month=2026-03 — JSON payroll data
payrollRoutes.get("/export", async (c) => {
  const restaurant = requestRestaurant(c);
  const monthParam = c.req.query("month");

  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }

  const data = computePayroll(restaurant.restaurantId, monthParam);
  return c.json({ data });
});

// GET /payroll/export/csv?month=2026-03 — CSV download (recap comptable)
payrollRoutes.get("/export/csv", async (c) => {
  const restaurant = requestRestaurant(c);
  const monthParam = c.req.query("month");

  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }

  const data = computePayroll(restaurant.restaurantId, monthParam);
  const csv = payrollToCSV(data);

  const filename = `paie-${monthParam}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// GET /payroll/export/silae?month=2026-03 — Silae import format (flat CSV)
payrollRoutes.get("/export/silae", async (c) => {
  const restaurant = requestRestaurant(c);
  const monthParam = c.req.query("month");

  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }

  const data = computePayroll(restaurant.restaurantId, monthParam);
  const restaurantSettings = db.select({ silaeCodes: restaurants.silaeCodes })
    .from(restaurants)
    .where(eq(restaurants.id, restaurant.restaurantId))
    .get();
  const silaeCodes = normalizeSilaeCodes(JSON.parse(restaurantSettings?.silaeCodes || "{}"));
  const missingMatricules = missingSilaeMatricules(data);
  if (missingMatricules.length > 0) {
    return c.json({
      error: "Export Silae impossible: matricule manquant",
      missingMatricules,
    }, 400);
  }

  const csv = payrollToSilae(data, silaeCodes);

  const filename = `silae-${monthParam}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// GET /payroll/silae-codes — current default rubrique codes
payrollRoutes.get("/silae-codes", async (c) => {
  const restaurantContext = requestRestaurant(c);
  const restaurant = db.select({ silaeCodes: restaurants.silaeCodes })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantContext.restaurantId))
    .get();
  return c.json({ data: normalizeSilaeCodes(JSON.parse(restaurant?.silaeCodes || "{}")), defaults: SILAE_DEFAULT_CODES });
});
