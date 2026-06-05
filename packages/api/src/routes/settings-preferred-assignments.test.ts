import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-settings-test-")), "test.db");

const { db, rawDb } = await import("../db/connection.js");
const { serviceTemplates, serviceTemplateOverrides, staffingProfiles, staffingTargets } = await import("../db/schema.js");
const { replaceStaffingTargetsConfiguration, resolvePreferredAssignmentsForSave } = await import("../services/staffing-target-persistence.js");

function createSchema() {
  rawDb.exec(`
    DROP TABLE IF EXISTS service_template_overrides;
    DROP TABLE IF EXISTS service_templates;
    DROP TABLE IF EXISTS staffing_targets;
    DROP TABLE IF EXISTS staffing_schedule;
    DROP TABLE IF EXISTS staffing_profiles;
    DROP TABLE IF EXISTS restaurants;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE staffing_profiles (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
      name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      day_priorities TEXT NOT NULL DEFAULT '{}',
      preferred_assignments TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE staffing_targets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
      profile_id TEXT REFERENCES staffing_profiles(id),
      day_of_week INTEGER NOT NULL,
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      role_breakdown TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE staffing_schedule (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
      profile_id TEXT NOT NULL REFERENCES staffing_profiles(id),
      year INTEGER NOT NULL,
      week INTEGER NOT NULL
    );

    CREATE TABLE service_templates (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
      profile_id TEXT REFERENCES staffing_profiles(id),
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE service_template_overrides (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES service_templates(id),
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );
  `);
}

beforeEach(() => createSchema());

describe("staffing profile preferredAssignments preservation", () => {
  test("preserves existing titulaire pins when client omits preferredAssignments", () => {
    const pins = JSON.stringify([{ workerId: "w1", dayOfWeek: 1, zone: "Midi", role: "floor" }]);
    const prior = new Map([["profile-1", pins]]);

    expect(resolvePreferredAssignmentsForSave({ id: "profile-1" }, prior)).toBe(pins);
  });

  test("client-provided preferredAssignments override the prior value", () => {
    const prior = new Map([["profile-1", "[{\"workerId\":\"old\"}]"]]);
    const next = [{ workerId: "new", dayOfWeek: 2, zone: "Soir", role: "kitchen" }];

    expect(resolvePreferredAssignmentsForSave({ id: "profile-1", preferredAssignments: next }, prior)).toBe(JSON.stringify(next));
  });

  test("new profiles without pins default to an empty array", () => {
    expect(resolvePreferredAssignmentsForSave({}, new Map())).toBe("[]");
  });

  test("target/template rewrite preserves titulaire pins when payload omits preferredAssignments", () => {
    const restaurantId = "rest-1";
    const profileId = "profile-1";
    const pins = JSON.stringify([{ workerId: "w1", dayOfWeek: 1, zone: "Midi", role: "floor" }]);

    rawDb.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run(restaurantId, "Test");
    db.insert(staffingProfiles).values({
      id: profileId,
      restaurantId,
      name: "Semaine normale",
      sortOrder: 0,
      dayPriorities: JSON.stringify({ 1: 1 }),
      preferredAssignments: pins,
    }).run();

    db.transaction((tx) => {
      replaceStaffingTargetsConfiguration(tx, {
        restaurantId,
        profiles: [{ id: profileId, name: "Semaine normale", sortOrder: 0, dayPriorities: { 1: 2 } }],
        targets: [{ profileId, dayOfWeek: 1, role: "floor", zone: "Midi", count: 2, roleBreakdown: { Serveur: 2 } }],
        profileTemplates: [{
          profileId,
          role: "floor",
          zone: "Midi",
          startTime: "11:00",
          endTime: "15:00",
          sortOrder: 0,
          overrides: [{ dayOfWeek: 1, startTime: "11:30", endTime: "15:30" }],
        }],
      });
    });

    const [profile] = db.select({ preferredAssignments: staffingProfiles.preferredAssignments, dayPriorities: staffingProfiles.dayPriorities })
      .from(staffingProfiles)
      .where(eq(staffingProfiles.id, profileId))
      .all();
    const targets = db.select().from(staffingTargets).where(eq(staffingTargets.profileId, profileId)).all();
    const templates = db.select().from(serviceTemplates).where(eq(serviceTemplates.profileId, profileId)).all();
    const overrides = db.select().from(serviceTemplateOverrides).where(eq(serviceTemplateOverrides.templateId, templates[0].id)).all();

    expect(profile.preferredAssignments).toBe(pins);
    expect(profile.dayPriorities).toBe(JSON.stringify({ 1: 2 }));
    expect(targets).toHaveLength(1);
    expect(templates).toHaveLength(1);
    expect(overrides).toHaveLength(1);
  });

  test("target rewrite preserves per-profile service templates when profileTemplates is omitted", () => {
    const restaurantId = "rest-1";
    const profileId = "profile-1";

    rawDb.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run(restaurantId, "Test");
    db.insert(staffingProfiles).values({
      id: profileId,
      restaurantId,
      name: "Semaine normale",
      sortOrder: 0,
    }).run();
    const [template] = db.insert(serviceTemplates).values({
      restaurantId,
      profileId,
      role: "floor",
      zone: "Midi",
      startTime: "10:00",
      endTime: "18:00",
      sortOrder: 1,
    }).returning({ id: serviceTemplates.id }).all();
    db.insert(serviceTemplateOverrides).values({
      templateId: template.id,
      dayOfWeek: 2,
      startTime: "10:15",
      endTime: "18:15",
    }).run();

    db.transaction((tx) => {
      replaceStaffingTargetsConfiguration(tx, {
        restaurantId,
        profiles: [{ id: profileId, name: "Semaine normale", sortOrder: 0 }],
        targets: [{ profileId, dayOfWeek: 1, role: "floor", zone: "Midi", count: 3 }],
      });
    });

    const templates = db.select().from(serviceTemplates).where(eq(serviceTemplates.profileId, profileId)).all();
    const overrides = db.select().from(serviceTemplateOverrides).where(eq(serviceTemplateOverrides.templateId, templates[0].id)).all();

    expect(templates).toHaveLength(1);
    expect(templates[0].zone).toBe("Midi");
    expect(templates[0].startTime).toBe("10:00");
    expect(overrides).toHaveLength(1);
    expect(overrides[0].startTime).toBe("10:15");
  });

  test("target rewrite clears per-profile service templates when profileTemplates is explicitly empty", () => {
    const restaurantId = "rest-1";
    const profileId = "profile-1";

    rawDb.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run(restaurantId, "Test");
    db.insert(staffingProfiles).values({
      id: profileId,
      restaurantId,
      name: "Semaine normale",
      sortOrder: 0,
    }).run();
    db.insert(serviceTemplates).values({
      restaurantId,
      profileId,
      role: "floor",
      zone: "Midi",
      startTime: "10:00",
      endTime: "18:00",
      sortOrder: 1,
    }).run();

    db.transaction((tx) => {
      replaceStaffingTargetsConfiguration(tx, {
        restaurantId,
        profiles: [{ id: profileId, name: "Semaine normale", sortOrder: 0 }],
        targets: [{ profileId, dayOfWeek: 1, role: "floor", zone: "Midi", count: 3 }],
        profileTemplates: [],
      });
    });

    const templates = db.select().from(serviceTemplates).where(eq(serviceTemplates.profileId, profileId)).all();
    expect(templates).toHaveLength(0);
  });

  test("target/template rewrite updates titulaire pins only when explicitly provided", () => {
    const restaurantId = "rest-1";
    const profileId = "profile-1";
    const oldPins = JSON.stringify([{ workerId: "old", dayOfWeek: 1, zone: "Midi", role: "floor" }]);
    const nextPins = [{ workerId: "new", dayOfWeek: 2, zone: "Soir", role: "kitchen" }];

    rawDb.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run(restaurantId, "Test");
    db.insert(staffingProfiles).values({
      id: profileId,
      restaurantId,
      name: "Semaine normale",
      sortOrder: 0,
      preferredAssignments: oldPins,
    }).run();

    db.transaction((tx) => {
      replaceStaffingTargetsConfiguration(tx, {
        restaurantId,
        profiles: [{ id: profileId, name: "Semaine normale", preferredAssignments: nextPins }],
        targets: [],
        profileTemplates: [],
      });
    });

    const [profile] = db.select({ preferredAssignments: staffingProfiles.preferredAssignments })
      .from(staffingProfiles)
      .where(eq(staffingProfiles.id, profileId))
      .all();

    expect(profile.preferredAssignments).toBe(JSON.stringify(nextPins));
  });
});
