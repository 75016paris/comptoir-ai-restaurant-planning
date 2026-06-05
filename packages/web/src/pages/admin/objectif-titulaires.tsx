import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, AlertTriangle, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { DndContext, useDraggable, useDroppable, useSensor, useSensors, MouseSensor, TouchSensor, KeyboardSensor, DragOverlay, type DragEndEvent } from "@dnd-kit/core";
import { subRoleSubstitution } from "@comptoir/shared";
import { api, type StaffingTargetsResponse, type TitulairesResponse, type TitulaireWorker, type TitulaireAssignment, type TitulaireStaleness } from "@/lib/api";
import { ChefCrown } from "@/components/chef-crown";
import { assignColors, getWorkerColor, getWorkerTier, KITCHEN_LABEL, FLOOR_LABEL } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { JOURS, JOURS_COURTS, fmtDateShort } from "@/lib/date-utils";

type TFn = ReturnType<typeof useTranslation>["t"];

function stalenessLabel(t: TFn, s: TitulaireStaleness, contractEndDate: string | null): string {
  switch (s) {
    case "inactive": return t("titulaires.staleness.inactive");
    case "temp_inactive": return t("titulaires.staleness.tempInactive");
    case "contract_ended": return contractEndDate
      ? t("titulaires.staleness.contractEndedOn", { date: fmtDateShort(contractEndDate) })
      : t("titulaires.staleness.contractEnded");
    case "contract_ending": return contractEndDate
      ? t("titulaires.staleness.contractEndingOn", { date: fmtDateShort(contractEndDate) })
      : t("titulaires.staleness.contractEnding");
  }
}

const SUBROLE_RANK: Record<string, number> = {
  "Chef": 0, "Sous-chef": 1, "Chef de partie": 2, "Cuisinier": 3, "Commis": 4, "Plongeur": 5,
  "Chef de rang": 0, "Sous-chef de rang": 1, "Serveur": 2, "Runner": 3, "Barman": 1, "Tabac": 2,
};
function rankSubRoles(subRoles: string[]): number {
  if (subRoles.length === 0) return 99;
  return Math.min(...subRoles.map(r => SUBROLE_RANK[r] ?? 50));
}

type ZoneSide = {
  zone: string;
  role: "kitchen" | "floor";
  startTime: string;
  endTime: string;
  hours: number;
  /** Required sub-role demand per dow: e.g. {1: ["Chef","Cuisinier","Cuisinier"]} */
  demandByDow: Map<number, string[]>;
};

type ZoneRow = {
  zone: string;
  /** Kitchen + salle sides for this zone — at least one is non-null */
  kitchen: ZoneSide | null;
  floor: ZoneSide | null;
  startTime: string;
  endTime: string;
};

type DragData =
  | { kind: "pool"; workerId: string }
  | { kind: "pinned"; workerId: string; dow: number; zone: string; role: "kitchen" | "floor" };

function dropKey(dow: number, zone: string, role: "kitchen" | "floor"): string {
  return `cell|${dow}|${zone}|${role}`;
}

export function ObjectifTitulairesPage() {
  const { t } = useTranslation("objectif");
  const { profileId } = useParams<{ profileId: string }>();
  const [searchParams] = useSearchParams();
  const fromOnboarding = searchParams.get("fromOnboarding") === "1";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [assignments, setAssignments] = useState<TitulaireAssignment[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const titulairesQuery = useQuery({
    queryKey: qk.staffing.titulaires(profileId ?? ""),
    queryFn: async () => (await api.getProfileTitulaires(profileId!)).data,
    enabled: !!profileId,
  });
  const staffingQuery = useQuery({
    queryKey: qk.staffing.targets(),
    queryFn: async () => (await api.getStaffingTargets()).data,
    enabled: !!profileId,
  });
  const data: TitulairesResponse | null = titulairesQuery.data ?? null;
  const staffing: StaffingTargetsResponse | null = staffingQuery.data ?? null;
  const loading = titulairesQuery.isPending || staffingQuery.isPending;

  useEffect(() => {
    if (!data) return;
    queueMicrotask(() => setAssignments(data.assignments));
    const palette = data.workers.map(w => ({ id: w.id, name: w.name, role: w.role, subRoles: w.subRoles }));
    assignColors(palette);
  }, [data]);

  useEffect(() => {
    if (titulairesQuery.error || staffingQuery.error) toast.error(t("shared.loadError"));
  }, [titulairesQuery.error, staffingQuery.error, t]);

  // Build per-zone row groups: each unique zone name has up to a kitchen side and a salle side.
  const zoneRows = useMemo<ZoneRow[]>(() => {
    if (!staffing || !profileId) return [];
    const tpls = (staffing.profileTemplates ?? []).filter(t => t.profileId === profileId);
    const targets = staffing.targets.filter(t => t.profileId === profileId);
    const sides = new Map<string, ZoneSide>(); // `${zone}__${role}` → side (legs merged for coupures)
    for (const tpl of tpls) {
      const k = `${tpl.zone}__${tpl.role}`;
      const [sh, sm] = tpl.startTime.split(":").map(Number);
      const [eh, em] = tpl.endTime.split(":").map(Number);
      let legMins = (eh * 60 + em) - (sh * 60 + sm);
      if (legMins <= 0) legMins += 24 * 60;
      const existing = sides.get(k);
      if (!existing) {
        sides.set(k, {
          zone: tpl.zone, role: tpl.role,
          startTime: tpl.startTime, endTime: tpl.endTime,
          hours: legMins / 60, demandByDow: new Map(),
        });
      } else {
        // Coupure: same (zone, role) carries multiple template legs (morning + evening).
        // Display the full amplitude (min start → max end). Worked hours = sum of leg hours.
        if (tpl.startTime < existing.startTime) existing.startTime = tpl.startTime;
        if (tpl.endTime > existing.endTime) existing.endTime = tpl.endTime;
        existing.hours += legMins / 60;
      }
    }
    function parseBreakdown(raw: unknown): Record<string, number> {
      if (!raw) return {};
      if (typeof raw === "string") {
        try {
          const obj = JSON.parse(raw);
          return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
        } catch { return {}; }
      }
      if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, number>;
      return {};
    }
    for (const t of targets) {
      const side = sides.get(`${t.zone}__${t.role}`);
      if (!side || t.count <= 0) continue;
      const breakdown = parseBreakdown(t.roleBreakdown);
      const breakdownEntries = Object.entries(breakdown).filter(([, n]) => typeof n === "number" && n > 0) as Array<[string, number]>;
      const demand: string[] = [];
      if (breakdownEntries.length === 0) {
        const generic = t.role === "kitchen" ? "Cuisinier" : "Serveur";
        for (let i = 0; i < t.count; i++) demand.push(generic);
      } else {
        for (const [subRole, n] of breakdownEntries) {
          for (let i = 0; i < n; i++) demand.push(subRole);
        }
        const sum = breakdownEntries.reduce((acc, [, n]) => acc + n, 0);
        const generic = t.role === "kitchen" ? "Cuisinier" : "Serveur";
        for (let i = sum; i < t.count; i++) demand.push(generic);
      }
      demand.sort((a, b) => (SUBROLE_RANK[a] ?? 50) - (SUBROLE_RANK[b] ?? 50));
      side.demandByDow.set(t.dayOfWeek, demand);
    }
    // Group sides into rows by zone name.
    const rows = new Map<string, ZoneRow>();
    for (const side of sides.values()) {
      let row = rows.get(side.zone);
      if (!row) {
        row = { zone: side.zone, kitchen: null, floor: null, startTime: "99:99", endTime: "00:00" };
        rows.set(side.zone, row);
      }
      if (side.role === "kitchen") row.kitchen = side;
      else row.floor = side;
    }
    // Recompute earliest-start / latest-end across both sides for ordering and display
    // (each side's own start/end already spans across all coupure legs).
    for (const row of rows.values()) {
      const starts = [row.kitchen?.startTime, row.floor?.startTime].filter((t): t is string => !!t);
      const ends = [row.kitchen?.endTime, row.floor?.endTime].filter((t): t is string => !!t);
      row.startTime = starts.sort()[0] ?? "00:00";
      row.endTime = ends.sort().reverse()[0] ?? "00:00";
    }
    // Sort by start time; tiebreak by end time (longer span e.g. coupure goes after the
    // tight midi service that ends at 15:00).
    return [...rows.values()].sort((a, b) => {
      const c = a.startTime.localeCompare(b.startTime);
      if (c !== 0) return c;
      return a.endTime.localeCompare(b.endTime);
    });
  }, [staffing, profileId]);

  // Active days = dows with at least one side having demand.
  const activeDays = useMemo(() => {
    const days = new Set<number>();
    for (const row of zoneRows) {
      for (const side of [row.kitchen, row.floor]) {
        if (!side) continue;
        for (const dow of side.demandByDow.keys()) days.add(dow);
      }
    }
    return [1, 2, 3, 4, 5, 6, 7].filter(d => days.has(d));
  }, [zoneRows]);

  const pinned = useMemo(() => {
    const m = new Map<string, Array<{ workerId: string; subRole?: string | null }>>();
    for (const a of assignments) {
      const k = dropKey(a.dayOfWeek, a.zone, a.role);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push({ workerId: a.workerId, subRole: a.subRole ?? null });
    }
    return m;
  }, [assignments]);

  const pinCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments) m.set(a.workerId, (m.get(a.workerId) ?? 0) + 1);
    return m;
  }, [assignments]);

  const pinnedHours = useMemo(() => {
    const m = new Map<string, number>();
    const sideHours = new Map<string, number>();
    for (const row of zoneRows) {
      if (row.kitchen) sideHours.set(`${row.zone}__kitchen`, row.kitchen.hours);
      if (row.floor) sideHours.set(`${row.zone}__floor`, row.floor.hours);
    }
    for (const a of assignments) {
      const h = sideHours.get(`${a.zone}__${a.role}`) ?? 0;
      m.set(a.workerId, (m.get(a.workerId) ?? 0) + h);
    }
    return m;
  }, [assignments, zoneRows]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const workersById = useMemo(() => {
    const m = new Map<string, TitulaireWorker>();
    if (data) for (const w of data.workers) m.set(w.id, w);
    return m;
  }, [data]);

  function scheduleSave(next: TitulaireAssignment[]) {
    if (!profileId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api.updateProfileTitulaires(profileId, next);
        setSavedAt(Date.now());
        queryClient.invalidateQueries({ queryKey: qk.staffing.titulaires(profileId) });
      } catch {
        toast.error(t("shared.saveError"));
      }
    }, 400);
  }

  function applyChange(updater: (prev: TitulaireAssignment[]) => TitulaireAssignment[]) {
    setAssignments(prev => {
      const next = updater(prev);
      scheduleSave(next);
      return next;
    });
  }

  function pinWorker(workerId: string, dow: number, zone: string, role: "kitchen" | "floor", subRole?: string) {
    applyChange(prev => {
      const idx = prev.findIndex(a => a.workerId === workerId && a.dayOfWeek === dow && a.zone === zone && a.role === role);
      if (idx >= 0) {
        if (subRole === undefined) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], subRole };
        return next;
      }
      return [...prev, { workerId, dayOfWeek: dow, zone, role, subRole: subRole ?? null }];
    });
  }
  function unpinWorker(workerId: string, dow: number, zone: string, role: "kitchen" | "floor") {
    applyChange(prev => prev.filter(a => !(a.workerId === workerId && a.dayOfWeek === dow && a.zone === zone && a.role === role)));
  }
  function clearWorker(workerId: string) {
    applyChange(prev => prev.filter(a => a.workerId !== workerId));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    const data = e.active.data.current as DragData | undefined;
    if (!data) return;
    if (!e.over) {
      if (data.kind === "pinned") unpinWorker(data.workerId, data.dow, data.zone, data.role);
      return;
    }
    const overId = String(e.over.id);
    if (overId === "pool") {
      if (data.kind === "pinned") unpinWorker(data.workerId, data.dow, data.zone, data.role);
      return;
    }
    const overData = e.over.data.current as { kind?: string; dow?: number; zone?: string; role?: "kitchen" | "floor"; subRole?: string } | undefined;
    let dow: number;
    let zone: string;
    let role: "kitchen" | "floor";
    let targetSubRole: string | undefined;
    if (overData?.kind === "slot" && overData.dow != null && overData.zone && overData.role) {
      dow = overData.dow;
      zone = overData.zone;
      role = overData.role;
      targetSubRole = overData.subRole;
    } else if (overId.startsWith("cell|")) {
      const parts = overId.split("|");
      dow = Number(parts[1]);
      zone = parts[2];
      const r = parts[3];
      if (r !== "kitchen" && r !== "floor") return;
      role = r;
    } else {
      return;
    }
    const w = workersById.get(data.workerId);
    if (!w) return;
    if (w.role !== role) {
      toast.error(t("titulaires.errors.wrongRole", { name: w.name, role: t(`shared.${role}`) }));
      return;
    }
    if (data.kind === "pinned") {
      if (data.dow === dow && data.zone === zone && data.role === role) {
        // Same cell — only update subRole if specified.
        if (targetSubRole !== undefined) {
          applyChange(prev => prev.map(a =>
            a.workerId === data.workerId && a.dayOfWeek === dow && a.zone === zone && a.role === role
              ? { ...a, subRole: targetSubRole }
              : a,
          ));
        }
        return;
      }
      applyChange(prev => {
        const without = prev.filter(a => !(a.workerId === data.workerId && a.dayOfWeek === data.dow && a.zone === data.zone && a.role === data.role));
        if (without.some(a => a.workerId === data.workerId && a.dayOfWeek === dow && a.zone === zone && a.role === role)) return without;
        return [...without, { workerId: data.workerId, dayOfWeek: dow, zone, role, subRole: targetSubRole ?? null }];
      });
      return;
    }
    pinWorker(data.workerId, dow, zone, role, targetSubRole);
  }

  const verdict = useMemo(() => {
    if (!data || zoneRows.length === 0) return null;
    let totalDemandSlots = 0;
    let totalDemandHours = 0;
    for (const row of zoneRows) {
      for (const side of [row.kitchen, row.floor]) {
        if (!side) continue;
        for (const [, demand] of side.demandByDow) {
          totalDemandSlots += demand.length;
          totalDemandHours += demand.length * side.hours;
        }
      }
    }
    const pinnedSlots = assignments.length;
    const fillRate = totalDemandSlots > 0 ? Math.min(1, pinnedSlots / totalDemandSlots) : 1;
    const uniquePinned = new Set(assignments.map(a => a.workerId));
    let totalCapacity = 0;
    for (const id of uniquePinned) {
      const w = workersById.get(id);
      if (w) totalCapacity += w.contractHours ?? 35;
    }
    const capacityRatio = totalDemandHours > 0 ? totalCapacity / totalDemandHours : 1;
    const overloaded: Array<{ workerId: string; name: string; pinned: number; contract: number }> = [];
    for (const id of uniquePinned) {
      const w = workersById.get(id);
      const ph = pinnedHours.get(id) ?? 0;
      const ch = w?.contractHours ?? 35;
      if (ph > ch + 0.5) overloaded.push({ workerId: id, name: w?.name ?? id, pinned: ph, contract: ch });
    }
    const stalePinned = [...uniquePinned].filter(id => workersById.get(id)?.staleness != null).length;
    // Substitution count: pinned cards where worker can fill but not exact for any required sub-role.
    let substitutions = 0;
    for (const a of assignments) {
      const row = zoneRows.find(r => r.zone === a.zone);
      const side = a.role === "kitchen" ? row?.kitchen : row?.floor;
      const demand = side?.demandByDow.get(a.dayOfWeek) ?? [];
      const w = workersById.get(a.workerId);
      if (!w || demand.length === 0) continue;
      // Exact match for at least one demanded sub-role on this day?
      const hasExact = demand.some(sub => w.subRoles.includes(sub));
      if (!hasExact) substitutions++;
    }
    let level: "ok" | "tendu" | "insuffisant";
    if (capacityRatio >= 1.0 && fillRate >= 0.95 && overloaded.length === 0) level = "ok";
    else if (capacityRatio >= 0.85 && fillRate >= 0.7) level = "tendu";
    else level = "insuffisant";
    return { totalDemandSlots, pinnedSlots, totalDemandHours, totalCapacity, capacityRatio, fillRate, overloaded, stalePinned, substitutions, level };
  }, [data, zoneRows, assignments, workersById, pinnedHours]);

  if (loading) {
    return <div className="flex items-center justify-center h-96"><p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("shared.loading")}</p></div>;
  }
  if (!data || !staffing) {
    return <div className="px-[var(--space-md)] py-[var(--space-lg)]"><p className="text-destructive">{t("titulaires.errors.profileNotFound")}</p></div>;
  }

  // Pool: hide workers who can't be planned at all (inactive, temp inactive, contract ended).
  // Keep contract_ending (still working, just CDD/saisonnier near term end) so the admin can
  // see them with an explicit warning and decide whether to keep pinning them.
  const poolWorkers = data.workers.filter(w => w.staleness === null || w.staleness === "contract_ending");
  const sortedWorkers = [...poolWorkers].sort((a, b) => {
    if (a.role !== b.role) return a.role === "kitchen" ? -1 : 1;
    return rankSubRoles(a.subRoles) - rankSubRoles(b.subRoles) || a.name.localeCompare(b.name);
  });
  const kitchenWorkers = sortedWorkers.filter(w => w.role === "kitchen");
  const floorWorkers = sortedWorkers.filter(w => w.role === "floor");

  // Worker being dragged — used to colour-code drop targets (red=wrong role, amber=substitution).
  const draggedWorker = activeDrag ? workersById.get(activeDrag.workerId) ?? null : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setActiveDrag((e.active.data.current as DragData) ?? null)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <div className="px-[var(--space-md)] md:px-[var(--space-lg)] py-[var(--space-md)] space-y-[var(--space-md)]">
        {/* Header */}
        <div className="flex items-center gap-[var(--space-sm)]">
          <button
            onClick={() => navigate(fromOnboarding ? `/preferences/objectif/${profileId}?fromOnboarding=1` : `/preferences/objectif/${profileId}`)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
            title={t("titulaires.header.back")}
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-[length:var(--text-lg)] font-bold">{t("titulaires.header.title", { name: data.profile.name || t("titulaires.header.untitled") })}</h1>
          <div className="ml-auto flex items-center gap-[var(--space-sm)]">
            {verdict && verdict.stalePinned > 0 && (
              <span
                className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-[6px] rounded-full bg-red-500 text-white text-[length:11px] font-bold"
                title={t("titulaires.header.needsReview", { count: verdict.stalePinned })}
              >
                {verdict.stalePinned}
              </span>
            )}
            {savedAt && <span className="text-[length:var(--text-2xs)] text-muted-foreground">{t("shared.saved")}</span>}
            {fromOnboarding && (
              <button
                type="button"
                onClick={() => navigate("/onboarding/style")}
                className="h-7 px-[var(--space-md)] rounded-full bg-foreground text-background text-[length:var(--text-xs)] uppercase tracking-widest font-bold hover:opacity-80 transition-opacity"
              >
                {t("shared.continue")}
              </button>
            )}
          </div>
        </div>

        <div className="border border-foreground/15 bg-foreground/[0.02] rounded-md p-[var(--space-md)] space-y-[var(--space-sm)] text-[length:var(--text-xs)] leading-relaxed">
          <p className="font-bold text-foreground">{t("titulaires.intro.title")}</p>
          <p className="text-muted-foreground">{t("titulaires.intro.p1")}</p>
          <p className="text-muted-foreground">{t("titulaires.intro.p2")}</p>
          <p className="text-muted-foreground">{t("titulaires.intro.p3")}</p>
          <p className="text-muted-foreground italic">{t("titulaires.intro.drag")}</p>
        </div>

        <WorkerPool
          kitchen={kitchenWorkers}
          floor={floorWorkers}
          pinCount={pinCount}
          pinnedHours={pinnedHours}
          onClear={clearWorker}
        />

        {verdict && <ConformitePanel verdict={verdict} />}

        {zoneRows.length === 0 || activeDays.length === 0 ? (
          <div className="border border-dashed border-foreground/20 rounded-md p-[var(--space-md)] text-center text-muted-foreground text-[length:var(--text-xs)]">
            {t("titulaires.errors.noTargets")}
          </div>
        ) : (
          <StackGrid
            zoneRows={zoneRows}
            activeDays={activeDays}
            pinned={pinned}
            workersById={workersById}
            draggedWorker={draggedWorker}
            onRemove={unpinWorker}
          />
        )}
      </div>

      <DragOverlay>
        {activeDrag && workersById.has(activeDrag.workerId) ? (
          <PinnedCard worker={workersById.get(activeDrag.workerId)!} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function WorkerPool({
  kitchen, floor, pinCount, pinnedHours, onClear,
}: {
  kitchen: TitulaireWorker[];
  floor: TitulaireWorker[];
  pinCount: Map<string, number>;
  pinnedHours: Map<string, number>;
  onClear: (workerId: string) => void;
}) {
  const { t } = useTranslation("objectif");
  const { setNodeRef, isOver } = useDroppable({ id: "pool" });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border rounded-md p-[var(--space-sm)] space-y-[var(--space-sm)]",
        isOver ? "border-amber-500 bg-amber-500/5" : "border-border",
      )}
    >
      <p className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">
        {t("titulaires.pool.title")} <span className="text-muted-foreground/60">{t("titulaires.pool.subtitle")}</span>
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-sm)]">
        <PoolColumn label={t("shared.kitchen")} labelColor={KITCHEN_LABEL} workers={kitchen} pinCount={pinCount} pinnedHours={pinnedHours} onClear={onClear} />
        <PoolColumn label={t("shared.floor")} labelColor={FLOOR_LABEL} workers={floor} pinCount={pinCount} pinnedHours={pinnedHours} onClear={onClear} />
      </div>
    </div>
  );
}

function PoolColumn({
  label, labelColor, workers, pinCount, pinnedHours, onClear,
}: {
  label: string;
  labelColor: { bg: string; border: string; text: string };
  workers: TitulaireWorker[];
  pinCount: Map<string, number>;
  pinnedHours: Map<string, number>;
  onClear: (workerId: string) => void;
}) {
  if (workers.length === 0) return null;
  return (
    <div className="space-y-[var(--space-xs)]">
      <span className={cn(
        "inline-flex items-center px-[var(--space-sm)] py-[2px] rounded-full text-[length:9px] font-bold uppercase tracking-widest",
        labelColor.bg, labelColor.border, labelColor.text, "border",
      )}>
        {label}
      </span>
      <div className="flex flex-wrap gap-[var(--space-xs)]">
        {workers.map(w => <PoolCard key={w.id} worker={w} pinned={(pinCount.get(w.id) ?? 0) > 0} count={pinCount.get(w.id) ?? 0} hours={pinnedHours.get(w.id) ?? 0} contractHours={w.contractHours ?? null} onClear={onClear} />)}
      </div>
    </div>
  );
}

function PoolCard({
  worker, pinned, count, hours, contractHours, onClear,
}: {
  worker: TitulaireWorker;
  pinned: boolean;
  count: number;
  hours: number;
  contractHours: number | null;
  onClear: (workerId: string) => void;
}) {
  const { t } = useTranslation("objectif");
  const dragData: DragData = { kind: "pool", workerId: worker.id };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pool-${worker.id}`,
    data: dragData,
  });
  const color = getWorkerColor(worker.id);
  const tier = getWorkerTier(worker.id);
  const ending = worker.staleness === "contract_ending";
  const [warnOpen, setWarnOpen] = useState(false);
  const pinnedTitle = pinned
    ? (contractHours != null
        ? t("titulaires.card.pinnedTitleWithContract", { count, hours: hours.toFixed(0), contract: contractHours })
        : t("titulaires.card.pinnedTitle", { count, hours: hours.toFixed(0) }))
    : worker.name;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "relative inline-flex items-center gap-[var(--space-xs)] px-[var(--space-sm)] py-[6px] rounded-full border cursor-grab active:cursor-grabbing select-none",
        color.bg, color.border, color.text,
        isDragging && "opacity-30",
        ending && "ring-2 ring-orange-500",
      )}
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.4)" }}
      title={pinnedTitle}
    >
      {tier !== "worker" && <ChefCrown faded={tier === "sous-chef"} />}
      <span className="text-[length:var(--text-xs)] font-bold leading-none">{worker.name}</span>
      {worker.subRoles[0] && (
        <span className="text-[length:9px] opacity-70">· {worker.subRoles[0]}</span>
      )}
      {pinned && (
        <span className={cn(
          "inline-flex items-center gap-[2px] px-[5px] h-[16px] rounded-full text-white text-[length:9px] font-bold",
          contractHours != null && hours > contractHours + 0.5 ? "bg-red-500" : "bg-amber-500",
        )}>
          <span>{count}</span>
          <span className="opacity-80">·</span>
          <span className="tabular-nums">{hours.toFixed(0)}h</span>
        </span>
      )}
      {ending && (
        <button
          type="button"
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); setWarnOpen(o => !o); }}
          className="inline-flex items-center justify-center size-4 rounded-full bg-orange-500 text-white hover:bg-orange-600 transition-colors"
          title={t("titulaires.card.viewReason")}
          aria-label={t("titulaires.card.viewAlert")}
        >
          <AlertTriangle className="size-2.5" />
        </button>
      )}
      {warnOpen && ending && (
        <div
          className="absolute z-50 top-full left-0 mt-1 w-56 rounded-md border border-orange-500/40 bg-popover text-popover-foreground p-2 shadow-lg space-y-1"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="text-[length:var(--text-2xs)] font-bold uppercase tracking-wide text-orange-600">{t("titulaires.card.endingTitle")}</p>
          <p className="text-[length:var(--text-xs)] leading-snug">
            {worker.staleness ? stalenessLabel(t, worker.staleness, worker.contractEndDate) : ""}
          </p>
          <p className="text-[length:9px] text-muted-foreground leading-snug">
            {worker.contractType ? `${worker.contractType} · ` : ""}{worker.name}
          </p>
          <button
            type="button"
            onClick={() => setWarnOpen(false)}
            className="text-[length:9px] text-muted-foreground hover:text-foreground underline"
          >
            {t("titulaires.card.close")}
          </button>
        </div>
      )}
      {pinned && (
        <button
          type="button"
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onClear(worker.id); }}
          className="ml-1 inline-flex items-center justify-center size-4 rounded-full bg-foreground/10 hover:bg-red-500 hover:text-white transition-colors"
          title={t("titulaires.card.removeAll")}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function StackGrid({
  zoneRows, activeDays, pinned, workersById, draggedWorker, onRemove,
}: {
  zoneRows: ZoneRow[];
  activeDays: number[];
  pinned: Map<string, PinnedSlot[]>;
  workersById: Map<string, TitulaireWorker>;
  draggedWorker: TitulaireWorker | null;
  onRemove: (workerId: string, dow: number, zone: string, role: "kitchen" | "floor") => void;
}) {
  // Mirror /schedule stack-view structure: rotated zone-label sticky column on the left,
  // 7 day columns. Each cell stacks cuisine on top + salle on bottom.
  return (
    <div className="border border-border rounded-md overflow-x-auto bg-card">
      <div
        className="grid"
        style={{ gridTemplateColumns: `28px repeat(${activeDays.length}, minmax(140px, 1fr))` }}
      >
        {/* Header row */}
        <div className="bg-muted border-b border-r border-border" />
        {activeDays.map(dow => (
          <div key={dow} className="bg-muted border-b border-r border-border last:border-r-0 text-center px-[var(--space-xs)] py-[var(--space-xs)]">
            <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-wide hidden md:block">{JOURS[dow % 7]}</p>
            <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-wide md:hidden">{JOURS_COURTS[dow % 7]}</p>
          </div>
        ))}
        {/* Zone rows */}
        {zoneRows.map((row, ri) => (
          <ZoneRowView
            key={row.zone}
            row={row}
            activeDays={activeDays}
            pinned={pinned}
            workersById={workersById}
            draggedWorker={draggedWorker}
            onRemove={onRemove}
            isLast={ri === zoneRows.length - 1}
            isFirst={ri === 0}
          />
        ))}
      </div>
    </div>
  );
}

function ZoneRowView({
  row, activeDays, pinned, workersById, draggedWorker, onRemove, isLast, isFirst,
}: {
  row: ZoneRow;
  activeDays: number[];
  pinned: Map<string, PinnedSlot[]>;
  workersById: Map<string, TitulaireWorker>;
  draggedWorker: TitulaireWorker | null;
  onRemove: (workerId: string, dow: number, zone: string, role: "kitchen" | "floor") => void;
  isLast: boolean;
  isFirst: boolean;
}) {
  return (
    <>
      {/* Sticky vertical zone label, mirrors /schedule stack view */}
      <div
        className={cn(
          "sticky left-0 z-20 flex items-center justify-center bg-muted/40 border-r border-border",
          !isLast && "border-b",
          !isFirst && "border-t border-t-border/60",
        )}
      >
        <span
          className="text-[length:var(--text-2xs)] font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap"
          style={{ writingMode: "vertical-lr", transform: "rotate(180deg)" }}
          title={`${row.zone} · ${row.startTime}–${row.endTime}`}
        >
          {row.zone.toUpperCase()}
        </span>
      </div>
      {/* Day cells */}
      {activeDays.map(dow => (
        <ZoneDayCell
          key={dow}
          row={row}
          dow={dow}
          pinned={pinned}
          workersById={workersById}
          draggedWorker={draggedWorker}
          onRemove={onRemove}
          isLast={isLast}
        />
      ))}
    </>
  );
}

type PinnedSlot = { workerId: string; subRole?: string | null };

function ZoneDayCell({
  row, dow, pinned, workersById, draggedWorker, onRemove, isLast,
}: {
  row: ZoneRow;
  dow: number;
  pinned: Map<string, PinnedSlot[]>;
  workersById: Map<string, TitulaireWorker>;
  draggedWorker: TitulaireWorker | null;
  onRemove: (workerId: string, dow: number, zone: string, role: "kitchen" | "floor") => void;
  isLast: boolean;
}) {
  const kSide = row.kitchen;
  const sSide = row.floor;
  const kDemand = kSide?.demandByDow.get(dow) ?? [];
  const sDemand = sSide?.demandByDow.get(dow) ?? [];
  const isClosed = kDemand.length === 0 && sDemand.length === 0;
  if (isClosed) {
    return (
      <div className={cn(
        "border-r border-border last:border-r-0 px-[var(--space-xs)] py-[var(--space-xs)] bg-muted/10",
        !isLast && "border-b",
      )}>
        <p className="text-[length:9px] text-muted-foreground/60 italic text-center py-[var(--space-sm)]">—</p>
      </div>
    );
  }
  return (
    <div className={cn(
      "border-r border-border last:border-r-0 flex flex-col gap-[var(--space-xs)] p-[var(--space-xs)]",
      !isLast && "border-b",
    )}>
      {/* Cuisine stack on top */}
      {kSide && (
        <RoleStackSide
          side={kSide}
          dow={dow}
          pinnedSlots={pinned.get(dropKey(dow, row.zone, "kitchen")) ?? []}
          workersById={workersById}
          draggedWorker={draggedWorker}
          onRemove={onRemove}
        />
      )}
      {/* Salle stack on bottom */}
      {sSide && (
        <RoleStackSide
          side={sSide}
          dow={dow}
          pinnedSlots={pinned.get(dropKey(dow, row.zone, "floor")) ?? []}
          workersById={workersById}
          draggedWorker={draggedWorker}
          onRemove={onRemove}
        />
      )}
    </div>
  );
}

function RoleStackSide({
  side, dow, pinnedSlots, workersById, draggedWorker, onRemove,
}: {
  side: ZoneSide;
  dow: number;
  pinnedSlots: PinnedSlot[];
  workersById: Map<string, TitulaireWorker>;
  draggedWorker: TitulaireWorker | null;
  onRemove: (workerId: string, dow: number, zone: string, role: "kitchen" | "floor") => void;
}) {
  const { t } = useTranslation("objectif");
  const id = dropKey(dow, side.zone, side.role);
  const { setNodeRef, isOver } = useDroppable({ id });
  const demand = side.demandByDow.get(dow) ?? [];
  const dropClass = (() => {
    if (!isOver || !draggedWorker) return "";
    if (draggedWorker.role !== side.role) return "ring-1 ring-inset ring-red-500 bg-red-500/10";
    const exact = demand.some(sub => draggedWorker.subRoles.includes(sub));
    const eligible = demand.some(sub => subRoleSubstitution(sub, draggedWorker.subRoles).eligible);
    if (exact) return "ring-1 ring-inset ring-green-500 bg-green-500/10";
    if (eligible) return "ring-1 ring-inset ring-amber-500 bg-amber-500/10";
    return "ring-1 ring-inset ring-red-500 bg-red-500/10";
  })();
  // Slot views: indexed array, length = demand.length.
  // Pass A: pinned with explicit subRole — placed into matching demand slots in order.
  // Pass B: remaining pinned — best-match algorithm (exact → substitution → any leftover).
  // Overflow pinned (more pins than slots) appended with default sub-role.
  type SlotView = { kind: "filled"; workerId: string; assignedSubRole: string } | { kind: "ghost"; subRole: string };
  const slotViews: Array<SlotView | null> = new Array(demand.length).fill(null);
  const usedDemandIdx = new Set<number>();

  const explicit: PinnedSlot[] = [];
  const implicit: PinnedSlot[] = [];
  for (const p of pinnedSlots) {
    if (p.subRole) explicit.push(p); else implicit.push(p);
  }

  // Pass A
  for (const p of explicit) {
    const w = workersById.get(p.workerId);
    if (!w) continue;
    const idx = demand.findIndex((sub, i) => sub === p.subRole && !usedDemandIdx.has(i));
    if (idx >= 0) {
      slotViews[idx] = { kind: "filled", workerId: w.id, assignedSubRole: demand[idx] };
      usedDemandIdx.add(idx);
    } else {
      // Explicit subRole has no matching slot left — fall back to best-match in pass B.
      implicit.push(p);
    }
  }

  // Pass B
  const remainingWorkers = implicit
    .map(p => workersById.get(p.workerId))
    .filter((w): w is TitulaireWorker => w != null);
  const orphanIds = implicit.filter(p => !workersById.has(p.workerId)).map(p => p.workerId);
  for (let i = 0; i < demand.length; i++) {
    if (usedDemandIdx.has(i)) continue;
    const sub = demand[i];
    let widx = remainingWorkers.findIndex(w => w.subRoles.includes(sub));
    if (widx === -1) widx = remainingWorkers.findIndex(w => subRoleSubstitution(sub, w.subRoles).eligible);
    if (widx === -1 && remainingWorkers.length > 0) widx = 0;
    if (widx >= 0) {
      const w = remainingWorkers.splice(widx, 1)[0];
      slotViews[i] = { kind: "filled", workerId: w.id, assignedSubRole: sub };
    } else {
      slotViews[i] = { kind: "ghost", subRole: sub };
    }
  }

  const finalViews: SlotView[] = slotViews.filter((v): v is SlotView => v != null);
  for (const w of remainingWorkers) {
    finalViews.push({ kind: "filled", workerId: w.id, assignedSubRole: side.role === "kitchen" ? "Cuisinier" : "Serveur" });
  }
  for (const wId of orphanIds) {
    finalViews.push({ kind: "filled", workerId: wId, assignedSubRole: side.role === "kitchen" ? "Cuisinier" : "Serveur" });
  }
  // Match /schedule stack visual: small role label pill (KITCHEN/SALLE color) above the stack.
  const labelClass = side.role === "kitchen"
    ? cn(KITCHEN_LABEL.bg, KITCHEN_LABEL.border, KITCHEN_LABEL.text)
    : cn(FLOOR_LABEL.bg, FLOOR_LABEL.border, FLOOR_LABEL.text);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-sm p-[2px] flex flex-col gap-[2px] transition-colors min-h-[var(--space-md)]",
        dropClass,
      )}
    >
      <div className="flex items-center justify-between gap-[var(--space-xs)] px-[2px]">
        <span className={cn(
          "inline-flex items-center px-[var(--space-xs)] rounded-full text-[length:9px] font-bold uppercase tracking-widest border",
          labelClass,
        )}>
          {t(side.role === "kitchen" ? "shared.kitchen" : "shared.floor")}
        </span>
        <span className="text-[length:9px] text-muted-foreground tabular-nums">{side.startTime}–{side.endTime}</span>
      </div>
      {finalViews.map((s, i) => {
        const slotSubRole = s.kind === "filled" ? s.assignedSubRole : s.subRole;
        return (
          <SlotDroppable
            key={s.kind === "filled" ? `f-${i}-${s.workerId}` : `g-${i}-${s.subRole}`}
            dow={dow}
            zone={side.zone}
            role={side.role}
            slotIdx={i}
            subRole={slotSubRole}
            draggedWorker={draggedWorker}
          >
            {s.kind === "filled"
              ? <PinnedCard
                  worker={workersById.get(s.workerId)!}
                  dow={dow}
                  zone={side.zone}
                  role={side.role}
                  assignedSubRole={s.assignedSubRole}
                  onRemove={() => onRemove(s.workerId, dow, side.zone, side.role)}
                />
              : <GhostCard subRole={s.subRole} />}
          </SlotDroppable>
        );
      })}
    </div>
  );
}

function SlotDroppable({
  dow, zone, role, slotIdx, subRole, draggedWorker, children,
}: {
  dow: number;
  zone: string;
  role: "kitchen" | "floor";
  slotIdx: number;
  subRole: string;
  draggedWorker: TitulaireWorker | null;
  children: React.ReactNode;
}) {
  const id = `slot|${dow}|${zone}|${role}|${slotIdx}|${subRole}`;
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { kind: "slot", dow, zone, role, subRole, slotIdx },
  });
  const ringClass = (() => {
    if (!isOver || !draggedWorker) return "";
    if (draggedWorker.role !== role) return "ring-1 ring-inset ring-red-500";
    if (draggedWorker.subRoles.includes(subRole)) return "ring-1 ring-inset ring-green-500";
    if (subRoleSubstitution(subRole, draggedWorker.subRoles).eligible) return "ring-1 ring-inset ring-amber-500";
    return "ring-1 ring-inset ring-red-500";
  })();
  return (
    <div ref={setNodeRef} className={cn("rounded-[1.2rem] transition-shadow", ringClass)}>
      {children}
    </div>
  );
}

function PinnedCard({
  worker, dow, zone, role, assignedSubRole, isOverlay, onRemove,
}: {
  worker: TitulaireWorker;
  dow?: number;
  zone?: string;
  role?: "kitchen" | "floor";
  assignedSubRole?: string;
  isOverlay?: boolean;
  onRemove?: () => void;
}) {
  const { t } = useTranslation("objectif");
  const dragData: DragData | undefined = (dow != null && zone != null && role != null)
    ? { kind: "pinned", workerId: worker.id, dow, zone, role }
    : undefined;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragData ? `pinned-${worker.id}-${dow}-${zone}-${role}` : `overlay-${worker.id}`,
    data: dragData,
    disabled: isOverlay,
  });
  const color = getWorkerColor(worker.id);
  const tier = getWorkerTier(worker.id);
  const stale = worker.staleness;
  const isSubstitution = assignedSubRole != null && worker.subRoles.length > 0 && !worker.subRoles.includes(assignedSubRole);
  const isWrongRole = assignedSubRole != null && !subRoleSubstitution(assignedSubRole, worker.subRoles).eligible;
  const subLabel = (assignedSubRole ?? worker.subRoles[0]) ?? null;
  const rolesLabel = worker.subRoles.join(", ") || t("titulaires.tooltip.noSubRoles");
  const wrongRoleReason = t("titulaires.tooltip.subRoleNotCovered", { sub: assignedSubRole, roles: rolesLabel });
  const substitutionReason = t("titulaires.tooltip.substitution", { sub: assignedSubRole, roles: worker.subRoles.join(", ") });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "relative w-full flex flex-row items-center justify-center gap-[var(--space-xs)] rounded-[1.2rem] border px-[var(--space-sm)] py-[3px] transition-all select-none",
        color.bg, color.border, color.text,
        !isOverlay && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-30",
        stale && "ring-2 ring-red-500",
        !stale && isWrongRole && "ring-2 ring-red-500",
        !stale && !isWrongRole && isSubstitution && "ring-2 ring-amber-400",
      )}
      style={{
        boxShadow: "0 1px 2px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.06)",
      }}
      title={
        stale ? stalenessLabel(t, stale, worker.contractEndDate)
        : isWrongRole ? wrongRoleReason
        : isSubstitution ? substitutionReason
        : worker.name
      }
    >
      <span className="inline-flex items-center gap-[2px] text-[length:var(--text-2xs)] font-bold tracking-wide leading-tight">
        {tier !== "worker" && <ChefCrown faded={tier === "sous-chef"} />}
        {shortName(worker.name)}
      </span>
      {subLabel && (
        <span className="inline-flex items-center px-1.5 py-px rounded-full bg-black/10 dark:bg-white/15 text-[8px] font-medium leading-none whitespace-nowrap">
          {abbreviate(subLabel)}
        </span>
      )}
      {(stale || isWrongRole) && (
        <WarningBadge
          variant="red"
          reason={stale ? stalenessLabel(t, stale, worker.contractEndDate) : wrongRoleReason}
        />
      )}
      {onRemove && !isOverlay && (
        <button
          type="button"
          onPointerDown={(e) => { e.stopPropagation(); }}
          onMouseDown={(e) => { e.stopPropagation(); }}
          onTouchStart={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="inline-flex items-center justify-center size-[14px] rounded-full bg-black/10 dark:bg-white/15 hover:bg-red-500 hover:text-white transition-colors shrink-0 cursor-pointer"
          title={t("titulaires.card.removeShift")}
          aria-label={t("titulaires.card.removeShift")}
        >
          <X className="size-2.5" />
        </button>
      )}
      {!stale && !isWrongRole && isSubstitution && (
        <WarningBadge
          variant="amber"
          reason={t("titulaires.tooltip.substitutionVerbose", { name: worker.name, roles: rolesLabel, sub: assignedSubRole })}
        />
      )}
    </div>
  );
}

function WarningBadge({ variant, reason }: { variant: "red" | "amber"; reason: string }) {
  const { t } = useTranslation("objectif");
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: r.right - 220 });
    setOpen(true);
  };

  const cls = variant === "red"
    ? "bg-red-500 text-white"
    : "bg-amber-500 text-white text-[9px] font-bold";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        onPointerDown={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        className={cn(
          "absolute top-1 right-1.5 z-10 inline-flex items-center justify-center size-[14px] rounded-full cursor-pointer hover:scale-110 transition-transform",
          cls,
        )}
        aria-label={t("titulaires.card.viewWarning")}
      >
        {variant === "red" ? <AlertTriangle className="size-2.5" /> : <span>↻</span>}
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="fixed z-[10000] w-[220px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-[var(--space-sm)] text-[length:var(--text-xs)] leading-relaxed"
          style={{ top: pos.top, left: Math.max(8, pos.left) }}
          onMouseDown={stop}
          onPointerDown={stop}
        >
          <div className="flex items-start gap-[var(--space-xs)]">
            <span className={cn(
              "inline-flex items-center justify-center size-[14px] rounded-full shrink-0 mt-[2px]",
              variant === "red" ? "bg-red-500 text-white" : "bg-amber-500 text-white",
            )}>
              {variant === "red" ? <AlertTriangle className="size-2.5" /> : <span className="text-[9px] font-bold leading-none">↻</span>}
            </span>
            <span className="flex-1">{reason}</span>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function GhostCard({ subRole }: { subRole: string }) {
  const { t } = useTranslation("objectif");
  return (
    <div
      className="relative w-full flex items-center justify-center rounded-[1.2rem] border border-dashed bg-red-500/5 border-red-500/40 text-red-700 dark:text-red-300 px-[var(--space-sm)] py-[3px]"
      title={t("titulaires.tooltip.subRoleMissing", { sub: subRole })}
    >
      <span className="inline-flex items-center px-1.5 py-px rounded-full bg-red-500/15 border border-red-500/30 text-[8px] font-bold uppercase tracking-widest leading-none">
        {abbreviate(subRole)}
      </span>
    </div>
  );
}

function ConformitePanel({
  verdict,
}: {
  verdict: { totalDemandSlots: number; pinnedSlots: number; totalDemandHours: number; totalCapacity: number; capacityRatio: number; fillRate: number; overloaded: Array<{ workerId: string; name: string; pinned: number; contract: number }>; stalePinned: number; substitutions: number; level: "ok" | "tendu" | "insuffisant" };
}) {
  const { t } = useTranslation("objectif");
  const verdictMeta: Record<typeof verdict.level, { label: string; cls: string }> = {
    ok: { label: t("titulaires.verdict.ok"), cls: "bg-green-500 text-white" },
    tendu: { label: t("titulaires.verdict.tendu"), cls: "bg-amber-500 text-white" },
    insuffisant: { label: t("titulaires.verdict.insuffisant"), cls: "bg-red-500 text-white" },
  };
  const v = verdictMeta[verdict.level];
  return (
    <div className="border border-border rounded-md p-[var(--space-md)] space-y-[var(--space-sm)]">
      <div className="flex items-center gap-[var(--space-sm)]">
        <p className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground">{t("titulaires.verdict.header")}</p>
        <span className={cn("inline-flex items-center px-[var(--space-sm)] py-[2px] rounded-full text-[length:var(--text-2xs)] font-bold uppercase tracking-widest", v.cls)}>{v.label}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-[var(--space-sm)] text-[length:var(--text-xs)]">
        <Stat label={t("titulaires.verdict.slotsPinned")} value={`${verdict.pinnedSlots} / ${verdict.totalDemandSlots}`} tone={verdict.fillRate < 0.7 ? "bad" : verdict.fillRate < 0.95 ? "warn" : "good"} />
        <Stat label={t("titulaires.verdict.capacity")} value={`${verdict.totalCapacity.toFixed(0)} h`} />
        <Stat label={t("titulaires.verdict.demand")} value={`${verdict.totalDemandHours.toFixed(0)} h`} />
        <Stat label={t("titulaires.verdict.coverageHours")} value={`${Math.round(verdict.capacityRatio * 100)}%`} tone={verdict.capacityRatio < 0.85 ? "bad" : verdict.capacityRatio < 1.0 ? "warn" : "good"} />
        <Stat label={t("titulaires.verdict.substitutions")} value={`${verdict.substitutions}`} tone={verdict.substitutions > 0 ? "warn" : undefined} />
      </div>
      {verdict.overloaded.length > 0 && (
        <div className="text-[length:var(--text-xs)]">
          <p className="text-muted-foreground mb-[2px]">{t("titulaires.verdict.overContract")}</p>
          <div className="flex flex-wrap gap-[4px]">
            {verdict.overloaded.map(o => (
              <span key={o.workerId} className="inline-flex items-center gap-1 px-[var(--space-sm)] py-[2px] rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30 text-[length:var(--text-2xs)]">
                {t("titulaires.verdict.overContractItem", { name: o.name, pinned: o.pinned.toFixed(0), contract: o.contract })}
              </span>
            ))}
          </div>
        </div>
      )}
      {verdict.stalePinned > 0 && (
        <p className="text-[length:var(--text-xs)] text-red-700 dark:text-red-400 inline-flex items-center gap-1">
          <AlertTriangle className="size-3" /> {t("titulaires.verdict.stale", { count: verdict.stalePinned })}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className={cn(
        "font-bold",
        tone === "bad" && "text-red-600",
        tone === "warn" && "text-amber-600",
        tone === "good" && "text-green-600",
      )}>{value}</p>
    </div>
  );
}

function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}

function abbreviate(subRole: string): string {
  const map: Record<string, string> = { "Sous-chef": "S.Chef", "Sous-chef de rang": "S.C.Rang", "Chef de rang": "C.Rang" };
  return map[subRole] ?? (subRole.length <= 10 ? subRole : subRole.slice(0, 9) + ".");
}
