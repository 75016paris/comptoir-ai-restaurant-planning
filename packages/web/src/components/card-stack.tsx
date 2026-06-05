import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useDraggable, useDroppable, useDndMonitor } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { getWorkerColor, getWorkerTier, getWorkerSubRoles, KITCHEN_LABEL, FLOOR_LABEL } from "@/lib/colors";
import type { ComplianceViolation } from "@/lib/api";
import { cn, shortName } from "@/lib/utils";
import type { ServiceRow, User } from "@/lib/api";
import { ChefCrown } from "./chef-crown";
import { useLongPress } from "@/hooks/use-long-press";
import { CARD_H, PEEK_Y, GAP_EXPANDED, ROLE_GAP, ZONE_PAD, GHOST_H } from "./card-stack-layout";

// ── Draggable worker card ──
function WorkerCard({
 service,
 coupureLegs,
 selectedWorkerIds,
 onServiceClick,
 onServiceDoubleClick,
 collapsed,
 touchSelectedId,
 onTouchSelect,
 isConflict,
 assignedSubRole,
 complianceStatus,
 renderActionsMenu,
}: {
 service: ServiceRow;
 coupureLegs?: ServiceRow[]; // when set (length ≥ 2), card represents a split shift; legs are sorted by startTime
 selectedWorkerIds: Set<string>;
 onServiceClick: (service: ServiceRow) => void;
 onServiceDoubleClick?: (service: ServiceRow, rect: DOMRect) => void;
 collapsed: boolean;
 touchSelectedId?: string | null;
 onTouchSelect?: (service: ServiceRow) => void;
 isConflict?: boolean;
 assignedSubRole?: string;
 complianceStatus?: { error: boolean; warning: boolean; violations: ComplianceViolation[] };
 renderActionsMenu?: (service: ServiceRow, assignedSubRole?: string) => React.ReactNode;
}) {
 const { t } = useTranslation("schedule");
 const [compliancePos, setCompliancePos] = useState<{ x: number; y: number } | null>(null);
 useEffect(() => {
  if (!compliancePos) return;
  const close = () => setCompliancePos(null);
  window.addEventListener("click", close);
  window.addEventListener("scroll", close, true);
  return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); };
 }, [compliancePos]);
 const shakeRef = useRef<HTMLButtonElement>(null);
 useEffect(() => {
  if (!isConflict) return;
  const timer = setTimeout(() => {
   const el = shakeRef.current;
   if (el) { el.classList.remove("reject-shake"); void el.offsetWidth; el.classList.add("reject-shake"); }
  }, 800);
  return () => clearTimeout(timer);
 }, [isConflict]);
 const dragRef = useRef(false);
 const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
 id: service.id,
 data: { service },
 disabled: collapsed,
 });

 useEffect(() => {
 if (transform && (Math.abs(transform.x) > 3 || Math.abs(transform.y) > 3)) {
 dragRef.current = true;
 }
 if (!transform && !isDragging) {
 dragRef.current = false;
 }
 }, [transform, isDragging]);

 const color = getWorkerColor(service.workerId);
 const isSelected = selectedWorkerIds.has(service.workerId);
 const isDimmed = selectedWorkerIds.size > 0 && !isSelected;
 const isTouchSelected = touchSelectedId === service.id;

 // Note: onTouchSelect (the dropdown-flow tap-to-place feature) is reachable
 // from the worker-name dropdown above the schedule, NOT from cards — cards
 // are pure dnd-kit drag-and-drop on touch. Wiring a longPress here would also
 // call e.stopPropagation(), preventing dnd-kit's TouchSensor from ever seeing
 // touchstart, which would block drag activation.
 void onTouchSelect; // referenced to keep prop in signature without a use site

 // Long-press visual — blue ring grows during the 450ms hold (matching dnd-kit
 // TouchSensor delay), then blinks once when drag activation fires.
 const [pressing, setPressing] = useState(false);
 const [blink, setBlink] = useState(false);
 const pressStartRef = useRef<{ x: number; y: number } | null>(null);
 const wasDraggingRef = useRef(false);
 useEffect(() => {
  if (isDragging && !wasDraggingRef.current) {
   queueMicrotask(() => {
    setPressing(false);
    setBlink(true);
   });
   const t = setTimeout(() => setBlink(false), 260);
   wasDraggingRef.current = true;
   return () => clearTimeout(t);
  }
  if (!isDragging) wasDraggingRef.current = false;
 }, [isDragging]);
 const handlePressStart = useCallback((e: React.TouchEvent) => {
  if (collapsed) return;
  const t = e.touches[0];
  pressStartRef.current = { x: t.clientX, y: t.clientY };
  setPressing(true);
 }, [collapsed]);
 const handlePressMove = useCallback((e: React.TouchEvent) => {
  if (!pressStartRef.current) return;
  const t = e.touches[0];
  if (Math.abs(t.clientX - pressStartRef.current.x) > 6 || Math.abs(t.clientY - pressStartRef.current.y) > 6) {
   setPressing(false);
   pressStartRef.current = null;
  }
 }, []);
 const handlePressEnd = useCallback(() => {
  setPressing(false);
  pressStartRef.current = null;
 }, []);

 // Don't apply transform — DragOverlay handles the moving visual.
 // touchAction: 'none' is required on iOS Safari so the browser doesn't claim
 // the touch for page scrolling, which would prevent dnd-kit's TouchSensor
 // from ever activating the drag.
 const style: React.CSSProperties = {
 height: `${CARD_H}px`,
 opacity: isDragging ? 0.5 : isTouchSelected ? 0.5 : isDimmed ? 0.15 : 1,
 touchAction: "none",
 };

 return (
 <div
 ref={setNodeRef}
 className="transition-opacity duration-200"
 style={style}
 {...attributes}
 {...listeners}
 >
 <button
 ref={shakeRef}
 onClick={(e) => {
 if (!dragRef.current) {
 if (collapsed) return; // let tap bubble to container to expand stack
 e.stopPropagation();
 onServiceClick(service);
 }
 }}
 onDoubleClick={(e) => {
 e.stopPropagation();
 if (collapsed || !onServiceDoubleClick) return;
 const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
 onServiceDoubleClick(service, rect);
 }}
 onTouchStart={handlePressStart}
 onTouchMove={handlePressMove}
 onTouchEnd={handlePressEnd}
 onTouchCancel={handlePressEnd}
 style={{
 boxShadow: isConflict
 ? "0 0 10px 2px rgba(239,68,68,0.5), 0 0 20px 4px rgba(239,68,68,0.25), 0 1px 2px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.06)"
 : isDragging ? undefined : "0 1px 2px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.06)",
 }}
 className={cn(
 "relative w-full h-full flex flex-col items-center justify-center gap-[2px] rounded-[1.2rem] border px-[var(--space-xs)] select-none transition-all",
 collapsed ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
 cn(color.bg, color.border, color.text),
 isDragging && "ring-[3px] ring-inset ring-accent",
 isTouchSelected && "ring-[3px] ring-accent border-accent scale-105 shadow-lg",
 pressing && !isDragging && "long-press-ramp",
 blink && "long-press-blink",
 isConflict && "outline outline-[3px] outline-offset-0 outline-red-500 dark:outline-red-400",
 )}
 >
 {!collapsed && complianceStatus && (complianceStatus.error || complianceStatus.warning) && (
 <span className="absolute top-1/2 right-1.5 -translate-y-1/2 z-10 flex items-center gap-px">
 <button
 type="button"
 onClick={(e) => {
 e.stopPropagation();
 if (compliancePos) { setCompliancePos(null); return; }
 const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
 setCompliancePos({ x: rect.right, y: rect.bottom + 4 });
 }}
 className={cn("flex items-center justify-center size-[18px] rounded-full text-white text-[10px] font-bold leading-none cursor-pointer", complianceStatus.error ? "bg-red-500" : "bg-amber-500")}
 >
 {complianceStatus.error ? "✕" : "?"}
 </button>
 {compliancePos && complianceStatus.violations.length > 0 && createPortal(
 <div
 className="fixed z-[9999] w-56 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg space-y-2"
 style={{ top: compliancePos.y, left: Math.min(compliancePos.x, window.innerWidth - 240) }}
 onClick={(e) => e.stopPropagation()}
 >
 {complianceStatus.violations.map((v, i) => (
 <div key={i}>
 <p className={cn("text-[10px] font-bold uppercase tracking-wide", v.severity === "error" ? "text-red-500" : "text-amber-500")}>
 {v.severity === "error" ? t("cards.errorBadge") : t("cards.warningBadge")}
 </p>
 <p className="text-[11px] leading-snug">{v.message}</p>
 <p className="text-[9px] text-muted-foreground leading-snug mt-0.5">{v.rule} · {v.code} · {v.date}</p>
 </div>
 ))}
 </div>,
 document.body
 )}
 </span>
 )}
 {renderActionsMenu && (
  <span
   className={cn("absolute top-1/2 left-1.5 -translate-y-1/2 z-10", collapsed && "opacity-0 pointer-events-none")}
   onClick={(e) => e.stopPropagation()}
   onPointerDown={(e) => e.stopPropagation()}
  >
   {/* Pass only the OBJECTIVE-derived sub-role (from serviceSubRoleMap) — never
       the worker's own sub-role. The match check in the swap dialog must
       compare against the slot's intended sub-role, not whoever is currently in it. */}
   {renderActionsMenu(service, assignedSubRole)}
  </span>
 )}
 {!collapsed && (<>
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide leading-tight text-center flex items-center justify-center gap-[2px]">
 {getWorkerTier(service.workerId) !== "worker" && <ChefCrown faded={getWorkerTier(service.workerId) === "sous-chef"} />}
 {shortName(service.workerName)}
 </span>
 <span className="flex items-center gap-1 leading-none">
 {(() => {
  const raw = assignedSubRole ?? getWorkerSubRoles(service.workerId)[0];
  if (!raw) return null;
  const abbrevMap: Record<string, string> = { "Sous-chef": "S.Chef", "Sous-chef de rang": "S.C.Rang", "Chef de rang": "C.Rang" };
  const label = abbrevMap[raw] ?? (raw.length <= 10 ? raw : raw.slice(0, 9) + ".");
  return <span className="inline-flex items-center px-1.5 py-px rounded-full bg-black/10 dark:bg-white/15 text-[8px] font-medium">{label}</span>;
 })()}
 {coupureLegs && coupureLegs.length >= 2 ? (() => {
  const first = coupureLegs[0];
  const last = coupureLegs[coupureLegs.length - 1];
  const detail = coupureLegs.map(l => `${l.startTime.slice(0,5)}–${l.endTime.slice(0,5)}`).join(" + ");
  return (
   <span className="text-[length:10px] tabular-nums text-muted-foreground" title={`Coupure · ${detail}`}>
    {first.startTime.slice(0, 5)} <span aria-hidden className="opacity-60">&gt;&gt;&gt;</span> {last.endTime.slice(0, 5)}
   </span>
  );
 })() : (
  <span className={cn("text-[length:10px] tabular-nums", "text-muted-foreground")}>
   {service.startTime.slice(0, 5)}-{service.endTime.slice(0, 5)}
  </span>
 )}
 </span>
 </>)}
 </button>
 </div>
 );
}

// ── Ghost card for missing staff ──
function GhostCard({ label, actionsMenu }: { label: string; actionsMenu?: React.ReactNode }) {
 return (
 <div
 className="relative w-full flex items-center justify-center rounded-[1.2rem] border border-red-300 bg-red-100 dark:border-red-800 dark:bg-red-950 px-[var(--space-xs)]"
 style={{ height: `${GHOST_H}px` }}
 >
 {actionsMenu && (
  <span className="absolute top-1/2 left-1.5 -translate-y-1/2 z-10" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
   {actionsMenu}
  </span>
 )}
 <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-red-500 text-white text-[11px] font-normal" style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}>{label}</span>
 </div>
 );
}

// ── Preview card for touch-selected placement — solid emerald (legal) or red (conflict) ──
function PlacementPreview({ service, conflict }: { service: ServiceRow; conflict?: boolean }) {
 const isRed = !!conflict;
 return (
 <div
 className={cn(
  "w-full flex flex-col items-center justify-center gap-[2px] rounded-[1.2rem] px-[var(--space-xs)] snap-land relative",
  isRed
   ? "bg-red-500 dark:bg-red-400 text-white dark:text-red-950 border-[3px] border-red-700 dark:border-red-200"
   : "bg-emerald-500 dark:bg-emerald-400 text-white dark:text-emerald-950 border-[3px] border-emerald-700 dark:border-emerald-200",
 )}
 style={{
  height: `${CARD_H}px`,
  boxShadow: isRed
   ? "0 0 0 2px rgba(239,68,68,0.9), 0 2px 8px rgba(239,68,68,0.35)"
   : "0 0 0 2px rgba(16,185,129,0.9), 0 2px 8px rgba(16,185,129,0.35)",
 }}
 >
 <span className="text-[length:var(--text-sm)] font-extrabold tracking-wide leading-tight text-center">
  {shortName(service.workerName)}
 </span>
 <span className={cn(
  "text-[length:10px] tabular-nums leading-none font-semibold",
  isRed ? "text-white/90 dark:text-red-950/80" : "text-white/90 dark:text-emerald-950/80",
 )}>
  {service.startTime.slice(0,5)}-{service.endTime.slice(0,5)}
 </span>
 </div>
 );
}

// ── Drop slot — solid card "lands" into position with scale bounce ──
function DropSlot({ service, worker, touchMode, isNewSlot, isReady }: { service?: ServiceRow | null; worker?: User | null; touchMode?: boolean; isNewSlot?: boolean; isReady?: boolean }) {
 // On touch, the "new target slot" gets the loud green pulse + "Ici" tag once
 // the user has dwelled long enough for stage B ("ready") to arm. Before that,
 // a subtler green outline indicates the slot is the active target but not yet
 // committed.
 const { t } = useTranslation("schedule");
 const loud = !!(touchMode && isNewSlot && isReady);
 if (!service && !worker) {
  return (
   <div
    className="w-full rounded-[1.2rem] border-2 border-dashed border-accent/60 bg-accent/10 transition-all duration-300 animate-in fade-in"
    style={{ height: `${CARD_H}px` }}
   />
  );
 }
 const workerId = service ? service.workerId : worker!.id;
 const workerName = service ? service.workerName : worker!.name;
 const color = getWorkerColor(workerId);
 return (
  <div
   className={cn(
    "w-full flex flex-col items-center justify-center gap-[2px] rounded-[1.2rem] px-[var(--space-xs)] snap-land relative",
    loud
     ? "bg-emerald-500 dark:bg-emerald-400 text-white dark:text-emerald-950 border-[3px] border-emerald-700 dark:border-emerald-200 ring-[4px] ring-emerald-400/70 dark:ring-emerald-300/70 drop-pulse-touch-solid"
     : touchMode
      ? "bg-emerald-500 dark:bg-emerald-400 text-white dark:text-emerald-950 border-2 border-emerald-700 dark:border-emerald-200 ring-2 ring-emerald-400/60 dark:ring-emerald-300/60"
      : cn(color.bg, color.text, "border-2", color.border, "outline outline-[3px] outline-offset-0 outline-emerald-500 dark:outline-emerald-400"),
   )}
   style={{
    height: `${loud ? CARD_H + 10 : CARD_H}px`,
    boxShadow: loud
     ? "0 0 0 3px rgba(16,185,129,0.95), 0 8px 28px 6px rgba(16,185,129,0.7), 0 0 56px 16px rgba(16,185,129,0.45)"
     : touchMode
      ? "0 0 0 2px rgba(16,185,129,0.85), 0 6px 20px 4px rgba(16,185,129,0.5)"
      : "0 0 10px 2px rgba(16,185,129,0.3), 0 0 18px 4px rgba(16,185,129,0.15)",
   }}
  >
   {loud && (
    <>
     <span
      aria-hidden
      className="pointer-events-none absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-white text-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 text-[11px] font-extrabold uppercase tracking-[0.12em] px-2.5 py-[3px] shadow-lg whitespace-nowrap drop-tag-bob border-2 border-emerald-500 dark:border-emerald-400"
     >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden><path d="M5 8L1 4h8z"/></svg>
      {t("cards.dropTag")}
     </span>
    </>
   )}
   {touchMode && !loud && (
    <span
     aria-hidden
     className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-white text-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 text-[10px] font-bold uppercase tracking-wider px-2 py-[2px] shadow-lg whitespace-nowrap border border-emerald-500 dark:border-emerald-400"
    >
     {t("cards.dropTag")}
    </span>
   )}
   <span className={cn("text-[length:var(--text-xs)] font-bold tracking-wide leading-tight text-center flex items-center justify-center gap-[2px]", loud && "text-[length:var(--text-sm)] font-extrabold")}>
    {getWorkerTier(workerId) !== "worker" && <ChefCrown faded={getWorkerTier(workerId) === "sous-chef"} />}
    {shortName(workerName)}
   </span>
   {service && (
    <span className={cn("text-[length:10px] tabular-nums leading-none", loud ? "text-white/90 dark:text-emerald-950/80 font-semibold" : "text-muted-foreground")}>
     {service.startTime.slice(0,5)}-{service.endTime.slice(0,5)}
    </span>
   )}
  </div>
 );
}

// ── Role stack (one role group: kitchen or salle) ──
interface RoleStackProps {
 label: string;
 labelStyle: string;
 timeLabel?: string;
 timeTitle?: string;
 services: ServiceRow[];
 selectedWorkerIds: Set<string>;
 onServiceClick: (service: ServiceRow) => void;
 onServiceDoubleClick?: (service: ServiceRow, rect: DOMRect) => void;
 direction: "down" | "up";
 peekY: number;
 onExpandChange?: (expanded: boolean) => void;
 forceExpand?: boolean;
 forceExpandAll?: boolean;
 isDragging?: boolean;
 target?: number; // staffing objective for this role
 suppressLabel?: boolean; // hide the role label badge (used in missing filter mode)
 touchSelectedId?: string | null;
 onTouchSelect?: (service: ServiceRow) => void;
 touchSelectedService?: ServiceRow | null;
 dragHoverRole?: string | null; // role of the card being dragged over this zone
 dragConflict?: boolean; // true when drop would conflict
 conflictServiceIds?: Set<string>; // IDs of conflicting services to highlight
 draggedService?: ServiceRow | null;
 draggedWorker?: User | null;
 onDropSnap?: (snapped: boolean) => void;
 ghostLabels?: string[]; // sub-role names for each ghost card
 serviceSubRoleMap?: Map<string, string>;
 hasActiveFilter?: boolean;
 complianceLookup?: Map<string, { error: boolean; warning: boolean; violations: ComplianceViolation[] }>;
 touchMode?: boolean; // true = touch drag in progress → show DropSlot immediately (no 500ms delay)
 touchPlacementConflict?: boolean; // true when placing touchSelectedService in this zone would conflict
 coupureLegsMap?: Map<string, ServiceRow[]>; // primary serviceId → all legs of a coupure (length ≥ 2)
 readyToCommit?: boolean; // stage B fired — release here will commit the move
 touchUnstacked?: boolean; // stage A fired — zone is allowed to expand and show drop slot
 growOnExpand?: boolean; // hover-expand grows container height (used when nothing below to bleed into)
 renderActionsMenu?: (service: ServiceRow, assignedSubRole?: string) => React.ReactNode;
 renderGhostActionsMenu?: (ghostIndex: number, ghostLabel?: string) => React.ReactNode;
}

function RoleStack({ label, labelStyle, timeLabel, timeTitle, services, selectedWorkerIds, onServiceClick, onServiceDoubleClick, direction, peekY, onExpandChange, forceExpand, forceExpandAll, isDragging, target, suppressLabel, touchSelectedId, onTouchSelect, touchSelectedService, dragHoverRole, dragConflict, conflictServiceIds, draggedService, draggedWorker, onDropSnap, ghostLabels, serviceSubRoleMap, hasActiveFilter, complianceLookup, touchMode, touchPlacementConflict, coupureLegsMap, readyToCommit, touchUnstacked, growOnExpand, renderActionsMenu, renderGhostActionsMenu }: RoleStackProps) {
 const { t } = useTranslation("roles");
 const [hoverExpanded, setHoverExpanded] = useState(false);
 const containerRef = useRef<HTMLDivElement>(null);

 // Visual expanded = hover (when not dragging) OR force (drag-over, role-matched)
 // isDragging prop comes from parent — survives component remounts during week navigation
 const expanded = (hoverExpanded && !isDragging) || !!forceExpand;

 // Notify parent of visual expanded state (only on change)
 const prevExpanded = useRef(false);
 useEffect(() => {
 if (prevExpanded.current !== expanded) {
 onExpandChange?.(expanded);
 prevExpanded.current = expanded;
 }
 }, [expanded, onExpandChange]);

 // Collapse on click outside
 useEffect(() => {
 if (!expanded) return;
 function handleClick(e: MouseEvent) {
 if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
 setHoverExpanded(false);
 }
 }
 document.addEventListener("click", handleClick, true);
 return () => document.removeEventListener("click", handleClick, true);
 }, [expanded]);

 // Collapse source stack when one of its cards starts dragging
 useDndMonitor({
 onDragStart(event) {
 setHoverExpanded(false);
 const draggedService = event.active.data.current?.service as ServiceRow | undefined;
 if (draggedService && services.some(s => s.id === draggedService.id)) {
 clearTimeout(collapseTimer.current);
 }
 },
 });

 // ── Drop-slot logic: show solid card after 0.5s hover on matching role without conflict ──
 const dragRoleKey = label === "cuisine" ? "cuisine" : "floor";
 const isRoleMatch = !!dragHoverRole && dragHoverRole === dragRoleKey;
 // On touch, the slot only appears once stage A ("unstack") has fired, matching
 // the visual unstack of the stack itself. Desktop keeps its 500ms hover delay.
 const shouldSlot = isRoleMatch && !dragConflict && (!touchMode || !!touchUnstacked);
 const [showDropSlot, setShowDropSlot] = useState(false);
 const dropSlotTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
 useEffect(() => {
  clearTimeout(dropSlotTimer.current);
  if (shouldSlot) {
   const delay = touchMode ? 0 : 500;
   if (delay === 0) queueMicrotask(() => setShowDropSlot(true));
   else dropSlotTimer.current = setTimeout(() => setShowDropSlot(true), delay);
  } else {
   setShowDropSlot(false);
  }
  return () => clearTimeout(dropSlotTimer.current);
 }, [shouldSlot, touchMode]);
 // Notify parent when snap state changes (dims the pointer card)
 const prevSnap = useRef(false);
 useEffect(() => {
  if (prevSnap.current !== showDropSlot) {
   onDropSnap?.(showDropSlot);
   prevSnap.current = showDropSlot;
  }
 }, [showDropSlot, onDropSnap]);

 const n = services.length;
 // Hide ghost cards when a worker is selected — only that worker's card matters
 const ghostCount = hasActiveFilter ? 0 : (target !== undefined ? Math.max(0, target - n) : 0);
 // Touch-device detection — PlacementPreview is iPhone/tablet only
 const isTouchDevice = typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches;
 // Placement preview: show ONLY in the stack the user tapped to open (expanded),
 // when touch-selected service matches this role and isn't already here,
 // and only on touch devices.
 const roleKey = label === "cuisine" ? "kitchen" : "floor";
 const showPreview = !!touchSelectedService
 && (touchSelectedService.workerRole || touchSelectedService.role) === roleKey
 && !services.some(s => s.id === touchSelectedService.id)
 && expanded
 && isTouchDevice;
 const previewCount = showPreview ? 1 : 0;
 const nTotal = n + ghostCount + previewCount; // total items (real + ghost + preview)
 const showLabel = !hasActiveFilter && !suppressLabel; // label only when no one selected and not suppressed
 const peekX = 0;
 const maxOffsetX = nTotal * peekX;
 const labelExpandedH = Math.round(CARD_H / 2.5);
 const hasDeficit = ghostCount > 0;

 // When label shown: label takes front spot, cards offset behind it
 // When no label: cards start at 0
 const maxOffsetY = showLabel ? nTotal * peekY : (nTotal > 0 ? (nTotal - 1) : 0) * peekY;
 const collapsedH = CARD_H + maxOffsetY;
 // Drop slot behavior:
 //  - When dragging BACK to source (dragged card is already in this stack):
 //    show it in the source card's original slot — no shift, no new slot.
 //  - Otherwise: insert as the FIRST card (right after the label), pushing
 //    all worker cards, ghosts, and preview down by one slot.
 // PlacementPreview (touch-select tap flow) gets the same first-slot treatment.
 const sourceIndex = draggedService ? services.findIndex(s => s.id === draggedService.id) : -1;
 const isReturnToSource = showDropSlot && sourceIndex >= 0;
 const dropSlotCount = showDropSlot && !isReturnToSource ? 1 : 0;
 const hasFirstSlotCard = dropSlotCount > 0 || showPreview;
 const firstSlotShift = hasFirstSlotCard ? (CARD_H + GAP_EXPANDED) : 0;
 const dropShift = firstSlotShift;
 const expandedH = showLabel
 ? labelExpandedH + n * CARD_H + n * GAP_EXPANDED + ghostCount * (GHOST_H + GAP_EXPANDED) + previewCount * (CARD_H + GAP_EXPANDED) + dropSlotCount * (CARD_H + GAP_EXPANDED)
 : n * CARD_H + (n > 0 ? (n - 1) : 0) * GAP_EXPANDED + ghostCount * (GHOST_H + GAP_EXPANDED) + previewCount * (CARD_H + GAP_EXPANDED) + dropSlotCount * (CARD_H + GAP_EXPANDED);

 // Bubble: covers the full expanded area to keep mouse inside the container DOM
 const bubbleTop = direction === "down" ? -8 : maxOffsetY + CARD_H - expandedH - 8;
 const bubbleH = expandedH + 16;

 // Delay collapse to prevent jarring transitions when moving toward bleeded cards
 const collapseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
 const doExpand = useCallback(() => {
 clearTimeout(collapseTimer.current);
 setHoverExpanded(true);
 }, []);
 const doCollapse = useCallback(() => {
 // eslint-disable-next-line react-hooks/immutability -- event callback owns this timer ref
 collapseTimer.current = setTimeout(() => setHoverExpanded(false), 150);
 }, []);
 useEffect(() => () => clearTimeout(collapseTimer.current), []);

 // Container stays at collapsed height — expanded cards overflow via absolute positioning
 // Only elevate z-index when expanded (avoids rogue stacking contexts when collapsed)
 return (
 <div
 ref={containerRef}
 onPointerEnter={(e) => { if (e.pointerType === "mouse") doExpand(); }}
 onPointerLeave={(e) => { if (e.pointerType === "mouse") doCollapse(); }}
 onClick={() => setHoverExpanded((prev) => !prev)}
 style={{ position: "relative", zIndex: expanded ? 20 : undefined }}
 >
 {/* Invisible bubble — keeps mouse inside container DOM when over expanded cards */}
 {expanded && (
 <div
 className="absolute"
 style={{
 left: "-12px",
 right: "-12px",
 top: `${bubbleTop}px`,
 height: `${bubbleH}px`,
 }}
 />
 )}
 <div
 className="relative"
 style={{ height: `${(forceExpand || (growOnExpand && expanded)) ? expandedH : collapsedH}px`, transition: "height 250ms ease-out" }}
 >
 {/* Scrim behind expanded overflow area — faded edges */}
 <div
 className="absolute pointer-events-none rounded-sm bg-background/60 dark:bg-background/70"
 style={{
 left: -2,
 right: -2,
 top: direction === "down"
 ? `${collapsedH - 4}px`
 : `${collapsedH - expandedH - 8}px`,
 height: `${Math.max(0, expandedH - collapsedH + 16)}px`,
 zIndex: 1,
 opacity: expanded && expandedH > collapsedH && !forceExpandAll && !forceExpand ? 1 : 0,
 transition: "opacity 200ms ease-in-out",
 maskImage: direction === "down"
 ? "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)"
 : "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
 WebkitMaskImage: direction === "down"
 ? "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)"
 : "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
 }}
 />
 {/* Label card — only when no worker selected */}
 {showLabel && (() => {
 // Aggregate compliance for all services in this role stack
 const roleViolations: ComplianceViolation[] = [];
 let roleHasError = false;
 let roleHasWarning = false;
 if (complianceLookup) {
 for (const service of services) {
 const cs = complianceLookup.get(`${service.workerId}:${service.date}`);
 if (cs) {
 if (cs.error) roleHasError = true;
 if (cs.warning) roleHasWarning = true;
 roleViolations.push(...cs.violations);
 }
 }
 }
 const hasRoleCompliance = roleHasError || roleHasWarning;
 return (
 <div
 className="absolute will-change-transform"
 style={{
 width: expanded ? "100%" : `calc(100% - ${maxOffsetX}px)`,
 height: `${expanded ? labelExpandedH : CARD_H}px`,
 transform: expanded
 ? direction === "down"
 ? "translate(0px, 0px)"
 : `translate(0px, ${maxOffsetY + CARD_H - labelExpandedH}px)`
 : direction === "down"
 ? "translate(0px, 0px)"
 : `translate(0px, ${maxOffsetY}px)`,
 transition: "transform 250ms ease-out, width 250ms ease-out, height 250ms ease-out",
 zIndex: nTotal + 1,
 }}
 >
 <div className={cn("h-full flex flex-col items-center justify-center gap-[1px] rounded-[1.2rem] border px-[var(--space-xs)] relative", labelStyle)}>
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide leading-tight text-center">
 {(() => {
   const displayLabel = label === "cuisine" ? t("kitchen") : label === "floor" ? t("floor") : label;
   return hasDeficit
     ? <span className="inline-flex items-center gap-[3px] px-1.5 py-px rounded-full bg-red-500 text-white text-[10px]"><TriangleAlert className="size-[10px] shrink-0" />{displayLabel} — {n}/{target}</span>
     : n > 0 ? `${displayLabel} — ${n}` : displayLabel;
 })()}
 </span>
 {timeLabel && !expanded && (
  <span className="text-[length:10px] tabular-nums leading-none text-muted-foreground" title={timeTitle ?? timeLabel}>
   {timeLabel}
  </span>
 )}
 {!expanded && hasRoleCompliance && (
 <span className={cn("absolute top-1/2 right-1.5 -translate-y-1/2 z-10 flex items-center justify-center size-[18px] rounded-full text-white text-[10px] font-bold leading-none", roleHasError ? "bg-red-500" : "bg-amber-500")}>
 {roleHasError ? "✕" : "?"}
 </span>
 )}
 </div>
 </div>
 );
 })()}

 {/* Worker cards — hide the source card when drop slot is occupying its slot */}
 {services.map((service, i) => {
 if (isReturnToSource && i === sourceIndex) return null;
 const collapsedY = showLabel
 ? (direction === "down" ? (i + 1) * peekY : maxOffsetY - (i + 1) * peekY)
 : (direction === "down" ? i * peekY : maxOffsetY - i * peekY);
 const expandedY = (showLabel
 ? (direction === "down"
 ? labelExpandedH + GAP_EXPANDED + i * (CARD_H + GAP_EXPANDED)
 : maxOffsetY - labelExpandedH + CARD_H - (i + 1) * (CARD_H + GAP_EXPANDED))
 : (direction === "down"
 ? i * (CARD_H + GAP_EXPANDED)
 : maxOffsetY + CARD_H - (i + 1) * (CARD_H + GAP_EXPANDED)))
 + (direction === "down" ? dropShift : -dropShift);

 return (
 <div
 key={service.id}
 className="absolute will-change-transform"
 style={{
 width: expanded ? "100%" : `calc(100% - ${maxOffsetX}px)`,
 transform: expanded
 ? `translate(0px, ${expandedY}px)`
 : `translate(${(i + 1) * peekX}px, ${collapsedY}px)`,
 transition: "transform 250ms ease-out, width 250ms ease-out",
 zIndex: expanded ? i + 2 : nTotal - i,
 }}
 >
 <WorkerCard
 service={service}
 coupureLegs={coupureLegsMap?.get(service.id)}
 selectedWorkerIds={selectedWorkerIds}
 onServiceClick={onServiceClick}
 onServiceDoubleClick={onServiceDoubleClick}
 collapsed={!expanded}
 touchSelectedId={touchSelectedId}
 onTouchSelect={onTouchSelect}
 isConflict={conflictServiceIds?.has(service.id)}
 assignedSubRole={serviceSubRoleMap?.get(service.id)}
                 complianceStatus={complianceLookup?.get(`${service.workerId}:${service.date}`)}
 renderActionsMenu={renderActionsMenu}
 />
 </div>
 );
 })}
 {/* Ghost cards for missing staff — shifted down one slot when drop slot is active */}
 {Array.from({ length: ghostCount }, (_, gi) => {
 const i = n + gi;
 const collapsedY = showLabel
 ? (direction === "down" ? (i + 1) * peekY : maxOffsetY - (i + 1) * peekY)
 : (direction === "down" ? i * peekY : maxOffsetY - i * peekY);
 const expandedY = (showLabel
 ? (direction === "down"
 ? labelExpandedH + GAP_EXPANDED + n * (CARD_H + GAP_EXPANDED) + gi * (GHOST_H + GAP_EXPANDED)
 : maxOffsetY - labelExpandedH + CARD_H - n * (CARD_H + GAP_EXPANDED) - (gi + 1) * (GHOST_H + GAP_EXPANDED))
 : (direction === "down"
 ? n * (CARD_H + GAP_EXPANDED) + gi * (GHOST_H + GAP_EXPANDED)
 : maxOffsetY + CARD_H - n * (CARD_H + GAP_EXPANDED) - (gi + 1) * (GHOST_H + GAP_EXPANDED)))
 + (direction === "down" ? dropShift : -dropShift);

 return (
 <div
 key={`ghost-${gi}`}
 className="absolute will-change-transform"
 style={{
 width: expanded ? "100%" : `calc(100% - ${maxOffsetX}px)`,
 transform: expanded
 ? `translate(0px, ${expandedY}px)`
 : `translate(${(i + 1) * peekX}px, ${collapsedY}px)`,
 transition: "transform 250ms ease-out, width 250ms ease-out",
 zIndex: expanded ? n + gi + 2 : ghostCount - gi,
 }}
 >
 <GhostCard
  label={ghostLabels?.[gi] ?? (label === "cuisine" ? t("kitchen") : label === "floor" ? t("floor") : label)}
  actionsMenu={renderGhostActionsMenu?.(gi, ghostLabels?.[gi])}
 />
 </div>
 );
 })}
 {/* Placement preview for touch-selected card — first slot (pushing others down) */}
 {showPreview && touchSelectedService && (() => {
 const pi = 0; // first slot
 const collapsedY = showLabel
 ? (direction === "down" ? (pi + 1) * peekY : maxOffsetY - (pi + 1) * peekY)
 : (direction === "down" ? pi * peekY : maxOffsetY - pi * peekY);
 const expandedY = direction === "down"
 ? (showLabel ? labelExpandedH + GAP_EXPANDED : 0)
 : (showLabel
  ? maxOffsetY - labelExpandedH + CARD_H - (CARD_H + GAP_EXPANDED)
  : maxOffsetY + CARD_H - (CARD_H + GAP_EXPANDED));
 return (
 <div
 key="placement-preview"
 className="absolute will-change-transform"
 style={{
 width: expanded ? "100%" : `calc(100% - ${maxOffsetX}px)`,
 transform: expanded
 ? `translate(0px, ${expandedY}px)`
 : `translate(${(pi + 1) * peekX}px, ${collapsedY}px)`,
 transition: "transform 250ms ease-out, width 250ms ease-out",
 zIndex: nTotal + 3,
 }}
 >
 <PlacementPreview service={touchSelectedService} conflict={touchPlacementConflict} />
 </div>
 );
 })()}
 {/* Drop slot — first card (pushing others down), or in-place of source card when returning to source */}
 {showDropSlot && (() => {
 const slotI = isReturnToSource ? sourceIndex : 0;
 const expandedY = direction === "down"
  ? (showLabel
   ? labelExpandedH + GAP_EXPANDED + slotI * (CARD_H + GAP_EXPANDED)
   : slotI * (CARD_H + GAP_EXPANDED))
  : (showLabel
   ? maxOffsetY - labelExpandedH + CARD_H - (slotI + 1) * (CARD_H + GAP_EXPANDED)
   : maxOffsetY + CARD_H - (slotI + 1) * (CARD_H + GAP_EXPANDED));
 return (
  <div
   key="drop-slot"
   className="absolute will-change-transform"
   style={{
    width: "100%",
    transform: `translate(0px, ${expandedY}px)`,
    transition: "transform 250ms ease-out",
    zIndex: nTotal + 3,
   }}
  >
   <DropSlot service={draggedService} worker={draggedWorker} touchMode={touchMode} isNewSlot={!isReturnToSource} isReady={readyToCommit} />
  </div>
 );
 })()}
 </div>
 </div>
 );
}

// ── Droppable zone wrapper ──
// All zones get position:relative + base z-index so they form proper stacking
// contexts in the CSS grid. Elevated (active) zone gets z-index 20.
export function ZoneDrop({
 id,
 children,
 className,
 zIndex,
 isDragActive,
 hasTouchSelection,
 onTouchPlace,
}: {
 id: string;
 children: React.ReactNode;
 className?: string;
 zIndex?: number;
 isDragActive?: boolean;
 hasTouchSelection?: boolean;
 onTouchPlace?: (zoneId: string) => void;
}) {
 const { setNodeRef, isOver } = useDroppable({ id });
 const longPress = useLongPress(useCallback(() => {
 if (hasTouchSelection && onTouchPlace) {
 if (navigator.vibrate) navigator.vibrate(50);
 onTouchPlace(id);
 }
 }, [hasTouchSelection, onTouchPlace, id]));

 return (
 <div
 ref={setNodeRef}
 data-zone-id={id}
 className={cn(
 "rounded-sm transition-colors duration-150",
 isDragActive && !isOver && "ring-1 ring-inset ring-foreground/10",
 isOver && "bg-accent/40 ring-1 ring-accent/60",
 hasTouchSelection && "ring-1 ring-inset ring-accent/40 bg-accent/10",
 className
 )}
 style={{
 overflow: "visible",
 position: "relative",
 zIndex: zIndex ?? 1,
 transform: "translateZ(0)", // force own GPU layer — prevents will-change children from escaping stacking context in Chrome overflow:auto containers
 }}
 {...(hasTouchSelection ? longPress : {})}
 >
 {children}
 </div>
 );
}

// ── Card stack (one zone) — renders kitchen + salle stacks ──
// Parent pre-filters services for this zone. zoneLabel is for display only.
interface CardStackProps {
 services: ServiceRow[];
 zoneLabel: string;
 selectedWorkerIds: Set<string>;
 onServiceClick: (service: ServiceRow) => void;
 onServiceDoubleClick?: (service: ServiceRow, rect: DOMRect) => void;
 stacksH: number;
 zoneId?: string; // droppable zone id for drag-over detection
 dimmed?: boolean; // grey out during drag when not source/target
 onActiveChange?: (active: boolean) => void; // fires when stack expands/collapses (hover or drag-over)
 isDragging?: boolean; // parent signals a drag is active — suppresses hover expansion
 forceExpandRole?: string | null; // parent-computed: which role to force-expand ("cuisine" | "floor" | null)
	forceExpandAll?: boolean; // expand all stacks ("unstack all" mode)
 direction?: "down" | "up"; // expand direction, default "down"
 kitchenTarget?: number; // staffing objective for kitchen
 salleTarget?: number; // staffing objective for salle
 kitchenTimeLabel?: string;
 kitchenTimeTitle?: string;
 salleTimeLabel?: string;
 salleTimeTitle?: string;
 roleFilter?: "all" | "kitchen" | "floor" | "missing";
 touchSelectedId?: string | null;
 onTouchSelect?: (service: ServiceRow) => void;
 touchSelectedService?: ServiceRow | null;
 dragHoverRole?: string | null; // role of the dragged card when hovering this zone
 dragConflict?: boolean; // true when drop would conflict (worker already has overlapping shift)
 conflictServiceIds?: Set<string>; // IDs of services that conflict with the current drag
 draggedService?: ServiceRow | null; // the service being dragged (for drop slot preview)
 draggedWorker?: User | null; // the worker being dragged from the legend (for drop slot preview)
 onDropSnap?: (snapped: boolean) => void;
 kitchenGhostLabels?: string[]; // sub-role labels for kitchen ghost cards
 salleGhostLabels?: string[]; // sub-role labels for salle ghost cards
 serviceSubRoleMap?: Map<string, string>; // serviceId → assigned breakdown subrole
 hasActiveFilter?: boolean; // true when workers or subroles are selected
 complianceLookup?: Map<string, { error: boolean; warning: boolean; violations: ComplianceViolation[] }>;
 touchMode?: boolean; // touch drag active — show drop-slot clue immediately
 touchPlacementConflict?: boolean; // true when placing touchSelectedService in this zone would conflict
 readyToCommit?: boolean; // stage B fired on this zone — release will commit
 touchUnstacked?: boolean; // stage A fired on this zone — unlock unstack + drop slot
 growOnExpand?: boolean; // hover-expand grows container height (no content below to bleed into)
 renderActionsMenu?: (service: ServiceRow, assignedSubRole?: string) => React.ReactNode;
 renderGhostActionsMenu?: (role: "kitchen" | "floor", ghostIndex: number, ghostLabel?: string) => React.ReactNode;
}

export function CardStackInner({ services, zoneLabel: _zoneLabel, selectedWorkerIds, onServiceClick, onServiceDoubleClick, stacksH, dimmed, onActiveChange, isDragging, forceExpandRole, forceExpandAll, direction: dirProp, kitchenTarget, salleTarget, kitchenTimeLabel, kitchenTimeTitle, salleTimeLabel, salleTimeTitle, roleFilter = "all", touchSelectedId, onTouchSelect, touchSelectedService, dragHoverRole, dragConflict, conflictServiceIds, draggedService, draggedWorker, onDropSnap, kitchenGhostLabels, salleGhostLabels, serviceSubRoleMap, hasActiveFilter, complianceLookup, touchMode, touchPlacementConflict, readyToCommit, touchUnstacked, growOnExpand, renderActionsMenu, renderGhostActionsMenu }: CardStackProps) {
 const sorted = [...services].sort((a, b) => a.startTime.localeCompare(b.startTime));
 // Coalesce coupures (same workerId+date → one card unit). Primary leg = earliest startTime.
 const coupureLegsMap = new Map<string, ServiceRow[]>();
 const filtered: ServiceRow[] = [];
 {
  const byWorkerDate = new Map<string, ServiceRow[]>();
  for (const s of sorted) {
   const k = `${s.workerId}|${s.date}`;
   if (!byWorkerDate.has(k)) byWorkerDate.set(k, []);
   byWorkerDate.get(k)!.push(s);
  }
  // Re-emit in original sorted order, but only the primary leg of each group
  const primaryIds = new Set<string>();
  for (const legs of byWorkerDate.values()) {
   primaryIds.add(legs[0].id); // earliest (sorted)
   if (legs.length >= 2) coupureLegsMap.set(legs[0].id, legs);
  }
  for (const s of sorted) if (primaryIds.has(s.id)) filtered.push(s);
 }

 const containerH = stacksH + ZONE_PAD;
 // Track expanded stacks for backdrop (set-based, no mount bug)
 const [expandedSet, setExpandedSet] = useState<Set<string>>(() => new Set());
 const showBackdrop = expandedSet.size > 0;
 const mkExpandHandler = useCallback((role: string) => (exp: boolean) => {
 setExpandedSet(prev => {
 const next = new Set(prev);
 if (exp) next.add(role); else next.delete(role);
 return next;
 });
 }, []);

 // forceExpandRole is computed by the parent (survives week navigation during drag)
 // Notify parent when this zone becomes active (expanded or drag-over)
 // so the parent can elevate its z-index above sibling grid cells
 const isActive = showBackdrop || !!forceExpandRole;
 const prevActive = useRef(false);
 useEffect(() => {
 if (prevActive.current !== isActive) {
 onActiveChange?.(isActive);
 prevActive.current = isActive;
 }
 }, [isActive, onActiveChange]);

 const kitchenServices = filtered.filter((s) => (s.workerRole || s.role) === "kitchen");
 const salleServices = filtered.filter((s) => (s.workerRole || s.role) === "floor");

 const kGhosts = kitchenTarget !== undefined ? Math.max(0, kitchenTarget - kitchenServices.length) : 0;
 const sGhosts = salleTarget !== undefined ? Math.max(0, salleTarget - salleServices.length) : 0;
 const hasDeficit = kGhosts > 0 || sGhosts > 0;

 // "missing" filter: hide filled services, show only ghost cards
 const isMissingFilter = roleFilter === "missing";
 // Missing mode: always expand downward — "up" direction breaks when there's no label card anchor
 const direction = forceExpandAll || isMissingFilter ? "down" : (dirProp ?? "down");
 const visibleKitchen = isMissingFilter ? [] : kitchenServices;
 const visibleSalle = isMissingFilter ? [] : salleServices;

 if (filtered.length === 0 && !hasDeficit) {
 return (
 <div className="flex items-center justify-center p-[var(--space-xs)]" style={{ height: `${containerH}px` }}>
 <span className="text-muted-foreground text-[length:var(--text-xs)]">—</span>
 </div>
 );
 }

 // In missing mode, skip zones with no deficit
 if (isMissingFilter && !hasDeficit) {
 return (
 <div className="flex items-center justify-center p-[var(--space-xs)]" style={{ height: `${containerH}px` }}>
 <span className="text-muted-foreground text-[length:var(--text-xs)]">—</span>
 </div>
 );
 }

 // Always account for 2 stacks so empty roles keep consistent height
 // Determine which roles to show based on filter
 const showKitchen = roleFilter === "all" || roleFilter === "kitchen" || (isMissingFilter && kGhosts > 0);
 const showSalle = roleFilter === "all" || roleFilter === "floor" || (isMissingFilter && sGhosts > 0);
 const showBothSlots = roleFilter === "all"; // reserve space for both roles even if empty

 const totalItems = (showKitchen ? visibleKitchen.length + kGhosts : 0) + (showSalle ? visibleSalle.length + sGhosts : 0);
 const availableForPeek = stacksH - 2 * CARD_H - ROLE_GAP;
 const dynamicPeekY = totalItems > 0
 ? Math.max(2, Math.min(14, availableForPeek / totalItems))
 : PEEK_Y;

 return (
 <div className="relative flex flex-col gap-[var(--space-sm)] p-[var(--space-xs)]" style={growOnExpand ? { minHeight: `${containerH}px`, transition: "min-height 250ms ease-out" } : { height: `${containerH}px`, transition: "height 250ms ease-out" }}>
 {/* Dim overlay when dragging and this zone is neither source nor target */}
 {dimmed && (
 <div className="absolute inset-0 bg-background/85 pointer-events-none rounded-sm" style={{ zIndex: 30 }} />
 )}

 {showKitchen && (visibleKitchen.length > 0 || kGhosts > 0) ? (
 <RoleStack
 label="cuisine"
 labelStyle={cn(KITCHEN_LABEL.bg, KITCHEN_LABEL.border, KITCHEN_LABEL.text)}
 timeLabel={kitchenTimeLabel}
 timeTitle={kitchenTimeTitle}
 services={visibleKitchen}
 coupureLegsMap={coupureLegsMap}
 selectedWorkerIds={selectedWorkerIds}
 onServiceClick={onServiceClick}
 direction={direction}
 peekY={dynamicPeekY}
 onExpandChange={mkExpandHandler("cuisine")}
 forceExpand={isMissingFilter || forceExpandAll || forceExpandRole === "cuisine"}
 forceExpandAll={forceExpandAll}
 isDragging={isDragging}
 suppressLabel={isMissingFilter}
 target={isMissingFilter ? kGhosts : kitchenTarget}
 touchSelectedId={touchSelectedId}
 onTouchSelect={onTouchSelect}
 touchSelectedService={touchSelectedService}
 dragHoverRole={dragHoverRole}
 dragConflict={dragConflict}
 conflictServiceIds={conflictServiceIds}
 draggedService={draggedService}
 draggedWorker={draggedWorker}
 onDropSnap={onDropSnap}
 ghostLabels={kitchenGhostLabels}
 serviceSubRoleMap={serviceSubRoleMap}
 hasActiveFilter={hasActiveFilter}
             complianceLookup={complianceLookup}
 touchMode={touchMode}
 touchPlacementConflict={touchPlacementConflict}
 readyToCommit={readyToCommit}
 touchUnstacked={touchUnstacked}
 growOnExpand={growOnExpand}
 renderActionsMenu={renderActionsMenu}
 renderGhostActionsMenu={renderGhostActionsMenu ? (gi, lbl) => renderGhostActionsMenu("kitchen", gi, lbl) : undefined}
 />
 ) : showBothSlots && !hasActiveFilter ? (
 <div className="flex-1" style={{ minHeight: `${CARD_H}px` }}>
 <div className="h-full flex items-center justify-center rounded-[1.2rem] border bg-muted/50 border-border/50 px-[var(--space-xs)]">
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground/50">no cuisine</span>
 </div>
 </div>
 ) : showBothSlots ? (
 <div style={{ height: `${CARD_H}px` }} />
 ) : null}
 {showSalle && (visibleSalle.length > 0 || sGhosts > 0) ? (
 <RoleStack
 label="floor"
 labelStyle={cn(FLOOR_LABEL.bg, FLOOR_LABEL.border, FLOOR_LABEL.text)}
 timeLabel={salleTimeLabel}
 timeTitle={salleTimeTitle}
 services={visibleSalle}
 coupureLegsMap={coupureLegsMap}
 selectedWorkerIds={selectedWorkerIds}
 onServiceClick={onServiceClick}
 onServiceDoubleClick={onServiceDoubleClick}
 direction={direction}
 peekY={dynamicPeekY}
 onExpandChange={mkExpandHandler("floor")}
 forceExpand={isMissingFilter || forceExpandAll || forceExpandRole === "floor"}
 forceExpandAll={forceExpandAll}
 isDragging={isDragging}
 suppressLabel={isMissingFilter}
 target={isMissingFilter ? sGhosts : salleTarget}
 touchSelectedId={touchSelectedId}
 onTouchSelect={onTouchSelect}
 touchSelectedService={touchSelectedService}
 dragHoverRole={dragHoverRole}
 dragConflict={dragConflict}
 conflictServiceIds={conflictServiceIds}
 draggedService={draggedService}
 draggedWorker={draggedWorker}
 onDropSnap={onDropSnap}
 ghostLabels={salleGhostLabels}
 serviceSubRoleMap={serviceSubRoleMap}
 hasActiveFilter={hasActiveFilter}
             complianceLookup={complianceLookup}
 touchMode={touchMode}
 touchPlacementConflict={touchPlacementConflict}
 readyToCommit={readyToCommit}
 touchUnstacked={touchUnstacked}
 growOnExpand={growOnExpand}
 renderActionsMenu={renderActionsMenu}
 renderGhostActionsMenu={renderGhostActionsMenu ? (gi, lbl) => renderGhostActionsMenu("floor", gi, lbl) : undefined}
 />
 ) : showBothSlots && !hasActiveFilter ? (
 <div className="flex-1" style={{ minHeight: `${CARD_H}px` }}>
 <div className="h-full flex items-center justify-center rounded-[1.2rem] border bg-muted/50 border-border/50 px-[var(--space-xs)]">
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground/50">no salle</span>
 </div>
 </div>
 ) : showBothSlots ? (
 <div style={{ height: `${CARD_H}px` }} />
 ) : null}
 </div>
 );
}
