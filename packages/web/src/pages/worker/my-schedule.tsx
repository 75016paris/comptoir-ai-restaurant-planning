import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { toast } from "sonner";
import { api, type ServiceRow, type ClockStatus } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ReplacementModal } from "@/components/replacement-modal";
import { UnderlineNav } from "@/components/underline-nav";
import { cn } from "@/lib/utils";
import { fmtDateShort, fmtDateRange, fmtMonthYearCap, toISO, JOURS, JOURS_COURTS } from "@/lib/date-utils";
import { formatInstantInTimeZone, todayInTimeZone } from "@comptoir/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";

function getMonthWeeks(year: number, month: number): (Date | null)[][] {
 const daysInMonth = new Date(year, month + 1, 0).getDate();
 const startDow = (new Date(year, month, 1).getDay() + 6) % 7; // 0=Mon
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

function getMonday(date: Date): Date {
 const d = new Date(date);
 d.setHours(12, 0, 0, 0);
 const day = d.getDay();
 d.setDate(d.getDate() - ((day + 6) % 7));
 return d;
}



function addDays(date: Date, days: number): Date {
 const d = new Date(date);
 d.setDate(d.getDate() + days);
 return d;
}

function serviceHours(s: ServiceRow): number {
 const [sh, sm] = s.startTime.split(":").map(Number);
 const [eh, em] = s.endTime.split(":").map(Number);
 let mins = (eh * 60 + em) - (sh * 60 + sm);
 if (mins < 0) mins += 24 * 60;
 return mins / 60;
}

// Mon-first ordering matches the original DAYS_SHORT (Lun, Mar, Mer, Jeu, Ven, Sam, Dim).
// JOURS_COURTS is Sunday-indexed (Sun=0), so reorder to Mon-first.
function getDaysShortMonFirst(): string[] {
 return [
  JOURS_COURTS[1], JOURS_COURTS[2], JOURS_COURTS[3],
  JOURS_COURTS[4], JOURS_COURTS[5], JOURS_COURTS[6], JOURS_COURTS[0],
 ];
}

function LeaveProposalsCard() {
 const { t } = useTranslation("schedule");
 const queryClient = useQueryClient();
 const [actingId, setActingId] = useState<string | null>(null);
 const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
  try { return new Set<string>(JSON.parse(localStorage.getItem("comptoir-imposed-dismissed") || "[]")); } catch { return new Set(); }
 });

 const holidaysQuery = useQuery({
  queryKey: qk.holidays.list(),
  queryFn: async () => (await api.listHolidays()).data,
 });
 const allHolidays = holidaysQuery.data ?? [];
 const today = todayInTimeZone();
 const pending = allHolidays.filter(h => h.status === "pending" && h.source === "admin_proposal");
 const imposed = allHolidays.filter(h =>
  h.status === "approved" &&
  h.source === "admin_proposal" &&
  h.endDate >= today &&
  !dismissedIds.has(h.id)
 );

 const respond = async (id: string, action: "accept" | "reject") => {
  setActingId(id);
  try {
   await api.respondToProposal(id, action);
   await queryClient.invalidateQueries({ queryKey: qk.holidays.all() });
   toast.success(action === "accept" ? t("worker.toasts.proposalAccepted") : t("worker.toasts.proposalRejected"));
  } catch {
   toast.error(t("worker.toasts.error"));
  } finally {
   setActingId(null);
  }
 };

 const dismiss = (id: string) => {
  const next = new Set(dismissedIds);
  next.add(id);
  setDismissedIds(next);
  localStorage.setItem("comptoir-imposed-dismissed", JSON.stringify([...next]));
 };

 if (pending.length === 0 && imposed.length === 0) return null;

 const renderRange = (start: string, end: string, reason: string | null | undefined) => {
  const from = fmtDateShort(start);
  const to = fmtDateShort(end);
  return reason
   ? t("worker.imposedLeave.dateRangeWithReason", { from, to, reason })
   : t("worker.imposedLeave.dateRange", { from, to });
 };

 return (
  <div className="space-y-[var(--space-xs)]">
   {imposed.map(h => (
    <div key={h.id} className="border border-destructive/30 bg-destructive/5 rounded-[0.2rem] p-[var(--space-sm)] flex items-start gap-[var(--space-sm)]">
     <div className="flex-1 min-w-0">
      <p className="text-[length:var(--text-sm)] font-bold text-destructive">{t("worker.imposedLeave.title")}</p>
      <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">
       {renderRange(h.startDate, h.endDate, h.reason)}
      </p>
      <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[2px]">
       {t("worker.imposedLeave.legalNote")}
      </p>
     </div>
     <button
      type="button"
      onClick={() => dismiss(h.id)}
      className="text-muted-foreground/50 hover:text-foreground transition-colors shrink-0"
      aria-label={t("worker.dismissAria")}
     >
      <span className="text-[length:var(--text-sm)]">×</span>
     </button>
    </div>
   ))}

   {pending.map(h => (
    <div key={h.id} className="border border-amber-500/30 bg-amber-500/5 rounded-[0.2rem] p-[var(--space-sm)] flex items-start gap-[var(--space-sm)]">
     <div className="flex-1 min-w-0">
      <p className="text-[length:var(--text-sm)] font-bold">{t("worker.proposedLeave.title")}</p>
      <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">
       {renderRange(h.startDate, h.endDate, h.reason)}
      </p>
     </div>
     <div className="flex gap-[var(--space-xs)] shrink-0">
      <button
       type="button"
       onClick={() => respond(h.id, "accept")}
       disabled={actingId === h.id}
       className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-md)] py-[4px] rounded-full border border-foreground bg-foreground text-background hover:bg-transparent hover:text-foreground transition-colors"
      >
       {t("worker.yes")}
      </button>
      <button
       type="button"
       onClick={() => respond(h.id, "reject")}
       disabled={actingId === h.id}
       className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-md)] py-[4px] rounded-full border border-foreground/30 text-muted-foreground hover:border-foreground hover:text-foreground transition-colors"
      >
       {t("worker.no")}
      </button>
     </div>
    </div>
   ))}
  </div>
 );
}

export function MySchedulePage() {
 const { t } = useTranslation("schedule");
 const { user } = useAuth();
 const [monday, setMonday] = useState(() => getMonday(new Date()));
 const [monthDate, setMonthDate] = useState(() => {
 const d = new Date();
 return new Date(d.getFullYear(), d.getMonth(), 1);
 });
 const queryClient = useQueryClient();
 const [replacementService, setReplacementService] = useState<ServiceRow | null>(null);
 const [viewMode, setViewMode] = useState<"week" | "month" | "list">("week");
 const [tapping, setTapping] = useState(false);

 const workerConfigQuery = useQuery({
 queryKey: qk.settings.workerConfig(),
 queryFn: async () => (await api.getWorkerConfig()).data,
 enabled: !!user,
 });
 const tapEnabled = !!workerConfigQuery.data?.tapInOutEnabled;

 const clockQuery = useQuery({
 queryKey: qk.timeclock.status(),
 queryFn: async () => (await api.clockStatus()).data,
 enabled: tapEnabled,
 });
 const clockStatus: ClockStatus | null = clockQuery.data ?? null;
 const refreshClock = useCallback(() => {
 if (!tapEnabled) return;
 queryClient.invalidateQueries({ queryKey: qk.timeclock.status() });
 }, [tapEnabled, queryClient]);

 const handleTap = async () => {
 if (!clockStatus) return;
 setTapping(true);
 try {
 if (clockStatus.clockedIn) {
 await api.tapOut();
 } else {
 await api.tapIn();
 }
 refreshClock();
 } catch (err) {
 console.error("Tap failed", err);
 } finally {
 setTapping(false);
 }
 };

 const { from: rangeFrom, to: rangeTo } = (() => {
 if (viewMode === "month") {
 return {
 from: toISO(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)),
 to: toISO(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0)),
 };
 }
 return { from: toISO(monday), to: toISO(addDays(monday, 6)) };
 })();

 const servicesQuery = useQuery({
 queryKey: qk.schedule.services(rangeFrom, rangeTo),
 queryFn: async () => (await api.getServices(rangeFrom, rangeTo)).data,
 enabled: !!user,
 });
 const services: ServiceRow[] = (servicesQuery.data ?? []).filter((s) => s.workerId === user?.id);
 const loading = servicesQuery.isPending;
 const refreshServices = () => {
 queryClient.invalidateQueries({ queryKey: qk.schedule.services(rangeFrom, rangeTo) });
 };

 const publishedQuery = useQuery({
 queryKey: qk.schedule.weekPublished(toISO(monday)),
 queryFn: async () => (await api.getWeekPublished(toISO(monday))).data.published,
 enabled: viewMode !== "month",
 });
 const weekPublished: boolean | null = viewMode === "month" ? null : (publishedQuery.data ?? null);

 let totalMinutes = 0;
 for (const s of services) totalMinutes += serviceHours(s) * 60;

 // Group services by date
 const servicesByDate = new Map<string, ServiceRow[]>();
 for (const s of services) {
 const arr = servicesByDate.get(s.date) || [];
 arr.push(s);
 servicesByDate.set(s.date, arr);
 }

 const daysShort = getDaysShortMonFirst();

 return (
 <div className="space-y-[var(--space-lg)]">
 <LeaveProposalsCard />
 <div className="flex flex-col gap-[var(--space-sm)] md:flex-row md:items-center md:justify-between">
 <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em]">{t("worker.title")}</h1>
 <div className="flex flex-wrap items-center gap-[var(--space-sm)]">
 <UnderlineNav
 items={[
 { value: "week", label: t("worker.viewModes.week") },
 { value: "month", label: t("worker.viewModes.month") },
 { value: "list", label: t("worker.viewModes.list") },
 ]}
 value={viewMode}
 onChange={(v) => setViewMode(v as "week" | "month" | "list")}
 />
 <span className="hidden md:inline w-px h-5 bg-border mx-[var(--space-xs)]" />
 <div className="flex items-center gap-[var(--space-xs)] ml-auto md:ml-0">
 <button
 aria-label={t("actions.previous")}
 onClick={() => {
 if (viewMode === "month") {
 setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1));
 } else {
 setMonday((m) => addDays(m, -7));
 }
 }}
 className="touch-target text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded hover:bg-muted"
 >
 <ChevronLeft className="size-4" />
 </button>
 <span className="text-[length:var(--text-sm)] font-semibold min-w-[110px] sm:min-w-[120px] text-center">
 {viewMode === "month"
 ? fmtMonthYearCap(monthDate)
 : fmtDateRange(toISO(monday), toISO(addDays(monday, 6)))}
 </span>
 <button
 aria-label={t("actions.next")}
 onClick={() => {
 if (viewMode === "month") {
 setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1));
 } else {
 setMonday((m) => addDays(m, 7));
 }
 }}
 className="touch-target text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded hover:bg-muted"
 >
 <ChevronRight className="size-4" />
 </button>
 <button
 onClick={() => {
 const now = new Date();
 if (viewMode === "month") {
 setMonthDate(new Date(now.getFullYear(), now.getMonth(), 1));
 } else {
 setMonday(getMonday(new Date()));
 }
 }}
 className="touch-target text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-1 rounded hover:bg-muted ml-[var(--space-xs)]"
 >
 {t("actions.today")}
 </button>
 </div>
 </div>
 </div>

 <div className="flex items-center gap-[var(--space-lg)] text-[length:var(--text-xs)] tracking-wide text-muted-foreground">
 <span className="font-bold text-foreground">
 {t("worker.servicesSummary", { count: services.length, hours: (totalMinutes / 60).toFixed(1) })}
 </span>
 </div>

 {/* Show a banner when the current week isn't published yet — shifts shown are zero by API gating */}
 {viewMode !== "month" && weekPublished === false && (
 <div className="border border-amber-500/40 bg-amber-500/10 px-[var(--space-lg)] py-[var(--space-md)] rounded-sm">
 <p className="text-[length:var(--text-sm)] font-bold tracking-wide text-amber-700 dark:text-amber-400">
 {t("worker.notPublished.title")}
 </p>
 <p className="text-[length:var(--text-xs)] text-amber-700/80 dark:text-amber-400/80 mt-[2px]">
 {t("worker.notPublished.body")}
 </p>
 </div>
 )}

 {/* Tap In / Tap Out */}
 {tapEnabled && clockStatus && (
 <div className={cn(
 "border p-[var(--space-lg)] flex items-center justify-between",
 clockStatus.clockedIn ? "border-foreground bg-foreground text-background" : "border-border"
 )}>
 <div>
 <p className="text-[length:var(--text-sm)] font-bold tracking-wide">
 {clockStatus.clockedIn ? t("worker.timeclock.clockedIn") : t("worker.timeclock.clockedOut")}
 </p>
 {clockStatus.clockedIn && clockStatus.current && (
 <p className={cn("text-[length:var(--text-xs)] tracking-wide", clockStatus.clockedIn ? "opacity-70" : "text-muted-foreground")}>
 {t("worker.timeclock.since", { time: formatInstantInTimeZone(clockStatus.current.tapIn, undefined, user?.restaurantTimezone, { year: undefined, month: undefined, day: undefined }) })}
 </p>
 )}
 </div>
 <Button
 onClick={handleTap}
 disabled={tapping}
 variant={clockStatus.clockedIn ? "outline" : "default"}
 className={cn(
 "tracking-wide text-[length:var(--text-xs)] font-bold h-[var(--space-2xl)] px-[var(--space-xl)]",
 clockStatus.clockedIn && "border-background bg-background text-foreground hover:bg-background/90 hover:text-foreground"
 )}
 >
 {tapping ? t("worker.timeclock.tapping") : clockStatus.clockedIn ? t("worker.timeclock.tapOut") : t("worker.timeclock.tapIn")}
 </Button>
 </div>
 )}

 {loading ? (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("page.loading")}</p>
 ) : viewMode === "month" ? (
 /* ── MONTH VIEW ── */
 <div className="border border-border rounded-sm overflow-hidden bg-card">
 <div className="grid grid-cols-7">
 {daysShort.map((d) => (
 <div key={d} className="border-b border-r border-border last:border-r-0 bg-muted p-[var(--space-xs)] text-center text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">
 {d}
 </div>
 ))}
 </div>
 {getMonthWeeks(monthDate.getFullYear(), monthDate.getMonth()).map((week, wi) => (
 <div key={wi} className="grid grid-cols-7 min-h-[64px] sm:min-h-[90px]">
 {week.map((date, di) => {
 if (!date) {
 return <div key={di} className="border-r last:border-r-0 border-b border-border bg-muted/30" />;
 }
 const dateStr = toISO(date);
 const today = todayInTimeZone(user?.restaurantTimezone);
 const isToday = dateStr === today;
 const isPast = dateStr < today;
 const dayServices = (servicesByDate.get(dateStr) || [])
 .sort((a, b) => a.startTime.localeCompare(b.startTime));
 const dayHours = dayServices.reduce((sum, s) => sum + serviceHours(s), 0);
 return (
 <button
 key={di}
 onClick={() => {
 setMonday(getMonday(new Date(date)));
 setViewMode("week");
 }}
 className={cn(
 "border-r last:border-r-0 border-b border-border relative flex flex-col overflow-hidden text-left hover:bg-accent/30 transition-colors cursor-pointer",
 isPast && "opacity-50",
 )}
 >
 <div className={cn(
 "shrink-0 w-full flex items-center justify-between px-[var(--space-xs)] py-[1px]",
 isToday && "bg-foreground text-background",
 )}>
 <span className="text-[length:var(--text-xs)] font-bold tabular-nums">
 {date.getDate()}
 </span>
 {dayServices.length > 0 && (
 <span className={cn(
 "text-[length:var(--text-2xs)] tabular-nums font-medium",
 isToday ? "text-background/60" : "text-muted-foreground",
 )}>
 {dayHours.toFixed(1)}h
 </span>
 )}
 </div>
 <div className="flex-1 flex flex-col gap-[1px] p-[2px] overflow-hidden">
 {dayServices.map((s) => (
 <div key={s.id} className="bg-foreground text-background px-[3px] py-[0.5px] rounded-[2px] text-[length:var(--text-2xs)] sm:text-[length:var(--text-xs)] font-bold tabular-nums truncate">
 <span className="sm:hidden">•</span>
 <span className="hidden sm:inline">{s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}</span>
 </div>
 ))}
 </div>
 </button>
 );
 })}
 </div>
 ))}
 </div>
 ) : viewMode === "week" ? (
 /* ── WEEK CALENDAR VIEW ── */
 <div className="border border-border rounded-sm overflow-hidden bg-card">
 <div className="grid grid-cols-1 sm:grid-cols-7">
 {daysShort.map((dayName, i) => {
 const dateStr = toISO(addDays(monday, i));
 const today = todayInTimeZone(user?.restaurantTimezone);
 const isToday = dateStr === today;
 const isPast = dateStr < today;
 const dayServices = servicesByDate.get(dateStr) || [];
 const dayHours = dayServices.reduce((sum, s) => sum + serviceHours(s), 0);

 return (
 <div key={dateStr} className={cn("border-b sm:border-b-0 sm:border-r border-border last:border-b-0 sm:last:border-r-0", isToday && "bg-accent/30", isPast && "opacity-50")}>
 {/* Day header */}
 <div className={cn(
 "border-b border-border p-[var(--space-sm)] text-center",
 isToday ? "bg-foreground text-background" : "bg-muted"
 )}>
 <div className="text-[length:var(--text-sm)] font-bold tracking-wide">
 {dayName}
 </div>
 <div className={cn("text-[length:var(--text-xs)] font-normal", isToday ? "text-background/70" : "text-muted-foreground")}>
 {fmtDateShort(dateStr)}
 </div>
 </div>

 {/* Service blocks */}
 <div className="sm:min-h-[120px] p-[var(--space-xs)]">
 {dayServices.length === 0 ? (
 <div className="flex items-center justify-center h-[56px] sm:h-[100px] text-muted-foreground text-[length:var(--text-xs)]">
 —
 </div>
 ) : (
 <div className="space-y-[var(--space-xs)]">
 {dayServices.map((service) => {
 const hrs = serviceHours(service);
 return (
 <button
 key={service.id}
 onClick={() => setReplacementService(service)}
 className="w-full text-left p-[var(--space-sm)] bg-foreground text-background rounded-sm transition-opacity hover:opacity-80"
 >
 <div className="text-[length:var(--text-xs)] font-bold tracking-wide">
 {service.startTime.slice(0, 5)}–{service.endTime.slice(0, 5)}
 </div>
 <div className="text-[length:var(--text-xs)] opacity-70">
 {hrs.toFixed(1)}h
 </div>
 </button>
 );
 })}
 </div>
 )}
 </div>

 {/* Day total */}
 {dayServices.length > 0 && (
 <div className="border-t border-border/30 p-[var(--space-xs)] text-center">
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">
 {dayHours.toFixed(1)}h
 </span>
 </div>
 )}
 </div>
 );
 })}
 </div>
 </div>
 ) : (
 /* ── LIST VIEW ── */
 <div className="space-y-[var(--space-sm)]">
 {services.length === 0 ? (
 <div className="border border-border rounded-sm p-[var(--space-xl)] text-center text-muted-foreground text-[length:var(--text-sm)] tracking-wide">
 {t("worker.noServicesThisWeek")}
 </div>
 ) : (
 services
 .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
 .map((service) => {
 const d = new Date(service.date + "T00:00:00");
 const dayName = JOURS[d.getDay()];
 const today = todayInTimeZone(user?.restaurantTimezone);
 const isToday = service.date === today;
 const isPast = service.date < today;
 const hours = serviceHours(service);

 return (
 <div
 key={service.id}
 className={cn(
 "border border-foreground/20 rounded-sm flex items-center justify-between p-[var(--space-md)]",
 isToday && "border-foreground border-2",
 isPast && "opacity-50"
 )}
 >
 <div>
 <p className="font-bold text-[length:var(--text-sm)] ">
 {dayName}{" "}
 <span className="text-muted-foreground font-normal">
 {fmtDateShort(service.date)}
 </span>
 {isToday && (
 <span className="ml-[var(--space-sm)] text-[length:var(--text-xs)] font-bold tracking-widest bg-foreground text-background px-[var(--space-sm)] py-[var(--space-xs)]">
 {t("worker.todayBadge")}
 </span>
 )}
 </p>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
 {service.startTime.slice(0, 5)} – {service.endTime.slice(0, 5)}
 <span className="ml-[var(--space-sm)] font-bold text-foreground">{hours.toFixed(1)}h</span>
 </p>
 </div>
 <Button variant="outline" size="sm" className="tracking-wide text-[length:var(--text-xs)] font-bold" onClick={() => setReplacementService(service)}>
 {t("worker.requestReplacement")}
 </Button>
 </div>
 );
 })
 )}
 </div>
 )}

 {/* "Planning hebdomadaire" availability display removed 2026-04-17 — was a read-only
  echo of worker_availability (admin-managed), redundant with the "Créneaux préférés"
  section on /my-profile and not actionable for the worker. */}

 <ReplacementModal
 service={replacementService}
 open={!!replacementService}
 onClose={() => setReplacementService(null)}
 onSuccess={() => {
 setReplacementService(null);
 refreshServices();
 }}
 />
 </div>
 );
}
