-- Weather data table — stores daily + hourly weather per restaurant
-- Forecast data refreshed daily, historical confirmed at end of day

ALTER TABLE restaurants ADD COLUMN latitude REAL;
ALTER TABLE restaurants ADD COLUMN longitude REAL;

CREATE TABLE weather_data (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  date TEXT NOT NULL,
  -- Daily summary
  weather_code INTEGER,           -- WMO weather code (0=clear, 1-3=clouds, 45-48=fog, 51-67=rain, 71-77=snow, 80-82=showers, 95-99=thunderstorm)
  temp_max REAL,                  -- °C
  temp_min REAL,                  -- °C
  sunrise TEXT,                   -- HH:MM
  sunset TEXT,                    -- HH:MM
  -- Seasonal normals for comparison
  normal_temp_max REAL,           -- °C — average of same date over past 5 years
  normal_temp_min REAL,           -- °C
  -- Hourly data as JSON arrays (24 entries, index 0 = 00:00)
  hourly_weather_codes TEXT,      -- JSON: [0, 0, 1, 2, 3, 61, ...]
  hourly_temperatures TEXT,       -- JSON: [8.2, 7.5, 7.1, ...]
  -- Source tracking
  is_forecast INTEGER NOT NULL DEFAULT 1,  -- 1=forecast, 0=confirmed historical
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(restaurant_id, date)
);
