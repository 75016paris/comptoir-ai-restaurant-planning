// Canonical sub-role labels for the chef / sous-chef promotion semantic.
// Kept in one place so the solver and the UI crown/tier display stay in sync.

export const CHEF_LABELS = ["Chef", "Chef de rang"] as const;
export const SOUS_CHEF_LABELS = ["Sous-chef", "Sous-chef de rang"] as const;

export function hasChefLabel(subRoles: readonly string[] | null | undefined): boolean {
  if (!subRoles) return false;
  return subRoles.some(r => (CHEF_LABELS as readonly string[]).includes(r));
}

export function hasSousChefLabel(subRoles: readonly string[] | null | undefined): boolean {
  if (!subRoles) return false;
  return subRoles.some(r => (SOUS_CHEF_LABELS as readonly string[]).includes(r));
}

// A worker can fill a Chef slot if they ARE a chef, or — as fallback —
// if they're a sous-chef (the French brigade convention: Sous-chef covers Chef).
export function canFillChefSlot(subRoles: readonly string[] | null | undefined): boolean {
  return hasChefLabel(subRoles) || hasSousChefLabel(subRoles);
}

// ── Sub-role substitution ──────────────────────────────────────────────
// When a slot demands a specific sub-role (e.g. Cuisinier) but no exact-match
// worker is available, the solver may substitute. Each substitution carries
// a penalty so the objective only takes it when needed.
//
// Penalty scale:
//   exact: 0  — worker has the demanded sub-role
//   tiny:  5  — lateral within the same hierarchy tier (Serveur↔Barman,
//               Chef de rang↔Sous-chef de rang) — treated as same role
//   small: 15 — one-tier flexibility (Sous-chef fills Cuisinier or Chef slot)
//   heavy: 40 — reverse downgrade (Chef takes Sous-chef slot, Cuisinier takes
//               Plongeur slot) — last resort

export const SUBSTITUTION_PENALTY = {
  exact: 0,
  tiny: 5,
  small: 15,
  heavy: 40,
} as const;

type Penalty = keyof typeof SUBSTITUTION_PENALTY;

const SUBSTITUTION_TABLE: Record<string, Record<string, Penalty>> = {
  // ── Cuisine brigade ──
  "Chef":              { "Chef": "exact", "Sous-chef": "small" },
  "Sous-chef":         { "Sous-chef": "exact", "Chef": "heavy" },
  "Cuisinier":         { "Cuisinier": "exact", "Sous-chef": "small" },
  "Plongeur":          { "Plongeur": "exact", "Cuisinier": "heavy" },

  // ── Salle brigade ──
  "Chef de rang":      { "Chef de rang": "exact", "Sous-chef de rang": "tiny" },
  "Sous-chef de rang": { "Sous-chef de rang": "exact", "Chef de rang": "tiny" },
  "Serveur":           { "Serveur": "exact", "Barman": "tiny" },
  "Barman":            { "Barman": "exact", "Serveur": "tiny" },
};

export type SubRoleMatch = {
  eligible: boolean;
  penalty: number;       // 0 = exact, larger = worse fit
  filledAs: string | null; // the worker's sub-role used to fill the slot, or null if ineligible
  exact: boolean;
};

/**
 * Decide whether a worker can fill a slot demanding `slotSubRole`,
 * given their `workerSubRoles`. Returns the best (lowest-penalty) match.
 *
 * If the worker has no sub-roles at all, they're treated as a generic
 * fit (eligible, exact, no flagged sub-role) — preserves prior behaviour
 * for restaurants that don't use sub-role tagging.
 */
export function subRoleSubstitution(
  slotSubRole: string,
  workerSubRoles: readonly string[] | null | undefined,
): SubRoleMatch {
  if (!workerSubRoles || workerSubRoles.length === 0) {
    return { eligible: true, penalty: 0, filledAs: null, exact: true };
  }

  const allowed = SUBSTITUTION_TABLE[slotSubRole];
  if (!allowed) {
    // Unknown slot sub-role — fall back to exact-match-only
    if (workerSubRoles.includes(slotSubRole)) {
      return { eligible: true, penalty: 0, filledAs: slotSubRole, exact: true };
    }
    return { eligible: false, penalty: Infinity, filledAs: null, exact: false };
  }

  let best: SubRoleMatch = { eligible: false, penalty: Infinity, filledAs: null, exact: false };
  for (const wSr of workerSubRoles) {
    const tier = allowed[wSr];
    if (!tier) continue;
    const pen = SUBSTITUTION_PENALTY[tier];
    if (pen < best.penalty) {
      best = {
        eligible: true,
        penalty: pen,
        filledAs: wSr,
        exact: tier === "exact",
      };
    }
  }
  return best;
}

/**
 * Convenience: is a worker eligible (exact OR fallback) to fill the slot?
 */
export function canFillSubRoleSlot(
  slotSubRole: string,
  workerSubRoles: readonly string[] | null | undefined,
): boolean {
  return subRoleSubstitution(slotSubRole, workerSubRoles).eligible;
}
