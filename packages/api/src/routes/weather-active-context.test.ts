import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-weather-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { weatherRoutes } = await import("./weather.js");

const app = new Hono();
app.route("/weather", weatherRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS weather_data;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS restaurant_memberships;
    DROP TABLE IF EXISTS owner_memberships;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;

    CREATE TABLE owners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      name TEXT NOT NULL,
      address TEXT,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'demo',
      subscription_status TEXT NOT NULL DEFAULT 'active',
      onboarding_completed_at TEXT,
      latitude INTEGER,
      longitude INTEGER,
      school_zone TEXT,
      holiday_zone TEXT
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      user_notice_version TEXT,
      user_notice_accepted_at TEXT,
      whatsapp_opt_in INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE owner_memberships (
      owner_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (owner_id, user_id)
    );

    CREATE TABLE restaurant_memberships (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      permissions TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (restaurant_id, user_id)
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE weather_data (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      weather_code INTEGER,
      temp_max INTEGER,
      temp_min INTEGER,
      sunrise TEXT,
      sunset TEXT,
      normal_temp_max INTEGER,
      normal_temp_min INTEGER,
      hourly_weather_codes TEXT,
      hourly_temperatures TEXT,
      is_forecast INTEGER NOT NULL DEFAULT 1,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo");

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin@example.com", "admin", "a1", 1, null, 0);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare(`
    INSERT INTO weather_data (
      id, restaurant_id, date, weather_code, temp_min, temp_max, sunrise, sunset,
      normal_temp_min, normal_temp_max, hourly_weather_codes, hourly_temperatures, is_forecast
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("weather-a1", "a1", "2026-05-12", 1, 10, 19, "2026-05-12T06:00:00", "2026-05-12T21:00:00", 9, 18, "[1]", "[19]", 0);
  rawDb.prepare(`
    INSERT INTO weather_data (
      id, restaurant_id, date, weather_code, temp_min, temp_max, sunrise, sunset,
      normal_temp_min, normal_temp_max, hourly_weather_codes, hourly_temperatures, is_forecast
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("weather-a2", "a2", "2026-05-12", 2, 12, 23, "2026-05-12T06:10:00", "2026-05-12T21:10:00", 11, 22, "[2]", "[23]", 1);
});

describe("weather routes active restaurant context", () => {
  test("GET /weather returns only active restaurant weather data", async () => {
    const res = await app.request("/weather?from=2026-05-12&to=2026-05-12", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{
        date: "2026-05-12",
        weatherCode: 2,
        tempMax: 23,
        tempMin: 12,
        sunrise: "2026-05-12T06:10:00",
        sunset: "2026-05-12T21:10:00",
        normalTempMax: 22,
        normalTempMin: 11,
        hourlyWeatherCodes: [2],
        hourlyTemperatures: [23],
        isForecast: true,
      }],
    });
  });
});
