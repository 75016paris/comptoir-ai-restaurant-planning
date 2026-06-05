// Report active employee count to Stripe metered billing
// "Active" = employee who had ≥1 service in the billing month
// Admin is never counted

import Stripe from "stripe";
import { db } from "../db/connection.js";
import { owners, restaurants, users, services } from "../db/schema.js";
import { eq, and, gte, lte, ne, sql } from "drizzle-orm";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const METER_EVENT_NAME = "active_employees";

export class InvalidBillingMonthError extends Error {
  constructor(month: string) {
    super(`Invalid billing month: ${month}`);
  }
}

export function isBillingMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export function resolveBillingMonth(month?: string | null): string {
  if (!month) return getCurrentMonth();
  if (!isBillingMonth(month)) throw new InvalidBillingMonthError(month);
  return month;
}

/**
 * Build Stripe metadata for restaurant-level SIRET. Once one Stripe customer
 * covers several restaurants, there is no single canonical SIRET to expose.
 */
export function stripeSiretMetadataForOwnerScope(activeRestaurantCount: number, siret: string | null): Record<string, string> {
  if (activeRestaurantCount <= 1) {
    return { siret: siret ?? "", siret_scope: "single_restaurant" };
  }
  return { siret: "", siret_scope: "multi_restaurant" };
}

/**
 * Push the restaurant's SIRET to Stripe customer metadata when unambiguous.
 * Fire-and-forget — failures log but don't propagate, since the SIRET is already
 * persisted on our side and the URSSAF DPAE flow doesn't depend on Stripe.
 */
export function syncSiretToStripe(restaurantId: string, siret: string | null): void {
  if (!stripe) return;
  const [r] = db.select({
    ownerId: restaurants.ownerId,
    restaurantStripeCustomerId: restaurants.stripeCustomerId,
    ownerStripeCustomerId: owners.stripeCustomerId,
  })
    .from(restaurants)
    .leftJoin(owners, eq(restaurants.ownerId, owners.id))
    .where(eq(restaurants.id, restaurantId))
    .limit(1).all();
  const stripeCustomerId = r?.ownerStripeCustomerId ?? r?.restaurantStripeCustomerId;
  if (!stripeCustomerId) return;

  const activeRestaurantCount = r.ownerId
    ? db.select({ id: restaurants.id })
      .from(restaurants)
      .where(and(eq(restaurants.ownerId, r.ownerId), eq(restaurants.status, "active")))
      .all().length
    : 1;

  stripe.customers.update(stripeCustomerId, {
    metadata: stripeSiretMetadataForOwnerScope(activeRestaurantCount, siret),
  }).catch(err => console.error("[stripe] siret metadata sync failed:", err.message));
}

type ActiveReport = {
  ownerId: string;
  ownerName: string;
  stripeCustomerId: string;
  activeCount: number;
  workers: string[];
  restaurants: ActiveRestaurantBreakdown[];
};

type ActiveRestaurantBreakdown = {
  restaurantId: string;
  restaurantName: string;
  activeCount: number;
  workers: string[];
};

/** Count active employees for a single restaurant */
export function countActiveForRestaurant(
  restaurantId: string,
  month: string
): { activeCount: number; workers: string[] } {
  if (!isBillingMonth(month)) throw new InvalidBillingMonthError(month);
  const startDate = `${month}-01`;
  const endDate = getLastDayOfMonth(month);

  const activeWorkers = db
    .selectDistinct({ workerId: services.workerId, name: users.name })
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(
      and(
        eq(services.restaurantId, restaurantId),
        gte(services.date, startDate),
        lte(services.date, endDate),
        eq(users.active, true),
        ne(users.role, "admin"),
        ne(services.status, "cancelled")
      )
    )
    .all();

  return {
    activeCount: activeWorkers.length,
    workers: activeWorkers.map((w) => w.name),
  };
}

/** Count unique active employees across every restaurant owned by an owner account. */
export function countActiveForOwner(
  ownerId: string,
  month: string
): { activeCount: number; workers: string[]; restaurants: ActiveRestaurantBreakdown[] } {
  if (!isBillingMonth(month)) throw new InvalidBillingMonthError(month);
  const startDate = `${month}-01`;
  const endDate = getLastDayOfMonth(month);

  const activeWorkers = db
    .selectDistinct({
      workerId: services.workerId,
      name: users.name,
    })
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .innerJoin(restaurants, eq(services.restaurantId, restaurants.id))
    .where(
      and(
        eq(restaurants.ownerId, ownerId),
        eq(restaurants.status, "active"),
        gte(services.date, startDate),
        lte(services.date, endDate),
        eq(users.active, true),
        ne(users.role, "admin"),
        ne(services.status, "cancelled")
      )
    )
    .all();

  const restaurantRows = db
    .select({
      id: restaurants.id,
      name: restaurants.name,
    })
    .from(restaurants)
    .where(and(eq(restaurants.ownerId, ownerId), eq(restaurants.status, "active")))
    .all();

  const breakdown = restaurantRows.map((restaurant) => {
    const workers = db
      .selectDistinct({
        workerId: services.workerId,
        name: users.name,
      })
      .from(services)
      .innerJoin(users, eq(services.workerId, users.id))
      .where(
        and(
          eq(services.restaurantId, restaurant.id),
          gte(services.date, startDate),
          lte(services.date, endDate),
          eq(users.active, true),
          ne(users.role, "admin"),
          ne(services.status, "cancelled")
        )
      )
      .all();

    return {
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      activeCount: workers.length,
      workers: workers.map((w) => w.name),
    };
  });

  return {
    activeCount: activeWorkers.length,
    workers: activeWorkers.map((w) => w.name),
    restaurants: breakdown,
  };
}

/** Count active employees per owner for a given month (all Stripe customers) */
export function countActiveEmployees(month: string): ActiveReport[] {
  if (!isBillingMonth(month)) throw new InvalidBillingMonthError(month);
  // Get all owners with Stripe customers. Restaurant Stripe fields remain mirrored during migration.
  const allOwners = db
    .select({
      id: owners.id,
      name: owners.name,
      stripeCustomerId: owners.stripeCustomerId,
      subscriptionStatus: owners.subscriptionStatus,
    })
    .from(owners)
    .where(
      and(
        sql`${owners.stripeCustomerId} IS NOT NULL`,
        sql`${owners.stripeCustomerId} != ''`,
        ne(owners.subscriptionStatus, "cancelled"),
        ne(owners.subscriptionStatus, "unpaid")
      )
    )
    .all();

  const reports: ActiveReport[] = [];

  for (const owner of allOwners) {
    const active = countActiveForOwner(owner.id, month);

    reports.push({
      ownerId: owner.id,
      ownerName: owner.name,
      stripeCustomerId: owner.stripeCustomerId!,
      activeCount: active.activeCount,
      workers: active.workers,
      restaurants: active.restaurants,
    });
  }

  return reports;
}

/** Report active employee counts to Stripe via Billing Meter events */
export async function reportUsageToStripe(month?: string): Promise<{
  reported: number;
  errors: string[];
}> {
  const targetMonth = resolveBillingMonth(month);

  if (!stripe) {
    console.log("⚠ Stripe not configured — skipping usage report");
    return { reported: 0, errors: [] };
  }

  const reports = countActiveEmployees(targetMonth);
  const errors: string[] = [];
  let reported = 0;

  for (const report of reports) {
    if (report.activeCount === 0) continue;

    try {
      await stripe.billing.meterEvents.create({
        event_name: METER_EVENT_NAME,
        payload: {
          stripe_customer_id: report.stripeCustomerId,
          value: String(report.activeCount),
        },
      });

      console.log(
        `✓ Reported ${report.activeCount} active employees for ${report.ownerName} (${targetMonth})`
      );
      reported++;
    } catch (err: any) {
      const msg = `Failed to report for ${report.ownerName}: ${err.message}`;
      console.error(`✗ ${msg}`);
      errors.push(msg);
    }
  }

  return { reported, errors };
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getLastDayOfMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const lastDay = new Date(year, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}
