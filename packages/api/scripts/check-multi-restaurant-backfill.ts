import { rawDb } from "../src/db/connection.js";
import { collectMultiRestaurantBackfillFailures } from "../src/services/multi-restaurant-backfill-check.js";

const failures = collectMultiRestaurantBackfillFailures(rawDb);

if (failures.length > 0) {
  throw new Error([
    "Multi-restaurant backfill check failed.",
    ...failures.map((failure) => `- ${failure}`),
  ].join("\n"));
}

console.log("Multi-restaurant backfill check passed.");
