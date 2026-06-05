import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { ApiError, api, type AdminPreferences, type ColorScheme, type ServiceTemplate, type StaffingTarget, type StaffingProfile, type StaffingWeekAssignment, type ProfileServiceTemplate, type ComplianceRuleMeta, type BillingInfo, type ActiveEmployeesInfo, type RestaurantClosure, type WeightsPreview, type WeightsPreviewSide, type ShareableWorker, type WorkerShareAuthorization } from "@/lib/api";
import { DIMENSION_META, GROUP_LABELS, POSITIVE_LEVEL_LABELS, NEGATIVE_LEVEL_LABELS, resolvePreset, inferLevels, type TunableDimension, type SemanticLevel } from "@comptoir/shared";
import { Calendar } from "@/components/ui/calendar";
import type { DateRange } from "react-day-picker";
import { fmtDateShort, parseDate, toISO } from "@/lib/date-utils";
import { useAuth } from "@/hooks/use-auth";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ALL_PALETTE_KEYS, PALETTE_NAMES, getPalette, setColorPalettes } from "@/lib/colors";
import { cn, formatPhone, errorMessage } from "@/lib/utils";
import { X, ChevronRight, ChevronDown, ExternalLink, Loader2, FlaskConical } from "lucide-react";
import { EmailRecipientsSection } from "@/components/email-recipients-section";
import { UnderlineNav } from "@/components/underline-nav";
import { AuditLogPage } from "@/pages/admin/audit-log";
import { HCR_LEVELS, HCR_LEVEL_LABELS, HCR_GRID_2026, DEFAULT_SUBROLE_TO_HCR, type HcrLevel } from "@comptoir/shared/hcr";
import { LEGAL_LINKS } from "@comptoir/shared/legal";
import { DEFAULT_CONTRACT_HOURS, DEFAULT_CONTRACT_TYPE } from "@comptoir/shared";

const labelClass = "text-[length:var(--text-sm)] uppercase tracking-wide font-extrabold text-foreground";
const fieldLabelClass = "text-[length:var(--text-xs)] uppercase tracking-widest font-semibold text-muted-foreground";

// crypto.randomUUID() requires secure context (HTTPS/localhost).
// Fallback for LAN/HTTP access.
function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

type ReminderFrequency = AdminPreferences["reminderFrequency"];
const REMINDER_OPTIONS: { value: ReminderFrequency; labelKey: string }[] = [
  { value: "off", labelKey: "preferences:reminderOptions.off" },
  { value: "daily", labelKey: "preferences:reminderOptions.daily" },
  { value: "weekly", labelKey: "preferences:reminderOptions.weekly" },
];

const SILAE_CODE_FIELDS = [
  "heuresNormales",
  "hs110",
  "hs120",
  "hs150",
  "repas",
  "congesPayes",
  "maladie",
] as const;

const DAY_LABEL_KEYS = [
  "preferences:days.monShort",
  "preferences:days.tueShort",
  "preferences:days.wedShort",
  "preferences:days.thuShort",
  "preferences:days.friShort",
  "preferences:days.satShort",
  "preferences:days.sunShort",
];

// ── Service group model ──

type DayTimeOverride = {
  kitchen?: { start: string; end: string };
  floor?: { start: string; end: string };
};

type TimeRange = { start: string; end: string };

type ServiceGroup = {
  label: string;
  sortOrder: number;
  kitchen: TimeRange;
  floor: TimeRange;
  // Coupure: second time range (evening half)
  kitchen2?: TimeRange;
  floor2?: TimeRange;
  dayOverrides?: Record<number, DayTimeOverride>; // 1=Mon...7=Sun
};

function serviceGroupsFromTemplates(templates: ServiceTemplate[]): ServiceGroup[] {
  // Group by sortOrder (not zone label) so duplicate labels don't merge
  const groupMap = new Map<number, ServiceGroup>();
  for (const t of templates) {
    const key = t.sortOrder ?? 0;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        label: t.zone,
        sortOrder: key,
        kitchen: { start: "", end: "" },
        floor: { start: "", end: "" },
      });
    }
    const g = groupMap.get(key)!;
    if (t.role === "kitchen") {
      if (g.kitchen.start) {
        // Second template for same role → coupure evening half
        if (t.startTime > g.kitchen.start) {
          g.kitchen2 = { start: t.startTime, end: t.endTime };
        } else {
          g.kitchen2 = { ...g.kitchen };
          g.kitchen = { start: t.startTime, end: t.endTime };
        }
      } else {
        g.kitchen = { start: t.startTime, end: t.endTime };
      }
    } else {
      if (g.floor.start) {
        if (t.startTime > g.floor.start) {
          g.floor2 = { start: t.startTime, end: t.endTime };
        } else {
          g.floor2 = { ...g.floor };
          g.floor = { start: t.startTime, end: t.endTime };
        }
      } else {
        g.floor = { start: t.startTime, end: t.endTime };
      }
    }
    // Merge per-day overrides
    if (t.overrides && t.overrides.length > 0) {
      if (!g.dayOverrides) g.dayOverrides = {};
      for (const o of t.overrides) {
        if (!g.dayOverrides[o.dayOfWeek]) g.dayOverrides[o.dayOfWeek] = {};
        if (t.role === "kitchen") {
          g.dayOverrides[o.dayOfWeek].kitchen = { start: o.startTime, end: o.endTime };
        } else {
          g.dayOverrides[o.dayOfWeek].floor = { start: o.startTime, end: o.endTime };
        }
      }
    }
  }
  // If one role is missing, copy from the other
  for (const g of groupMap.values()) {
    if (!g.kitchen.start && g.floor.start) {
      g.kitchen = { ...g.floor };
    } else if (!g.floor.start && g.kitchen.start) {
      g.floor = { ...g.kitchen };
    }
  }
  // Sort by earliest start time (kitchen or salle), earliest first
  return Array.from(groupMap.values()).sort((a, b) => {
    const aStart = [a.kitchen.start, a.floor.start].filter(Boolean).sort()[0] || "99:99";
    const bStart = [b.kitchen.start, b.floor.start].filter(Boolean).sort()[0] || "99:99";
    return aStart.localeCompare(bStart);
  });
}

/** Check if a service group has all required times filled */
function isServiceGroupValid(g: ServiceGroup): boolean {
  const base = !!(g.label.trim() && g.kitchen.start && g.kitchen.end && g.floor.start && g.floor.end);
  if (!base) return false;
  // If coupure, both halves must be complete
  if (g.kitchen2 && (!g.kitchen2.start || !g.kitchen2.end)) return false;
  if (g.floor2 && (!g.floor2.start || !g.floor2.end)) return false;
  return true;
}

function serviceGroupsToTemplates(groups: ServiceGroup[]): ServiceTemplate[] {
  // Sort valid groups by earliest start time, then assign sortOrder
  const valid = groups.filter(isServiceGroupValid);
  const sorted = [...valid].sort((a, b) => {
    const aStart = [a.kitchen.start, a.floor.start].filter(Boolean).sort()[0] || "99:99";
    const bStart = [b.kitchen.start, b.floor.start].filter(Boolean).sort()[0] || "99:99";
    return aStart.localeCompare(bStart);
  });
  return sorted.flatMap((g, i) => {
    const kitchenOverrides: { dayOfWeek: number; startTime: string; endTime: string }[] = [];
    const salleOverrides: { dayOfWeek: number; startTime: string; endTime: string }[] = [];
    if (g.dayOverrides) {
      for (const [dow, ov] of Object.entries(g.dayOverrides)) {
        if (ov.kitchen?.start && ov.kitchen?.end) {
          kitchenOverrides.push({ dayOfWeek: Number(dow), startTime: ov.kitchen.start, endTime: ov.kitchen.end });
        }
        if (ov.floor?.start && ov.floor?.end) {
          salleOverrides.push({ dayOfWeek: Number(dow), startTime: ov.floor.start, endTime: ov.floor.end });
        }
      }
    }
    const templates = [
      { role: "kitchen" as const, zone: g.label.trim(), startTime: g.kitchen.start, endTime: g.kitchen.end, sortOrder: i + 1, overrides: kitchenOverrides.length > 0 ? kitchenOverrides : undefined },
      { role: "floor" as const, zone: g.label.trim(), startTime: g.floor.start, endTime: g.floor.end, sortOrder: i + 1, overrides: salleOverrides.length > 0 ? salleOverrides : undefined },
    ];
    // Coupure: emit evening halves with same sortOrder
    if (g.kitchen2?.start && g.kitchen2?.end) {
      templates.push({ role: "kitchen" as const, zone: g.label.trim(), startTime: g.kitchen2.start, endTime: g.kitchen2.end, sortOrder: i + 1, overrides: undefined });
    }
    if (g.floor2?.start && g.floor2?.end) {
      templates.push({ role: "floor" as const, zone: g.label.trim(), startTime: g.floor2.start, endTime: g.floor2.end, sortOrder: i + 1, overrides: undefined });
    }
    return templates;
  });
}

// Generate staffing grid rows from service groups
type StaffingZoneGroup = {
  zone: string;
  label: string; // uppercase zone name
  kitchenTimes: string; // "06:00-15:30"
  floorTimes: string; // "07:00-15:00"
  rows: Array<{ label: string; role: "kitchen" | "floor"; zone: string }>;
};

function fmtTimes(t1: TimeRange, t2?: TimeRange): string {
  if (!t1.start || !t1.end) return "";
  const base = `${t1.start}-${t1.end}`;
  if (t2?.start && t2?.end) return `${base} + ${t2.start}-${t2.end}`;
  return base;
}

function staffingZoneGroups(
  groups: ServiceGroup[],
  labels: { kitchen: string; floor: string },
): StaffingZoneGroup[] {
  return groups.map((g) => ({
    zone: g.label,
    label: g.label.toUpperCase(),
    kitchenTimes: fmtTimes(g.kitchen, g.kitchen2),
    floorTimes: fmtTimes(g.floor, g.floor2),
    rows: [
      { label: labels.kitchen, role: "kitchen" as const, zone: g.label },
      { label: labels.floor, role: "floor" as const, zone: g.label },
    ],
  }));
}



function WeightSlidersSection({
  presetName,
  customWeights,
  onChange,
  workerPreferencesEnabled,
}: {
  presetName: AdminPreferences["preferredStyle"];
  customWeights: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  workerPreferencesEnabled: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<WeightsPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Dual-preset comparison state
  const [sideAPreset, setSideAPreset] = useState<AdminPreferences["preferredStyle"]>("equilibre");
  const [sideAWithCustom, setSideAWithCustom] = useState(false);
  const [sideBPreset, setSideBPreset] = useState<AdminPreferences["preferredStyle"]>(presetName);
  const [sideBWithCustom, setSideBWithCustom] = useState(true);
  const [numWeeks, setNumWeeks] = useState<number>(4);

  async function runPreview() {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const sideA: WeightsPreviewSide = {
        preset: sideAPreset,
        customWeights: sideAWithCustom ? customWeights : {},
      };
      const sideB: WeightsPreviewSide = {
        preset: sideBPreset,
        customWeights: sideBWithCustom ? customWeights : {},
      };
      const res = await api.previewWeights(sideA, sideB, { numWeeks });
      setPreview(res.data);
    } catch (e) {
      setPreviewError(errorMessage(e));
    } finally {
      setPreviewLoading(false);
    }
  }

  const presetLabels: Record<AdminPreferences["preferredStyle"], string> = {
    "equilibre": t("preferences:styleLabels.equilibre"),
    "equipe-stable": t("preferences:styleLabels.equipe-stable"),
    "economique": t("preferences:styleLabels.economique"),
    "resilience": t("preferences:styleLabels.resilience"),
  };

  const hasAnyCustom = Object.keys(customWeights).length > 0;
  // Preset-derived default levels (the "anchor" before custom overrides)
  const presetLevels = inferLevels(resolvePreset(presetName));
  // Effective level per dimension: custom wins, else preset
  const levelOf = (key: TunableDimension): SemanticLevel => {
    const custom = customWeights[key];
    if (typeof custom === "number" && custom >= 0 && custom <= 4) return custom as SemanticLevel;
    return presetLevels[key];
  };

  const hasOverrides = Object.keys(customWeights).length > 0;
  const divergedCount = (Object.keys(customWeights) as TunableDimension[])
    .filter(k => customWeights[k] !== presetLevels[k]).length;

  function setLevel(key: TunableDimension, level: SemanticLevel) {
    const next = { ...customWeights };
    // If user drags back to preset level, drop the override (keeps "revenir au préréglage" clean)
    if (level === presetLevels[key]) delete next[key];
    else next[key] = level;
    onChange(next);
  }

  function resetAll() {
    onChange({});
  }

  // Group dimensions for rendering
  const grouped = new Map<string, typeof DIMENSION_META[number][]>();
  for (const dim of DIMENSION_META) {
    if (!grouped.has(dim.group)) grouped.set(dim.group, []);
    grouped.get(dim.group)!.push(dim);
  }

  return (
    <div className="space-y-[var(--space-xs)]">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-[var(--space-xs)] group"
        >
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
          <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("preferences:weights.fineTuneToggle")}</span>
          {hasOverrides && (
            <span className="text-[length:var(--text-xs)] px-[var(--space-xs)] py-[1px] rounded-[0.2rem] bg-amber-500/15 text-amber-700 dark:text-amber-400 font-bold">
              {t("preferences:weights.modifiedBadge", { count: divergedCount })}
            </span>
          )}
        </button>
        {hasOverrides && expanded && (
          <button
            type="button"
            onClick={resetAll}
            className="text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("preferences:weights.resetToPreset")}
          </button>
        )}
      </div>
      {!expanded ? (
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("preferences:weights.summary")}
          {hasOverrides ? t("preferences:weights.summaryAdjusted", { count: divergedCount }) : ""}
        </p>
      ) : (
        <div className="space-y-[var(--space-md)] border border-foreground/10 rounded-[0.2rem] p-[var(--space-md)]">
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            <Trans
              i18nKey="preferences:weights.presetIntro"
              values={{ preset: presetName }}
              components={{ bold: <span className="font-bold" /> }}
            />
          </p>
          <p className="text-[length:var(--text-xs)] text-muted-foreground italic">
            <Trans
              i18nKey="preferences:weights.effectExplanation"
              components={{
                b1: <span className="font-bold" />,
                b2: <span className="font-bold" />,
                b3: <span className="font-bold" />,
                b4: <span className="font-bold" />,
                b5: <span className="font-bold" />,
                b6: <span className="font-bold" />,
                b7: <span className="font-bold" />,
                b8: <span className="font-bold" />,
                b9: <span className="font-bold" />,
                b10: <span className="font-bold" />,
              }}
            />
          </p>
          {[...grouped.entries()].map(([groupKey, dims]) => (
            <div key={groupKey} className="space-y-[var(--space-xs)]">
              <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-muted-foreground">
                {GROUP_LABELS[groupKey as keyof typeof GROUP_LABELS]}
              </p>
              <div className="space-y-[var(--space-sm)]">
                {dims.filter(dim => dim.key !== "preference" || workerPreferencesEnabled).map(dim => {
                  const labels = dim.direction === "positive" ? POSITIVE_LEVEL_LABELS : NEGATIVE_LEVEL_LABELS;
                  const lvl = levelOf(dim.key);
                  const presetLvl = presetLevels[dim.key];
                  const isOverride = customWeights[dim.key] !== undefined;
                  // Position of the preset-anchor tick (0%..100% across the slider track)
                  const presetPct = (presetLvl / 4) * 100;
                  return (
                    <div key={dim.key} className="space-y-[2px]">
                      <div className="flex items-start justify-between gap-[var(--space-sm)]">
                        <div className="flex-1">
                          <span className="text-[length:var(--text-xs)] font-bold">{dim.label}</span>
                          {isOverride && (
                            <span className="ml-[var(--space-xs)] text-[length:var(--text-xs)] text-amber-700 dark:text-amber-400">•</span>
                          )}
                          <p className="text-[length:var(--text-xs)] text-muted-foreground">{dim.description}</p>
                        </div>
                        <span className="text-[length:var(--text-xs)] font-bold tracking-wide whitespace-nowrap">{labels[lvl]}</span>
                      </div>
                      <div className="relative py-[var(--space-xs)]">
                        {/* preset-anchor tick: shows where the base preset sits */}
                        <span
                          aria-hidden
                          title={t("preferences:weights.presetTickTitle", { label: labels[presetLvl] })}
                          className="absolute top-1/2 -translate-y-1/2 w-[2px] h-[10px] bg-foreground/40 pointer-events-none"
                          style={{ left: `calc(${presetPct}% - 1px)` }}
                        />
                        <input
                          type="range"
                          min={0}
                          max={4}
                          step={1}
                          value={lvl}
                          onChange={(e) => setLevel(dim.key, Number(e.target.value) as SemanticLevel)}
                          title={labels[lvl]}
                          className="w-full accent-foreground cursor-pointer"
                        />
                      </div>
                      <div className="flex justify-between text-[length:var(--text-xs)] text-muted-foreground">
                        <span>{labels[0]}</span>
                        <span>{labels[4]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {/* Comparateur — side-by-side preset comparison with multi-week solve */}
          <div className="pt-[var(--space-sm)] border-t border-foreground/10 space-y-[var(--space-sm)]">
            <div className="flex items-center justify-between">
              <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-muted-foreground">
                {t("preferences:weights.compareTitle")}
              </span>
              <div className="flex items-center gap-[var(--space-xs)]">
                <label className="text-[length:var(--text-xs)] text-muted-foreground">
                  {t("preferences:weights.weeksLabel")}
                  <select
                    value={numWeeks}
                    onChange={(e) => setNumWeeks(Number(e.target.value))}
                    className="ml-[var(--space-xs)] text-[length:var(--text-xs)] font-bold bg-transparent border border-foreground/20 rounded-[0.2rem] px-[var(--space-xs)] py-[1px] text-foreground"
                  >
                    {[1, 2, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={previewLoading}
                  className={cn(
                    "flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)] font-bold px-[var(--space-sm)] py-[2px] rounded-[0.2rem] border transition-colors",
                    previewLoading
                      ? "border-foreground/20 text-muted-foreground"
                      : "border-foreground/40 hover:bg-foreground hover:text-background",
                  )}
                >
                  {previewLoading ? <Loader2 className="size-3 animate-spin" /> : <FlaskConical className="size-3" />}
                  {previewLoading ? t("preferences:weights.solverButton") : t("preferences:weights.testButton")}
                </button>
              </div>
            </div>
            <p className="text-[length:var(--text-xs)] text-muted-foreground">
              {t("preferences:weights.compareIntro", { count: numWeeks })}
            </p>

            <div className="grid grid-cols-2 gap-[var(--space-sm)]">
              {([
                { side: "A" as const, preset: sideAPreset, setPreset: setSideAPreset, withCustom: sideAWithCustom, setWithCustom: setSideAWithCustom },
                { side: "B" as const, preset: sideBPreset, setPreset: setSideBPreset, withCustom: sideBWithCustom, setWithCustom: setSideBWithCustom },
              ]).map(({ side, preset, setPreset, withCustom, setWithCustom }) => (
                <div key={side} className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)] space-y-[var(--space-xs)]">
                  <p className="text-[length:var(--text-xs)] font-bold tracking-wide">{t("preferences:weights.configLabel", { side })}</p>
                  <select
                    value={preset}
                    onChange={(e) => setPreset(e.target.value as AdminPreferences["preferredStyle"])}
                    className="w-full text-[length:var(--text-xs)] font-bold bg-transparent border border-foreground/20 rounded-[0.2rem] px-[var(--space-sm)] py-[2px] text-foreground"
                  >
                    {(Object.keys(presetLabels) as Array<AdminPreferences["preferredStyle"]>).map(p => (
                      <option key={p} value={p}>{presetLabels[p]}</option>
                    ))}
                  </select>
                  <label className={cn("flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)]", !hasAnyCustom && "text-muted-foreground/50")}>
                    <input
                      type="checkbox"
                      checked={withCustom && hasAnyCustom}
                      disabled={!hasAnyCustom}
                      onChange={(e) => setWithCustom(e.target.checked)}
                    />
                    {t("preferences:weights.withCustom")}
                  </label>
                </div>
              ))}
            </div>

            {previewError && (
              <p className="text-[length:var(--text-xs)] text-rose-600 dark:text-rose-400">{previewError}</p>
            )}

            {preview && !previewLoading && (
              <div className="space-y-[var(--space-xs)] border-t border-foreground/10 pt-[var(--space-sm)]">
                <div className="grid grid-cols-2 gap-[var(--space-sm)] text-[length:var(--text-xs)]">
                  <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)]">
                    <p className="font-bold tracking-wide text-muted-foreground">A · {presetLabels[sideAPreset]}{sideAWithCustom && hasAnyCustom ? t("preferences:weights.withCustomSuffix") : ""}</p>
                    <p>{t("preferences:weights.fillStats", { kitchen: preview.configA.kitchenFillPct, floor: preview.configA.salleFillPct })}</p>
                    <p className="text-muted-foreground">
                      {t("preferences:weights.hourStats", { total: preview.configA.totalHours, ot: preview.configA.otHours, mismatch: preview.configA.subRoleMismatch })}
                    </p>
                  </div>
                  <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)]">
                    <p className="font-bold tracking-wide text-muted-foreground">B · {presetLabels[sideBPreset]}{sideBWithCustom && hasAnyCustom ? t("preferences:weights.withCustomSuffix") : ""}</p>
                    <p>{t("preferences:weights.fillStats", { kitchen: preview.configB.kitchenFillPct, floor: preview.configB.salleFillPct })}</p>
                    <p className="text-muted-foreground">
                      {t("preferences:weights.hourStats", { total: preview.configB.totalHours, ot: preview.configB.otHours, mismatch: preview.configB.subRoleMismatch })}
                    </p>
                  </div>
                </div>
                <p className="text-[length:var(--text-xs)]">
                  <span className="font-bold">
                    {preview.jaccard >= 0.98 ? t("preferences:weights.diffIdentical") :
                     preview.jaccard >= 0.85 ? t("preferences:weights.diffAffected", { count: preview.changedWorkerCount }) :
                     preview.jaccard >= 0.6 ? t("preferences:weights.diffVeryDifferent", { count: preview.changedWorkerCount }) :
                     t("preferences:weights.diffDrastic", { count: preview.changedWorkerCount, slots: preview.totalAssignmentsChanged })}
                  </span>
                  {t("preferences:weights.similaritySuffix", { pct: (preview.jaccard * 100).toFixed(0), count: preview.numWeeks })}
                </p>
                {preview.sampleChanges.length > 0 && (
                  <div className="space-y-[2px]">
                    <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-muted-foreground">
                      {t("preferences:weights.mostAffected")}
                    </p>
                    {preview.sampleChanges.map((ch) => {
                      const dayLowerKeys = ["", "preferences:days.monLower", "preferences:days.tueLower", "preferences:days.wedLower", "preferences:days.thuLower", "preferences:days.friLower", "preferences:days.satLower", "preferences:days.sunLower"];
                      const fmtSlot = (s: { dayOfWeek: number; role: "kitchen" | "floor"; zone: string }) => `${t(dayLowerKeys[s.dayOfWeek])} ${s.role === "kitchen" ? t("preferences:weights.fmtSlotKitchen") : t("preferences:weights.fmtSlotFloor")} ${s.zone}`;
                      const deltaColor = ch.hoursDelta > 0 ? "text-emerald-600 dark:text-emerald-400" : ch.hoursDelta < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground";
                      return (
                        <div key={ch.workerId} className="text-[length:var(--text-xs)] border border-foreground/5 rounded-[0.2rem] p-[var(--space-xs)]">
                          <div className="flex items-center justify-between">
                            <span className="font-bold">{ch.workerName}</span>
                            {ch.hoursDelta !== 0 && (
                              <span className={cn("font-bold", deltaColor)}>
                                {ch.hoursDelta > 0 ? "+" : ""}{ch.hoursDelta.toFixed(1)}h
                              </span>
                            )}
                          </div>
                          {ch.slotsRemoved.length > 0 && (
                            <div className="text-muted-foreground">− {ch.slotsRemoved.map(fmtSlot).join(", ")}</div>
                          )}
                          {ch.slotsAdded.length > 0 && (
                            <div>+ {ch.slotsAdded.map(fmtSlot).join(", ")}</div>
                          )}
                        </div>
                      );
                    })}
                    {preview.changedWorkerCount > preview.sampleChanges.length && (
                      <p className="text-[length:var(--text-xs)] text-muted-foreground">
                        {t("preferences:weights.moreOthers", { count: preview.changedWorkerCount - preview.sampleChanges.length })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<boolean | null>(null);
  const display = hovered ?? value;
  return (
    <div className="space-y-[2px]">
      <div className="flex items-center gap-[var(--space-sm)]">
        <span className="text-[length:var(--text-sm)] font-bold shrink-0">{label}</span>
        <span className="flex-1 border-b border-dotted border-foreground/20" />
        <div className="flex gap-[3px]">
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              onClick={() => onChange(v)}
              onMouseEnter={() => setHovered(v)}
              onMouseLeave={() => setHovered(null)}
              className={`text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border transition-colors ${
                display === v
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted-foreground border-foreground/20"
              }`}
            >
              {v ? t("preferences:toggles.on") : t("preferences:toggles.off")}
            </button>
          ))}
        </div>
      </div>
      {description && (
        <p className="text-[length:var(--text-xs)] text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

function ReminderSelector({
  value,
  onChange,
}: {
  value: ReminderFrequency;
  onChange: (v: ReminderFrequency) => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<ReminderFrequency | null>(null);
  const display = hovered ?? value;
  return (
    <div className="space-y-[2px]">
      <div className="flex items-center gap-[var(--space-sm)]">
        <span className="text-[length:var(--text-sm)] font-bold shrink-0">{t("preferences:reminders.label")}</span>
        <span className="flex-1 border-b border-dotted border-foreground/20" />
        <div className="flex gap-[3px]">
          {REMINDER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              onMouseEnter={() => setHovered(opt.value)}
              onMouseLeave={() => setHovered(null)}
              className={`text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border transition-colors ${
                display === opt.value
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted-foreground border-foreground/20"
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-[2px] text-[length:var(--text-xs)] text-muted-foreground">
        <p>{t("preferences:reminders.description")}</p>
        <p><span className="font-bold text-foreground">{t("preferences:reminderOptions.daily")}</span> = {t("preferences:reminders.dailyExplanation")}</p>
        <p><span className="font-bold text-foreground">{t("preferences:reminderOptions.weekly")}</span> = {t("preferences:reminders.weeklyExplanation")}</p>
      </div>
    </div>
  );
}

function PalettePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-[var(--space-xs)]">
      <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-[6px]">
        {ALL_PALETTE_KEYS.map((key) => {
          const pal = getPalette(key);
          const active = value === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              className={cn(
                "flex flex-col items-center gap-[2px] rounded-[0.25rem] border p-[6px] transition-colors w-[72px]",
                active ? "border-foreground ring-2 ring-foreground/20" : "border-foreground/15 hover:border-foreground/40"
              )}
            >
              <div className="flex gap-[2px]">
                <div className={cn("w-5 h-4 rounded-[2px] border", pal.label.bg, pal.label.border)} />
                <div className={cn("w-5 h-4 rounded-[2px] border", pal.chef[0].bg, pal.chef[0].border)} />
                <div className={cn("w-5 h-4 rounded-[2px] border", pal.worker[0].bg, pal.worker[0].border)} />
              </div>
              <span className={cn("text-[length:var(--text-2xs)] font-bold", active ? "text-foreground" : "text-muted-foreground")}>
                {PALETTE_NAMES[key]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const STATUS_LABEL_KEYS: Record<string, { labelKey: string; color: string }> = {
  active: { labelKey: "preferences:billing.statusActive", color: "text-green-600 dark:text-green-400" },
  trialing: { labelKey: "preferences:billing.statusTrial", color: "text-blue-600 dark:text-blue-400" },
  past_due: { labelKey: "preferences:billing.statusPastDue", color: "text-amber-600 dark:text-amber-400" },
  cancelled: { labelKey: "preferences:billing.statusCancelled", color: "text-red-600 dark:text-red-400" },
  unpaid: { labelKey: "preferences:billing.statusUnpaid", color: "text-red-600 dark:text-red-400" },
};

function BillingSection() {
  const { t, i18n } = useTranslation();
  const [portalLoading, setPortalLoading] = useState(false);
  const [resubLoading, setResubLoading] = useState(false);

  const billingQuery = useQuery({
    queryKey: qk.billing.summary(),
    queryFn: async () => (await api.getBilling()).data,
  });
  const activeQuery = useQuery({
    queryKey: qk.billing.activeEmployees(),
    queryFn: async () => (await api.getActiveEmployees()).data,
  });
  const billing: BillingInfo | null = billingQuery.data ?? null;
  const activeInfo: ActiveEmployeesInfo | null = activeQuery.data ?? null;
  const loading = billingQuery.isPending || activeQuery.isPending;

  const openPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await api.createBillingPortal();
      window.location.href = res.data.url;
    } catch {
      toast.error(t("preferences:billing.portalError"));
    } finally {
      setPortalLoading(false);
    }
  };

  const resubscribe = async () => {
    setResubLoading(true);
    try {
      const res = await api.resubscribe();
      window.location.href = res.data.url;
    } catch {
      toast.error(t("preferences:billing.resubscribeError"));
    } finally {
      setResubLoading(false);
    }
  };

  if (loading) return null;

  // No Stripe = dev mode, skip section
  if (!billing?.stripeCustomerId) {
    return (
      <div className="-mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] space-y-[var(--space-xs)]">
        <p className={labelClass}>{t("preferences:billing.title")}</p>
        <p className="text-[length:var(--text-sm)] text-muted-foreground">
          {t("preferences:billing.devMode")}
        </p>
      </div>
    );
  }

  const status = STATUS_LABEL_KEYS[billing.subscriptionStatus] || STATUS_LABEL_KEYS.active;
  const dateLocale = i18n.language === "pt" ? "pt-PT" : i18n.language === "es" ? "es-ES" : i18n.language === "en" ? "en-GB" : "fr-FR";
  const periodEnd = billing.subscriptionPeriodEnd
    ? new Date(billing.subscriptionPeriodEnd).toLocaleDateString(dateLocale, { day: "numeric", month: "long", year: "numeric" })
    : null;
  const trialEnd = billing.trialEndsAt
    ? new Date(billing.trialEndsAt).toLocaleDateString(dateLocale, { day: "numeric", month: "long", year: "numeric" })
    : null;

  return (
    <div className="-mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] space-y-[var(--space-md)]">
      <p className={labelClass}>{t("preferences:billing.title")}</p>

      <div className="space-y-[var(--space-sm)]">
        <div className="flex items-center gap-[var(--space-sm)]">
          <span className="text-[length:var(--text-sm)] font-medium">{t("preferences:billing.productName")}</span>
          <span className={cn("text-[length:var(--text-xs)] font-bold uppercase tracking-widest", status.color)}>
            {t(status.labelKey)}
          </span>
        </div>

        <div className="text-[length:var(--text-sm)] text-muted-foreground space-y-[var(--space-xs)]">
          <p>{t("preferences:billing.pricing")}</p>
          {billing.subscriptionStatus === "trialing" && trialEnd && (
            <p>{t("preferences:billing.trialEnds", { date: trialEnd })}</p>
          )}
          {billing.subscriptionStatus !== "trialing" && periodEnd && (
            <p>{t("preferences:billing.renewsOn", { date: periodEnd })}</p>
          )}
          {billing.subscriptionStatus === "past_due" && (
            <p className="text-amber-600 dark:text-amber-400 font-medium">
              {t("preferences:billing.pastDueWarning")}
            </p>
          )}
          {billing.cancelAt && billing.subscriptionStatus !== "cancelled" && (
            <p className="text-amber-600 dark:text-amber-400 font-medium">
              {t("preferences:billing.cancelScheduled", { date: new Date(billing.cancelAt).toLocaleDateString(dateLocale, { day: "numeric", month: "long", year: "numeric" }) })}
            </p>
          )}
          {billing.subscriptionStatus === "cancelled" && (
            <p className="text-red-600 dark:text-red-400 font-medium">
              {t("preferences:billing.cancelled")}
            </p>
          )}
        </div>

        {activeInfo && (
          <div className="p-[var(--space-md)] border border-foreground/10 space-y-[var(--space-xs)]">
            <div className="flex items-baseline justify-between">
              <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground">
                {t("preferences:billing.monthEstimate", { month: new Date().toLocaleDateString(dateLocale, { month: "long" }) })}
              </span>
              <span className="text-[length:var(--text-sm)] font-bold">
                ~€{activeInfo.estimatedCost}
              </span>
            </div>
            <p className="text-[length:var(--text-xs)] text-muted-foreground">
              {t("preferences:billing.estimateLine", { count: activeInfo.activeCount })}
              {activeInfo.activeCount > 0 && (
                <span> - {activeInfo.workers.join(", ")}</span>
              )}
            </p>
            {activeInfo.restaurants && activeInfo.restaurants.length > 1 && (
              <div className="space-y-1 pt-[var(--space-xs)]">
                {activeInfo.restaurants.map((restaurant) => (
                  <div
                    key={restaurant.restaurantId}
                    className="flex items-baseline justify-between gap-[var(--space-sm)] text-[length:var(--text-xs)] text-muted-foreground"
                  >
                    <span className="truncate">{restaurant.restaurantName}</span>
                    <span className="shrink-0">{t("preferences:billing.restaurantActiveCount", { count: restaurant.activeCount })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <Button
          variant="outline"
          className="h-[var(--space-xl)] text-[length:var(--text-xs)] uppercase tracking-widest font-bold"
          onClick={openPortal}
          disabled={portalLoading}
        >
          {portalLoading ? t("preferences:actions.loadingShort") : t("preferences:billing.manage")}
        </Button>

        {(billing.subscriptionStatus === "cancelled" || billing.subscriptionStatus === "unpaid") && (
          <Button
            className="h-[var(--space-xl)] text-[length:var(--text-xs)] uppercase tracking-widest font-bold"
            onClick={resubscribe}
            disabled={resubLoading}
          >
            {resubLoading ? t("preferences:actions.loadingShort") : t("preferences:billing.resubscribe")}
          </Button>
        )}
      </div>
    </div>
  );
}

function WorkerSharesSection() {
  const { t } = useTranslation();
  const { user: authUser } = useAuth();
  const queryClient = useQueryClient();
  const activeRestaurantId = authUser?.activeRestaurantId ?? authUser?.restaurantId ?? "";
  const accessibleRestaurants = authUser?.restaurants ?? [];
  const sourceRestaurants = accessibleRestaurants.filter((restaurant) => restaurant.id !== activeRestaurantId);
  const canManageShares = authUser?.ownerRole === "owner_admin" || authUser?.ownerRole === "owner_manager";
  const [sourceRestaurantId, setSourceRestaurantId] = useState(sourceRestaurants[0]?.id ?? "");
  const [shareRole, setShareRole] = useState<"kitchen" | "floor">("kitchen");
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const resolvedSourceRestaurantId = sourceRestaurants.some((restaurant) => restaurant.id === sourceRestaurantId)
    ? sourceRestaurantId
    : sourceRestaurants[0]?.id ?? "";

  const allShareTargetIds = accessibleRestaurants.map((restaurant) => restaurant.id).sort().join("|");
  const sharesQuery = useQuery({
    queryKey: qk.workerShares.list(),
    enabled: canManageShares && !!activeRestaurantId,
    queryFn: async () => (await api.listWorkerShares(activeRestaurantId)).data,
  });
  const allSharesQuery = useQuery({
    queryKey: qk.workerShares.ownerList(allShareTargetIds),
    enabled: canManageShares && accessibleRestaurants.length > 0,
    queryFn: async () => {
      const batches = await Promise.all(accessibleRestaurants.map(async (restaurant) => (await api.listWorkerShares(restaurant.id)).data));
      return batches.flat();
    },
  });
  const shareableQuery = useQuery({
    queryKey: qk.workerShares.shareableWorkers(resolvedSourceRestaurantId, shareRole),
    enabled: canManageShares && !!activeRestaurantId && !!resolvedSourceRestaurantId,
    queryFn: async () => (await api.listShareableWorkers(activeRestaurantId, { sourceRestaurantId: resolvedSourceRestaurantId, role: shareRole })).data,
  });
  const shareableWorkers = shareableQuery.data ?? [];
  const resolvedSelectedWorkerId = shareableWorkers.some((worker) => worker.id === selectedWorkerId)
    ? selectedWorkerId
    : shareableWorkers[0]?.id ?? "";
  const selectedWorker = shareableWorkers.find((worker) => worker.id === resolvedSelectedWorkerId);
  const shares = sharesQuery.data ?? [];
  const allShares = allSharesQuery.data ?? [];
  const activeOwnerShares = allShares.filter((share) => share.status !== "revoked");
  const employeeShareRows = Array.from(activeOwnerShares.reduce((acc, share) => {
    const key = `${share.userId}:${share.sourceRestaurantId}:${share.role}`;
    const existing = acc.get(key) ?? {
      userId: share.userId,
      workerName: share.workerName ?? share.userId,
      sourceRestaurantName: share.sourceRestaurantName ?? share.sourceRestaurantId,
      role: share.role,
      targets: [] as WorkerShareAuthorization[],
    };
    existing.targets.push(share);
    acc.set(key, existing);
    return acc;
  }, new Map<string, { userId: string; workerName: string; sourceRestaurantName: string; role: "kitchen" | "floor"; targets: WorkerShareAuthorization[] }>()).values());
  const statusLabel = (status: "pending" | "accepted" | "revoked") => {
    if (status === "accepted") return t("preferences:workerShares.statusAccepted");
    if (status === "revoked") return t("preferences:workerShares.statusRevoked");
    return t("preferences:workerShares.statusPending");
  };
  const workerShareError = (err: unknown, fallbackKey: string) => {
    if (!(err instanceof ApiError)) return errorMessage(err, t(fallbackKey));
    const key = `preferences:workerShares.errors.${err.message}`;
    const translated = t(key);
    return translated === key ? t(fallbackKey) : translated;
  };

  async function refreshShares() {
    await queryClient.invalidateQueries({ queryKey: qk.workerShares.all() });
  }

  async function inviteWorker() {
    if (!selectedWorker || !resolvedSourceRestaurantId || !activeRestaurantId) return;
    setBusyId("invite");
    try {
      await api.createWorkerShare(activeRestaurantId, {
        sourceRestaurantId: resolvedSourceRestaurantId,
        userId: selectedWorker.id,
        role: selectedWorker.role,
      });
      toast.success(t("preferences:workerShares.inviteSent"));
      await refreshShares();
    } catch (err) {
      toast.error(workerShareError(err, "preferences:workerShares.inviteFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function revokeShare(id: string) {
    setBusyId(id);
    try {
      await api.revokeWorkerShare(id);
      toast.success(t("preferences:workerShares.revoked"));
      await refreshShares();
    } catch (err) {
      toast.error(workerShareError(err, "preferences:workerShares.revokeFailed"));
    } finally {
      setBusyId(null);
    }
  }

  if (!canManageShares) return null;

  return (
    <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-md)]">
      <div>
        <p className={labelClass}>{t("preferences:workerShares.title")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">
          {t("preferences:workerShares.intro")}
        </p>
      </div>

      {canManageShares && (
        <div className="space-y-[var(--space-sm)]">
          <div className="grid gap-[var(--space-sm)] md:grid-cols-3">
            {[
              {
                title: t("preferences:workerShares.policyPlanningTitle"),
                body: t("preferences:workerShares.policyPlanningBody"),
              },
              {
                title: t("preferences:workerShares.policyPayrollTitle"),
                body: t("preferences:workerShares.policyPayrollBody"),
              },
              {
                title: t("preferences:workerShares.policyHoursTitle"),
                body: t("preferences:workerShares.policyHoursBody"),
              },
            ].map((item) => (
              <div key={item.title} className="rounded-[0.2rem] border border-foreground/10 p-[var(--space-sm)]">
                <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest">{item.title}</p>
                <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">{item.body}</p>
              </div>
            ))}
          </div>

          {sourceRestaurants.length > 0 ? (
            <div className="grid gap-[var(--space-sm)] md:grid-cols-[1fr_120px_1fr_auto] md:items-end">
              <label className="space-y-[var(--space-xs)]">
                <span className={fieldLabelClass}>{t("preferences:workerShares.sourceRestaurant")}</span>
                <select
                  value={sourceRestaurantId}
                  onChange={(e) => {
                    setSourceRestaurantId(e.target.value);
                    setSelectedWorkerId("");
                  }}
                  className="w-full h-8 rounded-[0.2rem] border border-foreground/20 bg-transparent px-[var(--space-sm)] text-[length:var(--text-sm)] outline-none focus:border-foreground"
                >
                  {sourceRestaurants.map((restaurant) => (
                    <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-[var(--space-xs)]">
                <span className={fieldLabelClass}>{t("preferences:workerShares.role")}</span>
                <select
                  value={shareRole}
                  onChange={(e) => {
                    setShareRole(e.target.value as "kitchen" | "floor");
                    setSelectedWorkerId("");
                  }}
                  className="w-full h-8 rounded-[0.2rem] border border-foreground/20 bg-transparent px-[var(--space-sm)] text-[length:var(--text-sm)] outline-none focus:border-foreground"
                >
                  <option value="kitchen">{t("preferences:workerShares.roleKitchen")}</option>
                  <option value="floor">{t("preferences:workerShares.roleFloor")}</option>
                </select>
              </label>
              <label className="space-y-[var(--space-xs)]">
                <span className={fieldLabelClass}>{t("preferences:workerShares.worker")}</span>
                <select
                  value={resolvedSelectedWorkerId}
                  onChange={(e) => setSelectedWorkerId(e.target.value)}
                  disabled={shareableQuery.isPending || shareableWorkers.length === 0}
                  className="w-full h-8 rounded-[0.2rem] border border-foreground/20 bg-transparent px-[var(--space-sm)] text-[length:var(--text-sm)] outline-none focus:border-foreground disabled:opacity-50"
                >
                  {shareableWorkers.length === 0 ? (
                    <option value="">{t("preferences:workerShares.noneAvailable")}</option>
                  ) : shareableWorkers.map((worker: ShareableWorker) => (
                    <option key={worker.id} value={worker.id}>{worker.name}</option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                onClick={inviteWorker}
                disabled={!selectedWorker || busyId === "invite"}
                className="h-8 text-[length:var(--text-xs)] uppercase tracking-widest font-bold"
              >
                {busyId === "invite" ? t("preferences:actions.loadingShort") : t("preferences:workerShares.invite")}
              </Button>
            </div>
          ) : (
            <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("preferences:workerShares.needSecondRestaurant")}</p>
          )}

          <div className="space-y-[var(--space-xs)]">
            <p className={fieldLabelClass}>{t("preferences:workerShares.globalView")}</p>
            {allSharesQuery.isPending ? (
              <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("preferences:workerShares.loading")}</p>
            ) : employeeShareRows.length === 0 ? (
              <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("preferences:workerShares.globalEmpty")}</p>
            ) : (
              employeeShareRows.map((row) => (
                <div key={`${row.userId}:${row.sourceRestaurantName}:${row.role}`} className="flex flex-wrap items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
                  <div className="min-w-0">
                    <p className="text-[length:var(--text-sm)] font-bold truncate">{row.workerName}</p>
                    <p className="text-[length:var(--text-xs)] text-muted-foreground">
                      {row.sourceRestaurantName} · {row.role === "kitchen" ? t("preferences:workerShares.roleKitchen") : t("preferences:workerShares.roleFloor")}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-[var(--space-xs)]">
                    {row.targets.map((share) => (
                      <span key={share.id} className="rounded-[0.2rem] border border-foreground/10 px-[var(--space-xs)] py-[2px] text-[length:var(--text-2xs)] font-bold uppercase tracking-wide text-muted-foreground">
                        {share.targetRestaurantName ?? share.targetRestaurantId} · {statusLabel(share.status)}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="space-y-[var(--space-xs)]">
            <p className={fieldLabelClass}>{t("preferences:workerShares.activeShares")}</p>
            {sharesQuery.isPending ? (
              <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("preferences:workerShares.loading")}</p>
            ) : shares.length === 0 ? (
              <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("preferences:workerShares.empty")}</p>
            ) : (
              shares.map((share) => (
                <div key={share.id} className="flex flex-wrap items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
                  <div className="min-w-0">
                    <p className="text-[length:var(--text-sm)] font-bold truncate">{share.workerName ?? share.userId}</p>
                    <p className="text-[length:var(--text-xs)] text-muted-foreground">
                      {share.sourceRestaurantName ?? share.sourceRestaurantId} · {share.role === "kitchen" ? t("preferences:workerShares.roleKitchen") : t("preferences:workerShares.roleFloor")} · {statusLabel(share.status)}
                    </p>
                  </div>
                  {share.status !== "revoked" && (
                    <button
                      type="button"
                      onClick={() => revokeShare(share.id)}
                      disabled={busyId === share.id}
                      className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {t("preferences:workerShares.remove")}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PreferencesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user: authUser } = useAuth();
  const [loading, setLoading] = useState(true);

  // Profile fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [restaurantAddress, setRestaurantAddress] = useState("");
  const [siret, setSiret] = useState("");
  const [botLocale, setBotLocale] = useState<"fr" | "en" | "es" | "pt">("fr");
  const [profileEditing, setProfileEditing] = useState(false);
  const [, setProfileDirty] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

  // Preferences
  const [prefs, setPrefs] = useState<AdminPreferences>({
    restaurantName: "",
    restaurantAddress: "",
    siret: null,
    whatsappBotLocale: "fr",
    tapInOutEnabled: false,
    tapInOutAdminConfirmation: false,
    tapInOutMode: "lateness_only" as const,
    tapInCountsAsHours: false,
    reminderFrequency: "off",
    includeSilaeInMonthlyDigest: false,
    colorScheme: "classic" as ColorScheme,
    kitchenColor: "amber",
    floorColor: "sky",
    workerPreferencesEnabled: true,
    autoStaffingWeeks: 3,
    disabledComplianceRules: [],
    kitchenSubRoles: ["Chef", "Cuisinier"],
    floorSubRoles: ["Chef de rang", "Serveur"],
    overtimeMode: "flexible" as const,
    overtimeWeeklyCap: 48,
    overtimeDistribution: "willing-first" as const,
    hcrGrid: {},
    subroleHcrMap: {},
    defaultContractType: DEFAULT_CONTRACT_TYPE,
    defaultContractHours: DEFAULT_CONTRACT_HOURS,
    silaeCodes: {
      heuresNormales: "HS-HN",
      hs110: "HS-HS10",
      hs120: "HS-HS20",
      hs150: "HS-HS50",
      repas: "EV-RepasServis",
      congesPayes: "AB-300",
      maladie: "AB-100",
    },
    preferredStyle: "equilibre" as const,
    customWeights: {} as Record<string, number>,
  });

  // Compliance rules metadata
  const [complianceRules, setComplianceRules] = useState<ComplianceRuleMeta[]>([]);

  // Open days - simple open/closed per day
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  const [openDaysDirty, setOpenDaysDirty] = useState(false);

  // Service groups (dynamic, replaces old templates state)
  const [serviceGroups, setServiceGroups] = useState<ServiceGroup[]>([]);
  const [serviceGroupsDirty, setServiceGroupsDirty] = useState(false);
  const [servicesSaving, setServicesSaving] = useState(false);

  // Medical mode
  const [medicalMode, setMedicalMode] = useState(false);

  // Staffing profiles + targets + per-profile service groups
  type ProfileState = { id: string; name: string; sortOrder: number; targets: Record<string, number>; roleBreakdowns: Record<string, Record<string, number>>; dayPriorities?: Record<string, number>; serviceGroups?: ServiceGroup[] };
  const [staffProfiles, setStaffProfiles] = useState<ProfileState[]>([]);
  const [dirtyProfileIds, setDirtyProfileIds] = useState<Set<string>>(new Set());
  const staffTargetsDirty = dirtyProfileIds.size > 0;
  const markStaffProfileDirty = (id: string) => setDirtyProfileIds(prev => { const next = new Set(prev); next.add(id); return next; });
  const markAllStaffProfilesDirty = () => setDirtyProfileIds(new Set(staffProfiles.map(p => p.id)));
  const [deleteHoverIdx, setDeleteHoverIdx] = useState<number | null>(null);
  const [titulaireReview, setTitulaireReview] = useState<Record<string, number>>({});
  const [serviceHoverIdx, setServiceHoverIdx] = useState<number | null>(null);
  const [overrideOpen, setOverrideOpen] = useState<Record<string, boolean>>({}); // key → expanded
  const [expandedSubRoles, setExpandedSubRoles] = useState<Record<string, boolean>>({});
  const [profileServiceHoverKey, setProfileServiceHoverKey] = useState<string | null>(null);
  const [staffTargetsSaving, setStaffTargetsSaving] = useState(false);

  // Per-profile service expand state
  const [expandedProfileServices, setExpandedProfileServices] = useState<Set<string>>(new Set());

  // Restaurant closures
  const [closures, setClosures] = useState<RestaurantClosure[]>([]);
  const [closureStart, setClosureStart] = useState("");
  const [closureEnd, setClosureEnd] = useState("");
  const [closureReason, setClosureReason] = useState("");
  const [closureSaving, setClosureSaving] = useState(false);
  const [closureImposeLeave, setClosureImposeLeave] = useState(true);
  const [editingClosureId, setEditingClosureId] = useState<string | null>(null);
  const [editClosureStart, setEditClosureStart] = useState("");
  const [editClosureEnd, setEditClosureEnd] = useState("");
  const [editClosureReason, setEditClosureReason] = useState("");


  // Week planner
  const [showWeekPlanner, setShowWeekPlanner] = useState(false);
  const [weekAssignments, setWeekAssignments] = useState<Record<string, string>>({}); // "YYYY-WW" → profileId
  const [weekPlannerDirty, setWeekPlannerDirty] = useState(false);
  const [weekPlannerSaving, setWeekPlannerSaving] = useState(false);
  const [hoverOvertimeMode, setHoverOvertimeMode] = useState<string | null>(null);
  const [hoverOvertimeDist, setHoverOvertimeDist] = useState<string | null>(null);
  const [hoverAutoStaffing, setHoverAutoStaffing] = useState<number | null>(null);
  const [hoverPreferredStyle, setHoverPreferredStyle] = useState<string | null>(null);
  const [prefTab, setPrefTab] = useState<"profil" | "planning" | "regle" | "taux" | "conformite" | "partage" | "whatsapp" | "aide">("planning");
  const [helpSubject, setHelpSubject] = useState("");
  const [helpMessage, setHelpMessage] = useState("");
  const [helpFocused, setHelpFocused] = useState(false);

  const queryClient = useQueryClient();
  const prefsLoad = useQuery({
    queryKey: qk.settings.pageLoad(authUser?.id),
    enabled: !!authUser,
    queryFn: async () => {
      const [usersRes, prefsRes, openDaysRes, templatesRes, medicalRes, targetsRes, rulesRes, closuresRes] = await Promise.all([
        api.listUsers(),
        api.getPreferences(),
        api.getOpenDays(),
        api.getServiceTemplates(),
        api.getMedicalMode(),
        api.getStaffingTargets(),
        api.getComplianceRules(),
        api.getClosures(),
      ]);
      return { usersRes, prefsRes, openDaysRes, templatesRes, medicalRes, targetsRes, rulesRes, closuresRes };
    },
  });

  useEffect(() => {
    if (!authUser || !prefsLoad.data) return;
    const { usersRes, prefsRes, openDaysRes, templatesRes, medicalRes, targetsRes, rulesRes, closuresRes } = prefsLoad.data;
    {
      const admin = usersRes.data.find((u) => u.id === authUser.id);
      if (admin) {
        setName(admin.name);
        setEmail(admin.email);
        setPhone(admin.phone);
      }
      setPrefs(prefsRes.data);
      setRestaurantName(prefsRes.data.restaurantName || "");
      setRestaurantAddress(prefsRes.data.restaurantAddress || "");
      setSiret(prefsRes.data.siret || "");
      setBotLocale(prefsRes.data.whatsappBotLocale || "fr");

      // Convert API open days (Record<string, "both"|"midi"|"soir">) to simple boolean map
      const boolDays: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(openDaysRes.data)) {
        boolDays[k] = !!v; // any truthy value means open
      }
      setOpenDays(boolDays);

      setMedicalMode(medicalRes.data);

      // Closures
      setClosures(closuresRes.data);


      // Staff profiles + targets + per-profile service templates
      const { profiles: rawProfiles, targets: rawTargets, profileTemplates: rawProfileTemplates } = targetsRes.data;

      // Convert templates → service groups
      setServiceGroups(serviceGroupsFromTemplates(templatesRes.data));
      if (rawProfiles.length === 0) {
        // No profiles yet - create one empty
        setStaffProfiles([{ id: genId(), name: "", sortOrder: 0, targets: {}, roleBreakdowns: {}, dayPriorities: {} }]);
      } else {
        const builtProfiles = rawProfiles.map(p => {
          const tMap: Record<string, number> = {};
          const rbMap: Record<string, Record<string, number>> = {};
          for (const t of rawTargets) {
            if (t.profileId === p.id) {
              const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
              tMap[key] = t.count;
              if (t.roleBreakdown) {
                const rb = typeof t.roleBreakdown === "string" ? JSON.parse(t.roleBreakdown) : t.roleBreakdown;
                if (rb && typeof rb === "object" && Object.keys(rb).length > 0) rbMap[key] = rb;
              }
            }
          }
          // Per-profile service groups (only when >1 profile)
          const profileTpls = (rawProfileTemplates || []).filter(pt => pt.profileId === p.id);
          const pGroups = profileTpls.length > 0 ? serviceGroupsFromTemplates(profileTpls) : undefined;
          const dp = p.dayPriorities ? (typeof p.dayPriorities === "string" ? JSON.parse(p.dayPriorities) : p.dayPriorities) : {};
          return { id: p.id, name: p.name, sortOrder: p.sortOrder, targets: tMap, roleBreakdowns: rbMap, dayPriorities: dp, serviceGroups: pGroups };
        });
        setStaffProfiles(builtProfiles);
        // Lazy-fetch titulaire-review counts per profile for the header badges.
        Promise.all(builtProfiles.map(p =>
          api.getProfileTitulaires(p.id).then(r => [p.id, r.data.needsReview] as const).catch(() => [p.id, 0] as const)
        )).then(entries => setTitulaireReview(Object.fromEntries(entries)));
        // Auto-expand: first profile always + any profile with custom services
        const expanded = new Set<string>();
        if (builtProfiles.length > 0) expanded.add(builtProfiles[0].id);
        for (const p of builtProfiles) { if (p.serviceGroups) expanded.add(p.id); }
        setExpandedProfileServices(expanded);
        // First profile: ensure it has service groups (copy globals if needed)
        if (builtProfiles.length > 1 && !builtProfiles[0].serviceGroups) {
          const globalGroups = serviceGroupsFromTemplates(templatesRes.data);
          builtProfiles[0] = { ...builtProfiles[0], serviceGroups: globalGroups.map(g => ({ ...g })) };
          setStaffProfiles([...builtProfiles]);
        }
      }

      setComplianceRules(rulesRes.data);

      // Load week assignments if profiles exist
      if (rawProfiles.length > 1) {
        api.getStaffingSchedule(new Date().getFullYear()).then(res => {
          const map: Record<string, string> = {};
          for (const a of res.data) map[`${a.year}-${String(a.week).padStart(2, "0")}`] = a.profileId;
          setWeekAssignments(map);
        }).catch(() => {});
      }
      setLoading(false);
    }
  }, [authUser, prefsLoad.data]);
  useEffect(() => { if (prefsLoad.error) setLoading(false); }, [prefsLoad.error]);


  function markProfileDirty() {
    setProfileDirty(true);
  }

  async function handleSaveProfile() {
    if (!authUser) return;
    setProfileSaving(true);
    try {
      const addressChanged = restaurantAddress !== (prefs.restaurantAddress || "");
      const siretCleaned = siret.replace(/\s+/g, "");
      if (siretCleaned && !/^\d{14}$/.test(siretCleaned)) {
        toast.error(t("preferences:profile.siretInvalid"));
        setProfileSaving(false);
        return;
      }
      await Promise.all([
        api.updateUser(authUser.id, { name, email, phone }),
        api.updatePreferences({ restaurantName, restaurantAddress, siret: siretCleaned || null, whatsappBotLocale: botLocale }),
      ]);
      // Re-geocode when address changes (updates weather coordinates)
      if (addressChanged && restaurantAddress.trim()) {
        api.geocodeAddress(restaurantAddress).catch(() => {});
      }
      setPrefs(p => ({ ...p, restaurantName, restaurantAddress, siret: siretCleaned || null, whatsappBotLocale: botLocale }));
      setProfileDirty(false);
      setProfileEditing(false);
      toast(t("preferences:profile.saved"));
    } catch (err) {
      toast.error(errorMessage(err, t("preferences:profile.saveFailed")));
    } finally {
      setProfileSaving(false);
    }
  }

  async function updatePref<K extends keyof AdminPreferences>(key: K, value: AdminPreferences[K]) {
    const prev = prefs[key];
    setPrefs((p) => ({ ...p, [key]: value }));
    try {
      await api.updatePreferences({ [key]: value });
    } catch {
      setPrefs((p) => ({ ...p, [key]: prev }));
      toast.error(t("preferences:errors.updateFailed"));
    }
  }

  async function updateSilaeCode(key: (typeof SILAE_CODE_FIELDS)[number], value: string) {
    const nextCodes = { ...prefs.silaeCodes, [key]: value.trim() };
    await updatePref("silaeCodes", nextCodes);
  }

  // ── Open days - simple toggle ──
  function toggleDay(day: number) {
    const key = String(day);
    setOpenDays((prev) => {
      const next = { ...prev };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = true;
      }
      return next;
    });
    setOpenDaysDirty(true);
  }

  // ── Service groups ──

  function updateServiceGroup(index: number, updater: (g: ServiceGroup) => ServiceGroup) {
    setServiceGroups((prev) => prev.map((g, i) => (i === index ? updater(g) : g)));
    setServiceGroupsDirty(true);
  }

  function addServiceGroup() {
    const maxOrder = serviceGroups.reduce((m, g) => Math.max(m, g.sortOrder), 0);
    // Generate a unique default label
    let label = "nouveau";
    let counter = 2;
    const existingLabels = new Set(serviceGroups.map(g => g.label.trim().toLowerCase()));
    while (existingLabels.has(label)) {
      label = `nouveau ${counter}`;
      counter++;
    }
    setServiceGroups((prev) => [
      ...prev,
      {
        label,
        sortOrder: maxOrder + 1,
        kitchen: { start: "09:00", end: "17:00" },
        floor: { start: "09:00", end: "17:00" },
      },
    ]);
    setServiceGroupsDirty(true);
  }

  function removeServiceGroup(index: number) {
    if (serviceGroups.length <= 1) return;
    // Also clean up staffing targets for this zone across all profiles
    const removedZone = serviceGroups[index].label;
    setServiceGroups((prev) => prev.filter((_, i) => i !== index));
    setStaffProfiles(prev => prev.map(p => {
      const next = { ...p.targets };
      for (const key of Object.keys(next)) {
        if (key.endsWith(`_${removedZone}`)) delete next[key];
      }
      return { ...p, targets: next };
    }));
    setServiceGroupsDirty(true);
    markAllStaffProfilesDirty();
  }

  // ── Per-profile service groups (when >1 profiles) ──

  /** Get the effective service groups for a profile - own groups or fallback to global */
  function getProfileServiceGroups(profile: ProfileState): ServiceGroup[] {
    return profile.serviceGroups || serviceGroups;
  }

  function updateProfileServiceGroup(profileIdx: number, groupIdx: number, updater: (g: ServiceGroup) => ServiceGroup) {
    setStaffProfiles(prev => prev.map((p, i) => {
      if (i !== profileIdx || !p.serviceGroups) return p;
      return { ...p, serviceGroups: p.serviceGroups.map((g, j) => j === groupIdx ? updater(g) : g) };
    }));
    markStaffProfileDirty(staffProfiles[profileIdx].id);
  }

  function addProfileServiceGroup(profileIdx: number) {
    setStaffProfiles(prev => prev.map((p, i) => {
      if (i !== profileIdx) return p;
      const groups = p.serviceGroups || [...serviceGroups];
      const maxOrder = groups.reduce((m, g) => Math.max(m, g.sortOrder), 0);
      let label = "nouveau";
      let counter = 2;
      const existing = new Set(groups.map(g => g.label.trim().toLowerCase()));
      while (existing.has(label)) { label = `nouveau ${counter}`; counter++; }
      return { ...p, serviceGroups: [...groups, { label, sortOrder: maxOrder + 1, kitchen: { start: "09:00", end: "17:00" }, floor: { start: "09:00", end: "17:00" } }] };
    }));
    markStaffProfileDirty(staffProfiles[profileIdx].id);
  }

  function removeProfileServiceGroup(profileIdx: number, groupIdx: number) {
    setStaffProfiles(prev => prev.map((p, i) => {
      if (i !== profileIdx || !p.serviceGroups || p.serviceGroups.length <= 1) return p;
      const removedZone = p.serviceGroups[groupIdx].label;
      const nextGroups = p.serviceGroups.filter((_, j) => j !== groupIdx);
      const nextTargets = { ...p.targets };
      for (const key of Object.keys(nextTargets)) {
        if (key.endsWith(`_${removedZone}`)) delete nextTargets[key];
      }
      return { ...p, serviceGroups: nextGroups, targets: nextTargets };
    }));
    markStaffProfileDirty(staffProfiles[profileIdx].id);
  }

  const servicesDirty = serviceGroupsDirty || openDaysDirty;

  // Warn on page unload if any section has unsaved changes
  const anyDirty = servicesDirty || staffTargetsDirty || weekPlannerDirty;
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  const hasDuplicateLabels = (() => {
    const seen = new Set<string>();
    for (const g of serviceGroups) {
      const key = g.label.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  })();
  const allGroupsValid = serviceGroups.length > 0 && serviceGroups.every(isServiceGroupValid) && !hasDuplicateLabels;

  async function handleSaveServices() {
    if (!allGroupsValid) return;
    if (hasDuplicateLabels) {
      toast.error(t("preferences:services.duplicateError"));
      return;
    }
    setServicesSaving(true);
    try {
      const data = serviceGroupsToTemplates(serviceGroups);
      // Convert boolean openDays back to API format (Record<string, "both"|"midi"|"soir">)
      const apiOpenDays: Record<string, "both" | "midi" | "soir"> = {};
      for (const [k, v] of Object.entries(openDays)) {
        if (v) apiOpenDays[k] = "both";
      }
      await Promise.all([
        api.updateServiceTemplates(data),
        openDaysDirty ? api.updateOpenDays(apiOpenDays) : Promise.resolve(),
      ]);
      setServiceGroupsDirty(false);
      setOpenDaysDirty(false);
      toast(t("preferences:services.saved"));
    } catch (err) {
      console.error(err);
      toast.error(t("preferences:services.saveFailed"));
    } finally {
      setServicesSaving(false);
    }
  }

  // ── Staffing targets ──

  function updateProfileTarget(profileIdx: number, day: number, role: "kitchen" | "floor", zone: string, value: number) {
    const key = `${day}_${role}_${zone}`;
    setStaffProfiles(prev => prev.map((p, i) => i === profileIdx ? { ...p, targets: { ...p.targets, [key]: value } } : p));
    markStaffProfileDirty(staffProfiles[profileIdx].id);
  }

  function updateProfileName(profileIdx: number, name: string) {
    setStaffProfiles(prev => prev.map((p, i) => i === profileIdx ? { ...p, name } : p));
    markStaffProfileDirty(staffProfiles[profileIdx].id);
  }

  function addStaffProfile() {
    navigate("/preferences/objectif/new");
  }

  function removeStaffProfile(idx: number) {
    if (staffProfiles.length <= 1) return;
    setStaffProfiles(prev => {
      const next = prev.filter((_, i) => i !== idx);
      // When going from 2→1 profile, clear per-profile service groups (use global again)
      if (next.length === 1) return next.map(p => ({ ...p, serviceGroups: undefined }));
      return next;
    });
    markAllStaffProfilesDirty();
  }

  const staffProfilesNeedNames = staffProfiles.length > 1;
  const staffProfileNamesValid = !staffProfilesNeedNames || staffProfiles.every(p => p.name.trim().length > 0);
  const hasDuplicateProfileNames = (() => {
    if (staffProfiles.length <= 1) return false;
    const seen = new Set<string>();
    for (const p of staffProfiles) {
      const key = p.name.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  })();

  async function handleSaveStaffTargets() {
    if (!staffProfileNamesValid || hasDuplicateProfileNames) return;
    // Validate only dirty profiles' service groups when >1 profiles
    if (staffProfiles.length > 1) {
      for (const p of staffProfiles) {
        if (!dirtyProfileIds.has(p.id)) continue;
        const groups = p.serviceGroups || [];
        if (groups.length === 0 || !groups.every(isServiceGroupValid)) {
          toast.error(t("preferences:staffingTargets.incompleteServices", { name: p.name || t("preferences:staffingTargets.unnamedProfile") }));
          return;
        }
      }
    }
    setStaffTargetsSaving(true);
    try {
      const profiles: StaffingProfile[] = staffProfiles.map((p, i) => ({
        id: p.id,
        name: p.name.trim(),
        sortOrder: i,
        dayPriorities: p.dayPriorities,
      }));
      const targets: StaffingTarget[] = [];
      for (const p of staffProfiles) {
        for (const [key, count] of Object.entries(p.targets)) {
          if (count <= 0) continue;
          const parts = key.split("_");
          const dayStr = parts[0];
          const role = parts[1] as "kitchen" | "floor";
          const zone = parts.slice(2).join("_");
          const rbKey = key; // same format: "day_role_zone"
          const rb = p.roleBreakdowns[rbKey];
          targets.push({ profileId: p.id, dayOfWeek: Number(dayStr), role, zone, count, roleBreakdown: rb });
        }
      }
      // Preserve explicit per-profile service templates when this compact
      // preferences grid saves counts. Single-profile objectives created in the
      // calendar can still have profile-specific templates; omitting them here
      // used to make the API delete the objective's planning shape.
      const profileTemplates: ProfileServiceTemplate[] = [];
      for (const p of staffProfiles) {
        if (!p.serviceGroups) continue;
        const tpls = serviceGroupsToTemplates(p.serviceGroups);
        for (const t of tpls) {
          profileTemplates.push({ profileId: p.id, ...t });
        }
      }
      const res = await api.updateStaffingTargets(profiles, targets, profileTemplates.length > 0 ? profileTemplates : undefined);
      // Update local state with server-assigned IDs
      const { profiles: newProfiles, targets: newTargets, profileTemplates: newPT } = res.data;
      setStaffProfiles(newProfiles.map(np => {
        const tMap: Record<string, number> = {};
        const rbMap: Record<string, Record<string, number>> = {};
        for (const t of newTargets) {
          if (t.profileId === np.id) {
            const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
            tMap[key] = t.count;
            if (t.roleBreakdown) {
              const rb = typeof t.roleBreakdown === "string" ? JSON.parse(t.roleBreakdown) : t.roleBreakdown;
              if (rb && typeof rb === "object" && Object.keys(rb).length > 0) rbMap[key] = rb;
            }
          }
        }
        const pTpls = (newPT || []).filter(pt => pt.profileId === np.id);
        const pGroups = pTpls.length > 0 ? serviceGroupsFromTemplates(pTpls) : undefined;
        const dp = np.dayPriorities ? (typeof np.dayPriorities === "string" ? JSON.parse(np.dayPriorities) : np.dayPriorities) : {};
        return { id: np.id, name: np.name, sortOrder: np.sortOrder, targets: tMap, roleBreakdowns: rbMap, dayPriorities: dp, serviceGroups: pGroups };
      }));
      setDirtyProfileIds(new Set());
      toast(t("preferences:staffingTargets.saved"));
    } catch (err) {
      console.error(err);
      toast.error(t("preferences:staffingTargets.saveFailed"));
    } finally {
      setStaffTargetsSaving(false);
    }
  }

  // ── Week planner ──

  function getISOWeek(d: Date): number {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  function getMondayOfWeek(year: number, week: number): Date {
    const jan4 = new Date(year, 0, 4);
    const dayOfWeek = jan4.getDay() || 7;
    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
    return monday;
  }

  function generateWeeks(count: number): Array<{ year: number; week: number; monday: Date; label: string }> {
    const today = new Date();
    const result: Array<{ year: number; week: number; monday: Date; label: string }> = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i * 7);
      const w = getISOWeek(d);
      const y = d.getFullYear();
      // Adjust year for ISO week at year boundary
      const adjustedYear = d.getMonth() === 0 && w > 50 ? y - 1 : d.getMonth() === 11 && w === 1 ? y + 1 : y;
      const mon = getMondayOfWeek(adjustedYear, w);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      const fmt = (dt: Date) => `${dt.getDate()}/${dt.getMonth() + 1}`;
      result.push({ year: adjustedYear, week: w, monday: mon, label: `${fmt(mon)}-${fmt(sun)}` });
    }
    return result;
  }

  const plannerWeeks = generateWeeks(16);

  function toggleWeekProfile(year: number, week: number) {
    const key = `${year}-${String(week).padStart(2, "0")}`;
    const currentId = weekAssignments[key];
    const profileIds = staffProfiles.map(p => p.id);
    if (profileIds.length < 2) return;
    const currentIdx = currentId ? profileIds.indexOf(currentId) : 0; // default = first profile
    const nextIdx = (currentIdx + 1) % profileIds.length;
    setWeekAssignments(prev => ({ ...prev, [key]: profileIds[nextIdx] }));
    setWeekPlannerDirty(true);
  }

  async function handleSaveWeekPlanner() {
    setWeekPlannerSaving(true);
    try {
      const assignments: StaffingWeekAssignment[] = Object.entries(weekAssignments).map(([key, profileId]) => {
        const [y, w] = key.split("-");
        return { year: Number(y), week: Number(w), profileId };
      });
      const res = await api.updateStaffingSchedule(assignments);
      const map: Record<string, string> = {};
      for (const a of res.data) map[`${a.year}-${String(a.week).padStart(2, "0")}`] = a.profileId;
      setWeekAssignments(map);
      setWeekPlannerDirty(false);
      toast(t("preferences:weekPlanner.saved"));
    } catch {
      toast.error(t("preferences:weekPlanner.saveFailed"));
    } finally {
      setWeekPlannerSaving(false);
    }
  }

  // ── Other toggles ──

  async function toggleComplianceRule(code: string) {
    const current = prefs.disabledComplianceRules || [];
    const isDisabled = current.includes(code);
    const next = isDisabled
      ? current.filter(c => c !== code)
      : [...current, code];
    const prev = current;
    setPrefs(p => ({ ...p, disabledComplianceRules: next }));
    try {
      await api.updatePreferences({ disabledComplianceRules: next });
    } catch {
      setPrefs(p => ({ ...p, disabledComplianceRules: prev }));
      toast.error(t("preferences:errors.updateFailed"));
    }
  }

  async function handleMedicalToggle() {
    const next = !medicalMode;
    setMedicalMode(next);
    try {
      await api.setMedicalMode(next);
    } catch {
      setMedicalMode(!next);
      toast.error(t("preferences:errors.updateFailed"));
    }
  }

  // ── Closure handlers ──

  async function fetchClosures() {
    try {
      const res = await api.getClosures();
      setClosures(res.data);
      queryClient.invalidateQueries({ queryKey: qk.settings.closures() });
    } catch (e) { console.error(e); }
  }

  function startEditingClosure(c: RestaurantClosure) {
    setEditingClosureId(c.id);
    setEditClosureStart(c.startDate);
    setEditClosureEnd(c.endDate);
    setEditClosureReason(c.reason || "");
  }

  async function saveClosureEdit() {
    if (!editingClosureId || !editClosureStart || !editClosureEnd) return;
    if (closuresOverlap(editClosureStart, editClosureEnd, editingClosureId)) {
      toast.error(t("preferences:closures.overlapError")); return;
    }
    try {
      await api.updateClosure(editingClosureId, { startDate: editClosureStart, endDate: editClosureEnd, reason: editClosureReason || undefined });
      setEditingClosureId(null);
      fetchClosures();
    } catch (err) {
      const status = err && typeof err === "object" && "status" in err ? (err as { status: unknown }).status : undefined;
      if (status === 409) toast.error(t("preferences:closures.overlapError"));
      else console.error(err);
    }
  }

  function cancelClosureEdit() { setEditingClosureId(null); }

  const closureToday = new Date().toISOString().slice(0, 10);
  const upcomingClosures = closures.filter((c) => c.endDate >= closureToday).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const pastClosures = closures.filter((c) => c.endDate < closureToday).sort((a, b) => b.startDate.localeCompare(a.startDate));

  function closuresOverlap(start: string, end: string, excludeId?: string) {
    return closures.some(c => c.id !== excludeId && c.startDate <= end && c.endDate >= start);
  }

  async function handleAddClosure(e: React.FormEvent) {
    e.preventDefault();
    if (!closureStart || !closureEnd) return;
    if (closuresOverlap(closureStart, closureEnd)) {
      toast.error(t("preferences:closures.overlapError")); return;
    }
    const daysUntilStart = Math.floor((new Date(`${closureStart}T00:00:00`).getTime() - Date.now()) / (24 * 3600 * 1000));
    const confirmShortNotice = closureImposeLeave && daysUntilStart < 30
      ? confirm(t("preferences:closures.shortNoticeConfirm", { count: daysUntilStart }))
      : false;
    if (closureImposeLeave && daysUntilStart < 30 && !confirmShortNotice) return;

    setClosureSaving(true);
    try {
      const created = await api.addClosure({
        startDate: closureStart,
        endDate: closureEnd,
        reason: closureReason || undefined,
        createLeaves: closureImposeLeave,
        confirmShortNotice,
      });

      if (closureImposeLeave) {
        toast.success(t("preferences:closures.imposeSuccess", { count: created.data.leavesCreated ?? 0 }));
        if (created.data.noticeWarning) toast.warning(created.data.noticeWarning);
      }

      setClosureStart(""); setClosureEnd(""); setClosureReason("");
      fetchClosures();
    } catch (err) {
      const status = err && typeof err === "object" && "status" in err ? (err as { status: unknown }).status : undefined;
      if (status === 409) toast.error(t("preferences:closures.overlapError"));
      else console.error(err);
    }
    finally { setClosureSaving(false); }
  }

  async function handleDeleteClosure(id: string) {
    await api.deleteClosure(id);
    fetchClosures();
  }

  if (loading) {
    return <p className="text-muted-foreground text-[length:var(--text-sm)]">{t("preferences:page.loading")}</p>;
  }

  return (
    <div className="space-y-[var(--space-md)]">
      <div className="space-y-[var(--space-sm)]">
      <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em]">
        {t("preferences:page.title")}
      </h1>

      <div className="relative -mx-[var(--space-md)] md:-mx-[var(--space-lg)] border-b border-border">
        <div className="px-[var(--space-md)] md:px-[var(--space-lg)] overflow-x-auto scrollbar-none">
          <UnderlineNav
            items={[
              { value: "planning", label: t("preferences:tabs.planning") },
              { value: "regle", label: t("preferences:tabs.regle") },
              { value: "taux", label: t("preferences:tabs.taux") },
              { value: "conformite", label: t("preferences:tabs.conformite") },
              { value: "partage", label: t("preferences:tabs.partage") },
              ...(authUser?.restaurantStatus === "demo" ? [{ value: "whatsapp", label: t("preferences:tabs.whatsapp") }] : []),
              { value: "profil", label: t("preferences:tabs.profil") },
              { value: "aide", label: t("preferences:tabs.aide") },
            ]}
            value={prefTab}
            onChange={(v) => setPrefTab(v as typeof prefTab)}
          />
        </div>
        <div className="pointer-events-none absolute top-0 right-0 h-full w-8 bg-gradient-to-r from-transparent to-background sm:hidden" />
      </div>
      </div>

      {/* ── Profile Info (locked by default) ── */}
      {prefTab === "profil" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-md)]">
        <div className="flex items-center justify-between">
          <p className={labelClass}>{t("preferences:profile.title")}</p>
          <div className="flex items-center gap-[var(--space-xs)]">
            {profileEditing ? (
              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={profileSaving}
                className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground text-background bg-foreground hover:bg-transparent hover:text-foreground transition-colors"
              >
                {profileSaving ? t("preferences:actions.loadingShort") : t("preferences:profile.save")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setProfileEditing(true)}
                className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors"
              >
                {t("preferences:profile.edit")}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-[var(--space-xs)]">
          {profileEditing ? (
            <input
              value={restaurantName}
              onChange={(e) => { setRestaurantName(e.target.value); markProfileDirty(); }}
              placeholder={t("preferences:profile.restaurantNamePlaceholder")}
              className="block w-full bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-xl)] font-bold tracking-[-0.02em] pb-[1px] transition-colors"
            />
          ) : (
            <p className="text-[length:var(--text-xl)] font-bold tracking-[-0.02em]">{restaurantName || t("preferences:profile.restaurantDefault")}</p>
          )}
          {profileEditing ? (
            <input
              value={restaurantAddress}
              onChange={(e) => { setRestaurantAddress(e.target.value); markProfileDirty(); }}
              placeholder={t("preferences:profile.addressPlaceholder")}
              className="block w-full bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-sm)] text-muted-foreground pb-[1px] transition-colors"
            />
          ) : (
            restaurantAddress && <p className="text-[length:var(--text-sm)] text-muted-foreground">{restaurantAddress}</p>
          )}
          {profileEditing ? (
            <input
              value={siret}
              onChange={(e) => { setSiret(e.target.value); markProfileDirty(); }}
              placeholder={t("preferences:profile.siretPlaceholder")}
              inputMode="numeric"
              maxLength={17}
              className="block w-full bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-sm)] text-muted-foreground pb-[1px] transition-colors"
            />
          ) : (
            siret && <p className="text-[length:var(--text-sm)] text-muted-foreground">SIRET · {siret}</p>
          )}
          {profileEditing ? (
            <div className="flex gap-[var(--space-sm)]">
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); markProfileDirty(); }}
                placeholder={t("preferences:profile.namePlaceholder")}
                className="flex-1 bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-sm)] pb-[1px] transition-colors"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); markProfileDirty(); }}
                placeholder={t("preferences:profile.emailPlaceholder")}
                className="flex-1 bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-sm)] pb-[1px] transition-colors"
              />
              <input
                value={phone}
                onChange={(e) => { setPhone(e.target.value); markProfileDirty(); }}
                placeholder={t("preferences:profile.phonePlaceholder")}
                className="flex-1 bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-sm)] pb-[1px] transition-colors"
              />
            </div>
          ) : (
            <p className="text-[length:var(--text-sm)]">{name} · {email}{phone ? ` · ${formatPhone(phone)}` : ""}</p>
          )}
        </div>

        {!profileEditing && (
          <Link
            to="/change-password"
            className="inline-flex items-center text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("preferences:profile.changePassword")}
          </Link>
        )}

        <label className="flex items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
          <span className="text-[length:var(--text-xs)] font-medium">{t("preferences:profile.languageLabel")}</span>
          <select
            value={i18n.resolvedLanguage ?? i18n.language}
            onChange={(e) => i18n.changeLanguage(e.target.value)}
            className="text-[length:var(--text-xs)] bg-transparent border-b border-foreground/20 outline-none focus:border-foreground py-[2px]"
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
          </select>
        </label>

        <label className="flex items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
          <span className="text-[length:var(--text-xs)] font-medium">{t("preferences:profile.botLocaleLabel")}</span>
          <select
            value={botLocale}
            onChange={(e) => { setBotLocale(e.target.value as typeof botLocale); markProfileDirty(); }}
            disabled={!profileEditing}
            className="text-[length:var(--text-xs)] bg-transparent border-b border-foreground/20 outline-none focus:border-foreground py-[2px] disabled:opacity-60"
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
          </select>
        </label>
        <p className="text-[length:var(--text-xs)] text-muted-foreground -mt-[var(--space-xs)]">
          {t("preferences:profile.botLocaleHint")}
        </p>

        <EmailRecipientsSection />

        <div className="space-y-[var(--space-xs)] pt-[var(--space-md)]">
          <p className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground">
            {t("preferences:profile.payrollEmailTitle")}
          </p>
          <ToggleRow
            label={t("preferences:profile.includeSilaeLabel")}
            description={t("preferences:profile.includeSilaeDesc")}
            value={prefs.includeSilaeInMonthlyDigest}
            onChange={(v) => updatePref("includeSilaeInMonthlyDigest", v)}
          />
          <p className="text-[length:var(--text-xs)] text-amber-700 dark:text-amber-300">
            {t("preferences:profile.includeSilaeWarning")}
          </p>
        </div>

        <div className="space-y-[var(--space-xs)] pt-[var(--space-md)]">
          <p className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground">
            {t("preferences:profile.silaeCodesTitle")}
          </p>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            {t("preferences:profile.silaeCodesIntro")}
          </p>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            {t("preferences:profile.silaeCodesAnalyticHint")}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-sm)]">
            {SILAE_CODE_FIELDS.map((key) => (
              <label key={key} className="space-y-[3px]">
                <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-semibold text-muted-foreground">
                  {t(`preferences:profile.silaeCodes.${key}`)}
                </span>
                <Input
                  value={prefs.silaeCodes[key] || ""}
                  onChange={(e) => setPrefs((p) => ({ ...p, silaeCodes: { ...p.silaeCodes, [key]: e.target.value } }))}
                  onBlur={(e) => updateSilaeCode(key, e.target.value)}
                  placeholder={t(`preferences:profile.silaeCodePlaceholders.${key}`)}
                  className="font-mono text-[length:var(--text-sm)]"
                />
              </label>
            ))}
          </div>
        </div>
      </div>}

      {/* ── Remplir le planning en avance ── */}
      {prefTab === "planning" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[2px]">
          <div className="flex flex-wrap items-center gap-[var(--space-sm)]">
            <span className="text-[length:var(--text-sm)] font-bold shrink-0">{t("preferences:autoStaffing.label")}</span>
            <span className="flex-1 min-w-[var(--space-md)] border-b border-dotted border-foreground/20" />
            <div className="flex flex-wrap gap-[3px]">
              {([
                { value: 0, label: t("preferences:toggles.off") },
                { value: 1, label: "1W" },
                { value: 2, label: "2W" },
                { value: 3, label: "3W" },
                { value: 4, label: "4W" },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => updatePref("autoStaffingWeeks", opt.value)}
                  onMouseEnter={() => setHoverAutoStaffing(opt.value)}
                  onMouseLeave={() => setHoverAutoStaffing(null)}
                  className={`text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border transition-colors ${
                    (hoverAutoStaffing ?? prefs.autoStaffingWeeks) === opt.value
                      ? "bg-foreground text-background border-foreground"
                      : "bg-transparent text-muted-foreground border-foreground/20"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            {prefs.autoStaffingWeeks === 0
              ? t("preferences:autoStaffing.off")
              : t("preferences:autoStaffing.on", { count: prefs.autoStaffingWeeks })}
          </p>
          <p className="text-[length:10px] text-muted-foreground/80">
            {t("preferences:autoStaffing.publicationHint")}
          </p>
      </div>}


      {/* ── Planning des objectifs (only when multiple profiles) ── */}
      {prefTab === "planning" && staffProfiles.length > 1 && (
        <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
          <div className="flex items-center justify-between">
            <div>
              <button
                type="button"
                onClick={() => setShowWeekPlanner(p => !p)}
                className="flex items-center gap-[var(--space-xs)]">
                <p className={labelClass}>{t("preferences:weekPlanner.title")}</p>
                <ChevronRight className={cn("size-3 text-muted-foreground transition-transform", showWeekPlanner && "rotate-90")} />
              </button>
              <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">
                {t("preferences:weekPlanner.intro")}
              </p>
            </div>
            {weekPlannerDirty && (
              <Button size="sm" onClick={handleSaveWeekPlanner} disabled={weekPlannerSaving}
                className="h-6 px-[var(--space-sm)] uppercase tracking-widest text-[length:var(--text-xs)] font-bold">
                {weekPlannerSaving ? t("preferences:actions.loadingShort") : t("preferences:weekPlanner.save")}
              </Button>
            )}
          </div>

          {showWeekPlanner && (
            <div className="space-y-[var(--space-xs)]">
              {/* Legend */}
              <div className="flex gap-[var(--space-sm)] flex-wrap">
                {staffProfiles.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-[3px]">
                    <div className={cn(
                      "w-3 h-3 rounded-[2px] border",
                      i === 0 ? "bg-foreground border-foreground" : "bg-foreground/30 border-foreground/40"
                    )} />
                    <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground">
                      {p.name || t("preferences:weekPlanner.defaultProfileName")}
                    </span>
                  </div>
                ))}
              </div>

              {/* Week grid */}
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-[3px]">
                {plannerWeeks.map(({ year, week, label }) => {
                  const key = `${year}-${String(week).padStart(2, "0")}`;
                  const assignedId = weekAssignments[key];
                  const profileIdx = assignedId ? staffProfiles.findIndex(p => p.id === assignedId) : 0;
                  const assignedProfile = staffProfiles[profileIdx >= 0 ? profileIdx : 0];
                  const isFirst = profileIdx <= 0;
                  const today = new Date();
                  const currentWeek = getISOWeek(today);
                  const currentYear = today.getMonth() === 0 && currentWeek > 50 ? today.getFullYear() - 1 : today.getFullYear();
                  const isCurrent = year === currentYear && week === currentWeek;

                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleWeekProfile(year, week)}
                      className={cn(
                        "rounded-[0.2rem] border p-[var(--space-xs)] text-left transition-colors",
                        isCurrent && "ring-2 ring-foreground/30",
                        isFirst
                          ? "bg-foreground text-background border-foreground"
                          : "bg-foreground/20 text-foreground border-foreground/30"
                      )}
                    >
                      <div className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold opacity-60">{t("preferences:weekPlanner.weekShort", { week })}</div>
                      <div className="text-[length:var(--text-xs)] font-bold">{assignedProfile?.name || t("preferences:weekPlanner.defaultProfileName")}</div>
                      <div className={cn("text-[length:7px]", isFirst ? "opacity-50" : "text-muted-foreground")}>{label}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Restaurant Closures ── */}
      {prefTab === "planning" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-md)]">
        <p className={labelClass}>{t("preferences:closures.title")}</p>

        {/* Add closure form */}
        <form onSubmit={handleAddClosure} className="space-y-[var(--space-sm)]">
          <div className="flex items-end gap-[var(--space-sm)]">
            <DateRangePicker
              label={t("preferences:closures.datesLabel")}
              start={closureStart}
              end={closureEnd}
              onStartChange={setClosureStart}
              onEndChange={setClosureEnd}
            />
            <div className="space-y-[var(--space-xs)] flex-1">
              <Label className={fieldLabelClass}>{t("preferences:closures.reasonLabel")}</Label>
              <Input value={closureReason} onChange={(e) => setClosureReason(e.target.value)}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                placeholder={t("preferences:closures.reasonPlaceholder")} className="border-foreground/20 bg-white text-black dark:bg-white dark:text-black h-8 text-[length:var(--text-sm)] placeholder:text-black/40" />
            </div>
          </div>
          <label className="flex items-start gap-[var(--space-sm)] cursor-pointer">
            <input
              type="checkbox"
              checked={closureImposeLeave}
              onChange={(e) => setClosureImposeLeave(e.target.checked)}
              className="mt-[3px] w-4 h-4 rounded border-foreground/20 cursor-pointer"
            />
            <span className="text-[length:var(--text-xs)] leading-snug">
              <span className="font-semibold">{t("preferences:closures.imposeLeaveTitle")}</span>
              <span className="block text-muted-foreground mt-[2px]">
                <Trans
                  i18nKey="preferences:closures.imposeLeaveDescription"
                  components={{
                    link: (
                      <a
                        href={LEGAL_LINKS.imposedLeaveClosure.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                      />
                    ),
                  }}
                />
              </span>
            </span>
          </label>
          <div className="flex justify-end">
            <button type="submit" disabled={closureSaving}
              className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors disabled:opacity-50">
              {closureSaving ? t("preferences:actions.loadingShort") : t("preferences:closures.addButton")}
            </button>
          </div>
        </form>

        {/* Upcoming closures */}
        {upcomingClosures.length > 0 && (
          <div className="space-y-[var(--space-xs)]">
            {upcomingClosures.map((c) => {
              const isActive = c.startDate <= closureToday && c.endDate >= closureToday;
              const isEditing = editingClosureId === c.id;
              return (
                <div key={c.id} className="py-[var(--space-xs)]">
                  {isEditing ? (
                    <div className="flex items-end gap-[var(--space-sm)]">
                      <DateRangePicker label="" start={editClosureStart} end={editClosureEnd} onStartChange={setEditClosureStart} onEndChange={setEditClosureEnd} />
                      <Input value={editClosureReason} onChange={(e) => setEditClosureReason(e.target.value)}
                        placeholder={t("preferences:closures.reasonShortPlaceholder")} className="border-foreground/20 bg-white text-black dark:bg-white dark:text-black h-8 text-[length:var(--text-sm)] flex-1" />
                      <button type="button" onClick={saveClosureEdit}
                        className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground transition-colors shrink-0">{t("preferences:closures.saveEdit")}</button>
                      <button type="button" onClick={cancelClosureEdit}
                        className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground transition-colors shrink-0">{t("preferences:closures.cancelEdit")}</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-[var(--space-sm)] flex-wrap">
                        <span className="text-[length:var(--text-sm)] font-bold">{fmtDateShort(c.startDate)} → {fmtDateShort(c.endDate)}</span>
                        {c.reason && <span className="text-[length:var(--text-sm)] text-muted-foreground">- {c.reason}</span>}
                        {isActive && (
                          <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold bg-foreground text-background px-[var(--space-xs)] py-[1px] rounded-full">{t("preferences:closures.nowBadge")}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-[var(--space-sm)] shrink-0">
                        <button type="button" onClick={() => startEditingClosure(c)}
                          className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground hover:underline transition-colors">{t("preferences:closures.edit")}</button>
                        <button type="button" onClick={() => handleDeleteClosure(c.id)}
                          className="text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground hover:underline transition-colors">
                          {t("preferences:closures.delete")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Past closures */}
        {pastClosures.length > 0 && (
          <details className="group">
            <summary className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground cursor-pointer hover:text-foreground">
              {t("preferences:closures.pastSection", { count: pastClosures.length })}
            </summary>
            <div className="mt-[var(--space-xs)] space-y-[var(--space-xs)] opacity-50">
              {pastClosures.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-[var(--space-xs)]">
                  <div className="flex items-center gap-[var(--space-sm)]">
                    <span className="text-[length:var(--text-sm)] font-bold">{fmtDateShort(c.startDate)} → {fmtDateShort(c.endDate)}</span>
                    {c.reason && <span className="text-[length:var(--text-sm)] text-muted-foreground">- {c.reason}</span>}
                  </div>
                  <button type="button" onClick={() => handleDeleteClosure(c.id)}
                    className="text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground hover:underline transition-colors">
                    {t("preferences:closures.delete")}
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}

        {closures.length === 0 && (
          <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("preferences:closures.empty")}</p>
        )}
      </div>}

      {/* ── Service Groups + Staffing (Objectifs) ── */}
      {prefTab === "planning" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-md)]">

        {/* Global service group cards - only when 1 profile */}
        {staffProfiles.length <= 1 && (
          <>
            <div className="flex items-center justify-between">
              <p className={labelClass}>{t("preferences:services.title")}</p>
              {servicesDirty && (
                <Button size="sm" onClick={handleSaveServices} disabled={servicesSaving || !allGroupsValid}
                  className="h-6 px-[var(--space-sm)] uppercase tracking-widest text-[length:var(--text-xs)] font-bold">
                  {servicesSaving ? t("preferences:actions.loadingShort") : t("preferences:services.save")}
                </Button>
              )}
            </div>

            <div className="space-y-[var(--space-md)]">
            <div className="flex flex-wrap items-start gap-[var(--space-md)]">
              {serviceGroups.map((group, idx) => {
                const groupValid = isServiceGroupValid(group);
                const isDuplicateLabel = group.label.trim() !== "" && serviceGroups.some((g, i) => i !== idx && g.label.trim().toLowerCase() === group.label.trim().toLowerCase());
                const showError = serviceGroupsDirty && (!groupValid || isDuplicateLabel);
                return (
                <div key={idx} className={cn("space-y-[var(--space-xs)] min-w-[200px] transition-opacity border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)]", serviceHoverIdx === idx && "opacity-40")}>
                  <div className="flex items-center gap-[var(--space-xs)] pb-[var(--space-xs)]">
                    <span className="text-[length:var(--text-sm)] font-bold">{t("preferences:services.groupHeader")}</span>
                    <input
                      type="text"
                      value={group.label.toUpperCase()}
                      onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, label: e.target.value.toLowerCase() }))}
                      className={cn("text-[length:var(--text-sm)] font-bold bg-transparent border-b focus:border-foreground/60 focus:outline-none uppercase px-0 pr-2 [field-sizing:content] min-w-[2ch]", showError && (!group.label.trim() || isDuplicateLabel) ? "border-destructive" : "border-foreground/20")}
                    />
                    {serviceGroups.length > 1 && (
                      <button
                        type="button"
                        onMouseEnter={() => setServiceHoverIdx(idx)}
                        onMouseLeave={() => setServiceHoverIdx(null)}
                        onClick={() => {
                          if (window.confirm(t("preferences:services.deleteConfirm"))) removeServiceGroup(idx);
                          setServiceHoverIdx(null);
                        }}
                        className="text-muted-foreground/40 hover:text-foreground transition-colors text-[length:var(--text-sm)]"
                        title={t("preferences:services.deleteTitle")}
                      ><X className="size-3" /></button>
                    )}
                  </div>
                  {/* CUISINE row(s) */}
                  <div className="flex items-center gap-[2px]">
                    <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground w-[68px] shrink-0">{t("preferences:services.kitchenAbbr")}</span>
                    <Input type="time" required value={group.kitchen.start} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, kitchen: { ...g.kitchen, start: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.kitchen.start && "border-destructive")} />
                    <span className="text-muted-foreground text-[length:10px]">-</span>
                    <Input type="time" required value={group.kitchen.end} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, kitchen: { ...g.kitchen, end: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.kitchen.end && "border-destructive")} />
                    {group.kitchen2 && <>
                      <span className="text-muted-foreground text-[length:9px] mx-0.5">+</span>
                      <Input type="time" required value={group.kitchen2.start} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, kitchen2: { ...g.kitchen2!, start: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                      <span className="text-muted-foreground text-[length:10px]">-</span>
                      <Input type="time" required value={group.kitchen2.end} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, kitchen2: { ...g.kitchen2!, end: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                    </>}
                  </div>
                  {/* SALLE row(s) */}
                  <div className="flex items-center gap-[2px]">
                    <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground w-[68px] shrink-0">{t("preferences:services.floorAbbr")}</span>
                    <Input type="time" required value={group.floor.start} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, floor: { ...g.floor, start: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.floor.start && "border-destructive")} />
                    <span className="text-muted-foreground text-[length:10px]">-</span>
                    <Input type="time" required value={group.floor.end} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, floor: { ...g.floor, end: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.floor.end && "border-destructive")} />
                    {group.floor2 && <>
                      <span className="text-muted-foreground text-[length:9px] mx-0.5">+</span>
                      <Input type="time" required value={group.floor2.start} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, floor2: { ...g.floor2!, start: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                      <span className="text-muted-foreground text-[length:10px]">-</span>
                      <Input type="time" required value={group.floor2.end} onChange={(e) => updateServiceGroup(idx, (g) => ({ ...g, floor2: { ...g.floor2!, end: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                    </>}
                  </div>
                  {/* Per-day overrides */}
                  <div className="pt-[var(--space-xs)]">
                    <button
                      type="button"
                      onClick={() => { const k = `g${idx}`; setOverrideOpen(prev => ({ ...prev, [k]: !prev[k] })); }}
                      className="text-[length:var(--text-2xs)] text-muted-foreground/60 hover:text-foreground transition-colors flex items-center gap-1"
                    >
                      <span className="text-[length:9px]">{overrideOpen[`g${idx}`] ? "▾" : "▸"}</span>
                      {t("preferences:services.exceptions")}
                      {group.dayOverrides && Object.keys(group.dayOverrides).length > 0 && (
                        <span className="text-[length:var(--text-2xs)] text-foreground/60 font-bold">({Object.keys(group.dayOverrides).length})</span>
                      )}
                    </button>
                    {overrideOpen[`g${idx}`] && (
                      <div className="mt-[var(--space-xs)] space-y-[3px]">
                        {/* Day pills */}
                        <div className="flex gap-[3px] mb-[var(--space-xs)]">
                          {DAY_LABEL_KEYS.map((labelKey, di) => {
                            const dow = di + 1;
                            const hasOverride = !!(group.dayOverrides?.[dow]?.kitchen || group.dayOverrides?.[dow]?.floor);
                            return (
                              <button
                                key={dow}
                                type="button"
                                onClick={() => {
                                  if (hasOverride) {
                                    updateServiceGroup(idx, (g) => {
                                      const ov = { ...g.dayOverrides };
                                      delete ov[dow];
                                      return { ...g, dayOverrides: Object.keys(ov).length > 0 ? ov : undefined };
                                    });
                                  } else {
                                    updateServiceGroup(idx, (g) => {
                                      const ov = { ...g.dayOverrides };
                                      ov[dow] = {
                                        kitchen: { start: g.kitchen.start, end: g.kitchen.end },
                                        floor: { start: g.floor.start, end: g.floor.end },
                                      };
                                      return { ...g, dayOverrides: ov };
                                    });
                                  }
                                }}
                                className={cn(
                                  "text-[length:9px] font-bold w-[28px] h-[18px] rounded-sm transition-colors",
                                  hasOverride
                                    ? "bg-foreground text-background"
                                    : "bg-muted text-muted-foreground hover:bg-muted-foreground/20"
                                )}
                              >
                                {t(labelKey)}
                              </button>
                            );
                          })}
                        </div>
                        {/* Override time inputs for active days */}
                        {[1, 2, 3, 4, 5, 6, 7].filter(dow => group.dayOverrides?.[dow]).map(dow => {
                          const ov = group.dayOverrides![dow]!;
                          return (
                            <div key={dow} className="space-y-[2px]">
                              <span className="text-[length:9px] font-bold text-muted-foreground">{t(DAY_LABEL_KEYS[dow - 1])}</span>
                              {ov.kitchen?.start && <div className="flex items-center gap-[2px]">
                                <span className="text-[length:8px] uppercase tracking-widest font-bold text-muted-foreground/60 w-[28px] shrink-0">{t("preferences:services.kitchenSubAbbr")}</span>
                                <Input type="time" value={ov.kitchen?.start || ""} onChange={(e) => updateServiceGroup(idx, (g) => {
                                  const d = { ...g.dayOverrides };
                                  d[dow] = { ...d[dow], kitchen: { start: e.target.value, end: d[dow]?.kitchen?.end || g.kitchen.end } };
                                  return { ...g, dayOverrides: d };
                                })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                <span className="text-muted-foreground text-[length:9px]">-</span>
                                <Input type="time" value={ov.kitchen?.end || ""} onChange={(e) => updateServiceGroup(idx, (g) => {
                                  const d = { ...g.dayOverrides };
                                  d[dow] = { ...d[dow], kitchen: { ...d[dow]?.kitchen, start: d[dow]?.kitchen?.start || g.kitchen.start, end: e.target.value } };
                                  return { ...g, dayOverrides: d };
                                })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                              </div>}
                              {ov.floor?.start && <div className="flex items-center gap-[2px]">
                                <span className="text-[length:8px] uppercase tracking-widest font-bold text-muted-foreground/60 w-[28px] shrink-0">{t("preferences:services.floorSubAbbr")}</span>
                                <Input type="time" value={ov.floor?.start || ""} onChange={(e) => updateServiceGroup(idx, (g) => {
                                  const d = { ...g.dayOverrides };
                                  d[dow] = { ...d[dow], floor: { start: e.target.value, end: d[dow]?.floor?.end || g.floor.end } };
                                  return { ...g, dayOverrides: d };
                                })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                <span className="text-muted-foreground text-[length:9px]">-</span>
                                <Input type="time" value={ov.floor?.end || ""} onChange={(e) => updateServiceGroup(idx, (g) => {
                                  const d = { ...g.dayOverrides };
                                  d[dow] = { ...d[dow], floor: { ...d[dow]?.floor, start: d[dow]?.floor?.start || g.floor.start, end: e.target.value } };
                                  return { ...g, dayOverrides: d };
                                })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                              </div>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
              <button type="button" onClick={addServiceGroup} className="flex items-center gap-[var(--space-xs)] bg-background text-foreground border border-foreground rounded-full px-[var(--space-md)] py-[4px] hover:bg-foreground hover:text-background transition-colors">
                <span className="text-[length:var(--text-lg)] leading-none">⊕</span>
                <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold">{t("preferences:services.addService")}</span>
              </button>
            </div>
          </>
        )}

        {/* ── Staffing Targets ── */}
        <div className="space-y-[var(--space-sm)]">
          <div className="flex items-start justify-between gap-[var(--space-lg)]">
            <div>
              <p className={labelClass}>{t("preferences:staffingTargets.title")}</p>
              <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">
                {staffProfiles.length > 1 ? t("preferences:staffingTargets.introMulti") : t("preferences:staffingTargets.introSingle")}
              </p>
            </div>
            {staffProfiles.length <= 1 && (
              <div className="flex flex-col items-end gap-[var(--space-sm)]">
                <p className={labelClass}>{t("preferences:staffingTargets.scheduleHeader")}</p>
                {staffProfiles.length === 1 && staffProfiles[0] && (
                  <div className="flex items-center gap-[var(--space-xs)]">
                    <button
                      type="button"
                      onClick={() => navigate(`/preferences/objectif/${staffProfiles[0].id}/titulaires`)}
                      className="relative flex items-center gap-[var(--space-xs)] uppercase tracking-widest font-bold border border-foreground/20 text-foreground rounded-full px-[var(--space-md)] py-[4px] hover:border-foreground/40 hover:bg-muted transition-colors"
                      title={t("preferences:staffingTargets.selectTitulairesTitle")}
                    >
                      <span className="text-[length:var(--text-xs)]">{t("preferences:staffingTargets.titulaireTeam")}</span>
                      {(titulaireReview[staffProfiles[0].id] ?? 0) > 0 && (
                        <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-[5px] rounded-full bg-red-500 text-white text-[length:10px] font-bold">
                          {titulaireReview[staffProfiles[0].id]}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate(`/preferences/objectif/${staffProfiles[0].id}`)}
                      className="flex items-center gap-[var(--space-xs)] uppercase tracking-widest font-bold border border-amber-500 bg-amber-500 text-white rounded-full px-[var(--space-md)] py-[4px] hover:bg-amber-600 hover:border-amber-600 transition-colors"
                      title={t("preferences:staffingTargets.calendarEdit")}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                      <span className="text-[length:var(--text-xs)]">{t("preferences:staffingTargets.calendarView")}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>



          {staffProfiles.map((profile, pIdx) => {
            const isNameMissing = staffProfilesNeedNames && !profile.name.trim();
            const isDuplicateName = staffProfilesNeedNames && profile.name.trim() !== "" && staffProfiles.some((p, i) => i !== pIdx && p.name.trim().toLowerCase() === profile.name.trim().toLowerCase());
            const profileGroups = getProfileServiceGroups(profile);
            const profileStaffingGroups = staffingZoneGroups(profileGroups, {
              kitchen: t("preferences:services.kitchenAbbr"),
              floor: t("preferences:services.floorAbbr"),
            });
            return (
              <div key={profile.id} className={cn(staffProfilesNeedNames && "border border-foreground/10 rounded-[0.2rem] p-[var(--space-md)] space-y-[var(--space-sm)]", "transition-opacity", deleteHoverIdx === pIdx && "opacity-40")}>
                {/* Profile header - name + delete */}
                {staffProfilesNeedNames && (
                  <div className="flex items-center gap-[var(--space-xs)]">
                    <span className="text-[length:var(--text-sm)] font-bold shrink-0">{t("preferences:staffingTargets.profileLabel")}</span>
                    <input
                      type="text"
                      value={profile.name}
                      onChange={(e) => updateProfileName(pIdx, e.target.value)}
                      placeholder={t("preferences:staffingTargets.profileNamePlaceholder")}
                      className={cn(
                        "text-[length:var(--text-sm)] font-bold bg-transparent border-b focus:border-foreground/60 focus:outline-none px-0 pr-2 [field-sizing:content] min-w-[4ch]",
                        (isNameMissing || isDuplicateName) ? "border-destructive" : "border-foreground/20"
                      )}
                    />
                    <div className="ml-auto flex items-center gap-[var(--space-xs)]">
                      <button
                        type="button"
                        onClick={() => navigate(`/preferences/objectif/${profile.id}/titulaires`)}
                        className="relative flex items-center gap-[var(--space-xs)] text-muted-foreground/60 hover:text-foreground transition-colors border border-foreground/15 rounded-full px-[var(--space-sm)] py-[2px] hover:border-foreground/30"
                        title={t("preferences:staffingTargets.selectTitulairesSimple")}
                      >
                        <span className="text-[length:var(--text-2xs)] font-bold">{t("preferences:staffingTargets.titulaireTeam")}</span>
                        {(titulaireReview[profile.id] ?? 0) > 0 && (
                          <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-[16px] px-[4px] rounded-full bg-red-500 text-white text-[length:9px] font-bold">
                            {titulaireReview[profile.id]}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(`/preferences/objectif/${profile.id}`)}
                        className="flex items-center gap-[var(--space-xs)] text-muted-foreground/40 hover:text-foreground transition-colors border border-foreground/15 rounded-full px-[var(--space-sm)] py-[2px] hover:border-foreground/30"
                        title={t("preferences:staffingTargets.calendarEdit")}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                        <span className="text-[length:var(--text-2xs)] font-bold">{t("preferences:staffingTargets.calendarViewSmall")}</span>
                      </button>
                    </div>
                    {staffProfiles.length > 1 && (
                      <button
                        type="button"
                        onMouseEnter={() => setDeleteHoverIdx(pIdx)}
                        onMouseLeave={() => setDeleteHoverIdx(null)}
                        onClick={() => {
                          if (window.confirm(t("preferences:staffingTargets.deleteProfileConfirm"))) removeStaffProfile(pIdx);
                          setDeleteHoverIdx(null);
                        }}
                        className="text-muted-foreground/40 hover:text-foreground transition-colors"
                        title={t("preferences:staffingTargets.deleteProfileTitle")}
                      ><X className="size-4" /></button>
                    )}
                    {dirtyProfileIds.has(profile.id) && (
                      <Button size="sm" onClick={handleSaveStaffTargets} disabled={staffTargetsSaving || !staffProfileNamesValid || hasDuplicateProfileNames}
                        className="h-5 px-[var(--space-sm)] uppercase tracking-widest text-[length:var(--text-2xs)] font-bold ml-[var(--space-xs)]">
                        {staffTargetsSaving ? t("preferences:actions.loadingShort") : t("preferences:profile.save")}
                      </Button>
                    )}
                  </div>
                )}

                {/* Per-profile service cards - expand/collapse (only when >1 profiles) */}
                {staffProfilesNeedNames && (() => {
                  const isFirst = pIdx === 0;
                  const isExpanded = isFirst || expandedProfileServices.has(profile.id);
                  const hasCustom = !!profile.serviceGroups;
                  return (
                    <div className="space-y-[var(--space-sm)]">
                      {/* First profile: always expanded, no toggle. Others: chevron toggle */}
                      {!isFirst && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!isExpanded && !hasCustom) {
                              setStaffProfiles(prev => prev.map((p, i) => i === pIdx ? { ...p, serviceGroups: serviceGroups.map(g => ({ ...g })) } : p));
                              markStaffProfileDirty(profile.id);
                            }
                            setExpandedProfileServices(prev => {
                              const next = new Set(prev);
                              if (next.has(profile.id)) next.delete(profile.id); else next.add(profile.id);
                              return next;
                            });
                          }}
                          className="flex items-center gap-[var(--space-xs)] text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ChevronDown className={cn("size-3 transition-transform", isExpanded ? "rotate-0" : "-rotate-90")} />
                          <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold">
                            {t("preferences:staffingTargets.customizeServices")}{hasCustom ? t("preferences:staffingTargets.customizedSuffix") : ""}
                          </span>
                        </button>
                      )}

                      {isExpanded && (
                        <div className="space-y-[var(--space-md)]">
                        <div className="flex flex-wrap items-start gap-[var(--space-md)]">
                          {profileGroups.map((group, gIdx) => {
                            const groupValid = isServiceGroupValid(group);
                            const isDupLabel = group.label.trim() !== "" && profileGroups.some((g, i) => i !== gIdx && g.label.trim().toLowerCase() === group.label.trim().toLowerCase());
                            const showError = dirtyProfileIds.has(profile.id) && (!groupValid || isDupLabel);
                            return (
                            <div key={gIdx} className={cn("space-y-[var(--space-xs)] min-w-[200px] transition-opacity border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)]", profileServiceHoverKey === `${pIdx}-${gIdx}` && "opacity-40")}>
                              <div className="flex items-center gap-[var(--space-xs)] pb-[var(--space-xs)]">
                                <span className="text-[length:var(--text-sm)] font-bold">{t("preferences:services.groupHeader")}</span>
                                <input
                                  type="text"
                                  value={group.label.toUpperCase()}
                                  onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, label: e.target.value.toLowerCase() }))}
                                  className={cn("text-[length:var(--text-sm)] font-bold bg-transparent border-b focus:border-foreground/60 focus:outline-none uppercase px-0 pr-2 [field-sizing:content] min-w-[2ch]", showError && (!group.label.trim() || isDupLabel) ? "border-destructive" : "border-foreground/20")}
                                />
                                {profileGroups.length > 1 && (
                                  <button
                                    type="button"
                                    onMouseEnter={() => setProfileServiceHoverKey(`${pIdx}-${gIdx}`)}
                                    onMouseLeave={() => setProfileServiceHoverKey(null)}
                                    onClick={() => {
                                      if (window.confirm(t("preferences:services.deleteConfirm"))) removeProfileServiceGroup(pIdx, gIdx);
                                      setProfileServiceHoverKey(null);
                                    }}
                                    className="text-muted-foreground/40 hover:text-foreground transition-colors"
                                    title={t("preferences:services.deleteTitle")}
                                  ><X className="size-3" /></button>
                                )}
                              </div>
                              <div className="flex items-center gap-[2px]">
                                <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground w-[68px] shrink-0">{t("preferences:services.kitchenAbbr")}</span>
                                <Input type="time" required value={group.kitchen.start} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, kitchen: { ...g.kitchen, start: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.kitchen.start && "border-destructive")} />
                                <span className="text-muted-foreground text-[length:10px]">-</span>
                                <Input type="time" required value={group.kitchen.end} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, kitchen: { ...g.kitchen, end: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.kitchen.end && "border-destructive")} />
                                {group.kitchen2 && <>
                                  <span className="text-muted-foreground text-[length:9px] mx-0.5">+</span>
                                  <Input type="time" required value={group.kitchen2.start} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, kitchen2: { ...g.kitchen2!, start: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                  <span className="text-muted-foreground text-[length:10px]">-</span>
                                  <Input type="time" required value={group.kitchen2.end} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, kitchen2: { ...g.kitchen2!, end: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                </>}
                              </div>
                              <div className="flex items-center gap-[2px]">
                                <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground w-[68px] shrink-0">{t("preferences:services.floorAbbr")}</span>
                                <Input type="time" required value={group.floor.start} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, floor: { ...g.floor, start: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.floor.start && "border-destructive")} />
                                <span className="text-muted-foreground text-[length:10px]">-</span>
                                <Input type="time" required value={group.floor.end} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, floor: { ...g.floor, end: e.target.value } }))} className={cn("border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center", showError && !group.floor.end && "border-destructive")} />
                                {group.floor2 && <>
                                  <span className="text-muted-foreground text-[length:9px] mx-0.5">+</span>
                                  <Input type="time" required value={group.floor2.start} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, floor2: { ...g.floor2!, start: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                  <span className="text-muted-foreground text-[length:10px]">-</span>
                                  <Input type="time" required value={group.floor2.end} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => ({ ...g, floor2: { ...g.floor2!, end: e.target.value } }))} className="border-foreground/20 bg-transparent text-[length:10px] h-6 px-0.5 w-[58px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                </>}
                              </div>
                              {/* Per-day overrides */}
                              <div className="pt-[var(--space-xs)]">
                                <button
                                  type="button"
                                  onClick={() => { const k = `p${pIdx}-${gIdx}`; setOverrideOpen(prev => ({ ...prev, [k]: !prev[k] })); }}
                                  className="text-[length:var(--text-2xs)] text-muted-foreground/60 hover:text-foreground transition-colors flex items-center gap-1"
                                >
                                  <span className="text-[length:9px]">{overrideOpen[`p${pIdx}-${gIdx}`] ? "▾" : "▸"}</span>
                                  {t("preferences:services.exceptions")}
                                  {group.dayOverrides && Object.keys(group.dayOverrides).length > 0 && (
                                    <span className="text-[length:var(--text-2xs)] text-foreground/60 font-bold">({Object.keys(group.dayOverrides).length})</span>
                                  )}
                                </button>
                                {overrideOpen[`p${pIdx}-${gIdx}`] && (
                                  <div className="mt-[var(--space-xs)] space-y-[3px]">
                                    <div className="flex gap-[3px] mb-[var(--space-xs)]">
                                      {DAY_LABEL_KEYS.map((labelKey, di) => {
                                        const dow = di + 1;
                                        const hasOverride = !!(group.dayOverrides?.[dow]?.kitchen || group.dayOverrides?.[dow]?.floor);
                                        return (
                                          <button
                                            key={dow}
                                            type="button"
                                            onClick={() => {
                                              if (hasOverride) {
                                                updateProfileServiceGroup(pIdx, gIdx, (g) => {
                                                  const ov = { ...g.dayOverrides };
                                                  delete ov[dow];
                                                  return { ...g, dayOverrides: Object.keys(ov).length > 0 ? ov : undefined };
                                                });
                                              } else {
                                                updateProfileServiceGroup(pIdx, gIdx, (g) => {
                                                  const ov = { ...g.dayOverrides };
                                                  ov[dow] = {
                                                    kitchen: { start: g.kitchen.start, end: g.kitchen.end },
                                                    floor: { start: g.floor.start, end: g.floor.end },
                                                  };
                                                  return { ...g, dayOverrides: ov };
                                                });
                                              }
                                            }}
                                            className={cn(
                                              "text-[length:9px] font-bold w-[28px] h-[18px] rounded-sm transition-colors",
                                              hasOverride
                                                ? "bg-foreground text-background"
                                                : "bg-muted text-muted-foreground hover:bg-muted-foreground/20"
                                            )}
                                          >
                                            {t(labelKey)}
                                          </button>
                                        );
                                      })}
                                    </div>
                                    {[1, 2, 3, 4, 5, 6, 7].filter(dow => group.dayOverrides?.[dow]).map(dow => {
                                      const ov = group.dayOverrides![dow]!;
                                      return (
                                        <div key={dow} className="space-y-[2px]">
                                          <span className="text-[length:9px] font-bold text-muted-foreground">{t(DAY_LABEL_KEYS[dow - 1])}</span>
                                          {ov.kitchen?.start && <div className="flex items-center gap-[2px]">
                                            <span className="text-[length:8px] uppercase tracking-widest font-bold text-muted-foreground/60 w-[28px] shrink-0">{t("preferences:services.kitchenSubAbbr")}</span>
                                            <Input type="time" value={ov.kitchen?.start || ""} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => {
                                              const d = { ...g.dayOverrides };
                                              d[dow] = { ...d[dow], kitchen: { start: e.target.value, end: d[dow]?.kitchen?.end || g.kitchen.end } };
                                              return { ...g, dayOverrides: d };
                                            })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                            <span className="text-muted-foreground text-[length:9px]">-</span>
                                            <Input type="time" value={ov.kitchen?.end || ""} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => {
                                              const d = { ...g.dayOverrides };
                                              d[dow] = { ...d[dow], kitchen: { ...d[dow]?.kitchen, start: d[dow]?.kitchen?.start || g.kitchen.start, end: e.target.value } };
                                              return { ...g, dayOverrides: d };
                                            })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                          </div>}
                                          {ov.floor?.start && <div className="flex items-center gap-[2px]">
                                            <span className="text-[length:8px] uppercase tracking-widest font-bold text-muted-foreground/60 w-[28px] shrink-0">{t("preferences:services.floorSubAbbr")}</span>
                                            <Input type="time" value={ov.floor?.start || ""} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => {
                                              const d = { ...g.dayOverrides };
                                              d[dow] = { ...d[dow], floor: { start: e.target.value, end: d[dow]?.floor?.end || g.floor.end } };
                                              return { ...g, dayOverrides: d };
                                            })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                            <span className="text-muted-foreground text-[length:9px]">-</span>
                                            <Input type="time" value={ov.floor?.end || ""} onChange={(e) => updateProfileServiceGroup(pIdx, gIdx, (g) => {
                                              const d = { ...g.dayOverrides };
                                              d[dow] = { ...d[dow], floor: { ...d[dow]?.floor, start: d[dow]?.floor?.start || g.floor.start, end: e.target.value } };
                                              return { ...g, dayOverrides: d };
                                            })} className="border-foreground/20 bg-transparent text-[length:9px] h-5 px-0.5 w-[52px] text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit-fields-wrapper]:p-0 [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center" />
                                          </div>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                            );
                          })}
                        </div>
                          <button type="button" onClick={() => addProfileServiceGroup(pIdx)} className="flex items-center gap-[var(--space-xs)] bg-background text-foreground border border-foreground rounded-full px-[var(--space-md)] py-[4px] hover:bg-foreground hover:text-background transition-colors">
                            <span className="text-[length:var(--text-lg)] leading-none">⊕</span>
                            <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold">{t("preferences:services.addService")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="overflow-x-auto">
                  <table className="w-full table-fixed border-collapse">
                    <colgroup>
                      <col />
                      {DAY_LABEL_KEYS.map((_, i) => <col key={i} style={{ width: 38 }} />)}
                    </colgroup>
                    <thead>
                      <tr>
                        <th className="text-left pr-[var(--space-sm)] pb-[var(--space-sm)]" />
                        {DAY_LABEL_KEYS.map((labelKey, i) => {
                          const day = i + 1;
                          const isOpen = !!openDays[String(day)];
                          return (
                            <th key={day} className="text-center pb-[var(--space-sm)]">
                              <button
                                type="button"
                                onClick={() => toggleDay(day)}
                                className={cn(
                                  "h-6 w-[36px] rounded-[0.2rem] border text-[length:var(--text-2xs)] uppercase tracking-widest font-bold transition-colors",
                                  isOpen
                                    ? "bg-foreground text-background border-foreground"
                                    : "bg-transparent text-muted-foreground/40 border-foreground/10 hover:border-foreground/30"
                                )}
                              >
                                {t(labelKey)}
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {profileStaffingGroups.map((zg, zgIdx) => (
                        <Fragment key={`${profile.id}_zone_${zg.zone}`}>
                          <tr>
                            <td colSpan={8} className={cn("py-[2px]", zgIdx > 0 && "pt-[var(--space-xs)]")}>
                              <div className="flex items-center gap-[var(--space-xs)]">
                                <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold">{zg.label}</span>
                                <span className="flex-1 border-b border-foreground/10" />
                                <span className="text-[length:var(--text-2xs)] text-muted-foreground font-mono">
                                  {zg.kitchenTimes} / {zg.floorTimes}
                                </span>
                              </div>
                            </td>
                          </tr>
                          {zg.rows.map((r) => {
                            const srKey = profile.id + "_" + r.role + "_" + r.zone;
                            return (<>
                            <tr key={srKey}>
                              <td className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground whitespace-nowrap pr-[var(--space-sm)] py-[2px]">
                                <button
                                  type="button"
                                  onClick={() => setExpandedSubRoles(prev => ({ ...prev, [srKey]: !prev[srKey] }))}
                                  className="flex items-center gap-0.5 hover:text-foreground transition-colors"
                                >
                                  {r.label}
                                  {expandedSubRoles[srKey]
                                    ? <ChevronDown className="w-3 h-3" />
                                    : <ChevronRight className="w-3 h-3" />}
                                </button>
                              </td>
                              {DAY_LABEL_KEYS.map((_, i) => {
                                const day = i + 1;
                                const isOpen = !!openDays[String(day)];
                                const key = `${day}_${r.role}_${r.zone}`;
                                const val = profile.targets[key] || 0;

                                if (!isOpen) {
                                  return (
                                    <td key={day} className="text-center py-[2px]">
                                      <span className="text-[length:var(--text-xs)] text-muted-foreground/20">-</span>
                                    </td>
                                  );
                                }

                                return (
                                  <td key={day} className="text-center py-[2px]">
                                    <input
                                      type="number"
                                      min={0}
                                      max={20}
                                      value={val || ""}
                                      placeholder="0"
                                      onChange={(e) => updateProfileTarget(pIdx, day, r.role, r.zone, parseInt(e.target.value) || 0)}
                                      className="w-[34px] h-6 text-center text-[length:11px] font-bold bg-transparent border border-foreground/15 rounded-[0.2rem] focus:border-foreground/40 focus:outline-none transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                            {expandedSubRoles[srKey] && (
                              (r.role === "kitchen" ? (prefs.kitchenSubRoles ?? []) : (prefs.floorSubRoles ?? [])).map(sr => (
                                <tr key={srKey + "_" + sr} className="text-muted-foreground/60">
                                  <td className="text-[length:var(--text-2xs)] pl-3 pr-[var(--space-sm)] py-[1px] whitespace-nowrap">{sr}</td>
                                  {DAY_LABEL_KEYS.map((_, i) => {
                                    const day = i + 1;
                                    const isOpen = !!openDays[String(day)];
                                    if (!isOpen) return <td key={day} className="text-center py-[1px]"><span className="text-[length:var(--text-xs)] text-muted-foreground/20">-</span></td>;
                                    const rbKey = day + "_" + r.role + "_" + r.zone;
                                    const rb = profile.roleBreakdowns[rbKey];
                                    const val = rb?.[sr] ?? 0;
                                    return <td key={day} className="text-center py-[1px]"><span className={cn("text-[length:var(--text-2xs)]", val > 0 ? "text-muted-foreground" : "text-muted-foreground/30")}>{val || "-"}</span></td>;
                                  })}
                                </tr>
                              ))
                            )}
                          </>);
                          })}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          {/* Add profile + save row */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={addStaffProfile}
              className="flex items-center gap-[var(--space-xs)] bg-background text-foreground border border-foreground rounded-full px-[var(--space-md)] py-[4px] hover:bg-foreground hover:text-background transition-colors"
            >
              <span className="text-[length:var(--text-lg)] leading-none">⊕</span>
              <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold">{t("preferences:staffingTargets.addProfile")}</span>
            </button>

            {staffTargetsDirty && !staffProfilesNeedNames && (
              <Button size="sm" onClick={handleSaveStaffTargets} disabled={staffTargetsSaving || !staffProfileNamesValid || hasDuplicateProfileNames}
                className="h-6 px-[var(--space-sm)] uppercase tracking-widest text-[length:var(--text-xs)] font-bold">
                {staffTargetsSaving ? t("preferences:actions.loadingShort") : t("preferences:staffingTargets.saveStaffing")}
              </Button>
            )}
          </div>
        </div>

      </div>}

      {/* ── Heures supplémentaires — policy (cap + routing) ── */}
      {prefTab === "regle" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className={labelClass}>{t("preferences:overtime.title")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("preferences:overtime.intro")}
        </p>
        <div className="space-y-[var(--space-sm)]">
        {/* Mode selector */}
        <div className="space-y-[var(--space-xs)]">
          <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("preferences:overtime.modeLabel")}</p>
          <div className="flex gap-[var(--space-xs)]">
            {([
              { value: "strict", label: t("preferences:overtime.modeStrictLabel"), desc: t("preferences:overtime.modeStrictDesc") },
              { value: "controlled", label: t("preferences:overtime.modeControlledLabel"), desc: t("preferences:overtime.modeControlledDesc") },
              { value: "flexible", label: t("preferences:overtime.modeFlexibleLabel"), desc: t("preferences:overtime.modeFlexibleDesc") },
            ] as const).map((opt) => {
              const active = (hoverOvertimeMode ?? prefs.overtimeMode) === opt.value;
              return (
              <button
                key={opt.value}
                type="button"
                onClick={() => updatePref("overtimeMode", opt.value)}
                onMouseEnter={() => setHoverOvertimeMode(opt.value)}
                onMouseLeave={() => setHoverOvertimeMode(null)}
                className={cn(
                  "flex-1 border rounded-[0.2rem] p-[var(--space-sm)] text-left transition-colors",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-foreground/15"
                )}
              >
                <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest block">{opt.label}</span>
                <span className={cn(
                  "text-[length:var(--text-xs)] block mt-[1px]",
                  active ? "opacity-70" : "text-muted-foreground"
                )}>{opt.desc}</span>
              </button>
            );
            })}
          </div>
        </div>

        {/* Weekly cap - only in controlled mode */}
        {prefs.overtimeMode === "controlled" && (
          <div className="space-y-[var(--space-xs)]">
            <div className="flex items-center justify-between">
              <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("preferences:overtime.capLabel")}</p>
              <span className="font-mono text-[length:var(--text-sm)] font-bold">{prefs.overtimeWeeklyCap}h</span>
            </div>
            <input
              type="range"
              min={39}
              max={48}
              step={1}
              value={prefs.overtimeWeeklyCap}
              onChange={(e) => updatePref("overtimeWeeklyCap", parseInt(e.target.value))}
              className="w-full accent-foreground"
            />
            <div className="flex justify-between text-[length:var(--text-2xs)] text-muted-foreground uppercase tracking-widest">
              <span>{t("preferences:overtime.tick39")}</span>
              <span className={cn(prefs.overtimeWeeklyCap <= 43 && "font-bold text-foreground")}>{t("preferences:overtime.tick43")}</span>
              <span className={cn(prefs.overtimeWeeklyCap > 43 && prefs.overtimeWeeklyCap <= 47 && "font-bold text-foreground")}>{t("preferences:overtime.tick47")}</span>
              <span className={cn(prefs.overtimeWeeklyCap === 48 && "font-bold text-foreground")}>{t("preferences:overtime.tick48")}</span>
            </div>
            <p className="text-[length:var(--text-xs)] text-muted-foreground">
              {prefs.overtimeWeeklyCap <= 39
                ? t("preferences:overtime.capExplanation39")
                : prefs.overtimeWeeklyCap <= 43
                  ? t("preferences:overtime.capExplanation110", { count: prefs.overtimeWeeklyCap - 39 })
                  : prefs.overtimeWeeklyCap <= 47
                    ? t("preferences:overtime.capExplanation120", { count: prefs.overtimeWeeklyCap - 43 })
                    : t("preferences:overtime.capExplanationMax")
              }
            </p>
          </div>
        )}

        {/* Distribution - not shown in strict */}
        {prefs.overtimeMode !== "strict" && (
          <div className="space-y-[var(--space-xs)]">
            <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("preferences:overtime.distributionLabel")}</p>
            <p className="text-[length:var(--text-xs)] text-muted-foreground">
              {t("preferences:overtime.distributionIntro")}
            </p>
            <div className="flex gap-[var(--space-xs)]">
              {([
                { value: "willing-first", label: t("preferences:overtime.distributionWillingLabel"), desc: t("preferences:overtime.distributionWillingDesc") },
                { value: "by-priority", label: t("preferences:overtime.distributionPriorityLabel"), desc: t("preferences:overtime.distributionPriorityDesc") },
                { value: "even", label: t("preferences:overtime.distributionEvenLabel"), desc: t("preferences:overtime.distributionEvenDesc") },
              ] as const).map((opt) => {
                const active = (hoverOvertimeDist ?? prefs.overtimeDistribution) === opt.value;
                return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => updatePref("overtimeDistribution", opt.value)}
                  onMouseEnter={() => setHoverOvertimeDist(opt.value)}
                  onMouseLeave={() => setHoverOvertimeDist(null)}
                  className={cn(
                    "flex-1 border rounded-[0.2rem] p-[var(--space-sm)] text-left transition-colors",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-foreground/15"
                  )}
                >
                  <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest block">{opt.label}</span>
                  <span className={cn(
                    "text-[length:var(--text-xs)] block mt-[1px]",
                    active ? "opacity-70" : "text-muted-foreground"
                  )}>{opt.desc}</span>
                </button>
              );
              })}
            </div>
          </div>
        )}
        </div>
      </div>}

      {/* ── Style d'optimisation — solver objective shaping ── */}
      {prefTab === "regle" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className={labelClass}>{t("preferences:optimizationStyle.title")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("preferences:optimizationStyle.intro")}
        </p>
        <div className="space-y-[var(--space-sm)]">
        <div className="space-y-[var(--space-xs)]">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-[var(--space-xs)]">
            {([
              { value: "equilibre", label: t("preferences:styleLabels.equilibre"), desc: t("preferences:optimizationStyle.equilibreDesc") },
              { value: "equipe-stable", label: t("preferences:styleLabels.equipe-stable"), desc: t("preferences:optimizationStyle.equipeStableDesc") },
              { value: "economique", label: t("preferences:styleLabels.economique"), desc: t("preferences:optimizationStyle.economiqueDesc") },
              { value: "resilience", label: t("preferences:styleLabels.resilience"), desc: t("preferences:optimizationStyle.resilienceDesc") },
            ] as const).map((opt) => {
              const active = (hoverPreferredStyle ?? prefs.preferredStyle) === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => updatePref("preferredStyle", opt.value)}
                  onMouseEnter={() => setHoverPreferredStyle(opt.value)}
                  onMouseLeave={() => setHoverPreferredStyle(null)}
                  className={cn(
                    "border rounded-[0.2rem] p-[var(--space-sm)] text-left transition-colors",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-foreground/15"
                  )}
                >
                  <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest block">{opt.label}</span>
                  <span className={cn(
                    "text-[length:var(--text-xs)] block mt-[1px]",
                    active ? "opacity-70" : "text-muted-foreground"
                  )}>{opt.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Réglage fin — per-dimension semantic sliders on top of the chosen preset */}
        <WeightSlidersSection
          presetName={prefs.preferredStyle}
          customWeights={prefs.customWeights}
          workerPreferencesEnabled={prefs.workerPreferencesEnabled}
          onChange={async (next) => {
            const prev = prefs.customWeights;
            setPrefs((p) => ({ ...p, customWeights: next }));
            try {
              await api.updatePreferences({ customWeights: next });
            } catch {
              setPrefs((p) => ({ ...p, customWeights: prev }));
              toast.error(t("preferences:errors.updateFailed"));
            }
          }}
        />
        </div>
      </div>}

      {/* ── Policies ── */}
      {prefTab === "regle" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-xs)]">
        <p className={labelClass}>{t("preferences:rules.title")}</p>
        <ToggleRow
          label={t("preferences:rules.medicalLabel")}
          description={t("preferences:rules.medicalDesc")}
          value={medicalMode}
          onChange={handleMedicalToggle}
        />
        <ToggleRow
          label={t("preferences:rules.preferencesLabel")}
          description={t("preferences:rules.preferencesDesc")}
          value={prefs.workerPreferencesEnabled}
          onChange={(v) => updatePref("workerPreferencesEnabled", v)}
        />
      </div>}

      {/* ── WhatsApp ── */}
      {prefTab === "regle" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-xs)]">
        <p className={labelClass}>{t("preferences:whatsapp.title")}</p>
        <ReminderSelector
          value={prefs.reminderFrequency}
          onChange={(v) => updatePref("reminderFrequency", v)}
        />
      </div>}

      {/* ── Time Tracking ── */}
      {prefTab === "regle" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className={labelClass}>{t("preferences:timeTracking.title")}</p>
        <ToggleRow
          label={t("preferences:timeTracking.tapInOutLabel")}
          description={prefs.tapInOutEnabled
            ? t("preferences:timeTracking.tapInOutOnDesc")
            : t("preferences:timeTracking.tapInOutOffDesc")}
          value={prefs.tapInOutEnabled}
          onChange={(v) => updatePref("tapInOutEnabled", v)}
        />
        {prefs.tapInOutEnabled && (
          <div className="pl-[var(--space-md)] border-l-2 border-foreground/15 space-y-[var(--space-sm)]">
            <ToggleRow
              label={t("preferences:timeTracking.adminConfirmLabel")}
              description={t("preferences:timeTracking.adminConfirmDesc")}
              value={prefs.tapInOutAdminConfirmation}
              onChange={(v) => updatePref("tapInOutAdminConfirmation", v)}
            />
            <div className="space-y-[var(--space-xs)]">
              <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest">{t("preferences:timeTracking.modeLabel")}</p>
              <div className="space-y-[var(--space-xs)]">
                {([
                  { value: "sync" as const, label: t("preferences:timeTracking.syncLabel"), desc: t("preferences:timeTracking.syncDesc") },
                  { value: "lateness_only" as const, label: t("preferences:timeTracking.latenessLabel"), desc: t("preferences:timeTracking.latenessDesc") },
                ]).map((opt) => {
                  const on = prefs.tapInOutMode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => updatePref("tapInOutMode", opt.value)}
                      className={cn(
                        "w-full flex items-start justify-between gap-[var(--space-md)] px-[var(--space-md)] py-[var(--space-sm)] border rounded-md text-left transition-colors",
                        on ? "bg-foreground/5 border-foreground" : "bg-transparent border-foreground/20 hover:border-foreground/40",
                      )}
                    >
                      <div>
                        <div className="text-[length:var(--text-xs)] font-bold tracking-tight">{opt.label}</div>
                        <div className="text-[length:var(--text-xs)] text-muted-foreground mt-[1px]">{opt.desc}</div>
                      </div>
                      <div className={cn("h-4 w-4 rounded-full border flex items-center justify-center shrink-0 mt-[var(--space-xs)]", on ? "bg-foreground border-foreground" : "border-foreground/30")}>
                        {on && <div className="h-2 w-2 rounded-full bg-background" />}
                      </div>
                    </button>
                  );
                })}
              </div>
              {prefs.tapInOutMode === "sync" && (
                <div className="pl-[var(--space-md)] border-l-2 border-foreground/15 pt-[var(--space-xs)]">
                  <ToggleRow
                    label={t("preferences:timeTracking.earlyTapLabel")}
                    description={t("preferences:timeTracking.earlyTapDesc")}
                    value={prefs.tapInCountsAsHours}
                    onChange={(v) => updatePref("tapInCountsAsHours", v)}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>}

      {/* ── Sub-role / Compétences mode ── */}
      {prefTab === "regle" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className={labelClass}>{t("preferences:subRoles.title")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("preferences:subRoles.intro")}
        </p>
        <div className="space-y-[var(--space-sm)]">
          <p className="text-[length:var(--text-xs)] text-muted-foreground/70 leading-relaxed">
            <Trans
              i18nKey="preferences:subRoles.explanation"
              components={{
                b1: <span className="font-bold text-muted-foreground" />,
                b2: <span className="font-bold text-muted-foreground" />,
              }}
            />
          </p>
          {(["kitchen", "floor"] as const).map(dept => {
            const label = dept === "kitchen" ? t("preferences:subRoles.kitchenLabel") : t("preferences:subRoles.floorLabel");
            const key = dept === "kitchen" ? "kitchenSubRoles" : "floorSubRoles";
            const roles = prefs[key] ?? [];
            return (
              <div key={dept}>
                <p className="text-[length:var(--text-xs)] font-bold mb-[var(--space-xs)]">{label}</p>
                <div className="space-y-1">
                  {roles.map((r, i) => (
                    <div key={i} className="flex items-center gap-[var(--space-xs)] group">
                      <input
                        type="text"
                        value={r}
                        onChange={(e) => {
                          const next = [...roles];
                          next[i] = e.target.value;
                          updatePref(key, next);
                        }}
                        className="text-[length:var(--text-sm)] bg-transparent border-b border-foreground/10 focus:border-foreground/40 focus:outline-none px-0 py-0.5 [field-sizing:content] min-w-[6ch]"
                      />
                      <button
                        type="button"
                        onClick={() => updatePref(key, roles.filter((_, j) => j !== i))}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => updatePref(key, [...roles, ""])}
                    className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t("preferences:subRoles.addButton")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>}

      {/* ── Taux horaires & Contrat ── */}
      {prefTab === "taux" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-lg)]">
        <div className="space-y-[var(--space-xs)]">
          <p className={labelClass}>{t("preferences:hcrGrid.title")}</p>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            <Trans
              i18nKey="preferences:hcrGrid.intro"
              components={{
                link1: <a href={LEGAL_LINKS.hcrConvention.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
                link2: <a href={LEGAL_LINKS.hcrSalaryGrid.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
              }}
            />
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-[var(--space-xs)]">
          {HCR_LEVELS.map((lvl) => {
            // Grid values are stored in cents; convert to euros for the input.
            const overrideCents = prefs.hcrGrid?.[lvl];
            const effectiveCents = typeof overrideCents === "number" ? overrideCents : HCR_GRID_2026[lvl];
            const isOverridden = typeof overrideCents === "number" && overrideCents !== HCR_GRID_2026[lvl];
            return (
              <label key={lvl} className="flex items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
                <span className="text-[length:var(--text-xs)] font-medium truncate">{HCR_LEVEL_LABELS[lvl]}</span>
                <div className="flex items-center gap-[var(--space-xs)]">
                  <span className="text-[length:var(--text-xs)] text-muted-foreground">€</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={(effectiveCents / 100).toFixed(2)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isFinite(v) || v < 0) return;
                      setPrefs((p) => ({ ...p, hcrGrid: { ...(p.hcrGrid ?? {}), [lvl]: Math.round(v * 100) } }));
                    }}
                    onBlur={async () => {
                      try { await api.updatePreferences({ hcrGrid: prefs.hcrGrid }); }
                      catch (err) { console.error(err); toast.error(t("preferences:hcrGrid.rateSaveFailed")); }
                    }}
                    className={cn(
                      "w-20 text-right text-[length:var(--text-sm)] font-mono bg-transparent border-b outline-none focus:border-foreground transition-colors",
                      isOverridden ? "border-foreground/40 font-semibold" : "border-foreground/10"
                    )}
                  />
                </div>
              </label>
            );
          })}
        </div>

        <button
          type="button"
          onClick={async () => {
            setPrefs((p) => ({ ...p, hcrGrid: {} }));
            try { await api.updatePreferences({ hcrGrid: {} }); toast.success(t("preferences:hcrGrid.resetSuccess")); }
            catch (err) { console.error(err); toast.error(t("preferences:hcrGrid.resetFailed")); }
          }}
          className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors"
        >
          {t("preferences:hcrGrid.resetButton")}
        </button>

        {/* Sub-role → niveau default mapping */}
        <div className="space-y-[var(--space-xs)] pt-[var(--space-md)]">
          <p className={labelClass}>{t("preferences:hcrGrid.subRoleMappingTitle")}</p>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            {t("preferences:hcrGrid.subRoleMappingIntro")}
          </p>
        </div>

        {(() => {
          const allSubroles = Array.from(new Set([...(prefs.kitchenSubRoles ?? []), ...(prefs.floorSubRoles ?? [])]));
          if (allSubroles.length === 0) {
            return <p className="text-[length:var(--text-xs)] italic text-muted-foreground">{t("preferences:hcrGrid.subRoleMappingEmpty")}</p>;
          }
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-xs)]">
              {allSubroles.map((sr) => {
                const current = prefs.subroleHcrMap?.[sr] ?? DEFAULT_SUBROLE_TO_HCR[sr] ?? "";
                return (
                  <label key={sr} className="flex items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
                    <span className="text-[length:var(--text-xs)] font-medium">{sr}</span>
                    <select
                      value={current}
                      onChange={async (e) => {
                        const v = e.target.value as HcrLevel | "";
                        const next = { ...(prefs.subroleHcrMap ?? {}) };
                        if (v) next[sr] = v; else delete next[sr];
                        setPrefs((p) => ({ ...p, subroleHcrMap: next }));
                        try { await api.updatePreferences({ subroleHcrMap: next }); }
                        catch (err) { console.error(err); toast.error(t("preferences:hcrGrid.subRoleMappingSaveFailed")); }
                      }}
                      className="text-[length:var(--text-xs)] bg-transparent border-b border-foreground/20 outline-none focus:border-foreground py-[2px]"
                    >
                      <option value="">—</option>
                      {HCR_LEVELS.map((lvl) => (
                        <option key={lvl} value={lvl}>{lvl} · {HCR_LEVEL_LABELS[lvl].split(" — ")[1] ?? lvl}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          );
        })()}

        {/* Contract defaults */}
        <div className="space-y-[var(--space-xs)] pt-[var(--space-md)]">
          <p className={labelClass}>{t("preferences:hcrGrid.contractDefaultsTitle")}</p>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            <Trans
              i18nKey="preferences:hcrGrid.contractDefaultsIntro"
              components={{
                link1: <a href={LEGAL_LINKS.cdi.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
                link2: <a href={LEGAL_LINKS.cdd.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
                link3: <a href={LEGAL_LINKS.cddSaisonnier.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
              }}
            />
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-sm)]">
          <label className="flex items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
            <span className="text-[length:var(--text-xs)] font-medium">{t("preferences:hcrGrid.contractTypeLabel")}</span>
            <select
              value={prefs.defaultContractType}
              onChange={async (e) => {
                const v = e.target.value as "CDI" | "CDD" | "saisonnier";
                setPrefs((p) => ({ ...p, defaultContractType: v }));
                try { await api.updatePreferences({ defaultContractType: v }); }
                catch (err) { console.error(err); toast.error(t("preferences:hcrGrid.subRoleMappingSaveFailed")); }
              }}
              className="text-[length:var(--text-xs)] bg-transparent border-b border-foreground/20 outline-none focus:border-foreground py-[2px]"
            >
              <option value="CDI">{t("preferences:hcrGrid.contractCDI")}</option>
              <option value="CDD">{t("preferences:hcrGrid.contractCDD")}</option>
              <option value="saisonnier">{t("preferences:hcrGrid.contractSaisonnier")}</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)] border-b border-foreground/10">
            <span className="text-[length:var(--text-xs)] font-medium">{t("preferences:hcrGrid.contractHoursLabel")}</span>
            <input
              type="number"
              min="1"
              max="48"
              value={prefs.defaultContractHours}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v) || v < 1 || v > 48) return;
                setPrefs((p) => ({ ...p, defaultContractHours: v }));
              }}
              onBlur={async () => {
                try { await api.updatePreferences({ defaultContractHours: prefs.defaultContractHours }); }
                catch (err) { console.error(err); toast.error(t("preferences:hcrGrid.subRoleMappingSaveFailed")); }
              }}
              className="w-16 text-right text-[length:var(--text-sm)] font-mono bg-transparent border-b border-foreground/20 outline-none focus:border-foreground"
            />
          </label>
        </div>
      </div>}

      {/* ── Compliance - Labor Law ── */}
      {prefTab === "conformite" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className={labelClass}>{t("preferences:compliance.title")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("preferences:compliance.intro")}
        </p>
        <p className="text-[length:var(--text-2xs)] text-muted-foreground space-x-2">
          <Trans
            i18nKey="preferences:compliance.sources"
            components={{
              link1: <a href={LEGAL_LINKS.hcrConvention.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
              link2: <a href={LEGAL_LINKS.workingTime.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
              link3: <a href={LEGAL_LINKS.restPeriods.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
              link4: <a href={LEGAL_LINKS.overtimeHcr.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground" />,
            }}
          />
        </p>
        <div className="space-y-[var(--space-xs)]">
          {complianceRules.filter(r => !['COMPTOIR-CHEF-01', 'COMPTOIR-OT-01'].includes(r.code)).map((rule) => {
            const disabled = (prefs.disabledComplianceRules || []).includes(rule.code);
            return (
              <div key={rule.code} className="space-y-[1px]">
                <div className="flex items-center gap-[var(--space-sm)]">
                  <button
                    type="button"
                    onClick={() => toggleComplianceRule(rule.code)}
                    className={cn(
                      "w-[14px] h-[14px] rounded-[0.15rem] border-2 flex items-center justify-center shrink-0 transition-colors",
                      disabled
                        ? "border-foreground/20 bg-transparent"
                        : "border-foreground bg-foreground",
                    )}
                  >
                    {!disabled && (
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-background">
                        <path d="M1 4L3 6L7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                  <span className={cn(
                    "text-[length:var(--text-sm)] font-bold shrink-0 transition-colors",
                    disabled && "text-muted-foreground line-through",
                  )}>
                    {rule.label}
                  </span>
                  <span className="flex-1 border-b border-dotted border-foreground/20" />
                  <span className="text-[length:var(--text-2xs)] font-bold uppercase tracking-widest text-muted-foreground shrink-0">
                    {rule.code}
                  </span>
                </div>
                <div className="pl-[22px] flex items-baseline gap-[var(--space-sm)]">
                  <p className={cn(
                    "text-[length:var(--text-xs)] text-muted-foreground flex-1",
                    disabled && "opacity-50",
                  )}>
                    {rule.description}
                  </p>
                  {rule.lawUrl && (
                    <a
                      href={rule.lawUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[length:var(--text-2xs)] font-bold uppercase tracking-widest text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                    >
                      {t("preferences:compliance.legifrance")} <ExternalLink className="size-3 inline" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>}

      {/* ── Color Scheme ── */}
      {prefTab === "profil" && <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className={labelClass}>{t("preferences:colors.title")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("preferences:colors.intro")}
        </p>
        <PalettePicker
          label={t("preferences:colors.kitchenLabel")}
          value={prefs.kitchenColor}
          onChange={(v) => {
            setColorPalettes(v, prefs.floorColor);
            updatePref("kitchenColor", v);
          }}
        />
        <PalettePicker
          label={t("preferences:colors.floorLabel")}
          value={prefs.floorColor}
          onChange={(v) => {
            setColorPalettes(prefs.kitchenColor, v);
            updatePref("floorColor", v);
          }}
        />
      </div>}

      {/* ── WhatsApp Demo (whatsapp tab, demo only) ── */}
      {prefTab === "whatsapp" && authUser?.restaurantStatus === "demo" && (
        <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-xs)]">
          <p className={labelClass}>{t("preferences:whatsapp.title")}</p>
          <Link
            to="/whatsapp-demo"
            className="inline-flex items-center gap-[var(--space-xs)] text-[length:var(--text-sm)] font-bold hover:underline underline-offset-4 transition-colors"
          >
            {t("preferences:whatsapp.testBot")}
            <span className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground">{t("preferences:whatsapp.demoBadge")}</span>
          </Link>
        </div>
      )}

      {/* ── Billing ── */}
      {prefTab === "profil" && <BillingSection />}

      {/* ── Shared workers ── */}
      {prefTab === "partage" && <WorkerSharesSection />}

      {/* ── AIDE TAB ── */}
      {prefTab === "aide" && (
        <div className="space-y-[var(--space-lg)]">

          {/* Contact form */}
          <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
            <p className={labelClass}>{t("preferences:help.title")}</p>
            <p className="text-[length:var(--text-xs)] text-muted-foreground">
              {t("preferences:help.restaurantLabel")} <span className="font-mono font-bold text-foreground">{authUser?.restaurantId}</span>
              {" · "}
              {t("preferences:help.adminLabel")} <span className="font-mono font-bold text-foreground">{authUser?.id}</span>
            </p>
            {!helpFocused && !helpMessage ? (
              <button
                type="button"
                onClick={() => setHelpFocused(true)}
                className="w-full text-left rounded-md border border-foreground/20 bg-white text-black dark:bg-white dark:text-black px-3 py-2 space-y-[var(--space-xs)] hover:border-foreground/30 transition-colors"
              >
                <p className="text-[length:var(--text-sm)] text-muted-foreground">
                  {t("preferences:help.intro")}
                </p>
                <p className="text-[length:var(--text-xs)] text-muted-foreground/60">
                  {t("preferences:help.details")}
                </p>
                <p className="text-[length:var(--text-xs)] text-muted-foreground/40 italic">{t("preferences:help.clickToWrite")}</p>
              </button>
            ) : (
              <div className="space-y-[var(--space-xs)]">
                <Input
                  placeholder={t("preferences:help.subjectPlaceholder")}
                  value={helpSubject}
                  onChange={(e) => setHelpSubject(e.target.value)}
                  className="border-foreground/20 bg-white text-black dark:bg-white dark:text-black h-8 text-[length:var(--text-sm)] placeholder:text-black/40"
                  autoFocus
                />
                <textarea
                  placeholder={t("preferences:help.messagePlaceholder")}
                  value={helpMessage}
                  onChange={(e) => setHelpMessage(e.target.value)}
                  onBlur={() => { if (!helpMessage.trim()) setHelpFocused(false); }}
                  rows={4}
                  className="w-full rounded-md border border-foreground/20 bg-white text-black dark:bg-white dark:text-black px-3 py-2 text-[length:var(--text-sm)] placeholder:text-black/40 focus:outline-none focus:border-foreground/40 resize-none"
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                const subject = encodeURIComponent(
                  t("preferences:help.subjectPrefix", {
                    subject: helpSubject || t("preferences:help.subjectDefault"),
                    restaurant: authUser?.restaurantName || authUser?.restaurantId,
                  })
                );
                const body = encodeURIComponent(
                  `${helpMessage}\n\n---\nRestaurant ID: ${authUser?.restaurantId}\nAdmin ID: ${authUser?.id}\nRestaurant: ${authUser?.restaurantName}`
                );
                window.location.href = `mailto:info@cosmobot.fr?subject=${subject}&body=${body}`;
                setHelpMessage("");
                setHelpSubject("");
                setHelpFocused(false);
              }}
              disabled={!helpMessage.trim()}
              className={cn(
                "text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                helpMessage.trim()
                  ? "border-green-600/50 text-green-600 hover:border-green-600 hover:bg-green-600/5"
                  : "border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              )}
            >
              {t("preferences:help.sendButton")}
            </button>
          </div>

          {/* Cron runs — last-run-per-job dashboard (Phase A of id:67f8) */}
          <CronRunsSection />

          {/* Audit log */}
          <div className="space-y-[var(--space-sm)]">
            <AuditLogPage />
          </div>

        </div>
      )}

    </div>
  );
}

/** Single calendar range picker - click trigger opens dropdown, pick start then end */
function DateRangePicker({
  label, start, end, onStartChange, onEndChange,
}: {
  label: string;
  start: string; end: string;
  onStartChange: (v: string) => void; onEndChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected: DateRange | undefined = start
    ? { from: parseDate(start), to: end ? parseDate(end) : undefined }
    : undefined;

  const handleDayClick = (day: Date) => {
    const dateStr = toISO(day);
    if (!start || (start && end)) {
      onStartChange(dateStr);
      onEndChange("");
    } else {
      if (dateStr < start) {
        onEndChange(start);
        onStartChange(dateStr);
      } else if (dateStr === start) {
        onEndChange(dateStr);
      } else {
        onEndChange(dateStr);
      }
      setTimeout(() => setOpen(false), 150);
    }
  };

  const triggerLabel = start
    ? end
      ? `${fmtDateShort(start)} → ${fmtDateShort(end)}`
      : `${fmtDateShort(start)} → ...`
    : t("preferences:closures.datePickerPlaceholder");

  return (
    <div className="relative space-y-[var(--space-xs)]" ref={ref}>
      {label && <Label className={fieldLabelClass}>{label}</Label>}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center h-8 px-3 border border-foreground/20 rounded-full text-[length:var(--text-sm)] bg-transparent hover:border-foreground/40 transition-colors whitespace-nowrap"
      >
        {start ? (
          <span>{triggerLabel}</span>
        ) : (
          <span className="text-muted-foreground">{triggerLabel}</span>
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 bg-background border border-border rounded-[0.3rem] shadow-lg">
          <Calendar
            mode="range"
            selected={selected}
            onDayClick={handleDayClick}
            numberOfMonths={2}
            defaultMonth={start ? parseDate(start) : new Date()}
            disabled={{ before: new Date() }}
          />
        </div>
      )}
    </div>
  );
}

function CronRunsSection() {
  const { t, i18n } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: qk.cron.runs(),
    queryFn: () => api.getCronRuns().then((r) => r.data),
    staleTime: 30_000,
  });

  if (isLoading) return null;

  const runs = data ?? [];
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  };
  const jobLabel = (name: string): string => {
    const key = `preferences:cronRuns.jobs.${name}`;
    const localized = t(key);
    return localized === key ? t("preferences:cronRuns.jobUnknown", { name }) : localized;
  };

  return (
    <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] space-y-[var(--space-sm)]">
      <p className={labelClass}>{t("preferences:cronRuns.heading")}</p>
      <p className="text-[length:var(--text-xs)] text-muted-foreground">
        {t("preferences:cronRuns.intro")}
      </p>
      {runs.length === 0 ? (
        <p className="text-[length:var(--text-sm)] text-muted-foreground/60 italic">
          {t("preferences:cronRuns.empty")}
        </p>
      ) : (
        <ul className="space-y-[var(--space-xs)]">
          {runs.map((r) => {
            const statusKey =
              r.status === "ok" ? "statusOk" : r.status === "error" ? "statusError" : "statusRunning";
            const statusClass =
              r.status === "ok"
                ? "text-green-600 border-green-600/40"
                : r.status === "error"
                ? "text-red-600 border-red-600/40"
                : "text-muted-foreground border-foreground/20";
            return (
              <li
                key={r.jobName}
                className="flex flex-wrap items-center gap-[var(--space-xs)] text-[length:var(--text-sm)]"
              >
                <span className="font-mono font-bold">{jobLabel(r.jobName)}</span>
                <span
                  className={cn(
                    "text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-xs)] py-[1px] rounded-full border",
                    statusClass,
                  )}
                >
                  {t(`preferences:cronRuns.${statusKey}`)}
                </span>
                <span className="text-[length:var(--text-xs)] text-muted-foreground">
                  {fmt(r.startedAt)}
                </span>
                {r.attempt > 1 && (
                  <span className="text-[length:var(--text-xs)] text-muted-foreground/60">
                    · {t("preferences:cronRuns.attempt", { n: r.attempt })}
                  </span>
                )}
                {r.durationMs != null && (
                  <span className="text-[length:var(--text-xs)] text-muted-foreground/60">
                    · {t("preferences:cronRuns.duration", { ms: r.durationMs })}
                  </span>
                )}
                {r.error && (
                  <span className="basis-full text-[length:var(--text-xs)] text-red-600 font-mono break-all">
                    {r.error}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
