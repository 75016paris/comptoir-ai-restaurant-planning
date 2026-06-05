// Convention Collective HCR — Hôtels, Cafés, Restaurants
// Grille des salaires minima bruts — barème indicatif applicable au 1er janvier 2026.
// Ces valeurs sont modifiables par restaurant depuis Préférences → Taux horaires & Contrat.
// À vérifier contre l'avenant en vigueur : https://www.legifrance.gouv.fr (IDCC 1979).

export type HcrLevel =
  | "I-1" | "I-2" | "I-3"
  | "II-1" | "II-2" | "II-3"
  | "III-1" | "III-2" | "III-3"
  | "IV-1" | "IV-2" | "IV-3"
  | "V-1" | "V-2" | "V-3";

export const HCR_LEVELS: HcrLevel[] = [
  "I-1", "I-2", "I-3",
  "II-1", "II-2", "II-3",
  "III-1", "III-2", "III-3",
  "IV-1", "IV-2", "IV-3",
  "V-1", "V-2", "V-3",
];

export const HCR_LEVEL_LABELS: Record<HcrLevel, string> = {
  "I-1": "Niveau I — Échelon 1",
  "I-2": "Niveau I — Échelon 2",
  "I-3": "Niveau I — Échelon 3",
  "II-1": "Niveau II — Échelon 1",
  "II-2": "Niveau II — Échelon 2",
  "II-3": "Niveau II — Échelon 3",
  "III-1": "Niveau III — Échelon 1",
  "III-2": "Niveau III — Échelon 2",
  "III-3": "Niveau III — Échelon 3",
  "IV-1": "Niveau IV — Échelon 1",
  "IV-2": "Niveau IV — Échelon 2",
  "IV-3": "Niveau IV — Échelon 3",
  "V-1": "Niveau V — Échelon 1 (Cadre)",
  "V-2": "Niveau V — Échelon 2 (Cadre)",
  "V-3": "Niveau V — Échelon 3 (Cadre supérieur)",
};

// Taux horaires bruts en cents (entiers). Barème indicatif 2026 — à ajuster selon l'avenant
// en vigueur. Toutes les valeurs monétaires sont stockées et manipulées en cents (intégral),
// seules les surfaces d'affichage (formulaires, DPAE, contrat) divisent par 100.
export const HCR_GRID_2026: Record<HcrLevel, number> = {
  "I-1": 1188,
  "I-2": 1193,
  "I-3": 1198,
  "II-1": 1200,
  "II-2": 1208,
  "II-3": 1221,
  "III-1": 1236,
  "III-2": 1255,
  "III-3": 1277,
  "IV-1": 1337,
  "IV-2": 1410,
  "IV-3": 1494,
  "V-1": 1650,
  "V-2": 1840,
  "V-3": 2100,
};

// Catalogue par défaut, ordonné du plus subalterne au plus senior. Sert
// (a) au mapping par défaut sous-rôle → niveau HCR ci-dessous,
// (b) aux suggestions au moment d'ajouter un sous-rôle au catalogue d'un restaurant.
export const KITCHEN_DEFAULT_SUBROLES = [
  "Plongeur",
  "Commis",
  "Cuisinier",
  "Chef de partie",
  "Sous-chef",
  "Chef",
] as const;

export const FLOOR_DEFAULT_SUBROLES = [
  "Runner",
  "Serveur",
  "Tabac",
  "Barman",
  "Chef de rang",
  "Sous-chef de rang",
] as const;

// Mapping par défaut sous-rôle → niveau HCR. L'admin peut surcharger par employé.
export const DEFAULT_SUBROLE_TO_HCR: Record<string, HcrLevel> = {
  // Cuisine
  "Plongeur": "I-1",
  "Commis": "I-2",
  "Cuisinier": "II-2",
  "Chef de partie": "III-3",
  "Sous-chef": "IV-2",
  "Chef": "V-2",
  // Salle
  "Runner": "I-2",
  "Serveur": "II-1",
  "Tabac": "II-1",
  "Barman": "III-1",
  "Chef de rang": "III-2",
  "Sous-chef de rang": "III-3",
};

export type HcrGrid = Record<HcrLevel, number>;

export function resolveHcrRate(
  level: HcrLevel | null | undefined,
  override: number | null | undefined,
  grid: Partial<HcrGrid> | null | undefined,
): number | null {
  if (typeof override === "number" && override > 0) return override;
  if (!level) return null;
  const effectiveGrid = { ...HCR_GRID_2026, ...(grid ?? {}) };
  return effectiveGrid[level] ?? null;
}

// Pick the highest niveau across the employee's sub-roles.
// Per-restaurant mapping wins over the global defaults; ranking uses HCR_LEVELS order.
export function highestHcrFromSubRoles(
  subRoles: readonly string[],
  restaurantMap: Record<string, HcrLevel> | null | undefined,
): HcrLevel | null {
  let best: HcrLevel | null = null;
  let bestRank = -1;
  for (const sr of subRoles) {
    const lvl = restaurantMap?.[sr] ?? DEFAULT_SUBROLE_TO_HCR[sr] ?? null;
    if (!lvl) continue;
    const rank = HCR_LEVELS.indexOf(lvl);
    if (rank > bestRank) { best = lvl; bestRank = rank; }
  }
  return best;
}
