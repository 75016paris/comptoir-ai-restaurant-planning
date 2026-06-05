/**
 * Contract generation — HCR convention collective boilerplates.
 *
 * ⚠ LEGAL DISCLAIMER: these templates are a pragmatic baseline reflecting
 * the HCR convention collective nationale (IDCC 1979). They are NOT a
 * substitute for legal counsel. Admins should have any template reviewed
 * by their lawyer or accountant before using for actual employment.
 *
 * The built-in defaults are used when a restaurant hasn't customised them.
 * Admins can override / add templates per restaurant via contract_templates.
 */

import { db } from "../db/connection.js";
import { contractTemplates, users, restaurants } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { userHasActiveRestaurantMembership } from "./restaurant-context.js";

export type ContractKind = "CDI" | "CDD" | "saisonnier" | "extra";

// ── Merge tokens available in templates ──
// {{worker.name}}, {{worker.firstName}}, {{worker.lastName}}, {{worker.email}},
// {{worker.phone}}, {{worker.address}}, {{worker.hcrLevel}}, {{worker.hourlyRate}},
// {{worker.role}}, {{worker.subRoles}}, {{contract.kind}}, {{contract.weeklyHours}},
// {{contract.startDate}}, {{contract.endDate}}, {{restaurant.name}},
// {{restaurant.address}}, {{restaurant.siret}}, {{today}}

const COMMON_PREAMBLE = `
<div class="preamble">
  <p>Entre les soussignés :</p>
  <p>
    <strong>{{restaurant.name}}</strong>, sis {{restaurant.address}},<br>
    représenté par son représentant légal,<br>
    ci-après dénommé « l'employeur »,
  </p>
  <p>d'une part,</p>
  <p>Et</p>
  <p>
    <strong>{{worker.name}}</strong>,<br>
    demeurant {{worker.address}},<br>
    ci-après dénommé « le salarié »,
  </p>
  <p>d'autre part,</p>
  <p>Il a été convenu ce qui suit :</p>
</div>
`.trim();

const COMMON_POSITION_ARTICLE = `
<h3>Article 1 — Fonctions</h3>
<p>
  Le salarié est engagé en qualité de <strong>{{worker.role}}{{worker.subRolesSuffix}}</strong>,
  au niveau hiérarchique <strong>{{worker.hcrLevel}}</strong> de la
  grille de classification de la convention collective nationale des Hôtels,
  Cafés, Restaurants (IDCC 1979).
</p>
<p>
  Les fonctions sont celles habituellement attribuées à ce poste, sous l'autorité
  de la direction, sans que cette énumération soit exhaustive ni limitative.
</p>
`.trim();

const COMMON_COMP_ARTICLE = `
<h3>Article 4 — Rémunération</h3>
<p>
  Le salaire horaire brut est fixé à <strong>{{contract.hourlyRate}} €</strong>,
  soit un salaire mensuel brut de base de <strong>{{contract.monthlyGross}} €</strong>
  pour une durée hebdomadaire contractuelle de {{contract.weeklyHours}} heures.
</p>
<p>
  Les heures supplémentaires éventuellement effectuées au-delà de la durée
  contractuelle sont rémunérées selon les taux prévus par la convention
  collective nationale des Hôtels, Cafés, Restaurants :
  majoration de 10 % pour les heures 36 à 39, 20 % de la 40ème à la 43ème heure,
  et 50 % au-delà de 43 heures hebdomadaires.
</p>
<p>
  Avantage en nature nourriture : les repas fournis par l'employeur pendant
  les heures de service sont évalués à 2 fois le minimum garanti par jour
  conformément à la convention collective.
</p>
`.trim();

const COMMON_HOURS_ARTICLE = `
<h3>Article 3 — Durée du travail</h3>
<p>
  La durée contractuelle du travail est fixée à <strong>{{contract.weeklyHours}} heures</strong>
  par semaine, réparties selon un planning remis au salarié au moins 15 jours
  à l'avance, conformément aux usages de la profession et à la convention
  collective HCR.
</p>
<p>
  Les horaires pourront être modifiés en fonction des nécessités du service
  avec un préavis de 8 jours, hors cas d'urgence nécessitant une adaptation
  plus rapide.
</p>
`.trim();

const COMMON_LEAVES_ARTICLE = `
<h3>Article 5 — Congés payés</h3>
<p>
  Le salarié bénéficie des congés payés prévus par la loi et la convention
  collective HCR : 2,5 jours ouvrables par mois de travail effectif, soit
  30 jours ouvrables (5 semaines) par année de référence complète.
</p>
`.trim();

const COMMON_MISC_ARTICLES = `
<h3>Article 6 — Convention collective</h3>
<p>
  Le présent contrat est régi par les dispositions du Code du travail et de
  la <strong>convention collective nationale des Hôtels, Cafés, Restaurants
  (IDCC 1979)</strong>, disponible pour consultation au sein de l'établissement.
</p>

<h3>Article 7 — Visite médicale</h3>
<p>
  Le salarié s'engage à se soumettre à la visite médicale d'embauche et aux
  visites périodiques organisées par la médecine du travail.
</p>

<h3>Article 8 — Documents préalables</h3>
<p>
  Le salarié remettra à l'employeur, préalablement à sa prise de poste, les
  documents requis : pièce d'identité, carte vitale, RIB, justificatif de
  domicile, certificat d'aptitude médicale, et attestation de formation HACCP
  pour les postes en cuisine.
</p>

<h3>Article 9 — Confidentialité</h3>
<p>
  Le salarié s'engage à observer la plus stricte discrétion sur les
  informations confidentielles dont il pourrait avoir connaissance dans
  l'exercice de ses fonctions (recettes, clients, chiffres d'affaires, etc.).
</p>
`.trim();

const COMMON_SIGNATURE = `
<div class="signatures">
  <p>Fait à {{restaurant.city}}, le {{today}}</p>
  <p>En deux exemplaires originaux, dont un remis au salarié.</p>
  <table style="width:100%; margin-top: 60px;">
    <tr>
      <td style="text-align:left; width:50%;">
        <p><strong>Pour l'employeur</strong><br>Signature :</p>
      </td>
      <td style="text-align:right; width:50%;">
        <p><strong>Le salarié</strong><br>Signature précédée de la mention « Lu et approuvé » :</p>
      </td>
    </tr>
  </table>
</div>
`.trim();

// ── CDI ──
const TEMPLATE_CDI = `
<h1>Contrat de travail à durée indéterminée</h1>
<p class="subtitle">Convention collective nationale des Hôtels, Cafés, Restaurants (IDCC 1979)</p>

${COMMON_PREAMBLE}

${COMMON_POSITION_ARTICLE}

<h3>Article 2 — Engagement et période d'essai</h3>
<p>
  Le présent contrat est conclu pour une durée indéterminée, à compter du
  <strong>{{contract.startDate}}</strong>.
</p>
<p>
  Il est expressément convenu entre les parties une période d'essai de
  <strong>{{contract.trialPeriod}}</strong>, durant laquelle chaque partie
  pourra rompre le contrat sans indemnité ni préavis, dans le respect des
  délais de prévenance légaux.
</p>

${COMMON_HOURS_ARTICLE}

${COMMON_COMP_ARTICLE}

${COMMON_LEAVES_ARTICLE}

${COMMON_MISC_ARTICLES}

${COMMON_SIGNATURE}
`.trim();

// ── CDD ──
const TEMPLATE_CDD = `
<h1>Contrat de travail à durée déterminée</h1>
<p class="subtitle">Convention collective nationale des Hôtels, Cafés, Restaurants (IDCC 1979)</p>

${COMMON_PREAMBLE}

${COMMON_POSITION_ARTICLE}

<h3>Article 2 — Durée du contrat et motif</h3>
<p>
  Le présent contrat est conclu pour une durée déterminée, du
  <strong>{{contract.startDate}}</strong> au
  <strong>{{contract.endDate}}</strong>,
  au motif suivant : <strong>{{contract.cddReason}}</strong>
  (conformément aux articles L1242-1 et suivants du Code du travail).
</p>
<p>
  Une période d'essai de <strong>{{contract.trialPeriod}}</strong> est prévue,
  durant laquelle chaque partie peut rompre le contrat avec les délais de
  prévenance légaux.
</p>

${COMMON_HOURS_ARTICLE}

${COMMON_COMP_ARTICLE}

<h3>Article 5 — Indemnité de fin de contrat</h3>
<p>
  À l'issue du contrat, si les relations contractuelles ne se poursuivent pas
  par un contrat à durée indéterminée, le salarié percevra une indemnité de
  fin de contrat égale à 10 % de la rémunération totale brute versée, sauf
  exceptions légales (notamment emploi saisonnier, emploi d'usage, ou refus
  d'un CDI proposé à la suite).
</p>

${COMMON_LEAVES_ARTICLE}

${COMMON_MISC_ARTICLES}

${COMMON_SIGNATURE}
`.trim();

// ── Saisonnier ──
const TEMPLATE_SAISONNIER = `
<h1>Contrat de travail saisonnier</h1>
<p class="subtitle">Convention collective nationale des Hôtels, Cafés, Restaurants (IDCC 1979)</p>

${COMMON_PREAMBLE}

${COMMON_POSITION_ARTICLE}

<h3>Article 2 — Nature saisonnière et durée</h3>
<p>
  Le présent contrat est un contrat à durée déterminée à caractère saisonnier
  conclu au sens de l'article L1242-2, 3° du Code du travail. Il s'applique
  à une activité dont la répétition a un caractère cyclique lié au rythme des
  saisons ou à une période particulière de forte affluence.
</p>
<p>
  Il est conclu du <strong>{{contract.startDate}}</strong> au
  <strong>{{contract.endDate}}</strong>, pour la saison
  <strong>{{contract.season}}</strong>.
</p>
<p>
  Conformément à la nature saisonnière du contrat, aucune indemnité de fin
  de contrat (prime de précarité) n'est due.
</p>
<p>
  Une période d'essai de <strong>{{contract.trialPeriod}}</strong> est prévue,
  durant laquelle chaque partie peut rompre le contrat avec les délais de
  prévenance légaux.
</p>

${COMMON_HOURS_ARTICLE}

${COMMON_COMP_ARTICLE}

${COMMON_LEAVES_ARTICLE}

${COMMON_MISC_ARTICLES}

${COMMON_SIGNATURE}
`.trim();

// ── Extra ──
const TEMPLATE_EXTRA = `
<h1>Contrat d'extra (CDD d'usage)</h1>
<p class="subtitle">Convention collective nationale des Hôtels, Cafés, Restaurants (IDCC 1979) — Article 14 (extras)</p>

${COMMON_PREAMBLE}

${COMMON_POSITION_ARTICLE}

<h3>Article 2 — Nature du contrat et durée</h3>
<p>
  Le présent contrat est un contrat à durée déterminée d'usage pour « extra »,
  conclu conformément à l'article L1242-2, 3° du Code du travail et à l'article
  14 de la convention collective nationale des Hôtels, Cafés, Restaurants.
</p>
<p>
  Il est conclu pour la ou les période(s) suivante(s) :
  <strong>{{contract.extraDates}}</strong>.
</p>
<p>
  Conformément à l'usage HCR, le contrat d'extra ne donne pas lieu à
  indemnité de fin de contrat.
</p>

${COMMON_HOURS_ARTICLE}

${COMMON_COMP_ARTICLE}

${COMMON_LEAVES_ARTICLE}

${COMMON_MISC_ARTICLES}

${COMMON_SIGNATURE}
`.trim();

const DEFAULT_TEMPLATES: Record<ContractKind, { name: string; body: string }> = {
  CDI: { name: "CDI standard HCR", body: TEMPLATE_CDI },
  CDD: { name: "CDD classique HCR", body: TEMPLATE_CDD },
  saisonnier: { name: "Contrat saisonnier HCR", body: TEMPLATE_SAISONNIER },
  extra: { name: "Contrat d'extra HCR", body: TEMPLATE_EXTRA },
};

export function getDefaultTemplate(kind: ContractKind): { name: string; body: string } {
  return DEFAULT_TEMPLATES[kind];
}

// ── Rendering ──

export type ContractInputs = {
  weeklyHours?: number;
  startDate?: string;         // YYYY-MM-DD
  endDate?: string;           // YYYY-MM-DD (CDD / saisonnier / extra)
  trialPeriod?: string;       // "2 mois", "1 mois", "14 jours"
  cddReason?: string;         // "remplacement", "accroissement temporaire d'activité"…
  season?: string;            // "printemps-été 2026"
  extraDates?: string;        // "23, 24 et 25 juin 2026"
  hourlyRate?: number;        // overrides the worker's stored rate — in cents
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function renderContract(
  restaurantId: string,
  workerId: string,
  kind: ContractKind,
  inputs: ContractInputs = {},
  templateId?: string,
): { html: string; tokens: Record<string, string> } {
  const [restaurant] = db.select({
    id: restaurants.id,
    name: restaurants.name,
    address: restaurants.address,
    siret: restaurants.siret,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  if (!restaurant) throw new Error("Restaurant not found");
  if (!userHasActiveRestaurantMembership(workerId, restaurantId)) throw new Error("Worker not found");
  const [worker] = db.select({
    id: users.id,
    name: users.name,
    firstName: users.firstName,
    lastName: users.lastName,
    email: users.email,
    phone: users.phone,
    address: users.address,
    hcrLevel: users.hcrLevel,
    role: users.role,
    subRoles: users.subRoles,
    hourlyRate: users.hourlyRate,
    contractHours: users.contractHours,
  }).from(users).where(eq(users.id, workerId)).limit(1).all();
  if (!worker) throw new Error("Worker not found");

  // Pick template: explicit id > restaurant default for kind > built-in default
  let body: string;
  if (templateId) {
    const [tpl] = db.select().from(contractTemplates).where(and(eq(contractTemplates.id, templateId), eq(contractTemplates.restaurantId, restaurantId))).limit(1).all();
    if (!tpl) throw new Error("Template not found");
    body = tpl.bodyHtml;
  } else {
    const [tpl] = db.select().from(contractTemplates)
      .where(and(eq(contractTemplates.restaurantId, restaurantId), eq(contractTemplates.kind, kind), eq(contractTemplates.isDefault, true)))
      .limit(1).all();
    body = tpl?.bodyHtml ?? DEFAULT_TEMPLATES[kind].body;
  }

  const weeklyHours = inputs.weeklyHours ?? worker.contractHours ?? 35;
  const hourlyRateCents = inputs.hourlyRate ?? worker.hourlyRate ?? 0;
  const hourlyRateEur = hourlyRateCents / 100;
  const monthlyGrossEur = Math.round(hourlyRateCents * weeklyHours * 52 / 12) / 100;

  // Parse subRoles
  let subRoles: string[] = [];
  try { subRoles = worker.subRoles ? JSON.parse(worker.subRoles) : []; } catch { /* ignore */ }
  const subRolesSuffix = subRoles.length > 0 ? ` (${subRoles.join(", ")})` : "";

  const today = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const restaurantCity = restaurant.address?.match(/\d{5}\s+([^,]+)/)?.[1] ?? "Paris";

  const tokens: Record<string, string> = {
    "worker.name": worker.name,
    "worker.firstName": worker.firstName ?? "",
    "worker.lastName": worker.lastName ?? worker.name,
    "worker.email": worker.email ?? "",
    "worker.phone": worker.phone ?? "",
    "worker.address": worker.address ?? "[adresse à compléter]",
    "worker.hcrLevel": worker.hcrLevel ?? "Niveau à préciser",
    "worker.role": worker.role === "kitchen" ? "cuisine" : worker.role === "floor" ? "salle" : worker.role,
    "worker.subRoles": subRoles.join(", "),
    "worker.subRolesSuffix": subRolesSuffix,
    "worker.hourlyRate": hourlyRateEur.toFixed(2),
    "contract.kind": kind,
    "contract.weeklyHours": String(weeklyHours),
    "contract.startDate": inputs.startDate ?? "[date de début à préciser]",
    "contract.endDate": inputs.endDate ?? "[date de fin à préciser]",
    "contract.trialPeriod": inputs.trialPeriod ?? (kind === "CDI" ? "2 mois" : "1 mois"),
    "contract.cddReason": inputs.cddReason ?? "[motif à préciser]",
    "contract.season": inputs.season ?? "[saison à préciser]",
    "contract.extraDates": inputs.extraDates ?? "[dates à préciser]",
    "contract.hourlyRate": hourlyRateEur.toFixed(2),
    "contract.monthlyGross": monthlyGrossEur.toFixed(2),
    "restaurant.name": restaurant.name,
    "restaurant.address": restaurant.address ?? "[adresse à compléter]",
    "restaurant.city": restaurantCity,
    "restaurant.siret": "[SIRET à renseigner dans les préférences]",
    "today": today,
  };

  // Replace {{token}} with escaped HTML values
  let rendered = body;
  for (const [key, val] of Object.entries(tokens)) {
    rendered = rendered.replaceAll(`{{${key}}}`, escapeHtml(val));
  }

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Contrat ${kind} — ${escapeHtml(worker.name)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.6; color: #1a1a1a; max-width: 780px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 20pt; border-bottom: 2px solid #000; padding-bottom: 6px; }
  h3 { font-size: 13pt; margin-top: 24px; }
  .subtitle { color: #666; font-style: italic; margin-top: -8px; }
  .preamble p { margin: 8px 0; }
  .signatures { margin-top: 50px; page-break-inside: avoid; }
  .disclaimer { font-size: 9pt; color: #888; margin-top: 40px; padding-top: 12px; border-top: 1px solid #ccc; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
${rendered}
<p class="disclaimer">
  Document généré automatiquement par Comptoir à partir du modèle HCR intégré.
  Ce document est un projet de contrat fourni à titre indicatif — il est recommandé
  de le faire relire par un conseil juridique ou un expert-comptable avant signature.
</p>
</body>
</html>`;

  return { html, tokens };
}
