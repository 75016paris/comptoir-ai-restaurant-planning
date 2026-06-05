// Objective weights for the staffing solver (both HiGHS ILP and CP-SAT).
// Exposed as a single config so calibration sweeps can grid-search them.
// Defaults match the v1 calibrated values (2026-04-17 sweep winner).

export interface WeightConfig {
  // Primary fill incentive — must dominate so fill rate stays high.
  fill: number;

  // Per-hour piecewise hour preference:
  //   b0: under-contract fill (positive — we WANT to fill unused contract hours)
  //   b1: slight OT 100-115% (positive but smaller)
  //   b2: moderate OT 115-130% (penalty)
  //   b3: heavy OT >130% (stronger penalty)
  bucket0Value: number;
  bucket1Value: number;
  bucket2Penalty: number;
  bucket3Penalty: number;

  // How much the OT-willing multiplier offsets the b2/b3 penalties (0..1).
  // Effective penalty = base * (1 - otMult * offset). Higher offset = willing workers feel less penalty.
  bucket2OtOffset: number;
  bucket3OtOffset: number;

  // Soft preference weights, per-assignment.
  consistency: number;     // bonus per repeat-(dow, role, slot) count
  preference: number;      // bonus when assignment hits worker's matin/midi/soir preference
  priority: number;        // base priority tier bonus (×3 under otDistribution="by-priority")
  flexibility: number;     // favor workers with flexibility < 20 (versatile-worker tiebreak)

  // Per-assignment bonus when the slot's dow is in the worker's dow template —
  // a fixed Set<dow> derived from recent history (DB plumbing pending; caller-
  // supplied for measurement). Consistency rewards repeated (dow, role, slot)
  // observations; templateMatch rewards the canonical dow pattern itself.
  // From the CP-SAT reference-pattern analysis. CP-SAT only (ILP skips per
  // audit restructure step C). 0 = off.
  templateMatch: number;

  // Penalties.
  subroleMismatch: number; // assigning a worker whose sub-roles don't match slot.roleBreakdown
  rolePenalty: number;     // per-unit slack for soft C10/C11 role/chef constraints

  // Cost minimization — scales linearly with the assigned worker's hourly rate.
  // Effective only when the workers have hourly_rate or hcr_level populated.
  // 0 = ignore cost (current behavior); higher = strongly prefer cheaper workers.
  costAwareness: number;

  // Conservation of leave balance — penalize assigning workers whose CP balance
  // is urgent. Off by default: the holiday advice page handles leave planning,
  // the solver schedules normally. Admins opt in via the semantic slider.
  // 0 = ignore (default); higher = stronger nudge toward other workers.
  leaveConservation: number;

  // Redundancy / backup preservation — penalize using workers who are eligible
  // for MANY slots on a given day. Formally: per-(worker w, date d) penalty is
  // weight × N(w,d) × y_{w,d}, where N(w,d) is the number of slots on date d for
  // which w is eligible. Effect: versatile workers are held in reserve, role
  // specialists fill slots first, so if someone calls out there's a backup pool.
  // 0 = ignore (current default); typical active range 15–150.
  redundancy: number;

  // Contract-completion bonus — per (worker, slot) assignment, add a coefficient
  // proportional to the worker's pre-assignment deficit (contract - already-
  // assigned hours). Effect: workers far below their contract become more
  // attractive than workers near or above contract, biasing the solver toward
  // filling contracts before paying overtime. Complements bucket0Value (which
  // is hour-bucket-bounded) by being a per-assignment, deficit-aware bonus.
  // 0 = ignore (default — bucket0Value alone handles the basic case);
  //   typical active range 10–60 to dominate priority bonuses.
  contractCompletion: number;

  // Titulaire bonus — per-assignment bonus when the worker is in the active
  // staffing profile's preferredWorkerIds ("titulaires"). Designed as a manual
  // seed for the équipe-stable preset on new restaurants where the consistency
  // map has no historical data to draw from. Drift is allowed: any term
  // (mismatch penalty, OT cost, hard constraints) can override the bonus.
  // 0 = ignore (default for all presets except équipe-stable);
  //   typical active range 40–150 — pick a magnitude similar to consistency×2
  //   so a configured titulaire is at least as attractive as a worker who has
  //   done the slot in 2 of the last 4 weeks.
  titulaireBonus: number;
}

// ── v1 weights (the "equilibre" preset) ──
// Picked 2026-04-21 after v2 two-stage recalibration sprint on Scaleway Mac M2 Pro
// (6,450-job coarse sweep on 43 configs + 27,000-job fine sweep on 180 perturbations).
// The v2 sweep covered the new redundancy dimension and preset-taxonomy-v2 landscape.
// Outcome: v1 per-bucket / consistency / priority values hold up — all top fine
// configs stayed within ±20% of v1 on those axes. The one meaningful update is
// redundancy lifting from 0 to 15 (semantic level 1): the winner cluster had
// redundancy ≈ 14-17 and +4-7% worst-case composite vs. redundancy=0 baseline.
// Full calibration analysis lives in the internal decision notes.
export const DEFAULT_WEIGHTS: WeightConfig = {
  fill: 1000,
  bucket0Value: 300,        // v1: contract-first (vs. legacy 80)
  bucket1Value: 5,          // v1: slight-OT reward reduced vs. legacy 20
  bucket2Penalty: 150,      // v1: moderate OT 3.75× legacy
  bucket3Penalty: 500,      // v1: heavy OT 5× legacy
  bucket2OtOffset: 0.7,
  bucket3OtOffset: 0.5,
  consistency: 5,
  preference: 3,
  priority: 2,
  flexibility: 1,
  subroleMismatch: 800,
  rolePenalty: 500,
  costAwareness: 0,      // off by default — only kicks in when admin opts into cost-aware scheduling
  leaveConservation: 0,  // off by default — holiday advice page handles leave planning, solver schedules normally
  redundancy: 15,        // v2: mild baseline backup-preservation (semantic level 1). The resilience preset pushes this higher.
  templateMatch: 0,      // off by default — équipe-stable preset opts in, others stay 0
  contractCompletion: 0, // off by default — bucket0Value already handles fill-before-OT; this is the explicit dial admins can crank when priorities/sub-roles overpower contract gaps
  titulaireBonus: 0,     // off by default — équipe-stable preset opts in, others stay 0
};

// ── Named presets ──
// Five management-philosophy styles, all derived from the 2026-04-17 sweep.
// Admins pick one via /preferences → Auto-Staffing → "Style d'optimisation".
// New presets should be added here and only here — no other file hardcodes them.

export type PresetName =
  | "equilibre"       // v1 / coarse_33 — contract-first, OT-expensive (default)
  | "equipe-stable"   // coarse_H — high consistency + preference (week-over-week stability)
  | "flexibilite"     // coarse_23 — subroleMismatch ÷10 (accept cross-role assignments)
  | "economique"      // cost-first — minimize €/week labor while filling slots
  | "resilience";     // spread hours + favor versatiles + keep spare capacity for last-minute replacements

export const PRESETS: Record<PresetName, WeightConfig> = {
  "equilibre": DEFAULT_WEIGHTS,
  "equipe-stable": {
    ...DEFAULT_WEIGHTS,
    consistency: 40,
    preference: 15,
    // Recommended magnitude from the Step 2 équipe-stable measurement:
    // w=120 lifted dowPatternStability +0.035 paired at n=40 with no
    // restriction-surge regression. Gated behind TEMPLATE_MATCH_ENABLED
    // — default off keeps the term a no-op until ops flips the flag.
    templateMatch: 120,
    // Manual roster seed for new restaurants (no history => consistency map empty).
    // Magnitude ~consistency×2 so a configured titulaire matches a worker who has
    // done the slot in 2 of the last 4 weeks. Inert when preferredWorkerIds is empty.
    titulaireBonus: 80,
  },
  "flexibilite": {
    ...DEFAULT_WEIGHTS,
    subroleMismatch: 100,  // v2: ÷8 vs. default 800 (semantic level 1) — accept cross-subrole
    rolePenalty: 50,       // v2: ÷10 vs. default 500 — allow cuisine↔salle crossover too
    redundancy: 0,         // off — flexibilité is the opposite of reserving versatile workers
  },
  "economique": {
    ...DEFAULT_WEIGHTS,
    // costAwareness uses absolute-euros: per-assignment coeff = −CA × hours × €/hour.
    // Unified across ILP and CP-SAT (see utils/solver-cost.ts). Previous wage-band
    // normalization (CP-SAT only, CA=100) was rescaled ~25× down to stay in the
    // same per-assignment magnitude band (€12/h × CA=4 ≈ 0.5 × CA=100).
    costAwareness: 4,
    contractCompletion: 150,
    bucket0Value: 700,
    bucket1Value: 0,    // no slight-OT reward — OT costs money, avoid it
    bucket2Penalty: 300,
    bucket3Penalty: 1000,
  },
  "resilience": {
    // Goal: flat workload distribution — personne n'est surchargé, tout le monde peut
    // absorber un imprévu. When hours are spread evenly, any single cancelation is a small
    // fraction of the team's remaining capacity. Previous "versatile-reserves" formulation
    // (lex two-pass on redundancy) couldn't move the needle: the fill-to-contract
    // objective filled everyone, leaving nothing in reserve. This redefinition targets
    // what the solver CAN actually influence: the shape of the hours distribution.
    // See the internal resilience redefinition note.
    ...DEFAULT_WEIGHTS,
    priority: 0,           // no senior-first — equal rotation across all workers
    consistency: 2,        // low — don't lock workers into the same schedule every week
    redundancy: 50,        // modest — versatile workers naturally absorb overflow without being pinned
  },
};

// UI metadata for each preset — kept alongside the weights so the
// web package can render the selector without duplicating strings.
export type PresetMeta = {
  name: PresetName;
  label: string;        // short label (button caption)
  description: string;  // one-sentence explanation of the trade-off
};

export const PRESET_META: readonly PresetMeta[] = [
  {
    name: "equilibre",
    label: "Équilibré",
    description: "Répartit l'effort équitablement. Remplit les heures contractuelles avant d'ouvrir des HS.",
  },
  {
    name: "equipe-stable",
    label: "Équipe stable",
    description: "Favorise les mêmes employés sur les mêmes services d'une semaine à l'autre.",
  },
  {
    name: "flexibilite",
    label: "Flexibilité d'équipe",
    description: "Accepte les assignations hors sous-rôle quand c'est nécessaire.",
  },
  {
    name: "economique",
    label: "Économique",
    description: "Complète les heures contractuelles avant d'ajouter des extras ou des HS — le levier le plus direct sur la masse salariale.",
  },
  {
    name: "resilience",
    label: "Résilience",
    description: "Répartit les heures équitablement — personne n'est surchargé et tout le monde peut absorber un imprévu.",
  },
] as const;

const PRESET_NAMES = new Set<string>(Object.keys(PRESETS));

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === "string" && PRESET_NAMES.has(value);
}

// Resolve a preset name (possibly unknown / null / undefined) to a WeightConfig.
// Unknown values fall back to the default "equilibre" preset so stored data
// that predates a removed preset still solves cleanly.
export function resolvePreset(name: string | null | undefined): WeightConfig {
  if (isPresetName(name)) return PRESETS[name];
  return DEFAULT_WEIGHTS;
}

// ── Semantic scale for per-dimension custom overrides ──
// Admins never see raw numeric weights. Each dimension maps to a 5-step ordinal
// scale with pre-picked values kept inside the calibrated range.
// Values chosen so neighboring levels are meaningfully distinct (2-4× apart)
// without going outside bounds the benchmark sweeps validated.
export type SemanticLevel = 0 | 1 | 2 | 3 | 4;

// Which dimensions the admin can tune. Raw `fill` is intentionally omitted
// (it's the global magnitude — tuning it rescales everything else).
export type TunableDimension =
  | "bucket0Value"      // reward for filling under-contract hours
  | "bucket1Value"      // reward for slight OT (100-115%)
  | "bucket2Penalty"    // penalty for moderate OT (115-130%)
  | "bucket3Penalty"    // penalty for heavy OT (>130%)
  | "otOffset"          // composite: how much OT-willing workers soak the penalty
  | "consistency"       // same employees week-over-week
  | "preference"        // respect worker preferred-schedule
  | "priority"          // respect P1/P2/P3 tiers
  | "flexibility"       // favor versatile workers
  | "subroleMismatch"   // respect sub-roles (Chef/Cuisinier/...)
  | "rolePenalty"       // respect cuisine/salle separation
  | "costAwareness"     // prefer cheaper workers (requires hourly_rate)
  | "leaveConservation" // spare workers whose CP balance expires soon
  | "redundancy"        // hold versatile workers in reserve as backups
  | "templateMatch"     // reward matching a worker's canonical dow template
  | "contractCompletion" // bias solver toward filling under-contract workers before OT
  | "titulaireBonus";   // reward picking workers from the profile's titulaire roster

// Per-dimension ordinal → numeric mapping. Level 2 is the "equilibre" default.
// Level 4 is "IMPÉRATIF" — very high but still soft so the model never goes infeasible.
export const SEMANTIC_SCALE: Record<TunableDimension, readonly [number, number, number, number, number]> = {
  bucket0Value:     [0,    80,   300,  700,  1500],
  bucket1Value:     [0,    5,    20,   60,   200],
  bucket2Penalty:   [0,    40,   150,  400,  1000],
  bucket3Penalty:   [0,    100,  500,  1000, 2500],
  otOffset:         [0,    0.3,  0.6,  0.85, 1.0],   // applied to both b2 and b3 offsets
  consistency:      [0,    5,    20,   40,   100],
  preference:       [0,    3,    10,   30,   100],
  priority:         [0,    0.5,  2,    5,    20],
  flexibility:      [0,    1,    5,    15,   50],
  subroleMismatch:  [0,    100,  400,  800,  3000],
  rolePenalty:      [0,    100,  500,  1500, 5000],
  costAwareness:    [0,    0.5,  2,    4,    12],
  leaveConservation:[0,    10,   20,   60,   150],
  redundancy:       [0,    15,   50,   150,  400],
  templateMatch:    [0,    15,   60,   120,  300],  // mirrors consistency's shape; équipe-stable preset sits at level 3 (Step 2 sweep ship magnitude)
  contractCompletion:[0,   10,   30,   60,   150],  // L1 mild (priority-tier nudge); L2 dominates priority for visibly under-contracted workers; L3+ overrides priority entirely
  titulaireBonus:   [0,    20,   50,   80,   200],  // L3 = équipe-stable default (~consistency×2); L4 makes titulaires near-mandatory absent infeasibility
} as const;

export type CustomWeights = Partial<Record<TunableDimension, SemanticLevel>>;

// UI-facing metadata per dimension.
export type DimensionMeta = {
  key: TunableDimension;
  label: string;
  description: string;
  direction: "positive" | "negative";  // positive = "favor more", negative = "avoid more"
  group: "hours" | "stability" | "fairness" | "roles" | "cost" | "leave" | "resilience";
};

// Level labels differ by direction. For a positive dimension, level 0 = "ignorer"
// (don't reward), level 4 = "IMPÉRATIF" (strongly reward). For a negative
// dimension, level 0 = "accepter" (no penalty), level 4 = "interdire" (huge penalty).
export const POSITIVE_LEVEL_LABELS: readonly [string, string, string, string, string] = [
  "Ignorer", "Léger", "Modéré", "Fort", "IMPÉRATIF",
] as const;
export const NEGATIVE_LEVEL_LABELS: readonly [string, string, string, string, string] = [
  "Accepter", "Léger", "Modéré", "Fort", "INTERDIRE",
] as const;

export const DIMENSION_META: readonly DimensionMeta[] = [
  { key: "bucket0Value",    label: "Remplir les heures contractuelles", description: "Récompense pour atteindre les heures prévues au contrat.",                direction: "positive", group: "hours" },
  { key: "bucket1Value",    label: "Accepter un peu d'HS (100-115%)",   description: "Récompense légère pour des heures sup limitées.",                         direction: "positive", group: "hours" },
  { key: "bucket2Penalty",  label: "Éviter les HS modérées (115-130%)", description: "Pénalise les heures sup au-delà d'une marge raisonnable.",                direction: "negative", group: "hours" },
  { key: "bucket3Penalty",  label: "Éviter les HS lourdes (>130%)",     description: "Pénalise fortement les dépassements importants.",                         direction: "negative", group: "hours" },
  { key: "otOffset",        label: "HS concentrées sur volontaires",    description: "Plus le niveau est haut, plus les HS visent d'abord les employés volontaires.", direction: "positive", group: "hours" },
  { key: "consistency",     label: "Mêmes employés chaque semaine",      description: "Stabilise les services d'une semaine à l'autre.",                         direction: "positive", group: "stability" },
  { key: "preference",      label: "Respecter les préférences",          description: "Tient compte du planning préféré des employés.",                          direction: "positive", group: "stability" },
  { key: "priority",        label: "Respecter les priorités (P1/P2/P3)", description: "Donne plus de services aux employés à priorité élevée.",                   direction: "positive", group: "fairness" },
  { key: "flexibility",     label: "Favoriser les employés versatiles", description: "Répartit vers ceux qui peuvent couvrir plusieurs zones.",                 direction: "positive", group: "fairness" },
  { key: "subroleMismatch", label: "Respecter les sous-rôles",           description: "Chef, Cuisinier, Plongeur, Barman… affectation stricte par sous-rôle.",  direction: "negative", group: "roles" },
  { key: "rolePenalty",     label: "Respecter la cuisine vs la salle",   description: "Évite les assignations croisées entre cuisine et salle.",                direction: "negative", group: "roles" },
  { key: "costAwareness",   label: "Minimiser le coût",                  description: "À compétence égale, préfère les employés avec le taux horaire le plus bas. Inactif tant que les taux ne sont pas renseignés.", direction: "positive", group: "cost" },
  { key: "leaveConservation", label: "Préserver les soldes de CP",       description: "Évite d'assigner les employés dont les 5 semaines de congés payés expirent sous peu, pour leur laisser la place de poser.", direction: "positive", group: "leave" },
  { key: "redundancy",      label: "Garder des remplaçants disponibles", description: "Réserve les employés polyvalents comme renforts : si quelqu'un se désiste, d'autres restent libres pour prendre le shift.", direction: "positive", group: "resilience" },
  { key: "templateMatch",   label: "Respecter les jours habituels",      description: "Favorise les jours de la semaine que chaque employé travaille habituellement (ex. Maria toujours mardi/jeudi).", direction: "positive", group: "stability" },
  { key: "contractCompletion", label: "Compléter les contrats avant les HS", description: "Pousse le solveur à atteindre les heures contractuelles des employés sous-utilisés avant de placer d'autres en heures supp.", direction: "positive", group: "hours" },
  { key: "titulaireBonus",  label: "Favoriser les titulaires",            description: "Bonus pour les employés désignés titulaires de cet objectif. Sert d'amorce à « Équipe stable » sur les restaurants sans historique.", direction: "positive", group: "stability" },
] as const;

export const GROUP_LABELS: Record<DimensionMeta["group"], string> = {
  hours:      "Heures & HS",
  stability:  "Stabilité d'équipe",
  fairness:   "Équité",
  roles:      "Rôles & sous-rôles",
  cost:       "Coût",
  leave:      "Congés",
  resilience: "Résilience",
};

function nearestLevel(value: number, scale: readonly [number, number, number, number, number]): SemanticLevel {
  let best: SemanticLevel = 0;
  let bestDist = Math.abs(value - scale[0]);
  for (let i = 1 as SemanticLevel; i <= 4; i = (i + 1) as SemanticLevel) {
    const d = Math.abs(value - scale[i]);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** Given a preset-resolved WeightConfig, derive the ordinal level each dimension sits at. */
export function inferLevels(base: WeightConfig): Record<TunableDimension, SemanticLevel> {
  // Average the two bucket offsets for the otOffset meta-dimension.
  const avgOffset = (base.bucket2OtOffset + base.bucket3OtOffset) / 2;
  return {
    bucket0Value:    nearestLevel(base.bucket0Value, SEMANTIC_SCALE.bucket0Value),
    bucket1Value:    nearestLevel(base.bucket1Value, SEMANTIC_SCALE.bucket1Value),
    bucket2Penalty:  nearestLevel(base.bucket2Penalty, SEMANTIC_SCALE.bucket2Penalty),
    bucket3Penalty:  nearestLevel(base.bucket3Penalty, SEMANTIC_SCALE.bucket3Penalty),
    otOffset:        nearestLevel(avgOffset, SEMANTIC_SCALE.otOffset),
    consistency:     nearestLevel(base.consistency, SEMANTIC_SCALE.consistency),
    preference:      nearestLevel(base.preference, SEMANTIC_SCALE.preference),
    priority:        nearestLevel(base.priority, SEMANTIC_SCALE.priority),
    flexibility:     nearestLevel(base.flexibility, SEMANTIC_SCALE.flexibility),
    subroleMismatch: nearestLevel(base.subroleMismatch, SEMANTIC_SCALE.subroleMismatch),
    rolePenalty:     nearestLevel(base.rolePenalty, SEMANTIC_SCALE.rolePenalty),
    costAwareness:   nearestLevel(base.costAwareness, SEMANTIC_SCALE.costAwareness),
    leaveConservation: nearestLevel(base.leaveConservation, SEMANTIC_SCALE.leaveConservation),
    redundancy:      nearestLevel(base.redundancy, SEMANTIC_SCALE.redundancy),
    templateMatch:   nearestLevel(base.templateMatch, SEMANTIC_SCALE.templateMatch),
    contractCompletion: nearestLevel(base.contractCompletion, SEMANTIC_SCALE.contractCompletion),
    titulaireBonus:  nearestLevel(base.titulaireBonus, SEMANTIC_SCALE.titulaireBonus),
  };
}

/** Resolve preset + optional per-dimension custom overrides into a final WeightConfig. */
export function resolveWeights(
  presetName: string | null | undefined,
  custom: CustomWeights | null | undefined,
): WeightConfig {
  const base = resolvePreset(presetName);
  if (!custom || Object.keys(custom).length === 0) return base;
  const out: WeightConfig = { ...base };
  for (const [rawKey, level] of Object.entries(custom)) {
    if (level == null || level < 0 || level > 4) continue;
    const key = rawKey as TunableDimension;
    const lvl = level as SemanticLevel;
    const scale = SEMANTIC_SCALE[key];
    if (!scale) continue;
    const value = scale[lvl];
    if (key === "otOffset") {
      out.bucket2OtOffset = value;
      out.bucket3OtOffset = value;
    } else {
      (out as any)[key] = value;
    }
  }
  return out;
}

/** Parse a customWeights JSON blob from DB, filtering out unknown keys and out-of-range levels. */
export function parseCustomWeights(raw: string | null | undefined): CustomWeights {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: CustomWeights = {};
    for (const meta of DIMENSION_META) {
      const v = obj[meta.key];
      if (typeof v === "number" && v >= 0 && v <= 4 && Number.isInteger(v)) {
        out[meta.key] = v as SemanticLevel;
      }
    }
    return out;
  } catch {
    return {};
  }
}
