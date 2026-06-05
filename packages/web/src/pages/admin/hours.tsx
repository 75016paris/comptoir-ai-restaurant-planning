import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { api, type MonthlyRecap, type MonthlyRecapWorker, type MonthlyRecapWeek, type TimeclockConfirmation } from "@/lib/api";
import { UnderlineNav } from "@/components/underline-nav";
import {
 Table,
 TableBody,
 TableCell,
 TableHeader,
 TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { fmtDateShort, fmtDateRange, fmtMonthYearCap } from "@/lib/date-utils";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { SortableHead } from "@/components/sortable-head";
import { useSort, applySortNum } from "@/components/sortable-head-utils";

function getMonthKey(offset: number): { key: string; label: string } {
 const d = new Date();
 d.setDate(1);
 d.setMonth(d.getMonth() + offset);
 const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
 const label = fmtMonthYearCap(d);
 return { key, label };
}

function fmtWeekLabel(from: string, to: string): string {
 return fmtDateRange(from, to);
}

/** Format a number — integers stay clean, hours get .1 */
function fmt(v: number, isInt = false): string {
 return isInt ? String(Math.round(v)) : v.toFixed(1);
}

function monthlyContractHours(weeklyHours: number | null | undefined, monthKey: string): number | null {
 if (!weeklyHours) return null;
 const [year, month] = monthKey.split("-").map(Number);
 const daysInMonth = new Date(year, month, 0).getDate();
 return weeklyHours * (daysInMonth / 7);
}

function paidHours(worker: MonthlyRecapWorker, actual = false): number {
 return actual ? worker.actualHours + worker.actualHolidayHours : worker.totalHours + worker.holidayHours;
}

function DeltaValue({ value }: { value: number | null }) {
 return (
 <span className={cn(
 "font-mono text-[length:var(--text-sm)] font-bold",
 value === null ? "text-muted-foreground/30" : value > 0.5 ? "text-amber-600 dark:text-amber-400" : value < -0.5 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
 )}>
 {value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}h`}
 </span>
 );
}

function HoursOrDash({ value, bold = false, muted = false }: { value: number; bold?: boolean; muted?: boolean }) {
 if (Math.abs(value) < 0.05) return <span className="font-mono text-[length:var(--text-sm)] text-muted-foreground/30">—</span>;
 return <span className={cn("font-mono text-[length:var(--text-sm)]", bold && "font-bold", muted && "text-muted-foreground")}>{value.toFixed(1)}h</span>;
}

/** Show actual value on top, projected (muted) underneath when they differ */
function DualValue({ actual, projected, unit = "", isInt = false, bold = false, amber = false, size = "sm" }: {
 actual: number; projected: number; unit?: string; isInt?: boolean; bold?: boolean; amber?: boolean; size?: "sm" | "xs";
}) {
 const same = actual === projected;
 const textSize = size === "sm" ? "text-[length:var(--text-sm)]" : "text-[length:var(--text-xs)]";
 const amberClass = amber ? "text-amber-600 dark:text-amber-400" : "";
 const display = (v: number) => v > 0 || !amber ? `${fmt(v, isInt)}${unit}` : "—";

 if (same) {
 return (
 <span className={cn("font-mono", textSize, bold && "font-bold", amberClass)}>
 {display(projected)}
 </span>
 );
 }

 return (
 <span className="flex flex-col items-end leading-tight">
 <span className={cn("font-mono", textSize, bold && "font-bold", amberClass)}>
 {display(actual)}
 </span>
 <span className={cn("font-mono text-[10px] text-muted-foreground/50", amber && projected > 0 && "text-amber-600/40 dark:text-amber-400/40")}>
 {display(projected)}
 </span>
 </span>
 );
}

// ── Monthly view: worker rows with expandable weeks ──

function MonthlyWorkerRow({ worker, month, isPast }: { worker: MonthlyRecapWorker; month: string; isPast: boolean }) {
 const { t } = useTranslation("hours");
 const [expanded, setExpanded] = useState(false);
 const bd = worker.overtimeBreakdown;
 const abd = worker.actualOvertimeBreakdown;

 return (
 <>
 <TableRow
 className={cn("border-foreground/5 cursor-pointer hover:bg-foreground/[0.02] transition-colors", expanded && "bg-foreground/[0.02]")}
 onClick={() => setExpanded(!expanded)}
 >
 <TableCell className="font-bold text-[length:var(--text-sm)]">
 <span className="flex items-center gap-[var(--space-xs)]">
 <ChevronRight className={cn("size-3 text-muted-foreground/40 transition-transform shrink-0", expanded && "rotate-90")} />
 {worker.workerName}
 </span>
 </TableCell>
 <TableCell className="text-right text-[length:var(--text-xs)] text-muted-foreground">
 {t(worker.workerRole === "kitchen" ? "roles:kitchen" : "roles:floor")}
 </TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-xs)] text-muted-foreground">
 {(() => {
 const contract = monthlyContractHours(worker.contractHours, month);
 return contract === null ? "—" : `${contract.toFixed(1)}h`;
 })()}
 </TableCell>
 <TableCell className="text-right">
 {isPast
 ? <span className="font-mono text-[length:var(--text-sm)]">{worker.serviceCount}</span>
 : <DualValue actual={worker.actualServiceCount} projected={worker.serviceCount} isInt />}
 </TableCell>
 <TableCell className="text-right">
 {isPast ? (
 <HoursOrDash value={worker.totalHours} bold />
 ) : (
 <DualValue actual={worker.actualHours} projected={worker.totalHours} unit="h" bold />
 )}
 </TableCell>
 <TableCell className="text-right">
 {isPast
 ? <HoursOrDash value={worker.holidayHours} />
 : <DualValue actual={worker.actualHolidayHours} projected={worker.holidayHours} unit="h" />}
 </TableCell>
 {(() => {
 const monthlyContract = monthlyContractHours(worker.contractHours, month);
 const delta = monthlyContract !== null ? paidHours(worker) - monthlyContract : null;
 return (
 <TableCell className="text-right">
 <DeltaValue value={delta} />
 </TableCell>
 );
 })()}
 <TableCell className="text-right"><DualValue actual={abd.rate110} projected={bd.rate110} unit="h" amber /></TableCell>
 <TableCell className="text-right"><DualValue actual={abd.rate120} projected={bd.rate120} unit="h" amber /></TableCell>
 <TableCell className="text-right"><DualValue actual={abd.rate150} projected={bd.rate150} unit="h" amber /></TableCell>
 </TableRow>

 {expanded && worker.weeks.filter(w => w.services > 0).map((week) => {
 const wp = week.actualServices === week.services;
 return (
 <TableRow key={week.week.from} className="border-foreground/[0.03] bg-foreground/[0.015]">
 <TableCell className="text-[length:var(--text-xs)] text-muted-foreground pl-[var(--space-xl)]" colSpan={3}>
 {fmtWeekLabel(week.week.from, week.week.to)}
 </TableCell>
 <TableCell className="text-right text-[length:var(--text-xs)] text-muted-foreground">
 {wp ? week.services : <DualValue actual={week.actualServices} projected={week.services} size="xs" isInt />}
 </TableCell>
 <TableCell className="text-right">
 {wp
 ? <span className="font-mono text-[length:var(--text-xs)] text-muted-foreground">{week.hours.toFixed(1)}h</span>
 : <DualValue actual={week.actualHours} projected={week.hours} unit="h" size="xs" />}
 </TableCell>
 <TableCell />
 <TableCell />
 <TableCell className={cn("text-right font-mono text-[length:var(--text-xs)]", week.breakdown.rate110 > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/20")}>
 {wp ? (week.breakdown.rate110 > 0 ? week.breakdown.rate110.toFixed(1) : "—") : <DualValue actual={week.actualBreakdown.rate110} projected={week.breakdown.rate110} size="xs" amber />}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-xs)]", week.breakdown.rate120 > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/20")}>
 {wp ? (week.breakdown.rate120 > 0 ? week.breakdown.rate120.toFixed(1) : "—") : <DualValue actual={week.actualBreakdown.rate120} projected={week.breakdown.rate120} size="xs" amber />}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-xs)]", week.breakdown.rate150 > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/20")}>
 {wp ? (week.breakdown.rate150 > 0 ? week.breakdown.rate150.toFixed(1) : "—") : <DualValue actual={week.actualBreakdown.rate150} projected={week.breakdown.rate150} size="xs" amber />}
 </TableCell>
 </TableRow>
 );
 })}
 {expanded && worker.analytics.length > 0 && (
 <TableRow className="border-foreground/[0.03] bg-foreground/[0.01]">
 <TableCell colSpan={10} className="pl-[var(--space-xl)] py-[var(--space-sm)]">
 <div className="flex flex-wrap items-center gap-[var(--space-xs)] text-[length:var(--text-xs)]">
 <span className="font-bold text-muted-foreground">Analytique</span>
 {worker.analytics.map((section) => {
 const same = section.actualHours === section.totalHours && section.actualServiceCount === section.serviceCount;
 return (
 <span key={section.restaurantId} className="inline-flex items-center gap-1 rounded-[0.2rem] border border-foreground/10 px-[var(--space-xs)] py-[2px]">
 <span className="font-semibold">{section.restaurantName}</span>
 <span className="font-mono text-muted-foreground">
 {same
 ? `${section.totalHours.toFixed(1)}h · ${section.serviceCount} svc`
 : `${section.actualHours.toFixed(1)}h/${section.totalHours.toFixed(1)}h · ${section.actualServiceCount}/${section.serviceCount} svc`}
 </span>
 </span>
 );
 })}
 </div>
 </TableCell>
 </TableRow>
 )}
 </>
 );
}

// ── Weekly view: one week at a time, flat table per worker ──

type WeekSortCol = "name" | "role" | "contract" | "services" | "hours" | "holidays" | "delta" | "r110" | "r120" | "r150";

function WeeklyView({ recap, weekIndex }: {
 recap: MonthlyRecap; weekIndex: number;
}) {
 const { t } = useTranslation("hours");
 const { sort, toggle } = useSort<WeekSortCol>();
 // Collect all weeks across workers (they share the same week boundaries)
 const allWeeks = recap.workers[0]?.weeks ?? [];
 const activeWeeks = allWeeks.filter(w => {
 // Check if any worker has services this week
 return recap.workers.some(wr => wr.weeks.find(ww => ww.week.from === w.week.from && ww.services > 0));
 });

 if (activeWeeks.length === 0) {
 return <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide text-center py-[var(--space-xl)]">{t("common.noServices")}</p>;
 }

 const safeIdx = Math.min(weekIndex, activeWeeks.length - 1);
 const currentWeek = activeWeeks[safeIdx];
 // Build per-worker data for this week
 type WeekWorker = { name: string; role: string; contractHours: number | null; week: MonthlyRecapWeek };
 const weekWorkersUnsorted: WeekWorker[] = recap.workers
 .map(w => {
 const wk = w.weeks.find(ww => ww.week.from === currentWeek.week.from);
 return wk && wk.services > 0 ? { name: w.workerName, role: w.workerRole, contractHours: w.contractHours, week: wk } : null;
 })
 .filter(Boolean) as WeekWorker[];

 const weekWorkers = applySortNum(weekWorkersUnsorted, sort, {
   name: w => w.name,
   role: w => w.role,
   contract: w => w.contractHours ?? 0,
   services: w => w.week.services,
   hours: w => w.week.hours,
   delta: w => w.contractHours ? w.week.hours - w.contractHours : -9999,
   r110: w => w.week.breakdown.rate110,
   r120: w => w.week.breakdown.rate120,
   r150: w => w.week.breakdown.rate150,
 });

 const totServices = weekWorkers.reduce((s, w) => s + w.week.services, 0);
 const totHours = weekWorkers.reduce((s, w) => s + w.week.hours, 0);
 const totOT = weekWorkers.reduce((s, w) => s + w.week.overtime, 0);

 return (
 <div className="space-y-[var(--space-md)]">
 {/* Week stat cards */}
 <div className="grid grid-cols-3 gap-[var(--space-md)] border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{totHours.toFixed(0)}h</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.worked")}</p>
 </div>
 <div className="text-center">
 <p className={cn("text-[length:var(--text-2xl)] font-bold font-mono", totOT > 0 ? "text-amber-600 dark:text-amber-400" : "")}>
 {totOT > 0 ? `+${totOT.toFixed(0)}h` : "0h"}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.overtime")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{totServices}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.services")}</p>
 </div>
 </div>

 {(() => {
 const workersWithOT = weekWorkers.filter(w => w.week.overtime > 0).length;
 return (
 <>
 <p className="text-[length:var(--text-xs)] text-muted-foreground/60 tracking-wide">{t("common.dualValueLegend")}</p>
 {workersWithOT > 0 && (
 <p className="text-[length:var(--text-xs)] text-amber-600 dark:text-amber-400 tracking-wide font-bold">
 {t("alerts.workersWithOTWeekly", { count: workersWithOT })}
 </p>
 )}
 </>
 );
 })()}

 {/* Week table */}
 <div className="overflow-x-auto scrollbar-none -mx-[var(--space-md)] px-[var(--space-md)] md:mx-0 md:px-0">
 <Table>
 <TableHeader>
 <TableRow className="border-foreground/10">
 <SortableHead col="name" label={t("table.headers.name")} sort={sort} toggle={toggle} align="left" />
 <SortableHead col="role" label={t("table.headers.role")} sort={sort} toggle={toggle} />
 <SortableHead col="contract" label={t("table.headers.contract")} sort={sort} toggle={toggle} />
 <SortableHead col="services" label={t("table.headers.services")} sort={sort} toggle={toggle} />
 <SortableHead col="hours" label={t("table.headers.worked")} sort={sort} toggle={toggle} />
 <SortableHead col="delta" label={t("table.headers.weekDelta")} sort={sort} toggle={toggle} />
 <SortableHead col="r110" label={t("table.headers.ot110")} sort={sort} toggle={toggle} className="text-amber-600 dark:text-amber-400" />
 <SortableHead col="r120" label={t("table.headers.ot120")} sort={sort} toggle={toggle} className="text-amber-600 dark:text-amber-400" />
 <SortableHead col="r150" label={t("table.headers.ot150")} sort={sort} toggle={toggle} className="text-amber-600 dark:text-amber-400" />
 </TableRow>
 </TableHeader>
 <TableBody>
 {weekWorkers.map((w) => {
 const delta = w.contractHours ? w.week.hours - w.contractHours : null;
 return (
 <TableRow key={w.name} className="border-foreground/5">
 <TableCell className="font-bold text-[length:var(--text-sm)]">{w.name}</TableCell>
 <TableCell className="text-right text-[length:var(--text-xs)] text-muted-foreground">{t(w.role === "kitchen" ? "roles:kitchen" : "roles:floor")}</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-xs)] text-muted-foreground">{w.contractHours ? `${w.contractHours}h` : "—"}</TableCell>
 <TableCell className="text-right"><DualValue actual={w.week.actualServices} projected={w.week.services} isInt /></TableCell>
 <TableCell className="text-right"><DualValue actual={w.week.actualHours} projected={w.week.hours} unit="h" bold /></TableCell>
 <TableCell className="text-right">
 <DeltaValue value={delta} />
 </TableCell>
 <TableCell className="text-right"><DualValue actual={w.week.actualBreakdown.rate110} projected={w.week.breakdown.rate110} unit="h" amber /></TableCell>
 <TableCell className="text-right"><DualValue actual={w.week.actualBreakdown.rate120} projected={w.week.breakdown.rate120} unit="h" amber /></TableCell>
 <TableCell className="text-right"><DualValue actual={w.week.actualBreakdown.rate150} projected={w.week.breakdown.rate150} unit="h" amber /></TableCell>
 </TableRow>
 );
 })}
 {weekWorkers.length > 0 && (
 <TableRow className="font-bold border-t-2 border-foreground">
 <TableCell className="text-[length:var(--text-sm)] " colSpan={3}>{t("common.total")}</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">{totServices}</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">{totHours.toFixed(1)}h</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">
 {(() => {
 const totContract = weekWorkers.reduce((s, w) => s + (w.contractHours ?? 0), 0);
 const totDelta = totHours - totContract;
 return <DeltaValue value={totDelta} />;
 })()}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-sm)]", "text-amber-600 dark:text-amber-400")}>{weekWorkers.reduce((s, w) => s + w.week.breakdown.rate110, 0).toFixed(1)}h</TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-sm)]", "text-amber-600 dark:text-amber-400")}>{weekWorkers.reduce((s, w) => s + w.week.breakdown.rate120, 0).toFixed(1)}h</TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-sm)]", "text-amber-600 dark:text-amber-400")}>{weekWorkers.reduce((s, w) => s + w.week.breakdown.rate150, 0).toFixed(1)}h</TableCell>
 </TableRow>
 )}
 </TableBody>
 </Table>
 </div>
 </div>
 );
}

// ── Payroll export view ──

type PayrollSortCol = "name" | "role" | "days" | "base" | "ot110" | "ot120" | "ot150" | "holidays" | "meals";

function PayrollView({ monthKey }: { monthKey: string }) {
 const { t } = useTranslation("hours");
 const [expandedWorker, setExpandedWorker] = useState<string | null>(null);
 const { sort, toggle } = useSort<PayrollSortCol>();

 const payrollQuery = useQuery({
 queryKey: qk.payroll.monthly(monthKey),
 queryFn: async () => (await api.getPayrollExport(monthKey)).data,
 });
 const data = payrollQuery.data ?? null;
 const loading = payrollQuery.isPending;

 useEffect(() => {
 setExpandedWorker(null);
 }, [monthKey]);

 useEffect(() => {
 if (payrollQuery.error) toast.error(t("payroll.loadError"));
 }, [payrollQuery.error, t]);

 async function downloadFile(url: string, filename: string) {
 try {
 const res = await fetch(url, { credentials: "include" });
 if (!res.ok) {
 const errorBody = await res.json().catch(() => null) as { error?: string; missingMatricules?: string[] } | null;
 if (errorBody?.missingMatricules?.length) {
 throw new Error(`${errorBody.error}: ${errorBody.missingMatricules.join(", ")}`);
 }
 throw new Error(errorBody?.error || `HTTP ${res.status}`);
 }
 const blob = await res.blob();
 const href = URL.createObjectURL(blob);
 const a = document.createElement("a");
 a.href = href;
 a.download = filename;
 a.click();
 URL.revokeObjectURL(href);
 toast.success(t("payroll.downloadSuccess", { filename }));
 } catch (error) {
 toast.error(error instanceof Error ? error.message : t("payroll.downloadError"));
 }
 }

 if (loading) {
 return <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("common.loading")}</p>;
 }

 if (!data || data.workers.length === 0) {
 return <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide text-center py-[var(--space-xl)]">{t("payroll.noData")}</p>;
 }

 return (
 <div className="space-y-[var(--space-lg)]">
 {/* Header with download button */}
 <div className="flex items-center justify-between">
 <div className="space-y-[var(--space-xs)]">
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
 {t("payroll.headerInfo", { name: data.restaurantName, base: data.baseReference, threshold: data.otThreshold })}
 </p>
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <Button
 variant="outline"
 size="sm"
 onClick={() => downloadFile(api.getPayrollCSVUrl(monthKey), `paie-${monthKey}.csv`)}
 className="text-[length:var(--text-xs)] tracking-wide font-bold"
 >
 CSV
 </Button>
 <Button
 variant="outline"
 size="sm"
 onClick={() => downloadFile(api.getPayrollSilaeUrl(monthKey), `silae-${monthKey}.csv`)}
 className="text-[length:var(--text-xs)] tracking-wide font-bold"
 >
 Silae
 </Button>
 </div>
 </div>

 {/* Summary cards */}
 <div className="grid grid-cols-3 sm:grid-cols-5 gap-[var(--space-md)] border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{data.totals.totalHours.toFixed(0)}h</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.totalHours")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{data.totals.baseHours.toFixed(0)}h</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.baseHours")}</p>
 </div>
 <div className="text-center">
 <p className={cn("text-[length:var(--text-2xl)] font-bold font-mono", data.totals.overtimeHours > 0 ? "text-amber-600 dark:text-amber-400" : "")}>
 {data.totals.overtimeHours > 0 ? `+${data.totals.overtimeHours.toFixed(1)}h` : "0h"}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.overtime")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{data.totals.holidayDays}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.holidays")}</p>
 </div>
 <div className="text-center">
 <p className="text-[length:var(--text-2xl)] font-bold font-mono">{data.totals.sickDays}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("summary.sickDays")}</p>
 </div>
 </div>

 {/* Payroll table */}
 <div className="overflow-x-auto scrollbar-none -mx-[var(--space-md)] px-[var(--space-md)] md:mx-0 md:px-0">
 <Table>
 <TableHeader>
 <TableRow className="border-foreground/10">
 <SortableHead col="name" label={t("table.headers.name")} sort={sort} toggle={toggle} align="left" />
 <SortableHead col="role" label={t("table.headers.role")} sort={sort} toggle={toggle} />
 <SortableHead col="days" label={t("payroll.headers.days")} sort={sort} toggle={toggle} />
 <SortableHead col="base" label={t("payroll.headers.baseHours")} sort={sort} toggle={toggle} />
 <SortableHead col="ot110" label={t("payroll.headers.ot110")} sort={sort} toggle={toggle} className="text-amber-600 dark:text-amber-400" />
 <SortableHead col="ot120" label={t("payroll.headers.ot120")} sort={sort} toggle={toggle} className="text-amber-600 dark:text-amber-400" />
 <SortableHead col="ot150" label={t("payroll.headers.ot150")} sort={sort} toggle={toggle} className="text-amber-600 dark:text-amber-400" />
 <SortableHead col="holidays" label={t("payroll.headers.holidays")} sort={sort} toggle={toggle} />
 <SortableHead col="meals" label={t("payroll.headers.meals")} sort={sort} toggle={toggle} />
 </TableRow>
 </TableHeader>
 <TableBody>
 {applySortNum(data.workers, sort, {
   name: w => w.name,
   role: w => w.role,
   days: w => w.daysWorked,
   base: w => w.baseHours,
   ot110: w => w.ot110,
   ot120: w => w.ot120,
   ot150: w => w.ot150,
   holidays: w => w.holidayDays,
   meals: w => w.mealDays,
 }).map((w) => (
 <>
 <TableRow
 key={w.workerId}
 className={cn("border-foreground/5 cursor-pointer hover:bg-foreground/[0.02] transition-colors", expandedWorker === w.workerId && "bg-foreground/[0.02]")}
 onClick={() => setExpandedWorker(expandedWorker === w.workerId ? null : w.workerId)}
 >
 <TableCell className="font-bold text-[length:var(--text-sm)]">
 <span className="flex items-center gap-[var(--space-xs)]">
 <ChevronRight className={cn("size-3 text-muted-foreground/40 transition-transform shrink-0", expandedWorker === w.workerId && "rotate-90")} />
 {w.name}
 </span>
 </TableCell>
 <TableCell className="text-right text-[length:var(--text-xs)] text-muted-foreground">
 {t(w.role === "kitchen" ? "roles:kitchen" : "roles:floor")}
 </TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">{w.daysWorked}</TableCell>
 <TableCell className="text-right font-mono font-bold text-[length:var(--text-sm)]">{w.baseHours.toFixed(1)}h</TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-sm)]", w.ot110 > 0 ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground/30")}>
 {w.ot110 > 0 ? `${w.ot110.toFixed(1)}h` : "—"}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-sm)]", w.ot120 > 0 ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground/30")}>
 {w.ot120 > 0 ? `${w.ot120.toFixed(1)}h` : "—"}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-sm)]", w.ot150 > 0 ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground/30")}>
 {w.ot150 > 0 ? `${w.ot150.toFixed(1)}h` : "—"}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-sm)]", w.holidayDays > 0 ? "" : "text-muted-foreground/30")}>
 {w.holidayDays > 0 ? `${w.holidayDays}j` : "—"}
 {w.sickDays > 0 && <span className="text-red-500 dark:text-red-400 ml-1">+{w.sickDays}m</span>}
 </TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">{w.mealDays}</TableCell>
 </TableRow>

 {/* Weekly breakdown */}
 {expandedWorker === w.workerId && w.weeks.map((wk) => (
 <TableRow key={wk.from} className="border-foreground/[0.03] bg-foreground/[0.015]">
 <TableCell className="text-[length:var(--text-xs)] text-muted-foreground pl-[var(--space-xl)]" colSpan={3}>
 {t("payroll.weekRow.label", { num: wk.weekNum, from: fmtDateShort(wk.from), to: fmtDateShort(wk.to) })}
 {wk.straddling && <span className="ml-1 text-[10px] text-muted-foreground/40">{t("payroll.weekRow.straddling")}</span>}
 </TableCell>
 <TableCell className="text-right text-[length:var(--text-xs)] text-muted-foreground font-mono" />
 <TableCell className="text-right text-[length:var(--text-xs)] text-muted-foreground font-mono">
 {wk.monthHours.toFixed(1)}h
 {wk.straddling && <span className="text-[10px] text-muted-foreground/40 block">{t("payroll.weekRow.weekHoursSuffix", { hours: wk.totalHours.toFixed(1) })}</span>}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-xs)]", wk.breakdown.rate110 > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/20")}>
 {wk.breakdown.rate110 > 0 ? wk.breakdown.rate110.toFixed(1) : "—"}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-xs)]", wk.breakdown.rate120 > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/20")}>
 {wk.breakdown.rate120 > 0 ? wk.breakdown.rate120.toFixed(1) : "—"}
 </TableCell>
 <TableCell className={cn("text-right font-mono text-[length:var(--text-xs)]", wk.breakdown.rate150 > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/20")}>
 {wk.breakdown.rate150 > 0 ? wk.breakdown.rate150.toFixed(1) : "—"}
 </TableCell>
 <TableCell />
 <TableCell />
 </TableRow>
 ))}
 </>
 ))}

 {/* Totals */}
 {data.workers.length > 0 && (
 <TableRow className="font-bold border-t-2 border-foreground">
 <TableCell className="text-[length:var(--text-sm)] " colSpan={3}>{t("common.total")}</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">{data.totals.daysWorked}</TableCell>
 <TableCell className="text-right font-mono font-bold text-[length:var(--text-sm)]">{data.totals.baseHours.toFixed(1)}h</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)] text-amber-600 dark:text-amber-400">{data.totals.ot110.toFixed(1)}h</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)] text-amber-600 dark:text-amber-400">{data.totals.ot120.toFixed(1)}h</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)] text-amber-600 dark:text-amber-400">{data.totals.ot150.toFixed(1)}h</TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">{data.totals.holidayDays}j</TableCell>
 <TableCell />
 </TableRow>
 )}
 </TableBody>
 </Table>
 </div>

 {/* Legend */}
 <div className="text-[10px] text-muted-foreground/50 tracking-wide space-y-[var(--space-xs)]">
 <p>{t("payroll.legend.abbr")}</p>
 <p>{t("payroll.legend.calc")}</p>
 <p>{t("payroll.legend.exports")}</p>
 </div>
 </div>
 );
}

function PendingTimeclockConfirmations() {
 const { data, isPending, refetch } = useQuery({
 queryKey: qk.timeclock.pendingConfirmations(),
 queryFn: async () => (await api.pendingTimeclockConfirmations()).data,
 });
 const rows = data ?? [];
 const [confirming, setConfirming] = useState<string | null>(null);
 const confirm = async (row: TimeclockConfirmation) => {
 setConfirming(row.id);
 try {
 await api.confirmTimeclock(row.id);
 toast.success(`Pointage de ${row.userName ?? "l'employé"} confirmé`);
 await refetch();
 } catch (err) {
 toast.error(err instanceof Error ? err.message : "Confirmation impossible");
 } finally {
 setConfirming(null);
 }
 };
 if (isPending || rows.length === 0) return null;
 return (
 <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-[var(--space-md)] space-y-[var(--space-sm)]">
 <div>
 <p className="text-[length:var(--text-sm)] font-bold">Pointages à confirmer</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground">Ces pointages sont déjà enregistrés. Confirmez-les si l'heure est correcte, ou ajustez-les depuis la fiche employé.</p>
 </div>
 <div className="space-y-[var(--space-xs)]">
 {rows.map((row) => {
 const instant = row.tapOut || row.tapIn;
 const d = new Date(instant);
 const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
 return (
 <div key={row.id} className="flex items-center justify-between gap-[var(--space-sm)] rounded-md bg-background/70 border border-foreground/10 px-[var(--space-sm)] py-[var(--space-xs)]">
 <span className="text-[length:var(--text-sm)]"><span className="font-bold">{row.userName}</span> · {row.tapOut ? "sortie" : "arrivée"} {row.date} à {hhmm}</span>
 <Button size="sm" variant="outline" onClick={() => confirm(row)} disabled={confirming === row.id}>{confirming === row.id ? "..." : "Confirmer"}</Button>
 </div>
 );
 })}
 </div>
 </div>
 );
}

// ── Main page ──

export function HoursPage() {
 const { t } = useTranslation("hours");
 const [monthOffset, setMonthOffset] = useState(0);
 const [view, setView] = useState<"monthly" | "weekly" | "payroll">("weekly");
 const [weekIndex, setWeekIndex] = useState(0);
 const { sort: monthlySort, toggle: monthlyToggle } = useSort<WeekSortCol>();

 const { key, label } = getMonthKey(monthOffset);

 const recapQuery = useQuery({
 queryKey: qk.hours.monthlyRecap(key),
 queryFn: async () => (await api.getMonthlyRecap(key)).data,
 });
 const recap = recapQuery.data ?? null;
 const loading = recapQuery.isPending;

 // Weekly nav — computed at page level so header can use it
 const allWeeks = recap?.workers[0]?.weeks ?? [];
 const activeWeeks = allWeeks.filter(w =>
 recap!.workers.some(wr => wr.weeks.find(ww => ww.week.from === w.week.from && ww.services > 0))
 );
 const safeWeekIdx = Math.min(weekIndex, Math.max(0, activeWeeks.length - 1));
 const currentWeek = activeWeeks[safeWeekIdx];
 const weekLabel = currentWeek ? fmtWeekLabel(currentWeek.week.from, currentWeek.week.to) : label;

 useEffect(() => {
 if (!recap) return;
 const weeks = recap.workers[0]?.weeks ?? [];
 const lastActive = weeks.reduce((last, _w, i) =>
 recap.workers.some(wr => wr.weeks[i]?.services > 0) ? i : last, 0);
 queueMicrotask(() => setWeekIndex(lastActive));
 }, [recap]);

 const isPastMonth = recap ? key < recap.today.slice(0, 7) : monthOffset < 0;

 const totOT = recap ? recap.workers.reduce((s, w) => ({
 r110: s.r110 + w.overtimeBreakdown.rate110,
 r120: s.r120 + w.overtimeBreakdown.rate120,
 r150: s.r150 + w.overtimeBreakdown.rate150,
 ar110: s.ar110 + w.actualOvertimeBreakdown.rate110,
 ar120: s.ar120 + w.actualOvertimeBreakdown.rate120,
 ar150: s.ar150 + w.actualOvertimeBreakdown.rate150,
 }), { r110: 0, r120: 0, r150: 0, ar110: 0, ar120: 0, ar150: 0 }) : { r110: 0, r120: 0, r150: 0, ar110: 0, ar120: 0, ar150: 0 };

 const workersWithOT = recap?.workers.filter(w => w.overtimeHours > 0).length ?? 0;

 return (
 <div className="space-y-[var(--space-lg)]">
 <div className="flex flex-col gap-[var(--space-xs)]">
 <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em] shrink-0">{t("title")}</h1>
 <UnderlineNav
 items={[
 { value: "weekly", label: t("tabs.weekly") },
 { value: "monthly", label: t("tabs.monthly") },
 { value: "payroll", label: t("tabs.payroll") },
 ]}
 value={view}
 onChange={(v) => setView(v as "monthly" | "weekly" | "payroll")}
 />
 {view === "weekly" ? (
 <div className="flex items-center gap-[var(--space-xs)]">
 <button
 onClick={() => setWeekIndex(Math.max(0, safeWeekIdx - 1))}
 disabled={safeWeekIdx <= 0}
 className={cn("transition-colors p-1 rounded", safeWeekIdx <= 0 ? "text-muted-foreground/20 cursor-not-allowed" : "text-muted-foreground hover:text-foreground hover:bg-muted")}
 ><ChevronLeft className="size-4" /></button>
 <span className="text-[length:var(--text-sm)] font-semibold min-w-[140px] text-center">{weekLabel}</span>
 <button
 onClick={() => setWeekIndex(Math.min(activeWeeks.length - 1, safeWeekIdx + 1))}
 disabled={safeWeekIdx >= activeWeeks.length - 1}
 className={cn("transition-colors p-1 rounded", safeWeekIdx >= activeWeeks.length - 1 ? "text-muted-foreground/20 cursor-not-allowed" : "text-muted-foreground hover:text-foreground hover:bg-muted")}
 ><ChevronRight className="size-4" /></button>
 <button
 onClick={() => setMonthOffset(0)}
 className="text-[length:var(--text-xs)] font-medium text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-1 rounded hover:bg-muted ml-[var(--space-xs)]"
 >
 {t("nav.thisWeek")}
 </button>
 </div>
 ) : (
 <div className="flex items-center gap-[var(--space-xs)]">
 <button
 onClick={() => setMonthOffset((o) => o - 1)}
 className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
 ><ChevronLeft className="size-4" /></button>
 <span className="text-[length:var(--text-sm)] font-semibold min-w-[120px] text-center">{label}</span>
 <button
 onClick={() => setMonthOffset((o) => o + 1)}
 disabled={monthOffset >= 0}
 className={cn(
 "transition-colors p-1 rounded",
 monthOffset >= 0 ? "text-muted-foreground/20 cursor-not-allowed" : "text-muted-foreground hover:text-foreground hover:bg-muted"
 )}
 ><ChevronRight className="size-4" /></button>
 <button
 onClick={() => setMonthOffset(0)}
 className="text-[length:var(--text-xs)] font-medium text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-1 rounded hover:bg-muted ml-[var(--space-xs)]"
 >
 {t("nav.thisMonth")}
 </button>
 </div>
 )}
 </div>

 <PendingTimeclockConfirmations />

 {view === "payroll" ? (
 <PayrollView monthKey={key} />
 ) : loading ? (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("common.loading")}</p>
 ) : recap ? (
 view === "weekly" ? (
 <WeeklyView recap={recap} weekIndex={weekIndex} />
 ) : (
 <>
 {!isPastMonth && (
 <p className="text-[length:var(--text-xs)] text-muted-foreground/60 tracking-wide">{t("common.dualValueLegend")}</p>
 )}

 {workersWithOT > 0 && (
 <p className="text-[length:var(--text-xs)] text-amber-600 dark:text-amber-400 tracking-wide font-bold">
 {t("alerts.workersWithOTMonthly", { count: workersWithOT })}
 </p>
 )}

 {/* Monthly table */}
 <div className="overflow-x-auto scrollbar-none -mx-[var(--space-md)] px-[var(--space-md)] md:mx-0 md:px-0">
 <Table>
 <TableHeader>
 <TableRow className="border-foreground/10">
 <SortableHead col="name" label={t("table.headers.name")} sort={monthlySort} toggle={monthlyToggle} align="left" />
 <SortableHead col="role" label={t("table.headers.role")} sort={monthlySort} toggle={monthlyToggle} />
 <SortableHead col="contract" label={t("table.headers.contract")} sort={monthlySort} toggle={monthlyToggle} />
 <SortableHead col="services" label={t("table.headers.services")} sort={monthlySort} toggle={monthlyToggle} />
 <SortableHead col="hours" label={t("table.headers.worked")} sort={monthlySort} toggle={monthlyToggle} />
 <SortableHead col="holidays" label={t("table.headers.paidLeave")} sort={monthlySort} toggle={monthlyToggle} />
 <SortableHead col="delta" label={t("table.headers.payrollDelta")} sort={monthlySort} toggle={monthlyToggle} />
 <SortableHead col="r110" label={t("table.headers.ot110")} sort={monthlySort} toggle={monthlyToggle} className="text-amber-600 dark:text-amber-400" />
 <SortableHead col="r120" label={t("table.headers.ot120")} sort={monthlySort} toggle={monthlyToggle} className="text-amber-600 dark:text-amber-400" />
 <SortableHead col="r150" label={t("table.headers.ot150")} sort={monthlySort} toggle={monthlyToggle} className="text-amber-600 dark:text-amber-400" />
 </TableRow>
 </TableHeader>
 <TableBody>
 {applySortNum(recap.workers, monthlySort, {
   name: w => w.workerName,
   role: w => w.workerRole,
   contract: w => monthlyContractHours(w.contractHours, recap.month) ?? 0,
   services: w => w.serviceCount,
   hours: w => w.totalHours,
   holidays: w => w.holidayHours,
   delta: w => {
    const contract = monthlyContractHours(w.contractHours, recap.month);
    return contract !== null ? paidHours(w) - contract : -9999;
   },
   r110: w => w.overtimeBreakdown.rate110,
   r120: w => w.overtimeBreakdown.rate120,
   r150: w => w.overtimeBreakdown.rate150,
 }).map((w) => (
 <MonthlyWorkerRow key={w.workerId} worker={w} month={recap.month} isPast={isPastMonth} />
 ))}
 {recap.workers.length > 0 && (
 <TableRow className="font-bold border-t-2 border-foreground">
 <TableCell className="text-[length:var(--text-sm)] " colSpan={3}>{t("common.total")}</TableCell>
 <TableCell className="text-right">
 {isPastMonth
 ? <span className="font-mono text-[length:var(--text-sm)]">{recap.totals.serviceCount}</span>
 : <DualValue actual={recap.totals.actualServiceCount} projected={recap.totals.serviceCount} isInt />}
 </TableCell>
 <TableCell className="text-right">
 {isPastMonth ? (
 <HoursOrDash value={recap.totals.totalHours} bold />
 ) : (
 <DualValue actual={recap.totals.actualHours} projected={recap.totals.totalHours} unit="h" bold />
 )}
 </TableCell>
 <TableCell className="text-right">
 {isPastMonth
 ? <HoursOrDash value={recap.totals.holidayHours} />
 : <DualValue actual={recap.totals.actualHolidayHours} projected={recap.totals.holidayHours} unit="h" />}
 </TableCell>
 <TableCell className="text-right font-mono text-[length:var(--text-sm)]">
 {(() => {
 const totContract = recap.workers.reduce((s, w) => s + (monthlyContractHours(w.contractHours, recap.month) ?? 0), 0);
 const totDelta = recap.totals.totalHours + recap.totals.holidayHours - totContract;
 return <DeltaValue value={totDelta} />;
 })()}
 </TableCell>
 <TableCell className="text-right"><DualValue actual={totOT.ar110} projected={totOT.r110} unit="h" amber /></TableCell>
 <TableCell className="text-right"><DualValue actual={totOT.ar120} projected={totOT.r120} unit="h" amber /></TableCell>
 <TableCell className="text-right"><DualValue actual={totOT.ar150} projected={totOT.r150} unit="h" amber /></TableCell>
 </TableRow>
 )}
 </TableBody>
 </Table>
 </div>

 {recap.workers.length === 0 && (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide text-center py-[var(--space-xl)]">{t("common.noServicesThisMonth")}</p>
 )}
 </>
 )
 ) : null}
 </div>
 );
}
