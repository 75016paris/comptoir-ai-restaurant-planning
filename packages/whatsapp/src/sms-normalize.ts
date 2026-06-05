import { formatLogMessagePreview } from "@comptoir/shared";

/**
 * French SMS speak normalizer — deterministic dictionary-based preprocessing.
 * Runs before the LLM sees the message. Converts common French text speak
 * to proper French so the model can understand restaurant worker messages.
 *
 * Design: word-boundary aware replacements, case-insensitive, no false
 * positives on proper French words or employee names.
 */

type SmsRule = {
  pattern: RegExp;
  replacement: string;
};

// ── Word boundary helper ──
// JS \b treats accented chars (é, è, à, ç...) as non-word chars,
// so "fé" or "congé" won't match with \b. Use custom boundaries.
const B = `(?<![a-zA-ZÀ-ÿ0-9])`; // start boundary (not preceded by letter/digit)
const E = `(?![a-zA-ZÀ-ÿ0-9])`;  // end boundary (not followed by letter/digit)

/** Build case-insensitive word-boundary regex */
function sms(word: string): RegExp {
  return new RegExp(`${B}${word}${E}`, "gi");
}

// ── Compound patterns (multi-word, must run first) ──

const COMPOUND_RULES: SmsRule[] = [
  // "jbosse" / "jboss" / "j'boss" → "je bosse"
  { pattern: new RegExp(`${B}j'?boss[e]?${E}`, "gi"), replacement: "je bosse" },
  // "jsuis" / "j'suis" → "je suis"
  { pattern: new RegExp(`${B}j'?suis${E}`, "gi"), replacement: "je suis" },
  // "jpars" / "j'pars" → "je pars"
  { pattern: new RegExp(`${B}j'?pars${E}`, "gi"), replacement: "je pars" },
  // "jveux" / "j'veux" → "je veux"
  { pattern: new RegExp(`${B}j'?veux${E}`, "gi"), replacement: "je veux" },
  // "jpeux" / "j'peux" → "je peux"
  { pattern: new RegExp(`${B}j'?peux${E}`, "gi"), replacement: "je peux" },
  // "dheures" / "dheure" → "d'heures" / "d'heure"
  { pattern: sms("dheure"), replacement: "d'heure" },
  { pattern: sms("dheures"), replacement: "d'heures" },
  // "il y a" forms: "ya" at start or after space
  { pattern: sms("ya"), replacement: "il y a" },
  // "c'est" forms
  { pattern: sms("cé"), replacement: "c'est" },
  // "aujourd'hui" forms
  { pattern: sms("ojd"), replacement: "aujourd'hui" },
  { pattern: sms("ajd"), replacement: "aujourd'hui" },
  // "je pose [date]" → "je pose congé [date]" — only when not already followed by "congé"
  { pattern: new RegExp(`${B}je\\s+pose(?!\\s*cong)${E}`, "gi"), replacement: "je pose congé" },
];

// ── Single word replacements ──
// Sorted longest-first to avoid substring clashes

const WORD_RULES: SmsRule[] = [
  // Date/time
  { pattern: sms("2main"), replacement: "demain" },
  { pattern: sms("2min"), replacement: "demain" },
  { pattern: sms("2m1"), replacement: "demain" },
  { pattern: sms("dm1"), replacement: "demain" },
  // "semaine" variants
  { pattern: sms("samine"), replacement: "semaine" },
  { pattern: sms("samaine"), replacement: "semaine" },
  // "prochaine" variants
  { pattern: sms("prochene"), replacement: "prochaine" },
  // "attente" variants
  { pattern: sms("atant"), replacement: "attente" },
  { pattern: sms("atan"), replacement: "attente" },
  // "planning" variants
  { pattern: sms("planing"), replacement: "planning" },
  // Verbs
  { pattern: sms("travay"), replacement: "travaille" },
  // Questions — only misspellings, NOT correct French
  { pattern: sms("combian"), replacement: "combien" },
  { pattern: sms("conbien"), replacement: "combien" },
  // Common abbreviations
  { pattern: sms("cb"), replacement: "combien" },
  { pattern: sms("pr"), replacement: "pour" },
  { pattern: sms("ki"), replacement: "qui" },
  { pattern: sms("kel"), replacement: "quel" },
  { pattern: sms("kan"), replacement: "quand" },
  // "congé" variants
  { pattern: sms("conger"), replacement: "congé" },
  { pattern: sms("conge"), replacement: "congé" },
  // "temps" / "fait"
  { pattern: sms("tan"), replacement: "temps" },
  { pattern: sms("fé"), replacement: "fait" },
  // "mets" (as in "mets Dujardin en soir") — only before a capital or name-like word
  { pattern: new RegExp(`${B}met(?=\\s+[A-Z])`, "g"), replacement: "mets" },
  // Common filler
  { pattern: sms("svp"), replacement: "s'il vous plaît" },
  { pattern: sms("stp"), replacement: "s'il te plaît" },
  { pattern: sms("tkt"), replacement: "t'inquiète" },
  { pattern: sms("bcp"), replacement: "beaucoup" },
  { pattern: sms("pk"), replacement: "pourquoi" },
  { pattern: sms("dsl"), replacement: "désolé" },
  // Numbers as letters
  { pattern: /\b1\b(?=\s+(?:service|congé|semaine|jour))/gi, replacement: "un" },
];

/**
 * Normalize French SMS speak to proper French.
 * Returns the original text unchanged if no substitutions match.
 */
export function normalizeSms(text: string): string {
  let result = text;

  // Apply compound rules first (multi-word expansions)
  for (const rule of COMPOUND_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // Apply single word rules
  for (const rule of WORD_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // Log if we changed anything
  if (result !== text) {
    console.error(`  [sms] ${formatLogMessagePreview(text)} → ${formatLogMessagePreview(result)}`);
  }

  return result;
}
