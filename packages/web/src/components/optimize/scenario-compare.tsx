import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, type StaffingAnalysis, type CapacitySummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { GitCompareArrows, Plus, X, FlaskConical, Loader2, Ban } from "lucide-react";

const verdictStyle: Record<string, { color: string; bg: string; barColor: string }> = {
  oversized: { color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/15", barColor: "bg-blue-500" },
  undersized: { color: "text-red-600 dark:text-red-400", bg: "bg-red-500/15", barColor: "bg-red-500" },
  tight: { color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/15", barColor: "bg-amber-500" },
  balanced: { color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/15", barColor: "bg-emerald-500" },
};

type Scenario = {
  id: string;
  name: string;
  contractOverrides: Record<string, number>;
  restrictionOverrides: string[];
  data: StaffingAnalysis | null;
  loading: boolean;
};

function canUseEmploymentActions(worker: StaffingAnalysis["workerLoads"][number]) {
  return worker.employmentActionEligible !== false;
}

function RoleMetrics({ cap, slots, role }: { cap?: CapacitySummary; slots: StaffingAnalysis["slots"]; role: "kitchen" | "floor" }) {
  const { t } = useTranslation("optimize");
  if (!cap) return <span className="text-muted-foreground/40">—</span>;
  const v = verdictStyle[cap.verdict ?? "balanced"];
  const understaffed = slots.filter(s => s.role === role && s.status === "understaffed").length;

  return (
    <div className="space-y-[var(--space-xs)]">
      <span className={cn("px-1 py-0 rounded-[0.15rem] text-[length:var(--text-2xs)] font-bold", v.bg, v.color)}>
        {t(`verdict.${cap.verdict ?? "balanced"}`)}
      </span>
      <div className="space-y-[2px] text-[length:var(--text-xs)]">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("compare.surplus")}</span>
          <span className={cn("font-bold tabular-nums", (cap.surplusHours ?? 0) > 0 ? "text-blue-600 dark:text-blue-400" : (cap.surplusHours ?? 0) < 0 ? "text-red-600 dark:text-red-400" : "text-foreground")}>
            {(cap.surplusHours ?? 0) > 0 ? "+" : ""}{cap.surplusHours ?? 0}h
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("compare.contract")}</span>
          <span className="font-bold tabular-nums">{cap.totalContractHours ?? 0}h</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("compare.demand")}</span>
          <span className="font-bold tabular-nums">{cap.totalDemandHours ?? 0}h</span>
        </div>
        {understaffed > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("compare.understaffed")}</span>
            <span className="font-bold tabular-nums text-red-600 dark:text-red-400">{understaffed}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ScenarioColumn({ scenario, onRemove, isBaseline }: {
  scenario: Scenario;
  onRemove?: () => void;
  isBaseline: boolean;
}) {
  const { t } = useTranslation("optimize");
  const overrideCount = Object.keys(scenario.contractOverrides).length + scenario.restrictionOverrides.length;

  return (
    <div className={cn(
      "border rounded-[0.2rem] p-[var(--space-sm)] space-y-[var(--space-sm)] min-w-[200px]",
      isBaseline ? "border-foreground/20 bg-foreground/[0.02]" : "border-purple-500/20 bg-purple-500/[0.02]",
    )}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--space-xs)]">
          {isBaseline ? (
            <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">{t("compare.reference")}</span>
          ) : (
            <FlaskConical className="size-3 text-purple-600 dark:text-purple-400" />
          )}
          <span className="text-[length:var(--text-xs)] font-bold truncate max-w-[140px]">
            {scenario.name}
          </span>
        </div>
        {!isBaseline && onRemove && (
          <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-foreground">
            <X className="size-3" />
          </button>
        )}
      </div>

      {/* Override pills */}
      {overrideCount > 0 && (
        <div className="flex flex-wrap gap-[2px]">
          {Object.entries(scenario.contractOverrides).map(([wId, h]) => (
            <span key={wId} className="px-[var(--space-xs)] py-0 rounded-full text-[length:8px] font-medium border border-purple-500/20 bg-purple-500/10 text-purple-700 dark:text-purple-300">
              {scenario.data?.workerLoads.find(w => w.workerId === wId)?.workerName ?? wId} → {h}h
            </span>
          ))}
          {scenario.restrictionOverrides.map(wId => (
            <span key={wId} className="px-[var(--space-xs)] py-0 rounded-full text-[length:8px] font-medium border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300">
              {scenario.data?.workerLoads.find(w => w.workerId === wId)?.workerName ?? wId} ✕R
            </span>
          ))}
        </div>
      )}

      {/* Loading */}
      {scenario.loading && (
        <div className="flex items-center justify-center py-[var(--space-md)]">
          <Loader2 className="size-4 text-muted-foreground animate-spin" />
        </div>
      )}

      {/* Metrics */}
      {scenario.data && !scenario.loading && (
        <div className="space-y-[var(--space-sm)]">
          {(["kitchen", "floor"] as const).map(role => (
            <div key={role}>
              <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60 block mb-[var(--space-xs)]">
                {role === "kitchen" ? t("roles.kitchen") : t("roles.floor")}
              </span>
              <RoleMetrics
                cap={scenario.data!.capacity.find(c => c.role === role)}
                slots={scenario.data!.slots}
                role={role}
              />
            </div>
          ))}

          {/* Actions count */}
          {scenario.data.actions && scenario.data.actions.length > 0 && (
            <div className="text-[length:var(--text-2xs)] text-muted-foreground pt-[var(--space-xs)] border-t border-foreground/5">
              {t("compare.actionsRecommended", { count: scenario.data.actions.length })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

let idCounter = 0;

export function ScenarioCompareTab() {
  const { t } = useTranslation("optimize");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  // const [newName, setNewName] = useState(""); // TODO: for custom scenario naming
  const [showAdd, setShowAdd] = useState(false);

  // Always have baseline
  const [baseline, setBaseline] = useState<Scenario>({
    id: "baseline",
    name: t("compare.baselineName"),
    contractOverrides: {},
    restrictionOverrides: [],
    data: null,
    loading: false,
  });

  // Fetch baseline on mount
  const fetchBaseline = useCallback(async () => {
    setBaseline(prev => ({ ...prev, loading: true }));
    try {
      const res = await api.getStaffingAnalysis(undefined);
      setBaseline(prev => ({ ...prev, data: res.data, loading: false }));
    } catch {
      setBaseline(prev => ({ ...prev, data: null, loading: false }));
    }
  }, []);

  useEffect(() => { fetchBaseline(); }, [fetchBaseline]);

  const addScenario = useCallback(async (name: string, contractOverrides: Record<string, number>, restrictionOverrides: string[]) => {
    const id = `scenario_${++idCounter}`;
    const scenario: Scenario = {
      id, name, contractOverrides, restrictionOverrides, data: null, loading: true,
    };
    setScenarios(prev => [...prev, scenario]);

    try {
      const contractOv = Object.keys(contractOverrides).length > 0 ? contractOverrides : undefined;
      const restrictOv = restrictionOverrides.length > 0 ? restrictionOverrides : undefined;
      const res = await api.getStaffingAnalysis(undefined, contractOv, restrictOv);
      setScenarios(prev => prev.map(s => s.id === id ? { ...s, data: res.data, loading: false } : s));
    } catch {
      setScenarios(prev => prev.map(s => s.id === id ? { ...s, loading: false } : s));
    }
  }, []);

  const removeScenario = useCallback((id: string) => {
    setScenarios(prev => prev.filter(s => s.id !== id));
  }, []);

  // Quick-add presets
  const addPreset = useCallback(async (type: string) => {
    if (!baseline.data) return;

    if (type === "zero_surplus") {
      // Reduce all over-contracted workers to their planned hours
      const overrides: Record<string, number> = {};
      for (const w of baseline.data.workerLoads.filter(canUseEmploymentActions)) {
        const contractH = w.contractHours ?? 35;
        const plannedH = w.maxWeeklyHours ?? 0;
        if (contractH > 0 && plannedH < contractH * 0.8) {
          overrides[w.workerId] = Math.max(Math.ceil(plannedH), 0);
        }
      }
      if (Object.keys(overrides).length > 0) {
        addScenario(t("compare.presetContractsAdjusted"), overrides, []);
      }
    } else if (type === "no_restrictions") {
      // Remove all restrictions
      const restrictedIds = baseline.data.workerLoads
        .filter(canUseEmploymentActions)
        .filter(w => (w.maxWeeklyHours ?? 0) < (w.contractHours ?? 35) * 0.8)
        .map(w => w.workerId);
      if (restrictedIds.length > 0) {
        addScenario(t("compare.presetNoRestrictions"), {}, restrictedIds);
      }
    }
  }, [baseline.data, addScenario, t]);

  return (
    <div className="space-y-[var(--space-md)]">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-[var(--space-sm)]">
        <div className="flex items-center gap-[var(--space-sm)]">
          <button
            type="button"
            onClick={() => addPreset("zero_surplus")}
            disabled={!baseline.data}
            className="text-[length:var(--text-2xs)] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors disabled:opacity-40"
          >
            {t("compare.addContractsOptimized")}
          </button>
          <button
            type="button"
            onClick={() => addPreset("no_restrictions")}
            disabled={!baseline.data}
            className="text-[length:var(--text-2xs)] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors disabled:opacity-40"
          >
            {t("compare.addNoRestrictions")}
          </button>
        </div>
      </div>

      {/* Scenario columns */}
      <div className="flex gap-[var(--space-sm)] overflow-x-auto pb-[var(--space-sm)]">
        {/* Baseline */}
        <ScenarioColumn scenario={baseline} isBaseline />

        {/* Custom scenarios */}
        {scenarios.map(s => (
          <ScenarioColumn
            key={s.id}
            scenario={s}
            isBaseline={false}
            onRemove={() => removeScenario(s.id)}
          />
        ))}

        {/* Add scenario button */}
        {scenarios.length < 4 && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="border border-dashed border-foreground/15 rounded-[0.2rem] min-w-[160px] flex flex-col items-center justify-center gap-[var(--space-xs)] p-[var(--space-md)] text-muted-foreground/40 hover:text-muted-foreground hover:border-foreground/25 transition-colors"
          >
            <Plus className="size-5" />
            <span className="text-[length:var(--text-2xs)] font-bold">{t("compare.addScenario")}</span>
          </button>
        )}
      </div>

      {/* Add scenario modal (inline) */}
      {showAdd && baseline.data && (
        <AddScenarioPanel
          workerLoads={baseline.data.workerLoads}
          onAdd={(name, co, ro) => { addScenario(name, co, ro); setShowAdd(false); }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Empty state */}
      {scenarios.length === 0 && !showAdd && (
        <div className="border border-dashed border-foreground/15 rounded-[0.2rem] p-[var(--space-md)] text-center space-y-[var(--space-xs)]">
          <GitCompareArrows className="size-6 text-muted-foreground/30 mx-auto" />
          <p className="text-[length:var(--text-xs)] text-muted-foreground max-w-md mx-auto">
            {t("compare.emptyState")}
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Add scenario inline panel ── */

function AddScenarioPanel({ workerLoads, onAdd, onCancel }: {
  workerLoads: StaffingAnalysis["workerLoads"];
  onAdd: (name: string, contractOverrides: Record<string, number>, restrictionOverrides: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("optimize");
  const [name, setName] = useState(t("compare.scenarioName", { n: idCounter + 1 }));
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [restrictions, setRestrictions] = useState<string[]>([]);

  const toggleRestriction = (wId: string) => {
    setRestrictions(prev => prev.includes(wId) ? prev.filter(id => id !== wId) : [...prev, wId]);
  };

  const hasChanges = Object.keys(overrides).length > 0 || restrictions.length > 0;

  const employmentActionWorkers = workerLoads.filter(canUseEmploymentActions);
  const kitchenWorkers = employmentActionWorkers.filter(w => w.role === "kitchen");
  const salleWorkers = employmentActionWorkers.filter(w => w.role === "floor");

  return (
    <div className="border border-purple-500/20 bg-purple-500/[0.02] rounded-[0.2rem] p-[var(--space-sm)] space-y-[var(--space-sm)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--space-sm)]">
          <FlaskConical className="size-3.5 text-purple-600 dark:text-purple-400" />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-[length:var(--text-xs)] font-bold bg-transparent border-b border-foreground/20 focus:border-foreground/50 outline-none px-1 py-0"
            placeholder={t("compare.scenarioNamePlaceholder")}
          />
        </div>
        <div className="flex items-center gap-[var(--space-xs)]">
          <button type="button" onClick={onCancel} className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground underline underline-offset-2">
            {t("compare.cancel")}
          </button>
          <button
            type="button"
            onClick={() => onAdd(name, overrides, restrictions)}
            disabled={!hasChanges}
            className="inline-flex items-center gap-[var(--space-xs)] px-[var(--space-md)] py-[2px] rounded-[0.2rem] bg-foreground text-background text-[length:var(--text-xs)] font-bold disabled:opacity-40"
          >
            {t("compare.compareButton")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-sm)]">
        {[{ label: t("roles.kitchen"), workers: kitchenWorkers }, { label: t("roles.floor"), workers: salleWorkers }].map(group => (
          <div key={group.label} className="space-y-[2px]">
            <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground/60">
              {group.label}
            </span>
            {group.workers.map(w => {
              const contractH = w.contractHours ?? 35;
              const simH = overrides[w.workerId] ?? contractH;
              const isRestricted = restrictions.includes(w.workerId);
              const isModified = overrides[w.workerId] !== undefined || isRestricted;
              return (
                <div key={w.workerId} className={cn(
                  "flex items-center gap-[var(--space-xs)] px-[var(--space-xs)] py-[1px] rounded-[0.15rem] text-[length:var(--text-xs)]",
                  isModified && "bg-purple-500/5",
                )}>
                  <span className="font-bold w-[100px] truncate">{w.workerName}</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(contractH, 48)}
                    step={1}
                    value={simH}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setOverrides(prev => {
                        if (val === contractH) {
                          const next = { ...prev };
                          delete next[w.workerId];
                          return next;
                        }
                        return { ...prev, [w.workerId]: val };
                      });
                    }}
                    className="flex-1 h-[3px] accent-purple-500"
                  />
                  <span className="w-[30px] text-right tabular-nums text-muted-foreground">{simH}h</span>
                  <button
                    type="button"
                    onClick={() => toggleRestriction(w.workerId)}
                    className={cn(
                      "shrink-0 px-[2px] py-0 rounded-full text-[length:8px]",
                      isRestricted ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/30",
                    )}
                    title={t("compare.noRestrictionsTitle")}
                  >
                    <Ban className="size-2.5" />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
