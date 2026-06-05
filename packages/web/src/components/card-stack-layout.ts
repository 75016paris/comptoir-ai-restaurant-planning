import type { ServiceRow } from "@/lib/api";

// ── Animation constants ──
export const CARD_H = 42;
export const PEEK_Y = 5; // default/reference peek
export const GAP_EXPANDED = 6;
export const ROLE_GAP = 5; // gap-[var(--space-sm)] between role stacks
export const ZONE_PAD = 12; // p-[var(--space-xs)] top + bottom
export const GHOST_H = CARD_H; // ghost card height — same as real cards for visual consistency

/** Compute the stacks content height for a zone on a given day (using default PEEK_Y).
 * Caller passes already-filtered services for the zone.
 * Always accounts for 2 role stacks (cuisine + salle) even if one is empty.
 * Optional targets: if provided, ghost cards for missing staff are included in height. */
export function computeZoneStacksH(zoneServices: ServiceRow[], hasSelection?: boolean, kitchenTarget?: number, salleTarget?: number): number {
 const nk = zoneServices.filter(s => (s.workerRole || s.role) === "kitchen").length;
 const ns = zoneServices.filter(s => (s.workerRole || s.role) === "floor").length;
 const gk = kitchenTarget !== undefined ? Math.max(0, kitchenTarget - nk) : 0;
 const gs = salleTarget !== undefined ? Math.max(0, salleTarget - ns) : 0;
 if (hasSelection) {
 const kH = nk > 0 ? CARD_H + (nk - 1) * PEEK_Y + gk * PEEK_Y : CARD_H + gk * PEEK_Y;
 const sH = ns > 0 ? CARD_H + (ns - 1) * PEEK_Y + gs * PEEK_Y : CARD_H + gs * PEEK_Y;
 return kH + sH + ROLE_GAP;
 }
 // With labels: CARD_H + n*PEEK_Y each (label takes front spot)
 return 2 * CARD_H + (nk + ns + gk + gs) * PEEK_Y + ROLE_GAP;
}

/** Compute zone height for missing-only view: ghost cards only, force-expanded, no label cards. */
export function computeMissingZoneH(zoneServices: ServiceRow[], kitchenTarget?: number, salleTarget?: number): number {
	const nk = zoneServices.filter(s => (s.workerRole || s.role) === "kitchen").length;
	const ns = zoneServices.filter(s => (s.workerRole || s.role) === "floor").length;
	const gk = kitchenTarget !== undefined ? Math.max(0, kitchenTarget - nk) : 0;
	const gs = salleTarget !== undefined ? Math.max(0, salleTarget - ns) : 0;
	const kH = gk > 0 ? gk * (GHOST_H + GAP_EXPANDED) : 0;
	const sH = gs > 0 ? gs * (GHOST_H + GAP_EXPANDED) : 0;
	if (kH === 0 && sH === 0) return CARD_H + ZONE_PAD;
	return kH + (kH > 0 && sH > 0 ? ROLE_GAP : 0) + sH + ZONE_PAD;
}

/** Compute the expanded (unstacked) height for a zone. */
export function computeZoneExpandedH(zoneServices: ServiceRow[], hasSelection?: boolean, kitchenTarget?: number, salleTarget?: number): number {
	const nk = zoneServices.filter(s => (s.workerRole || s.role) === "kitchen").length;
	const ns = zoneServices.filter(s => (s.workerRole || s.role) === "floor").length;
	const gk = kitchenTarget !== undefined ? Math.max(0, kitchenTarget - nk) : 0;
	const gs = salleTarget !== undefined ? Math.max(0, salleTarget - ns) : 0;
	const labelH = Math.round(CARD_H / 2.5);
	if (hasSelection) {
		const kH = nk > 0 ? nk * CARD_H + (nk - 1) * GAP_EXPANDED : 0;
		const sH = ns > 0 ? ns * CARD_H + (ns - 1) * GAP_EXPANDED : 0;
		const total = kH + sH + (kH > 0 && sH > 0 ? ROLE_GAP : 0) + GAP_EXPANDED;
		return Math.max(CARD_H, total);
	}
	const kH = nk > 0 ? labelH + nk * CARD_H + nk * GAP_EXPANDED + gk * (GHOST_H + GAP_EXPANDED) : (gk > 0 ? CARD_H + gk * (GHOST_H + GAP_EXPANDED) : 0);
	const sH = ns > 0 ? labelH + ns * CARD_H + ns * GAP_EXPANDED + gs * (GHOST_H + GAP_EXPANDED) : (gs > 0 ? CARD_H + gs * (GHOST_H + GAP_EXPANDED) : 0);
	const total = kH + sH + (kH > 0 && sH > 0 ? ROLE_GAP : 0);
	return Math.max(CARD_H, total);
}
