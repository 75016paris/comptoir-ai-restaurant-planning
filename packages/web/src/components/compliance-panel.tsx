import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api, type ComplianceResult, type ComplianceViolation } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtDateShort } from "@/lib/date-utils";
import {
 Dialog,
 DialogContent,
 DialogHeader,
 DialogTitle,
 DialogDescription,
} from "@/components/ui/dialog";
import { ChevronRight, ExternalLink, AlertTriangle } from "lucide-react";
import type { ServiceRow } from "@/lib/api";

type Props = {
 weekDate: string; // any date in the week to check (YYYY-MM-DD)
 onWorkerClick?: (workerId: string) => void;
 weekPublished?: boolean;
 onTogglePublish?: () => void | Promise<void>;
 publishLoading?: boolean;
 weekServices?: ServiceRow[]; // when provided, surfaces sub-role cross-fills as alerts
};

/** Severity badge — compact inline label */
function SeverityBadge({ severity }: { severity: "error" | "warning" | "info" }) {
 const { t } = useTranslation("schedule");
 const styles = {
 error: "bg-red-500/15 text-red-600 dark:text-red-400",
 warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
 info: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
 };
 return (
 <span
 className={cn(
        "inline-block px-[var(--space-xs)] py-[1px] text-[length:var(--text-2xs)] font-bold uppercase tracking-widest rounded-[0.15rem]",
 styles[severity],
 )}
 >
 {t(`compliance.badges.${severity}`)}
 </span>
 );
}

/** Compact summary badge for the schedule header */
export function ComplianceBadge({ weekDate, onClick }: { weekDate: string; onClick: () => void }) {
 const { t } = useTranslation("schedule");
 const [result, setResult] = useState<ComplianceResult | null>(null);
 const [loading, setLoading] = useState(false);

 const check = useCallback(async () => {
 setLoading(true);
 try {
 const res = await api.checkCompliance(weekDate);
 setResult(res.data);
 } catch {
 setResult(null);
 } finally {
 setLoading(false);
 }
 }, [weekDate]);

 useEffect(() => {
 check();
 }, [check]);

 if (loading) {
 return (
 <button
 onClick={onClick}
        className="h-9 px-[var(--space-lg)] tracking-normal text-[length:11px] font-bold border border-border text-muted-foreground"
 >
 ...
 </button>
 );
 }

 if (!result) return null;

 const { errors, warnings } = result.summary;

 return (
 <button
 onClick={onClick}
 className={cn(
        "inline-flex items-center gap-1 px-[var(--space-md)] py-[3px] rounded-full border text-[length:var(--text-xs)] font-bold transition-colors cursor-pointer",
 errors > 0
 ? "border-red-500 bg-red-500 text-white hover:bg-red-600"
 : warnings > 0
 ? "border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20"
 : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20",
 )}
 >
 {errors > 0
 ? t("compliance.badges.errCount", { count: errors })
 : warnings > 0
 ? t("compliance.badges.alertCount", { count: warnings })
 : t("compliance.badges.compliant")}
 </button>
 );
}

/** Full compliance panel — shown in a dialog */
export function CompliancePanel({ weekDate, onWorkerClick, weekPublished, onTogglePublish, publishLoading, weekServices }: Props) {
 const { t } = useTranslation("schedule");
 const [result, setResult] = useState<ComplianceResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [expandedWorker, setExpandedWorker] = useState<string | null>(null);

 const check = useCallback(async () => {
 setLoading(true);
 try {
 const res = await api.checkCompliance(weekDate);
 setResult(res.data);
 } catch {
 setResult(null);
 } finally {
 setLoading(false);
 }
 }, [weekDate]);

 useEffect(() => {
 check();
 }, [check]);

 if (loading) {
 return (
 <div className="flex items-center justify-center py-[var(--space-xl)]">
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">
 {t("compliance.panel.verifying")}
 </p>
 </div>
 );
 }

 if (!result) {
 return (
 <div className="flex items-center justify-center py-[var(--space-xl)]">
 <p className="text-muted-foreground text-[length:var(--text-sm)]">
 {t("compliance.panel.loadError")}
 </p>
 </div>
 );
 }

 const { violations, overtime, summary, week } = result;

 // Group violations by worker
 const byWorker = new Map<string, { name: string; violations: ComplianceViolation[] }>();
 for (const v of violations) {
 if (!byWorker.has(v.workerId)) {
 byWorker.set(v.workerId, { name: v.workerName, violations: [] });
 }
 byWorker.get(v.workerId)!.violations.push(v);
 }

 return (
 <div className="space-y-[var(--space-md)]">
 {/* Summary bar */}
 <div className="flex items-center gap-[var(--space-md)] text-[length:var(--text-xs)]">
 <span className="font-bold tracking-wide text-muted-foreground">
 {t("compliance.panel.weekRange", { from: fmtDateShort(week.from), to: fmtDateShort(week.to) })}
 </span>
 <span className="text-muted-foreground">·</span>
 <span className="text-muted-foreground">{t("compliance.panel.workersChecked", { count: summary.workersChecked })}</span>
 {summary.errors > 0 && (
 <span className="font-bold text-red-600 dark:text-red-400">
 {t("compliance.panel.errors", { count: summary.errors })}
 </span>
 )}
 {summary.warnings > 0 && (
 <span className="font-bold text-amber-600 dark:text-amber-400">
 {t("compliance.panel.warnings", { count: summary.warnings })}
 </span>
 )}
 {summary.info > 0 && (
 <span className="text-blue-600 dark:text-blue-400">
 {t("compliance.panel.info", { count: summary.info })}
 </span>
 )}
 {summary.errors === 0 && summary.warnings === 0 && (
 <span className="font-bold text-emerald-600 dark:text-emerald-400">
 {t("compliance.badges.compliant")}
 </span>
 )}
 </div>

 {/* Sub-role cross-fills (substitutions) */}
 {weekServices && weekServices.some(s => s.filledAs) && (
 <div className="border border-amber-500/40 bg-amber-500/5 rounded-[0.2rem] p-[var(--space-md)] space-y-[var(--space-xs)]">
 <div className="flex items-center gap-[var(--space-xs)]">
 <AlertTriangle className="size-3 text-amber-600 dark:text-amber-400" />
 <span className="text-[length:var(--text-xs)] font-bold tracking-widest uppercase text-amber-600 dark:text-amber-400">
 {t("compliance.panel.subroleSubstitutionTitle")}
 </span>
 </div>
 <p className="text-[length:var(--text-xs)] text-muted-foreground">
 {t("compliance.panel.subroleSubstitutionBody")}
 </p>
 <ul className="text-[length:var(--text-xs)] space-y-[2px]">
 {weekServices
 .filter(s => s.filledAs)
 .map(s => (
 <li key={s.id} className="flex items-center gap-[var(--space-xs)]">
 <span className="font-bold">{s.workerName}</span>
 <span className="text-muted-foreground">— {fmtDateShort(s.date)} {s.startTime}–{s.endTime}</span>
 <span className="text-amber-700 dark:text-amber-300">
 {t("compliance.panel.filledAs", { name: s.filledAs })}
 </span>
 </li>
 ))}
 </ul>
 </div>
 )}

 {/* Violations grouped by worker */}
 {violations.length === 0 ? (
 <div className="py-[var(--space-lg)] text-center">
 <p className="text-[length:var(--text-sm)] text-emerald-600 dark:text-emerald-400 font-bold tracking-wide">
 {t("compliance.panel.noViolations")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
 {t("compliance.panel.noViolationsBody")}
 </p>
 </div>
 ) : (
 <div className="space-y-[var(--space-xs)]">
 {[...byWorker.entries()].map(([workerId, { name, violations: workerViolations }]) => {
 const workerErrors = workerViolations.filter(v => v.severity === "error").length;
 const workerWarnings = workerViolations.filter(v => v.severity === "warning").length;
 const isExpanded = expandedWorker === workerId;

 return (
 <div key={workerId} className="border border-border rounded-[0.2rem]">
 {/* Worker header — clickable */}
 <button
 onClick={() => setExpandedWorker(isExpanded ? null : workerId)}
 className="w-full flex items-center justify-between px-[var(--space-md)] py-[var(--space-sm)] hover:bg-muted/50 transition-colors"
 >
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-sm)] font-bold tracking-wide">
 {name}
 </span>
 <div className="flex items-center gap-[var(--space-xs)]">
 {workerErrors > 0 && <SeverityBadge severity="error" />}
 {workerWarnings > 0 && <SeverityBadge severity="warning" />}
 </div>
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-xs)] text-muted-foreground">
 {t("compliance.panel.points", { count: workerViolations.length })}
 </span>
 <span className="text-[length:var(--text-xs)] text-muted-foreground">
 <ChevronRight className={cn("size-3 transition-transform", isExpanded && "rotate-90")} />
 </span>
 </div>
 </button>

 {/* Expanded violation list */}
 {isExpanded && (
 <div className="border-t border-border">
 {workerViolations.map((v, i) => (
 <div
 key={i}
 className={cn(
 "px-[var(--space-md)] py-[var(--space-sm)] border-b border-border/50 last:border-b-0",
 v.severity === "error" && "bg-red-500/5",
 v.severity === "warning" && "bg-amber-500/5",
 )}
 >
 <div className="flex items-start gap-[var(--space-sm)]">
 <SeverityBadge severity={v.severity} />
 <div className="flex-1 min-w-0">
 <p className="text-[length:var(--text-xs)] font-medium">
 {v.message}
 </p>
 <p className="text-[length:10px] text-muted-foreground mt-[1px]">
 {v.rule} · {v.code}
 {v.date && ` · ${v.date}`}
 </p>
 </div>
 </div>
 </div>
 ))}
 {/* Link to spotlight worker on schedule */}
 {onWorkerClick && workerId !== "__schedule__" && (
 <button
 onClick={() => onWorkerClick(workerId)}
 className="w-full px-[var(--space-md)] py-[var(--space-xs)] text-[length:10px] font-bold tracking-wide text-muted-foreground hover:text-foreground transition-colors text-center border-t border-border/50"
 >
 {t("compliance.panel.viewSchedule")} <ExternalLink className="size-3 inline" />
 </button>
 )}
 </div>
 )}
 </div>
 );
 })}
 </div>
 )}

 {/* Overtime summary */}
 {overtime.length > 0 && (
 <div className="border-t border-border pt-[var(--space-md)]">
 <h3 className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground mb-[var(--space-sm)]">
 {t("compliance.panel.overtimeTitle")}
 </h3>
 <div className="space-y-[var(--space-xs)]">
 {overtime.map((ot) => (
 <div
 key={ot.workerId}
 className="flex items-center justify-between px-[var(--space-md)] py-[var(--space-xs)] bg-blue-500/5 rounded-[0.2rem]"
 >
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide">
 {ot.workerName}
 </span>
 <div className="flex items-center gap-[var(--space-md)] text-[length:10px] tabular-nums">
 <span className="text-muted-foreground">{t("compliance.panel.totalHours", { value: ot.weeklyHours.toFixed(1) })}</span>
 <span className="font-bold">{t("compliance.panel.overtimeHours", { value: ot.overtimeHours.toFixed(1) })}</span>
 {ot.breakdown.rate110 > 0 && (
 <span className="text-muted-foreground">{t("compliance.panel.rate", { rate: 110, value: ot.breakdown.rate110.toFixed(1) })}</span>
 )}
 {ot.breakdown.rate120 > 0 && (
 <span className="text-muted-foreground">{t("compliance.panel.rate", { rate: 120, value: ot.breakdown.rate120.toFixed(1) })}</span>
 )}
 {ot.breakdown.rate150 > 0 && (
 <span className="text-amber-600 dark:text-amber-400 font-bold">{t("compliance.panel.rate", { rate: 150, value: ot.breakdown.rate150.toFixed(1) })}</span>
 )}
 </div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Legend */}
 <div className="border-t border-border pt-[var(--space-sm)] flex flex-wrap gap-[var(--space-md)] text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
 <span>{t("compliance.panel.legend")}</span>
 </div>

 {/* Publish action — co-located with violations so the admin can't ship without seeing them */}
 {onTogglePublish && (
 <div className="border-t border-border pt-[var(--space-md)] space-y-[var(--space-sm)]">
 {!weekPublished && summary.errors > 0 && (
 <p className="text-[length:var(--text-xs)] text-amber-600 dark:text-amber-400 font-medium">
 {t("compliance.panel.publishWarning", { count: summary.errors })}
 </p>
 )}
 <button
 type="button"
 onClick={onTogglePublish}
 disabled={publishLoading}
 className={cn(
 "w-full h-9 rounded-[0.2rem] tracking-wide text-[length:var(--text-sm)] font-bold transition-colors disabled:opacity-50",
 weekPublished
 ? "border border-red-500 text-red-600 hover:bg-red-500 hover:text-white"
 : summary.errors > 0
 ? "bg-amber-500 text-white hover:bg-amber-600"
 : "bg-emerald-600 text-white hover:bg-emerald-700",
 )}
 >
 {publishLoading
 ? "..."
 : weekPublished
 ? t("compliance.panel.unpublishButton")
 : summary.errors > 0
 ? t("compliance.panel.publishWithErrorsButton", { count: summary.errors })
 : t("compliance.panel.publishButton")}
 </button>
 <p className="text-[length:10px] text-muted-foreground text-center">
 {weekPublished
 ? t("compliance.panel.publishedFooter")
 : t("compliance.panel.unpublishedFooter")}
 </p>
 </div>
 )}
 </div>
 );
}

/** Dialog wrapper for easy integration */
export function ComplianceDialog({
 weekDate,
 open,
 onOpenChange,
 onWorkerClick,
 weekPublished,
 onTogglePublish,
 publishLoading,
 weekServices,
}: {
 weekDate: string;
 open: boolean;
 onOpenChange: (open: boolean) => void;
 onWorkerClick?: (workerId: string) => void;
 weekPublished?: boolean;
 onTogglePublish?: () => void | Promise<void>;
 publishLoading?: boolean;
 weekServices?: ServiceRow[];
}) {
 const { t } = useTranslation("schedule");
 return (
 <Dialog open={open} onOpenChange={onOpenChange}>
 <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-lg)] font-bold tracking-tight">
 {t("compliance.dialog.title")}
 </DialogTitle>
 <DialogDescription className="text-[length:var(--text-xs)] text-muted-foreground">
 {t("compliance.dialog.description")}
 </DialogDescription>
 </DialogHeader>
 <CompliancePanel
 weekDate={weekDate}
 onWorkerClick={onWorkerClick}
 weekPublished={weekPublished}
 onTogglePublish={onTogglePublish}
 publishLoading={publishLoading}
 weekServices={weekServices}
 />
 </DialogContent>
 </Dialog>
 );
}
