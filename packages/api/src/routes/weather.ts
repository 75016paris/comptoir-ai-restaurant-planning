import { Hono } from "hono";
import { type AppEnv, requireAuth, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { db } from "../db/connection.js";
import { weatherData, restaurants } from "../db/schema.js";
import { eq, and, gte, lte } from "drizzle-orm";
import { refreshWeather, confirmYesterdayWeather, geocodeAddress } from "../services/weather.js";
import { detectZones, detectZonesFromPostcode, refreshCalendarEvents } from "../services/calendar.js";

export const weatherRoutes = new Hono<AppEnv>();
weatherRoutes.use("*", requireAuth);
weatherRoutes.use("*", requireActiveSubscription);

// GET /weather?from=YYYY-MM-DD&to=YYYY-MM-DD — get weather data for date range
weatherRoutes.get("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!from || !to) return c.json({ error: "from and to query params required" }, 400);

  const rows = db.select()
    .from(weatherData)
    .where(and(
      eq(weatherData.restaurantId, restaurant.restaurantId),
      gte(weatherData.date, from),
      lte(weatherData.date, to),
    ))
    .all();

  // Parse JSON fields
  const data = rows.map(r => ({
    date: r.date,
    weatherCode: r.weatherCode,
    tempMax: r.tempMax,
    tempMin: r.tempMin,
    sunrise: r.sunrise,
    sunset: r.sunset,
    normalTempMax: r.normalTempMax,
    normalTempMin: r.normalTempMin,
    hourlyWeatherCodes: r.hourlyWeatherCodes ? JSON.parse(r.hourlyWeatherCodes) : null,
    hourlyTemperatures: r.hourlyTemperatures ? JSON.parse(r.hourlyTemperatures) : null,
    isForecast: r.isForecast,
  }));

  return c.json({ data });
});

// POST /weather/refresh — manually trigger weather refresh (admin only)
weatherRoutes.post("/refresh", async (c) => {
  const user = c.get("user");
  const restaurantContext = requestRestaurant(c);
  if (user.role !== "admin") return c.json({ error: "Admin only" }, 403);

  // Check if restaurant has coordinates
  const [restaurant] = db.select({
    lat: restaurants.latitude,
    lon: restaurants.longitude,
    name: restaurants.name,
    address: restaurants.address,
  }).from(restaurants).where(eq(restaurants.id, restaurantContext.restaurantId)).limit(1).all();

  // If no coordinates, try geocoding the restaurant address (or name as fallback)
  if (!restaurant?.lat || !restaurant?.lon) {
    const query = restaurant?.address || restaurant?.name || "Paris";
    const coords = await geocodeAddress(query);
    if (coords) {
      db.update(restaurants)
        .set({ latitude: Math.round(coords.lat * 1e6), longitude: Math.round(coords.lon * 1e6) })
        .where(eq(restaurants.id, restaurantContext.restaurantId))
        .run();
    }
  }

  const result = await refreshWeather(restaurantContext.restaurantId);

  // Also confirm yesterday
  await confirmYesterdayWeather(restaurantContext.restaurantId);

  return c.json({ data: result });
});

// POST /weather/geocode — geocode the restaurant address and save coordinates
weatherRoutes.post("/geocode", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (user.role !== "admin") return c.json({ error: "Admin only" }, 403);

  const { address } = await c.req.json();
  if (!address) return c.json({ error: "address required" }, 400);

  const coords = await geocodeAddress(address);
  if (!coords) return c.json({ error: "Adresse non trouvée" }, 404);

  // Detect school/holiday zones — prefer postcode from geocode response, fallback to address parsing
  const zones = (coords.postcode ? detectZonesFromPostcode(coords.postcode) : null) || detectZones(address);
  db.update(restaurants)
    .set({
      latitude: Math.round(coords.lat * 1e6), longitude: Math.round(coords.lon * 1e6), address,
      ...(zones ? { schoolZone: zones.schoolZone, holidayZone: zones.holidayZone } : {}),
    })
    .where(eq(restaurants.id, restaurant.restaurantId))
    .run();

  // Refresh calendar events in background if zones detected
  if (zones) refreshCalendarEvents(restaurant.restaurantId).catch(() => {});

  return c.json({ data: { ...coords, ...(zones || {}) } });
});
