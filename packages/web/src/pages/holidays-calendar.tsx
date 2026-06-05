import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, type HolidayRequest, type LeaveIntelligence, type User, type WorkerLeaveSuggestion } from "@/lib/api";
import { cn, shortName } from "@/lib/utils";
import { fmtMonthYearCap, fmtDateShort, MOIS, JOURS_COURTS } from "@/lib/date-utils";
import { assignColors, getWorkerColor, setColorPalettes, type WorkerColor } from "@/lib/colors";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";

function fmt(date: Date): string {
 const y = date.getFullYear();
 const m = String(date.getMonth() + 1).padStart(2, "0");
 const d = String(date.getDate()).padStart(2, "0");
 return `${y}-${m}-${d}`;
}

function getMonthWeeks(year: number, month: number): (Date | null)[][] {
 const daysInMonth = new Date(year, month + 1, 0).getDate();
 const startDow = (new Date(year, month, 1).getDay() + 6) % 7;
 const weeks: (Date | null)[][] = [];
 let dayNum = 1 - startDow;
 while (dayNum <= daysInMonth) {
 const week: (Date | null)[] = [];
 for (let d = 0; d < 7; d++) {
 week.push(dayNum >= 1 && dayNum <= daysInMonth ? new Date(year, month, dayNum) : null);
 dayNum++;
 }
 weeks.push(week);
 }
 return weeks;
}

// ── Inline SVGs ──

function SunIcon({ className }: { className?: string }) {
 return (
 <svg viewBox="0 0 16 16" fill="none" className={cn("w-3 h-3 shrink-0", className)}>
 <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
 {/* rays */}
 {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
 const rad = (angle * Math.PI) / 180;
 const x1 = 8 + Math.cos(rad) * 4.5;
 const y1 = 8 + Math.sin(rad) * 4.5;
 const x2 = 8 + Math.cos(rad) * 6.2;
 const y2 = 8 + Math.sin(rad) * 6.2;
 return <line key={angle} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />;
 })}
 </svg>
 );
}

function MedicalCrossIcon({ className }: { className?: string }) {
 return (
 <svg viewBox="0 0 16 16" fill="none" className={cn("w-3 h-3 shrink-0", className)}>
 <rect x="5.5" y="2" width="5" height="12" rx="0.8" fill="currentColor" />
 <rect x="2" y="5.5" width="12" height="5" rx="0.8" fill="currentColor" />
 </svg>
 );
}

// ── Swim-lane layout: one horizontal row per holiday, spanning across days ──

type HolidayLane = {
 holiday: HolidayRequest;
 workerName: string;
 lane: number; // row index within the day cell
};

/** Assign a stable lane (row) to each holiday so multi-day bars don't jump.
 * Each worker's holidays get their own lane, sorted by start date. */
function assignLanes(holidays: HolidayRequest[], getUserName: (id: string) => string): HolidayLane[] {
 // Group by worker, then sort each group by startDate
 const byWorker = new Map<string, HolidayRequest[]>();
 for (const h of holidays) {
 const arr = byWorker.get(h.workerId) || [];
 arr.push(h);
 byWorker.set(h.workerId, arr);
 }
 for (const arr of byWorker.values()) arr.sort((a, b) => a.startDate.localeCompare(b.startDate));

 // Greedy lane assignment — each holiday gets the lowest lane not occupied at that time
 const lanes: { endDate: string }[][] = []; // lanes[i] = array of occupied ranges
 const result: HolidayLane[] = [];

 // Sort all holidays by start date for stable assignment
 const sorted = [...holidays].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.workerId.localeCompare(b.workerId));

 for (const h of sorted) {
 let assigned = -1;
 for (let i = 0; i < lanes.length; i++) {
 const conflict = lanes[i].some(r => h.startDate <= r.endDate && h.endDate >= h.startDate);
 if (!conflict) {
 assigned = i;
 lanes[i].push({ endDate: h.endDate });
 break;
 }
 }
 if (assigned === -1) {
 assigned = lanes.length;
 lanes.push([{ endDate: h.endDate }]);
 }
 result.push({ holiday: h, workerName: h.workerName || getUserName(h.workerId), lane: assigned });
 }

 return result;
}

export function HolidaysCalendarPage() {
 const { t } = useTranslation("holidays");
 const queryClient = useQueryClient();
 const [monthDate, setMonthDate] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
 const [showSuggestions, setShowSuggestions] = useState(true);
 type PopoverState =
  | { kind: "suggestion"; suggestion: WorkerLeaveSuggestion; anchor: { x: number; y: number } }
  | { kind: "pending"; holiday: HolidayRequest; anchor: { x: number; y: number } };
 const [popover, setPopover] = useState<PopoverState | null>(null);
 const [acting, setActing] = useState(false);
 const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());

 const holidaysQuery = useQuery({
  queryKey: qk.holidays.list(),
  queryFn: async () => (await api.listHolidays()).data,
 });
 const usersQuery = useQuery({
  queryKey: qk.employees.list(false),
  queryFn: async () => (await api.listUsers()).data,
 });
 const preferencesQuery = useQuery({
  queryKey: qk.settings.preferences(),
  queryFn: async () => (await api.getPreferences()).data,
 });
 const intelligenceQuery = useQuery({
  queryKey: qk.holidays.intelligence(),
  queryFn: async () => (await api.getLeaveIntelligence()).data,
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
 });
 const holidays: HolidayRequest[] = useMemo(() => holidaysQuery.data ?? [], [holidaysQuery.data]);
 const users: User[] = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
 const intelligence: LeaveIntelligence | null = intelligenceQuery.data ?? null;
 const loading = holidaysQuery.isPending || usersQuery.isPending || preferencesQuery.isPending;

 useEffect(() => {
  const prefs = preferencesQuery.data;
  if (!prefs || users.length === 0) return;
  setColorPalettes(prefs.kitchenColor || "amber", prefs.floorColor || "sky");
  const staff = users.filter((u) => u.role !== "admin");
  assignColors(staff);
 }, [preferencesQuery.data, users]);

 const refresh = () => {
  return Promise.all([
   queryClient.invalidateQueries({ queryKey: qk.holidays.list() }),
   queryClient.invalidateQueries({ queryKey: qk.holidays.intelligence() }),
  ]);
 };

 // Close popover on outside click or escape
 useEffect(() => {
  if (!popover) return;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPopover(null); };
  const onClick = (e: MouseEvent) => {
   const t = e.target as HTMLElement;
   if (!t.closest("[data-suggestion-popover]") && !t.closest("[data-suggestion-bar]")) setPopover(null);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("mousedown", onClick);
  return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
 }, [popover]);

 const act = async (impose: boolean) => {
  if (!popover || popover.kind !== "suggestion") return;
  const s = popover.suggestion;
  setActing(true);
  try {
   await api.proposeHoliday({
    workerId: s.workerId,
    startDate: s.weekStart,
    endDate: s.weekEnd,
    reason: t("shared.spreadReason"),
    impose,
   });
   toast.success(impose ? t("shared.imposedToast", { name: s.workerName }) : t("shared.proposedToast", { name: s.workerName }));
   setPopover(null);
   setDismissedKeys(prev => new Set(prev).add(`${s.workerId}_${s.weekStart}`));
   await refresh();
  } catch {
   toast.error(t("shared.sendFailed"));
  } finally {
   setActing(false);
  }
 };

 const reviewPending = async (status: "approved" | "rejected") => {
  if (!popover || popover.kind !== "pending") return;
  setActing(true);
  try {
   await api.reviewHoliday(popover.holiday.id, status);
   toast.success(status === "approved" ? t("calendar.approveToast") : t("calendar.rejectToast"));
   setPopover(null);
   await refresh();
  } catch {
   toast.error(t("calendar.errorToast"));
  } finally {
   setActing(false);
  }
 };

 const year = monthDate.getFullYear();
 const month = monthDate.getMonth();
 const weeks = getMonthWeeks(year, month);
 const today = fmt(new Date());

 const getUserName = (id: string) => users.find(u => u.id === id)?.name ?? t("shared.unknown");

 // Only approved + pending
 const visibleHolidays = holidays.filter(h => h.status === "approved" || h.status === "pending");
 const laneAssignments = assignLanes(visibleHolidays, getUserName);
 const maxLane = laneAssignments.reduce((m, l) => Math.max(m, l.lane), -1);

 // Lookup: dateStr → HolidayLane[]
 const lanesByDate = new Map<string, HolidayLane[]>();
 for (const lane of laneAssignments) {
 // Iterate all dates in the holiday range that fall in the visible month
 const start = new Date(lane.holiday.startDate + "T12:00:00");
 const end = new Date(lane.holiday.endDate + "T12:00:00");
 for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
 if (d.getFullYear() === year && d.getMonth() === month) {
 const dateStr = fmt(d);
 const arr = lanesByDate.get(dateStr) || [];
 arr.push(lane);
 lanesByDate.set(dateStr, arr);
 }
 }
 }

 // Legend — unique workers this month
 const monthStart = fmt(new Date(year, month, 1));
 const monthEnd = fmt(new Date(year, month + 1, 0));
 const legendWorkers = new Map<string, { name: string; color: WorkerColor }>();
 for (const lane of laneAssignments) {
 const h = lane.holiday;
 if (h.endDate < monthStart || h.startDate > monthEnd) continue;
 if (!legendWorkers.has(h.workerId)) {
 legendWorkers.set(h.workerId, { name: lane.workerName, color: getWorkerColor(h.workerId) });
 }
 }

 const ROW_H = 18; // px per lane

 // Build suggestion lanes — only solver picks (closures are already approved holiday_requests
 // once auto-created, and even when they're not, the user said school-vacation-driven
 // suggestions are misleading; the spread algorithm's closure rows are imposed-style not
 // click-to-act). Skip suggestions that already map to a real holiday (same workerId + week)
 // or that the user just acted on (dismissedKeys).
 const suggestionsByDate = (() => {
  const map = new Map<string, Array<{ suggestion: WorkerLeaveSuggestion; lane: number }>>();
  if (!showSuggestions || !intelligence) return map;
  const suggestions = (intelligence.advice.workerSuggestions || [])
   .filter(s => s.source === "solver")
   .filter(s => !dismissedKeys.has(`${s.workerId}_${s.weekStart}`))
   .filter(s => {
    // Hide if there's already a real approved/pending holiday for this worker overlapping the suggested week
    return !holidays.some(h =>
     h.workerId === s.workerId &&
     (h.status === "approved" || h.status === "pending") &&
     h.startDate <= s.weekEnd && h.endDate >= s.weekStart
    );
   });

  // Greedy lane assignment — stacked below real lanes (maxLane + 1 base)
  const sugLanes: { endDate: string }[][] = [];
  const baseLane = maxLane + 1;
  for (const s of suggestions) {
   let assigned = -1;
   for (let i = 0; i < sugLanes.length; i++) {
    const conflict = sugLanes[i].some(r => s.weekStart <= r.endDate && s.weekEnd >= s.weekStart);
    if (!conflict) { assigned = i; sugLanes[i].push({ endDate: s.weekEnd }); break; }
   }
   if (assigned === -1) { assigned = sugLanes.length; sugLanes.push([{ endDate: s.weekEnd }]); }
   const lane = baseLane + assigned;
   // Expand to every date in range that falls within visible month
   const start = new Date(s.weekStart + "T12:00:00");
   const end = new Date(s.weekEnd + "T12:00:00");
   for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getFullYear() === year && d.getMonth() === month) {
     const ds = fmt(d);
     const arr = map.get(ds) || [];
     arr.push({ suggestion: s, lane });
     map.set(ds, arr);
    }
   }
  }
  return map;
 })();

 const maxSugLane = Array.from(suggestionsByDate.values()).reduce((m, arr) => Math.max(m, ...arr.map(x => x.lane)), maxLane);
 const cellMinH = Math.max(60, (maxSugLane + 1) * ROW_H + 22); // 22 for day number header

 // Day-of-week headers — Mon-Sun (locale-aware via JOURS_COURTS where 1=Mon..6=Sat,0=Sun)
 const DAY_HEADERS = [JOURS_COURTS[1], JOURS_COURTS[2], JOURS_COURTS[3], JOURS_COURTS[4], JOURS_COURTS[5], JOURS_COURTS[6], JOURS_COURTS[0]];

 return (
 <div className="space-y-[var(--space-lg)]">
 {/* Header */}
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-[var(--space-md)]">
 <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em] ">{t("calendar.title")}</h1>
 <Link
 to="/holidays"
 className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground hover:text-foreground transition-colors border border-foreground/20 px-[var(--space-sm)] py-[2px] rounded-[0.2rem] hover:border-foreground/40"
 >
 <ArrowLeft className="size-3 inline" /> {t("calendar.back")}
 </Link>
 <button
 type="button"
 onClick={() => setShowSuggestions(v => !v)}
 className={cn(
  "text-[length:var(--text-xs)] tracking-wide font-bold transition-colors border px-[var(--space-sm)] py-[2px] rounded-[0.2rem]",
  showSuggestions
   ? "border-foreground text-foreground"
   : "border-foreground/20 text-muted-foreground hover:border-foreground/40",
 )}
 title={t("calendar.suggestionsTitle")}
 >
  {t("calendar.suggestionsToggle")} {showSuggestions ? "✓" : ""}
 </button>
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <button
 onClick={() => setMonthDate(new Date(year, month - 1, 1))}
 className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)]"
 >
 <ChevronLeft className="size-3 inline" /> {MOIS[(month + 11) % 12]}
 </button>
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide min-w-[120px] text-center">
 {fmtMonthYearCap(monthDate)}
 </span>
 <button
 onClick={() => setMonthDate(new Date(year, month + 1, 1))}
 className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)]"
 >
 {MOIS[(month + 1) % 12]} <ChevronRight className="size-3 inline" />
 </button>
 </div>
 </div>

 {/* Legend */}
 {legendWorkers.size > 0 && (
 <div className="flex flex-wrap items-center gap-[var(--space-sm)]">
 {Array.from(legendWorkers.entries()).map(([workerId, info]) => (
 <div key={workerId} className={cn("flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] rounded-[3px] border", info.color.bg, info.color.border)}>
 <span className={cn("text-[length:var(--text-xs)] tracking-wide font-bold", info.color.text)}>
 {shortName(info.name)}
 </span>
 </div>
 ))}
 <span className="w-px h-3 bg-border mx-[var(--space-xs)]" />
 <div className="flex items-center gap-[3px]">
 <SunIcon className="text-foreground/60" />
 <span className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground">{t("calendar.legend.holiday")}</span>
 </div>
 <div className="flex items-center gap-[3px]">
 <MedicalCrossIcon className="text-foreground/60" />
 <span className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground">{t("calendar.legend.medical")}</span>
 </div>
 <span className="w-px h-3 bg-border mx-[var(--space-xs)]" />
 <div className="flex items-center gap-[3px]">
 <div className="w-6 h-2.5 rounded-[2px] bg-foreground/20 border border-foreground/30" />
 <span className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground">{t("calendar.legend.approved")}</span>
 </div>
 <div className="flex items-center gap-[3px]">
 <div className="w-6 h-2.5 rounded-[2px] bg-foreground/5 border border-dashed border-foreground/20" />
 <span className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground">{t("calendar.legend.pending")}</span>
 </div>
 {showSuggestions && (
  <div className="flex items-center gap-[3px]">
   <div className="w-6 h-2.5 rounded-[2px] bg-foreground/[0.015] border border-dashed border-foreground/25" />
   <span className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground italic">{t("calendar.legend.suggestion")}</span>
  </div>
 )}
 </div>
 )}

 {loading ? (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("shared.loading")}</p>
 ) : (
 /* Calendar grid */
 <div className="w-[100vw] relative left-1/2 -translate-x-1/2 border-y border-border overflow-auto bg-card">
 {/* Day-of-week headers */}
 <div className="grid grid-cols-7">
 {DAY_HEADERS.map((d, i) => (
 <div key={i} className="border-b border-r border-border bg-muted p-[var(--space-xs)] text-center text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">
 {d}
 </div>
 ))}
 </div>

 {/* Week rows */}
 {weeks.map((week, wi) => (
 <div key={wi} className="grid grid-cols-7" style={{ minHeight: `${cellMinH}px` }}>
 {week.map((date, di) => {
 if (!date) {
 return <div key={di} className="border-r border-b border-border bg-muted/30" />;
 }
 const dateStr = fmt(date);
 const isToday = dateStr === today;
 const isPast = dateStr < today;
 const dayLanes = lanesByDate.get(dateStr) || [];

 return (
 <div
 key={di}
 className={cn(
 "border-r border-b border-border relative flex flex-col",
 isPast && "opacity-50",
 )}
 >
 {/* Day number */}
 <div className={cn(
 "shrink-0 w-full px-[var(--space-xs)] py-[1px]",
 isToday && "bg-foreground text-background",
 )}>
 <span className={cn(
 "text-[length:var(--text-xs)] font-bold tabular-nums",
 isToday ? "text-background" : "text-foreground",
 )}>
 {date.getDate()}
 </span>
 </div>

 {/* Lane slots — absolute positioned bars */}
 <div className="relative flex-1" style={{ minHeight: `${(maxSugLane + 1) * ROW_H}px` }}>
 {/* Suggestion bars — ghost, dashed, clickable */}
 {(suggestionsByDate.get(dateStr) || []).map(({ suggestion: s, lane }) => {
 const sStart = dateStr === s.weekStart;
 const sEnd = dateStr === s.weekEnd;
 const sKey = `${s.workerId}_${s.weekStart}`;
 return (
  <button
   key={`sug_${sKey}_${dateStr}`}
   type="button"
   data-suggestion-bar
   onClick={(e) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopover({ kind: "suggestion", suggestion: s, anchor: { x: rect.left + rect.width / 2, y: rect.bottom } });
   }}
   className={cn(
    "absolute left-0 right-0 flex items-center gap-[2px] px-[3px] overflow-hidden cursor-pointer",
    "bg-foreground/[0.015] border-y border-dashed border-foreground/25 hover:bg-foreground/[0.06] hover:border-foreground/50 transition-colors",
    sStart && "ml-[2px] border-l rounded-l-[3px]",
    sEnd && "mr-[2px] border-r rounded-r-[3px]",
    s.expiringSoon && "border-amber-500/50",
   )}
   style={{
    top: `${lane * ROW_H + 1}px`,
    height: `${ROW_H - 2}px`,
   }}
   title={t("calendar.tooltipSuggestion", { name: s.workerName, reason: s.reason })}
  >
   {sStart && (
    <span className={cn(
     "text-[length:var(--text-2xs)] font-bold tracking-wide truncate leading-tight italic",
     s.expiringSoon ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground/70",
    )}>
     ? {shortName(s.workerName)}
    </span>
   )}
  </button>
 );
 })}
 {dayLanes.map((lane) => {
 const color = getWorkerColor(lane.holiday.workerId);
 const isApproved = lane.holiday.status === "approved";
 const isPending = lane.holiday.status === "pending";
 const isStart = dateStr === lane.holiday.startDate;
 const isEnd = dateStr === lane.holiday.endDate;
 const isMedical = lane.holiday.medical;

 const barStyle = {
  top: `${lane.lane * ROW_H + 1}px`,
  height: `${ROW_H - 2}px`,
 };
 const barClass = cn(
  "absolute left-0 right-0 flex items-center gap-[2px] px-[3px] overflow-hidden",
  isApproved
   ? cn(color.bg, "border-y", color.border)
   : "bg-foreground/[0.03] border-y border-dashed border-foreground/15",
  isStart && "ml-[2px] border-l rounded-l-[3px]",
  isEnd && "mr-[2px] border-r rounded-r-[3px]",
  isPending && "cursor-pointer hover:bg-foreground/[0.07] hover:border-foreground/40 transition-colors",
 );

 if (isPending) {
  return (
   <button
    key={lane.holiday.id}
    type="button"
    data-suggestion-bar
    onClick={(e) => {
     e.stopPropagation();
     const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
     setPopover({ kind: "pending", holiday: lane.holiday, anchor: { x: rect.left + rect.width / 2, y: rect.bottom } });
    }}
    className={barClass}
    style={barStyle}
    title={t("calendar.tooltipPending", { name: lane.workerName })}
   >
    {(isStart || date.getDate() === 1) && (
     <>
      {isMedical ? (
       <MedicalCrossIcon className="opacity-70 text-muted-foreground" />
      ) : (
       <SunIcon className="opacity-70 text-muted-foreground" />
      )}
      <span className="text-[length:var(--text-xs)] font-bold tracking-wide truncate leading-tight text-muted-foreground">
       {shortName(lane.workerName)}
      </span>
     </>
    )}
   </button>
  );
 }

 return (
 <div
 key={lane.holiday.id}
 className={barClass}
 style={barStyle}
 >
 {/* Icon + name on first day of range or first day of month */}
 {(isStart || date.getDate() === 1) && (
 <>
 {isMedical ? (
 <MedicalCrossIcon className={cn(
 "opacity-70",
 isApproved ? color.text : "text-muted-foreground",
 )} />
 ) : (
 <SunIcon className={cn(
 "opacity-70",
 isApproved ? color.text : "text-muted-foreground",
 )} />
 )}
 <span className={cn(
 "text-[length:var(--text-xs)] font-bold tracking-wide truncate leading-tight",
 isApproved ? color.text : "text-muted-foreground",
 )}>
 {shortName(lane.workerName)}
 </span>
 </>
 )}
 </div>
 );
 })}
 </div>
 </div>
 );
 })}
 </div>
 ))}
 </div>
 )}

 {/* Action popover — suggestions (propose/impose) OR pending holidays (approve/reject) */}
 {popover && (
  <div
   data-suggestion-popover
   style={{
    position: "fixed",
    left: Math.max(8, Math.min(popover.anchor.x - 130, window.innerWidth - 268)),
    top: popover.anchor.y + 6,
    width: 260,
    zIndex: 50,
   }}
   className="bg-card border border-border rounded-[0.2rem] shadow-lg p-[var(--space-sm)] space-y-[var(--space-xs)]"
  >
   {popover.kind === "suggestion" ? (
    <>
     <div>
      <p className="text-[length:var(--text-sm)] font-bold">{popover.suggestion.workerName}</p>
      <p className="text-[length:var(--text-xs)] text-muted-foreground">
       {t("calendar.popover.weekRange", {
        start: fmtDateShort(popover.suggestion.weekStart),
        end: fmtDateShort(popover.suggestion.weekEnd),
        days: popover.suggestion.suggestedDays,
       })}
      </p>
      <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[2px]">{popover.suggestion.reason}</p>
     </div>
     <div className="flex gap-[var(--space-xs)] pt-[var(--space-xs)] border-t border-border">
      <button
       type="button"
       onClick={() => act(false)}
       disabled={acting}
       className="flex-1 text-[length:var(--text-2xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[4px] rounded-full border border-foreground text-background bg-foreground hover:bg-transparent hover:text-foreground transition-colors"
      >
       {acting ? "..." : t("shared.propose")}
      </button>
      <button
       type="button"
       onClick={() => {
        if (!confirm(t("shared.imposeConfirmShort", { name: popover.suggestion.workerName }))) return;
        act(true);
       }}
       disabled={acting}
       className="flex-1 text-[length:var(--text-2xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[4px] rounded-full border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
      >
       {acting ? "..." : t("shared.impose")}
      </button>
     </div>
    </>
   ) : (
    <>
     <div>
      <div className="flex items-center gap-[var(--space-xs)] flex-wrap">
       <p className="text-[length:var(--text-sm)] font-bold">{popover.holiday.workerName || t("calendar.popover.fallbackEmployee")}</p>
       {popover.holiday.medical && (
        <span className="text-[length:var(--text-2xs)] tracking-wide font-bold bg-foreground text-background px-[var(--space-xs)] py-[1px] rounded-full">
         {t("shared.medical")}
        </span>
       )}
       <span className="text-[length:var(--text-2xs)] font-medium text-muted-foreground border-l-2 border-foreground/30 pl-[var(--space-xs)]">
        {t("calendar.popover.pendingHeader")}
       </span>
      </div>
      <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">
       {t("calendar.popover.dateRange", {
        start: fmtDateShort(popover.holiday.startDate),
        end: fmtDateShort(popover.holiday.endDate),
       })}
      </p>
      {popover.holiday.reason && (
       <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">{popover.holiday.reason}</p>
      )}
      {popover.holiday.medical && popover.holiday.documentCount > 0 && (
       <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[2px]">
        {t("calendar.popover.docs", { count: popover.holiday.documentCount })}
       </p>
      )}
     </div>
     <div className="flex gap-[var(--space-xs)] pt-[var(--space-xs)] border-t border-border">
      <button
       type="button"
       onClick={() => reviewPending("approved")}
       disabled={acting}
       className="flex-1 text-[length:var(--text-2xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[4px] rounded-full border border-foreground text-background bg-foreground hover:bg-transparent hover:text-foreground transition-colors"
      >
       {acting ? "..." : t("shared.approve")}
      </button>
      <button
       type="button"
       onClick={() => reviewPending("rejected")}
       disabled={acting}
       className="flex-1 text-[length:var(--text-2xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[4px] rounded-full border border-foreground/30 text-muted-foreground hover:border-foreground hover:text-foreground transition-colors"
      >
       {acting ? "..." : t("shared.reject")}
      </button>
     </div>
     <Link
      to="/holidays"
      className="block text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground hover:text-foreground text-center pt-[2px]"
     >
      {t("calendar.popover.viewDetail")}
     </Link>
    </>
   )}
  </div>
 )}
 </div>
 );
}
