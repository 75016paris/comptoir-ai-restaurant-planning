import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { api, type HoursSummary, type MonthlyRecap } from "@/lib/api";
import { UnderlineNav } from "@/components/underline-nav";
import { cn } from "@/lib/utils";
import { fmtDateRange, fmtMonthYearCap } from "@/lib/date-utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

function getMonthKey(offset: number): { key: string; label: string } {
 const d = new Date();
 d.setDate(1);
 d.setMonth(d.getMonth() + offset);
 const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
 const label = fmtMonthYearCap(d);
 return { key, label };
}

function getYearRange(): { from: string; to: string } {
 const year = new Date().getFullYear();
 return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function fmtWeekLabel(from: string, to: string): string {
 return fmtDateRange(from, to);
}

export function MyHoursPage() {
 const { t } = useTranslation("hours");
 const [monthOffset, setMonthOffset] = useState(0);
 const [view, setView] = useState<"monthly" | "weekly">("monthly");
 const [weekIndex, setWeekIndex] = useState(0);

 const { key, label } = getMonthKey(monthOffset);
 const yearRange = getYearRange();

 const recapQuery = useQuery({
 queryKey: qk.hours.monthlyRecap(key),
 queryFn: async () => (await api.getMonthlyRecap(key)).data,
 });
 const yearQuery = useQuery({
 queryKey: qk.hours.range({ from: yearRange.from, to: yearRange.to }),
 queryFn: async () => (await api.getHours({ from: yearRange.from, to: yearRange.to })).data,
 });
 const recap: MonthlyRecap | null = recapQuery.data ?? null;
 const yearData: HoursSummary | null = yearQuery.data ?? null;
 const loading = recapQuery.isPending || yearQuery.isPending;

 useEffect(() => {
 if (!recap) return;
 const weeks = recap.workers?.[0]?.weeks ?? [];
 const lastActive = weeks.reduce((last, w, i) => w.services > 0 ? i : last, 0);
 queueMicrotask(() => setWeekIndex(lastActive));
 }, [recap]);

 const myRecap = recap?.workers?.[0] ?? null;
 const bd = myRecap?.overtimeBreakdown;
 const abd = myRecap?.actualOvertimeBreakdown;
 const hasOT = myRecap ? myRecap.overtimeHours > 0 : false;
 const isPastMonth = recap ? key < recap.today.slice(0, 7) : monthOffset < 0;

 // Weekly view data
 const activeWeeks = myRecap?.weeks.filter(w => w.services > 0) ?? [];
 const safeWeekIdx = Math.min(weekIndex, Math.max(0, activeWeeks.length - 1));
 const currentWeek = activeWeeks[safeWeekIdx];

 return (
 <div className="space-y-[var(--space-xl)]">
 <div className="flex flex-col gap-[var(--space-sm)] sm:flex-row sm:items-center sm:justify-between">
 <div className="flex flex-wrap items-center gap-[var(--space-md)]">
 <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em]">{t("worker.title")}</h1>
 <UnderlineNav
 items={[
 { value: "monthly", label: t("tabs.monthly") },
 { value: "weekly", label: t("tabs.weekly") },
 ]}
 value={view}
 onChange={(v) => setView(v as "monthly" | "weekly")}
 />
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <button
 aria-label={t("worker.prevMonth")}
 onClick={() => setMonthOffset((o) => o - 1)}
 className="touch-target text-[length:var(--text-xs)] font-bold text-muted-foreground/50 hover:text-foreground transition-colors p-1.5"
 ><ChevronLeft className="size-4" /></button>
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide min-w-[110px] sm:min-w-[120px] text-center">
 {label}
 </span>
 <button
 aria-label={t("worker.nextMonth")}
 onClick={() => setMonthOffset((o) => o + 1)}
 disabled={monthOffset >= 0}
 className={cn(
 "touch-target text-[length:var(--text-xs)] font-bold transition-colors p-1.5",
 monthOffset >= 0 ? "text-muted-foreground/20 cursor-not-allowed" : "text-muted-foreground/50 hover:text-foreground"
 )}
 ><ChevronRight className="size-4" /></button>
 </div>
 </div>

 {/* Year summary */}
 <div className="grid grid-cols-2 gap-[var(--space-md)] border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 <div className="text-center">
 <p className="text-[length:var(--text-3xl)] font-bold font-mono">{yearData ? `${yearData.totalHours.toFixed(0)}h` : "—"}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("worker.thisYear")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-3xl)] font-bold font-mono">{yearData ? yearData.serviceCount : "—"}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.services")}</p>
 </div>
 </div>

 {loading ? (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("common.loading")}</p>
 ) : view === "weekly" ? (
 /* ── WEEKLY VIEW ── */
 myRecap && activeWeeks.length > 0 && currentWeek ? (
 <div className="space-y-[var(--space-lg)]">
 {/* Week nav */}
 <div className="flex items-center justify-center gap-[var(--space-sm)]">
 <button
 onClick={() => setWeekIndex(Math.max(0, safeWeekIdx - 1))}
 disabled={safeWeekIdx <= 0}
 className={cn("text-[length:var(--text-xs)] font-bold transition-colors px-[var(--space-xs)]", safeWeekIdx <= 0 ? "text-muted-foreground/20 cursor-not-allowed" : "text-muted-foreground/50 hover:text-foreground")}
 ><ChevronLeft className="size-3" /></button>
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide min-w-[100px] text-center">
 {fmtWeekLabel(currentWeek.week.from, currentWeek.week.to)}
 </span>
 <button
 onClick={() => setWeekIndex(Math.min(activeWeeks.length - 1, safeWeekIdx + 1))}
 disabled={safeWeekIdx >= activeWeeks.length - 1}
 className={cn("text-[length:var(--text-xs)] font-bold transition-colors px-[var(--space-xs)]", safeWeekIdx >= activeWeeks.length - 1 ? "text-muted-foreground/20 cursor-not-allowed" : "text-muted-foreground/50 hover:text-foreground")}
 ><ChevronRight className="size-3" /></button>
 </div>

 {/* Week stat cards */}
 <div className="grid grid-cols-3 gap-[var(--space-md)] border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{currentWeek.hours.toFixed(1)}h</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.hours")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{currentWeek.services}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.services")}</p>
 </div>
 <div className="text-center">
 <p className={cn("text-[length:var(--text-2xl)] font-bold font-mono", currentWeek.overtime > 0 ? "text-amber-600 dark:text-amber-400" : "")}>
 {currentWeek.overtime > 0 ? `+${currentWeek.overtime.toFixed(1)}h` : "0h"}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.overtime")}</p>
 </div>
 </div>

 {/* OT tier breakdown for this week */}
 {currentWeek.overtime > 0 && (
 <div className="grid grid-cols-3 gap-[var(--space-md)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 {([["110%", currentWeek.breakdown.rate110], ["120%", currentWeek.breakdown.rate120], ["150%", currentWeek.breakdown.rate150]] as const).map(([lbl, val]) => (
 <div key={lbl} className="text-center">
 <p className="text-[length:var(--text-lg)] font-bold font-mono text-amber-600 dark:text-amber-400">
 {val > 0 ? `${val.toFixed(1)}h` : "—"}
 </p>
 <p className="text-[length:var(--text-xs)] text-amber-600/60 dark:text-amber-400/60 tracking-wide font-bold">{lbl}</p>
 </div>
 ))}
 </div>
 )}
 </div>
 ) : (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide text-center py-[var(--space-xl)]">{t("common.noServicesThisMonth")}</p>
 )
 ) : (
 /* ── MONTHLY VIEW ── */
 myRecap ? (
 <div className="space-y-[var(--space-lg)]">
 {/* Stat cards — actual vs projected */}
 {!isPastMonth ? (
 <div className="space-y-[var(--space-md)]">
 <div className="grid grid-cols-3 gap-[var(--space-md)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{myRecap.actualHours.toFixed(1)}h</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("worker.actual")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{myRecap.actualServiceCount}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("worker.servicesDone")}</p>
 </div>
 <div className="text-center">
 <p className={cn("text-[length:var(--text-2xl)] font-bold font-mono", myRecap.actualOvertimeHours > 0 ? "text-amber-600 dark:text-amber-400" : "")}>
 {myRecap.actualOvertimeHours > 0 ? `+${myRecap.actualOvertimeHours.toFixed(1)}h` : "0h"}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("worker.actualOT")}</p>
 </div>
 </div>
 <div className="grid grid-cols-3 gap-[var(--space-md)] border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 <div className="text-center">
 <p className="text-[length:var(--text-lg)] font-mono text-muted-foreground">{myRecap.totalHours.toFixed(1)}h</p>
 <p className="text-[10px] text-muted-foreground/50 tracking-wide">{t("worker.projected")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-lg)] font-mono text-muted-foreground">{myRecap.serviceCount}</p>
 <p className="text-[10px] text-muted-foreground/50 tracking-wide">{t("worker.servicesTotal")}</p>
 </div>
 <div className="text-center">
 <p className={cn("text-[length:var(--text-lg)] font-mono text-muted-foreground", myRecap.overtimeHours > 0 ? "text-amber-600/60 dark:text-amber-400/60" : "")}>
 {myRecap.overtimeHours > 0 ? `+${myRecap.overtimeHours.toFixed(1)}h` : "0h"}
 </p>
 <p className="text-[10px] text-muted-foreground/50 tracking-wide">{t("worker.projectedOT")}</p>
 </div>
 </div>
 </div>
 ) : (
 <div className="grid grid-cols-3 gap-[var(--space-md)] border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{myRecap.totalHours.toFixed(1)}h</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.hours")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{myRecap.serviceCount}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.services")}</p>
 </div>
 <div className="text-center">
 <p className={cn("text-[length:var(--text-2xl)] font-bold font-mono", hasOT ? "text-amber-600 dark:text-amber-400" : "")}>
 {hasOT ? `+${myRecap.overtimeHours.toFixed(1)}h` : "0h"}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.overtime")}</p>
 </div>
 </div>
 )}

 {/* OT tier breakdown */}
 {hasOT && bd && abd && (
 <div className="grid grid-cols-3 gap-[var(--space-md)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 {([["110%", "rate110"], ["120%", "rate120"], ["150%", "rate150"]] as const).map(([lbl, k]) => (
 <div key={k} className="text-center">
 {!isPastMonth && abd[k] !== bd[k] ? (
 <>
 <p className="text-[length:var(--text-lg)] font-bold font-mono text-amber-600 dark:text-amber-400">{bd[k] > 0 ? `${bd[k].toFixed(1)}h` : "—"}</p>
 <p className="text-[length:var(--text-xs)] font-mono text-amber-600/40 dark:text-amber-400/40">{abd[k] > 0 ? t("worker.actualHoursSuffix", { hours: abd[k].toFixed(1) }) : t("worker.actualHoursSuffix", { hours: "0" })}</p>
 </>
 ) : (
 <p className="text-[length:var(--text-lg)] font-bold font-mono text-amber-600 dark:text-amber-400">{bd[k] > 0 ? `${bd[k].toFixed(1)}h` : "—"}</p>
 )}
 <p className="text-[length:var(--text-xs)] text-amber-600/60 dark:text-amber-400/60 tracking-wide font-bold">{lbl}</p>
 </div>
 ))}
 </div>
 )}

 {/* Weekly breakdown list */}
 {activeWeeks.length > 0 && (
 <div className="space-y-[var(--space-xs)]">
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide font-bold">{t("worker.weeklyDetail")}</p>
 {activeWeeks.map((week) => {
 const weekPast = week.actualServices === week.services;
 const wbd = week.breakdown;
 const weekHasOT = week.overtime > 0;
 return (
 <div key={week.week.from} className="flex flex-wrap items-center justify-between gap-x-[var(--space-md)] gap-y-[var(--space-xs)] py-[var(--space-xs)] border-b border-foreground/5">
 <span className="text-[length:var(--text-sm)] text-muted-foreground min-w-0 shrink">{fmtWeekLabel(week.week.from, week.week.to)}</span>
 <span className="flex flex-wrap items-center justify-end gap-x-[var(--space-md)] gap-y-[var(--space-xs)]">
 {!weekPast ? (
 <span className="flex flex-col items-end leading-tight">
 <span className="font-mono text-[length:var(--text-sm)] font-bold">{week.hours.toFixed(1)}h</span>
 <span className="font-mono text-[10px] text-muted-foreground/50">{t("worker.actualHoursSuffix", { hours: week.actualHours.toFixed(1) })}</span>
 </span>
 ) : (
 <span className="font-mono text-[length:var(--text-sm)] font-bold">{week.hours.toFixed(1)}h</span>
 )}
 {weekHasOT && (
 <span className="font-mono text-[length:var(--text-xs)] text-amber-600 dark:text-amber-400 flex flex-wrap gap-[var(--space-sm)]">
 {wbd.rate110 > 0 && <span>{wbd.rate110.toFixed(1)}@110</span>}
 {wbd.rate120 > 0 && <span>{wbd.rate120.toFixed(1)}@120</span>}
 {wbd.rate150 > 0 && <span>{wbd.rate150.toFixed(1)}@150</span>}
 </span>
 )}
 </span>
 </div>
 );
 })}
 </div>
 )}
 </div>
 ) : (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide text-center py-[var(--space-xl)]">{t("common.noServicesThisMonth")}</p>
 )
 )}
 </div>
 );
}
