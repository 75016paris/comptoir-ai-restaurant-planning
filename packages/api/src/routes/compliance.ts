import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { requireAuth, requirePermission, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { checkCompliance, getComplianceRulesMeta } from "../services/compliance.js";

export const complianceRoutes = new Hono<AppEnv>();

complianceRoutes.use("*", requireAuth);
complianceRoutes.use("*", requireActiveSubscription);

// GET /compliance/check?date=2026-03-30
// Checks the week containing that date against French HCR labor rules
complianceRoutes.get("/check", requirePermission("TEAM_VIEW"), async (c) => {
  const restaurant = requestRestaurant(c);
  const date = c.req.query("date");

  if (!date) {
    return c.json({ error: "date query param required" }, 400);
  }

  const result = checkCompliance(restaurant.restaurantId, date);
  return c.json({ data: result });
});

// GET /compliance/rules
// Returns metadata about all compliance rules (for preferences UI)
complianceRoutes.get("/rules", requirePermission("TEAM_VIEW"), async (c) => {
  return c.json({ data: getComplianceRulesMeta() });
});
