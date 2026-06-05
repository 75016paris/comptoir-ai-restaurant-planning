import { useState, useEffect, useCallback } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, type StaffingAnalysis, type RoleSummary, type CapacitySummary, type ExpansionInsight, type LongHorizonStaffingSummary } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";
import { JOURS_COURTS } from "@/lib/date-utils";
import { ChevronRight, HelpCircle, FlaskConical, BarChart3, Cpu, Plus, Loader2, CalendarDays, RefreshCw } from "lucide-react";

function NumBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center justify-center size-[14px] text-[9px] font-bold rounded-full bg-foreground/10 text-foreground/70 leading-none">{n}</span>
  );
}

type VerdictKey = "oversized" | "undersized" | "tight" | "balanced";
const verdictConfig: Record<VerdictKey, { color: string; bg: string; border: string; barColor: string }> = {
  oversized: {
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-500/15",
    border: "border-blue-500/30 bg-blue-500/5",
    barColor: "bg-blue-500",
  },
  undersized: {
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-500/15",
    border: "border-red-500/30 bg-red-500/5",
    barColor: "bg-red-500",
  },
  tight: {
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/15",
    border: "border-amber-500/30 bg-amber-500/5",
    barColor: "bg-amber-500",
  },
  balanced: {
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/30 bg-emerald-500/5",
    barColor: "bg-emerald-500",
  },
};

function HoursBar({ cap, showHelp }: { cap: CapacitySummary; showHelp?: boolean }) {
  const { t } = useTranslation("staff");
  const demandH = cap.totalDemandHours ?? 0;
  const contractH = cap.totalContractHours ?? 0;
  if (demandH === 0 && contractH === 0) return null;

  const v = verdictConfig[cap.verdict ?? "balanced"];
  const maxH = Math.max(demandH, contractH);
  const demandPct = maxH > 0 ? (demandH / maxH) * 100 : 0;
  const contractPct = maxH > 0 ? (contractH / maxH) * 100 : 0;

  return (
    <div className="space-y-[4px]">
      <div className="space-y-[2px]">
        <div className="flex items-center justify-between">
          <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground flex items-center gap-[3px]">
            {showHelp && <NumBadge n={1} />}{t("analysis.demand")}
          </span>
          <span className="text-[length:var(--text-xs)] font-bold tabular-nums">
            {Math.round(demandH)}h<span className="text-muted-foreground font-normal">{t("analysis.perWeekUnit")}</span>
          </span>
        </div>
        <div className="h-[4px] rounded-full bg-foreground/10 overflow-hidden">
          <div className="h-full rounded-full bg-foreground/30 transition-all" style={{ width: `${demandPct}%` }} />
        </div>
      </div>
      <div className="space-y-[2px]">
        <div className="flex items-center justify-between">
          <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground flex items-center gap-[3px]">
            {showHelp && <NumBadge n={2} />}{t("analysis.contract")}
          </span>
          <span className="text-[length:var(--text-xs)] font-bold tabular-nums">
            {contractH}h<span className="text-muted-foreground font-normal">{t("analysis.perWeekUnit")}</span>
          </span>
        </div>
        <div className="h-[4px] rounded-full bg-foreground/10 overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", v.barColor)} style={{ width: `${contractPct}%` }} />
        </div>
      </div>
    </div>
  );
}

function RoleCard({ summary, cap, showHelp }: { summary: RoleSummary; cap?: CapacitySummary; showHelp?: boolean }) {
  const { t } = useTranslation(["staff", "roles"]);
  const roleLabel = (t(`roles:${summary.role}`) as string).toUpperCase();
  const verdict = cap?.verdict ?? "balanced";
  const v = verdictConfig[verdict];
  const surplusH = cap?.surplusHours ?? 0;
  const surplusW = cap?.surplusWorkers ?? 0;
  const surplusWAbs = Math.round(Math.abs(surplusW));

  return (
    <div className={cn("border rounded-[0.2rem] p-[var(--space-md)] space-y-[var(--space-sm)]", v.border)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--space-sm)]">
          <span className="text-[length:var(--text-sm)] font-bold tracking-wide">
            {roleLabel}
          </span>
          <span className={cn(
            "inline-flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] text-[length:var(--text-2xs)] font-bold uppercase tracking-widest rounded-[0.15rem]",
            v.bg, v.color,
          )}>
            {showHelp && <NumBadge n={4} />}{t(`analysis.verdict.${verdict}`)}
          </span>
        </div>
        <span className="text-[length:var(--text-2xl)] font-bold tabular-nums">
          {summary.totalWorkers}
        </span>
      </div>

      {cap && <HoursBar cap={cap} showHelp={showHelp} />}

      {cap && surplusH !== 0 && (
        <div className="flex items-center gap-[var(--space-sm)]">
          <span className={cn("text-[length:var(--text-lg)] font-bold tabular-nums", v.color)}>
            {showHelp && <NumBadge n={3} />}{" "}{surplusH > 0 ? "+" : ""}{t("analysis.hoursPerWeek", { n: surplusH })}
          </span>
          <div className="text-[length:10px] font-bold tracking-wide text-muted-foreground">
            {verdict === "oversized" && (
              <span className={v.color}>{t(surplusWAbs > 1 ? "analysis.surplusMany" : "analysis.surplusOne", { n: surplusWAbs })}</span>
            )}
            {verdict === "undersized" && (
              <span className={v.color}>{t("analysis.toHire", { n: surplusWAbs })}</span>
            )}
            {verdict === "tight" && summary.slotsUnderstaffed > 0 && (
              <span className={v.color}>{t("analysis.slotsUncovered")}</span>
            )}
            {((verdict === "balanced") || (verdict === "tight" && summary.slotsUnderstaffed === 0)) && (
              <span>{t("analysis.surplus")}</span>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-[var(--space-xs)]">
        {showHelp && (summary.slotsUnderstaffed > 0 || summary.slotsTight > 0) && <NumBadge n={5} />}
        {summary.slotsUnderstaffed > 0 && (
          <span className="inline-block px-[var(--space-xs)] py-[1px] text-[length:var(--text-2xs)] font-bold uppercase tracking-widest rounded-[0.15rem] bg-red-500/15 text-red-600 dark:text-red-400">
            {t("analysis.slotsUnderstaffed", { n: summary.slotsUnderstaffed })}
          </span>
        )}
        {summary.slotsTight > 0 && (
          <span className="inline-block px-[var(--space-xs)] py-[1px] text-[length:var(--text-2xs)] font-bold uppercase tracking-widest rounded-[0.15rem] bg-amber-500/15 text-amber-600 dark:text-amber-400">
            {t("analysis.slotsTight", { n: summary.slotsTight })}
          </span>
        )}
      </div>

      <p className="text-[length:var(--text-xs)] text-muted-foreground leading-relaxed">
        {summary.recommendation}
      </p>
    </div>
  );
}



// Server emits ISO weekday (1=Mon..7=Sun). Intl returns Sunday-first (0=Sun..6=Sat).
// `d % 7` maps Sunday from 7→0 while keeping Mon..Sat at 1..6 — matches Intl indexing.
const dayLabel = (d: number): string => JOURS_COURTS[d % 7] ?? "";

// ── Slot Heatmap: visual grid of day × zone fill status ──

const slotStatusColor: Record<string, string> = {
  covered: "bg-emerald-500",
  overstaffed: "bg-blue-500",
  understaffed: "bg-red-500",
  tight: "bg-amber-500",
  closed: "bg-foreground/5",
};

function SlotHeatmap({ slots }: { slots: import("@/lib/api").SlotAnalysis[] }) {
  const { t } = useTranslation(["staff", "roles"]);
  const activeSlots = slots.filter(s => s.target > 0);
  if (activeSlots.length === 0) return null;

  // Render one row per (zone, role) tuple so cuisine and salle don't collapse
  // into a single row that hides half the data.
  const zoneRoles = [...new Set(activeSlots.map(s => `${s.zone}\u0000${s.role}`))]
    .map(k => { const [zone, role] = k.split("\u0000"); return { zone, role: role as "kitchen" | "floor" }; })
    .sort((a, b) => a.zone.localeCompare(b.zone) || a.role.localeCompare(b.role));
  const days = [...new Set(activeSlots.map(s => s.dayOfWeek))].sort((a, b) => a - b);
  return (
    <div className="space-y-[var(--space-xs)]">
      <div className="flex items-center gap-[var(--space-xs)]">
        <BarChart3 className="size-3 text-muted-foreground" />
        <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">{t("analysis.heatmap.label")}</span>
        <div className="flex items-center gap-[var(--space-sm)] ml-auto">
          {[
            { label: t("analysis.heatmap.legendCovered"), color: "bg-emerald-500" },
            { label: t("analysis.heatmap.legendTight"), color: "bg-amber-500" },
            { label: t("analysis.heatmap.legendUnderstaffed"), color: "bg-red-500" },
            { label: t("analysis.heatmap.legendOverstaffed"), color: "bg-blue-500" },
          ].map(l => (
            <span key={l.label} className="flex items-center gap-[2px] text-[length:8px] text-muted-foreground">
              <span className={cn("inline-block w-[6px] h-[6px] rounded-[1px]", l.color)} />{l.label}
            </span>
          ))}
        </div>
      </div>
      <div className="border border-foreground/10 rounded-[0.2rem] overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-[length:8px] font-bold text-muted-foreground/50 uppercase tracking-widest p-[3px] text-left w-[50px]" />
              {days.map(d => (
                <th key={d} className="text-[length:8px] font-bold text-muted-foreground/50 uppercase tracking-widest p-[3px] text-center">
                  {dayLabel(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zoneRoles.map(({ zone, role }) => (
              <tr key={`${zone}_${role}`}>
                <td className="text-[length:8px] font-bold text-muted-foreground/60 p-[3px] truncate max-w-[80px]">
                  <span className="block leading-tight">{zone}</span>
                  <span className="block leading-tight text-muted-foreground/40 normal-case tracking-normal">{t(`roles:${role}`)}</span>
                </td>
                {days.map(d => {
                  const slot = activeSlots.find(s => s.dayOfWeek === d && s.zone === zone && s.role === role);
                  if (!slot) return <td key={d} className="p-[2px]"><div className="h-[18px]" /></td>;
                  const color = slotStatusColor[slot.status] || "bg-foreground/10";
                  const fill = slot.effectiveAvailability ?? slot.available;
                  return (
                    <td key={d} className="p-[2px]">
                      <div className={cn("h-[18px] rounded-[2px] flex items-center justify-center transition-colors", color, slot.status === "closed" ? "opacity-30" : "opacity-80 hover:opacity-100")}>
                        <span className="text-[length:8px] font-bold text-white drop-shadow-sm tabular-nums">
                          {fill}/{slot.target}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Worker Utilization Bars ──

function WorkerUtilizationBars({ workerLoads }: { workerLoads: import("@/lib/api").WorkerLoad[] }) {
  const { t } = useTranslation(["staff", "roles"]);
  const [expanded, setExpanded] = useState(false);
  const active = workerLoads.filter(w => (w.contractHours ?? 35) > 0);
  if (active.length === 0) return null;

  const sorted = [...active].sort((a, b) => {
    const aC = a.contractHours ?? 35;
    const bC = b.contractHours ?? 35;
    const aUtil = aC > 0 ? (a.maxWeeklyHours ?? 0) / aC : 0;
    const bUtil = bC > 0 ? (b.maxWeeklyHours ?? 0) / bC : 0;
    return aUtil - bUtil;
  });

  const kitchenWorkers = sorted.filter(w => w.role === "kitchen");
  const salleWorkers = sorted.filter(w => w.role === "floor");

  function UtilBar({ w }: { w: import("@/lib/api").WorkerLoad }) {
    const planned = w.maxWeeklyHours ?? 0;
    const contract = w.contractHours ?? 35;
    const utilPct = contract > 0 ? Math.round((planned / contract) * 100) : 0;
    const barPct = Math.min(100, utilPct);
    const barColor = utilPct >= 90 ? "bg-emerald-500" : utilPct >= 60 ? "bg-amber-500" : utilPct > 0 ? "bg-red-500" : "bg-foreground/20";
    return (
      <div className="flex items-center gap-[var(--space-sm)] text-[length:var(--text-2xs)]">
        <Link to={`/staff/${w.workerId}`} className="w-[80px] truncate font-bold underline underline-offset-2 decoration-foreground/25 hover:decoration-foreground/60">
          {w.workerName}
        </Link>
        <div className="flex-1 h-[6px] rounded-full bg-foreground/10 overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${barPct}%` }} />
        </div>
        <span className="w-[65px] text-right tabular-nums text-muted-foreground">
          {planned}h/{contract}h
        </span>
        <span className={cn("w-[30px] text-right tabular-nums font-bold", utilPct >= 90 ? "text-emerald-600 dark:text-emerald-400" : utilPct >= 60 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400")}>
          {utilPct}%
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-[var(--space-xs)]">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-[var(--space-xs)] hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">
          {t("analysis.utilization", { n: active.length })}
        </span>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-md)]">
          {[{ label: t("roles:kitchen"), workers: kitchenWorkers }, { label: t("roles:floor"), workers: salleWorkers }]
            .filter(g => g.workers.length > 0)
            .map(g => (
              <div key={g.label} className="space-y-[2px]">
                <span className="text-[length:8px] uppercase tracking-widest font-bold text-muted-foreground/50">{g.label}</span>
                {g.workers.map(w => <UtilBar key={w.workerId} w={w} />)}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ── ILP Stats Footer ──

function longHorizonLabel(longHorizon?: LongHorizonStaffingSummary): string {
  if (!longHorizon || longHorizon.status === "missing") return "calcul en cours";
  if (longHorizon.status === "ok") return "à jour";
  if (longHorizon.status === "running") return "calcul en cours";
  return "erreur";
}

function ILPStatsFooter({ stats, longHorizon }: { stats?: string; longHorizon?: LongHorizonStaffingSummary }) {
  if (!stats && !longHorizon) return null;
  return (
    <div className="space-y-[2px] text-[length:8px] text-muted-foreground/40 pt-[var(--space-xs)] border-t border-foreground/5">
      <div className="flex flex-wrap items-center gap-x-[var(--space-sm)] gap-y-[2px]">
        <span>Analyse affichée: 6 semaines</span>
        <span>Contrôle HCR 12 semaines: {longHorizonLabel(longHorizon)}</span>
      </div>
      {stats && (
        <div className="flex items-center gap-[var(--space-xs)]">
          <Cpu className="size-[10px]" />
          <span className="font-mono">{stats}</span>
        </div>
      )}
    </div>
  );
}

function HowItWorks({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const { t } = useTranslation("staff");
  return (
    <div className="text-[length:var(--text-xs)] text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-[var(--space-xs)] hover:text-foreground transition-colors"
      >
        <HelpCircle className="size-3 shrink-0" />
        <span className="underline underline-offset-2">{t("analysis.howItWorks.toggle")}</span>
      </button>
      {open && (
        <div className="mt-[var(--space-sm)] ml-[18px] space-y-[var(--space-md)] leading-relaxed">
          <div>
            <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("analysis.howItWorks.indicatorsHeader")}</p>
            <ol className="list-decimal ml-[16px] space-y-[3px]">
              <li>{t("analysis.howItWorks.indicator1")}</li>
              <li>{t("analysis.howItWorks.indicator2")}</li>
              <li>{t("analysis.howItWorks.indicator3")}</li>
              <li>{t("analysis.howItWorks.indicator4")}</li>
              <li>{t("analysis.howItWorks.indicator5")}</li>
            </ol>
          </div>
          <div>
            <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("analysis.howItWorks.engineHeader")}</p>
            <p className="mb-[var(--space-xs)]">
              <Trans
                i18nKey="staff:analysis.howItWorks.engineBody"
                components={{
                  link: <a href="https://developers.google.com/optimization/cp/cp_solver" target="_blank" rel="noopener noreferrer" className="underline text-foreground hover:text-foreground/80" />,
                }}
              />
            </p>
          </div>
          <p className="text-[length:var(--text-2xs)]">
            {t("analysis.howItWorks.engineFooter")}
          </p>
        </div>
      )}
    </div>
  );
}

function ExpansionSuggestionsCard({ profileId }: { profileId?: string }) {
  const { t } = useTranslation("staff");
  const [loading, setLoading] = useState(false);
  const [insights, setInsights] = useState<ExpansionInsight[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getStaffingExpansion(profileId);
      setInsights(res.data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const verdictStyle = (v: ExpansionInsight["verdict"]) =>
    v === "viable"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
      : v === "needs_hire"
        ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
        : "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-400";

  const verdictLabel = (v: ExpansionInsight["verdict"]) =>
    v === "viable" ? t("analysis.expansion.viable")
      : v === "needs_hire" ? t("analysis.expansion.needsHire")
      : t("analysis.expansion.unrealistic");

  return (
    <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-md)] space-y-[var(--space-sm)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--space-xs)]">
          <Plus className="size-3.5 text-muted-foreground" />
          <span className="text-[length:var(--text-xs)] tracking-wide font-bold">
            {t("analysis.expansion.title")}
          </span>
        </div>
        {insights === null && !loading && (
          <button
            onClick={run}
            className="text-[length:var(--text-xs)] tracking-wide font-bold px-[var(--space-sm)] py-[2px] rounded-[0.2rem] border border-foreground/20 hover:border-foreground/40 transition-colors"
          >
            {t("analysis.expansion.analyze")}
          </button>
        )}
        {loading && (
          <span className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {t("analysis.expansion.running")}
          </span>
        )}
      </div>

      {error && (
        <p className="text-[length:var(--text-xs)] text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {insights && insights.length === 0 && !loading && (
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("analysis.expansion.empty")}
        </p>
      )}

      {insights && insights.length > 0 && (
        <div className="space-y-[var(--space-xs)]">
          {insights.map((ins, i) => (
            <div
              key={i}
              className={cn(
                "border rounded-[0.2rem] p-[var(--space-sm)] space-y-[2px]",
                verdictStyle(ins.verdict),
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-[length:var(--text-xs)] font-bold tracking-wide">
                  {ins.dayLabel.charAt(0).toUpperCase() + ins.dayLabel.slice(1)} {ins.shiftLabel}
                </span>
                <span className="text-[length:var(--text-xs)] font-bold">
                  {verdictLabel(ins.verdict)}
                </span>
              </div>
              <p className="text-[length:var(--text-xs)]">{ins.summary}</p>
              <p className="text-[length:var(--text-xs)] text-muted-foreground">
                {t("analysis.expansion.demandAdded", { kitchen: ins.addedDemandHours.kitchen, floor: ins.addedDemandHours.floor })}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StaffingAnalysisPanel() {
 const { t } = useTranslation("staff");
 const [data, setData] = useState<StaffingAnalysis | null>(null);
 const [loading, setLoading] = useState(true);
 const [profileId, setProfileId] = useState<string | undefined>();
 const [expanded, setExpanded] = useState(true);
 const [showHowItWorks, setShowHowItWorks] = useState(false);

 const fetch = useCallback(async () => {
 setLoading(true);
 try {
 const res = await api.getStaffingAnalysis(profileId);
 setData(res.data);
 } catch {
 setData(null);
 } finally {
 setLoading(false);
 }
 }, [profileId]);

 useEffect(() => { fetch(); }, [fetch]);

 const hasAnyTargets = data?.slots.some(s => s.target > 0) ?? false;
 const solverUnavailable = data?.ilpStats?.startsWith("Solver error:") ?? false;

 return (
 <div className="space-y-[var(--space-sm)]">
 {/* Header */}
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-[var(--space-xs)]">
 <button
 onClick={() => setExpanded(!expanded)}
 className="flex items-center gap-[var(--space-sm)] group"
 >
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground group-hover:text-foreground transition-colors">
 {t("analysis.title")}
 </span>
 <span className="text-[length:var(--text-xs)] text-muted-foreground">
 <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
 </span>
 </button>
 <HowItWorks open={showHowItWorks} setOpen={setShowHowItWorks} />
 </div>
 {expanded && (
 <div className="flex items-center gap-[var(--space-md)] ml-auto">
 {data && data.profiles.length > 1 && (
 <div className="flex items-center gap-[var(--space-xs)]">
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground">{t("analysis.objectiveLabel")}</span>
 <select
 value={profileId ?? ""}
 onChange={(e) => setProfileId(e.target.value || undefined)}
 className="text-[length:var(--text-xs)] tracking-wide font-bold bg-transparent border border-foreground/20 rounded-[0.2rem] px-[var(--space-sm)] py-[2px] text-foreground"
 >
 <option value="">{t("analysis.objectivePlanned")}</option>
 {data.profiles.map((p) => (
 <option key={p.id} value={p.id}>{p.name || t("analysis.objectiveDefault")}</option>
 ))}
 </select>
 </div>
 )}
 <button
 type="button"
 onClick={fetch}
 disabled={loading}
 title={t("analysis.refreshTitle")}
 className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-foreground/20 text-muted-foreground hover:text-foreground hover:border-foreground/40 hover:bg-foreground/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
 >
 <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
 </button>
 </div>
 )}
 </div>

 {!expanded ? null : loading ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("analysis.loading")}</p>
 ) : !data ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("analysis.loadError")}</p>
 ) : !hasAnyTargets ? (
 <div className="border border-dashed border-foreground/15 rounded-[0.2rem] p-[var(--space-md)] text-center space-y-[var(--space-xs)]">
 <p className="text-[length:var(--text-sm)] font-bold tracking-wide">
 {t("analysis.noTargetsTitle")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground">
 {t("analysis.noTargetsBody")}
 </p>
 </div>
 ) : (
 <div className="space-y-[var(--space-md)]">
 {data.warnings && data.warnings.length > 0 && (
  <div className="rounded-[0.2rem] border border-amber-500/25 bg-amber-500/10 px-[var(--space-md)] py-[var(--space-sm)] text-[length:var(--text-xs)] font-medium text-amber-800 dark:text-amber-300">
   {data.warnings[0]}
  </div>
 )}
 {/* Role summary cards */}
 <div className="grid grid-cols-2 gap-[var(--space-sm)]">
 {data.roles.map(r => (
   <RoleCard
     key={r.role}
     summary={r}
     cap={data.capacity?.find(c => c.role === r.role)}
     showHelp={showHowItWorks}
   />
 ))}
 </div>

 {!solverUnavailable && (
 <>
 {/* Slot heatmap */}
 <SlotHeatmap slots={data.slots} />

 {/* Worker utilization bars */}
 <WorkerUtilizationBars workerLoads={data.workerLoads} />
 </>
 )}

 {/* Holiday advice is now served from /holidays (unified "Intelligence congés" panel).
   Keep a link here so /staff points to the canonical view. */}
 <Link
  to="/holidays"
  className="flex items-center justify-between gap-[var(--space-xs)] px-[var(--space-md)] py-[var(--space-sm)] rounded-[0.2rem] border border-foreground/10 hover:border-foreground/30 text-[length:var(--text-xs)] transition-colors"
 >
  <span className="flex items-center gap-[var(--space-xs)] font-bold">
   <CalendarDays className="size-3.5 text-muted-foreground" />
   {t("analysis.holidaysCard.title")}
  </span>
  <span className="flex items-center gap-[var(--space-xs)] text-muted-foreground">
   {t("analysis.holidaysCard.subtitle")}
   <ChevronRight className="size-3" />
  </span>
 </Link>

 {/* Expansion suggestions — on-demand feasibility check for closed day/shift combos */}
 <ExpansionSuggestionsCard profileId={profileId} />

 {/* Link to optimize page */}
 <Link
  to="/optimize"
  className="flex items-center justify-center gap-[var(--space-xs)] px-[var(--space-md)] py-[var(--space-sm)] rounded-[0.2rem] border border-purple-500/30 bg-purple-500/5 hover:bg-purple-500/10 text-[length:var(--text-xs)] font-bold text-purple-600 dark:text-purple-400 transition-colors"
 >
  <FlaskConical className="size-3.5" />
  {t("analysis.optimizeCta")}
 </Link>

 {/* ILP solver stats */}
 <ILPStatsFooter stats={data.ilpStats} longHorizon={data.longHorizon} />
 </div>
 )}
 </div>
 );
}
