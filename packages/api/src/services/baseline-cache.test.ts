import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildCacheKey,
  getCached,
  setCached,
  getCacheSnapshot,
  __resetBaselineCache,
  CACHE_CAP,
  CACHE_TTL_MS,
  type CacheKeyInputs,
} from "./baseline-cache.js";

function makeInputs(over: Partial<CacheKeyInputs> = {}): CacheKeyInputs {
  return {
    restaurantId: "r1",
    profileId: "p1",
    baseMonday: "2026-04-20",
    numWeeks: 4,
    weights: undefined,
    restaurantFingerprint: "fp1",
    cacheVersion: 0,
    templatesChecksum: "t1",
    targetsChecksum: "tg1",
    workersChecksum: "w1",
    ...over,
  };
}

beforeEach(() => {
  __resetBaselineCache();
});

describe("buildCacheKey", () => {
  test("is stable for the same inputs", () => {
    const a = buildCacheKey(makeInputs());
    const b = buildCacheKey(makeInputs());
    expect(a).toBe(b);
  });

  test("different profileId → different key", () => {
    const a = buildCacheKey(makeInputs({ profileId: "p1" }));
    const b = buildCacheKey(makeInputs({ profileId: "p2" }));
    expect(a).not.toBe(b);
  });

  test("undefined vs set profileId produces different keys", () => {
    const a = buildCacheKey(makeInputs({ profileId: undefined }));
    const b = buildCacheKey(makeInputs({ profileId: "p1" }));
    expect(a).not.toBe(b);
  });

  test("cacheVersion bump → different key", () => {
    const a = buildCacheKey(makeInputs({ cacheVersion: 1 }));
    const b = buildCacheKey(makeInputs({ cacheVersion: 2 }));
    expect(a).not.toBe(b);
  });

  test("each checksum field is part of the key", () => {
    const base = buildCacheKey(makeInputs());
    expect(buildCacheKey(makeInputs({ templatesChecksum: "tX" }))).not.toBe(base);
    expect(buildCacheKey(makeInputs({ targetsChecksum: "tgX" }))).not.toBe(base);
    expect(buildCacheKey(makeInputs({ workersChecksum: "wX" }))).not.toBe(base);
    expect(buildCacheKey(makeInputs({ restaurantFingerprint: "fpX" }))).not.toBe(base);
  });

  test("baseMonday and numWeeks matter", () => {
    const base = buildCacheKey(makeInputs());
    expect(buildCacheKey(makeInputs({ baseMonday: "2026-04-27" }))).not.toBe(base);
    expect(buildCacheKey(makeInputs({ numWeeks: 8 }))).not.toBe(base);
  });

  test("weights with different key order produce the same hash", () => {
    const w1 = { fairness: 1, overtime: 2, preference: 3 } as any;
    const w2 = { preference: 3, overtime: 2, fairness: 1 } as any;
    expect(buildCacheKey(makeInputs({ weights: w1 }))).toBe(
      buildCacheKey(makeInputs({ weights: w2 })),
    );
  });

  test("different weights produce different keys", () => {
    const w1 = { fairness: 1 } as any;
    const w2 = { fairness: 2 } as any;
    expect(buildCacheKey(makeInputs({ weights: w1 }))).not.toBe(
      buildCacheKey(makeInputs({ weights: w2 })),
    );
  });

  test("produces a 64-char hex SHA-256", () => {
    const k = buildCacheKey(makeInputs());
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  test("solver env vars are part of the key", () => {
    const keys = ["SOLVER", "SOLVER_MAX_TIER", "CPSAT_NUM_WORKERS", "CPSAT_RANDOM_SEED"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];

    try {
      for (const k of keys) delete process.env[k];
      const base = buildCacheKey(makeInputs());

      for (const k of keys) {
        for (const k2 of keys) delete process.env[k2];
        process.env[k] = "changed";
        expect(buildCacheKey(makeInputs())).not.toBe(base);
      }
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("getCached / setCached", () => {
  test("round-trips a value", () => {
    setCached("k1", { hello: "world" });
    expect(getCached<{ hello: string }>("k1")).toEqual({ hello: "world" });
  });

  test("returns null on miss", () => {
    expect(getCached("nope")).toBeNull();
  });

  test("updates lastAccess + hits on hit", () => {
    setCached("k", 1);
    getCached("k");
    getCached("k");
    const snap = getCacheSnapshot();
    const row = snap.find(s => s.key === "k")!;
    expect(row.hits).toBe(2);
  });

  test("evicts expired entries past TTL", () => {
    const origNow = Date.now;
    const base = origNow();
    setCached("k", "value");
    expect(getCached<string>("k")).toBe("value");

    try {
      Date.now = () => base + CACHE_TTL_MS + 1;
      expect(getCached("k")).toBeNull();
    } finally {
      Date.now = origNow;
    }
    // Expired entry was deleted on read.
    expect(getCacheSnapshot().find(s => s.key === "k")).toBeUndefined();
  });
});

describe("LRU eviction", () => {
  test(`evicts least-recently-accessed entry once size exceeds ${CACHE_CAP}`, () => {
    // Fill cache exactly to cap.
    for (let i = 0; i < CACHE_CAP; i++) {
      setCached(`k${i}`, i);
    }
    expect(getCacheSnapshot().length).toBe(CACHE_CAP);

    // Touch every entry except k0 so k0 has the oldest lastAccess.
    for (let i = 1; i < CACHE_CAP; i++) {
      getCached(`k${i}`);
    }

    // Insert one more — should evict k0.
    setCached("kNew", "new");
    const keys = new Set(getCacheSnapshot().map(s => s.key));
    expect(keys.size).toBe(CACHE_CAP);
    expect(keys.has("k0")).toBe(false);
    expect(keys.has("kNew")).toBe(true);
    // Spot check a touched entry is still present.
    expect(keys.has(`k${CACHE_CAP - 1}`)).toBe(true);
  });

  test("snapshot reports age, hits, and sizeBytesApprox", () => {
    setCached("sKey", { a: 1, b: "hello" });
    getCached("sKey");
    const [row] = getCacheSnapshot();
    expect(row.key).toBe("sKey");
    expect(row.hits).toBe(1);
    expect(row.sizeBytesApprox).toBeGreaterThan(0);
    expect(row.ageMs).toBeGreaterThanOrEqual(0);
  });
});
