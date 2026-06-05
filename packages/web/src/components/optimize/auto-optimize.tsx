import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type AutoOptimizeResult, type OptimizationRecommendation, type CompoundPlan, type HireRecommendation, type StaffingAnalysis, type CapacitySummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Zap, Ban, TrendingDown, TrendingUp, Users, ArrowRight, Loader2, RefreshCw, Check, FlaskConical, X, GraduationCap, UserX, Target, ChevronRight, UserPlus, Calendar, ArrowUp } from "lucide-react";

const DEFAULT_OPTIMIZE_SOLVER_BUDGET = 160;

type Lever = "reduce" | "increase" | "terminate" | "intra_train" | "remove_restrictions" | "hire_cdi" | "hire_seasonal";
const LEVER_ORDER: Array<{ id: Lever; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "reduce", icon: TrendingDown },
  { id: "increase", icon: ArrowUp },
  { id: "terminate", icon: UserX },
  { id: "remove_restrictions", icon: Ban },
  { id: "intra_train", icon: GraduationCap },
  { id: "hire_cdi", icon: UserPlus },
  { id: "hire_seasonal", icon: UserPlus },
];

const verdictStyle: Record<string, { color: string; bg: string }> = {
  oversized: { color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/15" },
  undersized: { color: "text-red-600 dark:text-red-400", bg: "bg-red-500/15" },
  tight: { color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/15" },
  balanced: { color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/15" },
};

const contractBadgeStyle: Record<string, string> = {
  CDI: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  CDD: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25",
  saisonnier: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/25",
};

function ContractBadge({ type }: { type: string | null | undefined }) {
  const { t } = useTranslation("optimize");
  if (!type) return null;
  const label = type === "saisonnier" ? t("contractBadge.saisonnierShort") : type;
  return <span className={cn("px-1 py-0 rounded-full text-[length:9px] font-medium border", contractBadgeStyle[type] || "bg-foreground/5 text-muted-foreground border-foreground/10")}>{label}</span>;
}

function BaselineSummary({ capacity }: { capacity: CapacitySummary[] }) {
  const { t } = useTranslation("optimize");
  return (
    <div className="grid grid-cols-2 gap-[var(--space-sm)]">
      {(["kitchen", "floor"] as const).map(role => {
        const cap = capacity.find(c => c.role === role);
        if (!cap) return null;
        const v = verdictStyle[cap.verdict ?? "balanced"] ?? verdictStyle.balanced;
        return (
          <div key={role} className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-sm)] space-y-[var(--space-xs)]">
            <div className="flex items-center justify-between">
              <span className="text-[length:var(--text-xs)] font-bold tracking-wide uppercase">
                {role === "kitchen" ? t("roles.kitchen") : t("roles.floor")}
              </span>
              <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:var(--text-2xs)] font-bold", v.bg, v.color)}>
                {t(`verdict.${cap.verdict ?? "balanced"}`)}
              </span>
            </div>
            <div className="flex items-center gap-[var(--space-md)] text-[length:var(--text-xs)]">
              <span className="text-muted-foreground">
                {t("auto.demand")} <span className="font-bold text-foreground tabular-nums">{Math.round(cap.totalDemandHours ?? cap.totalDemand)}h</span>
              </span>
              <span className="text-muted-foreground">
                {t("auto.contract")} <span className="font-bold text-foreground tabular-nums">{cap.totalContractHours ?? 0}h</span>
              </span>
              <span className={cn("font-bold tabular-nums", (cap.surplusHours ?? 0) > 0 ? "text-blue-600 dark:text-blue-400" : (cap.surplusHours ?? 0) < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                {(cap.surplusHours ?? 0) > 0 ? "+" : ""}{cap.surplusHours ?? 0}h
              </span>
            </div>
            <div className="flex items-center gap-[var(--space-md)] text-[length:var(--text-2xs)] text-muted-foreground">
              <span>
                {t("auto.slotsToCover", { count: Math.round(cap.totalDemand) })}
              </span>
              <span>
                {t("auto.workerCapacity", { count: Math.round(cap.totalCapacity) })}
              </span>
            </div>
          </div>
        );
      })}
      <p className="col-span-2 text-[length:var(--text-2xs)] text-muted-foreground/50 text-center pt-[2px]">
        {t("auto.hoursNote")}
      </p>
    </div>
  );
}

function RecommendationCard({ rec, index, selected, onToggle }: {
  rec: OptimizationRecommendation;
  index: number;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("optimize");
  const [expanded, setExpanded] = useState(false);
  const typeConfig = rec.type === "remove_restrictions"
    ? { icon: Ban, color: "text-amber-600 dark:text-amber-400", bg: "border-amber-500/20 bg-amber-500/5", selectedBg: "border-amber-500/40 bg-amber-500/10" }
    : rec.type === "cross_train"
    ? { icon: Users, color: "text-teal-600 dark:text-teal-400", bg: "border-teal-500/20 bg-teal-500/5", selectedBg: "border-teal-500/40 bg-teal-500/10" }
    : rec.type === "intra_train"
    ? { icon: GraduationCap, color: "text-cyan-600 dark:text-cyan-400", bg: "border-cyan-500/20 bg-cyan-500/5", selectedBg: "border-cyan-500/40 bg-cyan-500/10" }
    : rec.type === "terminate"
    ? { icon: UserX, color: "text-red-600 dark:text-red-400", bg: "border-red-500/20 bg-red-500/5", selectedBg: "border-red-500/40 bg-red-500/10" }
    : rec.type === "increase_hours"
    ? { icon: ArrowUp, color: "text-green-600 dark:text-green-400", bg: "border-green-500/20 bg-green-500/5", selectedBg: "border-green-500/40 bg-green-500/10" }
    : { icon: TrendingDown, color: "text-purple-600 dark:text-purple-400", bg: "border-purple-500/20 bg-purple-500/5", selectedBg: "border-purple-500/40 bg-purple-500/10" };
  const Icon = typeConfig.icon;

  return (
    <div className={cn("border rounded-[0.2rem] overflow-hidden transition-colors", selected ? typeConfig.selectedBg : typeConfig.bg)}>
      <div className="flex">
        {/* Checkbox */}
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 flex items-start pt-[var(--space-sm)] pl-[var(--space-sm)]"
        >
          <span className={cn(
            "inline-flex items-center justify-center size-[18px] rounded-[0.15rem] border-2 transition-colors",
            selected
              ? "bg-foreground border-foreground text-background"
              : "border-foreground/25 hover:border-foreground/50",
          )}>
            {selected && <Check className="size-3" strokeWidth={3} />}
          </span>
        </button>

        {/* Card content */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex-1 px-[var(--space-sm)] py-[var(--space-sm)] text-left"
        >
          <div className="flex items-start gap-[var(--space-sm)]">
            <span className="inline-flex items-center justify-center size-[20px] text-[length:var(--text-2xs)] font-bold rounded-full bg-foreground/10 text-foreground/70 shrink-0 mt-[1px]">
              {index + 1}
            </span>

            <div className="flex-1 min-w-0 space-y-[2px]">
              <div className="flex items-center gap-[var(--space-xs)]">
                <Icon className={cn("size-3.5 shrink-0", typeConfig.color)} />
                <span className={cn("text-[length:var(--text-2xs)] uppercase tracking-widest font-bold", typeConfig.color)}>
                  {rec.label}
                </span>
              </div>

              <div className="flex items-center gap-[var(--space-xs)]">
                <Link
                  to={`/staff/${rec.workerId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-[length:var(--text-xs)] font-bold underline underline-offset-2 decoration-foreground/25 hover:decoration-foreground/60"
                >
                  {rec.workerName}
                </Link>
                <ContractBadge type={rec.contractType} />
                <span className="text-[length:var(--text-2xs)] text-muted-foreground uppercase tracking-widest">
                  {rec.role === "kitchen" ? t("roles.kitchen") : t("roles.floor")}
                </span>
              </div>

              <p className="text-[length:var(--text-xs)] text-muted-foreground leading-relaxed">
                {rec.description}
              </p>

              <div className="flex flex-wrap items-center gap-[var(--space-sm)] pt-[2px]">
                {rec.type === "cross_train" ? (
                  <span className="flex items-center gap-[2px] text-[length:var(--text-2xs)] font-bold text-teal-600 dark:text-teal-400">
                    {rec.role === "kitchen" ? t("roles.kitchen") : t("roles.floor")} <ArrowRight className="size-2.5" /> {rec.role === "kitchen" ? t("roles.floor") : t("roles.kitchen")}
                  </span>
                ) : rec.type === "intra_train" ? (
                  null /* description is self-explanatory */
                ) : rec.type === "terminate" ? (
                  <span className="flex items-center gap-[2px] text-[length:var(--text-2xs)] font-bold text-red-600 dark:text-red-400">
                    {rec.currentValue}h <ArrowRight className="size-2.5" /> 0h
                  </span>
                ) : rec.type === "increase_hours" ? (
                  <span className="flex items-center gap-[2px] text-[length:var(--text-2xs)] font-bold text-green-600 dark:text-green-400">
                    {rec.currentValue}h <ArrowRight className="size-2.5" /> {rec.proposedValue}h
                  </span>
                ) : rec.type !== "remove_restrictions" && (
                  <span className="flex items-center gap-[2px] text-[length:var(--text-2xs)] font-bold text-purple-600 dark:text-purple-400">
                    {rec.currentValue}h <ArrowRight className="size-2.5" /> {rec.proposedValue}h
                  </span>
                )}
                {Object.entries(rec.impact.surplusHoursDelta).map(([role, delta]) => {
                  if (delta === 0) return null;
                  return (
                    <span key={role} className={cn(
                      "flex items-center gap-[2px] text-[length:var(--text-2xs)] font-bold",
                      delta < 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                    )}>
                      {delta < 0 ? <TrendingDown className="size-2.5" /> : <TrendingUp className="size-2.5" />}
                      {t("auto.surplusDelta", { delta: delta > 0 ? `+${delta}` : delta, role: role === "kitchen" ? t("roles.kitchenAbbr") : t("roles.floorAbbr") })}
                    </span>
                  );
                })}
                {rec.impact.affectedWorkers.length > 0 && (
                  <span className="flex items-center gap-[2px] text-[length:var(--text-2xs)] text-muted-foreground">
                    <Users className="size-2.5" />
                    {t("auto.redistributedCount", { count: rec.impact.affectedWorkers.length })}
                  </span>
                )}
              </div>
            </div>

            <div className="text-right shrink-0">
              <span className={cn(
                "text-[length:var(--text-lg)] font-bold tabular-nums",
                rec.score > 20 ? "text-emerald-600 dark:text-emerald-400" : rec.score > 0 ? "text-foreground" : "text-muted-foreground",
              )}>
                {rec.score > 0 ? "+" : ""}{rec.score}
              </span>
              <p className="text-[length:var(--text-2xs)] text-muted-foreground">{t("auto.score")}</p>
            </div>
          </div>
        </button>
      </div>

      {expanded && rec.impact.affectedWorkers.length > 0 && (
        <div className="px-[var(--space-sm)] pb-[var(--space-sm)] pt-0 border-t border-foreground/5 ml-[30px]">
          <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60 block mt-[var(--space-xs)] mb-[var(--space-xs)]">
            {t("auto.redistributionTotal", { hours: rec.impact.hoursRedistributed })}
          </span>
          <div className="space-y-[1px]">
            {rec.impact.affectedWorkers.map(aw => (
              <div key={aw.workerId} className="flex items-center gap-[var(--space-sm)] text-[length:var(--text-xs)]">
                <Link to={`/staff/${aw.workerId}`} className="font-bold underline underline-offset-2 decoration-foreground/25 hover:decoration-foreground/60 w-[120px] truncate">
                  {aw.workerName}
                </Link>
                <span className={cn(
                  "font-bold tabular-nums",
                  aw.hoursDelta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                )}>
                  {aw.hoursDelta > 0 ? "+" : ""}{aw.hoursDelta}h
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Worker utilization before/after comparison ── */

function WorkerUtilizationComparison({ baseData, scenarioData, dept, defaultExpanded = false }: {
  baseData: StaffingAnalysis;
  scenarioData: StaffingAnalysis;
  dept: "kitchen" | "floor";
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation("optimize");
  const [expanded, setExpanded] = useState(defaultExpanded);

  const baseWorkers = baseData.workerLoads.filter(w => w.role === dept);
  const scenarioWorkers = scenarioData.workerLoads.filter(w => w.role === dept);
  if (baseWorkers.length === 0) return null;

  // Build comparison data sorted by utilization change (biggest improvement first)
  const comparisons = baseWorkers
    .map(bw => {
      const sw = scenarioWorkers.find(s => s.workerId === bw.workerId);
      const bPlanned = bw.maxWeeklyHours ?? 0;
      const bContract = bw.contractHours ?? 35;
      const sPlanned = sw?.maxWeeklyHours ?? bPlanned;
      const sContract = sw?.contractHours ?? bContract;
      const bUtil = bContract > 0 ? Math.round((bPlanned / bContract) * 100) : 0;
      const sUtil = sContract > 0 ? Math.round((sPlanned / sContract) * 100) : 0;
      const terminated = sContract === 0 && bContract > 0;
      const contractChanged = sContract !== bContract;
      const hoursChanged = Math.round((sPlanned - bPlanned) * 10) / 10 !== 0;
      return {
        workerId: bw.workerId,
        workerName: bw.workerName,
        contractType: bw.contractType,
        bPlanned, bContract, bUtil,
        sPlanned, sContract, sUtil,
        utilDelta: sUtil - bUtil,
        hoursDelta: Math.round((sPlanned - bPlanned) * 10) / 10,
        terminated,
        hasChange: terminated || contractChanged || hoursChanged,
      };
    })
    .sort((a, b) => {
      // Terminated first, then by before-utilization ascending
      if (a.terminated !== b.terminated) return a.terminated ? -1 : 1;
      return a.bUtil - b.bUtil;
    });

  const changed = comparisons.filter(c => c.hasChange);

  function UtilRow({ c }: { c: typeof comparisons[0] }) {
    const barColor = (util: number) =>
      util >= 90 ? "bg-emerald-500" : util >= 60 ? "bg-amber-500" : util > 0 ? "bg-red-500" : "bg-foreground/20";
    const textColor = (util: number) =>
      util >= 90 ? "text-emerald-600 dark:text-emerald-400" : util >= 60 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
    return (
      <div className={cn("space-y-[1px]", c.terminated && "opacity-60")}>
        <div className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-2xs)]">
          <Link to={`/staff/${c.workerId}`} className={cn("w-[80px] truncate font-bold underline underline-offset-2 decoration-foreground/25 hover:decoration-foreground/60", c.terminated && "line-through")}>
            {c.workerName}
          </Link>
          <ContractBadge type={c.contractType} />
          {c.terminated && (
            <span className="px-1 py-0 rounded-full text-[length:8px] font-bold border border-red-500/25 bg-red-500/15 text-red-600 dark:text-red-400">{t("auto.deletedBadge")}</span>
          )}
          <div className="flex-1" />
          {c.hasChange ? (
            <>
              <span className="tabular-nums text-muted-foreground">
                {c.bPlanned}h/{c.bContract}h
              </span>
              <ArrowRight className="size-2.5 text-purple-500" />
              {c.terminated ? (
                <span className="tabular-nums font-bold text-red-600 dark:text-red-400">—</span>
              ) : (
                <>
                  <span className="tabular-nums font-bold">
                    {c.sPlanned}h/{c.sContract}h
                  </span>
                  <span className={cn("tabular-nums font-bold w-[32px] text-right", textColor(c.sUtil))}>
                    {c.sUtil}%
                  </span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="tabular-nums text-muted-foreground">
                {c.bPlanned}h/{c.bContract}h
              </span>
              <span className={cn("tabular-nums font-bold w-[32px] text-right", textColor(c.bUtil))}>
                {c.bUtil}%
              </span>
            </>
          )}
        </div>
        {/* Stacked before/after bars */}
        {!c.terminated && (
          <div className="flex items-center gap-[var(--space-xs)] ml-[80px] pl-[var(--space-xs)]">
            <div className="flex-1 space-y-[1px]">
              {c.hasChange ? (
                <>
                  <div className="h-[3px] rounded-full bg-foreground/10 overflow-hidden">
                    <div className={cn("h-full rounded-full opacity-40", barColor(c.bUtil))} style={{ width: `${Math.min(100, c.bUtil)}%` }} />
                  </div>
                  <div className="h-[3px] rounded-full bg-foreground/10 overflow-hidden">
                    <div className={cn("h-full rounded-full", barColor(c.sUtil))} style={{ width: `${Math.min(100, c.sUtil)}%` }} />
                  </div>
                </>
              ) : (
                <div className="h-[4px] rounded-full bg-foreground/10 overflow-hidden">
                  <div className={cn("h-full rounded-full", barColor(c.bUtil))} style={{ width: `${Math.min(100, c.bUtil)}%` }} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-[var(--space-xs)] pt-[var(--space-xs)] border-t border-purple-500/10">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-[var(--space-xs)] hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">
          {t("auto.utilizationByEmployee", { count: comparisons.length })}
        </span>
        {changed.length > 0 && (
          <span className="text-[length:var(--text-2xs)] text-purple-600 dark:text-purple-400 font-bold">
            {t("auto.modifiedCount", { count: changed.length })}
          </span>
        )}
      </button>
      {expanded && (
        <div className="space-y-[var(--space-sm)]">
          {comparisons.map(c => <UtilRow key={c.workerId} c={c} />)}
        </div>
      )}
    </div>
  );
}

function buildScenarioOverrides(recommendations: OptimizationRecommendation[]) {
  const contractOverrides: Record<string, number> = {};
  const maxWeeklyOverrides: Record<string, number> = {};
  const restrictionOverrides: string[] = [];
  const roleOverrides: Record<string, string> = {};
  for (const rec of recommendations) {
    if (rec.contractOverrides) {
      Object.assign(contractOverrides, rec.contractOverrides);
      if (rec.maxWeeklyOverrides) Object.assign(maxWeeklyOverrides, rec.maxWeeklyOverrides);
    } else if (rec.type === "remove_restrictions") {
      restrictionOverrides.push(rec.workerId);
    } else if (rec.type === "cross_train") {
      roleOverrides[rec.workerId] = rec.role === "kitchen" ? "floor" : "kitchen";
    } else if (rec.type === "intra_train") {
      // Informational — no staffing-analysis override available yet.
    } else if (rec.type === "terminate") {
      contractOverrides[rec.workerId] = 0;
    } else {
      contractOverrides[rec.workerId] = rec.proposedValue;
    }
  }
  return { contractOverrides, maxWeeklyOverrides, restrictionOverrides, roleOverrides };
}

/* ── Scenario comparison panel (shown when recs are selected) ── */

function ScenarioComparison({ baseline: _baseline, recommendations, onClose, dept, profileId }: {
  baseline: NonNullable<AutoOptimizeResult["baseline"]>;
  recommendations: OptimizationRecommendation[];
  onClose: () => void;
  dept: "kitchen" | "floor";
  profileId?: string;
}) {
  const { t } = useTranslation("optimize");
  const [baseData, setBaseData] = useState<StaffingAnalysis | null>(null);
  const [scenarioData, setScenarioData] = useState<StaffingAnalysis | null>(null);
  const [loading, setLoading] = useState(true);

  // Build combined overrides from selected recommendations
  const { contractOverrides, maxWeeklyOverrides, restrictionOverrides, roleOverrides } = useMemo(
    () => buildScenarioOverrides(recommendations),
    [recommendations],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Sequential calls — CP-SAT sidecar is single-threaded per request
    (async () => {
      try {
        const baseRes = await api.getStaffingAnalysis(profileId);
        if (cancelled) return;
        const scenarioRes = await api.getStaffingAnalysis(
          profileId,
          Object.keys(contractOverrides).length > 0 ? contractOverrides : undefined,
          restrictionOverrides.length > 0 ? restrictionOverrides : undefined,
          Object.keys(roleOverrides).length > 0 ? roleOverrides : undefined,
          Object.keys(maxWeeklyOverrides).length > 0 ? maxWeeklyOverrides : undefined,
        );
        if (cancelled) return;
        setBaseData(baseRes.data);
        setScenarioData(scenarioRes.data);
      } catch {
        // Ignore fetch failures; UI shows stale state.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [profileId, contractOverrides, maxWeeklyOverrides, restrictionOverrides, roleOverrides]);

  if (loading) {
    return (
      <div className="border border-purple-500/30 bg-purple-500/5 rounded-[0.2rem] p-[var(--space-md)] space-y-[var(--space-sm)]">
        <div className="flex items-center gap-[var(--space-sm)]">
          <FlaskConical className="size-4 text-purple-600 dark:text-purple-400" />
          <span className="text-[length:var(--text-sm)] font-bold text-purple-600 dark:text-purple-400">
            {t("auto.scenarioSimulating")}
          </span>
          <Loader2 className="size-3 animate-spin text-purple-600 dark:text-purple-400" />
        </div>
      </div>
    );
  }

  if (!baseData || !scenarioData) return null;

  return (
    <div className="border border-purple-500/30 bg-purple-500/5 rounded-[0.2rem] p-[var(--space-md)] space-y-[var(--space-sm)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--space-sm)]">
          <FlaskConical className="size-4 text-purple-600 dark:text-purple-400" />
          <span className="text-[length:var(--text-sm)] font-bold text-purple-600 dark:text-purple-400">
            {t("auto.scenarioCombined", { count: recommendations.length })}
          </span>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {/* Applied changes grouped by decision type */}
      {(() => {
        const terminated = recommendations.filter(r => r.type === "terminate");
        const reduced = recommendations.filter(r => r.type !== "terminate" && r.type !== "remove_restrictions" && r.type !== "cross_train" && r.type !== "intra_train");
        const restrictions = recommendations.filter(r => r.type === "remove_restrictions");
        const roles = recommendations.filter(r => r.type === "cross_train");

        // Split terminated by contract type
        const terminatedCDD = terminated.filter(r => r.contractType === "CDD" || r.contractType === "saisonnier");
        const terminatedCDI = terminated.filter(r => r.contractType === "CDI" || (!r.contractType && r.contractType !== "CDD" && r.contractType !== "saisonnier"));

        const groups: Array<{ label: string; color: string; border: string; items: Array<{ name: string; detail: string }> }> = [];
        if (terminatedCDD.length > 0) groups.push({
          label: t("auto.groupDoNotRenew"), color: "text-amber-700 dark:text-amber-300", border: "border-amber-500/20 bg-amber-500/10",
          items: terminatedCDD.map(r => ({ name: r.workerName, detail: r.contractType === "saisonnier" ? t("contractBadge.saisonnierShort") : "CDD" })),
        });
        if (terminatedCDI.length > 0) groups.push({
          label: t("auto.groupRemovePosition"), color: "text-red-700 dark:text-red-300", border: "border-red-500/20 bg-red-500/10",
          items: terminatedCDI.map(r => ({ name: r.workerName, detail: "CDI" })),
        });
        if (reduced.length > 0) groups.push({
          label: t("auto.groupReduceHours"), color: "text-purple-700 dark:text-purple-300", border: "border-purple-500/20 bg-purple-500/10",
          items: reduced.map(r => ({ name: r.workerName, detail: `${r.currentValue}h→${r.proposedValue}h` })),
        });
        if (restrictions.length > 0) groups.push({
          label: t("auto.groupLiftRestrictions"), color: "text-amber-700 dark:text-amber-300", border: "border-amber-500/20 bg-amber-500/10",
          items: restrictions.map(r => ({ name: r.workerName, detail: t("auto.detailNoRestrictions") })),
        });
        if (roles.length > 0) groups.push({
          label: t("auto.groupTransfer"), color: "text-teal-700 dark:text-teal-300", border: "border-teal-500/20 bg-teal-500/10",
          items: roles.map(r => ({ name: r.workerName, detail: `→ ${r.role === "kitchen" ? t("roles.floor") : t("roles.kitchen")}` })),
        });

        return (
          <div className="space-y-[var(--space-xs)]">
            {groups.map(g => (
              <div key={g.label} className="space-y-[2px]">
                <span className={cn("text-[length:var(--text-2xs)] uppercase tracking-widest font-bold", g.color)}>{g.label}</span>
                <div className="flex flex-wrap gap-[var(--space-xs)]">
                  {g.items.map(item => (
                    <span key={item.name} className={cn("inline-flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] rounded-full border text-[length:var(--text-xs)]", g.border)}>
                      <span className={cn("font-bold", g.color)}>{item.name}</span>
                      <span className="text-muted-foreground">{item.detail}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Before / After comparison */}
      <div className="space-y-[var(--space-xs)]">
        {([dept] as const).map(role => {
          const baseCap = baseData.capacity.find(c => c.role === role);
          const scenCap = scenarioData.capacity.find(c => c.role === role);
          if (!baseCap || !scenCap) return null;
          const vBefore = verdictStyle[baseCap.verdict ?? "balanced"];
          const vAfter = verdictStyle[scenCap.verdict ?? "balanced"];
          const underBefore = baseData.slots.filter(s => s.role === role && s.status === "understaffed").length;
          const underAfter = scenarioData.slots.filter(s => s.role === role && s.status === "understaffed").length;
          const vChanged = baseCap.verdict !== scenCap.verdict;
          const surplusDelta = (scenCap.surplusHours ?? 0) - (baseCap.surplusHours ?? 0);
          const roleColor = role === "kitchen" ? "text-amber-600 dark:text-amber-400" : "text-sky-600 dark:text-sky-400";
          return (
            <div key={role} className="space-y-[var(--space-xs)]">
              <span className={cn("text-[length:var(--text-2xs)] font-bold uppercase tracking-widest", roleColor)}>
                {role === "kitchen" ? t("roles.kitchen") : t("roles.floor")}
              </span>
              {/* Actuel */}
              <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-xs)] space-y-[2px]">
                <div className="flex items-center justify-between">
                  <span className="text-[length:var(--text-2xs)] font-bold text-muted-foreground/60 uppercase tracking-wide">{t("auto.current")}</span>
                  <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:8px] font-bold", vBefore.bg, vBefore.color)}>{t(`verdict.${baseCap.verdict ?? "balanced"}`)}</span>
                </div>
                <div className="text-[length:var(--text-xs)] tabular-nums">
                  <span className="text-muted-foreground">{t("auto.contract")}</span> <span className="font-bold">{baseCap.totalContractHours}h</span>
                  <span className="text-muted-foreground ml-[var(--space-sm)]">{t("auto.surplus")}</span>{" "}
                  <span className="font-bold">{(baseCap.surplusHours ?? 0) > 0 ? "+" : ""}{baseCap.surplusHours}h</span>
                </div>
                {underBefore > 0 && <span className="text-[length:8px] text-red-600 dark:text-red-400 font-bold">{t("auto.understaffedBadge", { count: underBefore })}</span>}
              </div>
              {/* Arrow */}
              <div className="flex justify-center">
                <ArrowRight className="size-3.5 text-purple-600 dark:text-purple-400 rotate-90" />
              </div>
              {/* Après */}
              <div className={cn("border rounded-[0.2rem] p-[var(--space-xs)] space-y-[2px]", vChanged ? "border-purple-500/30 bg-purple-500/5" : "border-foreground/10")}>
                <div className="flex items-center justify-between">
                  <span className="text-[length:var(--text-2xs)] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wide">{t("auto.after")}</span>
                  <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:8px] font-bold", vAfter.bg, vAfter.color)}>{t(`verdict.${scenCap.verdict ?? "balanced"}`)}</span>
                </div>
                <div className="text-[length:var(--text-xs)] tabular-nums">
                  <span className="text-muted-foreground">{t("auto.contract")}</span> <span className="font-bold">{scenCap.totalContractHours}h</span>
                  <span className="text-muted-foreground ml-[var(--space-sm)]">{t("auto.surplus")}</span>{" "}
                  <span className="font-bold">{(scenCap.surplusHours ?? 0) > 0 ? "+" : ""}{scenCap.surplusHours}h</span>
                  {surplusDelta !== 0 && (
                    <span className={cn(
                      "ml-[var(--space-xs)] text-[length:var(--text-2xs)] font-bold",
                      surplusDelta < 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                    )}>
                      ({surplusDelta > 0 ? "+" : ""}{surplusDelta}h)
                    </span>
                  )}
                </div>
                {underAfter > 0 && <span className="text-[length:8px] text-red-600 dark:text-red-400 font-bold">{t("auto.understaffedBadge", { count: underAfter })}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[length:var(--text-2xs)] text-muted-foreground/50 text-center">
        {t("auto.hoursNote")}
      </p>

      {/* Worker utilization before/after */}
      <WorkerUtilizationComparison baseData={baseData} scenarioData={scenarioData} dept={dept} />

      {/* Remaining actions */}
      {scenarioData.actions && scenarioData.actions.length > 0 && (
        <div className="text-[length:var(--text-2xs)] text-muted-foreground pt-[var(--space-xs)] border-t border-purple-500/10">
          {t("auto.actionsRemainingAfter", { count: scenarioData.actions.length })}
        </div>
      )}
    </div>
  );
}

/* ── HireRecommendationCard ── */

function HireRecommendationCard({ rec }: { rec: HireRecommendation }) {
  const { t } = useTranslation("optimize");
  const isCdi = rec.type === "hire_cdi";
  const money = (cents: number) => `${cents >= 0 ? "+" : ""}${Math.round(cents / 100)}€`;
  return (
    <div className={cn(
      "border rounded-[0.2rem] p-[var(--space-sm)] space-y-[var(--space-xs)]",
      isCdi ? "border-indigo-500/20 bg-indigo-500/5" : "border-sky-500/20 bg-sky-500/5",
    )}>
      <div className="flex items-start gap-[var(--space-sm)]">
        <UserPlus className={cn("size-4 shrink-0 mt-[2px]", isCdi ? "text-indigo-600 dark:text-indigo-400" : "text-sky-600 dark:text-sky-400")} />
        <div className="flex-1 min-w-0 space-y-[2px]">
          <div className="flex items-center gap-[var(--space-xs)]">
            <span className={cn(
              "text-[length:var(--text-xs)] font-bold",
              isCdi ? "text-indigo-600 dark:text-indigo-400" : "text-sky-600 dark:text-sky-400",
            )}>
              {rec.label}
            </span>
            <span className="text-[length:var(--text-2xs)] text-muted-foreground uppercase tracking-widest">
              {rec.role === "kitchen" ? t("roles.kitchen") : t("roles.floor")}
            </span>
          </div>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">{rec.description}</p>
          {(rec.idealProfile || rec.overtimeHoursReducedPerWeek || rec.netLaborSavingsCents !== undefined) && (
            <div className="flex flex-wrap items-center gap-[var(--space-xs)] pt-[2px]">
              {rec.idealProfile && (
                <span className={cn(
                  "inline-flex px-[var(--space-xs)] py-[1px] rounded-full border text-[length:var(--text-2xs)] font-bold",
                  isCdi ? "border-indigo-500/20 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300" : "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                )}>
                  Profil {rec.idealProfile.pattern}
                </span>
              )}
              {rec.overtimeHoursReducedPerWeek !== undefined && rec.overtimeHoursReducedPerWeek > 0 && (
                <span className="inline-flex px-[var(--space-xs)] py-[1px] rounded-full border border-amber-500/20 bg-amber-500/10 text-[length:var(--text-2xs)] font-bold text-amber-700 dark:text-amber-300">
                  -{rec.overtimeHoursReducedPerWeek}h HS/sem.
                </span>
              )}
              {rec.netLaborSavingsCents !== undefined && (
                <span className={cn(
                  "inline-flex px-[var(--space-xs)] py-[1px] rounded-full border text-[length:var(--text-2xs)] font-bold",
                  rec.netLaborSavingsCents >= 0 ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-muted bg-muted/30 text-muted-foreground",
                )}>
                  Solde salarial {money(rec.netLaborSavingsCents)} / {rec.analysisWeeks ?? 12} sem.
                </span>
              )}
            </div>
          )}
          {rec.neededSlots.length > 0 && (
            <div className="flex flex-wrap gap-[var(--space-xs)] pt-[2px]">
              <Calendar className="size-3 text-muted-foreground/60 mt-[1px]" />
              {rec.neededSlots.map((s, i) => (
                <span key={i} className={cn(
                  "inline-flex px-[var(--space-xs)] py-[1px] rounded-full border text-[length:var(--text-2xs)] font-bold",
                  isCdi ? "border-indigo-500/20 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300" : "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                )}>
                  {s.dayLabel} {s.zone}{s.startTime && s.endTime ? ` ${s.startTime}-${s.endTime}` : ""}{s.currentFill !== undefined && s.target !== undefined ? ` · ${s.currentFill}/${s.target}` : ""}{s.subRoles?.length ? ` · ${s.subRoles.slice(0, 2).join(", ")}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── CompoundPlanCard ── */

function CompoundPlanCard({ plan, onApply, dept }: { plan: CompoundPlan; onApply: () => void; dept: "kitchen" | "floor" }) {
  const { t } = useTranslation("optimize");
  const totalSaved = -Object.values(plan.totalImpact.surplusHoursDelta).reduce((s, d) => s + d, 0);
  const isRestructuration = plan.id.startsWith("plan_restructuration");
  return (
    <button
      type="button"
      onClick={onApply}
      className={cn(
        "w-full border rounded-[0.2rem] p-[var(--space-sm)] text-left transition-colors",
        isRestructuration
          ? "border-red-500/30 bg-red-500/5 hover:bg-red-500/10"
          : "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10",
      )}
    >
      <div className="flex items-start justify-between gap-[var(--space-sm)]">
        <div className="flex-1 min-w-0 space-y-[2px]">
          <div className="flex items-center gap-[var(--space-xs)]">
            <Target className={cn("size-4 shrink-0", isRestructuration ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")} />
            <span className={cn("text-[length:var(--text-sm)] font-bold", isRestructuration ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>
              {plan.label}
            </span>
          </div>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">{plan.description}</p>
          <div className="flex flex-wrap items-center gap-[var(--space-sm)] pt-[2px]">
            <span className="text-[length:var(--text-2xs)] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {t("auto.surplusSaved", { hours: totalSaved })}
            </span>
            <span className="text-[length:var(--text-2xs)] text-muted-foreground">
              {t("auto.actionsCount", { count: plan.moveIds.length })}
            </span>
            {plan.totalImpact.affectedWorkers.length > 0 && (
              <span className="text-[length:var(--text-2xs)] text-muted-foreground">
                {t("auto.workersImpacted", { count: plan.totalImpact.affectedWorkers.length })}
              </span>
            )}
          </div>
          {plan.actions && plan.actions.length > 0 && (
            <div className="flex flex-wrap gap-[var(--space-xs)] pt-[2px]">
              {plan.actions.map(action => (
                <span key={action.id} className="inline-flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] rounded-full border border-foreground/10 bg-background/50 text-[length:var(--text-2xs)]">
                  <span className="font-bold">{action.workerName}</span>
                  <span className="text-muted-foreground">
                    {action.type === "terminate"
                      ? "supprimé"
                      : action.type === "remove_restrictions"
                        ? "restriction levée"
                        : action.type === "increase_hours"
                          ? `${action.currentValue}h→${action.proposedValue}h`
                          : action.type === "reduce_to_planned" || action.type === "reduce_contract"
                            ? `${action.currentValue}h→${action.proposedValue}h`
                            : action.label.toLowerCase()}
                  </span>
                </span>
              ))}
            </div>
          )}
          {/* Final state verdict for this department */}
          {plan.finalState?.[dept] && (() => {
            const fs = plan.finalState![dept];
            const v = verdictStyle[fs.verdict] ?? verdictStyle.balanced;
            return (
              <div className="flex flex-wrap gap-[var(--space-xs)] pt-[2px]">
                <span className={cn("inline-flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] rounded-full text-[length:var(--text-2xs)] font-bold", v.bg, v.color)}>
                  {t(`verdict.${fs.verdict}`).toLowerCase()}
                  {fs.surplus !== 0 && <span className="tabular-nums">({fs.surplus > 0 ? "+" : ""}{fs.surplus}h)</span>}
                </span>
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-[var(--space-xs)] shrink-0 pt-[2px]">
          <ChevronRight className="size-4 text-muted-foreground" />
        </div>
      </div>
    </button>
  );
}

function PlanApplicationPreview({ actions, profileId, dept }: { actions: OptimizationRecommendation[]; profileId?: string; dept: "kitchen" | "floor" }) {
  const { t } = useTranslation("optimize");
  const [baseData, setBaseData] = useState<StaffingAnalysis | null>(null);
  const [scenarioData, setScenarioData] = useState<StaffingAnalysis | null>(null);
  const [loading, setLoading] = useState(actions.length > 0);
  const { contractOverrides, maxWeeklyOverrides, restrictionOverrides, roleOverrides } = useMemo(
    () => buildScenarioOverrides(actions),
    [actions],
  );

  useEffect(() => {
    if (actions.length === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const baseRes = await api.getStaffingAnalysis(profileId);
        if (cancelled) return;
        const scenarioRes = await api.getStaffingAnalysis(
          profileId,
          Object.keys(contractOverrides).length > 0 ? contractOverrides : undefined,
          restrictionOverrides.length > 0 ? restrictionOverrides : undefined,
          Object.keys(roleOverrides).length > 0 ? roleOverrides : undefined,
          Object.keys(maxWeeklyOverrides).length > 0 ? maxWeeklyOverrides : undefined,
        );
        if (cancelled) return;
        setBaseData(baseRes.data);
        setScenarioData(scenarioRes.data);
      } catch {
        // Keep the solver-backed plan summary visible even if this preview fails.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [actions.length, profileId, contractOverrides, maxWeeklyOverrides, restrictionOverrides, roleOverrides]);

  if (actions.length === 0) return null;
  if (loading) {
    return (
      <div className="border border-purple-500/20 bg-purple-500/5 rounded-[0.2rem] p-[var(--space-xs)] flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)] text-purple-600 dark:text-purple-400 font-bold">
        <Loader2 className="size-3 animate-spin" />
        {t("auto.planAppliedPreview")}
      </div>
    );
  }
  if (!baseData || !scenarioData) return null;
  return (
    <div className="space-y-[var(--space-xs)]">
      <WorkerUtilizationComparison baseData={baseData} scenarioData={scenarioData} dept={dept} defaultExpanded />
      {scenarioData.actions && scenarioData.actions.length > 0 && (
        <div className="text-[length:var(--text-2xs)] text-muted-foreground pt-[var(--space-xs)] border-t border-purple-500/10">
          {t("auto.actionsRemainingAfter", { count: scenarioData.actions.length })}
        </div>
      )}
    </div>
  );
}

function PlanDetail({ plan, baseline, dept, profileId, onClose }: { plan: CompoundPlan; baseline: NonNullable<AutoOptimizeResult["baseline"]>; dept: "kitchen" | "floor"; profileId?: string; onClose: () => void }) {
  const { t } = useTranslation("optimize");
  const base = baseline[dept];
  const final = plan.finalState?.[dept];
  const contractDelta = plan.totalImpact.surplusHoursDelta[dept] ?? 0;
  const finalContract = base.totalContract + contractDelta;
  const vBefore = verdictStyle[base.verdict ?? "balanced"] ?? verdictStyle.balanced;
  const vAfter = final ? (verdictStyle[final.verdict] ?? verdictStyle.balanced) : verdictStyle.balanced;
  const actions = plan.actions ?? [];
  return (
    <div className="border border-purple-500/30 bg-purple-500/5 rounded-[0.2rem] p-[var(--space-md)] space-y-[var(--space-sm)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--space-sm)]">
          <Target className="size-4 text-purple-600 dark:text-purple-400" />
          <span className="text-[length:var(--text-sm)] font-bold text-purple-600 dark:text-purple-400">
            {plan.label} — détail calculé par l'optimiseur
          </span>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {actions.length > 0 && (
        <div className="space-y-[var(--space-xs)]">
          <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60">Actions du plan</span>
          <div className="flex flex-wrap gap-[var(--space-xs)]">
            {actions.map(action => (
              <span key={action.id} className="inline-flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] rounded-full border border-purple-500/20 bg-purple-500/10 text-[length:var(--text-xs)]">
                <span className="font-bold text-purple-700 dark:text-purple-300">{action.workerName}</span>
                <span className="text-muted-foreground">
                  {action.type === "terminate"
                    ? action.contractType === "CDD" || action.contractType === "saisonnier" ? (action.contractType === "saisonnier" ? t("contractBadge.saisonnierShort") : "CDD") : "CDI supprimé"
                    : action.type === "remove_restrictions"
                      ? t("auto.detailNoRestrictions")
                      : action.type === "increase_hours" || action.type === "reduce_to_planned" || action.type === "reduce_contract"
                        ? `${action.currentValue}h→${action.proposedValue}h`
                        : action.label.toLowerCase()}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-[var(--space-xs)]">
        <span className={cn("text-[length:var(--text-2xs)] font-bold uppercase tracking-widest", dept === "kitchen" ? "text-amber-600 dark:text-amber-400" : "text-sky-600 dark:text-sky-400")}>
          {dept === "kitchen" ? t("roles.kitchen") : t("roles.floor")}
        </span>
        <div className="border border-foreground/10 rounded-[0.2rem] p-[var(--space-xs)] space-y-[2px]">
          <div className="flex items-center justify-between">
            <span className="text-[length:var(--text-2xs)] font-bold text-muted-foreground/60 uppercase tracking-wide">{t("auto.current")}</span>
            <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:8px] font-bold", vBefore.bg, vBefore.color)}>{t(`verdict.${base.verdict ?? "balanced"}`)}</span>
          </div>
          <div className="text-[length:var(--text-xs)] tabular-nums">
            <span className="text-muted-foreground">{t("auto.contract")}</span> <span className="font-bold">{base.totalContract}h</span>
            <span className="text-muted-foreground ml-[var(--space-sm)]">{t("auto.surplus")}</span>{" "}
            <span className="font-bold">{base.surplus > 0 ? "+" : ""}{base.surplus}h</span>
          </div>
          {base.understaffed > 0 && <span className="text-[length:8px] text-red-600 dark:text-red-400 font-bold">{t("auto.understaffedBadge", { count: base.understaffed })}</span>}
        </div>
        <div className="flex justify-center"><ArrowRight className="size-3.5 text-purple-600 dark:text-purple-400 rotate-90" /></div>
        <div className={cn("border rounded-[0.2rem] p-[var(--space-xs)] space-y-[2px]", final ? "border-purple-500/30 bg-purple-500/5" : "border-foreground/10")}>
          <div className="flex items-center justify-between">
            <span className="text-[length:var(--text-2xs)] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wide">{t("auto.after")}</span>
            {final && <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:8px] font-bold", vAfter.bg, vAfter.color)}>{t(`verdict.${final.verdict}`)}</span>}
          </div>
          <div className="text-[length:var(--text-xs)] tabular-nums">
            <span className="text-muted-foreground">{t("auto.contract")}</span> <span className="font-bold">{finalContract}h</span>
            <span className="text-muted-foreground ml-[var(--space-sm)]">{t("auto.surplus")}</span>{" "}
            <span className="font-bold">{final && final.surplus > 0 ? "+" : ""}{final?.surplus ?? 0}h</span>
            {contractDelta !== 0 && (
              <span className={cn("ml-[var(--space-xs)] text-[length:var(--text-2xs)] font-bold", contractDelta < 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                ({contractDelta > 0 ? "+" : ""}{contractDelta}h)
              </span>
            )}
          </div>
          {final && final.understaffed > 0 && <span className="text-[length:8px] text-red-600 dark:text-red-400 font-bold">{t("auto.understaffedBadge", { count: final.understaffed })}</span>}
        </div>
      </div>
      {plan.totalImpact.affectedWorkers.length > 0 && (
        <div className="text-[length:var(--text-2xs)] text-muted-foreground pt-[var(--space-xs)] border-t border-purple-500/10">
          {t("auto.workersImpacted", { count: plan.totalImpact.affectedWorkers.length })} — {t("auto.redistributionTotal", { hours: plan.totalImpact.hoursRedistributed })}
        </div>
      )}

      <PlanApplicationPreview actions={actions} profileId={profileId} dept={dept} />

      <p className="text-[length:var(--text-2xs)] text-muted-foreground/50 text-center">
        Plan recommandé sélectionné automatiquement par le solveur. Les actions cochées ci-dessous correspondent à ce plan.
      </p>
    </div>
  );
}

/* ── Progress bar for long-running CP-SAT optimization ── */

type ProgressInfo = { phase: string; current: number; total: number; label: string };

// French culinary phrases shown during long-running optimization. Kept verbatim
// across locales — they're decorative French flavor that ties the optimizer to
// the kitchen-staffing context. Translating them faithfully would require
// matching culinary vocabulary in each language; treat as an Easter egg.
const KITCHEN_PHRASES = [
  // Mise en place (matin)
  "Allumer les fourneaux…",
  "Aiguiser les couteaux…",
  "Sortir les produits de la chambre froide…",
  "Vérifier les arrivages du marché…",
  "Préparer la mise en place…",
  "Trier les herbes fraîches…",
  "Ranger les épices…",
  "Plier les torchons…",
  // Légumes
  "Éplucher les patates…",
  "Couper les carottes…",
  "Émincer les oignons…",
  "Tailler la brunoise de céleri…",
  "Ciseler la ciboulette…",
  "Hacher le persil plat…",
  "Effeuiller le thym…",
  "Zester le citron…",
  "Presser l'ail…",
  "Peler les tomates…",
  "Équeuter les haricots verts…",
  "Émonder les amandes…",
  // Protéines
  "Désosser le poulet fermier…",
  "Parer la pièce de bœuf…",
  "Lever les filets de bar…",
  "Écailler les huîtres…",
  "Décortiquer les langoustines…",
  "Vider le poisson…",
  "Mariner l'agneau aux herbes…",
  "Battre les œufs…",
  "Saler à la fleur de sel…",
  "Donner un tour de moulin à poivre…",
  // Fonds & bouillons
  "Tamiser la farine…",
  "Confectionner le fond brun…",
  "Préparer le roux…",
  "Infuser les aromates…",
  "Écumer le bouillon…",
  "Filtrer le consommé…",
  // Cuisson
  "Faire fondre le beurre…",
  "Faire revenir l'échalote…",
  "Saisir la viande à feu vif…",
  "Déglacer la poêle au vin blanc…",
  "Flamber au cognac…",
  "Mettre au four…",
  "Cuire les pâtes al dente…",
  "Faire mijoter doucement…",
  "Touiller la marmite…",
  "Pocher le poisson…",
  "Rôtir le canard…",
  "Braiser la joue de bœuf…",
  "Cuire les légumes à la vapeur…",
  "Faire griller le pain…",
  // Sauces
  "Réduire le jus de cuisson…",
  "Monter la sauce au beurre…",
  "Lier à la crème fraîche…",
  "Émulsionner la vinaigrette…",
  "Goûter la sauce…",
  "Ajouter une pincée de sel…",
  "Rectifier l'assaisonnement…",
  "Passer la sauce au chinois…",
  // Pâtisserie
  "Pétrir la pâte à pain…",
  "Crémer le beurre et le sucre…",
  "Tamiser le sucre glace…",
  "Monter les blancs en neige…",
  "Battre la crème chantilly…",
  "Caraméliser le sucre…",
  "Glacer le gâteau…",
  "Sortir les viennoiseries du four…",
  "Démouler les financiers…",
  "Saupoudrer de cacao amer…",
  // Dressage
  "Dresser les assiettes…",
  "Verser la sauce miroir…",
  "Râper le parmesan…",
  "Parsemer de fleur de sel…",
  "Garnir d'herbes fraîches…",
  "Déposer les pétales comestibles…",
  "Ajouter un trait d'huile d'olive…",
  "Tracer le coulis à la cuillère…",
  "Donner la touche finale…",
  // Service
  "Polir les verres…",
  "Plier les serviettes…",
  "Mettre le couvert…",
  "Décanter le vin…",
  "Annoncer la commande !",
  "Sortir le plat du passe…",
  "Vérifier la chaleur de l'assiette…",
  "Envoyer en salle !",
  "Service chaud !",
  "Bon appétit !",
  // Fin de service
  "Débarrasser les tables…",
  "Nettoyer le piano…",
  "Ranger la batterie de cuisine…",
  "Éteindre les fourneaux…",
];

function OptimizeProgressBar({ progress }: { progress: ProgressInfo }) {
  const { t } = useTranslation("optimize");
  const [smoothPct, setSmoothPct] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [phraseIdx, setPhraseIdx] = useState(0);
  const startRef = useRef<number | null>(null);

  // Phase-aware target: screening/compound use solver counter, other phases use fixed milestones
  const targetPct = progress.phase === "baseline" ? 5
    : progress.phase === "screening" ? 10 + Math.round((progress.current / Math.max(1, progress.total)) * 55)
    : progress.phase === "compound" ? 70 + Math.round((progress.current / Math.max(1, progress.total)) * 20)
    : progress.phase === "hire" ? 92
    : progress.phase === "finalize" ? 97
    : Math.round((progress.current / Math.max(1, progress.total)) * 100);

  useEffect(() => {
    const id = setInterval(() => {
      setSmoothPct(prev => {
        const diff = targetPct - prev;
        if (Math.abs(diff) < 0.3) return targetPct;
        return prev + diff * 0.12;
      });
      if (startRef.current === null) startRef.current = Date.now();
      setElapsed(Math.round((Date.now() - startRef.current) / 1000));
    }, 80);
    return () => clearInterval(id);
  }, [targetPct]);

  useEffect(() => {
    const id = setInterval(() => {
      setPhraseIdx(i => (i + 1) % KITCHEN_PHRASES.length);
    }, 2500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="border border-dashed border-foreground/15 rounded-[0.2rem] p-[var(--space-lg)] space-y-[var(--space-sm)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--space-sm)]">
          <Loader2 className="size-4 text-muted-foreground/50 animate-spin" />
          <span className="text-[length:var(--text-xs)] font-bold text-foreground">
            {t("auto.progressTitle")}
          </span>
        </div>
        <span className="text-[length:var(--text-2xs)] text-muted-foreground tabular-nums">
          {elapsed}s
        </span>
      </div>
      <div className="h-[6px] rounded-full bg-foreground/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-purple-500 transition-[width] duration-300 ease-out"
          style={{ width: `${Math.round(smoothPct)}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        <p
          key={phraseIdx}
          className="text-[length:var(--text-xs)] text-muted-foreground italic transition-opacity duration-500"
        >
          {KITCHEN_PHRASES[phraseIdx]}
        </p>
        <span className="text-[length:var(--text-xs)] font-bold tabular-nums text-muted-foreground">
          {Math.round(smoothPct)}%
        </span>
      </div>
    </div>
  );
}

/* ── LeverSelector ── */

function LeverSelector({ value, onChange }: { value: Set<Lever>; onChange: (v: Set<Lever>) => void }) {
  const { t } = useTranslation("optimize");
  const toggle = (lever: Lever) => {
    const next = new Set(value);
    if (next.has(lever)) next.delete(lever); else next.add(lever);
    onChange(next);
  };
  return (
    <div className="space-y-[var(--space-xs)]">
      <div className="flex items-baseline justify-between">
        <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60">
          {t("auto.leversAllowed")}
        </span>
        <span className="text-[length:var(--text-2xs)] text-muted-foreground/50">
          {t("auto.leversNote")}
        </span>
      </div>
      <div className="flex flex-wrap gap-[var(--space-xs)]">
        {LEVER_ORDER.map(({ id, icon: Icon }) => {
          const active = value.has(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              className={cn(
                "inline-flex items-center gap-[4px] px-[var(--space-sm)] py-[3px] rounded-[0.2rem] border text-[length:var(--text-xs)] font-bold transition-colors",
                active
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted-foreground border-foreground/20 hover:border-foreground/40",
              )}
            >
              <Icon className="size-3" />
              {t(`auto.levers.${id}.label`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── DepartmentColumn ── */

function DepartmentColumn({ dept, levers, onLeversChange, result, loading, progress, error, selected, inspectedPlan, profileId, onToggle, onSelectAll, onClearSelection, onInspectPlan, onClearPlan, onRun }: {
  dept: "kitchen" | "floor";
  levers: Set<Lever>;
  onLeversChange: (v: Set<Lever>) => void;
  result: DeptResult | null;
  loading: boolean;
  progress: ProgressInfo;
  error: string | null;
  selected: Set<string>;
  inspectedPlan: CompoundPlan | null;
  profileId?: string;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onInspectPlan: (plan: CompoundPlan) => void;
  onClearPlan: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation("optimize");
  const deptLabel = dept === "kitchen" ? t("roles.kitchen") : t("roles.floor");
  const borderColor = dept === "kitchen" ? "border-amber-500/30" : "border-sky-500/30";
  const titleColor = dept === "kitchen" ? "text-amber-600 dark:text-amber-400" : "text-sky-600 dark:text-sky-400";
  const data = result?.data ?? null;
  const selectableRecommendations = data
    ? Array.from(new Map([...data.recommendations, ...data.compounds.flatMap(p => p.actions ?? [])].map(r => [r.id, r])).values())
    : [];
  const selectedRecs = selectableRecommendations.filter(r => selected.has(r.id));

  return (
    <div className={cn("rounded-[0.2rem] border p-[var(--space-sm)] space-y-[var(--space-sm)]", borderColor)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className={cn("text-[length:var(--text-sm)] font-bold uppercase tracking-widest", titleColor)}>
          {deptLabel}
        </span>
        {result && (
          <span className="text-[length:var(--text-2xs)] text-muted-foreground">{formatTimeAgo(result.ranAt, t)}</span>
        )}
      </div>

      {/* Levers */}
      <LeverSelector value={levers} onChange={onLeversChange} />

      {/* Run button */}
      <button
        type="button"
        onClick={onRun}
        disabled={loading || levers.size === 0}
        className={cn(
          "w-full inline-flex items-center justify-center gap-[var(--space-xs)] px-[var(--space-sm)] py-[var(--space-xs)] rounded-[0.2rem] text-[length:var(--text-xs)] font-bold tracking-wide transition-colors",
          loading
            ? "bg-foreground/10 text-muted-foreground"
            : "bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50",
        )}
      >
        {loading ? (
          <><RefreshCw className="size-3 animate-spin" /> {t("auto.running")}</>
        ) : (
          <><Zap className="size-3" /> {result ? t("auto.rerun") : t("auto.optimize")}</>
        )}
      </button>

      {/* Progress */}
      {loading && <OptimizeProgressBar progress={progress} />}

      {/* Error */}
      {error && (
        <div className="border border-red-500/30 bg-red-500/5 rounded-[0.2rem] p-[var(--space-xs)]">
          <p className="text-[length:var(--text-2xs)] text-red-600 dark:text-red-400 font-bold">{error}</p>
        </div>
      )}

      {/* Results */}
      {data && !loading && (
        <>
          {/* Best compound plan */}
          {data.compounds && data.compounds.length > 0 && selectedRecs.length === 0 && !inspectedPlan && (
            <div className="space-y-[var(--space-xs)]">
              <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60">
                {t("auto.optimizationPlan")}
              </span>
              {data.compounds.map(plan => (
                <CompoundPlanCard key={plan.id} plan={plan} onApply={() => onInspectPlan(plan)} dept={dept} />
              ))}
            </div>
          )}

          {/* Hire recommendations */}
          {data.hireRecommendations && data.hireRecommendations.length > 0 && (
            <div className="space-y-[var(--space-xs)]">
              <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60">
                {t("auto.hireRecommended")}
              </span>
              {data.hireRecommendations.map(hr => (
                <HireRecommendationCard key={hr.id} rec={hr} />
              ))}
            </div>
          )}

          {/* Authoritative compound-plan detail */}
          {inspectedPlan && data.baseline && (
            <PlanDetail plan={inspectedPlan} baseline={data.baseline} dept={dept} profileId={profileId} onClose={onClearPlan} />
          )}

          {/* Scenario comparison for manually selected standalone recommendations */}
          {selectedRecs.length > 0 && data.baseline && !inspectedPlan && (
            <ScenarioComparison
              baseline={data.baseline}
              recommendations={selectedRecs}
              onClose={onClearSelection}
              dept={dept}
              profileId={profileId}
            />
          )}

          {/* Recommendations list */}
          {data.recommendations.length > 0 ? (
            <div className="space-y-[var(--space-xs)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-[var(--space-xs)]">
                  <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground">
                    {t("auto.recommendationsCount", { count: data.recommendations.length })}
                  </span>
                  {selected.size > 0 && (
                    <span className="text-[length:var(--text-2xs)] text-purple-600 dark:text-purple-400 font-bold">
                      {t("auto.selectedShort", { count: selected.size })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-[var(--space-xs)]">
                  {selected.size > 0 ? (
                    <button type="button" onClick={onClearSelection} className="text-[length:var(--text-2xs)] text-muted-foreground hover:text-foreground underline underline-offset-2">
                      {t("auto.deselect")}
                    </button>
                  ) : (
                    <button type="button" onClick={onSelectAll} className="text-[length:var(--text-2xs)] text-muted-foreground hover:text-foreground underline underline-offset-2">
                      {t("auto.selectAll")}
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-[var(--space-xs)]">
                {data.recommendations.map((rec, i) => (
                  <RecommendationCard
                    key={rec.id}
                    rec={rec}
                    index={i}
                    selected={selected.has(rec.id)}
                    onToggle={() => onToggle(rec.id)}
                  />
                ))}
              </div>
              {data.baseline && (
                <span className="text-[length:var(--text-2xs)] text-muted-foreground block text-right">
                  {t("auto.scenariosTested", { count: data.baseline.scenariosRun })}
                </span>
              )}
            </div>
          ) : !data.hireRecommendations?.length && !data.otPolicyRecommendations?.length ? (
            <div className="border border-dashed border-emerald-500/20 bg-emerald-500/5 rounded-[0.2rem] p-[var(--space-xs)] text-center">
              <p className="text-[length:var(--text-2xs)] font-bold text-emerald-600 dark:text-emerald-400">
                {t("auto.optimalConfig")}
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function formatTimeAgo(date: Date, t: (key: string, opts?: { n: number }) => string): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t("auto.timeAgoNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("auto.timeAgoMin", { n: minutes });
  const hours = Math.round(minutes / 60);
  return t("auto.timeAgoHour", { n: hours });
}

/* ── Main component ── */

type DeptResult = { data: AutoOptimizeResult; ranAt: Date };
const DEFAULT_LEVERS = new Set<Lever>(["reduce", "increase", "terminate", "intra_train", "remove_restrictions"]);

export function AutoOptimizeTab() {
  const { t } = useTranslation("optimize");
  const [kitchenResult, setKitchenResult] = useState<DeptResult | null>(null);
  const [salleResult, setSalleResult] = useState<DeptResult | null>(null);
  const [initialBaseline, setInitialBaseline] = useState<CapacitySummary[] | null>(null);
  const [loadingDept, setLoadingDept] = useState<"kitchen" | "floor" | null>(null);
  const [profileId, setProfileId] = useState<string | undefined>();
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [kitchenLevers, setKitchenLevers] = useState<Set<Lever>>(new Set(DEFAULT_LEVERS));
  const [salleLevers, setSalleLevers] = useState<Set<Lever>>(new Set(DEFAULT_LEVERS));
  const [kitchenError, setKitchenError] = useState<string | null>(null);
  const [salleError, setSalleError] = useState<string | null>(null);
  const [kitchenSelected, setKitchenSelected] = useState<Set<string>>(new Set());
  const [salleSelected, setSalleSelected] = useState<Set<string>>(new Set());
  const [kitchenInspectedPlan, setKitchenInspectedPlan] = useState<CompoundPlan | null>(null);
  const [salleInspectedPlan, setSalleInspectedPlan] = useState<CompoundPlan | null>(null);
  const [progress, setProgress] = useState<ProgressInfo>({ phase: "baseline", current: 0, total: DEFAULT_OPTIMIZE_SOLVER_BUDGET, label: "" });
  const eventSourceRef = useRef<EventSource | null>(null);
  const gotResultRef = useRef(false);

  const toggleSelection = useCallback((dept: "kitchen" | "floor", id: string) => {
    const setter = dept === "kitchen" ? setKitchenSelected : setSalleSelected;
    const setPlan = dept === "kitchen" ? setKitchenInspectedPlan : setSalleInspectedPlan;
    setPlan(null);
    setter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const runDept = useCallback((dept: "kitchen" | "floor") => {
    eventSourceRef.current?.close();

    const levers = dept === "kitchen" ? kitchenLevers : salleLevers;
    const setResult = dept === "kitchen" ? setKitchenResult : setSalleResult;
    const setError = dept === "kitchen" ? setKitchenError : setSalleError;
    const setSelected = dept === "kitchen" ? setKitchenSelected : setSalleSelected;
    const setPlan = dept === "kitchen" ? setKitchenInspectedPlan : setSalleInspectedPlan;

    setLoadingDept(dept);
    setError(null);
    setSelected(new Set());
    setPlan(null);
    setProgress({ phase: "baseline", current: 0, total: DEFAULT_OPTIMIZE_SOLVER_BUDGET, label: "" });
    gotResultRef.current = false;

    const params = new URLSearchParams();
    if (profileId) params.set("profileId", profileId);
    if (levers.size > 0) params.set("levers", [...levers].join(","));
    params.set("roleFilter", dept);
    params.set("stream", "1");

    const es = new EventSource(`/api/settings/auto-optimize?${params}`);
    eventSourceRef.current = es;

    es.addEventListener("progress", (e) => {
      try { setProgress(JSON.parse(e.data)); } catch {
        // Ignore malformed progress frames.
      }
    });

    es.addEventListener("result", (e) => {
      gotResultRef.current = true;
      try {
        const parsed = JSON.parse(e.data);
        setResult({ data: parsed.data, ranAt: new Date() });
      } catch {
        setError(t("auto.errors.parseResult"));
      }
      setLoadingDept(null);
      es.close();
    });

    es.onerror = () => {
      if (gotResultRef.current) return;
      setError(t("auto.errors.connectionLost"));
      setLoadingDept(null);
      es.close();
    };
  }, [profileId, kitchenLevers, salleLevers, t]);

  // Fetch baseline on mount + when profile changes
  useEffect(() => {
    api.getStaffingAnalysis(profileId).then(res => {
      setInitialBaseline(res.data.capacity);
      setProfiles(res.data.profiles);
    }).catch(() => {});
  }, [profileId]);

  const handleProfileChange = useCallback((id: string | undefined) => {
    setProfileId(id);
    setKitchenResult(null);
    setSalleResult(null);
    setKitchenSelected(new Set());
    setSalleSelected(new Set());
    setKitchenInspectedPlan(null);
    setSalleInspectedPlan(null);
    setKitchenError(null);
    setSalleError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => eventSourceRef.current?.close(), []);

  return (
    <div className="space-y-[var(--space-md)]">
      {/* Shared controls */}
      <div className="flex items-center gap-[var(--space-md)]">
        {profiles.length > 1 && (
          <div className="flex items-center gap-[var(--space-xs)]">
            <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground">{t("auto.objective")}</span>
            <select
              value={profileId ?? ""}
              onChange={(e) => handleProfileChange(e.target.value || undefined)}
              disabled={loadingDept !== null}
              className="text-[length:var(--text-xs)] tracking-wide font-bold bg-transparent border border-foreground/20 rounded-[0.2rem] px-[var(--space-sm)] py-[2px] text-foreground disabled:opacity-50"
            >
              <option value="">{t("auto.planned")}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name || t("manual.defaultProfile")}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Baseline */}
      {initialBaseline && <BaselineSummary capacity={initialBaseline} />}

      {/* Two-column layout */}
      <div className="grid grid-cols-2 gap-[var(--space-sm)]">
        <DepartmentColumn
          dept="kitchen"
          levers={kitchenLevers}
          onLeversChange={setKitchenLevers}
          result={kitchenResult}
          loading={loadingDept === "kitchen"}
          progress={progress}
          error={kitchenError}
          selected={kitchenSelected}
          inspectedPlan={kitchenInspectedPlan}
          profileId={profileId}
          onToggle={(id) => toggleSelection("kitchen", id)}
          onSelectAll={() => { setKitchenInspectedPlan(null); if (kitchenResult) setKitchenSelected(new Set(kitchenResult.data.recommendations.map(r => r.id))); }}
          onClearSelection={() => setKitchenSelected(new Set())}
          onInspectPlan={(plan) => { setKitchenSelected(new Set([...(plan.actions?.map(a => a.id) ?? []), ...plan.moveIds])); setKitchenInspectedPlan(plan); }}
          onClearPlan={() => setKitchenInspectedPlan(null)}
          onRun={() => runDept("kitchen")}
        />
        <DepartmentColumn
          dept="floor"
          levers={salleLevers}
          onLeversChange={setSalleLevers}
          result={salleResult}
          loading={loadingDept === "floor"}
          progress={progress}
          error={salleError}
          selected={salleSelected}
          inspectedPlan={salleInspectedPlan}
          profileId={profileId}
          onToggle={(id) => toggleSelection("floor", id)}
          onSelectAll={() => { setSalleInspectedPlan(null); if (salleResult) setSalleSelected(new Set(salleResult.data.recommendations.map(r => r.id))); }}
          onClearSelection={() => setSalleSelected(new Set())}
          onInspectPlan={(plan) => { setSalleSelected(new Set([...(plan.actions?.map(a => a.id) ?? []), ...plan.moveIds])); setSalleInspectedPlan(plan); }}
          onClearPlan={() => setSalleInspectedPlan(null)}
          onRun={() => runDept("floor")}
        />
      </div>
    </div>
  );
}
