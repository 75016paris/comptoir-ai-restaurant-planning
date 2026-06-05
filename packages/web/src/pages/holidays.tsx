import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, type HolidayRequest, type HolidayImpact, type LeaveIntelligence, type ReplacementRequest, type User } from "@/lib/api";
import { uploadHolidayDocumentFile, uploadReplacementDocumentFile } from "@/lib/document-upload";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import i18n from "@/i18n";

import { Calendar } from "@/components/ui/calendar";
import type { DateRange } from "react-day-picker";
import { ArrowRight, X, HelpCircle, ChevronRight, CalendarDays, AlertTriangle, CheckCircle } from "lucide-react";
import { fmtDateShort, parseDate, toISO, JOURS_COURTS } from "@/lib/date-utils";
import { formatInstantInTimeZone, parseServerTimestamp } from "@comptoir/shared";
import { LEGAL_LINKS } from "@comptoir/shared/legal";

const labelClass = "text-[length:var(--text-sm)] uppercase tracking-wide font-extrabold text-foreground";
const fieldLabelClass = "text-[length:var(--text-xs)] uppercase tracking-widest font-semibold text-muted-foreground";
const inputClass = "border-foreground/20 bg-transparent";
const statusBorder: Record<string, string> = {
 pending: "border-amber-500",
 awaiting_admin_decision: "border-amber-500",
 awaiting_worker_reply: "border-sky-500",
 approved: "border-emerald-500",
 accepted: "border-emerald-500",
 approved_without_replacement: "border-emerald-500",
 rejected: "border-red-400",
 cancelled: "border-red-400",
 expired: "border-border",
};

function formatRelativeTime(iso: string | null | undefined, locale: string) {
 if (!iso) return null;
 const then = parseServerTimestamp(iso).getTime();
 if (Number.isNaN(then)) return null;
 const diffSeconds = Math.round((then - Date.now()) / 1000);
 const abs = Math.abs(diffSeconds);
 const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
 if (abs < 60) return rtf.format(diffSeconds, "second");
 const diffMinutes = Math.round(diffSeconds / 60);
 if (Math.abs(diffMinutes) < 60) return rtf.format(diffMinutes, "minute");
 const diffHours = Math.round(diffMinutes / 60);
 if (Math.abs(diffHours) < 24) return rtf.format(diffHours, "hour");
 const diffDays = Math.round(diffHours / 24);
 return rtf.format(diffDays, "day");
}


export function HolidaysPage() {
 const { t } = useTranslation("holidays");
 const { user } = useAuth();
 const queryClient = useQueryClient();
 const [startDate, setStartDate] = useState("");
 const [endDate, setEndDate] = useState("");
 const [reason, setReason] = useState("");
 const [medical, setMedical] = useState(false);
 const [files, setFiles] = useState<File[]>([]);

 const isAdmin = user?.role === "admin";

 const holidaysQuery = useQuery({
 queryKey: qk.holidays.list(),
 queryFn: async () => (await api.listHolidays()).data,
 refetchInterval: isAdmin ? 60_000 : false,
 });
 const replacementsQuery = useQuery({
 queryKey: qk.replacements.pending(),
 queryFn: async () => (await api.pendingReplacements()).data,
 refetchInterval: isAdmin ? 60_000 : false,
 });
 const usersQuery = useQuery({
 queryKey: qk.employees.list(false),
 queryFn: async () => (await api.listUsers()).data,
 });
 const medicalModeQuery = useQuery({
 queryKey: qk.settings.medicalMode(),
 queryFn: async () => (await api.getMedicalMode()).data,
 });
 const holidays: HolidayRequest[] = holidaysQuery.data ?? [];
 const replacements: ReplacementRequest[] = replacementsQuery.data ?? [];
 const users: User[] = usersQuery.data ?? [];
 const medicalMode = medicalModeQuery.data ?? false;
 const loading = holidaysQuery.isPending || replacementsQuery.isPending || usersQuery.isPending;

 const fetchData = () => {
 queryClient.invalidateQueries({ queryKey: qk.holidays.all() });
 queryClient.invalidateQueries({ queryKey: qk.replacements.all() });
 };

 const getUserName = (id: string) => users.find((u) => u.id === id)?.name ?? t("shared.unknown");

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 const docs = await Promise.all(files.map(async (f) => {
 const upload = await uploadHolidayDocumentFile(f);
 return {
 name: f.name,
 filename: upload.filename,
 mimeType: upload.mimeType,
 size: upload.size,
 storageKey: upload.storageKey,
 };
 }));
 await api.requestHoliday({
 startDate, endDate,
 reason: reason || undefined,
 medical: medical || undefined,
 documents: docs.length ? docs : undefined,
 });
 setStartDate(""); setEndDate(""); setReason(""); setMedical(false); setFiles([]);
 fetchData();
 };

 const handleReview = async (id: string, status: "approved" | "rejected") => {
 await api.reviewHoliday(id, status);
 fetchData();
 };

 const handleRespondReplacement = async (replacementId: string, response: "accepted" | "rejected") => {
 try {
 await api.respondReplacement(replacementId, response);
 fetchData();
 } catch (err) {
 console.error("Failed to respond to replacement", err);
 }
 };

 const handleReviewReplacement = async (
 replacementId: string,
 decision: "pick" | "broadcast" | "refuse" | "approve_absence",
 candidateId?: string,
 ) => {
 try {
 await api.reviewReplacement(replacementId, decision, candidateId);
 fetchData();
 } catch (err) {
 console.error("Failed to review replacement", err);
 }
 };


 return (
 <div className="space-y-[var(--space-md)]">
 <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em]">
 {t("list.title")}
 </h1>

 {/* ── Request form (workers only) ── */}
 {!isAdmin && (
 <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-sm)]">
 <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-[var(--space-sm)] md:gap-[var(--space-md)]">
 <DateRangePicker
 label={t("list.form.datesLabel")}
 start={startDate}
 end={endDate}
 onStartChange={setStartDate}
 onEndChange={setEndDate}
 />
 <div className="space-y-[var(--space-sm)] flex-1">
 <Label className={fieldLabelClass}>{t("list.form.reasonLabel")}</Label>
 <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("list.form.reasonPlaceholder")} className={inputClass} />
 </div>
 {/* Medical toggle - only visible when admin has enabled medical mode */}
 {medicalMode && (
 <button type="button" onClick={() => setMedical(!medical)}
                className={`h-9 px-3 rounded-full border text-[length:var(--text-xs)] tracking-normal font-bold transition-colors shrink-0 ${
 medical
 ? "bg-foreground text-background border-foreground"
 : "bg-transparent text-muted-foreground border-foreground/20 hover:border-foreground/40"
 }`}>
 {t("shared.medical")}
 </button>
 )}
 <Button type="submit" className="tracking-wide text-[length:var(--text-xs)] font-bold">{t("list.form.submit")}</Button>
 </form>
 {/* Drop zone + helper text when medical is toggled on */}
 {medical && (
 <div className="space-y-[var(--space-sm)]">
 <p className="text-[length:var(--text-xs)] text-muted-foreground">
 {t("list.form.medicalNote")}
 </p>
 <FileDropZone files={files} onChange={setFiles} />
 </div>
 )}
 </div>
 )}

 {/* ── Congés ── */}
 <div className="border-b border-border pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-md)]">
 <div className="flex items-center justify-between">
 <p className={labelClass}>{t("list.holidaysHeader")}</p>
 <Link
 to="/holidays/calendar"
 className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-2xs)] font-bold text-muted-foreground/50 hover:text-foreground transition-colors border border-foreground/15 rounded-full px-[var(--space-sm)] py-[2px] hover:border-foreground/30"
 >
 <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
 {t("shared.viewCalendar")}
 </Link>
 </div>
 {isAdmin && (
 <OwnerHolidayForm workers={users} onCreated={fetchData} />
 )}
 {loading ? (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("shared.loading")}</p>
 ) : (() => {
 const pendingHolidays = holidays.filter(h => h.status === "pending");
 const resolvedHolidays = holidays.filter(h => h.status !== "pending");
 return (
 <>
 {pendingHolidays.length === 0 && resolvedHolidays.length === 0 && (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide py-[var(--space-md)]">
 {t("list.noHolidays")}
 </p>
 )}
 {isAdmin && (
 <LeaveIntelligenceSection />
 )}
 {isAdmin && pendingHolidays.length > 0 && (
 <HowItWorksTopBar />
 )}
 {pendingHolidays.map((h) => (
 <HolidayRow key={h.id} h={h} isAdmin={isAdmin} onReview={handleReview} />
 ))}
 {resolvedHolidays.length > 0 && (
 <details className="group">
 <summary className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground cursor-pointer hover:text-foreground">
 {t("list.treatedHolidays", { count: resolvedHolidays.length })}
 </summary>
 <div className="mt-[var(--space-xs)] space-y-[var(--space-xs)] opacity-50">
 {resolvedHolidays.map((h) => (
 <HolidayRow key={h.id} h={h} isAdmin={isAdmin} onReview={handleReview} />
 ))}
 </div>
 </details>
 )}
 </>
 );
 })()}
 </div>

 {/* ── Remplacements ── */}
 <div className="-mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)] [&>*:not(:first-child)]:pl-[var(--space-md)] space-y-[var(--space-md)]">
 <p className={labelClass}>{t("list.replacementsHeader")}</p>
 {loading ? (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("shared.loading")}</p>
 ) : (() => {
 const openStatuses = new Set(["awaiting_admin_decision", "awaiting_worker_reply"]);
 const pendingReplacements = replacements.filter(s => openStatuses.has(s.status));
 const resolvedReplacements = replacements.filter(s => !openStatuses.has(s.status));
 return (
 <>
 {pendingReplacements.length === 0 && resolvedReplacements.length === 0 && (
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide py-[var(--space-md)]">
 {t("list.noReplacements")}
 </p>
 )}
 {pendingReplacements.map((replacement) => (
 <ReplacementRow key={replacement.id} replacement={replacement} userId={user?.id} restaurantTimezone={user?.restaurantTimezone} isAdmin={isAdmin} getUserName={getUserName} onRespond={handleRespondReplacement} onReview={handleReviewReplacement} />
 ))}
 {resolvedReplacements.length > 0 && (
 <details className="group">
 <summary className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground cursor-pointer hover:text-foreground">
 {t("list.treatedReplacements", { count: resolvedReplacements.length })}
 </summary>
 <div className="mt-[var(--space-xs)] space-y-[var(--space-xs)] opacity-50">
 {resolvedReplacements.map((replacement) => (
 <ReplacementRow key={replacement.id} replacement={replacement} userId={user?.id} restaurantTimezone={user?.restaurantTimezone} isAdmin={isAdmin} getUserName={getUserName} onRespond={handleRespondReplacement} onReview={handleReviewReplacement} />
 ))}
 </div>
 </details>
 )}
 </>
 );
 })()}
 </div>
 </div>
 );
}

function OwnerHolidayForm({ workers, onCreated }: { workers: User[]; onCreated: () => void }) {
 const { t } = useTranslation("holidays");
 const [workerId, setWorkerId] = useState("");
 const [startDate, setStartDate] = useState("");
 const [endDate, setEndDate] = useState("");
 const [reason, setReason] = useState("");
 const [submitting, setSubmitting] = useState(false);
 const workerOptions = useMemo(
  () => workers.filter((w) => w.active !== false && (w.role === "kitchen" || w.role === "floor")),
  [workers],
 );
 const selectedWorker = workerOptions.find((w) => w.id === workerId) ?? null;

 useEffect(() => {
  if (workerOptions.length === 0) {
   if (workerId) setWorkerId("");
   return;
  }
  if (!workerId || !workerOptions.some((w) => w.id === workerId)) {
   setWorkerId(workerOptions[0].id);
  }
 }, [workerOptions, workerId]);

 const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!workerId || !startDate) return;
  const finalEndDate = endDate || startDate;
  setSubmitting(true);
  try {
   await api.requestHoliday({
    workerId,
    startDate,
    endDate: finalEndDate,
    reason: reason.trim() || undefined,
   });
   toast.success(t("list.adminForm.success", { name: selectedWorker?.name ?? t("shared.unknown") }));
   setStartDate("");
   setEndDate("");
   setReason("");
   onCreated();
  } catch (err) {
   console.error("Failed to assign holiday", err);
   toast.error(err instanceof Error ? err.message : t("list.adminForm.error"));
  } finally {
   setSubmitting(false);
  }
 };

 return (
  <form onSubmit={handleSubmit} className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)] bg-foreground/[0.02] space-y-[var(--space-sm)]">
   <div>
    <p className="text-[length:var(--text-xs)] tracking-wide font-bold">{t("list.adminForm.title")}</p>
    <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("list.adminForm.description")}</p>
   </div>
   <div className="flex flex-wrap items-end gap-[var(--space-sm)] md:gap-[var(--space-md)]">
    <div className="space-y-[var(--space-xs)] min-w-[220px]">
     <Label className={fieldLabelClass}>{t("list.adminForm.workerLabel")}</Label>
     <Select value={workerId} onValueChange={(value) => setWorkerId(value ?? "")} disabled={workerOptions.length === 0 || submitting}>
      <SelectTrigger className="w-full h-8 rounded-full border-foreground/20 bg-transparent px-3 text-[length:var(--text-sm)] data-[size=default]:h-8">
       <SelectValue>{selectedWorker?.name ?? t("list.adminForm.noWorkers")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
       {workerOptions.map((worker) => (
        <SelectItem key={worker.id} value={worker.id}>{worker.name}</SelectItem>
       ))}
      </SelectContent>
     </Select>
    </div>
    <DateRangePicker
     label={t("list.form.datesLabel")}
     start={startDate}
     end={endDate}
     onStartChange={setStartDate}
     onEndChange={setEndDate}
    />
    <div className="space-y-[var(--space-xs)] flex-1 min-w-[200px]">
     <Label className={fieldLabelClass}>{t("list.form.reasonLabel")}</Label>
     <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("list.adminForm.reasonPlaceholder")} className={inputClass} />
    </div>
    <Button type="submit" disabled={submitting || !workerId || !startDate} className="tracking-wide text-[length:var(--text-xs)] font-bold">
     {submitting ? t("list.adminForm.submitting") : t("list.adminForm.submit")}
    </Button>
   </div>
  </form>
 );
}

function HolidayRow({ h, isAdmin, onReview }: {
 h: HolidayRequest;
 isAdmin: boolean;
 onReview: (id: string, status: "approved" | "rejected") => void;
}) {
 const { t } = useTranslation("holidays");
 const [actionHover, setActionHover] = useState<"approved" | "rejected" | null>(null);
 const impactQuery = useQuery({
 queryKey: qk.holidays.impact(h.id),
 queryFn: async () => (await api.getHolidayImpact(h.id)).data,
 enabled: isAdmin && h.status === "pending",
 staleTime: 5 * 60 * 1000,
 refetchOnWindowFocus: false,
 });
 const impact: HolidayImpact | null = impactQuery.data ?? null;
 const impactLoading = impactQuery.isPending && impactQuery.fetchStatus !== "idle";

 const statusKey =
   h.status === "pending" ? "shared.pending"
   : h.status === "approved" ? "shared.approved"
   : h.status === "rejected" ? "shared.rejected"
   : null;
 const statusText = statusKey ? t(statusKey) : h.status;

 return (
 <div className="py-[var(--space-xs)] space-y-[var(--space-xs)]">
 <div className="flex flex-wrap items-start sm:items-center justify-between gap-[var(--space-xs)]">
 <div className="min-w-0">
 {isAdmin && h.workerName && (
 <Link to={`/staff/${h.workerId}`} className="font-bold text-[length:var(--text-sm)] hover:underline">
 {h.workerName}
 </Link>
 )}
 <div className="flex items-center gap-[var(--space-sm)] flex-wrap">
 <span className={`${isAdmin && h.workerName ? "text-muted-foreground" : "font-bold"} text-[length:var(--text-sm)]`}>
 {fmtDateShort(h.startDate)} → {fmtDateShort(h.endDate)}
 </span>
 {h.reason && <span className="text-[length:var(--text-sm)] text-muted-foreground">- {h.reason}</span>}
 {h.medical && (
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold bg-foreground text-background px-[var(--space-xs)] py-[1px] rounded-full">
 {t("shared.medical")}
 </span>
 )}
 <span className={`text-[length:var(--text-xs)] font-medium text-muted-foreground border-l-2 pl-[var(--space-sm)] ${statusBorder[h.status] ?? "border-border"}`}>
 {statusText}
 </span>
 </div>
 </div>
 {isAdmin && h.status === "pending" && (
 <div className="flex items-center gap-[var(--space-sm)]">
 <Button size="sm"
 className={`tracking-wide text-[length:var(--text-xs)] font-bold transition-all ${
 actionHover === "rejected" ? "bg-background text-foreground border border-border" : ""
 }`}
 onClick={() => onReview(h.id, "approved")}>{t("shared.approve")}</Button>
 <Button size="sm" variant="outline"
 className={`tracking-wide text-[length:var(--text-xs)] font-bold transition-all hover:!bg-foreground hover:!text-background hover:!border-foreground ${
 actionHover === "rejected" ? "bg-foreground text-background border-foreground" : ""
 }`}
 onMouseEnter={() => setActionHover("rejected")}
 onMouseLeave={() => setActionHover(null)}
 onClick={() => onReview(h.id, "rejected")}>{t("shared.reject")}</Button>
 </div>
 )}
 </div>

 {/* Medical doc reminder */}
 {isAdmin && h.medical && (
 <p className="text-[length:var(--text-xs)] text-muted-foreground">
 {h.documentCount > 0
 ? t("list.row.medicalDocsAttached", { count: h.documentCount, name: h.workerName || t("list.row.fallbackEmployee") })
 : t("list.row.medicalDocAwaiting", { name: h.workerName || t("list.row.fallbackEmployee") })}
 </p>
 )}

 {/* Impact analysis (admin, pending only) */}
 {isAdmin && h.status === "pending" && (
 <ImpactPanel impact={impact} loading={impactLoading} />
 )}
 </div>
 );
}

// Unified leave-intelligence section - replaces the legacy BatchRecommendation.
// One fetch to /holidays/intelligence pulls compliance warnings, per-role advice
// + quiet periods, per-worker balances, and the solver-backed approve/deny
// recommendation for each pending request (with the worker's balance inline).
function LeaveIntelligenceSection() {
 const { t } = useTranslation("holidays");
 const [showAdvice, setShowAdvice] = useState(false);
 const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set());
 const [proposedKeys, setProposedKeys] = useState<Set<string>>(new Set());
 const [proposingKey, setProposingKey] = useState<string | null>(null);

 const intelligenceQuery = useQuery({
  queryKey: qk.holidays.intelligence(),
  queryFn: async () => (await api.getLeaveIntelligence()).data,
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
 });
 const data: LeaveIntelligence | null = intelligenceQuery.data ?? null;
 const loading = intelligenceQuery.isPending;

 if (loading) return (
  <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)] bg-foreground/[0.02]">
   <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("intelligence.loadingAnalysis")}</p>
  </div>
 );
 if (!data) return null;

 const hasCompliance = data.compliance.length > 0;
 const solverSuggestions = (data.advice.workerSuggestions || []).filter(s => s.source === "solver");
 const balancesWithRemaining = data.balances.filter(b => b.remainingDays > 0);
 const hasRoleDetails = data.advice.byRole.some((r) => {
  const roleSuggestions = solverSuggestions.some(s => s.role === r.role);
  const roleBalances = balancesWithRemaining.some(b => b.role === r.role);
  return r.priority !== "none" || roleSuggestions || roleBalances;
 });
 const hasAdvice = hasRoleDetails || solverSuggestions.length > 0;
 const sortedCompliance = [...data.compliance].sort((a, b) => b.remainingDays - a.remainingDays);
 const visibleCompliance = sortedCompliance.slice(0, 5);
 const hiddenComplianceCount = Math.max(0, sortedCompliance.length - visibleCompliance.length);
 const totalRemainingCp = Math.round(data.balances.reduce((s, b) => s + b.remainingDays, 0));
 const totalExpiringCp = Math.round(data.balances.reduce((s, b) => s + (b.expiringDays ?? 0), 0));

 if (!hasAdvice && !hasCompliance && data.balances.length === 0) return null;

 const priorityColor = (p: "high" | "medium" | "low" | "none") =>
  p === "high" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
  : p === "medium" ? "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-400"
  : "border-foreground/10 text-muted-foreground";

 return (
  <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)] bg-foreground/[0.02] space-y-[var(--space-sm)]">
   {hasAdvice ? (
    <button
     type="button"
     onClick={() => setShowAdvice(!showAdvice)}
     className="flex items-center justify-between gap-[var(--space-sm)] w-full text-left"
    >
     <div className="flex items-center gap-[var(--space-xs)] min-w-0">
      <CalendarDays className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-[length:var(--text-xs)] tracking-wide font-bold">{t("intelligence.title")}</span>
      <span className="text-[length:var(--text-xs)] text-muted-foreground truncate">{t("intelligence.subtitle")}</span>
     </div>
     <div className="flex items-center gap-[var(--space-xs)] shrink-0">
      {(() => {
        const urgentCount = solverSuggestions.length;
        const totalToPose = balancesWithRemaining.length;
        if (urgentCount > 0) return (
         <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-[var(--space-xs)] py-[1px] text-[length:var(--text-2xs)] font-bold tracking-wide text-emerald-700 dark:text-emerald-300 whitespace-nowrap">{t("intelligence.actionable", { count: urgentCount })}</span>
        );
        if (totalToPose > 0) return (
         <span className="inline-flex items-center rounded-full border border-foreground/15 bg-transparent px-[var(--space-xs)] py-[1px] text-[length:var(--text-2xs)] font-bold tracking-wide text-muted-foreground whitespace-nowrap">{t("intelligence.toSpread", { count: totalToPose })}</span>
        );
        return (
         <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-[var(--space-xs)] py-[1px] text-[length:var(--text-2xs)] font-bold tracking-wide text-emerald-700 dark:text-emerald-300 whitespace-nowrap">{t("intelligence.upToDate")}</span>
        );
      })()}
      <ChevronRight className={`size-3 text-muted-foreground transition-transform ${showAdvice ? "rotate-90" : ""}`} />
     </div>
    </button>
   ) : (
    <div className="flex items-center gap-[var(--space-xs)]">
     <CalendarDays className="size-3.5 text-muted-foreground" />
     <span className="text-[length:var(--text-xs)] tracking-wide font-bold">{t("intelligence.title")}</span>
    </div>
   )}

   {/* ── HCR-CONGES-PAYES-MINIMUM alerts ── */}
   {hasCompliance && (
   <div className="border border-amber-500/30 bg-amber-500/5 rounded-[0.2rem] p-[var(--space-sm)] space-y-[2px]">
     <div className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)] font-bold text-amber-700 dark:text-amber-400">
      <AlertTriangle className="size-3" />
      {t("intelligence.complianceTitle")}
     </div>
     <p className="text-[length:var(--text-xs)] text-amber-700 dark:text-amber-400">
      {t("intelligence.complianceSummary", { count: data.compliance.length, days: totalExpiringCp, actions: solverSuggestions.length })}
     </p>
     <div className="flex flex-wrap gap-x-[var(--space-sm)] gap-y-[2px] text-[length:var(--text-xs)] text-amber-700 dark:text-amber-400">
      {visibleCompliance.map(v => (
       <span key={v.workerId}>• {t("intelligence.complianceWorker", { name: v.workerName, days: v.remainingDays })}</span>
      ))}
      {hiddenComplianceCount > 0 && (
       <span>• {t("intelligence.complianceMore", { count: hiddenComplianceCount })}</span>
      )}
     </div>
     <p className="text-[length:var(--text-2xs)] text-muted-foreground pt-[2px]">
      <LeaveLegalFooter />
     </p>
    </div>
   )}
   {!hasCompliance && data.balances.some(b => b.remainingDays > 0) && (
    <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-[0.2rem] p-[var(--space-sm)] space-y-[2px]">
     <div className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)] font-bold text-emerald-700 dark:text-emerald-400">
      <CheckCircle className="size-3" />
      {t("intelligence.healthyTitle")}
     </div>
     <p className="text-[length:var(--text-xs)] text-emerald-700 dark:text-emerald-400">
      {t("intelligence.healthySummary", { count: data.balances.filter(b => b.remainingDays > 0).length, days: totalRemainingCp, expiring: totalExpiringCp, actions: solverSuggestions.length })}
     </p>
     <p className="text-[length:var(--text-2xs)] text-muted-foreground pt-[2px]">
      <LeaveLegalFooter />
     </p>
    </div>
   )}

   {/* ── Per-role advice + worker suggestions (collapsible) ── */}
   {hasRoleDetails && showAdvice && (
    <div className="border-t border-foreground/5 pt-[var(--space-xs)]">
    <div className="space-y-[var(--space-xs)]">
     {data.advice.byRole.filter(r => {
      const roleSuggestions = (data.advice.workerSuggestions || []).some(s => s.role === r.role && s.source === "solver");
      const roleBalancesPending = data.balances.some(b => b.role === r.role && b.remainingDays > 0);
      return r.priority !== "none" || roleSuggestions || roleBalancesPending;
     }).map(r => {
      const roleSuggestions = (data.advice.workerSuggestions || []).filter(s => s.role === r.role && s.source === "solver");
      const roleClosureSuggestions = (data.advice.workerSuggestions || []).filter(s => s.role === r.role && s.source === "closure");
      const closureGroups = [...roleClosureSuggestions.reduce((map, s) => {
       const key = `${s.weekStart}_${s.weekEnd}_${s.reason}`;
       const existing = map.get(key) ?? { weekStart: s.weekStart, weekEnd: s.weekEnd, reason: s.reason, days: s.suggestedDays, count: 0 };
       existing.count += 1;
       map.set(key, existing);
       return map;
      }, new Map<string, { weekStart: string; weekEnd: string; reason: string; days: number; count: number }>()).values()];
      const roleBalancesAll = data.balances.filter(b => b.role === r.role);
      const roleBalancesPending = roleBalancesAll.filter(b => b.remainingDays > 0);
      const roleRemaining = roleBalancesAll.reduce((s, b) => s + b.remainingDays, 0);
      const roleTaken = roleBalancesAll.reduce((s, b) => s + b.takenDays, 0);
      const roleEarned = roleBalancesAll.reduce((s, b) => s + b.earnedDays, 0);
      const roleExpiring = roleBalancesAll.reduce((s, b) => s + (b.expiringDays ?? 0), 0);
      const roleUrgentCount = roleBalancesAll.filter(b => b.expiringSoon).length;
      const rolePendingCount = roleBalancesPending.length;
      const isExpanded = expandedRoles.has(r.role);
      const toggleRole = () => setExpandedRoles(prev => {
       const next = new Set(prev);
       if (next.has(r.role)) next.delete(r.role); else next.add(r.role);
       return next;
      });
      const roleLabel = r.role === "kitchen" ? t("shared.kitchen") : t("shared.floor");
      return (
      <div key={r.role} className={`border rounded-[0.2rem] p-[var(--space-sm)] ${priorityColor(r.priority)}`}>
       <button type="button" onClick={toggleRole} className="w-full text-left">
        <div className="flex items-center justify-between gap-[var(--space-sm)]">
         <span className="text-[length:var(--text-xs)] font-bold tracking-wide">{roleLabel}</span>
         <div className="flex items-center gap-[var(--space-xs)] shrink-0 text-[length:var(--text-xs)] text-right">
         <span>{t("intelligence.role.daysToTake", { days: Math.round(roleRemaining) })}</span>
          <span className={roleExpiring > 0 ? "text-amber-700 dark:text-amber-400 font-bold" : "text-muted-foreground"}>
           {t("intelligence.role.expiringTotal", { days: Math.round(roleExpiring) })}
          </span>
          {rolePendingCount > 0 && (
           <span className="text-muted-foreground">{t("intelligence.role.employees", { count: rolePendingCount })}</span>
          )}
          {roleUrgentCount > 0 && (
           <span className="text-amber-700 dark:text-amber-400 font-bold">{t("intelligence.role.urgent", { count: roleUrgentCount })}</span>
          )}
         <ChevronRight className={`size-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
         </div>
        </div>
       </button>
       {closureGroups.length > 0 && (
        <div className="mt-[var(--space-xs)] space-y-[2px] text-[length:var(--text-xs)] text-muted-foreground">
         {closureGroups.map(g => (
          <p key={`${g.weekStart}_${g.reason}`}>
           {t("intelligence.suggestion.closureGroup", { count: g.count, start: fmtDateShort(g.weekStart), end: fmtDateShort(g.weekEnd), days: g.days, reason: g.reason })}
          </p>
         ))}
        </div>
       )}
       {roleSuggestions.length > 0 && (
        <div className="mt-[var(--space-xs)] space-y-[2px]">
         {roleSuggestions.map((s, i) => {
          const key = `${s.workerId}_${s.weekStart}`;
          const alreadyActed = proposedKeys.has(key);
          const isActing = proposingKey === key || proposingKey === `${key}_impose`;
          const handleAction = async (impose: boolean) => {
           const k = impose ? `${key}_impose` : key;
           setProposingKey(k);
           try {
            await api.proposeHoliday({
             workerId: s.workerId,
             startDate: s.weekStart,
             endDate: s.weekEnd,
             reason: t("shared.spreadReason"),
             impose,
            });
            setProposedKeys(prev => new Set(prev).add(key));
            toast.success(impose
             ? t("shared.imposedToast", { name: s.workerName })
             : t("shared.proposedToast", { name: s.workerName }));
           } catch {
            toast.error(t("shared.sendFailed"));
           } finally {
            setProposingKey(null);
           }
          };
          return (
          <div key={i} className="text-[length:var(--text-xs)] flex items-start gap-[var(--space-xs)]">
           <span className={s.expiringSoon ? "text-amber-700 dark:text-amber-400 font-bold" : "text-foreground/70"}>
            →
           </span>
           <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-[var(--space-sm)]">
             <div className="min-w-0">
              <span className="font-bold">{s.workerName}</span>
              <span className="text-muted-foreground"> · {s.reason}</span>
             </div>
             {alreadyActed ? (
               <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground shrink-0">{t("intelligence.suggestion.sent")}</span>
              ) : (
               <div className="flex gap-[4px] shrink-0">
                <button
                 type="button"
                 onClick={() => handleAction(false)}
                 disabled={isActing}
                 className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[1px] rounded-full border border-foreground/30 text-foreground hover:bg-foreground hover:text-background transition-colors"
                >
                 {proposingKey === key ? "..." : t("shared.propose")}
                </button>
                <button
                 type="button"
                 onClick={() => {
                  if (!confirm(t("shared.imposeConfirmRange", { name: s.workerName, start: fmtDateShort(s.weekStart), end: fmtDateShort(s.weekEnd) }))) return;
                  handleAction(true);
                 }}
                 disabled={isActing}
                 className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[1px] rounded-full border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
                >
                 {proposingKey === `${key}_impose` ? "..." : t("shared.impose")}
                </button>
               </div>
              )}
            </div>
            <div className="text-muted-foreground">
             {t("intelligence.suggestion.weekSolver", { start: fmtDateShort(s.weekStart), end: fmtDateShort(s.weekEnd), days: s.suggestedDays })}
            </div>
           </div>
          </div>
          );
         })}
        </div>
       )}
       {roleSuggestions.length === 0 && roleBalancesPending.length > 0 && (
        <div className="mt-[var(--space-xs)] text-[length:var(--text-xs)]">
         <p className="text-muted-foreground">
          {t("intelligence.role.toSpreadIntro", { list: roleBalancesPending.map(b => `${b.workerName} (${b.remainingDays}j)`).join(", ") })}
         </p>
         <p className="text-muted-foreground mt-[2px]">
          {t("intelligence.role.noUrgencyHint")}
         </p>
        </div>
       )}
       {roleSuggestions.length === 0 && roleBalancesPending.length === 0 && (
        <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[2px]">{t("intelligence.role.noBacklog")}</p>
       )}
       {isExpanded && roleBalancesAll.length > 0 && (
        <div className="mt-[var(--space-xs)] pt-[var(--space-xs)] border-t border-foreground/10 space-y-[1px] text-[length:var(--text-xs)]">
        {roleBalancesAll.map(b => (
          <div key={b.workerId} className={`flex items-start justify-between gap-[var(--space-sm)] py-[2px] ${b.expiringSoon ? "text-amber-700 dark:text-amber-400" : ""}`}>
           <span>{b.workerName}</span>
           <span className="text-right text-muted-foreground">
            <span className="block">
             {t("intelligence.role.balanceLine", { days: b.remainingDays, taken: b.takenDays, earned: b.earnedDays })}
            </span>
            <span className={b.expiringSoon ? "block text-amber-700 dark:text-amber-400 font-bold" : "block text-muted-foreground/80"}>
             {t("intelligence.role.expiringLine", { days: b.expiringDays ?? 0 })}
            </span>
           </span>
          </div>
         ))}
         <div className="flex items-center justify-between py-[2px] mt-[2px] border-t border-foreground/10 font-bold">
          <span>{t("intelligence.role.totalLine", { role: roleLabel.toLowerCase() })}</span>
          <span>
           {t("intelligence.role.totalValue", { remaining: Math.round(roleRemaining), taken: Math.round(roleTaken), earned: Math.round(roleEarned) })}
           <span className="block text-right text-[length:var(--text-2xs)] text-muted-foreground font-normal">
            {t("intelligence.role.expiringLine", { days: Math.round(roleExpiring) })}
           </span>
          </span>
         </div>
        </div>
       )}
      </div>
     );})}
    </div>
    </div>
   )}

  </div>
 );
}

function LeaveLegalFooter() {
 return (
  <Trans
   ns="holidays"
   i18nKey="intelligence.complianceFooter"
   components={{
    codeLink: (
     <a
      href={LEGAL_LINKS.paidLeaveDuration.url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
     />
    ),
    hcrLink: (
     <a
      href={LEGAL_LINKS.hcrPaidLeaveIndemnity.url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
     />
    ),
   }}
  />
 );
}

function HowItWorksTopBar() {
 const [open, setOpen] = useState(false);
 return (
  <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)] bg-foreground/[0.02]">
   <ImpactHowItWorks open={open} setOpen={setOpen} />
  </div>
 );
}

function ImpactHowItWorks({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
 const { t } = useTranslation("holidays");
 return (
 <div className="text-[length:var(--text-xs)] text-muted-foreground">
 <button
 type="button"
 onClick={() => setOpen(!open)}
 className="flex items-center gap-[var(--space-xs)] hover:text-foreground transition-colors"
 >
 <HelpCircle className="size-3 shrink-0" />
 <span className="underline underline-offset-2">{t("howItWorks.trigger")}</span>
 </button>
 {open && (
 <div className="mt-[var(--space-sm)] ml-[18px] space-y-[var(--space-md)] leading-relaxed">
 {/* Metrics */}
 <div>
  <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("howItWorks.indicators.title")}</p>
  <ol className="list-decimal ml-[16px] space-y-[3px]">
   <li><Trans i18nKey="howItWorks.indicators.services" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.indicators.hours" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.indicators.absorption" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.indicators.subRole" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.indicators.overlapping" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.indicators.structural" ns="holidays" components={{ strong: <strong /> }} /></li>
  </ol>
 </div>
 {/* Engine */}
 <div>
  <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("howItWorks.engine.title")}</p>
  <p className="mb-[var(--space-xs)]">
   <Trans
    i18nKey="howItWorks.engine.intro"
    ns="holidays"
    components={{
     strong: <strong />,
     link: <a href="https://developers.google.com/optimization/cp/cp_solver" target="_blank" rel="noopener noreferrer" className="underline text-foreground hover:text-foreground/80" />,
    }}
   />
  </p>
  <ol className="list-decimal ml-[16px] space-y-[3px]">
   <li><Trans i18nKey="howItWorks.engine.step1" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.engine.step2" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.engine.step3" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.engine.step4" ns="holidays" components={{ strong: <strong /> }} /></li>
  </ol>
 </div>
 {/* Batch */}
 <div>
  <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("howItWorks.batch.title")}</p>
  <ol className="list-decimal ml-[16px] space-y-[3px]">
   <li>{t("howItWorks.batch.step1")}</li>
   <li>{t("howItWorks.batch.step2")}</li>
   <li>{t("howItWorks.batch.step3")}</li>
   <li>{t("howItWorks.batch.step4")}</li>
  </ol>
 </div>
 {/* Priorities */}
 <div>
  <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("howItWorks.priorities.title")}</p>
  <p className="mb-[var(--space-xs)]">{t("howItWorks.priorities.intro")}</p>
  <ol className="list-decimal ml-[16px] space-y-[3px]">
   <li><Trans i18nKey="howItWorks.priorities.p1" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.priorities.p2" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.priorities.p3" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.priorities.p4" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.priorities.p5" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.priorities.p6" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.priorities.p7" ns="holidays" components={{ strong: <strong /> }} /></li>
   <li><Trans i18nKey="howItWorks.priorities.p8" ns="holidays" components={{ strong: <strong /> }} /></li>
  </ol>
 </div>
 <p className="text-[length:var(--text-2xs)]">
  <Trans
   i18nKey="howItWorks.engineFooter"
   ns="holidays"
   components={{
    link1: <a href="https://developers.google.com/optimization/cp/cp_solver" target="_blank" rel="noopener noreferrer" className="underline" />,
    link2: <a href="https://github.com/google/or-tools" target="_blank" rel="noopener noreferrer" className="underline" />,
   }}
  />
 </p>
 </div>
 )}
 </div>
 );
}

function ImpactPanel({ impact, loading }: { impact: HolidayImpact | null; loading: boolean }) {
 const { t } = useTranslation("holidays");
 if (loading) return (
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("impact.loading")}</p>
 );
 if (!impact) return null;

 const { totalServicesAffected, daysWithImpact, daysBelowTarget, overlappingHolidays, structuralImpact, hoursImpact } = impact;
 const roleName = impact.workerRole === "kitchen" ? t("shared.kitchenLower") : t("shared.floorLower");

 const hasStructuralRisk = structuralImpact && (structuralImpact.slotsBecameUnfillable > 0 || structuralImpact.isBottleneck);
 const hasHoursRisk = hoursImpact && !hoursImpact.canAbsorbWithoutOT;
 const noImpact = totalServicesAffected === 0 && overlappingHolidays.length === 0 && !hasStructuralRisk && !hasHoursRisk;

 if (noImpact) {
 return (
 <div className="space-y-[var(--space-xs)] text-[length:var(--text-xs)]">
 <div className="flex items-center gap-[var(--space-xs)]">
 <span className="text-green-600 dark:text-green-400 font-bold">✓</span>
 <span className="text-muted-foreground">{t("impact.noImpact")}</span>
 </div>
 </div>
 );
 }

 return (
 <div className="space-y-[var(--space-sm)] border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)] bg-foreground/[0.02]">
 {/* Absence summary + hours + shifts */}
 {hoursImpact && (
 <div className="space-y-[var(--space-xs)]">
 <div className="text-[length:var(--text-xs)] text-muted-foreground">
 <Trans
  i18nKey="impact.absenceDays"
  ns="holidays"
  count={hoursImpact.holidayDays}
  components={{ strong: <strong className="text-foreground" /> }}
 />
 {" · "}
 <Trans
  i18nKey="impact.redistributeHours"
  ns="holidays"
  values={{ hours: hoursImpact.lostHours }}
  components={{ strong: <strong className="text-foreground" /> }}
 />
 {" · "}
 <Trans
  i18nKey="impact.slotsToCover"
  ns="holidays"
  count={totalServicesAffected}
  components={{ strong: <strong className="text-foreground" /> }}
 />
 {daysBelowTarget > 0 && (
 <span className="text-amber-600 dark:text-amber-400 font-bold">
 {" · "}{t("impact.daysBelowTarget", { count: daysBelowTarget })}
 </span>
 )}
 </div>
 {daysBelowTarget > 0 && daysWithImpact.length > 0 && (
 <div className="flex flex-wrap gap-[3px]">
 {daysWithImpact.filter(d => d.belowTarget).map((d) => (
 <span
 key={d.date}
 className="text-[length:var(--text-xs)] font-bold tracking-wide px-[var(--space-xs)] py-[1px] rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
 title={t("impact.dayBelowTitle", { date: fmtDateShort(d.date), after: d.sameRoleWithout, target: d.targetCount, role: roleName })}
 >
 {fmtDateShort(d.date)} <span className="font-mono">{d.sameRoleWithout}/{d.targetCount}</span>
 </span>
 ))}
 </div>
 )}
 <div className="flex items-center gap-[var(--space-sm)] text-[length:var(--text-xs)]">
 {hoursImpact.canAbsorbWithoutOT ? (
 <>
 <span className="text-emerald-600 dark:text-emerald-400 font-bold">✓</span>
 <span className="text-muted-foreground">
  {totalServicesAffected > 0 ? (
   <Trans
    i18nKey="impact.absorbWithSlots"
    ns="holidays"
    count={totalServicesAffected}
    values={{ role: roleName, slack: hoursImpact.remainingTeamSlack }}
    components={{ strong: <strong className="text-foreground" /> }}
   />
  ) : (
   t("impact.absorbNoSlots", { role: roleName, slack: hoursImpact.remainingTeamSlack })
  )}
 </span>
 </>
 ) : (
 <>
 <span className={hoursImpact.canCoverWithOvertime ? "text-amber-600 dark:text-amber-400 font-bold" : "text-red-600 dark:text-red-400 font-bold"}>
  {hoursImpact.canCoverWithOvertime ? "✓" : "✗"}
 </span>
 <span className={hoursImpact.canCoverWithOvertime ? "text-amber-600 dark:text-amber-400 font-bold" : "text-red-600 dark:text-red-400 font-bold"}>
  {hoursImpact.canCoverWithOvertime
   ? t("impact.needOvertimeCovered", {
    slack: hoursImpact.remainingTeamSlack,
    hours: hoursImpact.lostHours,
    overtime: hoursImpact.overtimeHoursNeeded ?? Math.max(0, hoursImpact.lostHours - hoursImpact.remainingTeamSlack),
   })
   : t("impact.needOvertime", { slack: hoursImpact.remainingTeamSlack, hours: hoursImpact.lostHours })}
 </span>
 </>
 )}
 </div>
 {hoursImpact.subRoleCoverage && hoursImpact.subRoleCoverage.length > 0 && (
 <div className="flex flex-wrap items-center gap-[3px]">
 {hoursImpact.subRoleCoverage.map(sr => (
 <span
 key={sr.subRole}
 className={`text-[length:var(--text-xs)] font-bold tracking-wide px-[var(--space-xs)] py-[1px] rounded-full border ${
 sr.coveredBy === 0
 ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
 : "border-foreground/10 bg-foreground/[0.03] text-muted-foreground"
 }`}
 >
 {sr.coveredBy === 0
  ? t("impact.subRoleNone", { subRole: sr.subRole })
  : t("impact.subRoleCovered", { subRole: sr.subRole, count: sr.coveredBy })}
 </span>
 ))}
 </div>
 )}
 </div>
 )}

 {/* Overlapping holidays */}
 {overlappingHolidays.length > 0 && (
 <div className="border-t border-foreground/5 pt-[var(--space-xs)]">
 <div className="text-[length:var(--text-xs)] text-muted-foreground flex items-start gap-[3px]">
 <span>{t("impact.overlappingLabel")}
 {overlappingHolidays.map((o, i) => (
 <span key={i}>
 {i > 0 && ", "}
 <span className="font-bold text-foreground">{o.workerName}</span>
 {" "}({fmtDateShort(o.startDate)}→{fmtDateShort(o.endDate)}
 {o.status === "pending" && t("impact.overlappingPending")})
 </span>
 ))}
 </span>
 </div>
 </div>
 )}

 {/* Solver-backed structural analysis */}
 {structuralImpact && (
 <div className="space-y-[var(--space-xs)] border-t border-foreground/5 pt-[var(--space-xs)]">
 {(structuralImpact.workersAlreadyOut > 0 || structuralImpact.isBottleneck || structuralImpact.workerDemandShare > 0 || !structuralImpact.solverBacked) && (
 <div className="text-[length:var(--text-xs)] text-muted-foreground flex items-start gap-[3px]">
 <span>
 {!structuralImpact.solverBacked && <span className="text-muted-foreground/70">{t("impact.structuralUnavailable")}</span>}
 {structuralImpact.workersAlreadyOut > 0 && (
 <span>{t("impact.alreadyOut", { count: structuralImpact.workersAlreadyOut })}</span>
 )}
 {structuralImpact.isBottleneck && (
 <span className="text-amber-600 dark:text-amber-400 font-bold">{t("impact.bottleneck")}</span>
 )}
 {structuralImpact.workerDemandShare > 0 && (
 <span>{t("impact.demandShare", { pct: Math.round(structuralImpact.workerDemandShare * 100), role: roleName })}</span>
 )}
 </span>
 </div>
 )}

 {/* Slots that became unfillable */}
 {structuralImpact.slotsBecameUnfillable > 0 && (
 <div className="space-y-[2px]">
 <div className="text-[length:var(--text-xs)] text-red-600 dark:text-red-400 font-bold">
 {t("impact.unfillableSlots", { count: structuralImpact.slotsBecameUnfillable })}
 </div>
 <div className="flex flex-wrap gap-[3px]">
 {structuralImpact.slotsAffected.filter(s => s.becameUnfillable).map((s, i) => (
 <span
 key={i}
 className="text-[length:var(--text-xs)] font-bold tracking-wide px-[var(--space-xs)] py-[1px] rounded-full border border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
 >
 {JOURS_COURTS[s.dayOfWeek % 7]} {s.zone} <span className="font-mono">{s.withoutFilled}/{s.target}</span>
 </span>
 ))}
 </div>
 </div>
 )}

 {/* Reduced but still fillable slots */}
 {structuralImpact.slotsAffected.filter(s => !s.becameUnfillable).length > 0 && (
 <div className="flex flex-wrap gap-[3px]">
 {structuralImpact.slotsAffected.filter(s => !s.becameUnfillable).map((s, i) => (
 <span
 key={i}
 className="text-[length:var(--text-xs)] font-bold tracking-wide px-[var(--space-xs)] py-[1px] rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
 title={`${s.baselineFilled}→${s.withoutFilled} / ${s.target}`}
 >
 {JOURS_COURTS[s.dayOfWeek % 7]} {s.zone} <span className="font-mono">{s.withoutFilled}/{s.target}</span>
 </span>
 ))}
 </div>
 )}
 </div>
 )}
 </div>
 );
}

function ReplacementDocUpload({ replacementId }: { replacementId: string }) {
 const { t } = useTranslation("holidays");
 const [busy, setBusy] = useState(false);
 const [done, setDone] = useState(false);

 const handleFiles = async (fileList: FileList | null) => {
 if (!fileList || fileList.length === 0) return;
 setBusy(true);
 try {
 const docs = await Promise.all(
 Array.from(fileList).map(async (f) => {
 const upload = await uploadReplacementDocumentFile(f);
 return {
 name: f.name,
 filename: upload.filename,
 mimeType: upload.mimeType,
 size: upload.size,
 storageKey: upload.storageKey,
 };
 }),
 );
 await api.attachReplacementDocuments(replacementId, docs);
 setDone(true);
 setTimeout(() => window.location.reload(), 600);
 } catch {
 setBusy(false);
 }
 };

 if (done) return <span className="text-[length:var(--text-xs)] text-emerald-600">{t("list.replacement.uploadIttSent")}</span>;
 return (
 <label className="text-[length:var(--text-xs)] font-bold tracking-wide px-[var(--space-sm)] py-[1px] rounded-full border border-foreground/20 hover:bg-foreground hover:text-background transition-colors cursor-pointer">
 {busy ? "..." : t("list.replacement.uploadItt")}
 <input
 type="file"
 multiple
 accept="image/*,application/pdf"
 className="hidden"
 onChange={(e) => handleFiles(e.target.files)}
 />
 </label>
 );
}

function ReplacementRow({ replacement, userId, restaurantTimezone, isAdmin, getUserName, onRespond, onReview }: {
 replacement: ReplacementRequest;
 userId: string | undefined;
 restaurantTimezone: string | undefined;
 isAdmin: boolean;
 getUserName: (id: string) => string;
 onRespond: (id: string, response: "accepted" | "rejected") => void;
 onReview: (id: string, decision: "pick" | "broadcast" | "refuse" | "approve_absence", candidateId?: string) => void;
}) {
 const { t } = useTranslation("holidays");
 const isRequester = replacement.requesterId === userId;
 const isPickedTarget = replacement.targetId === userId;
 const candidateIds = replacement.candidateIds ?? [];
 const rejected = replacement.rejectedCandidateIds ?? [];
 const remainingCandidateIds = candidateIds.filter((id) => !rejected.includes(id));
 const isBroadcastCandidate =
 replacement.targetId === null &&
 replacement.status === "awaiting_worker_reply" &&
 remainingCandidateIds.includes(userId ?? "");
 const sentCandidateNames = replacement.status === "awaiting_worker_reply"
 ? (replacement.targetId ? [getUserName(replacement.targetId)] : remainingCandidateIds.map(getUserName))
 : [];
 const sentAgo = formatRelativeTime(replacement.workerNotifiedAt, i18n.language);
 const createdAgo = formatRelativeTime(replacement.createdAt, i18n.language);

 // Header
 const headerLabel =
 replacement.status === "awaiting_admin_decision"
 ? <span className="font-bold">{getUserName(replacement.requesterId)}</span>
 : replacement.targetId
 ? <><span className="font-bold">{getUserName(replacement.requesterId)}</span><ArrowRight className="size-3 text-muted-foreground inline mx-1" /><span className="font-bold">{getUserName(replacement.targetId)}</span></>
 : <><span className="font-bold">{getUserName(replacement.requesterId)}</span><ArrowRight className="size-3 text-muted-foreground inline mx-1" /><span className="text-muted-foreground italic">{t("list.replacement.candidates", { count: remainingCandidateIds.length })}</span></>;

 const statusText = t(`list.replacementStatus.${replacement.status}`, { defaultValue: replacement.status });

 return (
 <div className="border-b border-border/60 py-[var(--space-sm)] last:border-b-0">
 <div className="flex items-start justify-between gap-[var(--space-md)]">
 <div className="space-y-[var(--space-sm)] flex-1">
 <div className="flex items-center gap-[var(--space-md)] flex-wrap">
 <p className="text-[length:var(--text-sm)]">{headerLabel}</p>
 <span className={`text-[length:var(--text-xs)] font-medium text-muted-foreground border-l-2 pl-[var(--space-sm)] ${statusBorder[replacement.status] ?? "border-border"}`}>
 {statusText}
 </span>
 </div>
 {replacement.message && (
 <p className="text-[length:var(--text-sm)] text-muted-foreground italic">
 &ldquo;{replacement.message}&rdquo;
 </p>
 )}

 {/* Medical / ITT signal */}
 {replacement.medical && (
 <div className="flex items-center gap-[var(--space-sm)] flex-wrap">
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide px-[var(--space-sm)] py-[1px] rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
 {t("list.replacement.medicalBadge")}
 </span>
 {(replacement.documentCount ?? 0) === 0 ? (
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide px-[var(--space-sm)] py-[1px] rounded-full border border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300">
 {t("list.replacement.ittMissing")}
 </span>
 ) : (
 <span className="text-[length:var(--text-xs)] text-muted-foreground">
 {t("list.replacement.ittAttached", { count: replacement.documentCount })}
 </span>
 )}
 {isRequester && (replacement.documentCount ?? 0) === 0 && (
 <ReplacementDocUpload replacementId={replacement.id} />
 )}
 </div>
 )}

 {/* Admin sees candidate actions while in awaiting_admin_decision */}
 {isAdmin && replacement.status === "awaiting_admin_decision" && (
 <div className="space-y-[var(--space-xs)] pt-[var(--space-xs)]">
 {remainingCandidateIds.length > 0 ? (
 <>
 <div className="space-y-[2px]">
 <p className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">
 {t("list.replacement.potentialCandidates")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground">
 {t(remainingCandidateIds.length > 1 ? "list.replacement.candidateHint" : "list.replacement.candidateHintSingle")}
 </p>
 </div>
 <div className="flex flex-wrap gap-[var(--space-xs)]">
 {remainingCandidateIds.map((cid) => {
 const score = replacement.candidateScores?.[cid];
 return (
 <button
 key={cid}
 onClick={() => onReview(replacement.id, "pick", cid)}
 className="group/button inline-flex items-center gap-[var(--space-xs)] rounded-full border border-foreground/20 bg-background px-[var(--space-sm)] py-[2px] text-[length:var(--text-xs)] font-bold tracking-wide hover:bg-foreground hover:text-background transition-colors"
 title={t("list.replacement.proposeToCandidate")}
 >
 <span>{getUserName(cid)}</span>
 {typeof score === "number" && (
 <span className="font-medium text-muted-foreground group-hover/button:text-background/70">
 {t("list.replacement.candidateScore", { score: Math.round(score) })}
 </span>
 )}
 </button>
 );
 })}
 {remainingCandidateIds.length > 1 && (
 <button
 onClick={() => onReview(replacement.id, "broadcast")}
 className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-[var(--space-sm)] py-[2px] text-[length:var(--text-xs)] font-bold tracking-wide text-emerald-700 hover:bg-emerald-600 hover:text-white dark:text-emerald-300 transition-colors"
 >
 {t("list.replacement.broadcastButton")}
 </button>
 )}
 <button
 onClick={() => onReview(replacement.id, "refuse")}
 className="rounded-full border border-red-500/35 bg-red-500/10 px-[var(--space-sm)] py-[2px] text-[length:var(--text-xs)] font-bold tracking-wide text-red-700 hover:bg-red-600 hover:text-white dark:text-red-300 transition-colors"
 >
 {t("list.replacement.cancelButton")}
 </button>
 <button
 onClick={() => onReview(replacement.id, "approve_absence")}
 className="rounded-full border border-sky-500/35 bg-sky-500/10 px-[var(--space-sm)] py-[2px] text-[length:var(--text-xs)] font-bold tracking-wide text-sky-700 hover:bg-sky-600 hover:text-white dark:text-sky-300 transition-colors"
 >
 {t("list.replacement.approveWithoutReplacementButton")}
 </button>
 </div>
 </>
 ) : (
 <div className="flex flex-wrap gap-[var(--space-xs)]">
 <p className="basis-full text-[length:var(--text-xs)] text-amber-700 dark:text-amber-300">
 {t("list.replacement.noCandidate")}
 </p>
 <button
 onClick={() => onReview(replacement.id, "refuse")}
 className="rounded-full border border-red-500/35 bg-red-500/10 px-[var(--space-sm)] py-[2px] text-[length:var(--text-xs)] font-bold tracking-wide text-red-700 hover:bg-red-600 hover:text-white dark:text-red-300 transition-colors"
 >
 {t("list.replacement.cancelButton")}
 </button>
 <button
 onClick={() => onReview(replacement.id, "approve_absence")}
 className="rounded-full border border-sky-500/35 bg-sky-500/10 px-[var(--space-sm)] py-[2px] text-[length:var(--text-xs)] font-bold tracking-wide text-sky-700 hover:bg-sky-600 hover:text-white dark:text-sky-300 transition-colors"
 >
 {t("list.replacement.approveWithoutReplacementButton")}
 </button>
 </div>
 )}
 </div>
 )}

 <div className="space-y-[2px]">
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
 {t("list.replacement.createdAgo", { time: createdAgo ?? formatInstantInTimeZone(replacement.createdAt, i18n.language, restaurantTimezone) })}
 </p>
 {replacement.status === "awaiting_worker_reply" && sentCandidateNames.length > 0 && (
 <p className="pl-[var(--space-md)] text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
 <span>{t("list.replacement.sentToInline", { names: sentCandidateNames.join(", "), time: sentAgo ?? "" })}</span>
 <ArrowRight className="mx-1 inline size-3 text-muted-foreground" />
 <span>{t("list.replacement.deadlineInline", { date: formatInstantInTimeZone(replacement.expiresAt, i18n.language, restaurantTimezone) })}</span>
 </p>
 )}
 </div>
 {isRequester && (replacement.status === "awaiting_admin_decision" || replacement.status === "awaiting_worker_reply") && (
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
 {replacement.status === "awaiting_admin_decision" ? t("list.replacement.awaitingAdminDecision") : t("list.replacement.managerProposed")}
 </p>
 )}
 </div>

 {/* Action column */}
 <div className="flex flex-col items-end gap-[var(--space-sm)] shrink-0">
 {/* Worker (target or broadcast candidate): accept/reject */}
 {(isPickedTarget || isBroadcastCandidate) && replacement.status === "awaiting_worker_reply" && (
 <div className="flex gap-[var(--space-sm)]">
 <Button size="sm"
 className="tracking-wide text-[length:var(--text-xs)] font-bold"
 onClick={() => onRespond(replacement.id, "accepted")}>
 {t("list.replacement.acceptButton")}
 </Button>
 <Button size="sm" variant="outline"
 className="tracking-wide text-[length:var(--text-xs)] font-bold hover:!bg-foreground hover:!text-background hover:!border-foreground"
 onClick={() => onRespond(replacement.id, "rejected")}>
 {t("shared.reject")}
 </Button>
 </div>
 )}
 </div>
 </div>
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
 const { t } = useTranslation("holidays");
 const [open, setOpen] = useState(false);
 const ref = useRef<HTMLDivElement>(null);

 // Close on outside click
 useEffect(() => {
 if (!open) return;
 const handler = (e: MouseEvent) => {
 if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
 };
 document.addEventListener("mousedown", handler);
 return () => document.removeEventListener("mousedown", handler);
 }, [open]);

 // Visual range for the calendar
 const selected: DateRange | undefined = start
 ? { from: parseDate(start), to: end ? parseDate(end) : undefined }
 : undefined;

 // Manual click handler - avoids rdp's quirky range-modify behavior
 const handleDayClick = (day: Date) => {
 const dateStr = toISO(day);

 if (!start || (start && end)) {
 // No selection yet, or complete range → start fresh
 onStartChange(dateStr);
 onEndChange("");
 } else {
 // Have start, picking end
 if (dateStr < start) {
 onEndChange(start);
 onStartChange(dateStr);
 } else if (dateStr === start) {
 // Same day = single-day range
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
 : t("list.form.datesPlaceholder");

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

/** File drop zone - drag & drop or click to select, with preview list */
function FileDropZone({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
 const { t } = useTranslation("holidays");
 const inputRef = useRef<HTMLInputElement>(null);
 const [dragOver, setDragOver] = useState(false);

 const addFiles = (incoming: FileList | null) => {
 if (!incoming) return;
 const next = [...files];
 for (let i = 0; i < incoming.length; i++) {
 const f = incoming[i];
 // Accept images and PDFs, max 5MB each
 if (f.size > 5 * 1024 * 1024) continue;
 if (!f.type.startsWith("image/") && f.type !== "application/pdf") continue;
 // Skip duplicates by name+size
 if (next.some((e) => e.name === f.name && e.size === f.size)) continue;
 next.push(f);
 }
 onChange(next);
 };

 const removeFile = (idx: number) => onChange(files.filter((_, i) => i !== idx));

 const formatSize = (bytes: number) => bytes < 1024 ? `${bytes}B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)}KB` : `${(bytes / 1048576).toFixed(1)}MB`;

 return (
 <div className="space-y-[var(--space-xs)]">
 <div
 onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
 onDragLeave={() => setDragOver(false)}
 onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
 onClick={() => inputRef.current?.click()}
 className={`flex items-center justify-center h-16 border-2 border-dashed rounded-[0.2rem] cursor-pointer transition-colors ${
 dragOver
 ? "border-foreground bg-foreground/5"
 : "border-foreground/20 hover:border-foreground/40"
 }`}
 >
 <p className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground select-none">
 {dragOver ? t("list.form.dropHere") : t("list.form.dropHint")}
 </p>
 <input
 ref={inputRef}
 type="file"
 multiple
 accept="image/*,application/pdf"
 className="hidden"
 onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
 />
 </div>
 {/* File list */}
 {files.length > 0 && (
 <div className="flex flex-wrap gap-[var(--space-xs)]">
 {files.map((f, i) => (
 <div key={`${f.name}-${i}`} className="flex items-center gap-[var(--space-xs)] border border-foreground/15 rounded-full px-[var(--space-xs)] py-[1px]">
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold truncate max-w-[120px]">{f.name}</span>
 <span className="text-[length:var(--text-xs)] text-muted-foreground">{formatSize(f.size)}</span>
 <button type="button" onClick={(e) => { e.stopPropagation(); removeFile(i); }}
 className="text-muted-foreground hover:text-foreground ml-1"><X className="size-3" /></button>
 </div>
 ))}
 </div>
 )}
 </div>
 );
}
