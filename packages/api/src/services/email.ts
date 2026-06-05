/**
 * Transactional email service — OVH SMTP via nodemailer.
 * Sends password reset links, welcome emails, etc.
 * Falls back to console.log when SMTP is not configured.
 */
import nodemailer from "nodemailer";
import { formatLogMessagePreview, redactSensitiveString } from "@comptoir/shared";

// ── Config ──

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "info@cosmobot.fr";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const isConfigured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

// ── Transport (lazy) ──

let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter | null {
  if (!isConfigured) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transport;
}

// ── Send helper ──

type Attachment = { filename: string; content: string | Buffer; contentType?: string };

async function send(to: string, subject: string, html: string, attachments?: Attachment[]): Promise<boolean> {
  const t = getTransport();
  const safeTo = redactSensitiveString(to);
  const safeSubject = formatLogMessagePreview(subject);
  if (!t) {
    console.log(`[email] (no SMTP) → ${safeTo}: ${safeSubject}${attachments?.length ? ` [+${attachments.length} attachment(s)]` : ""}`);
    return false;
  }
  try {
    await t.sendMail({ from: `Comptoir <${SMTP_FROM}>`, to, subject, html, attachments });
    console.log(`[email] ✓ → ${safeTo}: ${safeSubject}`);
    return true;
  } catch (err: any) {
    console.error(`[email] ✗ → ${safeTo}: ${redactSensitiveString(err.message)}`);
    return false;
  }
}

// ── Shared styles ──

const STYLE = {
  container: 'max-width:520px;margin:0 auto;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#1a1a1a;',
  header: "padding:24px 0;text-align:center;border-bottom:1px solid #e5e5e5;",
  logo: "font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#1a1a1a;text-decoration:none;",
  body: "padding:32px 0;",
  button: "display:inline-block;padding:12px 32px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:500;font-size:15px;",
  footer: "padding:24px 0;border-top:1px solid #e5e5e5;text-align:center;font-size:12px;color:#888;",
  muted: "color:#888;font-size:13px;",
} as const;

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:20px;background:#fafafa;">
<div style="${STYLE.container}">
  <div style="${STYLE.header}">
    <a href="${FRONTEND_URL}" style="${STYLE.logo}">Comptoir</a>
  </div>
  <div style="${STYLE.body}">
    ${content}
  </div>
  <div style="${STYLE.footer}">
    Comptoir par <a href="https://cosmobot.fr" style="color:#888;">Cosmobot</a><br>
    Gestion du personnel pour la restauration
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

// ── Email templates ──

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<boolean> {
  return send(to, "Réinitialisation de votre mot de passe — Comptoir", layout(`
    <p>Bonjour <strong>${name}</strong>,</p>
    <p>Vous avez demandé à réinitialiser votre mot de passe.</p>
    <p style="text-align:center;padding:16px 0;">
      <a href="${resetUrl}" style="${STYLE.button}">Réinitialiser mon mot de passe</a>
    </p>
    <p style="${STYLE.muted}">Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez cet e-mail.</p>
    <p style="${STYLE.muted}">Lien direct : <a href="${resetUrl}" style="color:#888;">${resetUrl}</a></p>
  `));
}

export async function sendWelcomeEmail(to: string, name: string, restaurantName: string): Promise<boolean> {
  const loginUrl = `${FRONTEND_URL}/login`;
  return send(to, `Bienvenue sur Comptoir — ${restaurantName}`, layout(`
    <p>Bonjour <strong>${name}</strong>,</p>
    <p>Votre compte Comptoir est prêt pour <strong>${restaurantName}</strong>.</p>
    <p>Vous pouvez dès maintenant :</p>
    <ul style="padding-left:20px;line-height:1.8;">
      <li>Créer votre équipe et définir les rôles</li>
      <li>Configurer vos créneaux et zones horaires</li>
      <li>Planifier le planning de la semaine</li>
    </ul>
    <p style="text-align:center;padding:16px 0;">
      <a href="${loginUrl}" style="${STYLE.button}">Accéder à Comptoir</a>
    </p>
    <p style="${STYLE.muted}">
      <strong>Conseil mot de passe :</strong> quatre mots sans rapport entre eux (ex. <em>fromage-piano-orage-citron</em>)
      sont plus sûrs qu'un mot court avec chiffres et symboles — et plus faciles à retenir.
      Évitez le nom du site, votre prénom ou une phrase connue.
      Le plus simple : laissez <a href="https://bitwarden.com/" style="color:#888;">Bitwarden</a> (gratuit) ou
      <a href="https://1password.com/fr/" style="color:#888;">1Password</a> générer la phrase pour vous.
    </p>
    <p style="${STYLE.muted}">Besoin d'aide ? Répondez directement à cet e-mail.</p>
  `));
}

export async function sendWorkerAccountSetupEmail(to: string, name: string, restaurantName: string, passwordSetupUrl: string): Promise<boolean> {
  return send(to, `Votre accès Comptoir — ${restaurantName}`, layout(`
    <p>Bonjour <strong>${name}</strong>,</p>
    <p><strong>${restaurantName}</strong> vous a ajouté·e à son équipe sur Comptoir.</p>
    <p>Pour accéder à votre espace et consulter votre planning, choisissez votre mot de passe :</p>
    <p style="text-align:center;padding:16px 0;">
      <a href="${passwordSetupUrl}" style="${STYLE.button}">Choisir mon mot de passe</a>
    </p>
    <p style="${STYLE.muted}">Ce lien est personnel et expire dans 24 heures.</p>
    <p style="${STYLE.muted}">Lien direct : <a href="${passwordSetupUrl}" style="color:#888;">${passwordSetupUrl}</a></p>
  `));
}

export async function sendWorkerInvitationEmail(
  to: string,
  name: string,
  restaurantName: string,
  opts: {
    defaultPassword?: string;
    passwordSetupUrl?: string;
    personalInfoNeeded: string[];                                // empty users.* fields (adresse, IBAN, …)
    missingDocs: Array<{ label: string; description: string }>;  // mandatory checklist items still to upload
    onboardingUrl?: string;                                       // magic-link to /onboarding/<token> — if set, replaces the login CTA
  },
): Promise<boolean> {
  const ctaUrl = opts.onboardingUrl || `${FRONTEND_URL}/login`;
  const ctaLabel = opts.onboardingUrl ? "Compléter mon dossier" : "Accéder à mon compte";

  const renderList = (items: string[]) =>
    `<ul style="padding-left:20px;line-height:1.8;margin:8px 0 0;">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

  const sections: string[] = [];
  if (opts.personalInfoNeeded.length > 0) {
    sections.push(`<p><strong>Informations à renseigner :</strong>${renderList(opts.personalInfoNeeded)}</p>`);
  }
  if (opts.missingDocs.length > 0) {
    const docLis = opts.missingDocs.map(
      (d) => `<strong>${d.label}</strong><br><span style="color:#888;font-size:13px;">${d.description}</span>`,
    );
    sections.push(`<p><strong>Documents à téléverser :</strong>${renderList(docLis)}</p>`);
  }
  const intro = sections.length > 0
    ? `<p>Avant votre première mission, votre employeur doit déclarer votre embauche à l'URSSAF (DPAE).
       Pour cela, merci de compléter votre dossier&nbsp;:</p>
       ${sections.join("")}
       <p style="${STYLE.muted};margin-top:16px;">
         Ces informations sont demandées par la <strong>Déclaration Préalable À l'Embauche</strong>
         (Code du travail L1221-10). Sans elles, votre contrat ne peut pas être finalisé.
         Vos données restent confidentielles et ne sont utilisées que pour les démarches légales (URSSAF, paie).
       </p>`
    : `<p>Votre dossier est complet côté administratif — rien à téléverser pour l'instant. Connectez-vous pour découvrir votre planning.</p>`;

  const passwordSetupBlock = opts.passwordSetupUrl
    ? `<p style="${STYLE.muted}">
         Pour accéder ensuite à votre planning, définissez votre mot de passe ici :<br>
         <a href="${opts.passwordSetupUrl}" style="color:#888;">${opts.passwordSetupUrl}</a>
       </p>`
    : "";

  const credentialsBlock = opts.defaultPassword
    ? `<p style="${STYLE.muted}">
         Identifiants :<br>
         Email : <strong>${to}</strong><br>
         Mot de passe provisoire : <strong>${opts.defaultPassword}</strong>
       </p>
       <p style="${STYLE.muted}">
         <strong>Changez ce mot de passe dès la première connexion.</strong><br>
         Astuce : quatre mots sans rapport entre eux (ex. <em>fromage-piano-orage-citron</em>) sont plus sûrs
         qu'un mot court avec chiffres et symboles. Évitez le nom du site, votre prénom ou une phrase connue.
         Le plus simple : laissez <a href="https://bitwarden.com/" style="color:#888;">Bitwarden</a> (gratuit) ou
         <a href="https://1password.com/fr/" style="color:#888;">1Password</a> générer la phrase pour vous.
       </p>`
    : passwordSetupBlock;

  return send(to, `Invitation ${restaurantName} — complétez votre dossier`, layout(`
    <p>Bonjour <strong>${name}</strong>,</p>
    <p><strong>${restaurantName}</strong> vous a ajouté·e à son équipe sur Comptoir.</p>
    ${intro}
    <p style="text-align:center;padding:16px 0;">
      <a href="${ctaUrl}" style="${STYLE.button}">${ctaLabel}</a>
    </p>
    ${opts.onboardingUrl ? `<p style="${STYLE.muted};font-size:12px;">Ce lien est personnel et reste actif 72 heures.</p>` : ""}
    ${credentialsBlock}
  `));
}

// ── Dossier reminder ──

// Sent every 3 days by /cron/dossier-reminders to workers whose dossier is
// still incomplete. The CTA is a fresh magic link (the cron mints one before
// calling here) so the worker doesn't need to dig out the original email.
export async function sendDossierReminderEmail(
  to: string,
  workerName: string,
  restaurantName: string,
  onboardingUrl: string,
  missing: { personalInfoNeeded: string[]; missingDocs: Array<{ label: string; description: string }> },
): Promise<boolean> {
  const renderList = (items: string[]) =>
    `<ul style="padding-left:20px;line-height:1.8;margin:8px 0 0;">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  const sections: string[] = [];
  if (missing.personalInfoNeeded.length > 0) {
    sections.push(`<p><strong>Informations à renseigner :</strong>${renderList(missing.personalInfoNeeded)}</p>`);
  }
  if (missing.missingDocs.length > 0) {
    const docLis = missing.missingDocs.map(
      (d) => `<strong>${d.label}</strong><br><span style="color:#888;font-size:13px;">${d.description}</span>`,
    );
    sections.push(`<p><strong>Documents à téléverser :</strong>${renderList(docLis)}</p>`);
  }

  return send(to, `Rappel — votre dossier ${restaurantName} est incomplet`, layout(`
    <p>Bonjour <strong>${workerName}</strong>,</p>
    <p>Votre dossier pour <strong>${restaurantName}</strong> n'est pas encore complet.
       Sans ces informations, votre embauche ne peut pas être déclarée à l'URSSAF.</p>
    ${sections.join("")}
    <p style="text-align:center;padding:16px 0;">
      <a href="${onboardingUrl}" style="${STYLE.button}">Compléter mon dossier</a>
    </p>
    <p style="${STYLE.muted};font-size:12px;">Ce lien est personnel et reste actif 72 heures.</p>
  `));
}

// ── Dossier completion ──

export async function sendDossierCompletedEmail(
  to: string,
  adminName: string,
  workerName: string,
  restaurantName: string,
): Promise<boolean> {
  const url = `${FRONTEND_URL}/staff`;
  return send(to, `Dossier complété — ${workerName}`, layout(`
    <p>Bonjour <strong>${adminName}</strong>,</p>
    <p><strong>${workerName}</strong> vient de finir de compléter son dossier pour <strong>${restaurantName}</strong>.</p>
    <p>Tous les champs DPAE et les documents obligatoires sont en place. Vous pouvez maintenant générer la DPAE depuis sa fiche.</p>
    <p style="text-align:center;padding:16px 0;">
      <a href="${url}" style="${STYLE.button}">Voir l'équipe</a>
    </p>
  `));
}

export type CancellationAlertEmailData = {
  restaurantName: string;
  restaurantId: string;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  periodEnd: string | null;
  cancelAt: string | null;
  requestedAt: string | null;
  reason: string | null;
  feedback: string | null;
  comment: string | null;
};

export async function sendCancellationAlertEmail(to: string, d: CancellationAlertEmailData): Promise<boolean> {
  const rows: Array<[string, string | null]> = [
    ["Restaurant", `${d.restaurantName} (${d.restaurantId})`],
    ["Statut", d.subscriptionStatus],
    ["Annulation demandée le", d.requestedAt],
    ["Fin d'accès prévue", d.cancelAt],
    ["Fin de période", d.periodEnd],
    ["Raison Stripe", d.reason],
    ["Feedback", d.feedback],
    ["Commentaire", d.comment],
    ["Customer Stripe", d.stripeCustomerId],
    ["Subscription Stripe", d.stripeSubscriptionId],
  ];
  const table = rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${escapeHtml(value || "—")}</td>
    </tr>`).join("");

  return send(to, `Annulation abonnement Comptoir — ${d.restaurantName}`, layout(`
    <p style="font-size:18px;font-weight:600;margin:0 0 4px;">Annulation abonnement</p>
    <p style="${STYLE.muted};margin:0 0 24px;">Un abonnement Stripe Comptoir vient d'être marqué comme annulé ou en annulation.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${table}</table>
  `));
}

// ── Monthly digest ──

import type { MonthlyDigest } from "./monthly-digest.js";
import { missingSilaeMatricules, normalizeSilaeCodes, payrollToCSV, payrollToSilae, silaeMatriculePlaceholder } from "./payroll.js";

function fmtHours(h: number): string {
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h${String(mm).padStart(2, "0")}`;
}

export async function sendMonthlyDigestEmail(to: string, d: MonthlyDigest): Promise<boolean> {
  const loginUrl = `${FRONTEND_URL}/schedule`;
  const row = (label: string, value: string): string =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">${label}</td>`
    + `<td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${value}</td></tr>`;

  const expiringList = d.leave.expiringSoonWorkers.length > 0
    ? `<ul style="padding-left:20px;line-height:1.7;margin:6px 0 0;">${
        d.leave.expiringSoonWorkers.map(w => `<li><strong>${w.name}</strong> — ${w.days}j restants</li>`).join("")
      }</ul>`
    : "";

  // Per-employee table — kitchen first, then floor, sorted by hours within each role.
  const workerRow = (w: MonthlyDigest["workers"][number]): string => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;">${w.name}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#888;font-size:12px;">${w.role === "kitchen" ? "Cuisine" : "Salle"}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${fmtHours(w.totalHours)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:${w.overtimeHours > 0 ? "#a35a00" : "#bbb"};">${w.overtimeHours > 0 ? `+${fmtHours(w.overtimeHours)}` : "—"}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:#888;">${w.holidayDays > 0 ? `${w.holidayDays}j` : "—"}</td>
    </tr>`;
  const workerTable = d.workers.length > 0 ? `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
      <thead>
        <tr style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">
          <th style="padding:6px 8px;font-weight:500;border-bottom:1px solid #ddd;">Employé</th>
          <th style="padding:6px 8px;font-weight:500;border-bottom:1px solid #ddd;">Rôle</th>
          <th style="padding:6px 8px;font-weight:500;border-bottom:1px solid #ddd;text-align:right;">Heures</th>
          <th style="padding:6px 8px;font-weight:500;border-bottom:1px solid #ddd;text-align:right;">HS</th>
          <th style="padding:6px 8px;font-weight:500;border-bottom:1px solid #ddd;text-align:right;">CP pris</th>
        </tr>
      </thead>
      <tbody>${d.workers.map(workerRow).join("")}</tbody>
    </table>
  ` : `<p style="${STYLE.muted};margin:8px 0 0;">Aucun pointage enregistré sur la période.</p>`;

  const otBreakdown = d.overtime.totalHours > 0
    ? ` <span style="${STYLE.muted}">(${[
        d.overtime.ot110 > 0 ? `${fmtHours(d.overtime.ot110)} à 110%` : null,
        d.overtime.ot120 > 0 ? `${fmtHours(d.overtime.ot120)} à 120%` : null,
        d.overtime.ot150 > 0 ? `${fmtHours(d.overtime.ot150)} à 150%` : null,
      ].filter(Boolean).join(" · ")})</span>`
    : "";

  const csv = payrollToCSV(d.payroll);
  const csvFilename = `paie-${d.month}-${d.restaurantName.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.csv`;
  const silaeCodes = normalizeSilaeCodes(d.silaeCodes);
  const attachments: Attachment[] = [{
    filename: csvFilename,
    content: csv,
    contentType: "text/csv; charset=utf-8",
  }];
  const silaeFilename = `silae-${d.month}-${d.restaurantName.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.csv`;
  const missingSilaeWorkers = d.payroll.workers
    .filter(w => !w.matricule?.trim())
    .map(w => ({
      name: w.name,
      placeholder: silaeMatriculePlaceholder(w),
    }));
  let silaeNotice = "";
  if (d.includeSilaeInMonthlyDigest) {
    const missingMatricules = missingSilaeMatricules(d.payroll);
    if (missingMatricules.length === 0) {
      attachments.push({
        filename: silaeFilename,
        content: payrollToSilae(d.payroll, silaeCodes),
        contentType: "text/csv; charset=utf-8",
      });
    } else {
      silaeNotice = `
        <div style="margin-top:20px;padding:14px;border-left:3px solid #a35a00;background:#fff9eb;">
          <p style="margin:0 0 6px;font-weight:600;">Export Silae non joint</p>
          <p style="${STYLE.muted};margin:0 0 8px;">
            L'option Silae est activée, mais certains salariés n'ont pas de matricule. Renseignez leur matricule Silae dans leur fiche employé puis relancez le récap.
          </p>
          <ul style="padding-left:20px;line-height:1.7;margin:6px 0 0;">${
            missingSilaeWorkers.map(w => `<li><strong>${w.name}</strong> — placeholder temporaire : <code>${w.placeholder}</code></li>`).join("")
          }</ul>
        </div>
      `;
    }
  }

  return send(to, `Récap ${d.monthLabel} — ${d.restaurantName}`, layout(`
    <p style="font-size:18px;font-weight:600;margin:0 0 4px;">${d.restaurantName}</p>
    <p style="${STYLE.muted};margin:0 0 24px;">Récapitulatif de ${d.monthLabel}</p>

    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td colspan="2" style="padding:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#888;">Heures travaillées</td></tr>
      ${row("Total équipe", fmtHours(d.hours.total))}
      ${row("Cuisine", fmtHours(d.hours.kitchen))}
      ${row("Salle", fmtHours(d.hours.floor))}
      ${row("Heures supp. (HCR &gt;39h/sem)", `${fmtHours(d.overtime.totalHours)}${otBreakdown}`)}

      <tr><td colspan="2" style="padding:20px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#888;">Planning</td></tr>
      ${row("Services planifiés", `${d.coverage.scheduledServices}`)}
      ${row("Annulés", `${d.cancellations.count}${d.cancellations.totalServices > 0 ? ` (${d.cancellations.pct}%)` : ""}`)}

      <tr><td colspan="2" style="padding:20px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#888;">Remplacements</td></tr>
      ${row("Demandés", `${d.replacements.total}`)}
      ${row("Acceptés", `${d.replacements.accepted}`)}
      ${row("Refusés / expirés", `${d.replacements.rejected + d.replacements.expired}`)}
      ${row("En attente", `${d.replacements.pending}`)}

      <tr><td colspan="2" style="padding:20px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#888;">Retards &amp; départs anticipés</td></tr>
      ${row("Incidents", `${d.lateness.incidents}`)}
      ${row("Retard cumulé", fmtMinutes(d.lateness.totalLateMinutes))}
      ${row("Départ anticipé cumulé", fmtMinutes(d.lateness.totalEarlyLeaveMinutes))}

      <tr><td colspan="2" style="padding:20px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#888;">Congés</td></tr>
      ${row("CP pris ce mois", `${d.leave.daysTakenInMonth}j`)}
      ${row("Maladie ce mois", `${d.leave.sickDaysTakenInMonth}j`)}
      ${row("Solde équipe à poser", `${d.leave.totalRemainingDays}j`)}
      ${row("À poser avant le 31 mai", `${d.leave.expiringSoonCount} employé${d.leave.expiringSoonCount > 1 ? "s" : ""}`)}
    </table>

    ${d.docs.expiredCount + d.docs.expiringSoonCount > 0 ? `
      <div style="margin-top:20px;padding:14px;border-left:3px solid ${d.docs.expiredCount > 0 ? "#a53232" : "#d4a017"};background:${d.docs.expiredCount > 0 ? "#fdf3f3" : "#fff9eb"};">
        <p style="margin:0 0 6px;font-weight:600;">Documents — ${d.docs.expiredCount} expiré${d.docs.expiredCount > 1 ? "s" : ""}, ${d.docs.expiringSoonCount} à renouveler</p>
        <ul style="padding-left:20px;line-height:1.7;margin:6px 0 0;">${
          d.docs.topItems.map(it => `<li><strong>${it.workerName}</strong> — ${it.label} ${it.expired ? `<span style="color:#a53232;">(expiré il y a ${Math.abs(it.daysUntilExpiry)}j)</span>` : `<span style="color:#a35a00;">(dans ${it.daysUntilExpiry}j)</span>`}</li>`).join("")
        }</ul>
      </div>
    ` : ""}

    ${d.lateness.topWorkers.length > 0 ? `
      <div style="margin-top:20px;padding:14px;border-left:3px solid #d4a017;background:#fff9eb;">
        <p style="margin:0 0 6px;font-weight:600;">Retards &amp; départs anticipés</p>
        <ul style="padding-left:20px;line-height:1.7;margin:6px 0 0;">${
          d.lateness.topWorkers.map(w => `<li><strong>${w.workerName}</strong> — ${w.incidents} incident${w.incidents > 1 ? "s" : ""}${w.totalLateMinutes > 0 ? ` · retard ${fmtMinutes(w.totalLateMinutes)}` : ""}${w.totalEarlyLeaveMinutes > 0 ? ` · départ anticipé ${fmtMinutes(w.totalEarlyLeaveMinutes)}` : ""}</li>`).join("")
        }</ul>
      </div>
    ` : ""}

    ${d.contracts.endingNextMonth.length > 0 ? `
      <div style="margin-top:20px;padding:14px;border-left:3px solid #d4a017;background:#fff9eb;">
        <p style="margin:0 0 6px;font-weight:600;">Fins de contrat le mois prochain</p>
        <p style="${STYLE.muted};margin:0 0 6px;">Renouveler ou anticiper le remplacement avant la dernière journée.</p>
        <ul style="padding-left:20px;line-height:1.7;margin:6px 0 0;">${
          d.contracts.endingNextMonth.map(c => `<li><strong>${c.workerName}</strong> — ${c.type}, fin le ${c.endDate}</li>`).join("")
        }</ul>
      </div>
    ` : ""}

    ${silaeNotice}

    <p style="margin:28px 0 0;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#888;">Détail par employé</p>
    ${workerTable}

    ${d.leave.expiringSoonCount > 0 ? `
      <div style="margin-top:24px;padding:14px;border-left:3px solid #d4a017;background:#fff9eb;">
        <p style="margin:0 0 6px;font-weight:600;">Soldes CP à poser avant le 31 mai</p>
        <p style="${STYLE.muted};margin:0;">Code du travail L3141-3 · CCN HCR art. 24</p>
        ${expiringList}
      </div>
    ` : ""}

    <p style="${STYLE.muted};margin:24px 0 0;">
      L'export paie complet (HS, CP, repas, détail hebdomadaire) est joint en CSV : <strong>${csvFilename}</strong>
      ${d.includeSilaeInMonthlyDigest && !silaeNotice ? `<br>L'export Silae est joint en CSV : <strong>${silaeFilename}</strong>` : ""}
    </p>

    <p style="text-align:center;padding:24px 0 0;">
      <a href="${loginUrl}" style="${STYLE.button}">Ouvrir Comptoir</a>
    </p>
  `), attachments);
}
