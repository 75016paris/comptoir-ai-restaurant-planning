import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type StaffingAnalysis, type WorkerLoad, type CapacitySummary, type StaffingAction } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FlaskConical, RotateCcw, ChevronDown, ChevronRight, Ban, UserMinus, Clock, UserPlus, CalendarClock, Wrench, Star, Info } from "lucide-react";

/* ── Shared configs ── */

const verdictKeys: Record<string, { color: string; bg: string; border: string; barColor: string }> = {
  oversized: { color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/15", border: "border-blue-500/30 bg-blue-500/5", barColor: "bg-blue-500" },
  undersized: { color: "text-red-600 dark:text-red-400", bg: "bg-red-500/15", border: "border-red-500/30 bg-red-500/5", barColor: "bg-red-500" },
  tight: { color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/15", border: "border-amber-500/30 bg-amber-500/5", barColor: "bg-amber-500" },
  balanced: { color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/15", border: "border-emerald-500/30 bg-emerald-500/5", barColor: "bg-emerald-500" },
};

const actionConfigStyle: Record<StaffingAction["type"], { icon: typeof UserMinus; color: string; bg: string }> = {
  terminate: { icon: UserMinus, color: "text-red-600 dark:text-red-400", bg: "bg-red-500/10 border-red-500/20" },
  reduce_hours: { icon: Clock, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
  check_restrictions: { icon: Ban, color: "text-orange-600 dark:text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  missing_subrole: { icon: Wrench, color: "text-purple-600 dark:text-purple-400", bg: "bg-purple-500/10 border-purple-500/20" },
  hire: { icon: UserPlus, color: "text-red-600 dark:text-red-400", bg: "bg-red-500/10 border-red-500/20" },
  convert_seasonal: { icon: CalendarClock, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
  key_dependency: { icon: Star, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
};

const priorityIndicator: Record<StaffingAction["priority"], string> = { high: "bg-red-500", medium: "bg-amber-500", low: "bg-blue-500" };

const contractBadgeStyle: Record<string, string> = {
  CDI: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  CDD: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25",
  saisonnier: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/25",
};

/* ── Small helpers ── */

function ContractBadge({ type }: { type: string | null | undefined }) {
  const { t } = useTranslation("optimize");
  if (!type) return null;
  const label = type === "saisonnier" ? t("contractBadge.saisonnierShort") : type;
  return <span className={cn("px-1 py-0 rounded-full text-[length:9px] font-medium border", contractBadgeStyle[type] || "bg-foreground/5 text-muted-foreground border-foreground/10")}>{label}</span>;
}

function canUseEmploymentActions(worker: WorkerLoad) {
  return worker.employmentActionEligible !== false;
}

/* ── Worker row for simulation panel ── */

function WorkerSimRow({ w, override, restrictionOverride, onContractChange, onRestrictionToggle }: {
  w: WorkerLoad;
  override?: number;
  restrictionOverride: boolean;
  onContractChange: (id: string, hours: number | undefined) => void;
  onRestrictionToggle: (id: string) => void;
}) {
  const { t } = useTranslation("optimize");
  const contractH = w.contractHours ?? 35;
  const simH = override ?? contractH;
  const utilPct = contractH > 0 ? Math.round((w.maxWeeklyHours! / contractH) * 100) : 0;
  const isModified = override !== undefined || restrictionOverride;

  return (
    <div className={cn(
      "flex items-center gap-[var(--space-sm)] px-[var(--space-sm)] py-[var(--space-xs)] rounded-[0.2rem] text-[length:var(--text-xs)]",
      isModified ? "bg-purple-500/5 border border-purple-500/20" : "border border-transparent hover:bg-foreground/[0.02]",
    )}>
      {/* Name + contract badge */}
      <div className="flex items-center gap-[var(--space-xs)] min-w-[140px]">
        <Link to={`/staff/${w.workerId}`} className="font-bold underline underline-offset-2 decoration-foreground/25 hover:decoration-foreground/60 truncate max-w-[120px]">
          {w.workerName}
        </Link>
        <ContractBadge type={w.contractType} />
      </div>

      {/* Current utilization */}
      <div className="w-[80px] shrink-0 text-right tabular-nums text-muted-foreground">
        {w.maxWeeklyHours ?? 0}h/{contractH}h
      </div>
      <div className="w-[40px] shrink-0 text-right tabular-nums font-bold">
        {utilPct}%
      </div>

      {/* Contract hours slider */}
      <div className="flex items-center gap-[var(--space-xs)] flex-1 min-w-[160px]">
        <input
          type="range"
          min={0}
          max={Math.max(contractH, 48)}
          step={1}
          value={simH}
          onChange={(e) => {
            const val = Number(e.target.value);
            onContractChange(w.workerId, val === contractH ? undefined : val);
          }}
          className="flex-1 h-[4px] accent-purple-500"
        />
        <input
          type="number"
          min={0}
          max={48}
          step={1}
          value={simH}
          onChange={(e) => {
            const val = Math.max(0, Number(e.target.value));
            onContractChange(w.workerId, val === contractH ? undefined : val);
          }}
          className="w-[42px] text-center font-bold bg-foreground/5 border border-foreground/15 rounded-[0.2rem] px-1 py-0 text-[length:var(--text-xs)]"
        />
        <span className="text-muted-foreground shrink-0">h</span>
      </div>

      {/* Restriction toggle */}
      <button
        type="button"
        onClick={() => onRestrictionToggle(w.workerId)}
        className={cn(
          "shrink-0 px-[var(--space-xs)] py-[1px] rounded-full border text-[length:var(--text-2xs)] font-medium transition-colors",
          restrictionOverride
            ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "border-foreground/10 bg-transparent text-muted-foreground/50 hover:text-muted-foreground hover:border-foreground/20",
        )}
        title={restrictionOverride ? t("manual.restrictionTitle.off") : t("manual.restrictionTitle.on")}
      >
        <Ban className="size-3 inline-block" />
      </button>
    </div>
  );
}

/* ── Diff card showing before → after for a role ── */

function RoleDiffCard({ role, baseCap, simCap, baseSlots, simSlots }: {
  role: "kitchen" | "floor";
  baseCap: CapacitySummary;
  simCap: CapacitySummary;
  baseSlots: StaffingAnalysis["slots"];
  simSlots: StaffingAnalysis["slots"];
}) {
  const { t } = useTranslation("optimize");
  const label = role === "kitchen" ? t("roles.kitchenUpper") : t("roles.floorUpper");
  const bV = verdictKeys[baseCap.verdict ?? "balanced"];
  const aV = verdictKeys[simCap.verdict ?? "balanced"];
  const vChanged = baseCap.verdict !== simCap.verdict;
  const sChanged = baseCap.surplusHours !== simCap.surplusHours;
  const bUnder = baseSlots.filter(s => s.role === role && s.status === "understaffed").length;
  const aUnder = simSlots.filter(s => s.role === role && s.status === "understaffed").length;

  if (!vChanged && !sChanged && bUnder === aUnder) return null;

  return (
    <div className={cn("border rounded-[0.2rem] p-[var(--space-sm)] space-y-[var(--space-xs)]", aV.border)}>
      <span className="text-[length:var(--text-xs)] font-bold tracking-wide">{label}</span>
      <div className="flex flex-wrap items-center gap-[var(--space-xs)] text-[length:var(--text-xs)]">
        {vChanged && (
          <span className="flex items-center gap-[3px]">
            <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:var(--text-2xs)] font-bold", bV.bg, bV.color)}>{t(`verdict.${baseCap.verdict ?? "balanced"}`)}</span>
            <span className="text-muted-foreground">→</span>
            <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:var(--text-2xs)] font-bold", aV.bg, aV.color)}>{t(`verdict.${simCap.verdict ?? "balanced"}`)}</span>
          </span>
        )}
        {sChanged && (
          <span className="text-muted-foreground tabular-nums">
            {baseCap.surplusHours! > 0 ? "+" : ""}{baseCap.surplusHours}h → {simCap.surplusHours! > 0 ? "+" : ""}{simCap.surplusHours}h
          </span>
        )}
        {aUnder !== bUnder && (
          <span className={aUnder > bUnder ? "text-red-600 dark:text-red-400 font-bold" : "text-emerald-600 dark:text-emerald-400 font-bold"}>
            {t("manual.results.underStaffed", { from: bUnder, to: aUnder })}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Worker loads diff table ── */

function WorkerLoadsDiff({ baseLoads, simLoads }: { baseLoads: WorkerLoad[]; simLoads: WorkerLoad[] }) {
  const { t } = useTranslation("optimize");
  const changes = simLoads
    .map(sw => {
      const bw = baseLoads.find(b => b.workerId === sw.workerId);
      if (!bw) return null;
      const bH = bw.maxWeeklyHours ?? 0;
      const sH = sw.maxWeeklyHours ?? 0;
      const bS = bw.maxServices ?? 0;
      const sS = sw.maxServices ?? 0;
      if (bH === sH && bS === sS) return null;
      return { ...sw, baseHours: bH, simHours: sH, baseServices: bS, simServices: sS };
    })
    .filter(Boolean) as Array<WorkerLoad & { baseHours: number; simHours: number; baseServices: number; simServices: number }>;

  if (changes.length === 0) return null;

  return (
    <div className="space-y-[var(--space-xs)]">
      <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">
        {t("manual.results.redistribution", { count: changes.length })}
      </span>
      <div className="space-y-[2px]">
        {changes.sort((a, b) => (b.simHours - b.baseHours) - (a.simHours - a.baseHours)).map(c => {
          const delta = c.simHours - c.baseHours;
          return (
            <div key={c.workerId} className="flex items-center gap-[var(--space-sm)] text-[length:var(--text-xs)] px-[var(--space-xs)]">
              <Link to={`/staff/${c.workerId}`} className="font-bold underline underline-offset-2 decoration-foreground/25 hover:decoration-foreground/60 w-[120px] truncate">
                {c.workerName}
              </Link>
              <span className="text-muted-foreground tabular-nums w-[60px] text-right">{c.baseHours}h</span>
              <span className="text-muted-foreground">→</span>
              <span className="font-bold tabular-nums w-[60px]">{c.simHours}h</span>
              <span className={cn(
                "text-[length:var(--text-2xs)] font-bold tabular-nums",
                delta > 0 ? "text-emerald-600 dark:text-emerald-400" : delta < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
              )}>
                {delta > 0 ? "+" : ""}{delta}h
              </span>
              <span className="text-muted-foreground tabular-nums text-[length:var(--text-2xs)]">
                {t("manual.results.svcs", { from: c.baseServices, to: c.simServices })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Simulation results panel ── */

function SimulationResults({ base, sim }: { base: StaffingAnalysis; sim: StaffingAnalysis }) {
  const { t } = useTranslation("optimize");
  return (
    <div className="space-y-[var(--space-md)]">
      <div className="flex items-center gap-[var(--space-sm)]">
        <FlaskConical className="size-4 text-purple-600 dark:text-purple-400" />
        <span className="text-[length:var(--text-sm)] font-bold text-purple-600 dark:text-purple-400">{t("manual.results.title")}</span>
      </div>

      {/* Role diff cards */}
      <div className="grid grid-cols-2 gap-[var(--space-sm)]">
        {(["kitchen", "floor"] as const).map(role => {
          const bCap = base.capacity.find(c => c.role === role);
          const sCap = sim.capacity.find(c => c.role === role);
          if (!bCap || !sCap) return null;
          return <RoleDiffCard key={role} role={role} baseCap={bCap} simCap={sCap} baseSlots={base.slots} simSlots={sim.slots} />;
        })}
      </div>

      {/* Worker loads redistribution */}
      <WorkerLoadsDiff baseLoads={base.workerLoads} simLoads={sim.workerLoads} />

      {/* Remaining actions */}
      {sim.actions && sim.actions.length > 0 && (
        <SimActions actions={sim.actions} />
      )}

      {/* Clarification */}
      <div className="text-[length:var(--text-2xs)] text-muted-foreground/70 leading-relaxed border-t border-border/30 pt-[var(--space-xs)]">
        <p className="font-medium text-muted-foreground/90 mb-[2px] flex items-center gap-[3px]">
          <Info className="size-3" /> {t("manual.results.howToReadTitle")}
        </p>
        <ul className="list-disc pl-4 space-y-[1px]">
          <li>{t("manual.results.howToReadBullet1")}</li>
          <li>{t("manual.results.howToReadBullet2")}</li>
          <li>{t("manual.results.howToReadBullet3")}</li>
          <li>{t("manual.results.howToReadBullet4")}</li>
        </ul>
      </div>
    </div>
  );
}

/* ── Simplified actions display ── */

function SimActions({ actions }: { actions: StaffingAction[] }) {
  const { t } = useTranslation("optimize");
  const kitchenActions = actions.filter(a => a.role === "kitchen");
  const salleActions = actions.filter(a => a.role === "floor");
  const groups = [
    { key: "kitchen", label: t("roles.kitchen"), actions: kitchenActions },
    { key: "floor", label: t("roles.floor"), actions: salleActions },
  ].filter(g => g.actions.length > 0);

  return (
    <div className="space-y-[var(--space-xs)]">
      <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">
        {t("manual.results.remainingActions")}
      </span>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-sm)]">
        {groups.map(group => (
          <div key={group.key} className="space-y-[var(--space-xs)]">
            <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60">
              {group.label} — {group.actions.length}
            </span>
            {group.actions.map((action, i) => {
              const cfg = actionConfigStyle[action.type];
              const Icon = cfg.icon;
              return (
                <div key={i} className={cn("border rounded-[0.2rem] px-[var(--space-sm)] py-[var(--space-xs)]", cfg.bg)}>
                  <div className="flex items-start gap-[var(--space-xs)]">
                    <div className="flex items-center gap-[var(--space-xs)] shrink-0 mt-[1px]">
                      <span className={cn("inline-block w-[5px] h-[5px] rounded-full", priorityIndicator[action.priority])} />
                      <Icon className={cn("size-3", cfg.color)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className={cn("text-[length:var(--text-2xs)] uppercase tracking-widest font-bold", cfg.color)}>
                        {t(`actionTypes.${action.type}`)}
                      </span>
                      {action.workerNames && (
                        <div className="flex flex-wrap gap-[var(--space-xs)] mt-[1px]">
                          {action.workerNames.map((name, j) => (
                            <span key={j} className="text-[length:var(--text-xs)] font-bold">{name}</span>
                          ))}
                        </div>
                      )}
                      <p className="text-[length:var(--text-xs)] text-muted-foreground leading-relaxed">{action.message}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Main component ── */

export function ManualSimulationTab() {
  const { t } = useTranslation("optimize");
  const [baseData, setBaseData] = useState<StaffingAnalysis | null>(null);
  const [simData, setSimData] = useState<StaffingAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState(false);
  const [profileId, setProfileId] = useState<string | undefined>();

  // Simulation overrides
  const [contractOverrides, setContractOverrides] = useState<Record<string, number>>({});
  const [restrictionOverrides, setRestrictionOverrides] = useState<string[]>([]);

  // Section expand
  const [showKitchen, setShowKitchen] = useState(true);
  const [showSalle, setShowSalle] = useState(true);

  const hasOverrides = Object.keys(contractOverrides).length > 0 || restrictionOverrides.length > 0;

  // Fetch baseline
  const fetchBaseline = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getStaffingAnalysis(profileId);
      setBaseData(res.data);
    } catch {
      setBaseData(null);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => { fetchBaseline(); }, [fetchBaseline]);

  // Run simulation when overrides change
  useEffect(() => {
    if (!hasOverrides) {
      setSimData(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setSimulating(true);
      try {
        const contractOv = Object.keys(contractOverrides).length > 0 ? contractOverrides : undefined;
        const restrictOv = restrictionOverrides.length > 0 ? restrictionOverrides : undefined;
        const res = await api.getStaffingAnalysis(profileId, contractOv, restrictOv);
        if (!cancelled) setSimData(res.data);
      } catch {
        if (!cancelled) setSimData(null);
      } finally {
        if (!cancelled) setSimulating(false);
      }
    };

    // Debounce simulation calls
    const timer = setTimeout(run, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [contractOverrides, restrictionOverrides, profileId, hasOverrides]);

  const handleContractChange = useCallback((workerId: string, hours: number | undefined) => {
    setContractOverrides(prev => {
      if (hours === undefined) {
        const next = { ...prev };
        delete next[workerId];
        return next;
      }
      return { ...prev, [workerId]: hours };
    });
  }, []);

  const handleRestrictionToggle = useCallback((workerId: string) => {
    setRestrictionOverrides(prev =>
      prev.includes(workerId) ? prev.filter(id => id !== workerId) : [...prev, workerId]
    );
  }, []);

  const clearAll = useCallback(() => {
    setContractOverrides({});
    setRestrictionOverrides([]);
    setSimData(null);
  }, []);

  if (loading) {
    return <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("manual.loading")}</p>;
  }

  if (!baseData) {
    return <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("manual.loadError")}</p>;
  }

  const hasTargets = baseData.slots.some(s => s.target > 0);
  if (!hasTargets) {
    return (
      <div className="border border-dashed border-foreground/15 rounded-[0.2rem] p-[var(--space-md)] text-center space-y-[var(--space-xs)]">
        <p className="text-[length:var(--text-sm)] font-bold tracking-wide">{t("manual.noTargetsTitle")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("manual.noTargetsBody")}
        </p>
      </div>
    );
  }

  const employmentActionWorkers = baseData.workerLoads.filter(canUseEmploymentActions);
  const kitchenWorkers = employmentActionWorkers.filter(w => w.role === "kitchen").sort((a, b) => (a.maxWeeklyHours ?? 0) - (b.maxWeeklyHours ?? 0));
  const salleWorkers = employmentActionWorkers.filter(w => w.role === "floor").sort((a, b) => (a.maxWeeklyHours ?? 0) - (b.maxWeeklyHours ?? 0));

  return (
    <div className="space-y-[var(--space-lg)]">
      {/* Controls bar */}
      <div className="flex items-center justify-between flex-wrap gap-[var(--space-sm)]">
        <div className="flex items-center gap-[var(--space-md)]">
          {baseData.profiles.length > 1 && (
            <div className="flex items-center gap-[var(--space-xs)]">
              <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground">{t("manual.profileLabel")}</span>
              <select
                value={profileId || baseData.activeProfileId || ""}
                onChange={(e) => setProfileId(e.target.value || undefined)}
                className="text-[length:var(--text-xs)] tracking-wide font-bold bg-transparent border border-foreground/20 rounded-[0.2rem] px-[var(--space-sm)] py-[2px] text-foreground"
              >
                {baseData.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name || t("manual.defaultProfile")}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {hasOverrides && (
          <div className="flex items-center gap-[var(--space-sm)]">
            <span className="text-[length:var(--text-2xs)] text-muted-foreground">
              {t("manual.modifications", { count: Object.keys(contractOverrides).length + restrictionOverrides.length })}
            </span>
            {simulating && (
              <span className="text-[length:var(--text-2xs)] text-purple-600 dark:text-purple-400 font-bold animate-pulse">
                {t("manual.calculating")}
              </span>
            )}
            <button
              type="button"
              onClick={clearAll}
              className="flex items-center gap-[3px] text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw className="size-3" />
              <span className="underline underline-offset-2">{t("manual.reset")}</span>
            </button>
          </div>
        )}
      </div>

      {/* Active overrides pills */}
      {hasOverrides && (
        <div className="flex flex-wrap gap-[var(--space-xs)]">
          {Object.entries(contractOverrides).map(([wId, newH]) => {
            const w = baseData.workerLoads.find(wl => wl.workerId === wId);
            const name = w?.workerName ?? wId;
            const origH = w?.contractHours ?? 35;
            return (
              <span key={wId} className="inline-flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] rounded-full border border-purple-500/20 bg-purple-500/10 text-[length:var(--text-xs)]">
                <span className="font-bold text-purple-700 dark:text-purple-300">{name}</span>
                <span className="text-muted-foreground">{origH}h→{newH}h</span>
                <button type="button" onClick={() => handleContractChange(wId, undefined)} className="text-muted-foreground hover:text-foreground ml-[2px]">×</button>
              </span>
            );
          })}
          {restrictionOverrides.map(wId => {
            const name = baseData.workerLoads.find(wl => wl.workerId === wId)?.workerName ?? wId;
            return (
              <span key={`r_${wId}`} className="inline-flex items-center gap-[3px] px-[var(--space-xs)] py-[1px] rounded-full border border-amber-500/20 bg-amber-500/10 text-[length:var(--text-xs)]">
                <span className="font-bold text-amber-700 dark:text-amber-300">{name}</span>
                <span className="text-muted-foreground">{t("manual.noRestrictionsBadge")}</span>
                <button type="button" onClick={() => handleRestrictionToggle(wId)} className="text-muted-foreground hover:text-foreground ml-[2px]">×</button>
              </span>
            );
          })}
        </div>
      )}

      {/* Worker panels by role */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[var(--space-md)]">
        {/* Kitchen */}
        <div className="space-y-[var(--space-xs)]">
          <button
            onClick={() => setShowKitchen(!showKitchen)}
            className="flex items-center gap-[var(--space-xs)] group"
          >
            {showKitchen ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
            <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground group-hover:text-foreground">
              {t("manual.kitchenWithCount", { count: kitchenWorkers.length })}
            </span>
          </button>
          {showKitchen && (
            <div className="space-y-[1px]">
              <div className="flex items-center gap-[var(--space-sm)] px-[var(--space-sm)] text-[length:var(--text-2xs)] text-muted-foreground/60 uppercase tracking-widest font-bold">
                <span className="min-w-[140px]">{t("manual.tableHead.employee")}</span>
                <span className="w-[80px] text-right">{t("manual.tableHead.planned")}</span>
                <span className="w-[40px] text-right">{t("manual.tableHead.utilization")}</span>
                <span className="flex-1 min-w-[160px] text-center">{t("manual.tableHead.simContract")}</span>
                <span className="w-[24px]"><Ban className="size-3" /></span>
              </div>
              {kitchenWorkers.map(w => (
                <WorkerSimRow
                  key={w.workerId}
                  w={w}
                  override={contractOverrides[w.workerId]}
                  restrictionOverride={restrictionOverrides.includes(w.workerId)}
                  onContractChange={handleContractChange}
                  onRestrictionToggle={handleRestrictionToggle}
                />
              ))}
            </div>
          )}
        </div>

        {/* Salle */}
        <div className="space-y-[var(--space-xs)]">
          <button
            onClick={() => setShowSalle(!showSalle)}
            className="flex items-center gap-[var(--space-xs)] group"
          >
            {showSalle ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
            <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground group-hover:text-foreground">
              {t("manual.floorWithCount", { count: salleWorkers.length })}
            </span>
          </button>
          {showSalle && (
            <div className="space-y-[1px]">
              <div className="flex items-center gap-[var(--space-sm)] px-[var(--space-sm)] text-[length:var(--text-2xs)] text-muted-foreground/60 uppercase tracking-widest font-bold">
                <span className="min-w-[140px]">{t("manual.tableHead.employee")}</span>
                <span className="w-[80px] text-right">{t("manual.tableHead.planned")}</span>
                <span className="w-[40px] text-right">{t("manual.tableHead.utilization")}</span>
                <span className="flex-1 min-w-[160px] text-center">{t("manual.tableHead.simContract")}</span>
                <span className="w-[24px]"><Ban className="size-3" /></span>
              </div>
              {salleWorkers.map(w => (
                <WorkerSimRow
                  key={w.workerId}
                  w={w}
                  override={contractOverrides[w.workerId]}
                  restrictionOverride={restrictionOverrides.includes(w.workerId)}
                  onContractChange={handleContractChange}
                  onRestrictionToggle={handleRestrictionToggle}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Simulation results */}
      {hasOverrides && simData && baseData && !simulating && (
        <SimulationResults base={baseData} sim={simData} />
      )}

      {/* Empty state */}
      {!hasOverrides && (
        <div className="border border-dashed border-foreground/15 rounded-[0.2rem] p-[var(--space-md)] text-center space-y-[var(--space-xs)]">
          <FlaskConical className="size-6 text-muted-foreground/30 mx-auto" />
          <p className="text-[length:var(--text-xs)] text-muted-foreground max-w-md mx-auto">
            {t("manual.emptyState")}
          </p>
        </div>
      )}
    </div>
  );
}
