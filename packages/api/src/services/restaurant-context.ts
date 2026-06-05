import { rawDb } from "../db/connection.js";

export type RestaurantRole = "admin" | "manager" | "kitchen" | "floor";
export type OwnerRole = "owner_admin" | "owner_manager" | "member";

export type AccessibleRestaurant = {
  id: string;
  ownerId: string;
  name: string;
  status: string;
  timezone: string;
  onboardingCompletedAt: string | null;
  role: RestaurantRole;
  ownerRole: OwnerRole;
  permissions: string | null;
  active: boolean;
};

export type RestaurantContext = AccessibleRestaurant & {
  restaurantId: string;
};

export type SchedulingRosterWorker = {
  id: string;
  name: string;
  role: RestaurantRole;
  priority: number;
  subRoles: string;
  contractHours: number | null;
  maxWeeklyHours: number | null;
  phone: string | null;
  active: boolean;
  restaurantId: string;
  sharedFromRestaurantId?: string;
  primaryRestaurantId?: string | null;
  primaryRestaurantName?: string | null;
  primaryKitchenColor?: string | null;
  primaryFloorColor?: string | null;
};

function tableExists(tableName: string): boolean {
  const row = rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

export function columnExists(tableName: string, columnName: string): boolean {
  const rows = rawDb.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function normalizeRestaurantRole(role: string): RestaurantRole {
  if (role === "admin" || role === "manager" || role === "kitchen" || role === "floor") return role;
  return "floor";
}

function ownerRoleForRestaurantRole(role: RestaurantRole): OwnerRole {
  if (role === "admin") return "owner_admin";
  if (role === "manager") return "owner_manager";
  return "member";
}

function hasV2MembershipModel(): boolean {
  return tableExists("restaurant_memberships")
    && tableExists("owner_memberships")
    && columnExists("restaurants", "owner_id");
}

function sharedWorkerWillingPredicate(): string {
  if (columnExists("users", "multi_restaurant_willing")) {
    return "u.multi_restaurant_willing = 1";
  }
  if (columnExists("worker_restaurant_profiles", "multi_restaurant_willing")) {
    return "target_profile.multi_restaurant_willing = 1";
  }
  return "1 = 1";
}

function sharedWorkerTargetProfileWillingPredicate(): string {
  if (columnExists("worker_restaurant_profiles", "multi_restaurant_willing")) {
    return "target_profile.multi_restaurant_willing = 1";
  }
  if (columnExists("users", "multi_restaurant_willing")) {
    return "u.multi_restaurant_willing = 1";
  }
  return "1 = 1";
}

function fallbackAccessibleRestaurants(userId: string): AccessibleRestaurant[] {
  const hasOwnerId = columnExists("restaurants", "owner_id");
  const hasOnboardingCompletedAt = columnExists("restaurants", "onboarding_completed_at");
  const ownerExpression = hasOwnerId ? "COALESCE(r.owner_id, r.id)" : "r.id";
  const onboardingExpression = hasOnboardingCompletedAt ? "r.onboarding_completed_at" : "NULL";
  const rows = rawDb.query(`
    SELECT
      r.id,
      ${ownerExpression} AS ownerId,
      r.name,
      r.status,
      r.timezone,
      ${onboardingExpression} AS onboardingCompletedAt,
      u.role,
      u.permissions,
      u.active
    FROM users u
    INNER JOIN restaurants r ON r.id = u.restaurant_id
    WHERE u.id = ?
    LIMIT 1
  `).all(userId) as Array<{
    id: string;
    ownerId: string | null;
    name: string;
    status: string;
    timezone: string;
    onboardingCompletedAt: string | null;
    role: string;
    permissions: string | null;
    active: number | boolean;
  }>;

  return rows.map((row) => {
    const role = normalizeRestaurantRole(row.role);
    return {
      id: row.id,
      ownerId: row.ownerId ?? row.id,
      name: row.name,
      status: row.status,
      timezone: row.timezone,
      onboardingCompletedAt: row.onboardingCompletedAt ?? null,
      role,
      ownerRole: ownerRoleForRestaurantRole(role),
      permissions: row.permissions ?? null,
      active: row.active === true || row.active === 1,
    };
  });
}

export function listAccessibleRestaurants(userId: string): AccessibleRestaurant[] {
  if (!hasV2MembershipModel()) {
    return fallbackAccessibleRestaurants(userId);
  }

  const onboardingExpression = columnExists("restaurants", "onboarding_completed_at") ? "r.onboarding_completed_at" : "NULL";
  const rows = rawDb.query(`
    SELECT
      r.id,
      COALESCE(r.owner_id, r.id) AS ownerId,
      r.name,
      r.status,
      r.timezone,
      ${onboardingExpression} AS onboardingCompletedAt,
      rm.role,
      COALESCE(om.role, 'member') AS ownerRole,
      rm.permissions,
      rm.active
    FROM restaurant_memberships rm
    INNER JOIN restaurants r ON r.id = rm.restaurant_id
    LEFT JOIN owner_memberships om ON om.owner_id = r.owner_id AND om.user_id = rm.user_id
    WHERE rm.user_id = ? AND rm.active = 1
    ORDER BY r.name COLLATE NOCASE ASC, r.id ASC
  `).all(userId) as Array<{
    id: string;
    ownerId: string | null;
    name: string;
    status: string;
    timezone: string;
    onboardingCompletedAt: string | null;
    role: string;
    ownerRole: string | null;
    permissions: string | null;
    active: number | boolean;
  }>;

  if (rows.length === 0) {
    return fallbackAccessibleRestaurants(userId);
  }

  return rows.map((row) => ({
    id: row.id,
    ownerId: row.ownerId ?? row.id,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    onboardingCompletedAt: row.onboardingCompletedAt ?? null,
    role: normalizeRestaurantRole(row.role),
    ownerRole: row.ownerRole === "owner_admin" || row.ownerRole === "owner_manager" ? row.ownerRole : "member",
    permissions: row.permissions ?? null,
    active: row.active === true || row.active === 1,
  }));
}

export function resolveRestaurantContext(userId: string, restaurantId?: string | null): RestaurantContext | null {
  const restaurants = listAccessibleRestaurants(userId);
  if (restaurants.length === 0) return null;

  const selected = restaurantId
    ? restaurants.find((restaurant) => restaurant.id === restaurantId)
    : restaurants[0];
  if (!selected) return null;

  return {
    ...selected,
    restaurantId: selected.id,
  };
}

export function resolveSharedWorkerRestaurantContext(userId: string, restaurantId: string): RestaurantContext | null {
  if (!hasV2MembershipModel() || !tableExists("worker_share_authorizations") || !tableExists("worker_restaurant_profiles")) {
    return null;
  }

  const onboardingExpression = columnExists("restaurants", "onboarding_completed_at")
    ? "target_restaurant.onboarding_completed_at"
    : "NULL";
  const willingPredicate = sharedWorkerWillingPredicate();
  const row = rawDb.query(`
    SELECT
      target_restaurant.id,
      target_restaurant.owner_id AS ownerId,
      target_restaurant.name,
      target_restaurant.status,
      target_restaurant.timezone,
      ${onboardingExpression} AS onboardingCompletedAt,
      wsa.role,
      COALESCE(om.role, 'member') AS ownerRole
    FROM worker_share_authorizations wsa
    INNER JOIN restaurants target_restaurant ON target_restaurant.id = wsa.target_restaurant_id
    INNER JOIN restaurants source_restaurant ON source_restaurant.id = wsa.source_restaurant_id
    INNER JOIN users u ON u.id = wsa.user_id
    INNER JOIN owner_memberships om ON om.owner_id = wsa.owner_id AND om.user_id = wsa.user_id
    INNER JOIN restaurant_memberships source_membership
      ON source_membership.restaurant_id = wsa.source_restaurant_id
      AND source_membership.user_id = wsa.user_id
      AND source_membership.role = wsa.role
      AND source_membership.active = 1
    INNER JOIN worker_restaurant_profiles target_profile
      ON target_profile.restaurant_id = wsa.target_restaurant_id
      AND target_profile.user_id = wsa.user_id
    WHERE wsa.user_id = ?
      AND wsa.target_restaurant_id = ?
      AND wsa.status = 'accepted'
      AND wsa.worker_consented_at IS NOT NULL
      AND wsa.revoked_at IS NULL
      AND u.active = 1
      AND ${willingPredicate}
      AND target_restaurant.owner_id = wsa.owner_id
      AND source_restaurant.owner_id = wsa.owner_id
      AND NOT EXISTS (
        SELECT 1
        FROM restaurant_memberships local_membership
        WHERE local_membership.restaurant_id = wsa.target_restaurant_id
          AND local_membership.user_id = wsa.user_id
          AND local_membership.active = 1
      )
    LIMIT 1
  `).get(userId, restaurantId) as {
    id: string;
    ownerId: string | null;
    name: string;
    status: string;
    timezone: string;
    onboardingCompletedAt: string | null;
    role: string;
    ownerRole: string | null;
  } | null;

  if (!row?.ownerId) return null;

  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    onboardingCompletedAt: row.onboardingCompletedAt ?? null,
    role: normalizeRestaurantRole(row.role),
    ownerRole: "member",
    permissions: "{}",
    active: true,
    restaurantId: row.id,
  };
}

function userHasRestaurantMembershipInternal(
  userId: string,
  restaurantId: string,
  roles?: RestaurantRole[],
  requireActiveUser = true,
): boolean {
  if (hasV2MembershipModel()) {
    const params: string[] = [restaurantId, userId];
    const roleFilter = roles?.length ? `AND rm.role IN (${roles.map(() => "?").join(", ")})` : "";
    if (roles?.length) params.push(...roles);
    const activeUserFilter = requireActiveUser ? "AND u.active = 1" : "";
    const row = rawDb.query(`
      SELECT 1
      FROM restaurant_memberships rm
      INNER JOIN users u ON u.id = rm.user_id
      WHERE rm.restaurant_id = ?
        AND rm.user_id = ?
        AND rm.active = 1
        ${activeUserFilter}
        ${roleFilter}
      LIMIT 1
    `).get(...params);
    return !!row;
  }

  const params: string[] = [userId, restaurantId];
  const roleFilter = roles?.length ? `AND role IN (${roles.map(() => "?").join(", ")})` : "";
  if (roles?.length) params.push(...roles);
  const activeUserFilter = requireActiveUser ? "AND active = 1" : "";
  const row = rawDb.query(`
    SELECT 1
    FROM users
    WHERE id = ?
      AND restaurant_id = ?
      ${activeUserFilter}
      ${roleFilter}
    LIMIT 1
  `).get(...params);
  return !!row;
}

export function userHasRestaurantMembership(
  userId: string,
  restaurantId: string,
  roles?: RestaurantRole[],
): boolean {
  return userHasRestaurantMembershipInternal(userId, restaurantId, roles, false);
}

export function userHasActiveRestaurantMembership(
  userId: string,
  restaurantId: string,
  roles?: RestaurantRole[],
): boolean {
  return userHasRestaurantMembershipInternal(userId, restaurantId, roles, true);
}

export function listOwnerRestaurantIdsForRestaurant(restaurantId: string): string[] {
  if (!hasV2MembershipModel()) return [restaurantId];
  const row = rawDb.query("SELECT owner_id AS ownerId FROM restaurants WHERE id = ?").get(restaurantId) as { ownerId: string | null } | undefined;
  if (!row?.ownerId) return [restaurantId];
  const rows = rawDb.query("SELECT id FROM restaurants WHERE owner_id = ? ORDER BY id").all(row.ownerId) as Array<{ id: string }>;
  const ids = rows.map((r) => r.id);
  return ids.includes(restaurantId) ? ids : [...ids, restaurantId];
}

export function userCanBeScheduledInRestaurant(
  userId: string,
  restaurantId: string,
  roles?: RestaurantRole[],
): boolean {
  if (userHasActiveRestaurantMembership(userId, restaurantId, roles)) return true;
  if (!hasV2MembershipModel() || !tableExists("worker_share_authorizations") || !tableExists("worker_restaurant_profiles")) {
    return false;
  }

  const params: string[] = [userId, restaurantId];
  const roleFilter = roles?.length ? `AND wsa.role IN (${roles.map(() => "?").join(", ")})` : "";
  if (roles?.length) params.push(...roles);
  const willingPredicate = sharedWorkerWillingPredicate();
  const row = rawDb.query(`
    SELECT 1
    FROM worker_share_authorizations wsa
    INNER JOIN restaurants target_restaurant ON target_restaurant.id = wsa.target_restaurant_id
    INNER JOIN restaurants source_restaurant ON source_restaurant.id = wsa.source_restaurant_id
    INNER JOIN users u ON u.id = wsa.user_id
    INNER JOIN owner_memberships om ON om.owner_id = wsa.owner_id AND om.user_id = wsa.user_id
    INNER JOIN restaurant_memberships source_membership
      ON source_membership.restaurant_id = wsa.source_restaurant_id
      AND source_membership.user_id = wsa.user_id
      AND source_membership.role = wsa.role
      AND source_membership.active = 1
    INNER JOIN worker_restaurant_profiles target_profile
      ON target_profile.restaurant_id = wsa.target_restaurant_id
      AND target_profile.user_id = wsa.user_id
    WHERE wsa.user_id = ?
      AND wsa.target_restaurant_id = ?
      AND wsa.status = 'accepted'
      AND wsa.worker_consented_at IS NOT NULL
      AND wsa.revoked_at IS NULL
      AND u.active = 1
      AND ${willingPredicate}
      AND target_restaurant.owner_id = wsa.owner_id
      AND source_restaurant.owner_id = wsa.owner_id
      AND NOT EXISTS (
        SELECT 1
        FROM restaurant_memberships local_membership
        WHERE local_membership.restaurant_id = wsa.target_restaurant_id
          AND local_membership.user_id = wsa.user_id
          AND local_membership.active = 1
      )
      ${roleFilter}
    LIMIT 1
  `).get(...params);
  return !!row;
}

export function listAcceptedSharedSchedulingWorkers(
  restaurantId: string,
  roles?: RestaurantRole[],
): SchedulingRosterWorker[] {
  if (!hasV2MembershipModel() || !tableExists("worker_share_authorizations") || !tableExists("worker_restaurant_profiles")) {
    return [];
  }

  const params: string[] = [restaurantId];
  const roleFilter = roles?.length ? `AND wsa.role IN (${roles.map(() => "?").join(", ")})` : "";
  if (roles?.length) params.push(...roles);
  const sourceRestaurantNameExpression = columnExists("restaurants", "name") ? "source_restaurant.name" : "NULL";
  const sourceKitchenColorExpression = columnExists("restaurants", "kitchen_color") ? "source_restaurant.kitchen_color" : "NULL";
  const sourceFloorColorExpression = columnExists("restaurants", "floor_color") ? "source_restaurant.floor_color" : "NULL";
  const targetProfileMaxWeeklyHours = columnExists("worker_restaurant_profiles", "admin_ot_override")
    ? "COALESCE(target_profile.admin_ot_override, target_profile.max_weekly_hours)"
    : columnExists("worker_restaurant_profiles", "max_weekly_hours")
      ? "target_profile.max_weekly_hours"
      : "NULL";
  const willingPredicate = sharedWorkerTargetProfileWillingPredicate();

  const rows = rawDb.query(`
    SELECT
      u.id,
      u.name,
      wsa.role,
      target_profile.priority,
      target_profile.sub_roles AS subRoles,
      target_profile.contract_hours AS contractHours,
      ${targetProfileMaxWeeklyHours} AS maxWeeklyHours,
      wsa.target_restaurant_id AS restaurantId,
      wsa.source_restaurant_id AS sharedFromRestaurantId,
      wsa.source_restaurant_id AS primaryRestaurantId,
      ${sourceRestaurantNameExpression} AS primaryRestaurantName,
      ${sourceKitchenColorExpression} AS primaryKitchenColor,
      ${sourceFloorColorExpression} AS primaryFloorColor
    FROM worker_share_authorizations wsa
    INNER JOIN restaurants target_restaurant ON target_restaurant.id = wsa.target_restaurant_id
    INNER JOIN restaurants source_restaurant ON source_restaurant.id = wsa.source_restaurant_id
    INNER JOIN users u ON u.id = wsa.user_id
    INNER JOIN owner_memberships om ON om.owner_id = wsa.owner_id AND om.user_id = wsa.user_id
    INNER JOIN restaurant_memberships source_membership
      ON source_membership.restaurant_id = wsa.source_restaurant_id
      AND source_membership.user_id = wsa.user_id
      AND source_membership.role = wsa.role
      AND source_membership.active = 1
    INNER JOIN worker_restaurant_profiles target_profile
      ON target_profile.restaurant_id = wsa.target_restaurant_id
      AND target_profile.user_id = wsa.user_id
    WHERE wsa.target_restaurant_id = ?
      AND wsa.status = 'accepted'
      AND wsa.worker_consented_at IS NOT NULL
      AND wsa.revoked_at IS NULL
      AND u.active = 1
      AND ${willingPredicate}
      AND target_restaurant.owner_id = wsa.owner_id
      AND source_restaurant.owner_id = wsa.owner_id
      AND NOT EXISTS (
        SELECT 1
        FROM restaurant_memberships local_membership
        WHERE local_membership.restaurant_id = wsa.target_restaurant_id
          AND local_membership.user_id = wsa.user_id
          AND local_membership.active = 1
      )
      ${roleFilter}
    ORDER BY target_profile.priority ASC, u.name COLLATE NOCASE ASC, u.id ASC
  `).all(...params) as Array<{
    id: string;
    name: string;
    role: string;
    priority: number;
    subRoles: string;
    contractHours: number | null;
    maxWeeklyHours: number | null;
    restaurantId: string;
    sharedFromRestaurantId: string;
    primaryRestaurantId: string | null;
    primaryRestaurantName: string | null;
    primaryKitchenColor: string | null;
    primaryFloorColor: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: normalizeRestaurantRole(row.role),
    priority: row.priority,
    subRoles: row.subRoles,
    contractHours: row.contractHours,
    maxWeeklyHours: row.maxWeeklyHours,
    phone: null,
    active: true,
    restaurantId: row.restaurantId,
    sharedFromRestaurantId: row.sharedFromRestaurantId,
    primaryRestaurantId: row.primaryRestaurantId,
    primaryRestaurantName: row.primaryRestaurantName,
    primaryKitchenColor: row.primaryKitchenColor,
    primaryFloorColor: row.primaryFloorColor,
  }));
}

export function listSchedulingRosterWorkers(
  restaurantId: string,
  roles: RestaurantRole[] = ["kitchen", "floor"],
): SchedulingRosterWorker[] {
  if (!hasV2MembershipModel()) {
    const memberIds = listRestaurantMemberUserIds(restaurantId, { roles });
    if (memberIds.length === 0) return [];
    const params = [...memberIds];
    const maxWeeklyHoursExpression = columnExists("users", "admin_ot_override")
      ? "COALESCE(admin_ot_override, max_weekly_hours)"
      : columnExists("users", "max_weekly_hours")
        ? "max_weekly_hours"
        : "NULL";
    const rows = rawDb.query(`
      SELECT
        id,
        name,
        role,
        priority,
        sub_roles AS subRoles,
        contract_hours AS contractHours,
        ${maxWeeklyHoursExpression} AS maxWeeklyHours,
        phone,
        active,
        restaurant_id AS restaurantId
      FROM users
      WHERE id IN (${memberIds.map(() => "?").join(", ")})
        AND active = 1
        AND role != 'admin'
      ORDER BY priority ASC, name COLLATE NOCASE ASC, id ASC
    `).all(...params) as Array<{
      id: string;
      name: string;
      role: string;
      priority: number;
      subRoles: string;
      contractHours: number | null;
      maxWeeklyHours: number | null;
      phone: string | null;
      active: number | boolean;
      restaurantId: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: normalizeRestaurantRole(row.role),
      priority: row.priority,
      subRoles: row.subRoles,
      contractHours: row.contractHours,
      maxWeeklyHours: row.maxWeeklyHours,
      phone: row.phone,
      active: row.active === true || row.active === 1,
      restaurantId: row.restaurantId,
    }));
  }

  const params: string[] = [restaurantId];
  const roleFilter = roles.length ? `AND rm.role IN (${roles.map(() => "?").join(", ")})` : "";
  if (roles.length) params.push(...roles);
  const localRestaurantNameExpression = columnExists("restaurants", "name") ? "r.name" : "NULL";
  const localKitchenColorExpression = columnExists("restaurants", "kitchen_color") ? "r.kitchen_color" : "NULL";
  const localFloorColorExpression = columnExists("restaurants", "floor_color") ? "r.floor_color" : "NULL";
  const localMaxWeeklyHoursExpression = columnExists("users", "admin_ot_override")
    ? "COALESCE(u.admin_ot_override, u.max_weekly_hours)"
    : columnExists("users", "max_weekly_hours")
      ? "u.max_weekly_hours"
      : "NULL";
  const localRows = rawDb.query(`
    SELECT
      u.id,
      u.name,
      rm.role,
      u.priority,
      u.sub_roles AS subRoles,
      u.contract_hours AS contractHours,
      ${localMaxWeeklyHoursExpression} AS maxWeeklyHours,
      u.phone,
      u.active,
      rm.restaurant_id AS restaurantId,
      rm.restaurant_id AS primaryRestaurantId,
      ${localRestaurantNameExpression} AS primaryRestaurantName,
      ${localKitchenColorExpression} AS primaryKitchenColor,
      ${localFloorColorExpression} AS primaryFloorColor
    FROM restaurant_memberships rm
    INNER JOIN users u ON u.id = rm.user_id
    INNER JOIN restaurants r ON r.id = rm.restaurant_id
    WHERE rm.restaurant_id = ?
      AND rm.active = 1
      AND u.active = 1
      AND rm.role != 'admin'
      ${roleFilter}
    ORDER BY u.priority ASC, u.name COLLATE NOCASE ASC, u.id ASC
  `).all(...params) as Array<{
    id: string;
    name: string;
    role: string;
    priority: number;
    subRoles: string;
    contractHours: number | null;
    maxWeeklyHours: number | null;
    phone: string | null;
    active: number | boolean;
    restaurantId: string;
    primaryRestaurantId: string | null;
    primaryRestaurantName: string | null;
    primaryKitchenColor: string | null;
    primaryFloorColor: string | null;
  }>;

  const local = localRows.map((row) => ({
    id: row.id,
    name: row.name,
    role: normalizeRestaurantRole(row.role),
    priority: row.priority,
    subRoles: row.subRoles,
    contractHours: row.contractHours,
    maxWeeklyHours: row.maxWeeklyHours,
    phone: row.phone,
    active: row.active === true || row.active === 1,
    restaurantId: row.restaurantId,
    primaryRestaurantId: row.primaryRestaurantId,
    primaryRestaurantName: row.primaryRestaurantName,
    primaryKitchenColor: row.primaryKitchenColor,
    primaryFloorColor: row.primaryFloorColor,
  }));
  const shared = listAcceptedSharedSchedulingWorkers(
    restaurantId,
    roles.filter((role) => role === "kitchen" || role === "floor"),
  );
  return [...local, ...shared].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
  });
}

export function listRestaurantMemberUserIds(
  restaurantId: string,
  options: {
    roles?: RestaurantRole[];
    includeInactiveUsers?: boolean;
  } = {},
): string[] {
  const roles = options.roles ?? [];
  const roleFilter = roles.length ? `AND ${hasV2MembershipModel() ? "rm.role" : "role"} IN (${roles.map(() => "?").join(", ")})` : "";

  if (hasV2MembershipModel()) {
    const params: string[] = [restaurantId];
    if (roles.length) params.push(...roles);
    const activeUserFilter = options.includeInactiveUsers ? "" : "AND u.active = 1";
    const rows = rawDb.query(`
      SELECT rm.user_id AS userId
      FROM restaurant_memberships rm
      INNER JOIN users u ON u.id = rm.user_id
      WHERE rm.restaurant_id = ?
        AND rm.active = 1
        ${activeUserFilter}
        ${roleFilter}
      ORDER BY u.name COLLATE NOCASE ASC, u.id ASC
    `).all(...params) as Array<{ userId: string }>;
    return rows.map((row) => row.userId);
  }

  const params: string[] = [restaurantId];
  if (roles.length) params.push(...roles);
  const activeUserFilter = options.includeInactiveUsers ? "" : "AND active = 1";
  const rows = rawDb.query(`
    SELECT id AS userId
    FROM users
    WHERE restaurant_id = ?
      ${activeUserFilter}
      ${roleFilter}
    ORDER BY name COLLATE NOCASE ASC, id ASC
  `).all(...params) as Array<{ userId: string }>;
  return rows.map((row) => row.userId);
}

export function sessionActiveRestaurantId(sessionId: string): string | null {
  if (!columnExists("sessions", "active_restaurant_id")) return null;

  const row = rawDb.query("SELECT active_restaurant_id AS activeRestaurantId FROM sessions WHERE id = ?")
    .get(sessionId) as { activeRestaurantId: string | null } | null;
  return row?.activeRestaurantId ?? null;
}

export function setSessionActiveRestaurant(sessionId: string, restaurantId: string): void {
  if (!columnExists("sessions", "active_restaurant_id")) {
    throw new Error("sessions.active_restaurant_id is not available");
  }

  rawDb.prepare("UPDATE sessions SET active_restaurant_id = ? WHERE id = ?").run(restaurantId, sessionId);
}

export function resolveSessionRestaurantContext(userId: string, fallbackRestaurantId: string, sessionId: string): RestaurantContext | null {
  return resolveRestaurantContext(userId, sessionActiveRestaurantId(sessionId))
    ?? resolveRestaurantContext(userId, fallbackRestaurantId)
    ?? resolveRestaurantContext(userId);
}
