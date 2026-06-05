import { describe, expect, test } from "bun:test";
import {
  phase7MasterSchemaTableNames,
  phase7Owners,
  phase7Sessions,
} from "./phase7-master-schema";

describe("Phase 7 master schema draft", () => {
  test("keeps the master schema focused on login, owner routing, and account state", () => {
    expect([...phase7MasterSchemaTableNames]).toEqual([
      "login_identities",
      "owners",
      "owner_memberships",
      "sessions",
      "password_reset_tokens",
      "pending_registrations",
      "owner_legal_acceptances",
      "phone_routes",
      "whatsapp_context_sessions",
      "notifications",
      "chat_messages",
      "cron_runs",
    ]);
  });

  test("stores owner database routing on the owner control-plane row", () => {
    expect(phase7Owners.databasePath.name).toBe("database_path");
  });

  test("stores active owner and restaurant context in master sessions", () => {
    expect(phase7Sessions.activeOwnerId.name).toBe("active_owner_id");
    expect(phase7Sessions.activeRestaurantId.name).toBe("active_restaurant_id");
  });
});
