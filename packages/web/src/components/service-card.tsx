import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { AlertTriangle } from "lucide-react";
import { getWorkerColor, getWorkerTier } from "@/lib/colors";
import { cn, shortName } from "@/lib/utils";
import type { ServiceRow } from "@/lib/api";
import { ChefCrown } from "@/components/chef-crown";

interface ServiceCardProps {
 service: ServiceRow;
 topPx: number;
 heightPx: number;
 onClick?: (e: React.MouseEvent) => void;
 onDoubleClick?: (e: React.MouseEvent) => void;
 selected?: boolean;
 dimmed?: boolean;
 narrow?: boolean;
 assignedSubRole?: string;
 actionSlot?: ReactNode;
}

const SUB_ROLE_ABBREV: Record<string, string> = {
 "Sous-chef": "S.Chef",
 "Sous-chef de rang": "S.C.Rang",
 "Chef de rang": "C.Rang",
};

function abbreviateSubRole(raw: string): string {
 return SUB_ROLE_ABBREV[raw] ?? (raw.length <= 10 ? raw : raw.slice(0, 9) + ".");
}

export function ServiceCard({ service, topPx, heightPx, onClick, onDoubleClick, selected, dimmed, narrow, assignedSubRole, actionSlot }: ServiceCardProps) {
 const dragOccurred = useRef(false);
 const { attributes, listeners, setNodeRef, transform, isDragging } =
 useDraggable({
 id: service.id,
 data: { service },
 });

 useEffect(() => {
 if (transform && (Math.abs(transform.x) > 3 || Math.abs(transform.y) > 3)) {
 dragOccurred.current = true;
 }
 if (!transform && !isDragging) {
 dragOccurred.current = false;
 }
 }, [transform, isDragging]);

 const color = getWorkerColor(service.workerId);
 const subRoleLabel = assignedSubRole ? abbreviateSubRole(assignedSubRole) : null;
 const crossFilled = !!service.filledAs;
 const crossFillTitle = crossFilled
   ? `${service.workerName} comble ce poste comme ${service.filledAs}` + (assignedSubRole ? ` (poste demandant ${assignedSubRole})` : "")
   : undefined;

 const style: React.CSSProperties = {
 position: "absolute",
 top: `${topPx}px`,
 height: `${Math.max(heightPx, 20)}px`,
 left: "2px",
 right: "2px",
 transform: transform
 ? `translate(${transform.x}px, ${transform.y}px)`
 : undefined,
 zIndex: isDragging ? 50 : selected ? 10 : 1,
 opacity: isDragging ? 0.8 : dimmed ? 0.15 : 1,
 transition: "opacity 0.2s ease",
 };

 return (
 <div
 ref={setNodeRef}
 style={style}
 title={crossFillTitle}
 className={cn(
 service.workerRole === "kitchen" ? "border-l-[3px] border-t-[3px] border-b-[3px] rounded-xl cursor-grab active:cursor-grabbing select-none overflow-hidden transition-shadow" : "border-r-[3px] border-t-[3px] border-b-[3px] rounded-xl cursor-grab active:cursor-grabbing select-none overflow-hidden transition-shadow",
 narrow ? "px-0" : "px-[var(--space-sm)]",
 cn(color.bg, color.border, color.text),
 selected && "ring-2 ring-foreground/60 shadow-md",
 isDragging && "shadow-lg ring-2 ring-foreground/20",
 crossFilled && "ring-2 ring-amber-500/80 ring-offset-1 ring-offset-background"
 )}
 onClick={(e) => {
 if (!dragOccurred.current && onClick) onClick(e);
 }}
 onDoubleClick={(e) => {
 if (!dragOccurred.current && onDoubleClick) onDoubleClick(e);
 }}
 {...attributes}
 {...listeners}
 >
 {actionSlot && (
 <div className="absolute top-[3px] right-[3px] z-20">
 {actionSlot}
 </div>
 )}
 <div className="flex items-center justify-center h-full">
 <span
 className={cn(
 "text-center leading-tight inline-flex items-center",
 narrow
 ? "text-[10px] font-light tracking-normal gap-[3px]"
 : "text-[length:var(--text-xs)] font-bold tracking-wide gap-[3px]"
 )}
 style={{ writingMode: "vertical-lr", transform: "rotate(180deg)" }}
 >
 {!narrow && getWorkerTier(service.workerId) !== "worker" && (
 <ChefCrown faded={getWorkerTier(service.workerId) === "sous-chef"} />
 )}
 {shortName(service.workerName)}
 {subRoleLabel && (
 <span className="inline-flex items-center justify-center px-[5px] py-[1px] rounded-full bg-black/15 dark:bg-white/15 text-[8px] font-medium leading-none whitespace-nowrap">
 {subRoleLabel}
 </span>
 )}
 {crossFilled && (
 <span className="inline-flex items-center justify-center w-[12px] h-[12px] rounded-full bg-amber-500 text-white" aria-label="Cross-fill">
 <AlertTriangle className="size-[8px]" strokeWidth={3} />
 </span>
 )}
 </span>
 </div>
 </div>
 );
}
