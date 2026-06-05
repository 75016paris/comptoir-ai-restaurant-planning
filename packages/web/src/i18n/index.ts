import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import frRoles from "./locales/fr/roles.json";
import enRoles from "./locales/en/roles.json";
import esRoles from "./locales/es/roles.json";
import ptRoles from "./locales/pt/roles.json";

import frCommon from "./locales/fr/common.json";
import enCommon from "./locales/en/common.json";
import esCommon from "./locales/es/common.json";
import ptCommon from "./locales/pt/common.json";

import frStaff from "./locales/fr/staff.json";
import enStaff from "./locales/en/staff.json";
import esStaff from "./locales/es/staff.json";
import ptStaff from "./locales/pt/staff.json";

import frNav from "./locales/fr/nav.json";
import enNav from "./locales/en/nav.json";
import esNav from "./locales/es/nav.json";
import ptNav from "./locales/pt/nav.json";

import frSchedule from "./locales/fr/schedule.json";
import enSchedule from "./locales/en/schedule.json";
import esSchedule from "./locales/es/schedule.json";
import ptSchedule from "./locales/pt/schedule.json";

import frPreferences from "./locales/fr/preferences.json";
import enPreferences from "./locales/en/preferences.json";
import esPreferences from "./locales/es/preferences.json";
import ptPreferences from "./locales/pt/preferences.json";

import frOnboarding from "./locales/fr/onboarding.json";
import enOnboarding from "./locales/en/onboarding.json";
import esOnboarding from "./locales/es/onboarding.json";
import ptOnboarding from "./locales/pt/onboarding.json";

import frHolidays from "./locales/fr/holidays.json";
import enHolidays from "./locales/en/holidays.json";
import esHolidays from "./locales/es/holidays.json";
import ptHolidays from "./locales/pt/holidays.json";

import frHours from "./locales/fr/hours.json";
import enHours from "./locales/en/hours.json";
import esHours from "./locales/es/hours.json";
import ptHours from "./locales/pt/hours.json";

import frAuth from "./locales/fr/auth.json";
import enAuth from "./locales/en/auth.json";
import esAuth from "./locales/es/auth.json";
import ptAuth from "./locales/pt/auth.json";

import frDemo from "./locales/fr/demo.json";
import enDemo from "./locales/en/demo.json";
import esDemo from "./locales/es/demo.json";
import ptDemo from "./locales/pt/demo.json";

import frAudit from "./locales/fr/audit.json";
import enAudit from "./locales/en/audit.json";
import esAudit from "./locales/es/audit.json";
import ptAudit from "./locales/pt/audit.json";

import frOptimize from "./locales/fr/optimize.json";
import enOptimize from "./locales/en/optimize.json";
import esOptimize from "./locales/es/optimize.json";
import ptOptimize from "./locales/pt/optimize.json";

import frObjectif from "./locales/fr/objectif.json";
import enObjectif from "./locales/en/objectif.json";
import esObjectif from "./locales/es/objectif.json";
import ptObjectif from "./locales/pt/objectif.json";

export const SUPPORTED_LOCALES = ["fr", "en", "es", "pt"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "fr",
    supportedLngs: SUPPORTED_LOCALES,
    ns: ["roles", "common", "staff", "nav", "schedule", "preferences", "onboarding", "holidays", "hours", "auth", "demo", "audit", "optimize", "objectif"],
    defaultNS: "common",
    interpolation: { escapeValue: false },
    resources: {
      fr: { roles: frRoles, common: frCommon, staff: frStaff, nav: frNav, schedule: frSchedule, preferences: frPreferences, onboarding: frOnboarding, holidays: frHolidays, hours: frHours, auth: frAuth, demo: frDemo, audit: frAudit, optimize: frOptimize, objectif: frObjectif },
      en: { roles: enRoles, common: enCommon, staff: enStaff, nav: enNav, schedule: enSchedule, preferences: enPreferences, onboarding: enOnboarding, holidays: enHolidays, hours: enHours, auth: enAuth, demo: enDemo, audit: enAudit, optimize: enOptimize, objectif: enObjectif },
      es: { roles: esRoles, common: esCommon, staff: esStaff, nav: esNav, schedule: esSchedule, preferences: esPreferences, onboarding: esOnboarding, holidays: esHolidays, hours: esHours, auth: esAuth, demo: esDemo, audit: esAudit, optimize: esOptimize, objectif: esObjectif },
      pt: { roles: ptRoles, common: ptCommon, staff: ptStaff, nav: ptNav, schedule: ptSchedule, preferences: ptPreferences, onboarding: ptOnboarding, holidays: ptHolidays, hours: ptHours, auth: ptAuth, demo: ptDemo, audit: ptAudit, optimize: ptOptimize, objectif: ptObjectif },
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "comptoir.locale",
    },
  });

export default i18n;
