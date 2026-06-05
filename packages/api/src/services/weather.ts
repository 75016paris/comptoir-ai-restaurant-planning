/**
 * Weather service — fetches forecast + historical data from Open-Meteo.
 * Stores per-day weather in weather_data table.
 * Computes seasonal normals from 5-year historical average.
 */

import { db } from "../db/connection.js";
import { weatherData, restaurants } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

// ── WMO Weather Code → icon mapping ──

export type WeatherIcon = "sun" | "partly-cloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "showers" | "thunderstorm";

export function wmoToIcon(code: number): WeatherIcon {
  if (code === 0) return "sun";
  if (code <= 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  return "thunderstorm";
}

// ── Temperature anomaly ──

export type TempAnomaly = null | "+1" | "+2" | "+3" | "-1" | "-2" | "-3";

/** Compute anomaly level based on deviation from normal. Thresholds: ±3°C, ±6°C, ±9°C */
export function tempAnomaly(actual: number, normal: number): TempAnomaly {
  const diff = actual - normal;
  if (diff >= 9) return "+3";
  if (diff >= 6) return "+2";
  if (diff >= 3) return "+1";
  if (diff <= -9) return "-3";
  if (diff <= -6) return "-2";
  if (diff <= -3) return "-1";
  return null;
}

// ── Open-Meteo API calls ──

/** Fetch 7-day forecast + today's weather */
async function fetchForecast(lat: number, lon: number): Promise<{
  daily: Array<{
    date: string;
    weatherCode: number;
    tempMax: number;
    tempMin: number;
    sunrise: string;
    sunset: string;
  }>;
  hourly: Map<string, { weatherCodes: number[]; temperatures: number[] }>;
}> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset`
    + `&hourly=temperature_2m,weather_code`
    + `&timezone=Europe/Paris&past_days=7&forecast_days=7`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo forecast failed: ${res.status}`);
  const data = await res.json();

  const daily = data.daily.time.map((date: string, i: number) => ({
    date,
    weatherCode: data.daily.weather_code[i],
    tempMax: data.daily.temperature_2m_max[i],
    tempMin: data.daily.temperature_2m_min[i],
    sunrise: data.daily.sunrise[i]?.split("T")[1]?.slice(0, 5) || "",
    sunset: data.daily.sunset[i]?.split("T")[1]?.slice(0, 5) || "",
  }));

  // Group hourly by date
  const hourly = new Map<string, { weatherCodes: number[]; temperatures: number[] }>();
  for (let i = 0; i < data.hourly.time.length; i++) {
    const date = data.hourly.time[i].split("T")[0];
    if (!hourly.has(date)) hourly.set(date, { weatherCodes: [], temperatures: [] });
    const entry = hourly.get(date)!;
    entry.weatherCodes.push(data.hourly.weather_code[i]);
    entry.temperatures.push(data.hourly.temperature_2m[i]);
  }

  return { daily, hourly };
}

/** Fetch historical weather for a date range (confirmed actuals) */
async function fetchHistorical(lat: number, lon: number, startDate: string, endDate: string): Promise<{
  daily: Array<{ date: string; weatherCode: number; tempMax: number; tempMin: number }>;
  hourly: Map<string, { weatherCodes: number[]; temperatures: number[] }>;
}> {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}`
    + `&start_date=${startDate}&end_date=${endDate}`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min`
    + `&hourly=temperature_2m,weather_code`
    + `&timezone=Europe/Paris`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo historical failed: ${res.status}`);
  const data = await res.json();

  const daily = data.daily.time.map((date: string, i: number) => ({
    date,
    weatherCode: data.daily.weather_code[i],
    tempMax: data.daily.temperature_2m_max[i],
    tempMin: data.daily.temperature_2m_min[i],
  }));

  const hourly = new Map<string, { weatherCodes: number[]; temperatures: number[] }>();
  for (let i = 0; i < data.hourly.time.length; i++) {
    const date = data.hourly.time[i].split("T")[0];
    if (!hourly.has(date)) hourly.set(date, { weatherCodes: [], temperatures: [] });
    const entry = hourly.get(date)!;
    entry.weatherCodes.push(data.hourly.weather_code[i]);
    entry.temperatures.push(data.hourly.temperature_2m[i]);
  }

  return { daily, hourly };
}

/** Compute seasonal normals by averaging the same date range over the past 5 years */
async function fetchSeasonalNormals(lat: number, lon: number, dates: string[]): Promise<Map<string, { normalMax: number; normalMin: number }>> {
  const normals = new Map<string, { maxSum: number; minSum: number; count: number }>();

  // For each of the past 5 years, fetch the same date range
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const firstYear = parseInt(firstDate.slice(0, 4));

  for (let yearOffset = 1; yearOffset <= 5; yearOffset++) {
    const year = firstYear - yearOffset;
    const start = `${year}${firstDate.slice(4)}`;
    const end = `${year}${lastDate.slice(4)}`;

    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}`
        + `&start_date=${start}&end_date=${end}`
        + `&daily=temperature_2m_max,temperature_2m_min`
        + `&timezone=Europe/Paris`;

      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      for (let i = 0; i < data.daily.time.length; i++) {
        // Map to current year's date for lookup
        const historicalDate = data.daily.time[i];
        const currentYearDate = `${firstYear}${historicalDate.slice(4)}`;

        if (!normals.has(currentYearDate)) normals.set(currentYearDate, { maxSum: 0, minSum: 0, count: 0 });
        const n = normals.get(currentYearDate)!;
        if (data.daily.temperature_2m_max[i] != null) {
          n.maxSum += data.daily.temperature_2m_max[i];
          n.minSum += data.daily.temperature_2m_min[i];
          n.count++;
        }
      }
    } catch {
      // Skip failed year
    }
  }

  const result = new Map<string, { normalMax: number; normalMin: number }>();
  for (const [date, n] of normals) {
    if (n.count > 0) {
      result.set(date, {
        normalMax: Math.round(n.maxSum / n.count * 10) / 10,
        normalMin: Math.round(n.minSum / n.count * 10) / 10,
      });
    }
  }
  return result;
}

// ── Geocoding ──

/** Geocode an address to lat/lon using Open-Meteo's geocoding API */
/**
 * Geocode a French address using api-adresse.data.gouv.fr (BAN).
 * Handles full addresses, city names, and postal codes.
 * Returns coordinates + postcode for zone detection.
 */
export async function geocodeAddress(address: string): Promise<{ lat: number; lon: number; postcode?: string; city?: string } | null> {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const feature = data.features?.[0];
    if (!feature) return null;
    const [lon, lat] = feature.geometry.coordinates;
    return {
      lat,
      lon,
      postcode: feature.properties?.postcode || undefined,
      city: feature.properties?.city || undefined,
    };
  } catch {
    return null;
  }
}

// ── Main refresh function ──

/** Refresh weather data for a restaurant — forecast + seasonal normals */
export async function refreshWeather(restaurantId: string): Promise<{ updated: number; errors: string[] }> {
  const [restaurant] = db.select({
    lat: restaurants.latitude,
    lon: restaurants.longitude,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();

  if (!restaurant?.lat || !restaurant?.lon) {
    return { updated: 0, errors: ["Restaurant has no coordinates — set address in preferences"] };
  }

  // Coordinates stored as micro-degrees (×1e6) — convert to decimal for APIs
  const lat = restaurant.lat > 1000 ? restaurant.lat / 1e6 : restaurant.lat;
  const lon = restaurant.lon > 1000 ? restaurant.lon / 1e6 : restaurant.lon;
  const errors: string[] = [];
  let updated = 0;

  try {
    // Fetch 7-day forecast
    const forecast = await fetchForecast(lat, lon);
    const dates = forecast.daily.map(d => d.date);

    // Fetch seasonal normals
    const normals = await fetchSeasonalNormals(lat, lon, dates);

    // Upsert each day
    for (const day of forecast.daily) {
      const hourly = forecast.hourly.get(day.date);
      const normal = normals.get(day.date);

      // Check if already exists
      const existing = db.select({ id: weatherData.id, isForecast: weatherData.isForecast })
        .from(weatherData)
        .where(and(eq(weatherData.restaurantId, restaurantId), eq(weatherData.date, day.date)))
        .limit(1).all();

      // Don't overwrite confirmed historical data with forecast
      if (existing.length > 0 && !existing[0].isForecast) continue;

      const values = {
        restaurantId,
        date: day.date,
        weatherCode: day.weatherCode,
        tempMax: day.tempMax,
        tempMin: day.tempMin,
        sunrise: day.sunrise,
        sunset: day.sunset,
        normalTempMax: normal?.normalMax ?? null,
        normalTempMin: normal?.normalMin ?? null,
        hourlyWeatherCodes: hourly ? JSON.stringify(hourly.weatherCodes) : null,
        hourlyTemperatures: hourly ? JSON.stringify(hourly.temperatures) : null,
        isForecast: true,
      };

      if (existing.length > 0) {
        db.update(weatherData)
          .set({ ...values, fetchedAt: new Date().toISOString() })
          .where(eq(weatherData.id, existing[0].id))
          .run();
      } else {
        db.insert(weatherData).values(values).run();
      }
      updated++;
    }
  } catch (e: any) {
    errors.push(`Forecast fetch failed: ${e.message}`);
  }

  return { updated, errors };
}

/** Confirm yesterday's weather with actual historical data */
export async function confirmYesterdayWeather(restaurantId: string): Promise<boolean> {
  const [restaurant] = db.select({
    lat: restaurants.latitude,
    lon: restaurants.longitude,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();

  if (!restaurant?.lat || !restaurant?.lon) return false;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  try {
    const historical = await fetchHistorical(restaurant.lat, restaurant.lon, dateStr, dateStr);
    if (historical.daily.length === 0) return false;

    const day = historical.daily[0];
    const hourly = historical.hourly.get(dateStr);

    const existing = db.select({ id: weatherData.id })
      .from(weatherData)
      .where(and(eq(weatherData.restaurantId, restaurantId), eq(weatherData.date, dateStr)))
      .limit(1).all();

    const values = {
      restaurantId,
      date: dateStr,
      weatherCode: day.weatherCode,
      tempMax: day.tempMax,
      tempMin: day.tempMin,
      hourlyWeatherCodes: hourly ? JSON.stringify(hourly.weatherCodes) : null,
      hourlyTemperatures: hourly ? JSON.stringify(hourly.temperatures) : null,
      isForecast: false,
      fetchedAt: new Date().toISOString(),
    };

    if (existing.length > 0) {
      db.update(weatherData).set(values).where(eq(weatherData.id, existing[0].id)).run();
    } else {
      db.insert(weatherData).values(values).run();
    }

    return true;
  } catch {
    return false;
  }
}
