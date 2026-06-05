import type { Context } from "hono";
import type { AppEnv, AuthUser } from "./auth.js";

export type RequestRestaurantContext = {
  ownerId: string;
  restaurantId: string;
  role: AuthUser["role"];
  permissions: string | null;
  timezone: string;
};

export function requestRestaurant(c: Context<AppEnv>): RequestRestaurantContext {
  const user = c.get("user");
  return {
    ownerId: user.ownerId,
    restaurantId: user.activeRestaurantId,
    role: user.role,
    permissions: user.permissions,
    timezone: user.restaurantTimezone,
  };
}
