import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { requireAuth, requireAdmin, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { refreshCalendarEvents, getCalendarEventsInRange } from "../services/calendar.js";

export const calendarRoutes = new Hono<AppEnv>();

calendarRoutes.use("*", requireAuth);
calendarRoutes.use("*", requireActiveSubscription);

// GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
calendarRoutes.get("/", async (c) => {
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) return c.json({ error: "from and to required" }, 400);

  const events = getCalendarEventsInRange(restaurant.restaurantId, from, to);
  return c.json({ data: events });
});

// POST /calendar/refresh — re-fetch holidays + vacations from gov APIs (admin only)
calendarRoutes.post("/refresh", requireAdmin, async (c) => {
  const restaurant = requestRestaurant(c);
  const result = await refreshCalendarEvents(restaurant.restaurantId);
  return c.json({ data: result });
});
