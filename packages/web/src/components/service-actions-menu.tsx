import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Settings, Pencil, Trash2, ArrowLeftRight, Sparkles, UserSquare, Users } from "lucide-react";
import { toast } from "sonner";
import { api, type ServiceRow, type User } from "@/lib/api";
import { cn, shortName } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type SwapMode = "solver" | "subrole" | "role";

type Candidate = { id: string; name: string; score: number; reasons: string[] };

// 4-state status combining sub-role match and same-day availability.
// Workers are pre-filtered by role, so role is always correct here.
type CandidateStatus =
  | "match-free"   // sub-role match + available  → green
  | "norole-free"  // no sub-role match + available → grey
  | "match-busy"   // sub-role match + already on a shift → orange
  | "norole-busy"; // no sub-role match + already on a shift → red

export function ServiceActionsMenu({
  service,
  workers,
  assignedSubRole,
  daySchedule,
  onChanged,
  forceOpt,
  open,
  onOpenChange,
  onSelectClose,
  triggerVariant = "gear",
  triggerStyle,
}: {
  service: ServiceRow;
  workers: User[];
  assignedSubRole?: string;
  daySchedule?: ServiceRow[]; // all services for service.date — used to flag busy workers
  onChanged: () => void | Promise<void>;
  forceOpt?: () => { force?: boolean } | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Close only the dropdown popup after a menu item is selected, while keeping this component mounted for its dialogs. */
  onSelectClose?: () => void;
  triggerVariant?: "gear" | "anchor";
  triggerStyle?: CSSProperties;
}) {
  const { t } = useTranslation("schedule");
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [swapMode, setSwapMode] = useState<SwapMode | null>(null);

  const role = (service.workerRole || service.role) as "kitchen" | "floor";
  const fopts = forceOpt?.();
  const closeForSelection = () => {
    onSelectClose?.();
    onOpenChange?.(false);
  };

  const handleDelete = async () => {
    try {
      await api.deleteService(service.id, fopts);
      toast.success(t("actionsMenu.toasts.deleted", { name: shortName(service.workerName) }));
      setDeleteOpen(false);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionsMenu.toasts.deleteFailed"));
    }
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={(nextOpen) => onOpenChange?.(nextOpen)}>
        <DropdownMenuTrigger
          nativeButton={false}
          render={(props) => (
            <span
              {...props}
              role="button"
              tabIndex={0}
              onPointerDown={(e: React.PointerEvent) => {
                e.stopPropagation();
                props.onPointerDown?.(e);
              }}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                props.onClick?.(e);
              }}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  (e.currentTarget as HTMLElement).click();
                }
                props.onKeyDown?.(e);
              }}
              aria-label={t("actionsMenu.trigger")}
              style={triggerStyle}
              className={triggerVariant === "anchor"
                ? "fixed size-[1px] opacity-0 pointer-events-none"
                : "inline-flex items-center justify-center size-[20px] rounded-full bg-black/10 dark:bg-white/15 hover:bg-black/20 dark:hover:bg-white/25 transition-colors text-current cursor-pointer select-none"}
            >
              {triggerVariant === "gear" && <Settings className="size-[12px]" strokeWidth={2.5} />}
            </span>
          )}
        />
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={triggerVariant === "anchor" ? -1 : 4}
          className="min-w-[160px]"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowLeftRight className="size-3.5" />
              {t("actionsMenu.swap")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => { closeForSelection(); setTimeout(() => setSwapMode("solver"), 0); }}>
                <Sparkles className="size-3.5" />
                {t("actionsMenu.solver")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { closeForSelection(); setTimeout(() => setSwapMode("subrole"), 0); }} disabled={!assignedSubRole}>
                <UserSquare className="size-3.5" />
                {assignedSubRole ? t("actionsMenu.subRoleWith", { name: assignedSubRole }) : t("actionsMenu.subRoleEmpty")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { closeForSelection(); setTimeout(() => setSwapMode("role"), 0); }}>
                <Users className="size-3.5" />
                {role === "kitchen" ? t("actionsMenu.allKitchen") : t("actionsMenu.allFloor")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => { closeForSelection(); setTimeout(() => setEditOpen(true), 0); }}>
            <Pencil className="size-3.5" />
            {t("actionsMenu.edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => { closeForSelection(); setTimeout(() => setDeleteOpen(true), 0); }}>
            <Trash2 className="size-3.5" />
            {t("actionsMenu.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditTimeDialog
        open={editOpen}
        service={service}
        onClose={() => setEditOpen(false)}
        onSaved={async () => { setEditOpen(false); await onChanged(); }}
        forceOpt={forceOpt}
      />

      <Dialog open={deleteOpen} onOpenChange={(o) => !o && setDeleteOpen(false)}>
        <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("actionsMenu.deleteService.title")}</DialogTitle>
            <DialogDescription>
              {shortName(service.workerName)} — {fmtDate(service.date)} · {service.startTime.slice(0,5)}–{service.endTime.slice(0,5)}
              <br />{t("actionsMenu.deleteService.irreversible")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setDeleteOpen(false)}>{t("actionsMenu.deleteService.cancel")}</Button>
            <Button size="sm" variant="destructive" onClick={handleDelete}>{t("actionsMenu.deleteService.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {swapMode && (
        <SwapDialog
          mode={swapMode}
          service={service}
          workers={workers}
          assignedSubRole={assignedSubRole}
          daySchedule={daySchedule}
          onClose={() => setSwapMode(null)}
          onSwapped={async () => { setSwapMode(null); await onChanged(); }}
          forceOpt={forceOpt}
        />
      )}
    </>
  );
}

function EditTimeDialog({
  open,
  service,
  onClose,
  onSaved,
  forceOpt,
}: {
  open: boolean;
  service: ServiceRow;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  forceOpt?: () => { force?: boolean } | undefined;
}) {
  const { t } = useTranslation("schedule");
  const [start, setStart] = useState(service.startTime.slice(0, 5));
  const [end, setEnd] = useState(service.endTime.slice(0, 5));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const unchanged = start === service.startTime.slice(0, 5) && end === service.endTime.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t("actionsMenu.editTime.title")}</DialogTitle>
          <DialogDescription>
            {shortName(service.workerName)} — {fmtDate(service.date)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-[var(--space-md)] py-[var(--space-sm)]">
          <label className="space-y-[var(--space-xs)]">
            <span className="text-[length:var(--text-xs)] font-bold tracking-wide uppercase text-muted-foreground">{t("actionsMenu.editTime.startLabel")}</span>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full h-[var(--space-xl)] px-[var(--space-sm)] rounded-md border border-foreground/15 bg-background font-mono text-[length:var(--text-sm)]"
            />
          </label>
          <label className="space-y-[var(--space-xs)]">
            <span className="text-[length:var(--text-xs)] font-bold tracking-wide uppercase text-muted-foreground">{t("actionsMenu.editTime.endLabel")}</span>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full h-[var(--space-xl)] px-[var(--space-sm)] rounded-md border border-foreground/15 bg-background font-mono text-[length:var(--text-sm)]"
            />
          </label>
        </div>
        {error && <p className="text-[length:var(--text-xs)] text-destructive font-bold">{error}</p>}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>{t("actionsMenu.editTime.cancel")}</Button>
          <Button
            size="sm"
            disabled={saving || !start || !end || unchanged}
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                await api.updateService(service.id, { startTime: start, endTime: end }, forceOpt?.());
                await onSaved();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("actionsMenu.toasts.saveFailed"));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "..." : t("actionsMenu.editTime.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SwapDialog({
  mode,
  service,
  workers,
  assignedSubRole,
  daySchedule,
  onClose,
  onSwapped,
  forceOpt,
}: {
  mode: SwapMode;
  service: ServiceRow;
  workers: User[];
  assignedSubRole?: string;
  daySchedule?: ServiceRow[];
  onClose: () => void;
  onSwapped: () => void | Promise<void>;
  forceOpt?: () => { force?: boolean } | undefined;
}) {
  const { t } = useTranslation("schedule");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [swappingId, setSwappingId] = useState<string | null>(null);

  const role = (service.workerRole || service.role) as "kitchen" | "floor";

  useEffect(() => {
    if (mode !== "solver") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.findReplacementCandidates(service.id)
      .then((res) => { if (!cancelled) setCandidates(res.data.candidates.slice(0, 3)); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t("actionsMenu.toasts.solverFailed")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, service.id, t]);

  // Build the worker list shown for subrole / role modes
  const filteredWorkers = (() => {
    if (mode === "subrole" && assignedSubRole) {
      return workers.filter((w) =>
        w.role === role &&
        w.id !== service.workerId &&
        (w.subRoles?.includes(assignedSubRole) || w.subRole === assignedSubRole)
      );
    }
    if (mode === "role") {
      return workers.filter((w) => w.role === role && w.id !== service.workerId);
    }
    return [];
  })();

  const title = {
    solver: t("actionsMenu.swapDialog.solverTitle"),
    subrole: assignedSubRole ? t("actionsMenu.swapDialog.subRoleTitleWith", { name: assignedSubRole }) : t("actionsMenu.swapDialog.subRoleTitle"),
    role: role === "kitchen" ? t("actionsMenu.swapDialog.allKitchenTitle") : t("actionsMenu.swapDialog.allFloorTitle"),
  }[mode];

  // Build a "busy this day" lookup: workerId → true if they have a service that overlaps service's time.
  // Used to flag conflicts (red status) so the admin sees which workers are already booked.
  const busyMap = (() => {
    const m = new Map<string, boolean>();
    if (!daySchedule) return m;
    const sStart = service.startTime;
    const sEnd = service.endTime;
    for (const ds of daySchedule) {
      if (ds.id === service.id) continue;
      if (ds.date !== service.date) continue;
      // Overlap: max(start) < min(end)
      const overlap = ds.startTime < sEnd && sStart < ds.endTime;
      if (overlap) m.set(ds.workerId, true);
    }
    return m;
  })();

  const statusOf = (workerId: string): CandidateStatus => {
    const busy = !!busyMap.get(workerId);
    const w = workers.find((x) => x.id === workerId);
    const match = !!(
      assignedSubRole &&
      w &&
      (w.subRoles?.includes(assignedSubRole) || w.subRole === assignedSubRole)
    );
    if (match && !busy) return "match-free";
    if (!match && !busy) return "norole-free";
    if (match && busy) return "match-busy";
    return "norole-busy";
  };

  const handleSwap = async (newWorkerId: string, newWorkerName: string) => {
    setSwappingId(newWorkerId);
    try {
      await api.moveService({ serviceId: service.id, newWorkerId }, forceOpt?.());
      toast.success(t("actionsMenu.toasts.swapped", { from: shortName(service.workerName), to: shortName(newWorkerName) }));
      await onSwapped();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionsMenu.toasts.swapFailed"));
    } finally {
      setSwappingId(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("actionsMenu.swapDialog.description", {
              name: shortName(service.workerName),
              date: fmtDate(service.date),
              start: service.startTime.slice(0,5),
              end: service.endTime.slice(0,5),
            })}
          </DialogDescription>
        </DialogHeader>

        <CandidateLegend assignedSubRole={assignedSubRole} />

        <div className="max-h-[50vh] overflow-y-auto space-y-1 py-[var(--space-xs)]">
          {mode === "solver" && loading && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("actionsMenu.swapDialog.calculating")}</p>
          )}
          {mode === "solver" && error && (
            <p className="text-sm text-destructive py-4 text-center">{error}</p>
          )}
          {mode === "solver" && candidates && candidates.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("actionsMenu.swapDialog.noCandidates")}</p>
          )}
          {mode === "solver" && candidates?.map((c, i) => (
            <CandidateRow
              key={c.id}
              rank={i + 1}
              workerId={c.id}
              name={c.name}
              score={c.score}
              reasons={c.reasons}
              subRoles={workers.find((w) => w.id === c.id)?.subRoles}
              status={statusOf(c.id)}
              loading={swappingId === c.id}
              onSelect={() => handleSwap(c.id, c.name)}
            />
          ))}

          {(mode === "subrole" || mode === "role") && filteredWorkers.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("actionsMenu.swapDialog.noEligible")}</p>
          )}
          {(mode === "subrole" || mode === "role") && filteredWorkers.map((w) => (
            <CandidateRow
              key={w.id}
              workerId={w.id}
              name={w.name}
              subRoles={w.subRoles}
              status={statusOf(w.id)}
              loading={swappingId === w.id}
              onSelect={() => handleSwap(w.id, w.name)}
            />
          ))}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>{t("actionsMenu.swapDialog.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  name,
  rank,
  score,
  reasons,
  subRoles,
  status,
  loading,
  onSelect,
}: {
  workerId: string;
  name: string;
  rank?: number;
  score?: number;
  reasons?: string[];
  subRoles?: string[];
  status: CandidateStatus;
  loading: boolean;
  onSelect: () => void;
}) {
  const statusClass = STATUS_CLASS[status];
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={loading}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 rounded-full border text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-95 dark:hover:brightness-110",
        statusClass,
      )}
    >
      {rank !== undefined && (
        <span className="shrink-0 inline-flex items-center justify-center size-5 rounded-full bg-foreground/15 text-[10px] font-bold tabular-nums">
          {rank}
        </span>
      )}
      <span className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="text-sm font-bold truncate">{name}</span>
        {(subRoles ?? []).map((sr) => (
          <span
            key={sr}
            className="inline-flex items-center px-1.5 py-px rounded-full bg-black/10 dark:bg-white/15 text-[9px] font-medium whitespace-nowrap"
          >
            {abbrevSubRole(sr)}
          </span>
        ))}
        {reasons && reasons.length > 0 && (
          <span className="text-[10px] opacity-75 truncate">{reasons.join(" · ")}</span>
        )}
      </span>
      {score !== undefined && (
        <span className="shrink-0 text-[10px] font-mono tabular-nums opacity-75">
          {score.toFixed(0)}
        </span>
      )}
    </button>
  );
}

const SUBROLE_ABBREV: Record<string, string> = {
  "Sous-chef": "S.Chef",
  "Sous-chef de rang": "S.C.Rang",
  "Chef de rang": "C.Rang",
};
function abbrevSubRole(raw: string): string {
  return SUBROLE_ABBREV[raw] ?? (raw.length <= 10 ? raw : raw.slice(0, 9) + ".");
}

const STATUS_CLASS: Record<CandidateStatus, string> = {
  "match-free":
    "bg-emerald-100 border-emerald-500 text-emerald-950 dark:bg-emerald-950/40 dark:border-emerald-500 dark:text-emerald-100",
  "norole-free":
    "bg-slate-100 border-slate-400 text-slate-900 dark:bg-slate-800/60 dark:border-slate-500 dark:text-slate-100",
  "match-busy":
    "bg-amber-100 border-amber-500 text-amber-950 dark:bg-amber-950/40 dark:border-amber-500 dark:text-amber-100",
  "norole-busy":
    "bg-red-100 border-red-500 text-red-950 dark:bg-red-950/40 dark:border-red-500 dark:text-red-100",
};

function CandidateLegend({ assignedSubRole }: { assignedSubRole?: string }) {
  const { t } = useTranslation("schedule");
  const subLabel = assignedSubRole ? `${assignedSubRole}` : t("actionsMenu.candidateLegend.subRoleFallback");
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-muted-foreground border-y border-border/50 py-1.5">
      <span className="inline-flex items-center gap-1">
        <span className="size-2 rounded-full bg-emerald-500 ring-1 ring-foreground/20" aria-hidden />
        {t("actionsMenu.candidateLegend.matchFree", { label: subLabel })}
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="size-2 rounded-full bg-amber-500 ring-1 ring-foreground/20" aria-hidden />
        {t("actionsMenu.candidateLegend.matchBusy", { label: subLabel })}
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="size-2 rounded-full bg-slate-400 ring-1 ring-foreground/20" aria-hidden />
        {t("actionsMenu.candidateLegend.otherFree")}
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="size-2 rounded-full bg-red-500 ring-1 ring-foreground/20" aria-hidden />
        {t("actionsMenu.candidateLegend.otherBusy")}
      </span>
    </div>
  );
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

// ──────────────────────────────────────────────────────────────────────
// Ghost (missing-staff) card actions menu
// ──────────────────────────────────────────────────────────────────────

export function GhostActionsMenu({
  date,
  role,
  startTime,
  endTime,
  zone,
  targetSubRole,
  workers,
  daySchedule,
  onChanged,
  forceOpt,
}: {
  date: string;
  role: "kitchen" | "floor";
  startTime: string;
  endTime: string;
  zone?: string;
  targetSubRole?: string;
  workers: User[];
  daySchedule?: ServiceRow[];
  onChanged: () => void | Promise<void>;
  forceOpt?: () => { force?: boolean } | undefined;
}) {
  const { t } = useTranslation("schedule");
  const [mode, setMode] = useState<"solver" | "subrole" | "role" | null>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          nativeButton={false}
          render={(props) => (
            <span
              {...props}
              role="button"
              tabIndex={0}
              onPointerDown={(e: React.PointerEvent) => { e.stopPropagation(); props.onPointerDown?.(e); }}
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); props.onClick?.(e); }}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  (e.currentTarget as HTMLElement).click();
                }
                props.onKeyDown?.(e);
              }}
              aria-label={t("actionsMenu.ghostTrigger")}
              className="inline-flex items-center justify-center size-[20px] rounded-full bg-white/30 hover:bg-white/50 text-red-700 dark:text-red-200 dark:bg-white/10 dark:hover:bg-white/20 transition-colors cursor-pointer select-none"
            >
              <Settings className="size-[12px]" strokeWidth={2.5} />
            </span>
          )}
        />
        <DropdownMenuContent
          align="start"
          side="bottom"
          className="min-w-[160px]"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowLeftRight className="size-3.5" />
              {t("actionsMenu.assign")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => setTimeout(() => setMode("solver"), 0)}>
                <Sparkles className="size-3.5" />
                {t("actionsMenu.solver")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setTimeout(() => setMode("subrole"), 0)}
                disabled={!targetSubRole}
              >
                <UserSquare className="size-3.5" />
                {targetSubRole ? t("actionsMenu.subRoleWith", { name: targetSubRole }) : t("actionsMenu.subRoleEmpty")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTimeout(() => setMode("role"), 0)}>
                <Users className="size-3.5" />
                {role === "kitchen" ? t("actionsMenu.allKitchen") : t("actionsMenu.allFloor")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      {mode && (
        <AssignDialog
          mode={mode}
          date={date}
          role={role}
          startTime={startTime}
          endTime={endTime}
          zone={zone}
          targetSubRole={targetSubRole}
          workers={workers}
          daySchedule={daySchedule}
          onClose={() => setMode(null)}
          onAssigned={async () => { setMode(null); await onChanged(); }}
          forceOpt={forceOpt}
        />
      )}
    </>
  );
}

function AssignDialog({
  mode,
  date,
  role,
  startTime,
  endTime,
  zone,
  targetSubRole,
  workers,
  daySchedule,
  onClose,
  onAssigned,
  forceOpt,
}: {
  mode: "solver" | "subrole" | "role";
  date: string;
  role: "kitchen" | "floor";
  startTime: string;
  endTime: string;
  zone?: string;
  targetSubRole?: string;
  workers: User[];
  daySchedule?: ServiceRow[];
  onClose: () => void;
  onAssigned: () => void | Promise<void>;
  forceOpt?: () => { force?: boolean } | undefined;
}) {
  const { t } = useTranslation("schedule");
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (mode !== "solver") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.findSlotCandidates({ date, startTime, endTime, role, zone, targetSubRole })
      .then((res) => { if (!cancelled) setCandidates(res.data.candidates.slice(0, 3)); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t("actionsMenu.toasts.solverFailed")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, date, startTime, endTime, role, zone, targetSubRole, t]);

  // Same busy detection as SwapDialog: anyone who has an overlapping shift
  const busyMap = (() => {
    const m = new Map<string, boolean>();
    if (!daySchedule) return m;
    for (const ds of daySchedule) {
      if (ds.date !== date) continue;
      const overlap = ds.startTime < endTime && startTime < ds.endTime;
      if (overlap) m.set(ds.workerId, true);
    }
    return m;
  })();

  const statusOf = (workerId: string): CandidateStatus => {
    const busy = !!busyMap.get(workerId);
    const w = workers.find((x) => x.id === workerId);
    const match = !!(
      targetSubRole &&
      w &&
      (w.subRoles?.includes(targetSubRole) || w.subRole === targetSubRole)
    );
    if (match && !busy) return "match-free";
    if (!match && !busy) return "norole-free";
    if (match && busy) return "match-busy";
    return "norole-busy";
  };

  const filteredWorkers = (() => {
    if (mode === "solver") return [];
    if (mode === "subrole" && targetSubRole) {
      return workers.filter(
        (w) =>
          w.role === role &&
          (w.subRoles?.includes(targetSubRole) || w.subRole === targetSubRole),
      );
    }
    return workers.filter((w) => w.role === role);
  })();

  const title = mode === "solver"
    ? t("actionsMenu.swapDialog.solverTitle")
    : mode === "subrole"
      ? targetSubRole ? t("actionsMenu.assignDialog.subRoleTitleWith", { name: targetSubRole }) : t("actionsMenu.assignDialog.subRoleTitle")
      : role === "kitchen" ? t("actionsMenu.assignDialog.allKitchenTitle") : t("actionsMenu.assignDialog.allFloorTitle");

  const description = targetSubRole
    ? t("actionsMenu.assignDialog.descriptionWithSub", {
        date: fmtDate(date),
        start: startTime,
        end: endTime,
        role: role === "kitchen" ? t("roles.kitchen") : t("roles.floor"),
        sub: targetSubRole,
      })
    : t("actionsMenu.assignDialog.description", {
        date: fmtDate(date),
        start: startTime,
        end: endTime,
        role: role === "kitchen" ? t("roles.kitchen") : t("roles.floor"),
      });

  const handleAssign = async (workerId: string, workerName: string) => {
    setAssigningId(workerId);
    try {
      await api.createService(
        { workerId, date, startTime, endTime, role },
        forceOpt?.(),
      );
      toast.success(t("actionsMenu.toasts.assigned", { name: shortName(workerName) }));
      await onAssigned();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionsMenu.toasts.assignFailed"));
    } finally {
      setAssigningId(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>

        <CandidateLegend assignedSubRole={targetSubRole} />

        <div className="max-h-[50vh] overflow-y-auto space-y-1 py-[var(--space-xs)]">
          {mode === "solver" && loading && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("actionsMenu.swapDialog.calculating")}</p>
          )}
          {mode === "solver" && error && (
            <p className="text-sm text-destructive py-4 text-center">{error}</p>
          )}
          {mode === "solver" && candidates && candidates.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("actionsMenu.swapDialog.noCandidates")}</p>
          )}
          {mode === "solver" && candidates?.map((c, i) => (
            <CandidateRow
              key={c.id}
              rank={i + 1}
              workerId={c.id}
              name={c.name}
              score={c.score}
              reasons={c.reasons}
              subRoles={workers.find((w) => w.id === c.id)?.subRoles}
              status={statusOf(c.id)}
              loading={assigningId === c.id}
              onSelect={() => handleAssign(c.id, c.name)}
            />
          ))}

          {(mode === "subrole" || mode === "role") && filteredWorkers.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("actionsMenu.assignDialog.noEligible")}</p>
          )}
          {(mode === "subrole" || mode === "role") && filteredWorkers.map((w) => (
            <CandidateRow
              key={w.id}
              workerId={w.id}
              name={w.name}
              subRoles={w.subRoles}
              status={statusOf(w.id)}
              loading={assigningId === w.id}
              onSelect={() => handleAssign(w.id, w.name)}
            />
          ))}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>{t("actionsMenu.assignDialog.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
