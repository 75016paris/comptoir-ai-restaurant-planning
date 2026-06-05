import { describe, expect, test } from "bun:test";
import {
  assertPhase7OwnerDataLocation,
  createStaticPhase7OwnerDataResolver,
} from "./phase7-owner-data-resolver";

describe("Phase 7 owner data resolver draft", () => {
  test("resolves an active owner data location without opening a database", async () => {
    const resolver = createStaticPhase7OwnerDataResolver([
      {
        ownerId: "owner-a",
        databasePath: "/tmp/comptoir/owners/owner-a/comptoir.db",
        status: "active",
      },
    ]);

    await expect(resolver.resolve("owner-a")).resolves.toEqual({
      ownerId: "owner-a",
      databasePath: "/tmp/comptoir/owners/owner-a/comptoir.db",
      status: "active",
    });
  });

  test("fails closed for unknown or disabled owners", async () => {
    const resolver = createStaticPhase7OwnerDataResolver([
      {
        ownerId: "owner-disabled",
        databasePath: "/tmp/comptoir/owners/owner-disabled/comptoir.db",
        status: "disabled",
      },
    ]);

    await expect(resolver.resolve("owner-missing")).resolves.toBeNull();
    await expect(resolver.resolve("owner-disabled")).resolves.toBeNull();
  });

  test("asserts the resolved location still matches the requested owner", () => {
    expect(() => assertPhase7OwnerDataLocation(null, "owner-a")).toThrow("No active Phase 7 owner data location");
    expect(() => assertPhase7OwnerDataLocation({
      ownerId: "owner-b",
      databasePath: "/tmp/comptoir/owners/owner-b/comptoir.db",
      status: "active",
    }, "owner-a")).toThrow("expected owner-a");
  });
});

