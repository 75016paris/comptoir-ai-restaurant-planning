import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { api, type ProfileServiceTemplate, type StaffingProfile, type StaffingTarget } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { UnderlineNav } from "@/components/underline-nav";
import { ArrowLeft } from "lucide-react";
import { JOURS, JOURS_COURTS, fmtDateFR } from "@/lib/date-utils";

type TFn = ReturnType<typeof useTranslation>["t"];

// ── Constants ──
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 25; // 1am next day
const HOUR_HEIGHT = 40;
const SNAP = 15;
const MAX_COUNT = 12;
const DEFAULT_SUBROLE: Record<"kitchen" | "floor", string> = { kitchen: "Cuisinier", floor: "Serveur" };

// ── Types ──
type DayBlock = {
  id: string;
  name: string;
  role: "kitchen" | "floor";
  startMins: number;
  endMins: number;
  count: number;
  continuous?: boolean;
  coupureStartMins?: number; // when coupure begins (e.g. 14:30 → 870)
  coupureEndMins?: number;   // when coupure ends (e.g. 17:30 → 1050)
  roleBreakdown?: Record<string, number>; // {"Chef":1,"Cuisinier":2}
};

type DayState = DayBlock[];
type WeekState = Record<number, DayState>; // 1-7

// ── Helpers ──
let _nextId = 0;
function uid() { return `b${++_nextId}_${Date.now().toString(36)}`; }

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toMins(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function toTime(mins: number): string {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function snapMins(mins: number): number {
  return Math.round(mins / SNAP) * SNAP;
}
function shiftLabel(t: TFn, startMins: number, endMins: number, continuous?: boolean): string {
  if (continuous) {
    if (startMins < 11 * 60 && endMins > 20 * 60) return t("calendar.shiftLabels.coupure");
    if (startMins < 11 * 60) return t("calendar.shiftLabels.coupureMorning");
    if (endMins > 22 * 60) return t("calendar.shiftLabels.coupureEvening");
    return t("calendar.shiftLabels.coupure");
  }
  const mid = (startMins + endMins) / 2;
  if (endMins <= 6 * 60 || startMins >= 22 * 60) return t("calendar.shiftLabels.night");
  if (mid < 11 * 60) return t("calendar.shiftLabels.morning");
  if (mid < 15 * 60) return t("calendar.shiftLabels.midday");
  if (mid < 19 * 60) return t("calendar.shiftLabels.afternoon");
  return t("calendar.shiftLabels.evening");
}

function uniqueName(base: string, role: "kitchen" | "floor", dayBlocks: DayBlock[], excludeId?: string): string {
  const taken = new Set(dayBlocks.filter(b => b.role === role && b.id !== excludeId).map(b => b.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function breakdownTotal(breakdown: Record<string, number> | undefined): number {
  return Object.values(breakdown || {}).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
}

function minimumBreakdown(role: "kitchen" | "floor", breakdown: Record<string, number> | undefined, count: number, subRoles: string[]): Record<string, number> {
  if (breakdownTotal(breakdown) > 0) return breakdown || {};
  return { [subRoles[0] || DEFAULT_SUBROLE[role]]: Math.max(1, count || 1) };
}

function changeBreakdownValue(
  role: "kitchen" | "floor",
  breakdown: Record<string, number> | undefined,
  count: number,
  subRoles: string[],
  subRole: string,
  delta: -1 | 1,
): Record<string, number> {
  const next = { ...minimumBreakdown(role, breakdown, count, subRoles) };
  const current = next[subRole] || 0;
  const total = breakdownTotal(next);
  if (delta < 0) {
    // A service block means at least one person is needed. To set it to zero,
    // delete the block instead of decrementing the last remaining post.
    if (current <= 0 || total <= 1) return next;
    if (current <= 1) delete next[subRole];
    else next[subRole] = current - 1;
    return next;
  }
  if (total >= MAX_COUNT) return next;
  next[subRole] = current + 1;
  return next;
}
function pxFromMins(mins: number, startHour: number): number {
  return ((mins - startHour * 60) / 60) * HOUR_HEIGHT;
}
function minsFromPx(px: number, startHour: number): number {
  return snapMins(startHour * 60 + (px / HOUR_HEIGHT) * 60);
}
function computeBlockBounds(week: WeekState): { startHour: number; endHour: number } {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const day of Object.values(week)) {
    for (const b of day) {
      if (b.startMins < minStart) minStart = b.startMins;
      let endM = b.endMins;
      if (endM <= b.startMins) endM += 24 * 60;
      if (endM > maxEnd) maxEnd = endM;
    }
  }
  if (!isFinite(minStart) || !isFinite(maxEnd)) {
    return { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR };
  }
  return {
    startHour: (minStart - 30) / 60,
    endHour: (maxEnd + 30) / 60,
  };
}
function hourMarks(startHour: number, endHour: number): number[] {
  const marks: number[] = [];
  for (let h = Math.ceil(startHour); h <= Math.floor(endHour); h++) marks.push(h);
  return marks;
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function fmtDuration(startMins: number, endMins: number): string {
  let d = endMins - startMins;
  if (d <= 0) d += 24 * 60;
  const h = Math.floor(d / 60);
  const m = d % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

// ── Palette card colors ──
// ── Overlap layout: split overlapping blocks side-by-side ──
type LayoutSlot = { block: DayBlock; col: number; span: number; totalCols: number };

function layoutOverlaps(blocks: DayBlock[], role: "kitchen" | "floor"): LayoutSlot[] {
  const filtered = blocks.filter(b => b.role === role);
  if (filtered.length === 0) return [];

  // Sort by start time, then by longer duration first
  const sorted = [...filtered].sort((a, b) => {
    if (a.startMins !== b.startMins) return a.startMins - b.startMins;
    const durA = (a.endMins <= a.startMins ? a.endMins + 24 * 60 : a.endMins) - a.startMins;
    const durB = (b.endMins <= b.startMins ? b.endMins + 24 * 60 : b.endMins) - b.startMins;
    return durB - durA;
  });

  // Build overlap groups (connected components of overlapping blocks)
  const endOf = (b: DayBlock) => b.endMins <= b.startMins ? b.endMins + 24 * 60 : b.endMins;

  const groups: DayBlock[][] = [];
  let current: DayBlock[] = [];
  let groupEnd = 0;

  for (const b of sorted) {
    if (current.length === 0 || b.startMins < groupEnd) {
      current.push(b);
      groupEnd = Math.max(groupEnd, endOf(b));
    } else {
      groups.push(current);
      current = [b];
      groupEnd = endOf(b);
    }
  }
  if (current.length > 0) groups.push(current);

  // Assign columns within each group using greedy column packing
  const result: LayoutSlot[] = [];
  for (const group of groups) {
    const cols: number[] = []; // cols[i] = end time of the latest block in column i
    const assignments = new Map<string, number>();

    for (const b of group) {
      let placed = -1;
      for (let c = 0; c < cols.length; c++) {
        if (b.startMins >= cols[c]) {
          placed = c;
          break;
        }
      }
      if (placed === -1) {
        placed = cols.length;
        cols.push(0);
      }
      cols[placed] = endOf(b);
      assignments.set(b.id, placed);
    }

    const totalCols = cols.length;
    for (const b of group) {
      result.push({ block: b, col: assignments.get(b.id)!, span: 1, totalCols });
    }
  }

  return result;
}

const ROLE_COLORS = {
  kitchen: {
    bg: "bg-amber-500/15",
    border: "border-amber-500/40",
    text: "text-amber-600 dark:text-amber-400",
    accent: "bg-amber-500",
    badge: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
    countBg: "bg-amber-500/10",
    dot: "bg-amber-500",
    handleBg: "bg-amber-500/25",
  },
  floor: {
    bg: "bg-sky-500/15",
    border: "border-sky-500/40",
    text: "text-sky-600 dark:text-sky-400",
    accent: "bg-sky-500",
    badge: "bg-sky-500/20 text-sky-700 dark:text-sky-300",
    countBg: "bg-sky-500/10",
    dot: "bg-sky-500",
    handleBg: "bg-sky-500/25",
  },
} as const;

export function ObjectifCalendarPage() {
  const { t } = useTranslation("objectif");
  const { profileId: rawProfileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const copyFromId = searchParams.get("copy");
  const targetWeek = searchParams.get("week");
  const fromOnboarding = searchParams.get("fromOnboarding") === "1";
  const isNew = rawProfileId === "new";
  const [realId] = useState(() => isNew ? genId() : rawProfileId!);
  const profileId = realId;

  const [profileName, setProfileName] = useState("");
  const [titulairesNeedReview, setTitulairesNeedReview] = useState(0);
  const [week, setWeek] = useState<WeekState>(() => {
    const w: WeekState = {};
    for (let d = 1; d <= 7; d++) w[d] = [];
    return w;
  });
  const { startHour, endHour } = useMemo(() => computeBlockBounds(week), [week]);
  const totalHours = endHour - startHour;
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(isNew);
  const [editingName, setEditingName] = useState(isNew);
  const [editPopup, setEditPopup] = useState<{ day: number; blockId: string; rect: DOMRect } | null>(null);
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [namePromptValue, setNamePromptValue] = useState("");
  type HcrWarning = { kind: "amplitude" | "coupure"; value: string };
  const [warningPopup, setWarningPopup] = useState<{ warnings: HcrWarning[]; rect: DOMRect } | null>(null);
  const [dayMissingPopup, setDayMissingPopup] = useState<{ day: number; missing: "kitchen" | "floor"; rect: DOMRect } | null>(null);
  const [priorityHelpPopup, setPriorityHelpPopup] = useState<{ rect: DOMRect } | null>(null);
  const [activeRole, setActiveRole] = useState<"floor" | "kitchen">("floor");
  const [copySource, setCopySource] = useState<number | null>(null);
  const [sortOrder, setSortOrder] = useState(0);
  const [dayPriorities, setDayPriorities] = useState<Record<string, number>>({});

  const [kitchenSubRoles, setKitchenSubRoles] = useState<string[]>([]);
  const [floorSubRoles, setSalleSubRoles] = useState<string[]>([]);

  const savedRef = useRef<{
    profiles: StaffingProfile[];
    targets: StaffingTarget[];
    profileTemplates: ProfileServiceTemplate[];
  } | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const queryClient = useQueryClient();
  const loadQuery = useQuery({
    queryKey: qk.staffing.calendarLoad(profileId),
    queryFn: async () => {
      const [targetsRes, openDaysRes, templatesRes, prefsRes] = await Promise.all([
        api.getStaffingTargets(),
        api.getOpenDays(),
        api.getServiceTemplates(),
        api.getPreferences(),
      ]);
      return { targetsRes, openDaysRes, templatesRes, prefsRes };
    },
    enabled: !!profileId,
  });

  useEffect(() => {
    if (loadQuery.error) { toast.error(t("calendar.toast.loadError")); setLoading(false); }
  }, [loadQuery.error, t]);

  useEffect(() => {
    if (!profileId || !loadQuery.data) return;
    const { targetsRes, openDaysRes, templatesRes, prefsRes } = loadQuery.data;
    {
      setKitchenSubRoles(prefsRes.data.kitchenSubRoles || []);
      setSalleSubRoles(prefsRes.data.floorSubRoles || []);
      const { profiles, targets, profileTemplates = [] } = targetsRes.data;

      if (isNew) {
        const maxOrder = profiles.reduce((m, p) => Math.max(m, p.sortOrder), 0);
        savedRef.current = { profiles, targets, profileTemplates };
        setSortOrder(maxOrder + 1);

        const sourceId = copyFromId;
        const sourceProfile = sourceId ? profiles.find(p => p.id === sourceId) : null;

        if (sourceProfile) {
          // Copy from existing profile
          setProfileName(t("calendar.names.temporary"));
          setEditingName(true);
          if (sourceProfile.dayPriorities) {
            setDayPriorities(typeof sourceProfile.dayPriorities === "string" ? JSON.parse(sourceProfile.dayPriorities) : sourceProfile.dayPriorities);
          }

          const pTpls = profileTemplates.filter(t => t.profileId === sourceId);
          const rawTpls = (pTpls.length > 0 ? pTpls : templatesRes.data).filter(t => t.startTime && t.endTime);
          const profileTargets = targets.filter(t => t.profileId === sourceId);
          const newWeek: WeekState = {};
          for (let d = 1; d <= 7; d++) newWeek[d] = [];
          for (const tpl of rawTpls) {
            for (let d = 1; d <= 7; d++) {
              const target = profileTargets.find(t => t.dayOfWeek === d && t.role === tpl.role && t.zone === tpl.zone);
              const count = target?.count ?? 0;
              if (count <= 0) continue;
              const override = tpl.overrides?.find(o => o.dayOfWeek === d);
              const startMins = override ? toMins(override.startTime) : toMins(tpl.startTime);
              const endMins = override ? toMins(override.endTime) : toMins(tpl.endTime);
              newWeek[d].push({
                id: uid(),
                name: tpl.zone,
                role: tpl.role,
                startMins,
                endMins,
                count,
                roleBreakdown: target?.roleBreakdown && typeof target.roleBreakdown === "string"
                  ? JSON.parse(target.roleBreakdown) : target?.roleBreakdown || undefined,
              });
            }
          }
          setWeek(newWeek);
        } else {
          // Truly new — empty planning
          const newWeek: WeekState = {};
          for (let d = 1; d <= 7; d++) newWeek[d] = [];
          setWeek(newWeek);
        }
      } else {
        savedRef.current = { profiles, targets, profileTemplates };

        const p = profiles.find(p => p.id === profileId);
        if (!p) {
          toast.error(t("calendar.toast.profileNotFound"));
          navigate("/preferences", { replace: true });
          return;
        }
        setProfileName(p.name);
        if (p.dayPriorities) {
          setDayPriorities(typeof p.dayPriorities === "string" ? JSON.parse(p.dayPriorities) : p.dayPriorities);
        }

        // Build per-day blocks from existing data
        const pTpls = profileTemplates.filter(t => t.profileId === profileId);
        const rawTpls = (pTpls.length > 0 ? pTpls : templatesRes.data)
          .filter(t => t.startTime && t.endTime);
        const profileTargets = targets.filter(t => t.profileId === profileId);

        const newWeek: WeekState = {};
        for (let d = 1; d <= 7; d++) newWeek[d] = [];

        for (const tpl of rawTpls) {
          for (let d = 1; d <= 7; d++) {
            const target = profileTargets.find(
              t => t.dayOfWeek === d && t.role === tpl.role && t.zone === tpl.zone
            );
            const count = target?.count ?? 0;
            if (count <= 0) continue;

            const override = tpl.overrides?.find(o => o.dayOfWeek === d);
            const startMins = override ? toMins(override.startTime) : toMins(tpl.startTime);
            const endMins = override ? toMins(override.endTime) : toMins(tpl.endTime);

            newWeek[d].push({
              id: uid(),
              name: tpl.zone,
              role: tpl.role,
              startMins,
              endMins,
              count,
              roleBreakdown: target?.roleBreakdown && typeof target.roleBreakdown === "string"
                ? JSON.parse(target.roleBreakdown)
                : target?.roleBreakdown || undefined,
            });
          }
        }

        // Merge pairs of blocks with same zone+role into continuous blocks
        for (let d = 1; d <= 7; d++) {
          const blocks = newWeek[d];
          const merged: DayBlock[] = [];
          const used = new Set<string>();
          // Sort by start time to find pairs
          const sorted = [...blocks].sort((a, b) => a.startMins - b.startMins);
          for (let i = 0; i < sorted.length; i++) {
            if (used.has(sorted[i].id)) continue;
            const a = sorted[i];
            // Look for a matching block with same zone+role (later in the day)
            const partner = sorted.find((b, j) =>
              j > i && !used.has(b.id) && b.name === a.name && b.role === a.role && b.count === a.count
            );
            if (partner) {
              // Merge into continuous block
              used.add(a.id);
              used.add(partner.id);
              merged.push({
                id: a.id,
                name: a.name,
                role: a.role,
                startMins: a.startMins,
                endMins: partner.endMins,
                count: a.count,
                continuous: true,
                coupureStartMins: a.endMins,
                coupureEndMins: partner.startMins,
                roleBreakdown: a.roleBreakdown,
              });
            } else {
              used.add(a.id);
              merged.push(a);
            }
          }
          newWeek[d] = merged;
        }

        setWeek(newWeek);
      }

      const boolDays: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(openDaysRes.data)) boolDays[k] = !!v;
      setOpenDays(boolDays);

      setLoading(false);
    }
  }, [profileId, loadQuery.data, t, isNew, copyFromId, navigate]);

  // Pull titulaire-review count for the badge (independent of the main load).
  const titulairesQuery = useQuery({
    queryKey: qk.staffing.titulaires(profileId ?? ""),
    queryFn: async () => (await api.getProfileTitulaires(profileId!)).data,
    enabled: !!profileId && !isNew,
  });
  useEffect(() => {
    if (titulairesQuery.data) setTitulairesNeedReview(titulairesQuery.data.needsReview);
  }, [titulairesQuery.data]);

  // ── Save ──
  const handleSave = useCallback(async (opts?: { weekOnly?: boolean; nameOverride?: string }) => {
    if (!savedRef.current || !profileId) return;
    const saveName = opts?.nameOverride || profileName;
    if (!saveName.trim()) {
      toast.error(t("calendar.toast.nameRequired"));
      setEditingName(true);
      return;
    }
    // If name is still the temporary placeholder, prompt user
    if (isNew && copyFromId && saveName.trim() === t("calendar.names.temporary") && !opts?.weekOnly) {
      setNamePromptValue("");
      setShowNamePrompt(true);
      return;
    }
    setSaving(true);
    try {
      const { profiles, targets: allTargets, profileTemplates: allPT } = savedRef.current;

      // For new profiles, add to list; for existing, update name
      const existsInProfiles = profiles.some(p => p.id === profileId);
      // When adding a 2nd profile, existing profiles with empty names need a default
      // (API requires all profiles to have names when there are 2+)
      const namedProfiles = profiles.map(p => ({ ...p, name: p.name.trim() || t("calendar.names.standard") }));
      const updatedProfiles = existsInProfiles
        ? namedProfiles.map(p => p.id === profileId ? { ...p, name: saveName, dayPriorities } : p)
        : [...namedProfiles, { id: profileId, name: saveName, sortOrder, dayPriorities }];

      // Collect unique (name, role) groups across all days
      // Each group → one or two ProfileServiceTemplates
      // Continuous blocks produce TWO templates (morning + evening) with the same zone name
      // Use first day with that group as base time, others as overrides
      type GroupEntry = {
        name: string;
        role: "kitchen" | "floor";
        baseDow: number;
        baseStart: number;
        baseEnd: number;
        skipTargets?: boolean; // true for evening half of continuous blocks (targets already emitted by morning half)
        days: { dow: number; startMins: number; endMins: number; count: number; roleBreakdown?: Record<string, number> }[];
      };
      const groups = new Map<string, GroupEntry>();

      for (let d = 1; d <= 7; d++) {
        for (const block of week[d]) {
          if (block.continuous && block.coupureStartMins != null && block.coupureEndMins != null) {
            // Continuous block → two groups: morning + evening with suffixed keys
            const morningKey = `${block.name}__${block.role}__morning`;
            const eveningKey = `${block.name}__${block.role}__evening`;
            if (!groups.has(morningKey)) {
              groups.set(morningKey, {
                name: block.name,
                role: block.role,
                baseDow: d,
                baseStart: block.startMins,
                baseEnd: block.coupureStartMins,
                days: [],
              });
            }
            groups.get(morningKey)!.days.push({
              dow: d,
              startMins: block.startMins,
              endMins: block.coupureStartMins,
              count: block.count,
              roleBreakdown: block.roleBreakdown,
            });
            if (!groups.has(eveningKey)) {
              groups.set(eveningKey, {
                name: block.name,
                role: block.role,
                baseDow: d,
                baseStart: block.coupureEndMins,
                baseEnd: block.endMins,
                skipTargets: true,
                days: [],
              });
            }
            groups.get(eveningKey)!.days.push({
              dow: d,
              startMins: block.coupureEndMins,
              endMins: block.endMins,
              count: block.count,
              roleBreakdown: block.roleBreakdown,
            });
          } else {
            // Classic block → one group
            const key = `${block.name}__${block.role}`;
            if (!groups.has(key)) {
              groups.set(key, {
                name: block.name,
                role: block.role,
                baseDow: d,
                baseStart: block.startMins,
                baseEnd: block.endMins,
                days: [],
              });
            }
            const grp = groups.get(key)!;
            const existingDay = grp.days.find(dd => dd.dow === d);
            if (existingDay) {
              // Merge: keep the higher count (same zone+role+day, e.g. coupure morning+evening)
              // Don't duplicate — the count is already correct from the original target
            } else {
              grp.days.push({
                dow: d,
                startMins: block.startMins,
                endMins: block.endMins,
                count: block.count,
                roleBreakdown: block.roleBreakdown,
              });
            }
          }
        }
      }

      const zoneOrders = new Map<string, number>();
      let nextZoneOrder = 1;
      const newPT: ProfileServiceTemplate[] = [];
      const newTargets: StaffingTarget[] = [];

      for (const [, g] of groups) {
        if (!zoneOrders.has(g.name)) zoneOrders.set(g.name, nextZoneOrder++);
        const so = zoneOrders.get(g.name)!;
        const overrides = g.days
          .filter(dd => dd.startMins !== g.baseStart || dd.endMins !== g.baseEnd)
          .map(dd => ({
            dayOfWeek: dd.dow,
            startTime: toTime(dd.startMins),
            endTime: toTime(dd.endMins),
          }));

        newPT.push({
          profileId,
          role: g.role,
          zone: g.name,
          startTime: toTime(g.baseStart),
          endTime: toTime(g.baseEnd),
          sortOrder: so,
          overrides: overrides.length > 0 ? overrides : undefined,
        });

        if (!g.skipTargets) {
          for (const dd of g.days) {
            if (dd.count > 0) {
              newTargets.push({
                profileId,
                dayOfWeek: dd.dow,
                role: g.role,
                zone: g.name,
                count: dd.count,
                roleBreakdown: dd.roleBreakdown,
              } as StaffingTarget);
            }
          }
        }
      }

      const mergedPT = [...allPT.filter(t => t.profileId !== profileId), ...newPT];
      const mergedTargets = [...allTargets.filter(t => t.profileId !== profileId), ...newTargets];

      // Derive openDays from which days have blocks
      const derivedOpenDays: Record<string, "both" | "midi" | "soir"> = {};
      for (let d = 1; d <= 7; d++) {
        if ((week[d]?.length ?? 0) > 0) {
          derivedOpenDays[String(d)] = "both";
        }
      }

      const [res] = await Promise.all([
        api.updateStaffingTargets(updatedProfiles, mergedTargets, mergedPT),
        api.updateOpenDays(derivedOpenDays),
      ]);
      savedRef.current = {
        profiles: res.data.profiles,
        targets: res.data.targets,
        profileTemplates: res.data.profileTemplates ?? [],
      };
      // Sync local openDays with what was saved
      const boolDays: Record<string, boolean> = {};
      for (const k of Object.keys(derivedOpenDays)) boolDays[k] = true;
      setOpenDays(boolDays);
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: qk.staffing.targets() });
      queryClient.invalidateQueries({ queryKey: qk.settings.openDays() });
      // If week-only (temporary profile), assign to target week and go back
      if (opts?.weekOnly && targetWeek) {
        const wd = new Date(targetWeek + "T12:00:00");
        const thu = new Date(wd); thu.setDate(wd.getDate() - ((wd.getDay() + 6) % 7) + 3);
        const year = thu.getFullYear();
        const jan1 = new Date(year, 0, 1);
        const weekNum = Math.ceil((Math.round((thu.getTime() - jan1.getTime()) / 86400000) + 1) / 7);
        await api.updateStaffingSchedule([{ profileId, year, week: weekNum }]);
        toast(t("calendar.toast.appliedWeek"));
        navigate("/schedule", { replace: true });
      } else {
        toast(t("calendar.toast.saved"));
        if (isNew) {
          navigate(`/preferences/objectif/${profileId}`, { replace: true });
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("calendar.toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [week, profileId, profileName, isNew, sortOrder, dayPriorities, copyFromId, targetWeek, t, queryClient, navigate]);

  // ── Drag state ──
  const dragRef = useRef<{
    type: "palette" | "move" | "resize-top" | "resize-bottom" | "resize-right" | "resize-coupure-top" | "resize-coupure-bottom" | "resize-coupure-move";
    role?: "kitchen" | "floor";
    continuous?: boolean;
    day: number;
    blockId?: string;
    startY: number;
    startX: number;
    origStart: number;
    origEnd: number;
    origCount: number;
    colWidth: number;
    altKey?: boolean;
  } | null>(null);

  const [dragGhost, setDragGhost] = useState<{
    day: number;
    startMins: number;
    endMins: number;
    role: "kitchen" | "floor";
    count: number;
    continuous?: boolean;
    coupureStartMins?: number;
    coupureEndMins?: number;
  } | null>(null);

  // Get day column from x position
  const getDayFromX = useCallback((clientX: number): number | null => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const colWidth = rect.width / 7;
    const day = Math.floor(x / colWidth) + 1;
    return day >= 1 && day <= 7 ? day : null;
  }, []);

  // Palette drag start
  const onPaletteDragStart = useCallback((e: React.PointerEvent, role: "kitchen" | "floor", continuous?: boolean) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      type: "palette",
      role,
      continuous: !!continuous,
      day: 0,
      startY: e.clientY,
      startX: e.clientX,
      origStart: 0,
      origEnd: 0,
      origCount: 1,
      colWidth: gridRef.current ? gridRef.current.getBoundingClientRect().width / 7 : 100,
    };
  }, []);

  // Block interaction start
  const onBlockPointerDown = useCallback((
    e: React.PointerEvent,
    day: number,
    blockId: string,
    mode: "move" | "resize-top" | "resize-bottom" | "resize-right" | "resize-coupure-top" | "resize-coupure-bottom" | "resize-coupure-move"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const block = week[day].find(b => b.id === blockId);
    if (!block) return;
    dragRef.current = {
      type: mode,
      day,
      blockId,
      startY: e.clientY,
      startX: e.clientX,
      // For coupure resize/move, use coupure bounds as origStart/origEnd
      origStart: (mode === "resize-coupure-top" || mode === "resize-coupure-bottom" || mode === "resize-coupure-move")
                 ? (block.coupureStartMins ?? block.startMins) : block.startMins,
      origEnd: (mode === "resize-coupure-top" || mode === "resize-coupure-bottom" || mode === "resize-coupure-move")
               ? (block.coupureEndMins ?? block.endMins) : block.endMins,
      origCount: block.count,
      colWidth: gridRef.current ? gridRef.current.getBoundingClientRect().width / 7 : 100,
      altKey: e.altKey,
    };
  }, [week]);

  // Global pointer move
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;

    if (d.type === "palette") {
      // Show ghost on calendar
      const day = getDayFromX(e.clientX);
      if (!day || !gridRef.current) { setDragGhost(null); return; }
      const rect = gridRef.current.getBoundingClientRect();
      const relY = e.clientY - rect.top + gridRef.current.scrollTop;
      const mins = minsFromPx(relY, startHour);
      if (d.continuous) {
        // Continuous: 13h amplitude, coupure depends on role (salle 1h30, cuisine 2h)
        const coupureMins = d.role === "kitchen" ? 120 : 90;
        const workBeforeCoupure = (780 - coupureMins) / 2; // split work evenly around coupure
        const startMins = clamp(mins - 390, startHour * 60, endHour * 60 - 780);
        setDragGhost({
          day,
          startMins,
          endMins: startMins + 780, // 13h amplitude
          role: d.role!,
          count: 1,
          continuous: true,
          coupureStartMins: startMins + workBeforeCoupure,
          coupureEndMins: startMins + workBeforeCoupure + coupureMins,
        });
      } else {
        // Classique: 8h shift
        const startMins = clamp(mins - 240, startHour * 60, endHour * 60 - 480);
        setDragGhost({
          day,
          startMins,
          endMins: startMins + 480, // 8h
          role: d.role!,
          count: 1,
        });
      }
      return;
    }

    const dy = e.clientY - d.startY;
    const dx = e.clientX - d.startX;
    const deltaMins = snapMins((dy / HOUR_HEIGHT) * 60);

    if (d.type === "move") {
      const dur = d.origEnd - d.origStart;
      const ns = clamp(snapMins(d.origStart + deltaMins), startHour * 60, endHour * 60 - dur);
      setWeek(prev => {
        const dayBlocks = [...prev[d.day]];
        const idx = dayBlocks.findIndex(b => b.id === d.blockId);
        if (idx < 0) return prev;
        const block = dayBlocks[idx];
        const newName = shiftLabel(t, ns, ns + dur, block.continuous);
        dayBlocks[idx] = { ...block, startMins: ns, endMins: ns + dur, name: uniqueName(newName, block.role, dayBlocks, block.id) };
        return { ...prev, [d.day]: dayBlocks };
      });
      // Cross-day visual feedback: when cursor enters a different column, render a ghost there.
      const targetDay = getDayFromX(e.clientX);
      const block = week[d.day]?.find(b => b.id === d.blockId);
      if (targetDay && targetDay !== d.day && block) {
        setDragGhost({
          day: targetDay,
          startMins: ns,
          endMins: ns + dur,
          role: block.role,
          count: block.count,
          ...(block.continuous ? {
            continuous: true,
            coupureStartMins: block.coupureStartMins,
            coupureEndMins: block.coupureEndMins,
          } : {}),
        });
      } else if (dragGhost) {
        setDragGhost(null);
      }
    } else if (d.type === "resize-top") {
      const ns = clamp(snapMins(d.origStart + deltaMins), startHour * 60, d.origEnd - SNAP * 2);
      setWeek(prev => {
        const dayBlocks = [...prev[d.day]];
        const idx = dayBlocks.findIndex(b => b.id === d.blockId);
        if (idx < 0) return prev;
        const block = dayBlocks[idx];
        const newName = shiftLabel(t, ns, block.endMins, block.continuous);
        dayBlocks[idx] = { ...block, startMins: ns, name: uniqueName(newName, block.role, dayBlocks, block.id) };
        return { ...prev, [d.day]: dayBlocks };
      });
    } else if (d.type === "resize-bottom") {
      const ne = clamp(snapMins(d.origEnd + deltaMins), d.origStart + SNAP * 2, endHour * 60);
      setWeek(prev => {
        const dayBlocks = [...prev[d.day]];
        const idx = dayBlocks.findIndex(b => b.id === d.blockId);
        if (idx < 0) return prev;
        const block = dayBlocks[idx];
        const newName = shiftLabel(t, block.startMins, ne, block.continuous);
        dayBlocks[idx] = { ...block, endMins: ne, name: uniqueName(newName, block.role, dayBlocks, block.id) };
        return { ...prev, [d.day]: dayBlocks };
      });
    } else if (d.type === "resize-right") {
      // Horizontal drag → change worker count
      const deltaCount = Math.round(dx / 16); // 16px per worker (narrower half-columns)
      const nc = clamp(d.origCount + deltaCount, 1, MAX_COUNT);
      setWeek(prev => {
        const dayBlocks = [...prev[d.day]];
        const idx = dayBlocks.findIndex(b => b.id === d.blockId);
        if (idx < 0) return prev;
        dayBlocks[idx] = { ...dayBlocks[idx], count: nc };
        return { ...prev, [d.day]: dayBlocks };
      });
    } else if (d.type === "resize-coupure-top") {
      // Move coupure start up/down
      setWeek(prev => {
        const dayBlocks = [...prev[d.day]];
        const idx = dayBlocks.findIndex(b => b.id === d.blockId);
        if (idx < 0) return prev;
        const block = dayBlocks[idx];
        if (!block.continuous || block.coupureEndMins == null) return prev;
        // origStart stores the original coupureStartMins
        const ns = clamp(snapMins(d.origStart + deltaMins), block.startMins + SNAP * 2, block.coupureEndMins - SNAP);
        dayBlocks[idx] = { ...block, coupureStartMins: ns };
        return { ...prev, [d.day]: dayBlocks };
      });
    } else if (d.type === "resize-coupure-bottom") {
      // Move coupure end up/down
      setWeek(prev => {
        const dayBlocks = [...prev[d.day]];
        const idx = dayBlocks.findIndex(b => b.id === d.blockId);
        if (idx < 0) return prev;
        const block = dayBlocks[idx];
        if (!block.continuous || block.coupureStartMins == null) return prev;
        // origEnd stores the original coupureEndMins
        const ne = clamp(snapMins(d.origEnd + deltaMins), block.coupureStartMins + SNAP, block.endMins - SNAP * 2);
        dayBlocks[idx] = { ...block, coupureEndMins: ne };
        return { ...prev, [d.day]: dayBlocks };
      });
    } else if (d.type === "resize-coupure-move") {
      // Move entire coupure window up/down (preserve duration)
      const duration = d.origEnd - d.origStart;
      setWeek(prev => {
        const dayBlocks = [...prev[d.day]];
        const idx = dayBlocks.findIndex(b => b.id === d.blockId);
        if (idx < 0) return prev;
        const block = dayBlocks[idx];
        if (!block.continuous) return prev;
        // Clamp so coupure stays within work block bounds
        let ns = snapMins(d.origStart + deltaMins);
        ns = clamp(ns, block.startMins + SNAP * 2, block.endMins - SNAP * 2 - duration);
        dayBlocks[idx] = { ...block, coupureStartMins: ns, coupureEndMins: ns + duration };
        return { ...prev, [d.day]: dayBlocks };
      });
    }
  }, [getDayFromX, startHour, endHour, dragGhost, t, week]);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;

    if (d.type === "palette" && dragGhost) {
      // Drop new block on calendar
      const day = dragGhost.day;
      // Auto-open the day if it was closed — dropping a service implies the gérant wants it open.
      if (!openDays[String(day)]) {
        setOpenDays(prev => ({ ...prev, [String(day)]: true }));
      }
      {
        setWeek(prev => {
          const dayBlocks = prev[day];
          const baseName = shiftLabel(t, dragGhost.startMins, dragGhost.endMins, dragGhost.continuous);
          const name = uniqueName(baseName, dragGhost.role, dayBlocks);
          const newBlock: DayBlock = {
            id: uid(),
            name,
            role: dragGhost.role,
            startMins: dragGhost.startMins,
            endMins: dragGhost.endMins,
            count: 1,
            roleBreakdown: minimumBreakdown(dragGhost.role, undefined, 1, dragGhost.role === "kitchen" ? kitchenSubRoles : floorSubRoles),
            ...(dragGhost.continuous ? {
              continuous: true,
              coupureStartMins: dragGhost.coupureStartMins,
              coupureEndMins: dragGhost.coupureEndMins,
            } : {}),
          };
          return { ...prev, [day]: [...dayBlocks, newBlock] };
        });
        setDirty(true);
      }
      setDragGhost(null);
    } else if (d.type === "move" && d.blockId) {
      // Cross-day move/copy: drop on a different day column duplicates (alt) or moves (no alt).
      const targetDay = getDayFromX(e.clientX);
      const alt = e.altKey || !!d.altKey;
      if (targetDay && targetDay !== d.day) {
        if (!openDays[String(targetDay)]) {
          setOpenDays(prev => ({ ...prev, [String(targetDay)]: true }));
        }
        setWeek(prev => {
          const originBlocks = [...(prev[d.day] || [])];
          const idx = originBlocks.findIndex(b => b.id === d.blockId);
          if (idx < 0) return prev;
          const draggedBlock = originBlocks[idx];
          const targetBlocks = [...(prev[targetDay] || [])];
          const baseName = shiftLabel(t, draggedBlock.startMins, draggedBlock.endMins, draggedBlock.continuous);
          const newBlock: DayBlock = {
            ...draggedBlock,
            id: uid(),
            name: uniqueName(baseName, draggedBlock.role, targetBlocks),
          };
          targetBlocks.push(newBlock);
          if (alt) {
            // Copy: restore origin block to its pre-drag time so origin is unchanged.
            const origName = shiftLabel(t, d.origStart, d.origEnd, draggedBlock.continuous);
            originBlocks[idx] = {
              ...draggedBlock,
              startMins: d.origStart,
              endMins: d.origEnd,
              name: uniqueName(origName, draggedBlock.role, originBlocks.filter((_, i) => i !== idx), draggedBlock.id),
            };
            return { ...prev, [d.day]: originBlocks, [targetDay]: targetBlocks };
          }
          // Move: delete from origin.
          originBlocks.splice(idx, 1);
          if (originBlocks.length === 0) {
            setOpenDays(o => ({ ...o, [String(d.day)]: false }));
          }
          return { ...prev, [d.day]: originBlocks, [targetDay]: targetBlocks };
        });
      }
      setDragGhost(null);
      setDirty(true);
    } else if (d.type !== "palette") {
      setDirty(true);
    }

    dragRef.current = null;
  }, [dragGhost, openDays, getDayFromX, kitchenSubRoles, floorSubRoles, t]);

  // Attach global listeners
  useEffect(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  // ── Block operations ──
  const updateRoleBreakdown = useCallback((day: number, blockId: string, subRole: string, delta: -1 | 1) => {
    setWeek(prev => ({
      ...prev,
      [day]: prev[day].map(block => {
        if (block.id !== blockId) return block;
        const subRoles = block.role === "kitchen" ? kitchenSubRoles : floorSubRoles;
        const roleBreakdown = changeBreakdownValue(block.role, block.roleBreakdown, block.count, subRoles, subRole, delta);
        return { ...block, roleBreakdown, count: breakdownTotal(roleBreakdown) };
      }),
    }));
    setDirty(true);
  }, [kitchenSubRoles, floorSubRoles]);

  const deleteBlock = useCallback((day: number, blockId: string) => {
    setWeek(prev => {
      const next = { ...prev, [day]: prev[day].filter(b => b.id !== blockId) };
      // If the day is now empty across both roles, close it automatically.
      if (next[day].length === 0) {
        setOpenDays(o => ({ ...o, [String(day)]: false }));
      }
      return next;
    });
    setDirty(true);
  }, []);



  // ── Toggle day open/closed ──
  const toggleDay = useCallback((day: number) => {
    setOpenDays(prev => {
      const wasOpen = !!prev[String(day)];
      if (wasOpen) {
        // Close day → clear blocks
        setWeek(w => ({ ...w, [day]: [] }));
        const next = { ...prev };
        delete next[String(day)];
        return next;
      } else {
        // Open day
        return { ...prev, [String(day)]: true };
      }
    });
    setDirty(true);
  }, []);

  // ── Copy day ──
  const handleCopyDay = useCallback((targetDay: number) => {
    if (copySource === null || copySource === targetDay) {
      setCopySource(null);
      return;
    }
    setWeek(prev => ({
      ...prev,
      [targetDay]: prev[copySource].map(b => ({ ...b, id: uid() })),
    }));
    setCopySource(null);
    setDirty(true);
    toast(t("calendar.copyDay.toast", { from: JOURS[copySource % 7], to: JOURS[targetDay % 7] }));
  }, [copySource, t]);

  // ── Loading / error states ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground text-[length:var(--text-sm)]">{t("shared.loading")}</p>
      </div>
    );
  }

  return (
    <div className="pb-8">
      {/* ── Header ── */}
      <div className="flex items-center gap-[var(--space-md)] mb-[var(--space-lg)]">
        <button
          type="button"
          onClick={() => navigate(fromOnboarding ? "/onboarding/services" : "/preferences")}
          className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-[var(--space-xs)]"
        >
          <ArrowLeft className="size-3" />
          <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold">{fromOnboarding ? t("calendar.back.onboarding") : t("calendar.back.preferences")}</span>
        </button>
        <span className="text-muted-foreground/30">/</span>

        {/* Editable objective name */}
        {editingName ? (
          <input
            ref={nameInputRef}
            className="text-[length:var(--text-sm)] font-bold bg-transparent border-b border-foreground/30 outline-none px-1 py-0"
            value={profileName}
            onChange={e => { setProfileName(e.target.value); setDirty(true); }}
            onBlur={() => setEditingName(false)}
            onKeyDown={e => { if (e.key === "Enter") setEditingName(false); }}
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(true)}
            className="text-[length:var(--text-sm)] font-bold hover:text-foreground/70 transition-colors flex items-center gap-[var(--space-xs)]"
            title={t("calendar.header.renameTitle")}
          >
            {profileName || t("calendar.header.untitled")}
            <svg className="w-3 h-3 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        )}

        {!fromOnboarding && (
          <button
            type="button"
            onClick={() => navigate(`/preferences/objectif/${profileId}/titulaires`)}
            className="ml-auto inline-flex items-center gap-[var(--space-xs)] h-7 px-[var(--space-md)] rounded-full border border-foreground/20 text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors relative"
            title={t("calendar.header.titulairesButton")}
          >
            {t("calendar.header.titulairesButton")}
            {titulairesNeedReview > 0 && (
              <span
                className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-[5px] rounded-full bg-red-500 text-white text-[length:10px] font-bold"
                title={t("calendar.header.titulairesNeedReview", { count: titulairesNeedReview })}
              >
                {titulairesNeedReview}
              </span>
            )}
          </button>
        )}
        {dirty && (
          <Button
            size="sm"
            onClick={() => handleSave()}
            disabled={saving}
            className={(fromOnboarding ? "ml-auto " : "") + "h-7 px-[var(--space-md)] uppercase tracking-widest text-[length:var(--text-xs)] font-bold"}
          >
            {saving ? t("shared.savePending") : t("shared.save")}
          </Button>
        )}
        {fromOnboarding && (() => {
          const salleHasBlocks = Object.values(week).some((blocks) => blocks.some((b) => b.role === "floor"));
          const kitchenHasBlocks = Object.values(week).some((blocks) => blocks.some((b) => b.role === "kitchen"));
          // If user is already on the cuisine tab, they've consciously visited it — don't gate on it.
          const needsCuisineNudge = salleHasBlocks && !kitchenHasBlocks && activeRole !== "kitchen";
          const label = !salleHasBlocks
            ? t("calendar.header.continueOnboarding")
            : needsCuisineNudge
            ? t("calendar.header.continueKitchen")
            : t("calendar.header.continueTitulaires");
          const tooltip = !salleHasBlocks ? t("calendar.header.needsFloorTooltip") : undefined;
          return (
            <Button
              size="sm"
              title={tooltip}
              onClick={async () => {
                if (!salleHasBlocks) return;
                if (dirty) await handleSave();
                if (needsCuisineNudge) {
                  setActiveRole("kitchen");
                  return;
                }
                navigate(`/preferences/objectif/${profileId}/titulaires?fromOnboarding=1`);
              }}
              disabled={saving || !salleHasBlocks}
              className={(dirty ? "" : "ml-auto ") + "h-7 px-[var(--space-md)] uppercase tracking-widest text-[length:var(--text-xs)] font-bold"}
            >
              {label}
            </Button>
          );
        })()}
      </div>

      {/* ── Role tabs (h2-style with animated underline) ── */}
      <div className="flex items-center gap-[var(--space-lg)] mb-[var(--space-lg)]">
        <UnderlineNav
          items={[
            { value: "floor", label: t("calendar.tabs.floor") },
            { value: "kitchen", label: t("calendar.tabs.kitchen") },
          ]}
          value={activeRole}
          onChange={(v) => setActiveRole(v as "floor" | "kitchen")}
          gapClassName="gap-[var(--space-lg)]"
          itemClassName="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight pb-[4px]"
          inactiveClassName="text-muted-foreground/40 hover:text-muted-foreground"
          barClassName="h-[3px]"
        />

        <button
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setPriorityHelpPopup(prev => prev ? null : { rect });
          }}
          className="inline-flex items-center gap-1 text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground hover:text-foreground transition-colors"
          title={t("calendar.priority.tooltip")}
        >
          <span>{t("calendar.priority.label")}</span>
          <span className="inline-flex items-center justify-center w-[14px] h-[14px] rounded-full border border-current text-[10px] leading-none">?</span>
        </button>

        {/* Palette: drag cards for active role */}
        <div className="flex items-center gap-[var(--space-sm)] ml-auto">
          <span className="text-[length:var(--text-2xs)] text-muted-foreground uppercase tracking-widest font-bold">
            {t("calendar.palette.drag")}
          </span>
          {(() => {
            const c = ROLE_COLORS[activeRole];
            return (
              <>
                <div
                  className={cn(
                    "flex items-center gap-[var(--space-sm)] px-[var(--space-md)] py-[var(--space-sm)]",
                    "rounded-lg border-2 border-dashed cursor-grab active:cursor-grabbing select-none",
                    "transition-all hover:scale-[1.02] active:scale-[0.98]",
                    c.border, c.bg
                  )}
                  onPointerDown={e => onPaletteDragStart(e, activeRole)}
                >
                  <div className={cn("w-2 h-2 rounded-full", c.dot)} />
                  <span className={cn("text-[length:var(--text-xs)] font-bold", c.text)}>{t("calendar.palette.classic")}</span>
                </div>
                <div
                  className={cn(
                    "flex items-center gap-[var(--space-sm)] px-[var(--space-md)] py-[var(--space-sm)]",
                    "rounded-lg border-2 border-dashed cursor-grab active:cursor-grabbing select-none",
                    "transition-all hover:scale-[1.02] active:scale-[0.98]",
                    c.border, c.bg
                  )}
                  onPointerDown={e => onPaletteDragStart(e, activeRole, true)}
                >
                  <div className="flex flex-col gap-[1px]">
                    <div className={cn("w-2 h-1 rounded-sm", c.dot)} />
                    <div className="w-2 h-[2px]" />
                    <div className={cn("w-2 h-1 rounded-sm", c.dot)} />
                  </div>
                  <span className={cn("text-[length:var(--text-xs)] font-bold", c.text)}>{t("calendar.palette.coupure")}</span>
                </div>
              </>
            );
          })()}
        </div>

        {copySource !== null && (
          <span className="text-[length:var(--text-xs)] text-muted-foreground animate-pulse">
            {t("calendar.copyDay.instruction", { day: JOURS_COURTS[copySource % 7] })}
          </span>
        )}
      </div>

      {/* ── Calendar grid ── */}
      <div className="border border-border rounded-lg overflow-hidden bg-card overflow-x-auto">
      <div className="min-w-[720px]">

        {/* Day header row */}
        <div
          className="sticky top-0 z-30 bg-card border-b border-border flex"
        >
          <div className="w-[52px] shrink-0 border-r border-border" />
          <div className="flex-1 grid" style={{ gridTemplateColumns: "repeat(7, 1fr)" }}>
          {[1,2,3,4,5,6,7].map((day) => {
            const dayLong = JOURS[day % 7];
            const dayShort = JOURS_COURTS[day % 7];
            const isOpen = !!openDays[String(day)];
            const isCopySource = copySource === day;
            const isCopyTarget = copySource !== null && copySource !== day;
            return (
              <div
                key={day}
                className={cn(
                  "border-r border-border last:border-r-0 text-center relative",
                  !isOpen && "opacity-40",
                  isCopyTarget && "cursor-pointer bg-primary/5 hover:bg-primary/10 transition-colors",
                  isCopySource && "ring-2 ring-inset ring-primary/40",
                )}
                onClick={() => isCopyTarget ? handleCopyDay(day) : undefined}
              >
                {/* Priority row (separate from day name) */}
                {isOpen && (() => {
                  const cur = dayPriorities[String(day)] ?? 1;
                  const allPrios = [1,2,3,4,5,6,7].filter(dd => dd !== day && openDays[String(dd)]).map(dd => dayPriorities[String(dd)] ?? 1);
                  const maxUsed = Math.max(1, ...allPrios);
                  const canGoDown = cur < 7 && cur <= maxUsed;
                  const canGoUp = cur > 1;
                  return (
                    <div className="group/prio flex items-center justify-center gap-[2px] pt-[var(--space-xs)] pb-[2px] border-b border-border/40">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canGoUp) return;
                          const next = cur - 1;
                          const updated = { ...dayPriorities, [String(day)]: next };
                          if (next === 1) delete updated[String(day)];
                          setDayPriorities(updated);
                          setDirty(true);
                        }}
                        className={cn(
                          "text-[length:14px] font-bold leading-none opacity-0 group-hover/prio:opacity-100 transition-opacity py-[1px] px-[2px]",
                          canGoUp ? "text-muted-foreground hover:text-foreground cursor-pointer" : "text-muted-foreground/20 cursor-default",
                        )}
                        title={canGoUp ? t("calendar.priority.raise") : ""}
                      >+</button>
                      <span
                        className={cn(
                          "text-[length:10px] font-bold rounded px-[5px] py-[1px] leading-tight select-none",
                          cur === 1 && "bg-foreground text-background",
                          cur === 2 && "bg-foreground/10 text-muted-foreground",
                          cur >= 3 && "bg-transparent text-muted-foreground/40 border border-foreground/10",
                        )}
                      >{t("calendar.priority.value", { n: cur })}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canGoDown) return;
                          const next = cur + 1;
                          const updated = { ...dayPriorities, [String(day)]: next };
                          if (next === 1) delete updated[String(day)];
                          setDayPriorities(updated);
                          setDirty(true);
                        }}
                        className={cn(
                          "text-[length:14px] font-bold leading-none opacity-0 group-hover/prio:opacity-100 transition-opacity py-[1px] px-[2px]",
                          canGoDown ? "text-muted-foreground hover:text-foreground cursor-pointer" : "text-muted-foreground/20 cursor-default",
                        )}
                        title={canGoDown ? t("calendar.priority.lower") : ""}
                      >-</button>
                    </div>
                  );
                })()}

                {/* Day name + toggle + copy + warning */}
                <div className="relative flex items-center justify-center gap-1 py-[var(--space-sm)] px-[var(--space-xs)]">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleDay(day); }}
                    className={cn(
                      "text-[length:var(--text-xs)] font-bold tracking-wide transition-colors",
                      isOpen ? "hover:text-muted-foreground" : "hover:text-foreground"
                    )}
                    title={isOpen ? t("calendar.day.closeTitle", { day: dayShort }) : t("calendar.day.openTitle", { day: dayShort })}
                  >
                    <span className="hidden sm:inline">{dayLong}</span>
                    <span className="sm:hidden">{dayShort}</span>
                  </button>
                  {!isOpen && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleDay(day); }}
                      className="text-[length:var(--text-2xs)] text-muted-foreground uppercase tracking-widest hover:text-foreground transition-colors cursor-pointer"
                    >
                      {t("calendar.day.closed")}
                    </button>
                  )}
                  {isOpen && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setCopySource(prev => prev === day ? null : day); }}
                      className={cn(
                        "text-[length:var(--text-2xs)] text-muted-foreground/40 hover:text-foreground transition-colors",
                        isCopySource && "text-primary"
                      )}
                      title={isCopySource ? t("calendar.copyDay.cancel") : t("calendar.copyDay.copyTitle", { day: dayShort })}
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    </button>
                  )}
                  {isOpen && (() => {
                    const dayBlocks = week[day] || [];
                    const hasKitchen = dayBlocks.some((b) => b.role === "kitchen");
                    const hasSalle = dayBlocks.some((b) => b.role === "floor");
                    if (dayBlocks.length === 0 || (hasKitchen && hasSalle)) return null;
                    const missing: "kitchen" | "floor" = hasKitchen ? "floor" : "kitchen";
                    return (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setDayMissingPopup(prev => prev && prev.day === day ? null : { day, missing, rect });
                        }}
                        className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-amber-500 text-white text-[length:11px] font-black leading-none shadow-sm hover:bg-amber-600 transition-colors"
                        aria-label={missing === "kitchen" ? t("calendar.missing.badgeKitchen") : t("calendar.missing.badgeFloor")}
                      >!</button>
                    );
                  })()}
                </div>

              </div>
            );
          })}
          </div>
        </div>

        {/* Time grid + blocks */}
        <div className="flex overflow-auto" style={{ maxHeight: "70vh" }}>

          {/* Hour gutter */}
          <div
            className="w-[52px] shrink-0 border-r border-border relative"
            style={{ height: totalHours * HOUR_HEIGHT }}
          >
            {hourMarks(startHour, endHour).map((h) => (
              <div
                key={h}
                className="absolute w-full flex items-start justify-end pr-[var(--space-xs)]"
                style={{ top: (h - startHour) * HOUR_HEIGHT, transform: "translateY(-0.3em)" }}
              >
                <span className="text-[length:var(--text-2xs)] text-muted-foreground/60 leading-none">
                  {String(h % 24).padStart(2, "0")}h
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          <div
            ref={gridRef}
            className="flex-1 grid relative"
            style={{
              gridTemplateColumns: "repeat(7, 1fr)",
              height: totalHours * HOUR_HEIGHT,
            }}
          >
            {/* Hour lines */}
            {hourMarks(startHour, endHour).map((h) => (
              <div
                key={`hl${h}`}
                className="absolute w-full border-t border-border/20 pointer-events-none"
                style={{ top: (h - startHour) * HOUR_HEIGHT, zIndex: 1 }}
              />
            ))}

            {/* Day columns */}
            {[1,2,3,4,5,6,7].map((day) => {
              const isOpen = !!openDays[String(day)];
              const dayBlocks = week[day] ?? [];

              return (
                <div
                  key={day}
                  className={cn(
                    "relative border-r border-border/20 last:border-r-0",
                    !isOpen && "bg-muted/10"
                  )}
                  style={{ height: totalHours * HOUR_HEIGHT }}
                >
                  {/* Closed day overlay */}
                  {!isOpen && (
                    <div className="absolute inset-0 pointer-events-none bg-muted/15 z-[2]" />
                  )}

                  {/* Service blocks - filtered by active role, full width */}
                  {layoutOverlaps(dayBlocks, activeRole).map(({ block, col, totalCols }) => {
                    const c = ROLE_COLORS[block.role];
                    let endM = block.endMins;
                    if (endM <= block.startMins) endM += 24 * 60;
                    const top = pxFromMins(block.startMins, startHour);
                    const height = ((endM - block.startMins) / 60) * HOUR_HEIGHT;

                    // HCR compliance warnings
                    const amplitudeMins = endM - block.startMins;
                    const amplitudeExceeded = amplitudeMins > 780; // 13h max
                    const coupureMins = block.continuous && block.coupureStartMins != null && block.coupureEndMins != null
                      ? block.coupureEndMins - block.coupureStartMins : 0;
                    const coupureExceeded = coupureMins > 300; // 5h max
                    const hcrWarnings: HcrWarning[] = [];
                    if (amplitudeExceeded) hcrWarnings.push({ kind: "amplitude", value: `${Math.floor(amplitudeMins / 60)}h${String(amplitudeMins % 60).padStart(2, '0')}` });
                    if (coupureExceeded) hcrWarnings.push({ kind: "coupure", value: `${Math.floor(coupureMins / 60)}h${String(coupureMins % 60).padStart(2, '0')}` });

                    // Full width, subdivided only by overlap columns
                    const colWidthPct = 100 / totalCols;
                    const leftPct = col * colWidthPct;
                    const rightPct = 100 - (leftPct + colWidthPct);
                    const posStyle: React.CSSProperties = {
                      left: `calc(${leftPct}% + 2px)`,
                      right: `calc(${rightPct}% + 2px)`,
                    };

                    return (
                      <div
                        key={block.id}
                        data-block-id={block.id}
                        className={cn(
                          "absolute rounded-md border overflow-hidden",
                          "shadow-sm hover:shadow-md transition-all",
                          hcrWarnings.length > 0 ? "border-destructive/70 border-2" : c.border,
                          c.bg
                        )}
                        style={{ top, height, zIndex: 10, ...posStyle, display: 'flex', flexDirection: 'column' }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          const el = e.currentTarget;
                          setEditPopup({ day, blockId: block.id, rect: el.getBoundingClientRect() });
                        }}
                      >
                        {/* Resize top handle */}
                        <div
                          className="absolute top-0 left-0 right-0 h-[6px] cursor-ns-resize z-20 hover:bg-foreground/5"
                          onPointerDown={e => onBlockPointerDown(e, day, block.id, "resize-top")}
                        />

                        {/* Header bar - delete + drag to move */}
                        <div
                          className={cn("flex items-center px-1 cursor-grab active:cursor-grabbing z-10 relative rounded-t-sm", c.handleBg, hcrWarnings.length > 0 ? "justify-between" : "justify-end")}
                          style={{ height: 14, marginTop: 1 }}
                          onPointerDown={e => onBlockPointerDown(e, day, block.id, "move")}
                        >
                          {hcrWarnings.length > 0 && (
                            <button
                              type="button"
                              className="text-destructive shrink-0 hover:scale-125 transition-transform"
                              onPointerDown={e => e.stopPropagation()}
                              onClick={e => {
                                e.stopPropagation();
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setWarningPopup(prev => prev ? null : { warnings: hcrWarnings, rect });
                              }}
                            >
                              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6zm-1 5v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>
                            </button>
                          )}
                          {/* Delete button */}
                          <button
                            type="button"
                            className="delete-btn inline-flex h-5 w-5 items-center justify-center rounded-full border border-destructive/30 bg-background/90 text-destructive shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground shrink-0"
                            onPointerDown={e => e.stopPropagation()}
                            onClick={() => deleteBlock(day, block.id)}
                            title={t("shared.delete")}
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </div>

                        {/* Block content - different for continuous vs classic */}
                        <div
                          className="flex-1 min-h-0 cursor-grab active:cursor-grabbing overflow-hidden relative"
                          onPointerDown={e => onBlockPointerDown(e, day, block.id, "move")}
                        >
                          {block.continuous && block.coupureStartMins != null && block.coupureEndMins != null ? (() => {
                            const morningDur = block.coupureStartMins! - block.startMins;
                            const coupureDur = block.coupureEndMins! - block.coupureStartMins!;
                            const eveningDur = block.endMins - block.coupureEndMins!;
                            const worked = morningDur + eveningDur;
                            const wH = Math.floor(worked / 60);
                            const wM = worked % 60;
                            return (
                            /* Continuous block: proportional morning / coupure / evening */
                            <div className="flex flex-col h-full">
                              {/* Morning work area */}
                              <div className="flex flex-col justify-start overflow-hidden px-1" style={{ flex: morningDur }}>
                                <span className={cn("text-[11px] font-bold uppercase tracking-wider leading-none block truncate mt-0.5", c.text)}>
                                  {block.name}
                                </span>
                                <span className="text-[10px] text-muted-foreground font-mono mt-0.5">
                                  {toTime(block.startMins)} › {toTime(block.coupureStartMins!)}
                                </span>
                                <span className={cn("text-[10px] font-semibold font-mono", c.text)}>({fmtDuration(block.startMins, block.coupureStartMins!)})</span>
                                {morningDur >= eveningDur && (
                                  <div className="flex flex-col gap-[1px] mt-2 overflow-hidden">
                                    {(block.role === "kitchen" ? kitchenSubRoles : floorSubRoles).map(sr => {
                                      const roleSubRoles = block.role === "kitchen" ? kitchenSubRoles : floorSubRoles;
                                      const displayBreakdown = minimumBreakdown(block.role, block.roleBreakdown, block.count, roleSubRoles);
                                      const val = displayBreakdown[sr] || 0;
                                      const tot = breakdownTotal(displayBreakdown);
                                      const abbr = sr.length <= 3 ? sr : sr.slice(0, 3).replace(/\s+$/, "");
                                      return (
                                        <div key={sr} className="flex items-center gap-[2px]">
                                          <span className={cn("text-[9px] font-semibold w-[22px] truncate", val > 0 ? "text-foreground/70" : "text-muted-foreground/30")} title={sr}>{abbr}</span>
                                          <button type="button" className={cn("w-3 h-3 flex items-center justify-center text-[10px] font-bold transition-colors", tot <= 1 && val > 0 ? "text-muted-foreground/25" : val <= 0 ? "text-muted-foreground/20" : "text-muted-foreground hover:text-foreground")} onPointerDown={e => e.stopPropagation()} onClick={() => updateRoleBreakdown(day, block.id, sr, -1)}>-</button>
                                          <span className={cn("text-[10px] font-bold tabular-nums w-2.5 text-center", val > 0 ? c.text : "text-muted-foreground/30")}>{val}</span>
                                          <button type="button" className={cn("w-3 h-3 flex items-center justify-center text-[10px] font-bold transition-colors", tot >= MAX_COUNT ? "text-muted-foreground/20" : "text-muted-foreground hover:text-foreground")} onPointerDown={e => e.stopPropagation()} onClick={() => updateRoleBreakdown(day, block.id, sr, 1)}>+</button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                              {/* Coupure gap - proportional height with drag handles */}
                              <div
                                className={cn("mx-1 rounded-sm border border-dashed flex flex-col items-center justify-center relative group/coupure",
                                  coupureExceeded ? "border-destructive/50 bg-destructive/10" : "border-muted-foreground/20 bg-muted/30")}
                                style={{ flex: coupureDur, minHeight: 16 }}
                              >
                                {/* Resize top edge of coupure */}
                                <div
                                  className="absolute top-0 left-0 right-0 h-[8px] cursor-ns-resize z-20 hover:bg-primary/15 rounded-t-sm flex items-center justify-center"
                                  onPointerDown={e => { e.stopPropagation(); onBlockPointerDown(e, day, block.id, "resize-coupure-top"); }}
                                >
                                  <div className="w-3 h-[2px] rounded-full bg-muted-foreground/20 group-hover/coupure:bg-muted-foreground/50 transition-colors" />
                                </div>
                                {/* Middle: drag to move entire coupure */}
                                <div
                                  className="flex-1 w-full flex items-center justify-center cursor-grab active:cursor-grabbing z-10"
                                  onPointerDown={e => { e.stopPropagation(); onBlockPointerDown(e, day, block.id, "resize-coupure-move"); }}
                                >
                                  <span className={cn("text-[9px] font-mono select-none text-center leading-tight", coupureExceeded ? "text-destructive/70" : "text-muted-foreground/50")}>
                                    {t("calendar.block.coupureShort", { value: fmtDuration(block.coupureStartMins!, block.coupureEndMins!) })}{coupureExceeded ? " ⚠" : ""}
                                  </span>
                                </div>
                                {/* Resize bottom edge of coupure */}
                                <div
                                  className="absolute bottom-0 left-0 right-0 h-[8px] cursor-ns-resize z-20 hover:bg-primary/15 rounded-b-sm flex items-center justify-center"
                                  onPointerDown={e => { e.stopPropagation(); onBlockPointerDown(e, day, block.id, "resize-coupure-bottom"); }}
                                >
                                  <div className="w-3 h-[2px] rounded-full bg-muted-foreground/20 group-hover/coupure:bg-muted-foreground/50 transition-colors" />
                                </div>
                              </div>
                              {/* Evening work area */}
                              <div className="flex flex-col justify-start overflow-hidden px-1" style={{ flex: eveningDur }}>
                                <span className="text-[10px] text-muted-foreground font-mono mt-0.5">
                                  {toTime(block.coupureEndMins!)} › {toTime(block.endMins)}
                                </span>
                                <span className={cn("text-[10px] font-semibold font-mono", c.text)}>({fmtDuration(block.coupureEndMins!, block.endMins)})</span>
                                <span className={cn("text-[10px] font-bold mt-0.5", c.text)}>
                                  {t("calendar.block.totalShort", { value: wM > 0 ? `${wH}h${String(wM).padStart(2, '0')}` : `${wH}h` })}
                                </span>
                                <span className={cn("text-[10px] mt-0.5", amplitudeExceeded ? "text-destructive font-bold" : "text-muted-foreground")}>
                                  {t("calendar.block.amplitudeShort", { value: `${Math.floor(amplitudeMins / 60)}h${amplitudeMins % 60 > 0 ? String(amplitudeMins % 60).padStart(2, '0') : ''}` })}
                                </span>
                                {eveningDur > morningDur && (
                                  <div className="flex flex-col gap-[1px] mt-2 overflow-hidden">
                                    {(block.role === "kitchen" ? kitchenSubRoles : floorSubRoles).map(sr => {
                                      const roleSubRoles = block.role === "kitchen" ? kitchenSubRoles : floorSubRoles;
                                      const displayBreakdown = minimumBreakdown(block.role, block.roleBreakdown, block.count, roleSubRoles);
                                      const val = displayBreakdown[sr] || 0;
                                      const tot = breakdownTotal(displayBreakdown);
                                      const abbr = sr.length <= 3 ? sr : sr.slice(0, 3).replace(/\s+$/, "");
                                      return (
                                        <div key={sr} className="flex items-center gap-[2px]">
                                          <span className={cn("text-[9px] font-semibold w-[22px] truncate", val > 0 ? "text-foreground/70" : "text-muted-foreground/30")} title={sr}>{abbr}</span>
                                          <button type="button" className={cn("w-3 h-3 flex items-center justify-center text-[10px] font-bold transition-colors", tot <= 1 && val > 0 ? "text-muted-foreground/25" : val <= 0 ? "text-muted-foreground/20" : "text-muted-foreground hover:text-foreground")} onPointerDown={e => e.stopPropagation()} onClick={() => updateRoleBreakdown(day, block.id, sr, -1)}>-</button>
                                          <span className={cn("text-[10px] font-bold tabular-nums w-2.5 text-center", val > 0 ? c.text : "text-muted-foreground/30")}>{val}</span>
                                          <button type="button" className={cn("w-3 h-3 flex items-center justify-center text-[10px] font-bold transition-colors", tot >= MAX_COUNT ? "text-muted-foreground/20" : "text-muted-foreground hover:text-foreground")} onPointerDown={e => e.stopPropagation()} onClick={() => updateRoleBreakdown(day, block.id, sr, 1)}>+</button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                            );
                          })() : (
                            /* Classic block */
                            <>
                              <div className="px-1 mt-0.5">
                                <span
                                  className={cn("text-[11px] font-bold uppercase tracking-wider leading-none block truncate", c.text)}
                                  style={totalCols > 3 ? { writingMode: "vertical-lr", textOrientation: "upright", whiteSpace: "nowrap", letterSpacing: "-0.3em" } : undefined}
                                >
                                  {block.name}
                                </span>
                              </div>
                              <div className={cn("px-1 flex flex-wrap items-center gap-x-0.5 leading-none mt-1")}>
                                <span className="text-[10px] text-muted-foreground font-mono">{toTime(block.startMins)}</span>
                                <span className="text-[9px] text-muted-foreground/60 font-mono font-bold">&gt;</span>
                                <span className="text-[10px] text-muted-foreground font-mono">{toTime(block.endMins)}</span>
                              </div>
                              <div className="px-1">
                                <span className={cn("text-[10px] font-semibold leading-none", c.text)}>({fmtDuration(block.startMins, block.endMins)})</span>
                              </div>
                            </>
                          )}
                        </div>

                        {/* Role breakdown (middle of card, non-coupure only) */}
                        {!block.continuous && (
                          <div className="flex flex-col gap-[1px] px-1 flex-1 min-h-0 overflow-hidden justify-center">
                            {(block.role === "kitchen" ? kitchenSubRoles : floorSubRoles).map(sr => {
                              const roleSubRoles = block.role === "kitchen" ? kitchenSubRoles : floorSubRoles;
                              const displayBreakdown = minimumBreakdown(block.role, block.roleBreakdown, block.count, roleSubRoles);
                              const val = displayBreakdown[sr] || 0;
                              const total = breakdownTotal(displayBreakdown);
                              const abbr = sr.length <= 3 ? sr : sr.slice(0, 3).replace(/\s+$/, "");
                              return (
                                <div key={sr} className="flex items-center gap-[2px]">
                                  <span className={cn("text-[9px] font-semibold w-[22px] truncate", val > 0 ? "text-foreground/70" : "text-muted-foreground/30")} title={sr}>{abbr}</span>
                                  <button
                                    type="button"
                                    className={cn("w-3 h-3 flex items-center justify-center text-[10px] font-bold transition-colors", total <= 1 && val > 0 ? "text-muted-foreground/25" : val <= 0 ? "text-muted-foreground/20" : "text-muted-foreground hover:text-foreground")}
                                    onPointerDown={e => e.stopPropagation()}
                                    onClick={() => updateRoleBreakdown(day, block.id, sr, -1)}
                                  >-</button>
                                  <span className={cn("text-[10px] font-bold tabular-nums w-2.5 text-center", val > 0 ? c.text : "text-muted-foreground/30")}>{val}</span>
                                  <button
                                    type="button"
                                    className={cn("w-3 h-3 flex items-center justify-center text-[10px] font-bold transition-colors", total >= MAX_COUNT ? "text-muted-foreground/20" : "text-muted-foreground hover:text-foreground")}
                                    onPointerDown={e => e.stopPropagation()}
                                    onClick={() => updateRoleBreakdown(day, block.id, sr, 1)}
                                  >+</button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Gear icon - always above badge */}
                        <div className="px-1 flex justify-start mt-auto">
                          <button
                            type="button"
                            className={cn(
                              "inline-flex items-center justify-center rounded-full h-5 w-5 border transition-colors",
                              "border-foreground/15 bg-background/60 text-muted-foreground/70",
                              "hover:bg-foreground/5 hover:text-foreground hover:border-foreground/40",
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              const el = e.currentTarget.closest('[data-block-id]') as HTMLElement;
                              if (el) setEditPopup({ day, blockId: block.id, rect: el.getBoundingClientRect() });
                            }}
                            title={t("calendar.block.configure")}
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                        </div>

                        {/* Worker count + chef toggle (always at bottom) */}
                        <div className="px-1 pb-0.5 flex items-center gap-0.5">
                          
                          <div className={cn(
                            "flex items-center gap-0.5 rounded-full px-1 py-[1px]",
                            c.badge,
                          )}>
                            <span className={cn("text-[11px] font-bold tabular-nums", c.text)}>
                              ×{breakdownTotal(minimumBreakdown(block.role, block.roleBreakdown, block.count, block.role === "kitchen" ? kitchenSubRoles : floorSubRoles))}
                            </span>
                          </div>
                          
                        </div>

                        {/* Resize bottom handle */}
                        <div
                          className="absolute bottom-0 left-0 right-0 h-[6px] cursor-ns-resize z-20 flex items-end justify-center pb-[2px] hover:bg-foreground/5"
                          onPointerDown={e => onBlockPointerDown(e, day, block.id, "resize-bottom")}
                        >
                          <div className={cn("w-6 h-[2px] rounded-full opacity-30", c.accent)} />
                        </div>
                      </div>
                    );
                  })}

                  {/* Drop ghost for palette drag */}
                  {dragGhost && dragGhost.day === day && (() => {
                    const gc = ROLE_COLORS[dragGhost.role];
                    return (
                      <div
                        className={cn(
                          "absolute rounded-md border-2 border-dashed pointer-events-none",
                          "flex flex-col items-center justify-center",
                          gc.border, gc.bg, "opacity-70"
                        )}
                        style={{
                          top: pxFromMins(dragGhost.startMins, startHour),
                          height: ((dragGhost.endMins - dragGhost.startMins) / 60) * HOUR_HEIGHT,
                          left: 2, right: 2,
                          zIndex: 20,
                        }}
                      >
                        <span className={cn("text-[9px] font-bold uppercase", gc.text)}>
                          {dragGhost.continuous ? t("calendar.palette.coupure") : t("calendar.palette.classic")}
                        </span>
                        {dragGhost.continuous && (
                          <div className="mx-2 my-1 w-3/4 border-t border-dashed border-muted-foreground/30" />
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
        </div>
      </div>

      {/* ── Legend / help ── */}
      <div className="flex items-center gap-[var(--space-md)] mt-[var(--space-md)] flex-wrap">
        <span className="text-[length:var(--text-2xs)] text-muted-foreground/40">
          {t("calendar.footer.help")}
        </span>
      </div>

      {/* ── Priority help popup ── */}
      {priorityHelpPopup && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPriorityHelpPopup(null)} />
          <div
            className="fixed z-50 bg-popover border border-border rounded-lg shadow-xl p-3 w-[min(320px,calc(100vw-16px))] space-y-2"
            style={{ top: priorityHelpPopup.rect.bottom + 6, left: Math.min(window.innerWidth - 328, Math.max(8, priorityHelpPopup.rect.left)) }}
          >
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-foreground text-[10px] leading-none font-bold">?</span>
              <span className="text-sm font-semibold">{t("calendar.priority.popupTitle")}</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <Trans
                ns="objectif"
                i18nKey="calendar.priority.popupP1"
                components={{ strong: <span className="font-semibold text-foreground" /> }}
              />
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("calendar.priority.popupP2")}
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("calendar.priority.popupP3")}
            </p>
          </div>
        </>
      )}

      {/* ── Day missing-role popup ── */}
      {dayMissingPopup && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setDayMissingPopup(null)} />
          <div
            className="fixed z-50 bg-popover border border-amber-500/40 rounded-lg shadow-xl p-3 w-[min(280px,calc(100vw-16px))] space-y-2"
            style={{ top: dayMissingPopup.rect.bottom + 4, left: Math.min(window.innerWidth - 288, Math.max(8, dayMissingPopup.rect.left - 130)) }}
          >
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-white text-[10px] font-black leading-none">!</span>
              <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">{dayMissingPopup.missing === "kitchen" ? t("calendar.missing.titleKitchen") : t("calendar.missing.titleFloor")}</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <Trans
                ns="objectif"
                i18nKey={dayMissingPopup.missing === "kitchen" ? "calendar.missing.explainKitchen" : "calendar.missing.explainFloor"}
                values={{ day: JOURS[dayMissingPopup.day % 7] }}
                components={{ day: <span className="font-semibold" />, em: <span className="font-semibold text-foreground" /> }}
              />
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <Trans
                ns="objectif"
                i18nKey={dayMissingPopup.missing === "kitchen" ? "calendar.missing.actionKitchen" : "calendar.missing.actionFloor"}
                values={{ day: JOURS[dayMissingPopup.day % 7] }}
                components={{ strong: <span className="font-semibold" /> }}
              />
            </p>
          </div>
        </>
      )}

      {/* ── HCR warning popup ── */}
      {warningPopup && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setWarningPopup(null)} />
          <div
            className="fixed z-50 bg-popover border border-destructive/30 rounded-lg shadow-xl p-3 w-[min(260px,calc(100vw-16px))] max-w-[calc(100vw-16px)] space-y-2"
            style={{ top: warningPopup.rect.bottom + 4, left: Math.min(window.innerWidth - 268, Math.max(8, warningPopup.rect.left - 100)) }}
          >
            <div className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-destructive shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6zm-1 5v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>
              <span className="text-sm font-semibold text-destructive">{t("calendar.warning.title")}</span>
            </div>
            {warningPopup.warnings.map((w, i) => (
              <div key={i} className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">
                  {w.kind === "amplitude"
                    ? t("calendar.warning.amplitude", { value: w.value }).split('(')[0].trim()
                    : t("calendar.warning.coupure", { value: w.value })}
                </span><br />
                <Trans
                  ns="objectif"
                  i18nKey={w.kind === "amplitude" ? "calendar.warning.amplitudeExplain" : "calendar.warning.coupureExplain"}
                  components={{ strong: <span className="font-semibold" /> }}
                />
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Edit block popup ── */}
      {editPopup && (() => {
        const block = week[editPopup.day]?.find(b => b.id === editPopup.blockId);
        if (!block) return null;
        return (
          <BlockEditPopup
            block={block}
            siblings={week[editPopup.day]}
            anchorRect={editPopup.rect}
            subRoles={block.role === "kitchen" ? kitchenSubRoles : floorSubRoles}
            onChange={(updates) => {
              setWeek(prev => ({
                ...prev,
                [editPopup.day]: prev[editPopup.day].map(b =>
                  b.id === block.id ? { ...b, ...updates } : b
                ),
              }));
              setDirty(true);
            }}
            onDelete={() => {
              deleteBlock(editPopup.day, block.id);
              setEditPopup(null);
            }}
            onClose={() => setEditPopup(null)}
          />
        );
      })()}

      {/* Name prompt dialog for temporary profiles */}
      <Dialog open={showNamePrompt} onOpenChange={(open) => { if (!open) setShowNamePrompt(false); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide">
              {t("calendar.namePrompt.title")}
            </DialogTitle>
            <DialogDescription>
              {t("calendar.namePrompt.description")}
            </DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={namePromptValue}
            onChange={(e) => setNamePromptValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && namePromptValue.trim()) { setShowNamePrompt(false); setProfileName(namePromptValue.trim()); handleSave({ nameOverride: namePromptValue.trim() }); } }}
            placeholder={t("calendar.namePrompt.placeholder")}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
          />
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button

              className="tracking-wide text-[length:var(--text-xs)] font-bold rounded-full bg-amber-500 hover:bg-amber-600 text-white border-amber-500"
              onClick={() => { if (!targetWeek) return; const m = new Date(targetWeek + "T12:00:00"); const s = new Date(m); s.setDate(m.getDate() + 6); const pad = (n: number) => String(n).padStart(2, "0"); const autoName = `${pad(m.getDate())}/${pad(m.getMonth()+1)}_${pad(s.getDate())}/${pad(s.getMonth()+1)}`; setShowNamePrompt(false); setProfileName(autoName); handleSave({ weekOnly: true, nameOverride: autoName }); }}
            >
              {targetWeek
                ? (() => {
                    const m = new Date(targetWeek + "T12:00:00");
                    const s = new Date(m);
                    s.setDate(m.getDate() + 6);
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const fromIso = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
                    const toIso = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
                    return t("calendar.namePrompt.useWeekOnly", { from: fmtDateFR(fromIso), to: fmtDateFR(toIso) });
                  })()
                : t("calendar.namePrompt.applyThisWeek")}
            </Button>
            <Button
              disabled={!namePromptValue.trim()}
              className="tracking-wide text-[length:var(--text-xs)] font-bold"
              onClick={() => { setShowNamePrompt(false); setProfileName(namePromptValue.trim()); handleSave({ nameOverride: namePromptValue.trim() }); }}
            >
              {t("calendar.namePrompt.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Block edit popup ──
function BlockEditPopup({
  block,
  siblings,
  anchorRect,
  subRoles,
  onChange,
  onDelete,
  onClose,
}: {
  block: DayBlock;
  siblings: DayBlock[];
  anchorRect: DOMRect;
  subRoles: string[];
  onChange: (updates: Partial<DayBlock>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("objectif");
  const popupRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(block.name);
  const [startTime, setStartTime] = useState(toTime(block.startMins));
  const [endTime, setEndTime] = useState(toTime(block.endMins));
  const [count, setCount] = useState(block.count);
  const [coupureStart, setCoupureStart] = useState(block.coupureStartMins != null ? toTime(block.coupureStartMins) : "");
  const [coupureEnd, setCoupureEnd] = useState(block.coupureEndMins != null ? toTime(block.coupureEndMins) : "");
  const [roleBreakdown, setRoleBreakdown] = useState<Record<string, number>>(minimumBreakdown(block.role, block.roleBreakdown, block.count, subRoles));

  // Position: to the right of the block, or left if not enough space
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const gap = 8;
    let left = anchorRect.right + gap;
    let top = anchorRect.top;
    // Flip left if overflows right
    if (left + pw > window.innerWidth - 16) {
      left = anchorRect.left - pw - gap;
    }
    // Clamp horizontal for small viewports
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    // Clamp vertical
    if (top + ph > window.innerHeight - 16) {
      top = window.innerHeight - ph - 16;
    }
    if (top < 16) top = 16;
    const frame = requestAnimationFrame(() => setPos({ top, left }));
    return () => cancelAnimationFrame(frame);
  }, [anchorRect]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the double-click that opened it from immediately closing
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handler); };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const nameTaken = siblings.some(b => b.id !== block.id && b.role === block.role && b.name === name);

  // Sync local edits back to parent on every change
  const apply = useCallback((updates: Partial<{ name: string; startTime: string; endTime: string; count: number; coupureStart: string; coupureEnd: string; roleBreakdown: Record<string, number> }>) => {
    const n = updates.name ?? name;
    const st = updates.startTime ?? startTime;
    const et = updates.endTime ?? endTime;
    const ct = updates.count ?? count;
    const cs = updates.coupureStart ?? coupureStart;
    const ce = updates.coupureEnd ?? coupureEnd;
    const rb = minimumBreakdown(block.role, updates.roleBreakdown ?? roleBreakdown, ct, subRoles);
    if (updates.name !== undefined) setName(n);
    if (updates.startTime !== undefined) setStartTime(st);
    if (updates.endTime !== undefined) setEndTime(et);
    if (updates.count !== undefined) setCount(ct);
    if (updates.coupureStart !== undefined) setCoupureStart(cs);
    if (updates.coupureEnd !== undefined) setCoupureEnd(ce);
    if (updates.roleBreakdown !== undefined) setRoleBreakdown(rb);
    // Don't push name change if it conflicts with a sibling
    const conflict = siblings.some(b => b.id !== block.id && b.role === block.role && b.name === n);
    if (conflict) return;
    // When role-based, count = sum of breakdown
    const effectiveCount = updates.roleBreakdown
      ? Object.values(rb).reduce((s, v) => s + v, 0) || ct
      : ct;
    onChange({
      name: n,
      startMins: toMins(st),
      endMins: toMins(et),
      count: effectiveCount,
      roleBreakdown: rb,
      ...(block.continuous && cs && ce ? {
        coupureStartMins: toMins(cs),
        coupureEndMins: toMins(ce),
      } : {}),
    });
  }, [name, startTime, endTime, count, coupureStart, coupureEnd, roleBreakdown, onChange, siblings, block.id, block.role, block.continuous, subRoles]);

  const c = ROLE_COLORS[block.role];

  return (
    <div
      ref={popupRef}
      className="fixed z-50 bg-popover border border-border rounded-lg shadow-xl p-3 w-[min(220px,calc(100vw-16px))] max-w-[calc(100vw-16px)] space-y-3"
      style={{ top: pos.top, left: pos.left }}
    >
      {/* Role badge */}
      <div className="flex items-center gap-2">
        <div className={cn("w-2 h-2 rounded-full", c.dot)} />
        <span className={cn("text-[11px] font-bold uppercase tracking-wider", c.text)}>
          {t(block.role === "kitchen" ? "shared.kitchen" : "shared.floor")}
        </span>
      </div>

      {/* Name */}
      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">{t("calendar.edit.name")}</label>
        <input
          className={cn(
            "w-full h-7 px-2 text-[length:var(--text-sm)] font-medium bg-muted/50 border rounded-md outline-none focus:ring-1",
            nameTaken ? "border-destructive focus:ring-destructive" : "border-border focus:ring-ring"
          )}
          value={name}
          onChange={e => apply({ name: e.target.value })}
          onKeyDown={e => { if (e.key === "Enter") onClose(); }}
        />
        {nameTaken && (
          <p className="text-[10px] text-destructive mt-0.5">{t("calendar.edit.nameTaken")}</p>
        )}
      </div>

      {/* Times + duration */}
      <div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">{t("calendar.edit.start")}</label>
            <input
              type="time"
              className="w-full h-7 px-1.5 text-[length:var(--text-sm)] font-mono bg-muted/50 border border-border rounded-md outline-none focus:ring-1 focus:ring-ring"
              value={startTime}
              step={SNAP * 60}
              onChange={e => apply({ startTime: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">{t("calendar.edit.end")}</label>
            <input
              type="time"
              className="w-full h-7 px-1.5 text-[length:var(--text-sm)] font-mono bg-muted/50 border border-border rounded-md outline-none focus:ring-1 focus:ring-ring"
              value={endTime}
              step={SNAP * 60}
              onChange={e => apply({ endTime: e.target.value })}
            />
          </div>
        </div>
        <div className="mt-1 text-center">
          <span className={cn("text-[11px] font-bold tabular-nums", c.text)}>
            {block.continuous && coupureStart && coupureEnd
              ? (() => {
                  const worked = (toMins(coupureStart) - toMins(startTime)) + (toMins(endTime) - toMins(coupureEnd));
                  const h = Math.floor(worked / 60);
                  const m = worked % 60;
                  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
                })()
              : fmtDuration(toMins(startTime), toMins(endTime))}
          </span>
          <span className="text-[10px] text-muted-foreground ml-1">{block.continuous ? t("calendar.edit.worked") : t("calendar.edit.service")}</span>
        </div>
      </div>

      {/* Coupure times (continuous only) */}
      {block.continuous && (
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">{t("calendar.edit.coupureLabel")}</label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] text-muted-foreground/70 block mb-0.5">{t("calendar.edit.start")}</label>
              <input
                type="time"
                className="w-full h-7 px-1.5 text-[length:var(--text-sm)] font-mono bg-muted/50 border border-border rounded-md outline-none focus:ring-1 focus:ring-ring"
                value={coupureStart}
                step={SNAP * 60}
                onChange={e => apply({ coupureStart: e.target.value })}
              />
            </div>
            <div>
              <label className="text-[9px] text-muted-foreground/70 block mb-0.5">{t("calendar.edit.end")}</label>
              <input
                type="time"
                className="w-full h-7 px-1.5 text-[length:var(--text-sm)] font-mono bg-muted/50 border border-border rounded-md outline-none focus:ring-1 focus:ring-ring"
                value={coupureEnd}
                step={SNAP * 60}
                onChange={e => apply({ coupureEnd: e.target.value })}
              />
            </div>
          </div>
          <div className="mt-1 text-center">
            <span className="text-[10px] text-muted-foreground">
              {coupureStart && coupureEnd ? t("calendar.edit.coupureValue", { value: fmtDuration(toMins(coupureStart), toMins(coupureEnd)) }) : ""}
            </span>
          </div>
        </div>
      )}

      {/* Effectif par poste */}
      <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">{t("calendar.edit.staffPerRole")}</label>
          <div className="space-y-1">
            {subRoles.map(role => {
              const total = breakdownTotal(roleBreakdown);
              const val = roleBreakdown[role] || 0;
              return (
                <div key={role} className="flex items-center gap-2">
                  <span className="text-[11px] font-medium w-[80px] truncate" title={role}>{role}</span>
                  <button
                    type="button"
                    className="w-5 h-5 flex items-center justify-center rounded border border-border bg-muted/50 hover:bg-muted text-foreground font-bold text-[10px] transition-colors disabled:opacity-30"
                    disabled={val <= 0 || total <= 1}
                    onClick={() => apply({ roleBreakdown: changeBreakdownValue(block.role, roleBreakdown, count, subRoles, role, -1) })}
                  >-</button>
                  <span className="text-[length:var(--text-sm)] font-bold tabular-nums w-4 text-center">{val}</span>
                  <button
                    type="button"
                    className="w-5 h-5 flex items-center justify-center rounded border border-border bg-muted/50 hover:bg-muted text-foreground font-bold text-[10px] transition-colors disabled:opacity-30"
                    disabled={total >= MAX_COUNT}
                    onClick={() => apply({ roleBreakdown: changeBreakdownValue(block.role, roleBreakdown, count, subRoles, role, 1) })}
                  >+</button>
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-center">
            <span className="text-[10px] text-muted-foreground"><Trans ns="objectif" i18nKey="calendar.edit.total" values={{ n: breakdownTotal(roleBreakdown) }} components={{ b: <span className="font-bold" /> }} /></span>
          </div>
        </div>

      {/* Delete */}
      <button
        type="button"
        onClick={onDelete}
        className="w-full h-7 flex items-center justify-center gap-1.5 rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 text-[11px] font-semibold uppercase tracking-wider transition-colors"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        </svg>
        {t("shared.delete")}
      </button>
    </div>
  );
}
