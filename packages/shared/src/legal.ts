// French labour-law references — links to Légifrance / official sources.
// Update these whenever the underlying texts are amended.

export const LEGAL_LINKS = {
  // Convention Collective Nationale des HCR (IDCC 1979) — Hôtels, Cafés, Restaurants
  hcrConvention: {
    label: "Convention collective HCR (IDCC 1979)",
    url: "https://www.legifrance.gouv.fr/conv_coll/id/KALICONT000005635540",
  },
  // Avenant n° 30 du 13 mars 2024 (grille de salaires en vigueur 2024-2026)
  hcrSalaryGrid: {
    label: "Avenant n° 30 — Grille de salaires HCR",
    url: "https://www.legifrance.gouv.fr/conv_coll/article/KALIARTI000049398710",
  },
  // CDI — Contrat à durée indéterminée
  cdi: {
    label: "CDI — Code du travail (art. L1221-1 et s.)",
    url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006072050/LEGISCTA000006177873/",
  },
  // CDD — Contrat à durée déterminée
  cdd: {
    label: "CDD — Code du travail (art. L1242-1 et s.)",
    url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006072050/LEGISCTA000006195614/",
  },
  // CDD — Renouvellement (art. L1243-13-1)
  cddRenewal: {
    label: "Renouvellement du CDD — art. L1243-13-1",
    url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033012810",
  },
  // CDD saisonnier — art. L1242-2 3°
  cddSaisonnier: {
    label: "CDD saisonnier — art. L1242-2 3°",
    url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033012774",
  },
  // CDD d'usage / extra — synthèse officielle Service-Public
  cddUsage: {
    label: "CDD d'usage / contrat d'extra",
    url: "https://www.service-public.fr/particuliers/vosdroits/F33693",
  },
  // Modèle officiel Service-Public — CDD générique (pas spécifique extra)
  cddModel: {
    label: "Modèle de CDD — Service-Public",
    url: "https://www.service-public.fr/particuliers/vosdroits/R68833",
  },
  // DPAE — Déclaration Préalable à l'Embauche
  dpae: {
    label: "DPAE — URSSAF",
    url: "https://www.urssaf.fr/accueil/employeur/embaucher-salarie/dpae.html",
  },
  // Durée du travail — limites quotidiennes / hebdomadaires
  workingTime: {
    label: "Durée du travail — Code du travail (art. L3121-1 et s.)",
    url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006072050/LEGISCTA000006195630/",
  },
  // Heures supplémentaires (HCR avenant n° 2 — 39h, taux majorés)
  overtimeHcr: {
    label: "Heures supplémentaires HCR — avenant n° 2",
    url: "https://www.legifrance.gouv.fr/conv_coll/article/KALIARTI000005844435",
  },
  // Repos quotidien (11h) et hebdomadaire (35h) — HCR
  restPeriods: {
    label: "Repos quotidien & hebdomadaire — Code du travail",
    url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006072050/LEGISCTA000006177862/",
  },
  // Période d'essai — CDI 2 mois (employé), renouvelable une fois
  probation: {
    label: "Période d'essai — art. L1221-19 à L1221-26",
    url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006072050/LEGISCTA000019067459/",
  },
  // Imposition des congés en cas de fermeture d'établissement — art. L3141-13
  imposedLeaveClosure: {
    label: "Congés imposés (fermeture) — art. L3141-13",
    url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020385",
  },
  // Congés payés — 2,5 jours ouvrables par mois de travail effectif.
  paidLeaveDuration: {
    label: "Congés payés — Code du travail art. L3141-3",
    url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020826",
  },
  // Convention collective HCR — indemnité de congé (article 24).
  hcrPaidLeaveIndemnity: {
    label: "CCN HCR — indemnité de congé art. 24",
    url: "https://www.legifrance.gouv.fr/conv_coll/id/KALIARTI000005826285",
  },
} as const;

export type LegalLinkKey = keyof typeof LEGAL_LINKS;
