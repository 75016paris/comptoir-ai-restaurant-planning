/**
 * French date resolver — converts natural language date expressions to YYYY-MM-DD.
 * Used by WhatsApp bot tools (admin + worker) to resolve dates server-side
 * so the LLM never calculates dates itself.
 *
 * Handles: relative days (demain, hier, avant-hier, après-demain),
 * day names (lundi–dimanche) with prochain/dernier/ce,
 * week expressions (semaine prochaine/dernière/du 14 avril),
 * month expressions (fin/début du mois, mois prochain),
 * dans N jours/semaines, il y a N jours,
 * French dates (15 avril, 1er janvier 2025), DD/MM, DD/MM/YYYY,
 * "le 15", ISO YYYY-MM-DD.
 */
import { todayInTimeZone } from "@comptoir/shared";

// ── Helpers ──

/** Format Date as YYYY-MM-DD in local timezone (not UTC). */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Monday of the week containing `ref` (defaults to today). */
function monday(ref?: Date): Date {
  const d = new Date(ref || new Date());
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d;
}

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10,
  décembre: 11, decembre: 11,
};

/** Try parsing a French month name, returns 0-11 or undefined. */
function parseMonthName(s: string): number | undefined {
  return FRENCH_MONTHS[s.toLowerCase().replace("û", "u").replace("é", "e")];
}

/** Last day of a given month (1-indexed). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// ── Main resolver ──

/** Resolve French relative date expressions to YYYY-MM-DD. Returns null if unresolvable. */
export function resolveRelativeDate(input: string, opts: { timeZone?: string; now?: Date } = {}): string | null {
  if (!input) return null;
  const lower = input.toLowerCase().trim();
  const today = new Date(`${todayInTimeZone(opts.timeZone, opts.now)}T12:00:00`);

  // ── 1. Direct YYYY-MM-DD ──
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return lower;

  // ── 2. DD/MM/YYYY or DD/MM ──
  const ddmm = lower.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?$/);
  if (ddmm) {
    const day = parseInt(ddmm[1]);
    const month = parseInt(ddmm[2]) - 1; // 0-indexed
    const year = ddmm[3] ? parseInt(ddmm[3]) : today.getFullYear();
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      const d = new Date(year, month, day, 12, 0, 0);
      // If no year given and date is past, assume next year
      if (!ddmm[3] && d < today) d.setFullYear(d.getFullYear() + 1);
      if (!isNaN(d.getTime())) return fmtDate(d);
    }
  }

  // ── 3. "aujourd'hui" / SMS variants / service part today ──
  if (lower.includes("aujourd") || /\bajd\b/.test(lower) || /\bojd\b/.test(lower) || /\bce\s+(?:soir|midi|matin)\b/.test(lower)) return fmtDate(today);

  // ── 4. "avant-hier" (BEFORE "hier" — contains "hier") ──
  if (/avant[- ]?hier/.test(lower)) {
    const d = new Date(today); d.setDate(d.getDate() - 2); return fmtDate(d);
  }

  // ── 5. "hier" ──
  if (lower === "hier" || lower.includes("hier")) {
    const d = new Date(today); d.setDate(d.getDate() - 1); return fmtDate(d);
  }

  // ── 6. "après-demain" (BEFORE "demain" — contains "demain") ──
  if (/apr[èe]s[- ]?demain/.test(lower)) {
    const d = new Date(today); d.setDate(d.getDate() + 2); return fmtDate(d);
  }

  // ── 7. "demain" + SMS variants ──
  if (lower.includes("demain") || /\bdmin\b/.test(lower) || /\bdmain\b/.test(lower) || /\b2min\b/.test(lower) || /\b2main\b/.test(lower)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return fmtDate(d);
  }

  // ── 8. Day names with modifiers ──
  const dayMap: Record<string, number> = {
    lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 0,
  };
  for (const [name, dow] of Object.entries(dayMap)) {
    if (!lower.includes(name)) continue;
    const d = new Date(today);
    const currentDow = d.getDay();
    let diff = dow - currentDow;

    if (lower.includes("dernier") || lower.includes("dernière") || lower.includes("passé")) {
      // "[jour] dernier" → previous occurrence
      if (diff >= 0) diff -= 7;
      d.setDate(d.getDate() + diff);
      return fmtDate(d);
    }

    // "ce [jour]" → this week's occurrence (could be past or future within week)
    const thisWeek = /\bce\b/.test(lower) || /\bcet(?:te)?\b/.test(lower);
    if (thisWeek) {
      // Resolve to this week: if diff < 0, it's earlier this week (past); if diff > 0, later this week
      // If diff === 0, it's today
      d.setDate(d.getDate() + diff);
      return fmtDate(d);
    }

    // "[jour] prochain" or bare day name → next occurrence (strictly future)
    if (lower.includes("prochain") || diff <= 0) {
      if (diff <= 0) diff += 7;
    }
    d.setDate(d.getDate() + diff);
    return fmtDate(d);
  }

  // ── 9. "dans N jours" ──
  const inDays = lower.match(/dans\s+(\d+)\s*jour/);
  if (inDays) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(inDays[1])); return fmtDate(d);
  }

  // ── 10. "dans N semaines" ──
  const inWeeks = lower.match(/dans\s+(\d+)\s*semaine/);
  if (inWeeks) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(inWeeks[1]) * 7); return fmtDate(d);
  }

  // ── 11. "il y a N jours" ──
  const agoD = lower.match(/il\s+y\s+a\s+(\d+)\s*jour/);
  if (agoD) {
    const d = new Date(today); d.setDate(d.getDate() - parseInt(agoD[1])); return fmtDate(d);
  }

  // ── 12. "il y a N semaines" ──
  const agoW = lower.match(/il\s+y\s+a\s+(\d+)\s*semaine/);
  if (agoW) {
    const d = new Date(today); d.setDate(d.getDate() - parseInt(agoW[1]) * 7); return fmtDate(d);
  }

  // ── 13. "semaine du [date]" → Monday of that week ──
  const weekOf = lower.match(/semaine\s+du\s+(\d{1,2})(?:\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre))?(?:\s+(\d{4}))?/);
  if (weekOf) {
    const day = parseInt(weekOf[1]);
    const monthStr = weekOf[2];
    const yearStr = weekOf[3];
    let month = today.getMonth();
    let year = today.getFullYear();
    if (monthStr) {
      const m = parseMonthName(monthStr);
      if (m !== undefined) month = m;
    }
    if (yearStr) year = parseInt(yearStr);
    const ref = new Date(year, month, day, 12, 0, 0);
    if (!isNaN(ref.getTime())) return fmtDate(monday(ref));
  }

  // ── 14. Week-relative: "semaine prochaine", "semaine dernière", "cette semaine" ──
  if (/s[aei]m[aei]+n[e]?\s*proch/i.test(lower)) {
    const mon = monday(); mon.setDate(mon.getDate() + 7); return fmtDate(mon);
  }
  if (/s[aei]m[aei]+n[e]?\s*derni/i.test(lower)) {
    const mon = monday(); mon.setDate(mon.getDate() - 7); return fmtDate(mon);
  }
  if (/cet(?:te)?\s*s[aei]m[aei]+n/i.test(lower) || /la\s+s[aei]m[aei]+n[e]?$/i.test(lower)) {
    return fmtDate(monday());
  }

  // ── 15. Weekend ──
  if (/week-?end\s*proch/i.test(lower)) {
    // "weekend prochain" → next Saturday (skip current weekend if we're in it)
    const d = new Date(today);
    const daysToSat = (6 - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + (daysToSat === 0 ? 7 : daysToSat));
    return fmtDate(d);
  }
  if (/ce\s*week-?end|le\s*week-?end/i.test(lower)) {
    const d = new Date(today);
    const daysToSat = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysToSat);
    return fmtDate(d);
  }

  // ── 16. Month start/end: "fin du mois", "début du mois", "fin avril", "début mai" ──
  // "fin [month]" or "fin du mois"
  const finMonth = lower.match(/fin\s+(?:du\s+mois|(?:de\s+)?(janvier|février|fevrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre))/);
  if (finMonth) {
    let month = today.getMonth();
    let year = today.getFullYear();
    if (finMonth[1]) {
      const m = parseMonthName(finMonth[1]);
      if (m !== undefined) { month = m; if (month < today.getMonth()) year++; }
    }
    const lastDay = lastDayOfMonth(year, month);
    return fmtDate(new Date(year, month, lastDay, 12, 0, 0));
  }
  // "début [month]" or "début du mois"
  const debutMonth = lower.match(/d[ée]but\s+(?:du\s+mois|(?:de\s+)?(janvier|février|fevrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre))/);
  if (debutMonth) {
    let month = today.getMonth();
    let year = today.getFullYear();
    if (debutMonth[1]) {
      const m = parseMonthName(debutMonth[1]);
      if (m !== undefined) { month = m; if (month < today.getMonth()) year++; }
    }
    return fmtDate(new Date(year, month, 1, 12, 0, 0));
  }

  // ── 17. "mois prochain" / "mois dernier" ──
  if (/mois\s*proch/i.test(lower)) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 1, 12, 0, 0);
    return fmtDate(d);
  }
  if (/mois\s*derni/i.test(lower)) {
    const d = new Date(today.getFullYear(), today.getMonth() - 1, 1, 12, 0, 0);
    return fmtDate(d);
  }

  // ── 18. French date patterns: "1er janvier 2025", "15 avril", "5 mars 2026" ──
  const frDateMatch = lower.match(/(\d{1,2})(?:er|ème|e)?\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)(?:\s+(\d{4}))?/);
  if (frDateMatch) {
    const day = parseInt(frDateMatch[1]);
    const monthIdx = parseMonthName(frDateMatch[2]);
    const year = frDateMatch[3]
      ? parseInt(frDateMatch[3])
      : (monthIdx !== undefined && monthIdx < today.getMonth() ? today.getFullYear() + 1 : today.getFullYear());
    if (monthIdx !== undefined && day >= 1 && day <= 31) {
      const d = new Date(year, monthIdx, day, 12, 0, 0);
      if (!isNaN(d.getTime())) return fmtDate(d);
    }
  }

  // ── 19. "le 15" — assume current or next month ──
  const leN = lower.match(/le\s+(\d{1,2})/);
  if (leN) {
    const day = parseInt(leN[1]);
    if (day >= 1 && day <= 31) {
      const d = new Date(today.getFullYear(), today.getMonth(), day, 12, 0, 0);
      if (d < today) d.setMonth(d.getMonth() + 1);
      return fmtDate(d);
    }
  }

  // ── 20. Bare YYYY-MM-DD (already checked at top, safety fallback) ──
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  return null;
}
