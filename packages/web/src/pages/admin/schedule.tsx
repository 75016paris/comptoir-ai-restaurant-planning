import { Fragment, useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
 DndContext,
 DragOverlay,
 type DragEndEvent,
 type DragStartEvent,
 type DragOverEvent,
 MouseSensor,
 TouchSensor,
 KeyboardSensor,
 useDraggable,
 useSensor,
 useSensors,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { toast } from "sonner";
import { api, type ServiceRow, type ServiceTemplate, type User, type RestaurantClosure, type AutostaffingPlan, type StaffingTarget, type StaffingProfile, type ProfileServiceTemplate, type StaffingInfo, type WeatherDay, type CalendarEvent, type AuditLogEntry, type ComplianceViolation, type LaborCostSummary } from "@/lib/api";
import { WeatherIconSvg, WeatherHeaderBadge, DayInfobox } from "@/components/weather-icons";
import { ComplianceBadge, ComplianceDialog } from "@/components/compliance-panel";
import { ServiceCard } from "@/components/service-card";
import { ChefCrown } from "@/components/chef-crown";
import { assignColors, getWorkerColor, getWorkerColorIndex, getWorkerTier, setColorPalettes } from "@/lib/colors";

import { ZoneDrop, CardStackInner } from "@/components/card-stack";
import { ServiceActionsMenu, GhostActionsMenu } from "@/components/service-actions-menu";
import { computeZoneStacksH, computeZoneExpandedH, computeMissingZoneH } from "@/components/card-stack-layout";
import { UnderlineNav } from "@/components/underline-nav";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn, shortName, errorMessage } from "@/lib/utils";
import { fmtDateShort, fmtDateMed, fmtDateRange, fmtMonthYearCap, JOURS, JOURS_COURTS, MOIS } from "@/lib/date-utils";
import { SchedulePrint } from "@/components/schedule-print";
import { ScheduleMobileTutorial } from "@/components/schedule-mobile-tutorial";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight, AlertTriangle, Trash2, ArrowLeft, ArrowRight, HelpCircle, Zap, Save, Pencil, Plus, RotateCw, Maximize2, Minimize2, Lock, Unlock, Printer, Calendar, CalendarDays, Link2 } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";
import { useIsMobile, useIsCompact } from "@/hooks/use-mobile";
import { useAuth } from "@/hooks/use-auth";

// Mirrors the four "preferredStyle" options exposed on /preferences → Règle.
// Display labels come from the `preferences` i18n namespace (styleLabels.*).
const STYLE_KEYS = ["equilibre", "equipe-stable", "economique", "resilience"] as const;

// ── Time grid config ──
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 26;
const HOUR_HEIGHT = 28;
const ROTATED_TRACK_HEIGHT = 24; // per stacked service band within a day row
const ROTATED_DAY_LABEL_WIDTH = 140;
const ROTATED_DAY_LABEL_WIDTH_MOBILE = 88;

function computeHourBounds(services: ServiceRow[]): { startHour: number; endHour: number } {
 if (services.length === 0) return { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR };
 let minStart = Infinity;
 let maxEnd = -Infinity;
 for (const s of services) {
 const [sh, sm] = s.startTime.split(":").map(Number);
 const [eh, em] = s.endTime.split(":").map(Number);
 const start = sh + sm / 60;
 let end = eh + em / 60;
 if (end <= start) end += 24;
 if (start < minStart) minStart = start;
 if (end > maxEnd) maxEnd = end;
 }
 return { startHour: minStart - 0.5, endHour: maxEnd + 0.5 };
}

function hourMarks(startHour: number, endHour: number): number[] {
 const marks: number[] = [];
 for (let h = Math.ceil(startHour); h <= Math.floor(endHour); h++) marks.push(h);
 return marks;
}
// Monday-first short day labels (Lun..Dim in FR / Mon..Sun in EN). Reads the
// current locale via JOURS_COURTS (which is Sunday-first) and reorders.
// Proxy so DAYS.map / DAYS[i] / DAYS.length all re-evaluate after locale change.
function _daysArr(): string[] {
 return [JOURS_COURTS[1], JOURS_COURTS[2], JOURS_COURTS[3], JOURS_COURTS[4], JOURS_COURTS[5], JOURS_COURTS[6], JOURS_COURTS[0]];
}
const DAYS: string[] = new Proxy(["", "", "", "", "", "", ""] as string[], {
 get(_, prop, receiver) {
  return Reflect.get(_daysArr(), prop, receiver);
 },
});

/** Get ISO day-of-week (1=Mon...7=Sun) from a YYYY-MM-DD string */
function dateToDow(dateStr: string): number {
 const d = new Date(dateStr + "T12:00:00");
 return d.getDay() === 0 ? 7 : d.getDay(); // JS 0=Sun → 7
}

function getMonday(date: Date): Date {
 const d = new Date(date);
 d.setHours(12, 0, 0, 0);
 const day = d.getDay();
 d.setDate(d.getDate() - ((day + 6) % 7));
 return d;
}

function fmt(date: Date): string {
 const y = date.getFullYear();
 const m = String(date.getMonth() + 1).padStart(2, "0");
 const d = String(date.getDate()).padStart(2, "0");
 return `${y}-${m}-${d}`;
}

const AUTO_STAFF_RELOAD_KEY = "comptoir:auto-staff-reload";

type AutoStaffReloadPayload = {
 monday: string;
 unfilled?: number;
 warnings?: string[];
};

function readAutoStaffReloadPayload(): AutoStaffReloadPayload | null {
 if (typeof window === "undefined") return null;
 try {
  const raw = window.sessionStorage.getItem(AUTO_STAFF_RELOAD_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<AutoStaffReloadPayload>;
  if (typeof parsed.monday !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.monday)) return null;
  return {
   monday: parsed.monday,
   unfilled: typeof parsed.unfilled === "number" ? parsed.unfilled : undefined,
   warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === "string") : undefined,
  };
 } catch {
  return null;
 }
}

function reloadScheduleAfterAutoStaff(payload: AutoStaffReloadPayload) {
 if (typeof window === "undefined") return;
 window.sessionStorage.setItem(AUTO_STAFF_RELOAD_KEY, JSON.stringify(payload));
 window.location.reload();
}

function isoWeekNum(dateStr: string): number {
 const d = new Date(dateStr + "T12:00:00");
 const thursday = new Date(d);
 thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
 const jan1 = new Date(thursday.getFullYear(), 0, 1);
 const dayDiff = Math.round((thursday.getTime() - jan1.getTime()) / 86400000);
 return Math.ceil((dayDiff + 1) / 7);
}

function isoWeekYear(dateStr: string): number {
 const d = new Date(dateStr + "T12:00:00");
 const thursday = new Date(d);
 thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
 return thursday.getFullYear();
}

function addDays(date: Date, n: number): Date {
 const d = new Date(date);
 d.setDate(d.getDate() + n);
 return d;
}

function timeToHours(t: string): number {
 const [h, m] = t.split(":").map(Number);
 return h + m / 60;
}

function serviceDurationHours(service: Pick<ServiceRow, "startTime" | "endTime">): number {
 const [sh, sm] = service.startTime.split(":").map(Number);
 const [eh, em] = service.endTime.split(":").map(Number);
 let mins = (eh * 60 + em) - (sh * 60 + sm);
 if (mins < 0) mins += 24 * 60;
 return mins / 60;
}

function compactHours(value: number): string {
 return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function servicePosition(startTime: string, endTime: string, startHour: number, endHour: number) {
 const startH = timeToHours(startTime);
 let endH = timeToHours(endTime);
 if (endH <= startH) endH += 24;
 const visibleStart = Math.max(startH, startHour);
 const visibleEnd = Math.min(endH, endHour);
 if (visibleStart >= visibleEnd) return null;
 const topPx = (visibleStart - startHour) * HOUR_HEIGHT;
 const heightPx = (visibleEnd - visibleStart) * HOUR_HEIGHT;
 return { topPx, heightPx };
}

function formatHour(h: number): string {
 const actual = h % 24;
 return `${String(actual).padStart(2, "0")}:00`;
}

function hoursToTime(h: number): string {
 const total = Math.round(h * 60);
 const hh = Math.floor(total / 60) % 24;
 const mm = total % 60;
 return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function roleTimeDisplay(legs: { startTime: string; endTime: string }[]): { label: string; title: string } {
 const sorted = legs.slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
 if (sorted.length === 0) return { label: "", title: "" };
 if (sorted.length === 1) {
  const leg = sorted[0];
  const label = `${leg.startTime.slice(0, 5)}-${leg.endTime.slice(0, 5)}`;
  return { label, title: label };
 }
 const first = sorted[0];
 const last = sorted[sorted.length - 1];
 const detail = sorted.map(l => `${l.startTime.slice(0, 5)}-${l.endTime.slice(0, 5)}`).join(" + ");
 return {
  label: `${first.startTime.slice(0, 5)} >>> ${last.endTime.slice(0, 5)}`,
  title: detail,
 };
}

// ── Zone definitions (derived from service templates) ──

export type ZoneDayOverride = {
 kitchenStart?: string;
 kitchenEnd?: string;
 serviceStart?: string;
 serviceEnd?: string;
};

export type ZoneDefinition = {
 label: string;
 sortOrder: number;
 kitchenStart: string;
 kitchenEnd: string;
 serviceStart: string;
 serviceEnd: string;
 rangeStart: string; // min(kitchenStart, serviceStart)
 rangeEnd: string; // max(kitchenEnd, serviceEnd)
 dayOverrides?: Record<number, ZoneDayOverride>; // 1=Mon...7=Sun
 isCoupure?: boolean; // true when the zone has 2+ template blocks per role (split shift)
 roleLegs?: Partial<Record<"kitchen" | "floor", Array<{ startTime: string; endTime: string; overrides?: Array<{ dayOfWeek: number; startTime: string; endTime: string }> }>>>;
};



function zoneDefsFromTemplates(templates: ServiceTemplate[]): ZoneDefinition[] {
 if (templates.length === 0) return [];
 // Group by sortOrder (not zone label) so duplicate labels don't merge
 const groupMap = new Map<number, ZoneDefinition>();
 for (const t of templates) {
 const key = t.sortOrder ?? 0;
 if (!groupMap.has(key)) {
 groupMap.set(key, {
 label: t.zone,
 sortOrder: key,
 kitchenStart: "", kitchenEnd: "",
 serviceStart: "", serviceEnd: "",
 rangeStart: "", rangeEnd: "",
 roleLegs: { kitchen: [], floor: [] },
 });
 }
 const g = groupMap.get(key)!;
 if (t.role === "kitchen") {
 // For coupure: keep the earliest start and latest end
 if (!g.kitchenStart || t.startTime < g.kitchenStart) g.kitchenStart = t.startTime;
 if (!g.kitchenEnd || t.endTime > g.kitchenEnd) g.kitchenEnd = t.endTime;
 g.roleLegs?.kitchen?.push({ startTime: t.startTime, endTime: t.endTime, overrides: t.overrides });
 } else {
 if (!g.serviceStart || t.startTime < g.serviceStart) g.serviceStart = t.startTime;
 if (!g.serviceEnd || t.endTime > g.serviceEnd) g.serviceEnd = t.endTime;
 g.roleLegs?.floor?.push({ startTime: t.startTime, endTime: t.endTime, overrides: t.overrides });
 }
 // Merge per-day overrides
 if (t.overrides && t.overrides.length > 0) {
 if (!g.dayOverrides) g.dayOverrides = {};
 for (const o of t.overrides) {
 if (!g.dayOverrides[o.dayOfWeek]) g.dayOverrides[o.dayOfWeek] = {};
 if (t.role === "kitchen") {
 g.dayOverrides[o.dayOfWeek].kitchenStart = o.startTime;
 g.dayOverrides[o.dayOfWeek].kitchenEnd = o.endTime;
 } else {
 g.dayOverrides[o.dayOfWeek].serviceStart = o.startTime;
 g.dayOverrides[o.dayOfWeek].serviceEnd = o.endTime;
 }
 }
 }
 }
 // Compute range + coupure flag (any role with 2+ template blocks → split shift)
 for (const g of groupMap.values()) {
 const starts = [g.kitchenStart, g.serviceStart].filter(Boolean);
 const ends = [g.kitchenEnd, g.serviceEnd].filter(Boolean);
 g.rangeStart = starts.length > 0 ? starts.sort()[0] : "00:00";
 g.rangeEnd = ends.length > 0 ? ends.sort().reverse()[0] : "23:59";
 const perRole = new Map<string, number>();
 for (const t of templates) {
 if ((t.sortOrder ?? 0) === g.sortOrder) perRole.set(t.role, (perRole.get(t.role) ?? 0) + 1);
 }
 g.isCoupure = Array.from(perRole.values()).some(c => c >= 2);
 }
 // Sort by earliest start time (rangeStart), earliest first
 const defs = Array.from(groupMap.values()).sort((a, b) => a.rangeStart.localeCompare(b.rangeStart));
 return defs;
}

/** Assign a service to the zone whose rangeStart is closest to (and <=) the service's startTime.
 * If service starts before all zones, assign to first zone.
 * When `dayServices` is provided, route services into a coupure zone only when
 * the worker's same-day services exactly match that coupure's template legs.
 * A regular Midi+Soir double should stay visible in Midi and Soir. */
function assignServiceToZone(service: ServiceRow, zones: ZoneDefinition[], dayServices?: ServiceRow[]): string {
 if (zones.length === 0) return "midi";
 if (zones.length === 1) return zones[0].label;
 const role = (service.workerRole || service.role) as "kitchen" | "floor";
 const dow = dateToDow(service.date);
 if (dayServices) {
 const siblings = dayServices.filter(s => s.workerId === service.workerId && s.date === service.date && (s.workerRole || s.role) === role);
 if (siblings.length >= 2) {
 for (const coupureZone of zones.filter(z => z.isCoupure)) {
 const legs = (coupureZone.roleLegs?.[role] ?? [])
 .map(l => {
 const ov = l.overrides?.find(o => o.dayOfWeek === dow);
 return { startTime: ov?.startTime ?? l.startTime, endTime: ov?.endTime ?? l.endTime };
 })
 .sort((a, b) => a.startTime.localeCompare(b.startTime));
 if (legs.length < 2) continue;
 const legKeys = new Set(legs.map(l => `${l.startTime}-${l.endTime}`));
 const siblingKeys = new Set(siblings.map(s => `${s.startTime}-${s.endTime}`));
 const serviceKey = `${service.startTime}-${service.endTime}`;
 if (legKeys.has(serviceKey) && legs.every(l => siblingKeys.has(`${l.startTime}-${l.endTime}`))) {
 return coupureZone.label;
 }
 }
 }
 }
 // Exact template match wins before range fallback. This matters when two zones
 // start at the same time (e.g. Midi 08:00-16:00 and Coupure first leg
 // 08:00-13:30): a Midi service must not fall through into Coupure just
 // because Coupure shares the same rangeStart.
 for (const z of zones) {
 const legs = z.roleLegs?.[role] ?? [];
 for (const leg of legs) {
 const ov = leg.overrides?.find(o => o.dayOfWeek === dow);
 const startTime = ov?.startTime ?? leg.startTime;
 const endTime = ov?.endTime ?? leg.endTime;
 if (service.startTime === startTime && service.endTime === endTime) return z.label;
 }
 }
 // Find the zone whose rangeStart is <= service.startTime and closest
 let best = zones[0];
 for (const z of zones) {
 if (z.rangeStart <= service.startTime) {
 best = z;
 }
 }
 return best.label;
}

/** Get default times for a zone + role, with optional per-day override */
function zoneDefaultTimes(zone: ZoneDefinition, role: string, dayOfWeek?: number): { startTime: string; endTime: string } {
 const ov = dayOfWeek ? zone.dayOverrides?.[dayOfWeek] : undefined;
 if (role === "kitchen") {
 return {
 startTime: ov?.kitchenStart || zone.kitchenStart || zone.rangeStart,
 endTime: ov?.kitchenEnd || zone.kitchenEnd || zone.rangeEnd,
 };
 }
 return {
 startTime: ov?.serviceStart || zone.serviceStart || zone.rangeStart,
 endTime: ov?.serviceEnd || zone.serviceEnd || zone.rangeEnd,
 };
}


export function AdminSchedulePage() {
 const { t } = useTranslation(["schedule", "common"]);
 const navigate = useNavigate();
 const { user } = useAuth();
 const activeRestaurantId = user?.activeRestaurantId ?? user?.restaurantId ?? "";
 const isMobile = useIsMobile();
 const isCompact = useIsCompact();
 const dayLabelWidth = isMobile ? ROTATED_DAY_LABEL_WIDTH_MOBILE : ROTATED_DAY_LABEL_WIDTH;
 const [monday, setMonday] = useState(() => {
  const pendingReload = readAutoStaffReloadPayload();
  return pendingReload ? getMonday(new Date(`${pendingReload.monday}T12:00:00`)) : getMonday(new Date());
 });
 const [services, setServices] = useState<ServiceRow[]>([]);
 const [cancelledServices, setCancelledServices] = useState<ServiceRow[]>([]);
 const [gridRotated, setGridRotated] = useState(true);
 const { startHour, endHour } = useMemo(() => computeHourBounds(services), [services]);
 const totalHours = endHour - startHour;
 const [staffingInfo, setStaffingInfo] = useState<StaffingInfo | null>(null);
 const [laborCost, setLaborCost] = useState<LaborCostSummary | null>(null);
 const [workers, setWorkers] = useState<User[]>([]);
 const [loading, setLoading] = useState(true);

 const [roleFilter, setRoleFilter] = useState<"all" | "kitchen" | "floor" | "missing">("all");
 const [subRoleFilter, setSubRoleFilter] = useState<Set<string>>(new Set());
 const [selectedWorkerIds, setSelectedWorkerIds] = useState<Set<string>>(() => {
 const params = new URLSearchParams(window.location.search);
 const w = params.get("worker");
 return w ? new Set([w]) : new Set();
 });
 // Compat: many callsites use single-worker checks
 const selectedWorkerId = selectedWorkerIds.size === 1 ? [...selectedWorkerIds][0]! : null;
 const isWorkerSelected = (id: string) => selectedWorkerIds.has(id);
 const isWorkerDimmed = (id: string) => selectedWorkerIds.size > 0 && !selectedWorkerIds.has(id);
 const toggleWorker = (id: string) => setSelectedWorkerIds(prev => {
 const next = new Set(prev);
 if (next.has(id)) next.delete(id); else next.add(id);
 return next;
 });
 const clearWorkerSelection = () => setSelectedWorkerIds(new Set());
 const [viewMode, setViewMode] = useState<"grid" | "list" | "stack">("stack");
 const [timeRange, setTimeRange] = useState<"week" | "month">("week");
 // Compact (≤lg) stack view shows two consecutive days. Index is 0=Mon..6=Dim — anchor of the pair within `monday`'s week.
 const [stackDayIdx, setStackDayIdx] = useState<number>(() => {
  const today = new Date();
  return (today.getDay() + 6) % 7;
 });
 // Explicit user override for stack layout. Default is the 7-day week view on
 // every viewport; the 2-day "day" mode is available on demand for narrow screens.
 const [stackLayoutOverride, setStackLayoutOverride] = useState<"week" | "day" | null>(null);
 const stackLayout: "week" | "day" = stackLayoutOverride ?? "week";
 // Swipe-to-paginate the 2-day window. Steps by 2; clamps at week edges and crosses weeks at the ends.
 const stackSwipeStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
 const advanceStackPair = useCallback(() => {
  const anchor = Math.min(5, Math.max(0, stackDayIdx));
  if (anchor + 2 <= 5) setStackDayIdx(anchor + 2);
  else if (anchor < 5) setStackDayIdx(5);
  else {
   setMonday((prev) => addDays(prev, 7));
   setStackDayIdx(0);
  }
 }, [stackDayIdx]);
 const retreatStackPair = useCallback(() => {
  const anchor = Math.min(5, Math.max(0, stackDayIdx));
  if (anchor - 2 >= 0) setStackDayIdx(anchor - 2);
  else if (anchor > 0) setStackDayIdx(0);
  else {
   setMonday((prev) => addDays(prev, -7));
   setStackDayIdx(4);
  }
 }, [stackDayIdx]);
 const onStackTouchStart = useCallback((e: React.TouchEvent) => {
  const t = e.touches[0];
  if (!t) return;
  stackSwipeStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
 }, []);
 const onStackTouchEnd = useCallback(
  (e: React.TouchEvent) => {
   const start = stackSwipeStartRef.current;
   stackSwipeStartRef.current = null;
   if (!start) return;
   const t = e.changedTouches[0];
   if (!t) return;
   const dx = t.clientX - start.x;
   const dy = t.clientY - start.y;
   if (Date.now() - start.t > 700) return;
   if (Math.abs(dx) < 50) return;
   if (Math.abs(dy) > Math.abs(dx)) return;
   if (dx < 0) advanceStackPair();
   else retreatStackPair();
  },
  [advanceStackPair, retreatStackPair],
 );
 // Center the selected chip in the horizontal date strip. The strip div is
 // position: relative (see JSX below), so chip.offsetLeft is measured against
 // it directly — no viewport math, no offsetParent guessing. We retry the
 // scroll on three tracks (sync, rAF, setTimeout) because iOS Safari has been
 // observed to silently no-op the assignment on the first tick after a remount.
 useEffect(() => {
 if (stackLayout !== "day") return;
 const el = dayStripScrollRef.current;
 if (!el) return;
 const center = () => {
 const chip = el.querySelector<HTMLElement>("[data-day-selected]");
 if (!chip) return;
 el.scrollLeft = chip.offsetLeft + chip.offsetWidth / 2 - el.clientWidth / 2;
 };
 center();
 const rafId = requestAnimationFrame(center);
 const timeoutId = setTimeout(center, 80);
 return () => {
 cancelAnimationFrame(rafId);
 clearTimeout(timeoutId);
 };
 }, [stackLayout, monday, stackDayIdx]);
  const [unstackAll, setUnstackAll] = useState(false);
 // Touch long-press: select a card, then long-press a zone to move it
 const [touchSelectedService, setTouchSelectedService] = useState<ServiceRow | null>(null);
 // Mobile worker dropdowns: tap a worker name to pick them up, long-press a zone to place.
 const [touchSelectedWorker, setTouchSelectedWorker] = useState<User | null>(null);
 const [openMobileRoleDropdown, setOpenMobileRoleDropdown] = useState<"kitchen" | "floor" | null>(null);
 const [gridScrolledY, setGridScrolledY] = useState(false);
 const handleGridScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
  setGridScrolledY(e.currentTarget.scrollTop > 10);
 }, []);
 // Callback ref: set maxHeight so grid fills from its position to viewport bottom
 const gridRefCb = useCallback((el: HTMLDivElement | null) => {
  if (!el) return;
  // Wait one frame so layout is settled before measuring
  requestAnimationFrame(() => {
   const rect = el.getBoundingClientRect();
   el.style.maxHeight = `${Math.max(120, window.innerHeight - rect.top)}px`;
  });
 }, []);
  const [legendOpen, setLegendOpen] = useState(false);

 // Double-click a bar in Calendrier → time edit dialog for that service only
 // (updates the services row, not the objectif template).
 const [timeEditService, setTimeEditService] = useState<ServiceRow | null>(null);
 const [timeEditStart, setTimeEditStart] = useState("");
 const [timeEditEnd, setTimeEditEnd] = useState("");
 const [timeEditSaving, setTimeEditSaving] = useState(false);
 const [timeEditError, setTimeEditError] = useState("");
 const openTimeEdit = useCallback((service: ServiceRow) => {
  setTimeEditService(service);
  setTimeEditStart(service.startTime.slice(0, 5));
  setTimeEditEnd(service.endTime.slice(0, 5));
  setTimeEditError("");
 }, []);
 const closeTimeEdit = useCallback(() => {
  setTimeEditService(null);
  setTimeEditError("");
 }, []);
 const [calendarAction, setCalendarAction] = useState<{ service: ServiceRow; x: number; y: number; open: boolean } | null>(null);
 const openCalendarAction = useCallback((service: ServiceRow, e: React.MouseEvent) => {
  e.stopPropagation();
  const x = e.clientX;
  const y = e.clientY;
  // Defer mounting the controlled Base UI menu until after the opening click
  // has bubbled; otherwise the same click can be observed as an outside press
  // and immediately close the menu in Calendrier view.
  setCalendarAction(null);
  window.setTimeout(() => setCalendarAction({ service, x, y, open: true }), 0);
 }, []);
 useEffect(() => {
  if (!calendarAction?.open) return;
  const closeIfOutside = (event: PointerEvent) => {
   const target = event.target instanceof Element ? event.target : null;
   if (target?.closest('[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], [data-slot="dialog-content"]')) return;
   setCalendarAction(null);
  };
  const closeOnEscape = (event: KeyboardEvent) => {
   if (event.key === "Escape") setCalendarAction(null);
  };
  document.addEventListener("pointerdown", closeIfOutside, true);
  document.addEventListener("keydown", closeOnEscape, true);
  return () => {
   document.removeEventListener("pointerdown", closeIfOutside, true);
   document.removeEventListener("keydown", closeOnEscape, true);
  };
 }, [calendarAction?.open]);

 // Fullscreen toggle — wraps the entire schedule (toolbar + grid).
 const scheduleRootRef = useRef<HTMLDivElement | null>(null);
 const [isFullscreen, setIsFullscreen] = useState(false);
 useEffect(() => {
  const sync = () => setIsFullscreen(document.fullscreenElement === scheduleRootRef.current);
  document.addEventListener("fullscreenchange", sync);
  return () => document.removeEventListener("fullscreenchange", sync);
 }, []);
 const toggleFullscreen = useCallback(() => {
  const el = scheduleRootRef.current;
  if (!el) return;
  if (document.fullscreenElement === el) void document.exitFullscreen();
  else void el.requestFullscreen().catch(() => {});
 }, []);

 // Month view state (shared by grid-month and stack-month)
 const [monthDate, setMonthDate] = useState(() => {
 const now = new Date();
 return new Date(now.getFullYear(), now.getMonth(), 1);
 });
 const [monthServices, setMonthServices] = useState<ServiceRow[]>([]);
 const [monthLoading, setMonthLoading] = useState(false);

 // Live clock for the "now" line - ticks every 60s
 const [nowTime, setNowTime] = useState(() => new Date().toTimeString().slice(0, 5));
 useEffect(() => {
 const id = setInterval(() => setNowTime(new Date().toTimeString().slice(0, 5)), 60_000);
 return () => clearInterval(id);
 }, []);

 // List view uses its own month-based state
 const [listMonth, setListMonth] = useState(() => {
 const now = new Date();
 return new Date(now.getFullYear(), now.getMonth(), 1);
 });
 const [listServices, setListServices] = useState<ServiceRow[]>([]);
 const [listLoading, setListLoading] = useState(false);

 // Scroll to today's day section when list view opens or month changes
 const nowLineRef = useRef<HTMLDivElement>(null);
 const todayRef = useRef<HTMLDivElement>(null);
 const listScrollRef = useRef<HTMLDivElement>(null);
 const dayStripScrollRef = useRef<HTMLDivElement>(null);
 const listMountedRef = useRef(false);
 useEffect(() => {
 if (viewMode !== "list" || listLoading) {
 listMountedRef.current = false;
 return;
 }
 const timer = setTimeout(() => {
 const scrollEl = listScrollRef.current;
 const todayEl = todayRef.current;
 if (scrollEl && todayEl) {
 const containerTop = scrollEl.getBoundingClientRect().top;
 const todayTop = todayEl.getBoundingClientRect().top;
 scrollEl.scrollTo({ top: scrollEl.scrollTop + (todayTop - containerTop), behavior: listMountedRef.current ? "smooth" : "instant" });
 }
 listMountedRef.current = true;
 }, 50);
 return () => clearTimeout(timer);
 }, [viewMode, listLoading, listMonth]);

 // MouseSensor + TouchSensor instead of PointerSensor, so touch devices
 // ONLY go through TouchSensor's long-press delay. PointerSensor would grab
 // touch events on an 8px move, bypassing the delay entirely.
 const sensors = useSensors(
 useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
 useSensor(TouchSensor, { activationConstraint: { delay: 450, tolerance: 6 } }),
 useSensor(KeyboardSensor)
 );

 // Track drag state for greying out non-source/non-target zones
 const [dragSource, setDragSource] = useState<string | null>(null);
 const [dragOver, setDragOver] = useState<string | null>(null);

 // Track dragged item's role - survives week navigation during drag
 const [draggedRole, setDraggedRole] = useState<string | null>(null);

 // Track active drag item for DragOverlay (portal-rendered, always on top)
 const [activeDragItem, setActiveDragItem] = useState<{ service: ServiceRow } | { worker: User } | null>(null);

 // Track which zone has an expanded stack (hover or drag-over) for z-index elevation
 const [activeZone, setActiveZone] = useState<string | null>(null);

 // Two-stage dwell (touch only): hovering a destination zone reveals individual
 // slots after DWELL_UNSTACK_MS (the stack visually unstacks), then keeping the
 // finger on the same slot for DWELL_READY_MS arms the green "ready" pulse.
 // Release commits only after stage B fires; earlier release cancels silently.
 const DWELL_UNSTACK_MS = 350;
 const DWELL_READY_MS = 700;
 const touchDragRef = useRef(false);
 const [touchDragActive, setTouchDragActive] = useState(false);
 const dwellTargetRef = useRef<string | null>(null);
 const readyCompleteRef = useRef(false);
 const unstackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
 const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
 const [unstackedZoneId, setUnstackedZoneId] = useState<string | null>(null);
 const [readyZoneId, setReadyZoneId] = useState<string | null>(null);
 // When stage A unstacks a zone, scroll it into the viewport center so the
 // user can see the slots they're about to drop onto (their finger may be
 // covering part of the area).
 useEffect(() => {
  if (!unstackedZoneId) return;
  const el = document.querySelector<HTMLElement>(`[data-zone-id="${CSS.escape(unstackedZoneId)}"]`);
  if (el && typeof el.scrollIntoView === "function") {
   el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }
 }, [unstackedZoneId]);
 const clearDwell = useCallback(() => {
  if (unstackTimerRef.current) { clearTimeout(unstackTimerRef.current); unstackTimerRef.current = null; }
  if (readyTimerRef.current) { clearTimeout(readyTimerRef.current); readyTimerRef.current = null; }
  dwellTargetRef.current = null;
  readyCompleteRef.current = false;
  setUnstackedZoneId(null);
  setReadyZoneId(null);
 }, []);

 // Pending past-date action - stored when user drags to a past date, awaiting confirmation
 const [pendingPastAction, setPendingPastAction] = useState<(() => Promise<void>) | null>(null);

 // Pending closure action - stored when user creates/moves to a closure date
 const [pendingClosureAction, setPendingClosureAction] = useState<{ action: () => Promise<void>; closureReason: string | null } | null>(null);

 // Restaurant closures
 const [closures, setClosures] = useState<RestaurantClosure[]>([]);
 const [restaurantName, setRestaurantName] = useState("");
  const [disabledComplianceRules, setDisabledComplianceRules] = useState<string[]>([]);

 // Pending worker drop - show service type selector before creating
 const [pendingWorkerDrop, setPendingWorkerDrop] = useState<{ worker: User; targetDay: string } | null>(null);

 // Auto-staffing
 const [showAutoStaff, setShowAutoStaff] = useState(false);
 const [showCompliance, setShowCompliance] = useState(false);
 const [autoStaffPreview, setAutoStaffPreview] = useState<AutostaffingPlan | null>(null);
 const [autoStaffLoading, setAutoStaffLoading] = useState(false);
 const [autoStaffTargets, setAutoStaffTargets] = useState<Record<string, number>>({});
 const [defaultTargets, setDefaultTargets] = useState<StaffingTarget[]>([]);
 const [allProfiles, setAllProfiles] = useState<{ profile: StaffingProfile; targets: StaffingTarget[] }[]>([]);
 const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
 const [, setSavedProfileId] = useState<string | null>(null);
 const [openDays, setOpenDays] = useState<Record<string, string>>({});
 const [showHowItWorks, setShowHowItWorks] = useState(false);

 // Zone definitions derived from service templates
 const [zoneDefs, setZoneDefs] = useState<ZoneDefinition[]>([]);
 const [globalZoneDefs, setGlobalZoneDefs] = useState<ZoneDefinition[]>([]);
 const [globalTemplates, setGlobalTemplates] = useState<ServiceTemplate[]>([]);
 const [hasTemplates, setHasTemplates] = useState(true); // assume true until loaded
 const [profileTemplatesMap, setProfileTemplatesMap] = useState<Map<string, ProfileServiceTemplate[]>>(new Map());
 // Raw per-leg templates for the active zoneDefs — used to expand coupure drops into both legs.
 const [activeTemplates, setActiveTemplates] = useState<ServiceTemplate[]>([]);

 const handlePrint = useCallback(() => {
 const prevTitle = document.title;
 document.title = `Planning ${fmtDateRange(fmt(monday), fmt(addDays(monday, 6)))}`;
 window.print();
 document.title = prevTitle;
 }, [monday]);

 const handleAutoStaffPreview = useCallback(async (overrides?: Record<string, number>) => {
 setAutoStaffLoading(true);
 try {
 // Use provided overrides, or init from defaults
 const tMap = overrides ?? Object.fromEntries(
 defaultTargets.map((t) => [`${t.dayOfWeek}_${t.role}_${t.zone}`, t.count])
 );
 if (!overrides) setAutoStaffTargets(tMap);

 // Convert map to array for API
 const targetArr: StaffingTarget[] = Object.entries(tMap)
 .filter(([, count]) => count > 0)
 .map(([key, count]) => {
 const parts = key.split("_");
 const d = parts[0];
 const role = parts[1] as "kitchen" | "floor";
 const zone = parts.slice(2).join("_");
 return { dayOfWeek: Number(d), role, zone, count };
 });

 const res = await api.previewSchedule(fmt(monday), targetArr, activeProfileId ?? undefined);
 setAutoStaffPreview(res.data);
 setShowAutoStaff(true);
 } catch (err) {
 toast.error(errorMessage(err, t("schedule:toasts.previewFailed")));
 } finally {
 setAutoStaffLoading(false);
 }
 }, [monday, defaultTargets, activeProfileId, t]);

 const [gapWarnings, setGapWarnings] = useState<string[]>([]);
 const [showGapWarning, setShowGapWarning] = useState(false);
 const showUnfilledDiagnostics = useCallback((unfilled?: number, warnings?: string[]) => {
 if (unfilled && unfilled > 0) {
 const relevantWarnings = (warnings || []).filter(w =>
 w.startsWith("Poste non pourvu") || w.startsWith("Mode exceptionnel") || w.startsWith("Planning complété") || w.includes("available for") || w.includes("cap") || w.includes("No ")
 );
 setGapWarnings(relevantWarnings);
 setShowGapWarning(true);
 } else {
 setGapWarnings([]);
 }
 }, []);

 useEffect(() => {
 const payload = readAutoStaffReloadPayload();
 if (!payload || payload.monday !== fmt(monday)) return;
 window.sessionStorage.removeItem(AUTO_STAFF_RELOAD_KEY);
 showUnfilledDiagnostics(payload.unfilled, payload.warnings);
 }, [monday, showUnfilledDiagnostics]);

 const handleAutoStaffGenerate = useCallback(async () => {
 setAutoStaffLoading(true);
 try {
 const targetArr: StaffingTarget[] = Object.entries(autoStaffTargets)
 .filter(([, count]) => count > 0)
 .map(([key, count]) => {
 const parts = key.split("_");
 const d = parts[0];
 const role = parts[1] as "kitchen" | "floor";
 const zone = parts.slice(2).join("_");
 return { dayOfWeek: Number(d), role, zone, count };
 });
 const res = await api.generateSchedule(fmt(monday), false, targetArr, activeProfileId ?? undefined);
 toast(t("schedule:toasts.servicesGenerated", { count: res.data.created }) + (res.data.skipped ? t("schedule:toasts.skippedOverlaps", { count: res.data.skipped }) : ""));
 setShowAutoStaff(false);
 setAutoStaffPreview(null);
 reloadScheduleAfterAutoStaff({ monday: fmt(monday), unfilled: res.data.unfilled, warnings: res.data.warnings });
 } catch (err) {
 toast.error(errorMessage(err, t("schedule:toasts.generationFailed")));
 } finally {
 setAutoStaffLoading(false);
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchData is declared later in this large component; it is stable.
 }, [monday, autoStaffTargets, activeProfileId, showUnfilledDiagnostics, t]);

 const [, setSavingProfile] = useState(false);
  const selectAndSaveProfile = useCallback(async (profileId: string | null) => {
    setActiveProfileId(profileId);
    if (!profileId) {
      // Clear assignment
      setSavingProfile(true);
      try {
        const mondayStr = fmt(monday);
        const year = isoWeekYear(mondayStr);
        const week = isoWeekNum(mondayStr);
        await api.updateStaffingSchedule([{ profileId: "none", year, week }]);
        setSavedProfileId(null);
        if (roleFilter === "missing") setRoleFilter("all");
      } catch (err) {
        toast.error(errorMessage(err, t("schedule:toasts.saveFailed")));
      } finally {
        setSavingProfile(false);
      }
      return;
    }
    setSavingProfile(true);
    try {
      const mondayStr = fmt(monday);
      const year = isoWeekYear(mondayStr);
      const week = isoWeekNum(mondayStr);
      await api.updateStaffingSchedule([{ profileId, year, week }]);
      setSavedProfileId(profileId);
    } catch (err) {
      toast.error(errorMessage(err, t("schedule:toasts.saveFailed")));
    } finally {
      setSavingProfile(false);
    }
  }, [monday, roleFilter, t]);

 const [fillingGaps, setFillingGaps] = useState(false);
 const [styleOverride, setStyleOverride] = useState<"equilibre" | "equipe-stable" | "economique" | "resilience">("equilibre");
 const styleSeededRef = useRef(false);
 const [showStaffChoice, setShowStaffChoice] = useState(false);
 const [showWipeWeek, setShowWipeWeek] = useState(false);
  const [weekPublished, setWeekPublished] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [weekLocked, setWeekLocked] = useState(false);
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const unlockedWeeksRef = useRef<Set<string>>(new Set());
  const [, forceUnlockRender] = useState(0);
  const [complianceViolations, setComplianceViolations] = useState<ComplianceViolation[]>([]);
 const [wipingWeek, setWipingWeek] = useState(false);
  const [wipeWarning, setWipeWarning] = useState<string | null>(null);
 const [showWeekAudit, setShowWeekAudit] = useState(false);
 const [weekAuditLogs, setWeekAuditLogs] = useState<AuditLogEntry[]>([]);
 const [weekAuditLoading, setWeekAuditLoading] = useState(false);
 const handleFillGaps = useCallback(async () => {
 setFillingGaps(true);
 try {
 const targets = allProfiles.find(p => p.profile.id === activeProfileId)?.targets ?? defaultTargets;
 const targetArr: StaffingTarget[] = targets.map(t => ({
 dayOfWeek: t.dayOfWeek, role: t.role, zone: t.zone, count: t.count,
 }));
 const res = await api.generateSchedule(fmt(monday), false, targetArr, activeProfileId ?? undefined, styleOverride);
 const { created, skipped, unfilled, warnings } = res.data;
 toast(t("schedule:toasts.servicesAdded", { count: created }) + (skipped ? t("schedule:toasts.skippedSimple", { count: skipped }) : ""));
 reloadScheduleAfterAutoStaff({ monday: fmt(monday), unfilled, warnings });
 } catch (err) {
 toast.error(errorMessage(err, t("schedule:toasts.fillFailed")));
 } finally {
 setFillingGaps(false);
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchData is declared later in this large component; it is stable.
 }, [monday, activeProfileId, allProfiles, defaultTargets, styleOverride, showUnfilledDiagnostics, t]);

 const handleReplaceStaff = useCallback(async () => {
 setFillingGaps(true);
 try {
 const targets = allProfiles.find(p => p.profile.id === activeProfileId)?.targets ?? defaultTargets;
 const targetArr: StaffingTarget[] = targets.map(t => ({
 dayOfWeek: t.dayOfWeek, role: t.role, zone: t.zone, count: t.count,
 }));
 const res = await api.generateSchedule(fmt(monday), true, targetArr, activeProfileId ?? undefined, styleOverride);
 const { created, skipped, unfilled, warnings } = res.data;
 toast(t("schedule:toasts.servicesReplaced", { count: created }) + (skipped ? t("schedule:toasts.skippedSimple", { count: skipped }) : ""));
 reloadScheduleAfterAutoStaff({ monday: fmt(monday), unfilled, warnings });
 } catch (err) {
 toast.error(errorMessage(err, t("schedule:toasts.replaceFailed")));
 } finally {
 setFillingGaps(false);
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchData is declared later in this large component; it is stable.
 }, [monday, activeProfileId, allProfiles, defaultTargets, styleOverride, showUnfilledDiagnostics, t]);

 const handleStaffClick = useCallback(async () => {
 // If no profile selected, auto-select the first one
 if (!activeProfileId && allProfiles.length > 0) {
 await selectAndSaveProfile(allProfiles[0].profile.id);
 }
 if (staffingInfo?.hasAuto) {
 setShowStaffChoice(true);
 } else {
 handleFillGaps();
 }
 }, [staffingInfo?.hasAuto, handleFillGaps, activeProfileId, allProfiles, selectAndSaveProfile]);

 const handleOpenWeekAudit = useCallback(async () => {
 setShowWeekAudit(true);
 setWeekAuditLoading(true);
 try {
 const from = fmt(monday);
 const to = fmt(addDays(monday, 6));
 const res = await api.getAuditLogs({ from, to, limit: 50 });
 setWeekAuditLogs(res.data);
 } catch (err) {
 console.error("Failed to load audit logs", err);
 setWeekAuditLogs([]);
 } finally {
 setWeekAuditLoading(false);
 }
 }, [monday]);

 const handleZoneActiveChange = useCallback((zoneId: string, active: boolean) => {
 setActiveZone(prev => active ? zoneId : (prev === zoneId ? null : prev));
 }, []);

 /** Check if a date falls within any restaurant closure */
 const getClosureForDate = useCallback((dateStr: string): RestaurantClosure | null => {
 return closures.find((c) => dateStr >= c.startDate && dateStr <= c.endDate) || null;
 }, [closures]);

 const [weatherMap, setWeatherMap] = useState<Map<string, WeatherDay>>(new Map());
 const [openDayInfobox, setOpenDayInfobox] = useState<string | null>(null);
 const dayHeaderRefs = useRef<Map<string, HTMLElement>>(new Map());
 const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);

 useEffect(() => {
 if (!activeRestaurantId) return;
 styleSeededRef.current = false;
 unlockedWeeksRef.current = new Set();
 setServices([]);
 setCancelledServices([]);
 setMonthServices([]);
 setListServices([]);
 setWorkers([]);
 setClosures([]);
 setWeatherMap(new Map());
 setCalendarEvents([]);
 setComplianceViolations([]);
 setWeekPublished(false);
 setWeekLocked(false);
 setRestaurantName("");
 setStaffingInfo(null);
 setLaborCost(null);
 setAllProfiles([]);
 setDefaultTargets([]);
 setOpenDays({});
 setGlobalZoneDefs([]);
 setGlobalTemplates([]);
 setZoneDefs([]);
 setActiveTemplates([]);
 setProfileTemplatesMap(new Map());
 setActiveProfileId(null);
 setSavedProfileId(null);
 setSelectedWorkerIds(new Set());
 setRoleFilter("all");
 setSubRoleFilter(new Set());
 setHasTemplates(true);
 setOpenDayInfobox(null);
 setLoading(true);
 }, [activeRestaurantId]);

 /** Get calendar events (holidays + vacations) for a specific date */
 const getCalendarForDate = useCallback((dateStr: string) => {
 const holiday = calendarEvents.find(e => e.type === "public_holiday" && e.date === dateStr);
 const vacation = calendarEvents.find(e => e.type === "school_vacation" && dateStr >= e.date && dateStr <= (e.endDate || e.date));
 return { holiday, vacation };
 }, [calendarEvents]);

 // Schedule data is hydrated through this manual loop into local state.
 // Mutations call fetchData(monday) for the page's own refresh and additionally
 // invalidate cross-page query keys so /staff, /holidays, /preferences stay fresh.
 const fetchData = useCallback(async (mon: Date) => {
 if (!activeRestaurantId) return;
 setLoading(true);
 try {
 const to = new Date(mon); to.setDate(mon.getDate() + 6);
 const weekFrom = fmt(mon);
 const weekTo = fmt(to);
 const [weekRes, usersRes, closuresRes, prefsRes, weatherRes, calendarRes, publishRes, complianceRes] = await Promise.all([
 api.getWeek(weekFrom),
 api.listSchedulingRoster({ from: weekFrom, to: weekTo }),
 api.getClosures(),
 api.getPreferences(),
 api.getWeather(weekFrom, weekTo).catch(() => ({ data: [] as WeatherDay[] })),
 api.getCalendarEvents(weekFrom, weekTo).catch(() => ({ data: [] as CalendarEvent[] })),
        api.getWeekPublished(weekFrom).catch(() => ({ data: { published: false, publishedAt: null } })),
        api.checkCompliance(weekFrom).catch(() => ({ data: { violations: [] as ComplianceViolation[] } })),
 ]);
 const wMap = new Map<string, WeatherDay>();
 for (const w of weatherRes.data) wMap.set(w.date, w);
 setWeatherMap(wMap);
 setCalendarEvents(calendarRes.data);
      setWeekPublished(publishRes.data.published);
      setWeekLocked(!!weekRes.data.weekLocked);
      setComplianceViolations(complianceRes.data.violations || []);
 setColorPalettes(prefsRes.data.kitchenColor || "amber", prefsRes.data.floorColor || "sky");
 setRestaurantName(prefsRes.data.restaurantName || "");
 if (!styleSeededRef.current) {
   setStyleOverride(prefsRes.data.preferredStyle || "equilibre");
   styleSeededRef.current = true;
 }
      setDisabledComplianceRules(prefsRes.data.disabledComplianceRules || []);
 const staff = usersRes.data.filter((u) => u.role !== "admin");
 assignColors(staff);
 setWorkers(staff);
 setServices(weekRes.data.services);
 setCancelledServices(weekRes.data.cancelledServices ?? []);
 setStaffingInfo(weekRes.data.staffingInfo ?? null);
 setLaborCost(weekRes.data.laborCost ?? null);
 // Sync profile dropdown with week's assigned profile
 const weekProfileId = weekRes.data.staffingInfo?.profileId ?? null;
 setActiveProfileId(weekProfileId);
 setSavedProfileId(weekProfileId);
 setClosures(closuresRes.data);
 } catch (err) {
 console.error("Failed to load schedule", err);
 } finally {
 setLoading(false);
 }
 }, [activeRestaurantId]);

 useEffect(() => {
 fetchData(monday);
 }, [monday, fetchData]);

 const forceOpt = useCallback(
   (): { force: boolean } => ({ force: unlockedWeeksRef.current.has(fmt(monday)) }),
   [monday],
 );

 const handleWipeWeek = useCallback(async () => {
 setWipingWeek(true);
 try {
 const res = await api.wipeWeek(fmt(monday), forceOpt());
 toast(t("schedule:toasts.servicesDeleted", { count: res.data.deleted }));
 fetchData(monday);
 } catch (err) {
 toast.error(errorMessage(err, t("schedule:toasts.deleteFailed")));
 } finally {
 setWipingWeek(false);
 setShowWipeWeek(false);
 }
 }, [monday, fetchData, forceOpt, t]);


  const handleWipeClick = useCallback(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = new Date(monday);
    const weekEnd = addDays(monday, 6);
    const hasPast = weekStart < today;
    const modRuleEnabled = !disabledComplianceRules.includes("HCR-L3121-47");
    const delayDays = 8;
    const delayDate = new Date(today);
    delayDate.setDate(delayDate.getDate() + delayDays);
    const hasDelayConflict = modRuleEnabled && weekEnd >= today && weekStart < delayDate;

    if (hasPast && hasDelayConflict) {
      setWipeWarning(t("schedule:toasts.wipePastAndDelay"));
    } else if (hasPast) {
      setWipeWarning(t("schedule:toasts.wipePast"));
    } else if (hasDelayConflict) {
      setWipeWarning(t("schedule:toasts.wipeDelay"));
    } else {
      setShowWipeWeek(true);
      return;
    }
    setShowWipeWeek(true);
  }, [monday, disabledComplianceRules, t]);
  const handleTogglePublish = useCallback(async () => {
    const next = !weekPublished;
    setPublishLoading(true);
    try {
      await api.setWeekPublished(fmt(monday), next);
      setWeekPublished(next);
      toast(next ? t("schedule:toasts.weekPublished") : t("schedule:toasts.publishRemoved"));
    } catch (err) {
      toast.error(errorMessage(err, t("schedule:toasts.failed")));
    } finally {
      setPublishLoading(false);
    }
  }, [monday, weekPublished, t]);

  // Past + published weeks are locked against edits. Admin must explicitly
  // unlock per-session to modify them; the unlock is tracked in a ref and
  // every mutation for that week is then sent with ?force=true so the audit
  // log marks the edit as an override.
  const isLockedForEdit = weekLocked && !unlockedWeeksRef.current.has(fmt(monday));
  const confirmUnlock = useCallback(() => {
    unlockedWeeksRef.current.add(fmt(monday));
    forceUnlockRender((n) => n + 1);
    setShowUnlockDialog(false);
    toast(t("schedule:toasts.weekUnlocked"));
  }, [monday, t]);
 // Load default staffing targets + open days + service templates once
 useEffect(() => {
 if (!activeRestaurantId) return;
 Promise.all([api.getStaffingTargets(), api.getOpenDays(), api.getServiceTemplates()]).then(([t, o, tmpl]) => {
 const { profiles, targets, profileTemplates: pt } = t.data;
 // Store all profiles for picker
 const grouped = profiles.map(p => ({
 profile: p,
 targets: targets.filter(tt => tt.profileId === p.id),
 }));
 setAllProfiles(grouped);
 const firstId = grouped[0]?.profile.id ?? null;
 const firstTargets = grouped[0]?.targets ?? targets;
 setDefaultTargets(firstTargets);
 setOpenDays(o.data);
 const gDefs = zoneDefsFromTemplates(tmpl.data);
 setGlobalZoneDefs(gDefs);
 setGlobalTemplates(tmpl.data);
 setHasTemplates(tmpl.data.length > 0);
 // Build per-profile template map
 const ptMap = new Map<string, ProfileServiceTemplate[]>();
 if (pt) {
 for (const tpl of pt) {
 if (!ptMap.has(tpl.profileId)) ptMap.set(tpl.profileId, []);
 ptMap.get(tpl.profileId)!.push(tpl);
 }
 }
 setProfileTemplatesMap(ptMap);
 // Compute effective zone defs (profile overrides merged into global)
 const profileTpls = firstId ? ptMap.get(firstId) : undefined;
 setZoneDefs(profileTpls?.length ? zoneDefsFromTemplates(profileTpls) : gDefs);
 setActiveTemplates(profileTpls?.length ? profileTpls : tmpl.data);
 }).catch(console.error);
 }, [activeRestaurantId]);

 // Re-compute zone defs when active profile changes
 useEffect(() => {
 const profileTpls = activeProfileId ? profileTemplatesMap.get(activeProfileId) : undefined;
 setZoneDefs(profileTpls?.length ? zoneDefsFromTemplates(profileTpls) : globalZoneDefs);
 setActiveTemplates(profileTpls?.length ? (profileTpls as ServiceTemplate[]) : globalTemplates);
 }, [activeProfileId, profileTemplatesMap, globalZoneDefs, globalTemplates]);

 // Resolve all leg times for a (zone, role, dayOfWeek). Returns one entry for normal
 // zones, two (or more) for coupure zones — one per template block.
 const zoneLegs = useCallback((zoneLabel: string, role: string, dayOfWeek: number): { startTime: string; endTime: string }[] => {
 const def = zoneDefs.find(z => z.label === zoneLabel);
 if (!def) return [{ startTime: "09:00", endTime: "15:00" }];
 if (!def.isCoupure) return [zoneDefaultTimes(def, role, dayOfWeek)];
 // Coupure: pull each leg from raw templates matching this zone+role, sorted by startTime.
 const legs = activeTemplates
 .filter(t => t.zone === zoneLabel && t.role === role)
 .sort((a, b) => a.startTime.localeCompare(b.startTime))
 .map(t => {
 const ov = t.overrides?.find(o => o.dayOfWeek === dayOfWeek);
 return { startTime: ov?.startTime ?? t.startTime, endTime: ov?.endTime ?? t.endTime };
 });
 return legs.length > 0 ? legs : [zoneDefaultTimes(def, role, dayOfWeek)];
 }, [zoneDefs, activeTemplates]);

 // Fetch month data for list view
 useEffect(() => {
 if (!activeRestaurantId || viewMode !== "list") return;
 const fetchMonth = async () => {
 setListLoading(true);
 try {
 const from = fmt(listMonth);
 const lastDay = new Date(listMonth.getFullYear(), listMonth.getMonth() + 1, 0);
 const to = fmt(lastDay);
 const [res, calRes] = await Promise.all([
 api.getServices(from, to),
 api.getCalendarEvents(from, to).catch(() => ({ data: [] as CalendarEvent[] })),
 ]);
 setListServices(res.data);
 setCalendarEvents(calRes.data);
 } catch (err) {
 console.error("Failed to load month services", err);
 } finally {
 setListLoading(false);
 }
 };
 fetchMonth();
 }, [activeRestaurantId, viewMode, listMonth]);

 // Fetch month data for grid/stack month view
 useEffect(() => {
 if (!activeRestaurantId || timeRange !== "month" || viewMode !== "grid") return;
 const fetchMonth = async () => {
 setMonthLoading(true);
 try {
 const from = fmt(monthDate);
 const lastDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
 const to = fmt(lastDay);
 const [servicesRes, usersRes, closuresRes, prefsRes] = await Promise.all([
 api.getServices(from, to),
 api.listSchedulingRoster({ from, to }),
 api.getClosures(),
 api.getPreferences(),
 ]);
 setColorPalettes(prefsRes.data.kitchenColor || "amber", prefsRes.data.floorColor || "sky");
      setDisabledComplianceRules(prefsRes.data.disabledComplianceRules || []);
 const staff = usersRes.data.filter((u) => u.role !== "admin");
 assignColors(staff);
 setWorkers(staff);
 setMonthServices(servicesRes.data);
 setClosures(closuresRes.data);
 } catch (err) {
 console.error("Failed to load month services", err);
 } finally {
 setMonthLoading(false);
 }
 };
 fetchMonth();
 }, [activeRestaurantId, timeRange, viewMode, monthDate]);

 // Count services of a given role in a zone (or whole day if no zone)
 const countRole = useCallback(
 (date: string, role: string, zone?: string | null) =>
 services.filter((s) => {
 if (s.date !== date || (s.workerRole || s.role) !== role) return false;
 if (zone) return assignServiceToZone(s, zoneDefs, services) === zone;
 return true;
 }).length,
 [services, zoneDefs]
 );

 const roleName = useCallback((r: string) => (r === "kitchen" ? t("schedule:roles.kitchen") : t("schedule:roles.floor")), [t]);

 // Whether a service card (not a worker chip) is being dragged - shows delete zone
 const [draggingService, setDraggingService] = useState(false);
 const [dragSnapped, setDragSnapped] = useState(false);
 // Clear touch selection when drag starts (user switched to dragging)
 useEffect(() => {
 if (draggingService) setTouchSelectedService(null);
 }, [draggingService]);
 // Reset snap when drag ends
 useEffect(() => {
 if (!draggingService) setDragSnapped(false);
 }, [draggingService]);

 // Compute drag feedback: neutral / valid / conflict + conflicting service IDs
 const dragFeedback = useMemo<{ state: "neutral" | "valid" | "conflict" | "wrong-role"; conflictIds: Set<string> }>(() => {
 const empty = { state: "neutral" as const, conflictIds: new Set<string>() };
 if (!dragOver || !activeDragItem) return empty;
 const colonIdx = dragOver.indexOf(":");
 if (colonIdx < 0) return empty;
 const targetDate = dragOver.slice(0, colonIdx);
 const targetZoneName = dragOver.slice(colonIdx + 1);
 const targetZoneDef = zoneDefs.find(z => z.label === targetZoneName);
 if (!targetZoneDef) return empty;
 const isServiceDrag = 'service' in activeDragItem;
 const workerId = isServiceDrag ? activeDragItem.service.workerId : activeDragItem.worker.id;
 const excludeId = isServiceDrag ? activeDragItem.service.id : null;
 // Coupure-aware exclude: when the source is one leg of a coupure (≥ 2 shifts
 // for this worker on the source date), the whole unit moves together —
 // executeMove deletes/relocates every sibling leg — so none of them should
 // count as a conflict at the target.
 const sourceDate = isServiceDrag ? activeDragItem.service.date : null;
 const role = isServiceDrag
  ? (activeDragItem.service.workerRole || activeDragItem.service.role || "floor")
  : (activeDragItem.worker.role === "kitchen" ? "kitchen" : "floor");
 const dow = dateToDow(targetDate);
 const targetTimes = zoneDefaultTimes(targetZoneDef, role, dow);
 // Find overlapping services for this worker on target date
 const conflictIds = new Set<string>();
 for (const s of services) {
 if (s.date !== targetDate || s.workerId !== workerId || s.id === excludeId) continue;
 if (sourceDate && s.date === sourceDate) continue; // sibling coupure leg — moves with the source
 if (s.startTime < targetTimes.endTime && s.endTime > targetTimes.startTime) {
 conflictIds.add(s.id);
 }
 }
 if (conflictIds.size > 0) return { state: "conflict", conflictIds };
 return { state: "valid", conflictIds };
 }, [dragOver, activeDragItem, services, zoneDefs]);

 // Per-zone conflict check for touch-select placement flow (PlacementPreview red/green)
 const touchPlacementConflictAt = useCallback((zoneId: string): boolean => {
  if (!touchSelectedService) return false;
  const colonIdx = zoneId.indexOf(":");
  if (colonIdx < 0) return false;
  const targetDate = zoneId.slice(0, colonIdx);
  const targetZoneName = zoneId.slice(colonIdx + 1);
  const targetZoneDef = zoneDefs.find(z => z.label === targetZoneName);
  if (!targetZoneDef) return false;
  const workerId = touchSelectedService.workerId;
  const excludeId = touchSelectedService.id;
  const role = touchSelectedService.workerRole || touchSelectedService.role || "floor";
  const dow = dateToDow(targetDate);
  const targetTimes = zoneDefaultTimes(targetZoneDef, role, dow);
  for (const s of services) {
   if (s.date !== targetDate || s.workerId !== workerId || s.id === excludeId) continue;
   if (s.startTime < targetTimes.endTime && s.endTime > targetTimes.startTime) return true;
  }
  return false;
 }, [touchSelectedService, zoneDefs, services]);

 // Conflict shake: overlay shakes after 0.8s hover on conflict zone
 const overlayShakeRef = useRef<HTMLDivElement>(null);
 const isConflictDrag = dragFeedback.state === "conflict";
 useEffect(() => {
  if (!isConflictDrag) return;
  const t = setTimeout(() => {
   const el = overlayShakeRef.current;
   if (el) { el.classList.remove("reject-shake-reverse"); void el.offsetWidth; el.classList.add("reject-shake-reverse"); }
  }, 800);
  return () => clearTimeout(t);
 }, [isConflictDrag]);

 const handleDragStart = useCallback((event: DragStartEvent) => {
 const service = event.active.data.current?.service as ServiceRow | undefined;
 const worker = event.active.data.current?.worker as User | undefined;
 if (service) {
 setDraggingService(true);
 const zone = assignServiceToZone(service, zoneDefs, services);
 setDragSource(`${service.date}:${zone}`);
 }
 // Track dragged role (works for both service cards and worker chips)
 const role = service ? (service.workerRole || service.role) : worker?.role;
 if (role) {
 setDraggedRole(role === "kitchen" ? "cuisine" : "floor");
 }
 // Track active item for DragOverlay
 if (service) setActiveDragItem({ service });
 else if (worker) setActiveDragItem({ worker });
 // Touch mode = either the activator is explicitly touch, OR the device is
 // touch-primary (no hover capability), OR we're rendering at a mobile-sized
 // viewport (covers Chrome DevTools mobile emulation, which fires synthesized
 // MouseEvents instead of TouchEvents).
 const activator = event.activatorEvent as Event & { pointerType?: string };
 const isTouchActivator =
  (typeof TouchEvent !== "undefined" && activator instanceof TouchEvent) ||
  activator?.pointerType === "touch";
 const isTouchDevice =
  typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches;
 const isTouch = isTouchActivator || isTouchDevice || isMobile;
 touchDragRef.current = !!isTouch;
 setTouchDragActive(!!isTouch);
 clearDwell();
 }, [clearDwell, isMobile, zoneDefs, services]);

 const handleDragOver = useCallback((event: DragOverEvent) => {
 const overId = (event.over?.id as string) || null;
 setDragOver(overId);
 // Two-stage dwell only applies to touch drags; mouse keeps instant unstack/commit.
 if (!touchDragRef.current) return;
 if (overId !== dwellTargetRef.current) {
  if (unstackTimerRef.current) { clearTimeout(unstackTimerRef.current); unstackTimerRef.current = null; }
  if (readyTimerRef.current) { clearTimeout(readyTimerRef.current); readyTimerRef.current = null; }
  dwellTargetRef.current = overId;
  readyCompleteRef.current = false;
  setUnstackedZoneId(null);
  setReadyZoneId(null);
  if (overId) {
   const target = overId;
   unstackTimerRef.current = setTimeout(() => {
    if (dwellTargetRef.current === target) setUnstackedZoneId(target);
    unstackTimerRef.current = null;
   }, DWELL_UNSTACK_MS);
   readyTimerRef.current = setTimeout(() => {
    if (dwellTargetRef.current === target) {
     readyCompleteRef.current = true;
     setReadyZoneId(target);
    }
    readyTimerRef.current = null;
   }, DWELL_READY_MS);
  }
 }
 }, []);

 // ── Execute service move ──
 const executeMove = useCallback(async (
 service: ServiceRow,
 targetDay: string,
 targetZone: string | null,
 ) => {
 const sourceZone = assignServiceToZone(service, zoneDefs, services);
 const destZone = targetZone || sourceZone;
 const serviceRole = service.workerRole || service.role;
 const dow = dateToDow(targetDay);
 const destDef = zoneDefs.find(z => z.label === destZone);

 // Detect coupure source: any sibling shifts on the same day for this worker.
 const sourceLegs = services
 .filter(s => s.workerId === service.workerId && s.date === service.date)
 .sort((a, b) => a.startTime.localeCompare(b.startTime));
 const sourceIsCoupure = sourceLegs.length >= 2;
 const destIsCoupure = !!destDef?.isCoupure;

 const origDate = service.date;
 const origStart = service.startTime;
 const origEnd = service.endTime;

 // Coupure-aware paths take precedence over the single-shift move logic.
 if (sourceIsCoupure || destIsCoupure) {
 try {
 const destLegs = zoneLegs(destZone, serviceRole, dow);
 if (sourceIsCoupure && destIsCoupure) {
 // Move each existing leg to the corresponding destination leg time.
 for (let i = 0; i < sourceLegs.length; i++) {
 const leg = sourceLegs[i];
 const t = destLegs[i] ?? destLegs[destLegs.length - 1];
 await api.moveService({ serviceId: leg.id, newDate: targetDay, newStartTime: t.startTime, newEndTime: t.endTime }, forceOpt());
 }
 } else if (!sourceIsCoupure && destIsCoupure) {
 // Single shift dropped onto a coupure zone → move primary, create the rest.
 await api.moveService({ serviceId: service.id, newDate: targetDay, newStartTime: destLegs[0].startTime, newEndTime: destLegs[0].endTime }, forceOpt());
 for (let i = 1; i < destLegs.length; i++) {
 await api.createService({ workerId: service.workerId, date: targetDay, startTime: destLegs[i].startTime, endTime: destLegs[i].endTime, role: serviceRole as "kitchen" | "floor" }, forceOpt());
 }
 } else {
 // Coupure source dropped onto a single-shift zone → keep primary, drop extras.
 await api.moveService({ serviceId: sourceLegs[0].id, newDate: targetDay, newStartTime: destLegs[0].startTime, newEndTime: destLegs[0].endTime }, forceOpt());
 for (let i = 1; i < sourceLegs.length; i++) {
 await api.deleteService(sourceLegs[i].id, forceOpt());
 }
 }
 fetchData(monday);
 const label = `${shortName(service.workerName)} ${roleName(serviceRole)}`;
 toast(label, {
 description: destIsCoupure
 ? t("schedule:coupure.description", { date: fmtDateShort(targetDay), legs: destLegs.map(l => `${l.startTime}–${l.endTime}`).join(" + ") })
 : `${fmtDateShort(origDate)} → ${fmtDateShort(targetDay)}`,
 duration: 4000,
 });
 } catch (err) {
 console.error("Coupure-aware move failed", err);
 toast.error(errorMessage(err, t("schedule:toasts.moveFailed")));
 }
 return;
 }

 const moveData: { serviceId: string; newDate?: string; newStartTime?: string; newEndTime?: string } = {
 serviceId: service.id,
 };
 if (targetDay !== service.date) moveData.newDate = targetDay;

 if (targetZone && targetZone !== sourceZone) {
 const targetDef = zoneDefs.find(z => z.label === targetZone);
 if (targetDef) {
 const defaults = zoneDefaultTimes(targetDef, serviceRole, dow);
 moveData.newStartTime = defaults.startTime;
 moveData.newEndTime = defaults.endTime;
 }
 } else if (targetDay !== service.date) {
 // Same zone, different day - check if per-day override changes the times
 if (destDef?.dayOverrides) {
 const srcDow = dateToDow(service.date);
 const dstDow = dateToDow(targetDay);
 const srcTimes = zoneDefaultTimes(destDef, serviceRole, srcDow);
 const dstTimes = zoneDefaultTimes(destDef, serviceRole, dstDow);
 if (srcTimes.startTime !== dstTimes.startTime || srcTimes.endTime !== dstTimes.endTime) {
 moveData.newStartTime = dstTimes.startTime;
 moveData.newEndTime = dstTimes.endTime;
 }
 }
 }

 const srcCount = countRole(service.date, serviceRole, targetZone ? sourceZone : null);
 const dstCount = countRole(targetDay, serviceRole, targetZone ? destZone : null);

 try {
 await api.moveService(moveData, forceOpt());
 fetchData(monday);

 const label = `${shortName(service.workerName)} ${roleName(serviceRole)}`;
 const srcLabel = `${fmtDateShort(service.date)}${targetZone ? ` ${sourceZone}` : ""}`;
 const dstLabel = `${fmtDateShort(targetDay)}${targetZone ? ` ${destZone}` : ""}`;

 toast(label, {
 description: t("schedule:moveDescription.moved", { src: srcLabel, srcLeft: srcCount - 1, dst: dstLabel, was: dstCount, now: dstCount + 1 }),
 action: {
 label: t("schedule:toasts.undo"),
 onClick: async () => {
 try {
 await api.moveService({
 serviceId: service.id,
 newDate: origDate,
 newStartTime: origStart,
 newEndTime: origEnd,
 }, forceOpt());
 fetchData(monday);
 } catch {
 toast.error(t("schedule:toasts.undoFailed"));
 }
 },
 },
 duration: 5000,
 });
 } catch (err) {
 console.error("Move failed", err);
 toast.error(errorMessage(err, t("schedule:toasts.moveFailed")));
 }
 }, [countRole, fetchData, monday, zoneDefs, services, zoneLegs, forceOpt, roleName, t]);

 // Toggle touch-select: long-press same card = deselect, different card = switch
 const handleTouchSelect = useCallback((service: ServiceRow) => {
 if (navigator.vibrate) navigator.vibrate(30);
 setTouchSelectedService(prev => prev?.id === service.id ? null : service);
 }, []);

 // ── Execute service create (from legend drag) ──
 const executeCreate = useCallback(async (
 worker: User,
 targetDay: string,
 targetZone: string | null,
 ) => {
 const destZone = targetZone || zoneDefs[0]?.label || "midi";
 const workerRole = worker.role as "kitchen" | "floor";
 const targetDef = zoneDefs.find(z => z.label === destZone);
 const dow = dateToDow(targetDay);
 const legs = targetDef
 ? zoneLegs(destZone, workerRole, dow)
 : [{ startTime: "09:00", endTime: "15:00" }];

 const dstCount = countRole(targetDay, workerRole, targetZone);

 try {
 const created: string[] = [];
 for (const leg of legs) {
 const res = await api.createService({
 workerId: worker.id,
 date: targetDay,
 startTime: leg.startTime,
 endTime: leg.endTime,
 role: workerRole,
 }, forceOpt());
 created.push((res as { data: { id: string } }).data.id);
 }
 fetchData(monday);

 const label = `${shortName(worker.name)} ${roleName(workerRole)}`;
 const description = legs.length > 1
 ? t("schedule:coupure.description", { date: fmtDateShort(targetDay), legs: legs.map(l => `${l.startTime}–${l.endTime}`).join(" + ") })
 : t("schedule:moveDescription.addedToZone", { date: fmtDateShort(targetDay), zone: destZone, was: dstCount, now: dstCount + 1 });

 toast(label, {
 description,
 action: {
 label: t("schedule:toasts.undo"),
 onClick: async () => {
 try {
 for (const id of created) await api.deleteService(id, forceOpt());
 fetchData(monday);
 } catch {
 toast.error(t("schedule:toasts.undoFailed"));
 }
 },
 },
 duration: 5000,
 });
 } catch (err) {
 console.error("Create service failed", err);
 toast.error(errorMessage(err, t("schedule:toasts.createServiceFailed")));
 }
 }, [countRole, fetchData, monday, zoneDefs, zoneLegs, forceOpt, roleName, t]);

 // ── Touch long-press: place selected card or picked worker into a zone ──
 const handleTouchPlace = useCallback((zoneId: string) => {
 const [targetDay, targetZone] = zoneId.includes(":")
 ? zoneId.split(":")
 : [zoneId, null];

 // Mobile dropdown flow: a worker was tap-picked from the CUISINE/SALLE menu
 if (touchSelectedWorker) {
 const worker = touchSelectedWorker;
 setTouchSelectedWorker(null);
 const closure = getClosureForDate(targetDay);
 const action = () => executeCreate(worker, targetDay, targetZone);
 const wrappedAction = closure
 ? () => { setPendingClosureAction({ action, closureReason: closure.reason }); return Promise.resolve(); }
 : action;
 if (targetDay < fmt(new Date())) {
 if (closure) {
 setPendingClosureAction({ action: () => { setPendingPastAction(() => action); return Promise.resolve(); }, closureReason: closure.reason });
 } else {
 setPendingPastAction(() => action);
 }
 } else {
 wrappedAction();
 }
 return;
 }

 if (!touchSelectedService) return;
 const sourceZone = assignServiceToZone(touchSelectedService, zoneDefs, services);
 if (targetDay === touchSelectedService.date && (!targetZone || targetZone === sourceZone)) {
 setTouchSelectedService(null);
 return;
 }
 const service = touchSelectedService;
 setTouchSelectedService(null);

 const closure = getClosureForDate(targetDay);
 const action = () => executeMove(service, targetDay, targetZone);
 const wrappedAction = closure
 ? () => { setPendingClosureAction({ action, closureReason: closure.reason }); return Promise.resolve(); }
 : action;
 if (targetDay < fmt(new Date())) {
 if (closure) {
 setPendingClosureAction({ action: () => { setPendingPastAction(() => action); return Promise.resolve(); }, closureReason: closure.reason });
 } else {
 setPendingPastAction(() => action);
 }
 } else {
 wrappedAction();
 }
 }, [touchSelectedService, touchSelectedWorker, executeMove, executeCreate, zoneDefs, getClosureForDate, services]);

 // ── Handle service type selection from modal ──
 const handleServiceTypeSelect = useCallback(async (
 type: string, // zone label or "custom"
 customTimes?: { startTime: string; endTime: string },
 ) => {
 if (!pendingWorkerDrop) return;
 const { worker, targetDay } = pendingWorkerDrop;
 setPendingWorkerDrop(null);

 const workerRole = worker.role as "kitchen" | "floor";
 const label = `${shortName(worker.name)} ${roleName(workerRole)}`;

 const createOne = async (startTime: string, endTime: string) => {
 const res = await api.createService({
 workerId: worker.id,
 date: targetDay,
 startTime,
 endTime,
 role: workerRole,
 }, forceOpt());
 return (res as { data: { id: string } }).data.id;
 };

 const doCreate = async () => {
 try {
 if (type === "custom" && customTimes) {
 const id = await createOne(customTimes.startTime, customTimes.endTime);
 fetchData(monday);
 toast(label, {
 description: t("schedule:moveDescription.addedToTimes", { date: fmtDateShort(targetDay), start: customTimes.startTime, end: customTimes.endTime }),
 action: { label: t("schedule:toasts.undo"), onClick: async () => { try { await api.deleteService(id, forceOpt()); fetchData(monday); } catch { toast.error(t("schedule:toasts.undoFailed")); } } },
 duration: 5000,
 });
 } else {
 // type is a zone label
 const zoneDef = zoneDefs.find(z => z.label === type);
 const dow = dateToDow(targetDay);
 const times = zoneDef ? zoneDefaultTimes(zoneDef, workerRole, dow) : { startTime: "09:00", endTime: "15:00" };
 const id = await createOne(times.startTime, times.endTime);
 fetchData(monday);
 toast(label, {
 description: t("schedule:moveDescription.addedToType", { date: fmtDateShort(targetDay), type }),
 action: { label: t("schedule:toasts.undo"), onClick: async () => { try { await api.deleteService(id, forceOpt()); fetchData(monday); } catch { toast.error(t("schedule:toasts.undoFailed")); } } },
 duration: 5000,
 });
 }
 } catch (err) {
 console.error("Create service failed", err);
 toast.error(errorMessage(err, t("schedule:toasts.createServiceFailed")));
 }
 };

 const closure = getClosureForDate(targetDay);
 if (closure) {
 setPendingClosureAction({
 action: () => {
 if (targetDay < fmt(new Date())) {
 setPendingPastAction(() => doCreate);
 return Promise.resolve();
 }
 return doCreate();
 },
 closureReason: closure.reason,
 });
 } else if (targetDay < fmt(new Date())) {
 setPendingPastAction(() => doCreate);
 } else {
 await doCreate();
 }
 }, [pendingWorkerDrop, fetchData, monday, getClosureForDate, zoneDefs, forceOpt, roleName, t]);

 const handleDragEnd = async (event: DragEndEvent) => {
 setDragSource(null);
 setDragOver(null);
 setDraggingService(false);
 setDraggedRole(null);
 const { active, over } = event;
 // Two-stage dwell: on touch, commit only if the user held long enough for
 // stage B (“ready”) to arm. Earlier release cancels silently.
 const wasTouch = touchDragRef.current;
 const dwellOk = readyCompleteRef.current;
 clearDwell();
 touchDragRef.current = false;
 setTouchDragActive(false);
 if (!over) {
 // Dropped outside — snap back then disappear
 setTimeout(() => setActiveDragItem(null), 300);
 return;
 }
 if (wasTouch && !dwellOk) {
 // Released too early — cancel silently, snap back
 setTimeout(() => setActiveDragItem(null), 300);
 return;
 }
 // Successful drop — vanish immediately
 setActiveDragItem(null);

 const targetId = over.id as string;
 const service = active.data.current?.service as ServiceRow | undefined;
 const worker = active.data.current?.worker as User | undefined;

 // ── Drop on delete zone ──
 if (service && targetId === "delete-service") {
 const serviceRole = service.workerRole || service.role;
 const origData = { workerId: service.workerId, date: service.date, startTime: service.startTime, endTime: service.endTime, role: serviceRole as "kitchen" | "floor" };
 try {
 await api.deleteService(service.id, forceOpt());
 fetchData(monday);
 toast(t("schedule:deleteToast.removed", { name: shortName(service.workerName) }), {
 description: t("schedule:deleteToast.rangeDescription", { date: fmtDateShort(service.date), start: service.startTime, end: service.endTime }),
 action: {
 label: t("schedule:toasts.undo"),
 onClick: async () => {
 try {
 await api.createService(origData, forceOpt());
 fetchData(monday);
 } catch { toast.error(t("schedule:toasts.undoFailed")); }
 },
 },
 duration: 5000,
 });
 } catch { toast.error(t("schedule:toasts.deleteFailed")); }
 return;
 }

 // Ignore drops on nav zones (they trigger via hover, not drop)
 if (targetId === "nav-prev-week" || targetId === "nav-next-week") return;

 /** Run action with past-date and closure checks */
 const runWithChecks = (targetDay: string, action: () => Promise<void>) => {
 const closure = getClosureForDate(targetDay);
 const wrappedAction = closure
 ? () => { setPendingClosureAction({ action, closureReason: closure.reason }); return Promise.resolve(); }
 : action;

 if (targetDay < fmt(new Date())) {
 // Past-date check wraps the (possibly closure-wrapped) action
 if (closure) {
 // Both past AND closure - show closure first, past-date after confirm
 setPendingClosureAction({ action: () => { setPendingPastAction(() => action); return Promise.resolve(); }, closureReason: closure.reason });
 } else {
 setPendingPastAction(() => action);
 }
 } else {
 wrappedAction();
 }
 };

 if (service) {
 const [targetDay, targetZone] = targetId.includes(":")
 ? targetId.split(":")
 : [targetId, null];

 const sourceZone = assignServiceToZone(service, zoneDefs, services);
 if (targetDay === service.date && (!targetZone || targetZone === sourceZone)) return;

 const action = () => executeMove(service, targetDay, targetZone);
 runWithChecks(targetDay, action);
 } else if (worker) {
 const [targetDay, targetZone] = targetId.includes(":")
 ? targetId.split(":")
 : [targetId, null];

 if (targetZone) {
 const action = () => executeCreate(worker, targetDay, targetZone);
 runWithChecks(targetDay, action);
 } else {
 // Grid view drop - show service type selector (closure check handled in handleServiceTypeSelect)
 setPendingWorkerDrop({ worker, targetDay });
 }
 }
 };

 // Filter by role
 let filteredWorkers = roleFilter === "all" || roleFilter === "missing"
 ? workers
 : workers.filter((w) => w.role === roleFilter);
 let filteredServices = roleFilter === "all" || roleFilter === "missing"
 ? services
 : services.filter((s) => s.role === roleFilter);
 // Filter by sub-role
 if (subRoleFilter.size > 0) {
 filteredWorkers = filteredWorkers.filter(w => (w.subRoles ?? []).some(sr => subRoleFilter.has(sr)));
 filteredServices = filteredServices.filter(s => {
 const w = workers.find(ww => ww.id === s.workerId);
 return (w?.subRoles ?? []).some(sr => subRoleFilter.has(sr));
 });
 }

 const weeklyHoursByWorker = useMemo(() => {
 const map = new Map<string, number>();
 const hasRosterHours = workers.some((w) => typeof w.weeklyHours === "number");
 if (hasRosterHours) {
 for (const worker of workers) map.set(worker.id, worker.weeklyHours ?? 0);
 return map;
 }
 for (const s of services) {
 map.set(s.workerId, (map.get(s.workerId) ?? 0) + serviceDurationHours(s));
 }
 return map;
 }, [services, workers]);

 const workerHoursLabel = useCallback((worker: User) => {
 const staffed = weeklyHoursByWorker.get(worker.id) ?? 0;
 const contract = worker.contractHours ?? 0;
 return `${compactHours(Math.round(staffed * 10) / 10)}h/${contract > 0 ? `${compactHours(contract)}h` : "—"}`;
 }, [weeklyHoursByWorker]);

 // Group services by date
 const servicesByDate = new Map<string, ServiceRow[]>();
 for (let i = 0; i < 7; i++) {
 servicesByDate.set(fmt(addDays(monday, i)), []);
 }
 for (const s of filteredServices) {
 const arr = servicesByDate.get(s.date);
 if (arr) arr.push(s);
 }

 // Build target lookup: dayOfWeek_role_zone → count
 // When no profile is selected (null), return empty map → no ghost cards
 const targetLookup = useMemo(() => {
 if (!activeProfileId) return new Map<string, number>();
 const targets = allProfiles.find(p => p.profile.id === activeProfileId)?.targets ?? defaultTargets;
 const map = new Map<string, number>();
 for (const t of targets) map.set(`${t.dayOfWeek}_${t.role}_${t.zone}`, t.count);
 return map;
 }, [allProfiles, activeProfileId, defaultTargets]);

 // Sub-role breakdown lookup: dayOfWeek_role_zone → Record<subRole, count>
 const breakdownLookup = useMemo(() => {
 const targets = allProfiles.find(p => p.profile.id === activeProfileId)?.targets ?? defaultTargets;
 const map = new Map<string, Record<string, number>>();
 for (const t of targets) {
 const rb = t.roleBreakdown ? (typeof t.roleBreakdown === "string" ? JSON.parse(t.roleBreakdown) : t.roleBreakdown) : null;
 if (rb && Object.keys(rb).length > 0) {
 map.set(`${t.dayOfWeek}_${t.role}_${t.zone}`, rb);
 }
 }
 return map;
 }, [allProfiles, activeProfileId, defaultTargets]);

 /** Get target count for a date/role/zone (undefined on closure days → no ghost cards) */
 const getTarget = useCallback((dateStr: string, role: "kitchen" | "floor", zone: string): number | undefined => {
 if (getClosureForDate(dateStr)) return undefined;
 const dow = dateToDow(dateStr);
 return targetLookup.get(`${dow}_${role}_${zone}`);
 }, [targetLookup, getClosureForDate]);

 /** Get missing sub-role labels for ghost cards (returns string[] with one label per ghost) */
 const getGhostLabels = useCallback((dateStr: string, role: "kitchen" | "floor", zone: string, assignedServices: ServiceRow[]): string[] | undefined => {
 const dow = dateToDow(dateStr);
 const target = targetLookup.get(`${dow}_${role}_${zone}`) ?? 0;
 const missingCount = Math.max(0, target - assignedServices.length);
 if (missingCount === 0) return undefined;

 const breakdown = breakdownLookup.get(`${dow}_${role}_${zone}`);
 if (breakdown) {
 // Assign existing services to objective sub-role slots, then label only the remaining slots.
 const remaining: Record<string, number> = { ...breakdown };
 const unmapped: ServiceRow[] = [];
 for (const s of assignedServices) {
 const primary = workers.find(w => w.id === s.workerId)?.subRoles?.[0] ?? "";
 if (primary && (remaining[primary] ?? 0) > 0) remaining[primary]!--;
 else unmapped.push(s);
 }
 for (const _s of unmapped) {
 const next = Object.entries(remaining).find(([, count]) => count > 0);
 if (next) remaining[next[0]]!--;
 }
 const labels = Object.entries(remaining).flatMap(([sub, count]) => Array.from({ length: Math.max(0, count) }, () => sub));
 return labels.length > 0 ? labels.slice(0, missingCount) : undefined;
 }

 // Fallback for deleted/cancelled services (notably WhatsApp removals) when the active
 // target has no explicit role breakdown: preserve the removed worker's primary sub-role.
 const cancelledLabels = cancelledServices
 .filter(s => s.date === dateStr && (s.workerRole || s.role) === role && assignServiceToZone(s, zoneDefs, cancelledServices.filter(x => x.date === dateStr)) === zone)
 .map(s => workers.find(w => w.id === s.workerId)?.subRoles?.[0] ?? s.workerSubRoles?.[0] ?? "")
 .filter(Boolean);
 return cancelledLabels.length > 0 ? cancelledLabels.slice(0, missingCount) : undefined;
 }, [breakdownLookup, cancelledServices, targetLookup, workers, zoneDefs]);

 // Map each service to the breakdown subrole slot it fills
  // Build compliance violation lookup: workerId:date → { error, warning }
  const complianceLookup = useMemo(() => {
    const map = new Map<string, { error: boolean; warning: boolean; violations: ComplianceViolation[] }>();
    for (const v of complianceViolations) {
      if (!v.date) continue;
      const key = `${v.workerId}:${v.date}`;
      const entry = map.get(key) || { error: false, warning: false, violations: [] };
      if (v.severity === "error") entry.error = true;
      if (v.severity === "warning") entry.warning = true;
      entry.violations.push(v);
      map.set(key, entry);
    }
    return map;
  }, [complianceViolations]);
 // Maps each service → the sub-role it fills in the staffing OBJECTIVE
 // (the breakdown), independent of the worker assigned. Pass 1 prefers the
 // worker's primary sub-role when it matches a remaining breakdown slot;
 // pass 2 distributes leftover breakdown slots to unmapped services so every
 // service within the breakdown's count gets the OBJECTIVE sub-role (e.g. a
 // S.C.Rang worker covering a Chef de rang slot maps to Chef de rang).
 const serviceSubRoleMap = useMemo(() => {
 const map = new Map<string, string>();
 for (let i = 0; i < 7; i++) {
 const dateStr = fmt(addDays(monday, i));
 const dayServices = services.filter(s => s.date === dateStr);
 for (const zd of zoneDefs) {
 for (const role of ["kitchen", "floor"] as const) {
 const dow = dateToDow(dateStr);
 const breakdown = breakdownLookup.get(`${dow}_${role}_${zd.label}`);
 if (!breakdown) continue;
 const remaining: Record<string, number> = { ...breakdown };
 const zoneRoleServices = dayServices.filter(s => assignServiceToZone(s, zoneDefs, dayServices) === zd.label && (s.workerRole || s.role) === role);
 const unmapped: typeof zoneRoleServices = [];
 // Pass 1: bias each service toward its worker's primary sub-role
 for (const s of zoneRoleServices) {
 const worker = workers.find(w => w.id === s.workerId);
 const primary = (worker?.subRoles ?? [])[0] ?? "";
 if (primary && (remaining[primary] ?? 0) > 0) {
 map.set(s.id, primary);
 remaining[primary]!--;
 } else {
 unmapped.push(s);
 }
 }
 // Pass 2: distribute remaining objective slots to services whose worker
 // didn't fit any breakdown bucket
 for (const s of unmapped) {
 for (const [subRole, count] of Object.entries(remaining)) {
 if (count > 0) {
 map.set(s.id, subRole);
 remaining[subRole]!--;
 break;
 }
 }
 }
 }
 }
 }
 return map;
 }, [monday, services, workers, breakdownLookup, zoneDefs]);

 // Compute max overlap across all 7 days including ghost slots for uniform bar widths
 let maxOverlap = 1;
 for (let i = 0; i < 7; i++) {
 const dateStr = fmt(addDays(monday, i));
 const dayServices = servicesByDate.get(dateStr) || [];
 const positioned = layoutServices(dayServices, null);
 // In missing mode real service columns don't constrain width — ghosts own the full column
 if (roleFilter !== "missing") {
 for (const p of positioned) {
 if (p.totalColumns > maxOverlap) maxOverlap = p.totalColumns;
 }
 }
 if (targetLookup.size > 0 && !getClosureForDate(dateStr)) {
 // Global max column across ALL services of each role (columns are shared, not per-zone)
 const kGlobalStart = Math.max(-1, ...positioned.filter(p => !p.alignRight).map(p => p.column)) + 1;
 const sGlobalStart = Math.max(-1, ...positioned.filter(p => !!p.alignRight).map(p => p.column)) + 1;
 // Use unfiltered services for actual counts — filteredServices excludes the other role
 const allDay = services.filter(s => s.date === dateStr);
 let totalKGhosts = 0, totalSGhosts = 0;
 for (const zd of zoneDefs) {
 const kt = getTarget(dateStr, "kitchen", zd.label);
 const st = getTarget(dateStr, "floor", zd.label);
 const kActual = new Set(allDay.filter(s => (s.workerRole || s.role) === "kitchen" && assignServiceToZone(s, zoneDefs, allDay) === zd.label).map(s => s.workerId)).size;
 const sActual = new Set(allDay.filter(s => (s.workerRole || s.role) === "floor" && assignServiceToZone(s, zoneDefs, allDay) === zd.label).map(s => s.workerId)).size;
 if (kt !== undefined) totalKGhosts += Math.max(0, kt - kActual);
 if (st !== undefined) totalSGhosts += Math.max(0, st - sActual);
 }
 // In missing mode ghosts own the full column (real services not rendered) — start from 0
 const kBase = roleFilter === "missing" ? 0 : kGlobalStart;
 const sBase = roleFilter === "missing" ? 0 : sGlobalStart;
 // Only count ghost cols for roles rendered in the current filter
 const kGhostsLayout = (roleFilter === "all" || roleFilter === "missing" || roleFilter === "kitchen") ? totalKGhosts : 0;
 const sGhostsLayout = (roleFilter === "all" || roleFilter === "missing" || roleFilter === "floor") ? totalSGhosts : 0;
 // Sum: kitchen is LEFT-aligned, salle is RIGHT-aligned
 maxOverlap = Math.max(maxOverlap, (kBase + kGhostsLayout) + (sBase + sGhostsLayout));
 }
 }

 /** Total number of unfilled slots across the week (targets - actual services, skips closure days) */
 const totalGaps = useMemo(() => {
 if (targetLookup.size === 0) return 0;
 let gaps = 0;
 for (let i = 0; i < 7; i++) {
 const dateStr = fmt(addDays(monday, i));
 if (getClosureForDate(dateStr)) continue;
 const dayServices = services.filter(s => s.date === dateStr);
 for (const zd of zoneDefs) {
 for (const role of ["kitchen", "floor"] as const) {
 const target = targetLookup.get(`${dateToDow(dateStr)}_${role}_${zd.label}`);
 if (target === undefined) continue;
 const actual = new Set(dayServices.filter(s => s.role === role && assignServiceToZone(s, zoneDefs, dayServices) === zd.label).map(s => s.workerId)).size;
 if (actual < target) gaps += target - actual;
 }
 }
 }
 return gaps;
 }, [monday, services, targetLookup, zoneDefs, getClosureForDate]);

 // Compute max zone heights for consistent separator across all 7 days
 // Uses raw services (unfiltered) so layout stays stable when selecting workers
 // One height per zone definition
 const maxStacksHByZone: number[] = zoneDefs.map((zd) => {
 let maxH = 42;
 for (let i = 0; i < 7; i++) {
 const dateStr = fmt(addDays(monday, i));
 const dayServices = (selectedWorkerIds.size > 0 || subRoleFilter.size > 0
 ? filteredServices.filter(s => selectedWorkerIds.size === 0 || selectedWorkerIds.has(s.workerId))
 : services
 ).filter(s => s.date === dateStr);
 const zoneServices = dayServices.filter(s => assignServiceToZone(s, zoneDefs, dayServices) === zd.label);
 const hasFilter = selectedWorkerIds.size > 0 || subRoleFilter.size > 0;
 const kt = getTarget(dateStr, "kitchen", zd.label);
 const st = getTarget(dateStr, "floor", zd.label);
 maxH = Math.max(maxH, roleFilter === "missing"
 ? computeMissingZoneH(zoneServices, kt, st)
 : (unstackAll || hasFilter)
 ? computeZoneExpandedH(zoneServices, hasFilter, hasFilter ? undefined : kt, hasFilter ? undefined : st)
 : computeZoneStacksH(zoneServices, false, kt, st));
 }
 return maxH;
 });

 // No service templates configured — nudge user to create them
 if (!loading && !hasTemplates) {
 const firstProfileId = allProfiles[0]?.profile.id;
 return (
 <div className="flex flex-col items-center justify-center gap-[var(--space-lg)] py-20 text-center">
 <AlertTriangle className="h-12 w-12 text-muted-foreground/50" />
 <div className="space-y-[var(--space-xs)]">
 <h2 className="text-[length:var(--text-lg)] font-semibold">{t("schedule:empty.noServicesConfiguredTitle")}</h2>
 <p className="text-[length:var(--text-sm)] text-muted-foreground max-w-md">
 {t("schedule:empty.noServicesConfiguredHint")}
 </p>
 </div>
 <Button
 onClick={() => navigate(firstProfileId ? `/preferences/objectif/${firstProfileId}` : "/preferences")}
 className="gap-[var(--space-xs)]"
 >
 {t("schedule:actions.configureServices")}
 <ArrowRight className="h-4 w-4" />
 </Button>
 </div>
 );
 }

 return (
 <DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={() => { setDragSource(null); setDragOver(null); setDraggingService(false); setDraggedRole(null); clearDwell(); touchDragRef.current = false; setTouchDragActive(false); setTimeout(() => setActiveDragItem(null), 300); }}>
 <div ref={scheduleRootRef} className={cn(viewMode === "list" ? "fixed inset-0 top-[40px] md:top-[46px] flex flex-col overflow-hidden z-20 bg-background" : "space-y-0", isFullscreen && "bg-background overflow-auto p-[var(--space-md)]")}>
 {/* Everything above the grid - action bar overlays this entire area during drag */}
 <div className={cn("relative", viewMode === "list" && "shrink-0 border-b border-border max-w-7xl mx-auto w-full px-[var(--space-lg)]")}>
 {/* Drag action bar - covers header + filters + legend */}
 {draggingService && (
 <div className="absolute inset-0 z-30">
 <DragActionBar
 onPrevWeek={() => setMonday(m => addDays(m, -7))}
 onNextWeek={() => setMonday(m => addDays(m, 7))}
 />
 </div>
 )}

 <div className="space-y-[var(--space-sm)]">
 {/* Row 1: Planning title + view switcher (left) + Imprimer (right) */}
 <div className="flex items-start justify-between gap-[var(--space-sm)]">
 <div className="flex flex-col gap-[var(--space-xs)]">
 <div className="flex items-center gap-[var(--space-sm)]">
 <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em] shrink-0">{t("schedule:page.title")}</h1>
 <button
  type="button"
  onClick={() => setShowHowItWorks(!showHowItWorks)}
  className="text-muted-foreground hover:text-foreground transition-colors"
 >
  <HelpCircle className="size-4" />
 </button>
 </div>
 {showHowItWorks && (
 <div className="text-[length:var(--text-xs)] text-muted-foreground leading-relaxed space-y-[var(--space-md)] mt-[var(--space-xs)]">
  <div>
   <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("schedule:help.scheduleTitle")}</p>
   <ol className="list-decimal ml-[16px] space-y-[3px]">
    <li><Trans i18nKey="schedule:help.items.dragDrop" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.items.objectives" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.items.fillTeam" components={{ strong: <strong />, link: <a href="https://developers.google.com/optimization/cp/cp_solver" target="_blank" rel="noopener noreferrer" className="underline text-foreground hover:text-foreground/80" /> }} /></li>
    <li><Trans i18nKey="schedule:help.items.compliance" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.items.views" components={{ strong: <strong /> }} /></li>
   </ol>
  </div>
  <div>
   <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("schedule:help.engineTitle")}</p>
   <p><Trans i18nKey="schedule:help.engineExplanation" components={{ link: <a href="https://developers.google.com/optimization/cp/cp_solver" target="_blank" rel="noopener noreferrer" className="underline text-foreground hover:text-foreground/80" /> }} /></p>
  </div>
  <div>
   <p className="font-bold text-foreground mb-[var(--space-xs)]">{t("schedule:help.priorityTitle")}</p>
   <p className="mb-[var(--space-xs)]">{t("schedule:help.priorityIntro")}</p>
   <ol className="list-decimal ml-[16px] space-y-[3px]">
    <li><Trans i18nKey="schedule:help.priorities.fillSlots" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.priorities.underHours" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.priorities.moderateOT" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.priorities.lightOT" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.priorities.consistency" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.priorities.preferences" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.priorities.priority" components={{ strong: <strong /> }} /></li>
    <li><Trans i18nKey="schedule:help.priorities.flexibility" components={{ strong: <strong /> }} /></li>
   </ol>
  </div>
  <p className="text-[length:var(--text-2xs)]">
   <Trans i18nKey="schedule:help.engineFooter" components={{ link1: <a href="https://developers.google.com/optimization/cp/cp_solver" target="_blank" rel="noopener noreferrer" className="underline" />, link2: <a href="https://github.com/google/or-tools" target="_blank" rel="noopener noreferrer" className="underline" /> }} />
  </p>
 </div>
 )}
 <UnderlineNav
 items={[
 { value: "stack", label: t("schedule:viewModes.stack") },
 { value: "grid", label: t("schedule:viewModes.calendar") },
 { value: "list", label: t("schedule:viewModes.list") },
 ]}
 value={viewMode}
 onChange={(v) => {
 const vm = v as "grid" | "list" | "stack";
 setViewMode(vm);
 if (vm !== "grid") setTimeRange("week");
 if (vm !== "stack") setUnstackAll(false);
 }}
 />
 </div>
 {laborCost && !loading && (
 <div className="flex items-center gap-[var(--space-sm)] pt-[var(--space-xs)]">
 <LaborCostPill laborCost={laborCost} monday={monday} />
 </div>
 )}
 </div>

 {/* Staffing + actions row */}
 {viewMode !== "list" && (
 <div className="flex items-center gap-[var(--space-sm)] overflow-x-auto scrollbar-none">
 {activeProfileId && totalGaps > 0 && !(viewMode === "grid" && timeRange === "month") && (
 <button
 className="inline-flex items-center gap-1 px-[var(--space-md)] py-[3px] rounded-full border border-red-500 bg-red-500 text-[length:var(--text-xs)] font-bold text-white hover:bg-red-600 transition-colors cursor-pointer"
 onClick={() => setRoleFilter(roleFilter === "missing" ? "all" : "missing")}
 >
 {t("schedule:gaps.missingPositions", { count: totalGaps })}
 </button>
 )}
 <ComplianceBadge weekDate={fmt(monday)} onClick={() => setShowCompliance(true)} />
 {viewMode === "grid" && (
 <>
 <span className="w-px h-4 bg-border shrink-0" />
 <UnderlineNav
 items={[
 { value: "week", label: t("schedule:timeRange.week") },
 { value: "month", label: t("schedule:timeRange.month") },
 ]}
 value={timeRange}
 onChange={(v) => {
 const tr = v as "week" | "month";
 setTimeRange(tr);
 if (tr === "month") {
 setMonthDate(new Date(monday.getFullYear(), monday.getMonth(), 1));
 }
 if (tr === "week") {
 setMonday(getMonday(monthDate));
 }
 }}
 />
 </>
 )}
 {staffingInfo && !loading && (
 <>
 <span className="w-px h-4 bg-border shrink-0" />
 <button
 type="button"
 onClick={handleOpenWeekAudit}
 className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground hover:underline transition-colors shrink-0 pb-[2px]"
 >
 {staffingInfo.hasAuto
 ? (staffingInfo.profileName
 ? t("schedule:status.autoWithProfile", { name: staffingInfo.profileName })
 : t("schedule:status.auto")) + (staffingInfo.autoModified ? t("schedule:status.autoModifiedSuffix") : "")
 : t("schedule:status.manual")}
 </button>
 </>
 )}
 <button
 onClick={handlePrint}
 aria-label={t("schedule:actions.printAria")}
 title={t("schedule:actions.printAria")}
 className="inline-flex items-center justify-center ml-auto h-7 sm:px-[var(--space-md)] px-0 w-7 sm:w-auto rounded-full tracking-normal text-[length:12px] font-bold bg-foreground text-background hover:opacity-80 transition-opacity shrink-0 gap-[6px]"
 >
 <Printer className="size-[14px] sm:hidden" />
 <span className="hidden sm:inline">{t("schedule:actions.print")}</span>
 </button>
 </div>
 )}

 {/* Role filter tabs */}
 <UnderlineNav
 items={[
 { value: "all", label: t("schedule:roleFilter.all") },
 { value: "kitchen", label: t("schedule:roleFilter.kitchen", { count: workers.filter((w) => w.role === "kitchen").length }) },
 { value: "floor", label: t("schedule:roleFilter.floor", { count: workers.filter((w) => w.role === "floor").length }) },
 ...(activeProfileId && totalGaps > 0 ? [{ value: "missing", label: t("schedule:roleFilter.missing", { count: totalGaps }) }] : []),
 ]}
 value={roleFilter}
 onChange={(v) => { setRoleFilter(v as typeof roleFilter); setSubRoleFilter(new Set()); }}
 />

 {/* Sub-role filter badges */}
 {roleFilter !== "missing" && (() => {
 const baseWorkers = roleFilter === "all" ? workers : workers.filter(w => w.role === roleFilter);
 const subRoleCounts = new Map<string, number>();
 for (const w of baseWorkers) {
 for (const sr of w.subRoles ?? []) {
 subRoleCounts.set(sr, (subRoleCounts.get(sr) ?? 0) + 1);
 }
 }
 if (subRoleCounts.size === 0) return null;
 return (
 <div className="relative -mx-[var(--space-md)] md:mx-0">
 <div className="flex gap-1 overflow-x-auto scrollbar-none px-[var(--space-md)] md:px-0 md:flex-wrap">
 {[...subRoleCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([sr, count]) => (
 <button
 key={sr}
 onClick={() => setSubRoleFilter(prev => { const next = new Set(prev); if (next.has(sr)) next.delete(sr); else next.add(sr); return next; })}
 className={cn(
 "shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors cursor-pointer border",
 subRoleFilter.has(sr)
 ? "bg-foreground text-background border-foreground"
 : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
 )}
 >
 {sr} ({count})
 </button>
 ))}
 </div>
 <div className="pointer-events-none absolute top-0 right-0 h-full w-8 bg-gradient-to-r from-transparent to-background md:hidden" />
 </div>
 );
 })()}

 {/* Mobile-only: CUISINE / SALLE dropdowns. Tap a name to pick the worker, then long-press a zone to place. */}
 {roleFilter !== "missing" && isMobile && (
 <div className="flex flex-row items-start gap-[var(--space-xs)]">
 {(["kitchen", "floor"] as const).map((role) => {
 const roleWorkers = filteredWorkers.filter((w) => w.role === role);
 if (roleWorkers.length === 0) return null;
 const isOpen = openMobileRoleDropdown === role;
 const label = role === "kitchen" ? t("schedule:roles.kitchenMobile") : t("schedule:roles.floorMobile");
 return (
 <div key={role} className="flex-1 min-w-0 relative">
 <button
 onClick={() => setOpenMobileRoleDropdown((prev) => (prev === role ? null : role))}
 className="w-full flex items-center justify-between border border-border rounded-2xl bg-card shadow-sm px-[var(--space-md)] py-[var(--space-sm)] text-[length:var(--text-sm)] font-bold tracking-wide hover:bg-muted/50 transition-colors"
 >
 <span>{label} ({roleWorkers.length})</span>
 <span className={cn("text-[length:var(--text-xs)] transition-transform inline-block", isOpen && "rotate-180")}>{"\u25be"}</span>
 </button>
 {isOpen && (
 <>
 {/* Backdrop \u2014 tap outside the panel to close */}
 <div
 className="fixed inset-0 z-40"
 onClick={() => setOpenMobileRoleDropdown(null)}
 />
 {/* Floating panel \u2014 overlays the calendar instead of pushing it down */}
 <div className="absolute top-full left-0 right-0 mt-[var(--space-xs)] z-50 border border-border rounded-2xl bg-card shadow-lg overflow-hidden py-[var(--space-xs)] flex flex-col">
 {roleWorkers.map((w) => {
 const color = getWorkerColor(w.id);
 const isPicked = touchSelectedWorker?.id === w.id;
 return (
 <button
 key={w.id}
 onClick={() => {
 if (navigator.vibrate) navigator.vibrate(30);
 setTouchSelectedWorker((prev) => (prev?.id === w.id ? null : w));
 setOpenMobileRoleDropdown(null);
 }}
 className={cn(
 "w-full flex items-center gap-[var(--space-md)] px-[var(--space-md)] py-[var(--space-sm)] text-left text-[length:var(--text-sm)] font-medium tracking-wide transition-colors",
 isPicked
 ? "bg-muted text-foreground"
 : "text-foreground hover:bg-muted/50"
 )}
 >
 <span className={cn("size-[14px] rounded-full shrink-0", color.dot)} />
 <span className="flex-1 flex items-center gap-[var(--space-xs)] min-w-0">
 {getWorkerTier(w.id) !== "worker" && <ChefCrown faded={getWorkerTier(w.id) === "sous-chef"} />}
 {w.sharedFromRestaurantId && (
 <span title={t("schedule:legend.sharedWorker")} className="inline-flex shrink-0">
 <Link2 className="size-3 text-muted-foreground/70" aria-label={t("schedule:legend.sharedWorker")} />
 </span>
 )}
 <span className="truncate">{shortName(w.name)}</span>
 </span>
 <span className="shrink-0 text-[length:var(--text-xs)] font-mono tabular-nums text-muted-foreground">
 {workerHoursLabel(w)}
 </span>
 </button>
 );
 })}
 </div>
 </>
 )}
 </div>
 );
 })}
 </div>
 )}

 {/* Legend - clickable + draggable worker tags, grouped by role when showing all (desktop) */}
 {roleFilter !== "missing" && !isMobile && (
 <>
 <button
 onClick={() => setLegendOpen(p => !p)}
 className="sm:hidden flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
 >
 <span className={cn("inline-block transition-transform", legendOpen ? "rotate-90" : "")}>{"\u25b8"}</span>
 {selectedWorkerIds.size > 0 ? t("schedule:legend.selected", { count: selectedWorkerIds.size }) : t("schedule:legend.employees", { count: filteredWorkers.length })}
 </button>
 <div className={cn("sm:block", legendOpen ? "block" : "hidden")}>
 {roleFilter === "all" ? (
 <div className="flex flex-col gap-[var(--space-sm)]">
 {(["kitchen", "floor"] as const).map((role) => (
 <div key={role} className="flex items-baseline gap-[var(--space-xs)]">
 <span className="text-[length:var(--text-2xs)] md:text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground w-[50px] md:w-[60px] shrink-0">
 {role === "kitchen" ? t("schedule:roles.kitchenColon") : t("schedule:roles.floorColon")}
 </span>
 <div className="flex flex-wrap gap-x-[var(--space-sm)] gap-y-0">
 {filteredWorkers.filter((w) => w.role === role).map((w) => (
 <DraggableWorkerChip
 key={w.id}
 worker={w}
 isSelected={isWorkerSelected(w.id)}
 isDimmed={isWorkerDimmed(w.id)}
 draggable={viewMode === "stack" || viewMode === "grid"}
 onClick={() => toggleWorker(w.id)}
 hoursLabel={workerHoursLabel(w)}
 />
 ))}
 </div>
 </div>
 ))}
 {selectedWorkerIds.size > 0 && (
 <button
 onClick={clearWorkerSelection}
 className="inline-flex items-center self-start px-[var(--space-sm)] py-[var(--space-xs)] text-[length:var(--text-xs)] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
 >
 <X className="size-3" /> {t("schedule:actions.clear")}
 </button>
 )}
 </div>
 ) : (
 <div className="flex flex-wrap items-center gap-[var(--space-sm)]">
 {filteredWorkers.map((w) => (
 <DraggableWorkerChip
 key={w.id}
 worker={w}
 isSelected={isWorkerSelected(w.id)}
 isDimmed={isWorkerDimmed(w.id)}
 draggable={viewMode === "stack" || viewMode === "grid"}
 onClick={() => toggleWorker(w.id)}
 hoursLabel={workerHoursLabel(w)}
 />
 ))}
 {selectedWorkerIds.size > 0 && (
 <button
 onClick={clearWorkerSelection}
 className="inline-flex items-center gap-1 px-[var(--space-sm)] py-[var(--space-xs)] text-[length:var(--text-xs)] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
 >
 <X className="size-3" /> {t("schedule:actions.clear")}
 </button>
 )}
 </div>
 )}
 </div>
 </>
 )}

 {/* Date nav — just above calendar */}
 {viewMode !== "list" && (
 <div className="flex flex-col gap-[4px] md:flex-row md:items-center md:gap-[var(--space-sm)] border-t border-border py-[4px]">
 <div className="flex items-center gap-[var(--space-sm)]">
 {allProfiles.length > 0 && !(viewMode === "grid" && timeRange === "month") && (
 <button
 onClick={handleStaffClick}
 disabled={fillingGaps}
 className={cn("group inline-flex items-center gap-1 h-[24px] pl-[var(--space-sm)] pr-[var(--space-md)] rounded-full border border-transparent text-white hover:bg-violet-600 transition-colors cursor-pointer disabled:opacity-50 text-[length:11px] font-bold tracking-wide uppercase", fillingGaps ? "bg-violet-600" : "bg-amber-500")}
 title={t("schedule:buttons.autoStaff")}
 >
 {fillingGaps ? <Zap className="size-[14px] fill-current animate-storm" /> : <Zap className="size-[14px] group-hover:fill-current group-hover:rotate-12 transition-all" />}
 {t("schedule:buttons.auto")}
 </button>
 )}
 {allProfiles.length > 0 && !(viewMode === "grid" && timeRange === "month") && (
 <div className="inline-flex items-center rounded-full border border-foreground/20 hover:border-foreground/40 transition-colors">
 <DropdownMenu>
 <DropdownMenuTrigger className="inline-flex items-center gap-1 pl-[var(--space-md)] pr-[var(--space-sm)] py-[3px] rounded-l-full text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
 {(() => { const n = allProfiles.find(p => p.profile.id === activeProfileId)?.profile.name || t("schedule:profiles.objectiveLabel"); return n.length > 10 ? n.slice(0, 10) + "…" : n; })()}
 <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-50"><path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
 </DropdownMenuTrigger>
 <DropdownMenuContent align="start">
 {allProfiles.map(({ profile }) => (
 <DropdownMenuItem
 key={profile.id}
 onClick={() => selectAndSaveProfile(profile.id)}
 className={cn(
 "text-[length:var(--text-xs)] tracking-wide",
 (activeProfileId === profile.id) && "font-bold"
 )}
 >
 {profile.name || t("schedule:profiles.default")}
 </DropdownMenuItem>
 ))}
 <DropdownMenuSeparator />
 <DropdownMenuItem
 onClick={() => selectAndSaveProfile(null)}
 className={cn(
 "text-[length:var(--text-xs)] tracking-wide text-muted-foreground",
 !activeProfileId && "font-bold"
 )}
 >
 {t("schedule:profiles.noneObjective")}
 </DropdownMenuItem>
                   <DropdownMenuSeparator />
                   {activeProfileId && (
                     <DropdownMenuItem
                       onClick={() => navigate(`/preferences/objectif/${activeProfileId}`)}
                       className="text-[length:var(--text-xs)] tracking-wide flex items-center gap-2"
                     >
                       <Pencil className="size-3" /> {t("schedule:profiles.editProfile")}
                     </DropdownMenuItem>
                   )}
                   <DropdownMenuItem
                     onClick={() => navigate(`/preferences/objectif/new${activeProfileId ? `?copy=${activeProfileId}&week=${fmt(monday)}` : ""}`)}
                     className="text-[length:var(--text-xs)] tracking-wide flex items-center gap-2"
                   >
                     <Plus className="size-3" /> {t("schedule:profiles.createProfile")}
                   </DropdownMenuItem>
 </DropdownMenuContent>
 </DropdownMenu>
 <div aria-hidden className="self-stretch w-px bg-foreground/20 my-[3px]" />
 <DropdownMenu>
 <DropdownMenuTrigger
 title={t("schedule:buttons.optimizationStyle")}
 className="inline-flex items-center gap-1 pl-[var(--space-sm)] pr-[var(--space-md)] py-[3px] rounded-r-full text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
 >
 {t(`preferences:styleLabels.${styleOverride}`)}
 <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-50"><path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
 </DropdownMenuTrigger>
 <DropdownMenuContent align="start">
 {STYLE_KEYS.map((s) => (
 <DropdownMenuItem
 key={s}
 onClick={() => setStyleOverride(s)}
 className={cn(
 "text-[length:var(--text-xs)] tracking-wide",
 styleOverride === s && "font-bold",
 )}
 >
 {t(`preferences:styleLabels.${s}`)}
 </DropdownMenuItem>
 ))}
 </DropdownMenuContent>
 </DropdownMenu>
 </div>
 )}
             <button
               onClick={() => setShowCompliance(true)}
               title={weekPublished ? t("schedule:status.publishedTooltip") : t("schedule:status.draftTooltip")}
               className={cn(
                 "inline-flex items-center gap-1 h-[24px] px-[var(--space-md)] rounded-full border tracking-wide text-[length:11px] font-bold transition-colors cursor-pointer",
                 weekPublished
                   ? "border-green-500 bg-green-500 text-white hover:bg-green-600"
                   : "border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20"
               )}
             >
               <Save className="size-[12px]" />
               {!isCompact && (weekPublished ? t("schedule:status.published") : t("schedule:status.draft"))}
             </button>
             {weekLocked && (
               <button
                 onClick={() => isLockedForEdit ? setShowUnlockDialog(true) : undefined}
                 title={isLockedForEdit
                   ? t("schedule:status.lockedTooltip")
                   : t("schedule:status.unlockedTooltip")}
                 className={cn(
                   "inline-flex items-center gap-1 h-[24px] px-[var(--space-md)] rounded-full border tracking-wide text-[length:11px] font-bold transition-colors",
                   isLockedForEdit
                     ? "border-foreground/30 bg-foreground/10 text-foreground hover:bg-foreground/20 cursor-pointer"
                     : "border-orange-500/50 bg-orange-500/10 text-orange-600 cursor-default"
                 )}
               >
                 {isLockedForEdit ? <Lock className="size-[12px]" /> : <Unlock className="size-[12px]" />}
                 {isLockedForEdit ? t("schedule:status.locked") : t("schedule:status.unlocked")}
               </button>
             )}
             {activeProfileId && !(viewMode === "grid" && timeRange === "month") && (
               <button
                 onClick={handleWipeClick}
                 disabled={wipingWeek}
                 title={t("schedule:buttons.wipeWeek")}
                 className="inline-flex items-center justify-center size-[24px] rounded-full border border-red-500 bg-red-500/15 text-red-500 hover:bg-red-500 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
               >
                 <Trash2 className="size-[14px]" />
               </button>
             )}
             {viewMode === "grid" && timeRange !== "month" && (
               <button
                 onClick={() => setGridRotated(prev => !prev)}
                 title={gridRotated ? t("schedule:buttons.gridVertical") : t("schedule:buttons.gridHorizontal")}
                 className={cn(
                   "inline-flex items-center justify-center size-[24px] rounded-full border transition-colors cursor-pointer",
                   gridRotated
                     ? "border-foreground bg-foreground text-background hover:bg-foreground/80"
                     : "border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                 )}
               >
                 <RotateCw className={cn("size-[14px] transition-transform", gridRotated && "rotate-90")} />
               </button>
             )}
             <button
               onClick={toggleFullscreen}
               title={isFullscreen ? t("schedule:buttons.exitFullscreen") : t("schedule:buttons.fullscreen")}
               className={cn(
                 "inline-flex items-center justify-center size-[24px] rounded-full border transition-colors cursor-pointer",
                 isFullscreen
                   ? "border-foreground bg-foreground text-background hover:bg-foreground/80"
                   : "border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
               )}
             >
               {isFullscreen ? <Minimize2 className="size-[14px]" /> : <Maximize2 className="size-[14px]" />}
             </button>
             {viewMode === "stack" && (
               <button
                 onClick={() => setStackLayoutOverride(stackLayout === "week" ? "day" : "week")}
                 title={stackLayout === "week" ? t("schedule:buttons.stackDayView") : t("schedule:buttons.stackWeekView")}
                 className={cn(
                   "inline-flex items-center justify-center size-[24px] rounded-full border transition-colors cursor-pointer",
                   stackLayout === "day"
                     ? "border-foreground bg-foreground text-background hover:bg-foreground/80"
                     : "border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                 )}
               >
                 {stackLayout === "day" ? <Calendar className="size-[14px]" /> : <CalendarDays className="size-[14px]" />}
               </button>
             )}
             </div>
             <div className="flex items-center justify-between gap-[var(--space-sm)] md:contents">
               <div className="flex items-center gap-[var(--space-xs)] md:flex-1 md:justify-center">
 <button
 onClick={() => {
 if (viewMode === "grid" && timeRange === "month") {
 setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1));
 } else {
 setMonday((m) => addDays(m, -7));
 }
 }}
 className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
 >
 <ChevronLeft className="size-4" />
 </button>
 <span className="text-[length:var(--text-sm)] font-semibold min-w-[120px] text-center">
 {viewMode === "grid" && timeRange === "month"
 ? fmtMonthYearCap(monthDate)
 : fmtDateRange(fmt(monday), fmt(addDays(monday, 6)))}
 </span>
 <button
 onClick={() => {
 if (viewMode === "grid" && timeRange === "month") {
 setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1));
 } else {
 setMonday((m) => addDays(m, 7));
 }
 }}
 className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
 >
 <ChevronRight className="size-4" />
 </button>
 </div>
 <div className="flex items-center gap-[var(--space-xs)]">
 <button
 onClick={() => {
 const now = new Date();
 if (viewMode === "grid" && timeRange === "month") {
 setMonthDate(new Date(now.getFullYear(), now.getMonth(), 1));
 } else {
 setMonday(getMonday(new Date()));
 }
 }}
 className="text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-1 rounded hover:bg-muted"
 >
 {t("schedule:actions.today")}
 </button>
 {viewMode === "stack" && (
 <>
 <span className="w-px h-4 bg-border mx-[var(--space-xs)]" />
 <button
 onClick={() => setUnstackAll(prev => !prev)}
 className={cn(
 "text-[length:var(--text-xs)] font-medium tracking-wide transition-colors px-[var(--space-sm)] py-[var(--space-xs)] rounded-sm shrink-0",
 unstackAll ? "text-foreground bg-muted" : "text-muted-foreground hover:text-foreground"
 )}
 >
 {unstackAll ? t("schedule:actions.restack") : t("schedule:actions.expand")}
 </button>
 </>
 )}
 </div>
 </div>
 </div>
 )}

 </div>
 </div>

 {(loading || (viewMode === "grid" && timeRange === "month" && monthLoading)) ? (
 <div className="flex items-center justify-center h-96">
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("schedule:page.loading")}</p>
 </div>
 ) : viewMode === "grid" && timeRange === "month" ? (
 /* ── GRID MONTH CALENDAR ── */
 <MonthCalendar
 monthDate={monthDate}
 services={monthServices}
 roleFilter={roleFilter}
 selectedWorkerId={selectedWorkerId}
 onServiceClick={() => {}}
 onDayClick={(dateStr) => {
 setMonday(getMonday(new Date(dateStr + "T12:00:00")));
 setTimeRange("week");
 }}
 getClosureForDate={getClosureForDate}
 />
 ) : viewMode === "grid" && gridRotated ? (
 /* ── ROTATED GRID: days-as-rows, hours-as-columns (fluid) ── */
 <div className={cn("border-y border-border overflow-auto bg-card", weekPublished && "ring-2 ring-green-500")} style={{ width: "100vw", marginLeft: "calc(50% - 50vw)" }}>
 <div
 className="grid"
 style={{
 gridTemplateColumns: `${dayLabelWidth}px 1fr`,
 rowGap: "8px",
 paddingBottom: "4px",
 minWidth: isMobile ? 720 : undefined,
 background: `linear-gradient(to right, var(--muted) 0 ${dayLabelWidth}px, var(--card) ${dayLabelWidth}px)`,
 }}
 >
 {/* Top-left corner */}
 <div className="sticky left-0 top-0 z-40 border-b border-r border-border bg-muted" style={{ height: 34 }} />
 {/* Hour header row */}
 <div className="sticky top-0 z-30 border-b border-border bg-muted relative" style={{ height: 34 }}>
 {hourMarks(startHour, endHour).map((h) => {
 const leftPct = ((h - startHour) / totalHours) * 100;
 return (
 <Fragment key={`hh-${h}`}>
 <div
 className="absolute text-[length:var(--text-xs)] text-muted-foreground font-medium"
 style={{ left: `${leftPct}%`, top: "50%", transform: "translate(-50%, -50%)" }}
 >
 {formatHour(h)}
 </div>
 <div className="absolute top-0 bottom-0 border-l border-border/40" style={{ left: `${leftPct}%` }} />
 </Fragment>
 );
 })}
 </div>

 {/* Day rows */}
 {DAYS.map((dayName, i) => {
 const dateStr = fmt(addDays(monday, i));
 const today = fmt(new Date());
 const isToday = dateStr === today;
 const isPast = dateStr < today;
 const closure = getClosureForDate(dateStr);
 const w = weatherMap.get(dateStr);
 const cal = getCalendarForDate(dateStr);
 const dayServices = servicesByDate.get(dateStr) || [];
 const filtered = roleFilter === "all" || roleFilter === "missing"
 ? dayServices
 : dayServices.filter((s) => (s.workerRole || s.role) === roleFilter);
 const positioned = layoutServices(filtered, selectedWorkerId);
 const kitchenPositioned = positioned.filter((p) => !p.alignRight);
 const sallePositioned = positioned.filter((p) => !!p.alignRight);
 const kitchenBase = kitchenPositioned.length > 0 ? Math.max(...kitchenPositioned.map((p) => p.column + 1)) : 0;
 const salleBase = sallePositioned.length > 0 ? Math.max(...sallePositioned.map((p) => p.column + 1)) : 0;

 // Ghost slot computation (missing staff per zone)
 const allDayServices = services.filter((s) => s.date === dateStr);
 type RotatedGhost = { role: "kitchen" | "floor"; startTime: string; endTime: string; column: number; label?: string; zone?: string };
 const ghosts: RotatedGhost[] = [];
 if (!closure && targetLookup.size > 0) {
 let kCol = roleFilter === "missing" ? 0 : kitchenBase;
 let sCol = roleFilter === "missing" ? 0 : salleBase;
 for (const zd of zoneDefs) {
 const kt = getTarget(dateStr, "kitchen", zd.label);
 const st = getTarget(dateStr, "floor", zd.label);
 const kAssigned = allDayServices.filter((s) => (s.workerRole || s.role) === "kitchen" && assignServiceToZone(s, zoneDefs, allDayServices) === zd.label);
 const sAssigned = allDayServices.filter((s) => (s.workerRole || s.role) === "floor" && assignServiceToZone(s, zoneDefs, allDayServices) === zd.label);
 const kAssignedWorkers = new Set(kAssigned.map(s => s.workerId)).size;
 const sAssignedWorkers = new Set(sAssigned.map(s => s.workerId)).size;
 const kGhosts = kt !== undefined ? Math.max(0, kt - kAssignedWorkers) : 0;
 const sGhosts = st !== undefined ? Math.max(0, st - sAssignedWorkers) : 0;
 const kLabels = getGhostLabels(dateStr, "kitchen", zd.label, kAssigned);
 const sLabels = getGhostLabels(dateStr, "floor", zd.label, sAssigned);
 for (let gi = 0; gi < kGhosts; gi++) ghosts.push({ role: "kitchen", startTime: zd.kitchenStart, endTime: zd.kitchenEnd, column: kCol++, label: kLabels?.[gi], zone: zd.label });
 for (let gi = 0; gi < sGhosts; gi++) ghosts.push({ role: "floor", startTime: zd.serviceStart, endTime: zd.serviceEnd, column: sCol++, label: sLabels?.[gi], zone: zd.label });
 }
 }
 const kitchenGhostCount = ghosts.filter((g) => g.role === "kitchen").length;
 const salleGhostCount = ghosts.filter((g) => g.role === "floor").length;
 const kitchenTracks = roleFilter === "missing" ? kitchenGhostCount : kitchenBase + kitchenGhostCount;
 const salleTracks = roleFilter === "missing" ? salleGhostCount : salleBase + salleGhostCount;
 const trackCount = Math.max(1, kitchenTracks + salleTracks);
 const extraMeta = (w ? 1 : 0) + (cal.holiday ? 1 : 0) + (cal.vacation && !cal.holiday ? 1 : 0) + (closure ? 1 : 0);
 const labelMinHeight = ROTATED_TRACK_HEIGHT * 2 + extraMeta * 11 + 10; // +10 for padding top/bottom
 const rowHeight = Math.max(labelMinHeight, trackCount * ROTATED_TRACK_HEIGHT + 4);

 // Coupure detection: same worker + same track with a time gap → dimmed bridge
 type CoupureBridge = { key: string; workerId: string; column: number; alignRight: boolean; startH: number; endH: number };
 const bridges: CoupureBridge[] = [];
 const coupureSecondIds = new Set<string>();
 const byWorker = new Map<string, typeof positioned>();
 for (const p of positioned) {
 const arr = byWorker.get(p.service.workerId) || [];
 arr.push(p);
 byWorker.set(p.service.workerId, arr);
 }
 for (const [workerId, list] of byWorker) {
 if (list.length < 2) continue;
 const sorted = list.slice().sort((a, b) => a.service.startTime.localeCompare(b.service.startTime));
 for (let k = 0; k < sorted.length - 1; k++) {
 const a = sorted[k];
 const b = sorted[k + 1];
 if (a.column !== b.column || !!a.alignRight !== !!b.alignRight) continue;
 let aEnd = timeToHours(a.service.endTime);
 const aStart = timeToHours(a.service.startTime);
 if (aEnd <= aStart) aEnd += 24;
 const bStart = timeToHours(b.service.startTime);
 if (bStart - aEnd <= 0) continue;
 bridges.push({ key: `${workerId}-${k}`, workerId, column: a.column, alignRight: !!a.alignRight, startH: aEnd, endH: bStart });
 coupureSecondIds.add(b.service.id);
 }
 }

 return (
 <Fragment key={dateStr}>
 {/* Day label (sticky left) */}
 <div className={cn(
 "sticky left-0 z-30 border-r border-b border-border border-b-foreground/30 flex flex-col items-center justify-center text-center pl-[var(--space-md)] pr-[var(--space-sm)] py-[var(--space-xs)] overflow-hidden gap-[2px]",
 isToday ? "bg-foreground text-background" : "bg-muted",
 isPast && "opacity-50",
 )} style={{ height: rowHeight }}>
 <div className="text-[length:var(--text-sm)] font-bold tracking-wide leading-tight">{dayName}</div>
 <div className={cn("text-[length:var(--text-xs)] font-normal leading-tight", isToday ? "text-background/70" : "text-muted-foreground")}>
 {fmtDateShort(dateStr)}
 </div>
 {closure && (
 <div className={cn("text-[length:var(--text-2xs)] tracking-widest font-bold leading-none", isToday ? "text-background/60" : "text-muted-foreground")}>
 {t("schedule:status.closed")}
 </div>
 )}
 {w && <div className="hidden sm:contents"><WeatherHeaderBadge w={w} isToday={isToday} /></div>}
 {cal.holiday && (
 <div className={cn("text-[length:7px] font-bold uppercase tracking-widest leading-none truncate max-w-full", isToday ? "text-background/70" : "text-red-500 dark:text-red-400")}>
 {cal.holiday.name}
 </div>
 )}
 {cal.vacation && !cal.holiday && (
 <div className={cn("text-[length:7px] uppercase tracking-widest leading-none truncate max-w-full", isToday ? "text-background/50" : "text-blue-500/70 dark:text-blue-400/70")}>
 {cal.vacation.name}
 </div>
 )}
 </div>
 {/* Day track */}
 <div className={cn(
 "relative bg-card overflow-hidden border-b border-foreground/30",
 isPast && "opacity-40",
 closure && "closed-hatch",
 )} style={{ height: rowHeight }}>
 {/* Vertical hour grid lines */}
 {hourMarks(startHour, endHour).map((h) => (
 <div key={`gl-${dateStr}-${h}`} className="absolute top-0 bottom-0 border-l border-border/20 pointer-events-none" style={{ left: `${((h - startHour) / totalHours) * 100}%` }} />
 ))}
 {/* Ghost (missing) slots — red bars to indicate unfilled staffing targets */}
 {ghosts.map((ghost, gi) => {
 const startH = timeToHours(ghost.startTime);
 let endH = timeToHours(ghost.endTime);
 if (endH <= startH) endH += 24;
 const leftPct = Math.max(0, ((startH - startHour) / totalHours) * 100);
 const widthPct = Math.max(0, ((endH - startH) / totalHours) * 100);
 const posStyle = ghost.role === "floor"
 ? { bottom: ghost.column * ROTATED_TRACK_HEIGHT + 2 }
 : { top: ghost.column * ROTATED_TRACK_HEIGHT + 2 };
 return (
 <div
 key={`ghost-${dateStr}-${gi}`}
 className="absolute rounded-sm border border-red-300 bg-red-100 dark:border-red-800 dark:bg-red-950 flex items-center justify-center overflow-hidden"
 style={{ left: `${leftPct}%`, width: `calc(${widthPct}% - 2px)`, height: ROTATED_TRACK_HEIGHT - 4, ...posStyle }}
 title={t("schedule:ghost.tooltip", { label: ghost.label ?? ghost.role, start: ghost.startTime.slice(0,5), end: ghost.endTime.slice(0,5) })}
 >
 <div className="absolute right-[3px] top-1/2 -translate-y-1/2 z-20">
 <GhostActionsMenu
 date={dateStr}
 role={ghost.role}
 startTime={ghost.startTime}
 endTime={ghost.endTime}
 zone={ghost.zone}
 targetSubRole={ghost.label}
 workers={workers}
 daySchedule={allDayServices}
 onChanged={() => fetchData(monday)}
 forceOpt={forceOpt}
 />
 </div>
 <span className="inline-flex items-center px-[6px] py-px rounded-full bg-red-500 text-white text-[length:var(--text-2xs)] font-medium whitespace-nowrap truncate max-w-full">
 {ghost.label ?? t("schedule:ghost.missing")}
 </span>
 </div>
 );
 })}
 {/* Coupure bridges — dimmed spans between two services of the same worker on the same track */}
 {roleFilter !== "missing" && bridges.map((br) => {
 const leftPct = Math.max(0, ((br.startH - startHour) / totalHours) * 100);
 const widthPct = Math.max(0, ((br.endH - br.startH) / totalHours) * 100);
 const posStyle = br.alignRight
 ? { bottom: br.column * ROTATED_TRACK_HEIGHT + 2 }
 : { top: br.column * ROTATED_TRACK_HEIGHT + 2 };
 return (
 <div
 key={`br-${br.key}`}
 className="absolute rounded-sm bg-foreground/5 border border-dashed border-foreground/20 flex items-center justify-center pointer-events-none"
 style={{ left: `${leftPct}%`, width: `calc(${widthPct}% - 2px)`, height: ROTATED_TRACK_HEIGHT - 4, ...posStyle }}
 title={t("schedule:coupure.tooltip", { start: hoursToTime(br.startH), end: hoursToTime(br.endH) })}
 >
 <span className="text-[length:var(--text-2xs)] tabular-nums text-muted-foreground/60 truncate px-[4px]">
 {hoursToTime(br.startH)}–{hoursToTime(br.endH)}
 </span>
 </div>
 );
 })}
 {/* Services */}
 {roleFilter !== "missing" && positioned.map(({ service, column, alignRight }) => {
 const startH = timeToHours(service.startTime);
 let endH = timeToHours(service.endTime);
 if (endH <= startH) endH += 24;
 const leftPct = Math.max(0, ((startH - startHour) / totalHours) * 100);
 const widthPct = Math.max(0, ((endH - startH) / totalHours) * 100);
 const posStyle = alignRight
 ? { bottom: column * ROTATED_TRACK_HEIGHT + 2 }
 : { top: column * ROTATED_TRACK_HEIGHT + 2 };
 const color = getWorkerColor(service.workerId);
 const tier = getWorkerTier(service.workerId);
 const isDimmed = selectedWorkerId !== null && selectedWorkerId !== service.workerId;
 const subRoleRaw = serviceSubRoleMap.get(service.id);
 const subRoleLabel = subRoleRaw
 ? ({ "Sous-chef": "S.Chef", "Sous-chef de rang": "S.C.Rang", "Chef de rang": "C.Rang" } as Record<string, string>)[subRoleRaw]
 ?? (subRoleRaw.length <= 10 ? subRoleRaw : subRoleRaw.slice(0, 9) + ".")
 : null;
 return (
 <div
 key={service.id}
 className={cn(
 "absolute rounded-sm px-[4px] flex items-center gap-[3px] text-[length:var(--text-xs)] font-bold tracking-wide cursor-pointer hover:opacity-90 transition-opacity",
 color.bg, color.text,
 isDimmed && "opacity-30",
 )}
 style={{ left: `${leftPct}%`, width: `calc(${widthPct}% - 2px)`, height: ROTATED_TRACK_HEIGHT - 4, ...posStyle }}
 title={`${service.workerName}${subRoleRaw ? ` · ${subRoleRaw}` : ""} · ${service.startTime.slice(0,5)}–${service.endTime.slice(0,5)}`}
 onClick={(e) => openCalendarAction(service, e)}
 >
 <span className="shrink-0">
 <ServiceActionsMenu
 service={service}
 workers={workers}
 assignedSubRole={serviceSubRoleMap.get(service.id)}
 daySchedule={services.filter((s) => s.date === service.date)}
 onChanged={() => fetchData(monday)}
 forceOpt={forceOpt}
 />
 </span>
 {!coupureSecondIds.has(service.id) && (
 <>
 {tier !== "worker" && (
 <span className="shrink-0"><ChefCrown faded={tier === "sous-chef"} /></span>
 )}
 <span className="truncate min-w-0">{shortName(service.workerName)}</span>
 {subRoleLabel && (
 <span className="shrink-0 inline-flex items-center px-[6px] py-px rounded-full bg-black/15 dark:bg-white/15 text-[8px] font-medium leading-none whitespace-nowrap">
 {subRoleLabel}
 </span>
 )}
 </>
 )}
 <span className="ml-auto text-[length:var(--text-2xs)] tabular-nums opacity-75 shrink-0">
 {service.startTime.slice(0, 5)} &gt; {service.endTime.slice(0, 5)}
 </span>
 </div>
 );
 })}
 </div>
 </Fragment>
 );
 })}
 </div>
 </div>
 ) : viewMode === "grid" ? (
 /* ── GRID VIEW ── */
 <div ref={gridRefCb} onScroll={handleGridScroll} className={cn("border-y border-border overflow-auto bg-card", weekPublished && "ring-2 ring-green-500")} style={{ width: "100vw", marginLeft: "calc(50% - 50vw)" }}>
 <div className="grid" style={{ gridTemplateColumns: "48px repeat(7, minmax(100px, 1fr))" }}>
 {/* Column headers — sticky when scrolled */}
 <div className="sticky top-0 z-40 border-b border-r border-border bg-muted p-[var(--space-sm)]" />
 {DAYS.map((dayName, i) => {
 const dateStr = fmt(addDays(monday, i));
 const today = fmt(new Date());
 const isToday = dateStr === today;
 const isPast = dateStr < today;
 const closure = getClosureForDate(dateStr);
 const w = weatherMap.get(dateStr);
 const cal = getCalendarForDate(dateStr);
 return (
 <div
 key={dateStr}
 ref={(el) => { if (el) dayHeaderRefs.current.set(dateStr, el); }}
 onClick={(e) => { e.stopPropagation(); setOpenDayInfobox(prev => prev === dateStr ? null : dateStr); }}
 className={cn(
 "sticky top-0 z-40 border-b border-r-2 border-border text-center font-bold tracking-wide cursor-pointer transition-all",
 gridScrolledY ? "py-[2px] px-[var(--space-xs)] text-[length:var(--text-xs)]" : "p-[var(--space-sm)] text-[length:var(--text-sm)]",
 isToday ? "bg-foreground text-background" : "bg-muted hover:bg-muted/80",
 isPast && "opacity-50",
 )}
 >
 {dayName}{" "}
 <span className={cn("font-normal text-[length:var(--text-xs)]", isToday ? "text-background/70" : "text-muted-foreground")}>
 {fmtDateShort(dateStr)}
 </span>
 {!gridScrolledY && closure && (
 <div className={cn("text-[length:var(--text-2xs)] tracking-widest font-bold", isToday ? "text-background/60" : "text-muted-foreground")}>
 {t("schedule:status.closed")}
 </div>
 )}
 {/* Inline indicators — hidden when compact */}
 {!gridScrolledY && (
 <div className="mt-[2px] space-y-[1px]">
 {w && <div className="hidden sm:contents"><WeatherHeaderBadge w={w} isToday={isToday} /></div>}
 {cal.holiday && (
                        <div className={cn("text-[length:7px] font-bold uppercase tracking-widest", isToday ? "text-background/70" : "text-red-500 dark:text-red-400")}>
 {cal.holiday.name}
 </div>
 )}
 {cal.vacation && !cal.holiday && (
                        <div className={cn("text-[length:7px] uppercase tracking-widest", isToday ? "text-background/50" : "text-blue-500/70 dark:text-blue-400/70")}>
 {cal.vacation.name}
 </div>
 )}
 </div>
 )}
 {openDayInfobox === dateStr && (
 <DayInfobox
 dateStr={dateStr}
 weatherDay={w}
 holiday={cal.holiday}
 vacation={cal.vacation}
 onClose={() => setOpenDayInfobox(null)}
 anchorRef={{ current: dayHeaderRefs.current.get(dateStr) || null }}
 />
 )}
 </div>
 );
 })}

 {/* Time column */}
 <div className="border-r-2 border-border relative" style={{ height: `${totalHours * HOUR_HEIGHT}px` }}>
 {hourMarks(startHour, endHour).map((h) => (
 <div
 key={h}
 className="absolute w-full flex items-center justify-end gap-[2px] pr-[var(--space-sm)]"
 style={{ top: `${(h - startHour) * HOUR_HEIGHT}px`, height: `${HOUR_HEIGHT}px`, transform: "translateY(-50%)" }}
 >
 <span className="text-[length:var(--text-xs)] text-muted-foreground font-medium">
 {formatHour(h)}
 </span>
 </div>
 ))}
 </div>

 {/* Day columns */}
 {DAYS.map((_, i) => {
 const dateStr = fmt(addDays(monday, i));
 const today = fmt(new Date());
 const isPast = dateStr < today;
 const closure = getClosureForDate(dateStr);
 const dayServices = servicesByDate.get(dateStr) || [];
 const positioned = layoutServices(dayServices, selectedWorkerId);

 // Global max column across ALL services of each role — shared column space, not per-zone
 const kGlobalStart = Math.max(-1, ...positioned.filter(p => !p.alignRight).map(p => p.column)) + 1;
 const sGlobalStart = Math.max(-1, ...positioned.filter(p => !!p.alignRight).map(p => p.column)) + 1;
 // Use unfiltered services for actual counts so role-filtered views get correct ghost counts
 const allDayServices = services.filter(s => s.date === dateStr);
 // Accumulate ghost columns sequentially across zones so no two zones share the same column
 // Missing mode: ghosts own the full column (real services hidden) — start from 0
 let kGhostCol = roleFilter === "missing" ? 0 : kGlobalStart;
 let sGhostCol = roleFilter === "missing" ? 0 : sGlobalStart;
 const ghostSlots: GhostSlot[] = !closure && targetLookup.size > 0
 ? (() => {
 const result: GhostSlot[] = [];
 for (const zd of zoneDefs) {
 const kt = getTarget(dateStr, "kitchen", zd.label);
 const st = getTarget(dateStr, "floor", zd.label);
 const kAssigned = allDayServices.filter(s => (s.workerRole || s.role) === "kitchen" && assignServiceToZone(s, zoneDefs, allDayServices) === zd.label);
 const sAssigned = allDayServices.filter(s => (s.workerRole || s.role) === "floor" && assignServiceToZone(s, zoneDefs, allDayServices) === zd.label);
 const kAssignedWorkers = new Set(kAssigned.map(s => s.workerId)).size;
 const sAssignedWorkers = new Set(sAssigned.map(s => s.workerId)).size;
 const kGhosts = kt !== undefined ? Math.max(0, kt - kAssignedWorkers) : 0;
 const sGhosts = st !== undefined ? Math.max(0, st - sAssignedWorkers) : 0;
 const kLabels = getGhostLabels(dateStr, "kitchen", zd.label, kAssigned);
 const sLabels = getGhostLabels(dateStr, "floor", zd.label, sAssigned);
 for (let gi = 0; gi < kGhosts; gi++) result.push({ role: "kitchen", startTime: zd.kitchenStart, endTime: zd.kitchenEnd, column: kGhostCol++, label: kLabels?.[gi], zone: zd.label });
 for (let gi = 0; gi < sGhosts; gi++) result.push({ role: "floor", startTime: zd.serviceStart, endTime: zd.serviceEnd, column: sGhostCol++, label: sLabels?.[gi], zone: zd.label });
 }
 return result;
 })()
 : [];

 return (
 <DayColumn
 key={dateStr}
 dateStr={dateStr}
 services={positioned}
 selectedWorkerId={selectedWorkerId}
 onServiceClick={openCalendarAction}
 onServiceDoubleClick={(svc) => { setCalendarAction(null); openTimeEdit(svc); }}
 isPast={isPast}
 isClosed={!!closure}
 maxOverlap={maxOverlap}
 hourlyWeatherCodes={weatherMap.get(dateStr)?.hourlyWeatherCodes}
 roleFilter={roleFilter}
 ghostSlots={ghostSlots}
 startHour={startHour}
 endHour={endHour}
 serviceSubRoleMap={serviceSubRoleMap}
 workers={workers}
 daySchedule={allDayServices}
 onChanged={() => fetchData(monday)}
 forceOpt={forceOpt}
 />
 );
 })}
 </div>
 </div>
 ) : viewMode === "list" ? (
 /* ── LIST VIEW (vertical, month-based) ── */
 (() => {
 const today = fmt(new Date());
 const year = listMonth.getFullYear();
 const month = listMonth.getMonth();
 const daysInMonth = new Date(year, month + 1, 0).getDate();

 // Cumulative hours per worker from start of month
 // Key: workerId, value: running total in hours
 const cumulHours = new Map<string, number>();
 const serviceHours = (s: ServiceRow) => {
 const [sh, sm] = s.startTime.split(":").map(Number);
 const [eh, em] = s.endTime.split(":").map(Number);
 let mins = (eh * 60 + em) - (sh * 60 + sm);
 if (mins < 0) mins += 24 * 60;
 return mins / 60;
 };

 // Pre-compute cumul for ALL services (unfiltered by selection) so totals are accurate
 const sortedAll = [...listServices].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
 const cumulByServiceId = new Map<string, number>();
 for (const s of sortedAll) {
 const prev = cumulHours.get(s.workerId) || 0;
 const next = prev + serviceHours(s);
 cumulHours.set(s.workerId, next);
 cumulByServiceId.set(s.id, next);
 }

 // Build day list for the month
 const allDays = Array.from({ length: daysInMonth }, (_, i) => {
 const d = new Date(year, month, i + 1);
 const dateStr = fmt(d);
 const dayName = JOURS[d.getDay()];
 const dayServices = roleFilter === "missing"
   ? []
   : listServices
       .filter((s) => s.date === dateStr && (selectedWorkerIds.size === 0 || selectedWorkerIds.has(s.workerId)) && (roleFilter === "all" || s.role === roleFilter))
       .sort((a, b) => a.startTime.localeCompare(b.startTime));
 // Group services by zone using zone definitions
 const servicesByZone: ServiceRow[][] = zoneDefs.map((zd) =>
 dayServices.filter(s => assignServiceToZone(s, zoneDefs, dayServices) === zd.label)
 .sort((a, b) => a.startTime.localeCompare(b.startTime))
 );
 // Compute missing slots per zone (Manquants mode)
 const missingByZone: { role: "kitchen" | "floor" }[][] = zoneDefs.map((zd) => {
   if (roleFilter !== "missing" || targetLookup.size === 0 || getClosureForDate(dateStr)) return [];
   const allDay = listServices.filter(s => s.date === dateStr);
   const actualK = new Set(allDay.filter(s => s.role === "kitchen" && assignServiceToZone(s, zoneDefs, allDay) === zd.label).map(s => s.workerId)).size;
   const actualS = new Set(allDay.filter(s => s.role === "floor" && assignServiceToZone(s, zoneDefs, allDay) === zd.label).map(s => s.workerId)).size;
   const targetK = getTarget(dateStr, "kitchen", zd.label) ?? 0;
   const targetS = getTarget(dateStr, "floor", zd.label) ?? 0;
   const slots: { role: "kitchen" | "floor" }[] = [];
   for (let i = 0; i < Math.max(0, targetK - actualK); i++) slots.push({ role: "kitchen" });
   for (let i = 0; i < Math.max(0, targetS - actualS); i++) slots.push({ role: "floor" });
   return slots;
 });
 const totalMissing = missingByZone.reduce((s, z) => s + z.length, 0);
 return { dateStr, dayName, dayNum: i + 1, dayServices, servicesByZone, missingByZone, totalMissing };
 });

 return (
 <div className="flex-1 flex flex-col overflow-hidden">
 {/* Month nav bar - sticky at top */}
 <div className="shrink-0 flex items-center gap-[var(--space-xs)] border-b border-border bg-background pt-[2px] pb-[2px] px-[var(--space-xs)]">
 <button
 onClick={() => setListMonth(new Date(year, month - 1, 1))}
 className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
 >
 <ChevronLeft className="size-4" />
 </button>
 <span className="text-[length:var(--text-sm)] font-semibold">
 {fmtMonthYearCap(listMonth)}
 </span>
 <button
 onClick={() => setListMonth(new Date(year, month + 1, 1))}
 className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
 >
 <ChevronRight className="size-4" />
 </button>
 <button
 onClick={() => {
 const now = new Date();
 if (year === now.getFullYear() && month === now.getMonth()) {
 const scrollEl = listScrollRef.current;
 const todayEl = todayRef.current;
 if (scrollEl && todayEl) {
 const containerTop = scrollEl.getBoundingClientRect().top;
 const todayTop = todayEl.getBoundingClientRect().top;
 scrollEl.scrollTo({ top: scrollEl.scrollTop + (todayTop - containerTop), behavior: "smooth" });
 }
 } else {
 setListMonth(new Date(now.getFullYear(), now.getMonth(), 1));
 }
 }}
 className="text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-1 rounded hover:bg-muted ml-[var(--space-xs)]"
 >
 {t("schedule:actions.today")}
 </button>
 <span className="w-px h-4 bg-border mx-[var(--space-xs)]" />
 <button
 onClick={() => listScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
 className="text-[length:var(--text-xs)] font-medium text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-1 rounded hover:bg-muted"
 >
 {t("schedule:actions.scrollTop")}
 </button>
 <button
 onClick={() => { const el = listScrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }}
 className="text-[length:var(--text-xs)] font-medium text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-1 rounded hover:bg-muted"
 >
 {t("schedule:actions.scrollBottom")}
 </button>
 </div>
 <div ref={listScrollRef} className="flex-1 overflow-y-auto">

 {listLoading ? (
 <div className="flex items-center justify-center h-48">
 <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">{t("schedule:page.loading")}</p>
 </div>
 ) : (
 <div className="space-y-0 relative">
 {allDays.filter(d => d.dateStr === today || (roleFilter === "missing" ? d.totalMissing > 0 : d.dayServices.length > 0)).map(({ dateStr, dayName, dayNum, dayServices, servicesByZone, missingByZone }) => {
 const isToday = dateStr === today;
 const isDayPast = dateStr < today;
 const closure = getClosureForDate(dateStr);
 const isDayFuture = dateStr > today;
 // Dynamic zones from service templates
 const zones: { services: ServiceRow[]; missing: { role: "kitchen" | "floor" }[] }[] = servicesByZone.map((zoneServices, zi) => ({ services: zoneServices, missing: missingByZone[zi] ?? [] }));

 // Determine where the red "now" line goes within today's sections
 // We track which section/service boundary the current time falls in
 const isServiceDone = (s: ServiceRow) => {
 if (isDayPast) return true;
 if (isDayFuture) return false;
 // Today: done if endTime <= now
 return s.endTime.slice(0, 5) <= nowTime;
 };
 const isServiceUpcoming = (s: ServiceRow) => {
 if (isDayPast) return false;
 if (isDayFuture) return true;
 // Today: upcoming if startTime > now
 return s.startTime.slice(0, 5) > nowTime;
 };

 return (
 <div key={dateStr} ref={isToday ? todayRef : undefined} className="relative">
 {/* Full-width date header - sticky, clickable for infobox */}
 <div
 ref={(el) => { if (el) dayHeaderRefs.current.set(dateStr, el); }}
 onClick={(e) => { e.stopPropagation(); setOpenDayInfobox(prev => prev === dateStr ? null : dateStr); }}
 className={cn(
 "sticky top-0 z-40 px-[var(--space-sm)] py-[2px] border-b border-border text-center cursor-pointer",
 isToday ? "bg-foreground text-background" : "bg-muted hover:bg-muted/80",
 )}
 >
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide">
 {dayName} {String(dayNum).padStart(2, "0")} {MOIS[month]}
 </span>
 {isToday && (
 <span className="ml-[var(--space-xs)] text-[length:var(--text-xs)] font-bold tracking-wide bg-background text-foreground px-[3px] rounded">
 {t("schedule:status.todayBadge")}
 </span>
 )}
 {closure && (
 <span className={cn("ml-[var(--space-xs)] text-[length:var(--text-xs)] font-bold tracking-wide px-[3px] rounded", isToday ? "bg-background text-foreground" : "text-muted-foreground")}>
 {closure.reason ? t("schedule:status.closedWithReason", { reason: closure.reason }) : t("schedule:status.closed")}
 </span>
 )}
 {(() => {
 const cal = getCalendarForDate(dateStr);
 if (!cal.holiday && !cal.vacation) return null;
 return (
 <span className={cn("ml-[var(--space-xs)] text-[length:var(--text-xs)] font-bold tracking-wide px-[3px] rounded",
 cal.holiday
 ? (isToday ? "bg-background text-foreground" : "text-red-500 dark:text-red-400")
 : (isToday ? "bg-background/50 text-foreground" : "text-blue-500/70 dark:text-blue-400/70")
 )}>
 {cal.holiday?.name || cal.vacation?.name}
 </span>
 );
 })()}
 {openDayInfobox === dateStr && (
 <DayInfobox
 dateStr={dateStr}
 weatherDay={weatherMap.get(dateStr)}
 holiday={getCalendarForDate(dateStr).holiday}
 vacation={getCalendarForDate(dateStr).vacation}
 onClose={() => setOpenDayInfobox(null)}
 anchorRef={{ current: dayHeaderRefs.current.get(dateStr) || null }}
 />
 )}
 </div>

 {/* Midi + Soir zones, thin separator between them */}
 <div className="border-b border-border">
 {dayServices.length === 0 && missingByZone.every(z => z.length === 0) ? (
 <div className="px-[var(--space-md)] py-[3px] text-[length:var(--text-xs)] text-muted-foreground/40 italic">{t("schedule:status.noService")}</div>
 ) : (() => {
 let nowLineShown = false;
 return zones.map(({ services: zoneServices, missing: zoneMissing }, zi) => {
 if (zoneServices.length === 0 && zoneMissing.length === 0) return null;

 return (
 <div key={zi} className={cn("relative", zi > 0 && "border-t border-foreground/20")}>
 {/* One row per member */}
 {zoneServices.map((service, idx) => {
 const color = getWorkerColor(service.workerId);
 const workerDimmed = isWorkerDimmed(service.workerId);
 const upcoming = isServiceUpcoming(service);
 const cumul = cumulByServiceId.get(service.id);

 // Show red now-line only once per day - before the first upcoming service
 const prevService = idx > 0 ? zoneServices[idx - 1] : null;
 const showNowLine = !nowLineShown && isToday && upcoming && (idx === 0 || (prevService && isServiceDone(prevService)));
 if (showNowLine) nowLineShown = true;

 return (
 <div key={service.id} className="relative">
 {showNowLine && (
 <div ref={nowLineRef} className="absolute left-0 right-0 top-0 h-[2px] bg-red-500 z-10" style={{ boxShadow: "0 0 4px 0 rgb(239 68 68 / 0.5)" }}>
 <span className="absolute -top-[8px] left-[var(--space-sm)] text-[length:var(--text-2xs)] font-bold text-red-500 tabular-nums bg-card px-[1px] rounded">
 {nowTime}
 </span>
 </div>
 )}
 <button
 onClick={() => {}}
 className={cn(
 "w-full flex items-center gap-[var(--space-xs)] px-[var(--space-md)] py-[1px] border-b border-border/20 last:border-b-0 transition-all hover:opacity-80",
 color.bg,

 workerDimmed && "opacity-20",
 upcoming && !workerDimmed && "opacity-40",
 )}
 >
 <span className={cn(
 "text-[length:11px] font-bold tracking-wide flex-1 text-left flex items-center gap-[3px]",
 color.text,
 )}>
 {getWorkerTier(service.workerId) !== "worker" && <ChefCrown faded={getWorkerTier(service.workerId) === "sous-chef"} />}
 {service.workerName}
 </span>
 <span className={cn(
 "text-[length:10px] tabular-nums shrink-0",
 "text-muted-foreground",
 )}>
 {service.startTime.slice(0, 5)}-{service.endTime.slice(0, 5)}
 </span>
 {cumul != null && (
 <span className={cn(
 "text-[length:var(--text-xs)] tabular-nums shrink-0 w-[40px] text-right font-medium",
 "text-muted-foreground/50",
 )}>
 {cumul.toFixed(1)}h
 </span>
 )}
 </button>
 </div>
 );
 })}
 {zoneMissing.map((slot, mi) => (
 <div key={`ghost-${mi}`} className="w-full flex items-center gap-[var(--space-xs)] px-[var(--space-md)] py-[1px] border-b border-border/20 last:border-b-0 bg-red-500/10">
 <span className="text-[length:11px] font-bold tracking-wide flex-1 text-left text-red-500/60">{t("schedule:ghost.missing")}</span>
 <span className="text-[length:10px] shrink-0 text-red-500/50">{slot.role === "kitchen" ? t("schedule:roles.kitchen") : t("schedule:roles.floor")}</span>
 </div>
 ))}
 </div>
 );
 });
 })()}
 </div>

 {/* Red now-line at bottom of today if all services are done */}
 {isToday && dayServices.every(s => isServiceDone(s)) && (
 <div ref={nowLineRef} className="absolute left-0 right-0 bottom-0 h-[2px] bg-red-500 z-10" style={{ boxShadow: "0 0 4px 0 rgb(239 68 68 / 0.5)" }}>
 <span className="absolute -top-[8px] left-[var(--space-sm)] text-[length:var(--text-2xs)] font-bold text-red-500 tabular-nums bg-card px-[1px] rounded">
 {nowTime}
 </span>
 </div>
 )}
 </div>
 );
 })}
 </div>
 )}

 </div>
 </div>
 );
 })()
 ) : (
 /* ── STACK VIEW ── */
 (() => {
 const today = fmt(new Date());
 const allDays = DAYS.map((dayName, i) => {
 const dateStr = fmt(addDays(monday, i));
 const isToday = dateStr === today;
 const isPast = dateStr < today;
 const closure = getClosureForDate(dateStr);
 const dayServices = (servicesByDate.get(dateStr) || [])
 .filter((s) => selectedWorkerIds.size === 0 || selectedWorkerIds.has(s.workerId));
 return { dateStr, dayName, isToday, isPast, closure, dayServices };
 });
 // Day mode renders two consecutive days (default on compact viewports, toggleable via toolbar).
 const compactStack = stackLayout === "day";
 const safeDayIdx = Math.min(6, Math.max(0, stackDayIdx));
 // Anchor clamped to 0..5 so the pair always fits within the loaded week.
 const stackAnchorIdx = compactStack ? Math.min(5, safeDayIdx) : safeDayIdx;
 const days = compactStack ? [allDays[stackAnchorIdx], allDays[stackAnchorIdx + 1]] : allDays;
 const dayCount = days.length;

 return (
 <>
 {compactStack && (() => {
 // Extended scrollable date strip: ±2 weeks around the visible week (5 weeks total).
 // Tapping a date outside the current week updates `monday` and the selected day idx.
 const STRIP_WEEKS_BEFORE = 2;
 const STRIP_WEEKS_AFTER = 2;
 const stripStart = addDays(monday, -7 * STRIP_WEEKS_BEFORE);
 const stripLength = 7 * (STRIP_WEEKS_BEFORE + 1 + STRIP_WEEKS_AFTER);
 const todayStr = fmt(new Date());
 const anchorDateStr = fmt(addDays(monday, stackAnchorIdx));
 const secondDateStr = fmt(addDays(monday, stackAnchorIdx + 1));
 const mondayStr = fmt(monday);
 return (
 <div ref={dayStripScrollRef} className="relative overflow-x-auto scrollbar-none border-b border-border bg-card">
 <div className="inline-flex items-stretch gap-[2px] px-[var(--space-xs)] pt-[var(--space-xs)] pb-[var(--space-sm)]">
 {Array.from({ length: stripLength }, (_, i) => addDays(stripStart, i)).map((d) => {
 const dateStr = fmt(d);
 const isSelected = dateStr === anchorDateStr || dateStr === secondDateStr;
 const isToday = dateStr === todayStr;
 const isPast = dateStr < todayStr;
 const isWeekStart = dateStr === mondayStr;
 const dow = (d.getDay() + 6) % 7; // 0=Mon..6=Dim
 const dayName = DAYS[dow];
 const dayNum = fmtDateShort(dateStr).split(" ")[0];
 const closure = getClosureForDate(dateStr);
 return (
 <button
 key={dateStr}
 data-day-selected={isSelected || undefined}
 data-week-monday={isWeekStart || undefined}
 onClick={() => {
 const newMonday = getMonday(d);
 if (fmt(newMonday) !== fmt(monday)) setMonday(newMonday);
 setStackDayIdx(dow);
 }}
 className={cn(
 "shrink-0 min-w-[52px] flex flex-col items-center py-[var(--space-xs)] px-[var(--space-xs)] rounded-sm transition-colors",
 isSelected
 ? "bg-foreground text-background"
 : isToday
 ? "border border-foreground text-foreground"
 : isPast
 ? "text-muted-foreground/50 hover:text-foreground"
 : "text-muted-foreground hover:text-foreground hover:bg-muted",
 closure && !isSelected && "opacity-60"
 )}
 >
 <span className="text-[length:var(--text-2xs)] font-bold tracking-wide uppercase">
 {dayName}
 </span>
 <span className="text-[length:var(--text-sm)] font-bold tabular-nums leading-tight">
 {dayNum}
 </span>
 </button>
 );
 })}
 </div>
 </div>
 );
 })()}
 <div ref={gridRefCb} onScroll={handleGridScroll} onTouchStart={compactStack ? onStackTouchStart : undefined} onTouchEnd={compactStack ? onStackTouchEnd : undefined} className={cn("border-y border-border overflow-auto", weekPublished && "ring-2 ring-green-500")} style={{ width: "100vw", marginLeft: "calc(50% - 50vw)" }}>
 <div className="grid bg-card" style={{ gridTemplateColumns: compactStack ? "18px repeat(2, 1fr)" : `18px repeat(${dayCount}, minmax(130px, 1fr))` }}>
 {/* Row 1 - Day headers (sticky top + left corner) */}
 <div className="sticky top-0 left-0 z-40 border-b border-border bg-muted" />
 {days.map((d) => {
 return (
 <div
 key={d.dateStr}
 ref={(el) => { if (el) dayHeaderRefs.current.set(d.dateStr, el); }}
 onClick={(e) => { e.stopPropagation(); setOpenDayInfobox(prev => prev === d.dateStr ? null : d.dateStr); }}
 className={cn(
 "sticky top-0 z-40 border-b border-r border-border text-center font-bold tracking-wide cursor-pointer transition-all",
 gridScrolledY ? "py-[2px] px-[var(--space-xs)] text-[length:var(--text-xs)]" : "p-[var(--space-sm)] text-[length:var(--text-sm)]",
 d.isToday ? "bg-foreground text-background" : "bg-muted hover:bg-muted/80",
 d.isPast && "opacity-40"
 )}
 >
 {d.dayName}{" "}
 <span className={cn("font-normal text-[length:var(--text-xs)]", d.isToday ? "text-background/70" : "text-muted-foreground")}>
 {fmtDateShort(d.dateStr)}
 </span>
 {!gridScrolledY && d.closure && (
 <div className={cn("text-[length:var(--text-2xs)] tracking-widest font-bold", d.isToday ? "text-background/60" : "text-muted-foreground")}>
 {d.closure.reason ? t("schedule:status.closedWithReason", { reason: d.closure.reason }) : t("schedule:status.closed")}
 </div>
 )}
 {/* Inline indicators — hidden when compact */}
 {!gridScrolledY && (() => {
 const w = weatherMap.get(d.dateStr);
 const cal = getCalendarForDate(d.dateStr);
 return (
 <div className="mt-[2px] space-y-[1px]">
 {w && <div className="hidden sm:contents"><WeatherHeaderBadge w={w} isToday={d.isToday} /></div>}
 {cal.holiday && (
                                <div className={cn("text-[length:7px] font-bold uppercase tracking-widest", d.isToday ? "text-background/70" : "text-red-500 dark:text-red-400")}>
 {cal.holiday.name}
 </div>
 )}
 {cal.vacation && !cal.holiday && (
                                <div className={cn("text-[length:7px] uppercase tracking-widest", d.isToday ? "text-background/50" : "text-blue-500/70 dark:text-blue-400/70")}>
 {cal.vacation.name}
 </div>
 )}
 </div>
 );
 })()}
 {openDayInfobox === d.dateStr && (
 <DayInfobox
 dateStr={d.dateStr}
 weatherDay={weatherMap.get(d.dateStr)}
 holiday={getCalendarForDate(d.dateStr).holiday}
 vacation={getCalendarForDate(d.dateStr).vacation}
 onClose={() => setOpenDayInfobox(null)}
 anchorRef={{ current: dayHeaderRefs.current.get(d.dateStr) || null }}
 />
 )}
 </div>
 );
 })}

 {/* Dynamic zone rows */}
 {zoneDefs.map((zd, zoneIdx) => {
 const stacksH = maxStacksHByZone[zoneIdx] ?? 42;
 return (
 <Fragment key={zd.label}>
 {/* Separator between zones (not before first) */}
 {zoneIdx > 0 && (
 <div key={`sep-${zd.label}`} style={{ gridColumn: "1 / -1", height: "2px" }} className="bg-border" />
 )}

 {/* Zone label column */}
 <div key={`label-${zd.label}`} className="sticky left-0 z-30 flex items-center justify-center bg-card">
                          <span className="text-[length:var(--text-2xs)] font-bold uppercase tracking-wider text-muted-foreground" style={{ writingMode: "vertical-lr", transform: "rotate(180deg)" }}>
 {zd.label.toUpperCase()}
 </span>
 </div>

 {/* Zone cells for each day */}
 {days.map((d) => {
 const zoneId = `${d.dateStr}:${zd.label}`;
 const zoneServices = d.dayServices.filter(s => assignServiceToZone(s, zoneDefs, d.dayServices) === zd.label);
 const dow = dateToDow(d.dateStr);
 const kitchenTimes = roleTimeDisplay(zoneLegs(zd.label, "kitchen", dow));
 const salleTimes = roleTimeDisplay(zoneLegs(zd.label, "floor", dow));
 return (
 <ZoneDrop
 key={`${d.dateStr}-${zd.label}`}
 id={zoneId}
 className={cn("border-r border-border", d.isPast && activeZone !== zoneId && "opacity-40", d.closure && "closed-hatch")}
 zIndex={(activeZone === zoneId || dragOver === zoneId) ? 20 : (zoneDefs.length - zoneIdx)}
 isDragActive={draggingService}
 hasTouchSelection={!!touchSelectedService || !!touchSelectedWorker}
 onTouchPlace={handleTouchPlace}
 >
 <CardStackInner
 services={zoneServices}
 zoneLabel={zd.label}
 zoneId={zoneId}
 selectedWorkerIds={selectedWorkerIds}
 onServiceClick={() => {}}
 stacksH={stacksH}
 dimmed={!!dragSource && !draggingService && zoneId !== dragSource && zoneId !== dragOver}
 onActiveChange={(active) => handleZoneActiveChange(zoneId, active)}
 isDragging={draggingService}
 forceExpandRole={dragOver === zoneId && (!touchDragActive || unstackedZoneId === zoneId) ? draggedRole : null}
 readyToCommit={readyZoneId === zoneId}
 touchUnstacked={unstackedZoneId === zoneId}
															forceExpandAll={unstackAll || selectedWorkerIds.size > 0 || subRoleFilter.size > 0}
 direction={zoneDefs.length <= 1 || zoneIdx < Math.floor(zoneDefs.length / 2) ? "down" : "up"}
 growOnExpand={zoneDefs.length <= 1}
 kitchenTarget={subRoleFilter.size > 0 || selectedWorkerIds.size > 0 ? undefined : getTarget(d.dateStr, "kitchen", zd.label)}
 salleTarget={subRoleFilter.size > 0 || selectedWorkerIds.size > 0 ? undefined : getTarget(d.dateStr, "floor", zd.label)}
 kitchenTimeLabel={kitchenTimes.label}
 kitchenTimeTitle={kitchenTimes.title}
 salleTimeLabel={salleTimes.label}
 salleTimeTitle={salleTimes.title}
 roleFilter={roleFilter}
 touchSelectedId={touchSelectedService?.id ?? null}
 onTouchSelect={handleTouchSelect}
 touchSelectedService={touchSelectedService}
 dragHoverRole={dragOver === zoneId ? draggedRole : null}
 dragConflict={dragOver === zoneId ? dragFeedback.state === "conflict" : false}
 conflictServiceIds={dragFeedback.conflictIds.size > 0 ? dragFeedback.conflictIds : undefined}
 draggedService={activeDragItem && 'service' in activeDragItem ? activeDragItem.service : null}
 draggedWorker={activeDragItem && 'worker' in activeDragItem ? activeDragItem.worker : null}
 onDropSnap={setDragSnapped}
 kitchenGhostLabels={getGhostLabels(d.dateStr, "kitchen", zd.label, zoneServices.filter(s => (s.workerRole || s.role) === "kitchen"))}
 salleGhostLabels={getGhostLabels(d.dateStr, "floor", zd.label, zoneServices.filter(s => (s.workerRole || s.role) === "floor"))}
 serviceSubRoleMap={serviceSubRoleMap}
 hasActiveFilter={selectedWorkerIds.size > 0 || subRoleFilter.size > 0}
                         complianceLookup={complianceLookup}
 touchMode={touchDragActive}
 touchPlacementConflict={touchSelectedService ? touchPlacementConflictAt(zoneId) : false}
 renderActionsMenu={(s, sub) => (
  <ServiceActionsMenu
   service={s}
   workers={workers}
   assignedSubRole={sub}
   daySchedule={services.filter((x) => x.date === s.date)}
   onChanged={() => fetchData(monday)}
   forceOpt={forceOpt}
  />
 )}
 renderGhostActionsMenu={(role, _gi, ghostLabel) => (
  <GhostActionsMenu
   date={d.dateStr}
   role={role}
   startTime={role === "kitchen" ? zd.kitchenStart : zd.serviceStart}
   endTime={role === "kitchen" ? zd.kitchenEnd : zd.serviceEnd}
   zone={zd.label}
   targetSubRole={ghostLabel}
   workers={workers}
   daySchedule={services.filter((x) => x.date === d.dateStr)}
   onChanged={() => fetchData(monday)}
   forceOpt={forceOpt}
  />
 )}
 />
 </ZoneDrop>
 );
 })}
 </Fragment>
 );
 })}

 </div>
 </div>
 </>
 );
 })()
 )}

 {/* Touch selection floating indicator (existing service being moved) */}
 {touchSelectedService && (
 <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full bg-accent px-4 py-2 shadow-lg text-accent-foreground text-sm font-medium animate-in slide-in-from-bottom-4">
 <span>{shortName(touchSelectedService.workerName)}</span>
 <span className="opacity-70">{t("schedule:touch.holdToPlace")}</span>
 <button
 className="ml-1 rounded-full bg-accent-foreground/20 p-1 hover:bg-accent-foreground/30"
 onClick={() => setTouchSelectedService(null)}
 >
 <X className="size-3" />
 </button>
 </div>
 )}

 {/* Picked-worker indicator (mobile dropdown flow — long-press a zone to create the service) */}
 {touchSelectedWorker && !touchSelectedService && (
 <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full bg-foreground px-4 py-2 shadow-lg text-background text-sm font-medium animate-in slide-in-from-bottom-4">
 <span className={cn("size-[10px] rounded-full shrink-0", getWorkerColor(touchSelectedWorker.id).dot)} />
 <span>{shortName(touchSelectedWorker.name)}</span>
 <span className="opacity-70">{t("schedule:touch.holdToPlace")}</span>
 <button
 className="ml-1 rounded-full bg-background/20 p-1 hover:bg-background/30"
 onClick={() => setTouchSelectedWorker(null)}
 >
 <X className="size-3" />
 </button>
 </div>
 )}

 {calendarAction && (
  <ServiceActionsMenu
   service={calendarAction.service}
   workers={workers}
   assignedSubRole={serviceSubRoleMap.get(calendarAction.service.id)}
   daySchedule={services.filter((s) => s.date === calendarAction.service.date)}
   onChanged={async () => {
    setCalendarAction(null);
    await fetchData(monday);
   }}
   forceOpt={forceOpt}
   open={calendarAction.open}
   // Base UI can emit a delayed close from the original card click when the
   // trigger is a synthetic 1px anchor. Ignore those transient closes here;
   // outside clicks/Escape and item selection close the calendar menu explicitly.
   onOpenChange={(open) => {
    if (open) setCalendarAction((current) => current ? { ...current, open: true } : current);
   }}
   onSelectClose={() => setCalendarAction((current) => current ? { ...current, open: false } : current)}
   triggerVariant="anchor"
   triggerStyle={{ left: calendarAction.x, top: calendarAction.y }}
  />
 )}

 {/* Staff choice dialog: Replace or Complete */}
 <Dialog open={showStaffChoice} onOpenChange={setShowStaffChoice}>
 <DialogContent showCloseButton={false}>
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide flex items-center gap-[var(--space-sm)]">
 <Zap className="size-4 text-amber-500" />
 {t("schedule:dialogs.autoStaffing.title")}
 </DialogTitle>
 <DialogDescription>
 {t("schedule:dialogs.autoStaffing.existsDescription")}
 </DialogDescription>
 </DialogHeader>
 <DialogFooter>
 <DialogClose render={<Button variant="outline" className="tracking-wide text-[length:var(--text-xs)] font-bold" />}>
 {t("schedule:actions.cancel")}
 </DialogClose>
 <Button
 onClick={() => { setShowStaffChoice(false); handleFillGaps(); }}
 className="tracking-wide text-[length:var(--text-xs)] font-bold bg-amber-500 hover:bg-amber-600 text-white border-amber-500"
 >
 {t("schedule:actions.complete")}
 </Button>
 <Button
 onClick={() => { setShowStaffChoice(false); handleReplaceStaff(); }}
 className="tracking-wide text-[length:var(--text-xs)] font-bold bg-red-500 hover:bg-red-600 text-white border-red-500"
 >
 {t("schedule:actions.replace")}
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Unlock past+published week dialog */}
 <Dialog open={showUnlockDialog} onOpenChange={(open) => { if (!open) setShowUnlockDialog(false); }}>
 <DialogContent showCloseButton={false}>
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide flex items-center gap-[var(--space-sm)]">
 <Lock className="size-4 text-orange-500" />
 {t("schedule:dialogs.unlockWeek.title")}
 </DialogTitle>
 <DialogDescription>
 <Trans i18nKey="schedule:dialogs.unlockWeek.description" values={{ from: fmt(monday), to: fmt(addDays(monday, 6)) }} components={{ strong: <strong /> }} />
 <p className="mt-2">
 <Trans i18nKey="schedule:dialogs.unlockWeek.details" components={{ em: <em /> }} />
 </p>
 </DialogDescription>
 </DialogHeader>
 <DialogFooter>
 <DialogClose render={<Button variant="outline" className="tracking-wide text-[length:var(--text-xs)] font-bold" />}>
 {t("schedule:actions.cancel")}
 </DialogClose>
 <Button
 onClick={confirmUnlock}
 className="tracking-wide text-[length:var(--text-xs)] font-bold bg-orange-600 hover:bg-orange-700 text-white border-orange-600"
 >
 <Unlock className="size-3 mr-1" /> {t("schedule:actions.unlock")}
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Wipe-week confirmation dialog */}
 <Dialog open={showWipeWeek} onOpenChange={(open) => { if (!open) { setShowWipeWeek(false); setWipeWarning(null); } }}>
 <DialogContent showCloseButton={false}>
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide flex items-center gap-[var(--space-sm)]">
 <Trash2 className="size-4 text-red-500" />
 {t("schedule:dialogs.wipeWeek.title")}
 </DialogTitle>
 <DialogDescription>
 <Trans i18nKey="schedule:dialogs.wipeWeek.description" values={{ from: fmt(monday), to: fmt(addDays(monday, 6)) }} components={{ strong: <strong /> }} />
              {wipeWarning && (
                <p className="mt-2 flex items-start gap-2 text-amber-600 text-sm font-medium">
                  <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                  {wipeWarning}
                </p>
              )}
 </DialogDescription>
 </DialogHeader>
 <DialogFooter>
 <DialogClose render={<Button variant="outline" className="tracking-wide text-[length:var(--text-xs)] font-bold" />}>
 {t("schedule:actions.cancel")}
 </DialogClose>
 <Button
 onClick={handleWipeWeek}
 disabled={wipingWeek}
 className="tracking-wide text-[length:var(--text-xs)] font-bold bg-red-600 hover:bg-red-700 text-white border-red-600"
 >
 {wipingWeek ? t("schedule:actions.loadingShort") : t("schedule:actions.deleteWeek")}
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Past-date confirmation dialog */}
 <Dialog open={!!pendingPastAction} onOpenChange={(open) => { if (!open) setPendingPastAction(null); }}>
 <DialogContent showCloseButton={false}>
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide">
 {t("schedule:dialogs.pastDate.title")}
 </DialogTitle>
 <DialogDescription>
 {t("schedule:dialogs.pastDate.description")}
 </DialogDescription>
 </DialogHeader>
 <DialogFooter>
 <DialogClose render={<Button variant="outline" />}>
 {t("schedule:actions.cancel")}
 </DialogClose>
 <Button
 onClick={async () => {
 const action = pendingPastAction;
 setPendingPastAction(null);
 if (action) await action();
 }}
 >
 {t("schedule:actions.confirm")}
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Closure warning - shown when creating/moving to a date during a restaurant closure */}
 <Dialog open={!!pendingClosureAction} onOpenChange={(open) => { if (!open) setPendingClosureAction(null); }}>
 <DialogContent showCloseButton={false}>
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide">
 {t("schedule:dialogs.closure.title")}
 </DialogTitle>
 <DialogDescription>
 {pendingClosureAction?.closureReason
   ? t("schedule:dialogs.closure.descriptionWithReason", { reason: pendingClosureAction.closureReason })
   : t("schedule:dialogs.closure.description")}
 </DialogDescription>
 </DialogHeader>
 <DialogFooter>
 <DialogClose render={<Button variant="outline" />}>
 {t("schedule:actions.cancel")}
 </DialogClose>
 <Button
 onClick={async () => {
 const action = pendingClosureAction?.action;
 setPendingClosureAction(null);
 if (action) await action();
 }}
 >
 {t("schedule:actions.scheduleAnyway")}
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Auto-staffing preview dialog */}
 <Dialog open={showAutoStaff} onOpenChange={(open) => { if (!open) { setShowAutoStaff(false); setAutoStaffPreview(null); } }}>
 <DialogContent showCloseButton={false} className="sm:max-w-lg max-h-[80vh] flex flex-col">
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide">
 {t("schedule:dialogs.autoStaffPreview.title")}
 </DialogTitle>
 {autoStaffPreview && (
 <DialogDescription>
 {t("schedule:dialogs.autoStaffPreview.description", { from: autoStaffPreview.week.from, to: autoStaffPreview.week.to, count: autoStaffPreview.services.length })}
 </DialogDescription>
 )}
 </DialogHeader>
 {/* Staffing targets grid - editable per-week override */}
 <div className="border border-border rounded-[0.2rem] p-[var(--space-sm)] space-y-[var(--space-xs)]">
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-[var(--space-xs)]">
 <p className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground">{t("schedule:dialogs.autoStaffPreview.targetsLabel")}</p>
 {allProfiles.length > 1 && (
 <div className="flex gap-[2px]">
 {allProfiles.map(({ profile, targets: pTargets }) => (
 <button
 key={profile.id}
 type="button"
 onClick={() => {
 setActiveProfileId(profile.id);
 const tMap = Object.fromEntries(
 pTargets.map((t) => [`${t.dayOfWeek}_${t.role}_${t.zone}`, t.count])
 );
 setAutoStaffTargets(tMap);
 handleAutoStaffPreview(tMap);
 }}
                        className={`text-[length:var(--text-2xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-[0.2rem] border transition-colors ${
 (activeProfileId ?? allProfiles[0]?.profile.id) === profile.id
 ? "bg-foreground text-background border-foreground"
 : "bg-transparent text-muted-foreground border-foreground/20 hover:border-foreground/40"
 }`}
 >
 {profile.name || t("schedule:profiles.default")}
 </button>
 ))}
 </div>
 )}
 </div>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground">{t("schedule:dialogs.autoStaffPreview.zeroMeansAll")}</p>
 </div>
 <table className="w-full">
 <thead>
 <tr>
                  <th className="text-left text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground pr-[var(--space-xs)] pb-[2px]" />
 {DAYS.map((label, i) => {
 const day = i + 1;
 const mode = openDays[String(day)];
 return (
 <th key={day} className={cn(
                        "text-center text-[length:var(--text-2xs)] uppercase tracking-widest font-bold pb-[2px] w-[38px]",
 mode ? "text-foreground" : "text-muted-foreground/30"
 )}>
 {label}
 </th>
 );
 })}
 </tr>
 </thead>
 <tbody>
 {zoneDefs.flatMap((zd) =>
 (["kitchen", "floor"] as const).map((role) => (
 <tr key={`${role}_${zd.label}`}>
                      <td className="text-[length:7px] uppercase tracking-widest font-bold text-muted-foreground whitespace-nowrap pr-[var(--space-xs)] py-[1px]">
 {role === "kitchen" ? t("schedule:roles.kitchenAbbr") : t("schedule:roles.floorAbbr")} {zd.label.toUpperCase()}
 </td>
 {DAYS.map((_, i) => {
 const day = i + 1;
 const mode = openDays[String(day)] as string | undefined;
 const isOpen = !!mode;
 const key = `${day}_${role}_${zd.label}`;
 const val = autoStaffTargets[key] || 0;
 if (!isOpen) {
 return <td key={day} className="text-center py-[1px]"><span className="text-[length:var(--text-2xs)] text-muted-foreground/20">-</span></td>;
 }
 return (
 <td key={day} className="text-center py-[1px]">
 <input
 type="number"
 min={0}
 max={20}
 value={val || ""}
 placeholder="0"
 onChange={(e) => {
 const next = { ...autoStaffTargets, [key]: parseInt(e.target.value) || 0 };
 setAutoStaffTargets(next);
 }}
 className="w-[32px] h-5 text-center text-[length:10px] font-bold bg-transparent border border-foreground/15 rounded-[0.15rem] focus:border-foreground/40 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 </td>
 );
 })}
 </tr>
 ))
 )}
 </tbody>
 </table>
 <Button
 variant="outline"
 size="sm"
 onClick={() => handleAutoStaffPreview(autoStaffTargets)}
 disabled={autoStaffLoading}
              className="w-full h-6 tracking-normal text-[length:var(--text-xs)] font-bold"
 >
 {autoStaffLoading ? t("schedule:actions.loadingShort") : t("schedule:actions.refreshPreview")}
 </Button>
 </div>

 {autoStaffPreview && (
 <div className="flex-1 overflow-y-auto space-y-[var(--space-sm)] pr-[var(--space-xs)]">
 {autoStaffPreview.warnings.length > 0 && (
 <div className="space-y-[2px]">
 {autoStaffPreview.warnings.map((w, i) => (
 <p key={i} className="text-[length:var(--text-xs)] text-destructive tracking-wide font-bold">{w}</p>
 ))}
 </div>
 )}
 {(() => {
 // Group by date
 const byDate = new Map<string, typeof autoStaffPreview.services>();
 for (const s of autoStaffPreview.services) {
 if (!byDate.has(s.date)) byDate.set(s.date, []);
 byDate.get(s.date)!.push(s);
 }
 return Array.from(byDate.entries()).map(([date, dayServices]) => (
 <div key={date}>
 <p className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground mb-[2px]">
 {fmtDateMed(date)}
 </p>
 <div className="grid grid-cols-2 gap-x-[var(--space-md)] gap-y-[1px]">
 {dayServices.map((s, i) => (
 <div key={i} className="flex items-center gap-[var(--space-xs)]">
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground w-[28px]">{s.zone}</span>
 <span className="text-[length:var(--text-sm)] font-medium truncate">{s.workerName}</span>
 <span className="text-[length:var(--text-xs)] text-muted-foreground ml-auto shrink-0">{s.startTime}-{s.endTime}</span>
 </div>
 ))}
 </div>
 </div>
 ));
 })()}
 </div>
 )}
 <DialogFooter className="gap-[var(--space-xs)]">
 <DialogClose render={<Button variant="outline" className="tracking-wide text-[length:var(--text-xs)] font-bold" />}>
 {t("schedule:actions.cancel")}
 </DialogClose>
 <Button
 onClick={() => handleAutoStaffGenerate()}
 disabled={autoStaffLoading || !autoStaffPreview?.services.length}
 className="tracking-wide text-[length:var(--text-xs)] font-bold"
 >
 {t("schedule:actions.addServices")}
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Service type selector - shown when dropping a worker on the grid */}
 <ServiceTypeModal
 pending={pendingWorkerDrop}
 zones={zoneDefs}
 onSelect={handleServiceTypeSelect}
 onClose={() => setPendingWorkerDrop(null)}
 />


 {/* Print portal - rendered outside #root so @media print can show it */}
 {createPortal(
 <div id="schedule-print-root">
 <SchedulePrint
 monday={monday}
 services={services}
 workers={workers}
 closures={closures}
 restaurantName={restaurantName}
 />
 </div>,
 document.body
 )}
 <ComplianceDialog
 weekDate={fmt(monday)}
 open={showCompliance}
 onOpenChange={setShowCompliance}
 onWorkerClick={(id) => {
 setShowCompliance(false);
 setSelectedWorkerIds(new Set([id]));
 }}
 weekPublished={weekPublished}
 onTogglePublish={handleTogglePublish}
 publishLoading={publishLoading}
 weekServices={services}
 />
 </div>
 <DragOverlay style={{ display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
 {activeDragItem && (
 <div
  ref={overlayShakeRef}
  className={!('service' in activeDragItem) && !dragSnapped ? "drag-pickup" : undefined}
  style={{
   opacity: dragSnapped ? 0.3 : 1,
   transform: dragSnapped ? "scale(0.85)" : "scale(1)",
  }}
 >
 {'service' in activeDragItem ? (
  <OverlayServiceCard service={activeDragItem.service} feedback={dragFeedback.state} />
 ) : (
  <OverlayWorkerChip worker={activeDragItem.worker} feedback={dragFeedback.state} />
 )}
 </div>
 )}
 </DragOverlay>

 {/* Gap warning dialog after fill-gaps */}
 <Dialog open={showGapWarning} onOpenChange={setShowGapWarning}>
 <DialogContent>
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide flex items-center gap-[var(--space-sm)]">
 <AlertTriangle className="size-4 text-amber-500" /> {t("schedule:dialogs.gapWarning.title")}
 </DialogTitle>
 <DialogDescription>
 {t("schedule:dialogs.gapWarning.description")}
 </DialogDescription>
 </DialogHeader>
 {gapWarnings.length > 0 && (
 <ul className="text-[length:var(--text-xs)] text-muted-foreground space-y-1 max-h-48 overflow-y-auto">
 {gapWarnings.map((w, i) => (
 <li key={i} className="flex items-start gap-[var(--space-xs)]">
 <span className="size-1.5 rounded-full bg-amber-500 shrink-0 mt-1" />
 <span>{w}</span>
 </li>
 ))}
 </ul>
 )}
 <DialogFooter>
 <DialogClose render={<Button size="sm" />}>
 {t("schedule:actions.understood")}
 </DialogClose>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Week audit log dialog */}
 <Dialog open={showWeekAudit} onOpenChange={setShowWeekAudit}>
 <DialogContent className="max-w-lg">
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide">
 {t("schedule:dialogs.auditLog.title")}
 </DialogTitle>
 <DialogDescription>
 {fmtDateRange(fmt(monday), fmt(addDays(monday, 6)))}
 </DialogDescription>
 </DialogHeader>
 {weekAuditLoading ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground py-[var(--space-md)]">{t("schedule:page.loading")}</p>
 ) : weekAuditLogs.length === 0 ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground py-[var(--space-md)]">{t("schedule:dialogs.auditLog.noChanges")}</p>
 ) : (
 <ul className="space-y-[var(--space-sm)] max-h-[400px] overflow-y-auto">
 {weekAuditLogs.map((log) => (
 <li key={log.id} className="flex items-start gap-[var(--space-sm)] text-[length:var(--text-xs)] tracking-wide">
 <span className={cn(
 "shrink-0 w-[52px] text-right tabular-nums text-muted-foreground",
 )}>
 {fmtDateShort(new Date(log.createdAt).toISOString().slice(0, 10))}
 </span>
 <span className={cn(
 "shrink-0 px-[var(--space-xs)] py-[1px] rounded text-[length:10px] uppercase font-bold tracking-widest",
 log.action === "insert" && "bg-emerald-500/10 text-emerald-600",
 log.action === "update" && "bg-amber-500/10 text-amber-600",
 log.action === "delete" && "bg-red-500/10 text-red-600",
 )}>
 {log.action === "insert" ? t("schedule:dialogs.auditLog.actionInsert") : log.action === "update" ? t("schedule:dialogs.auditLog.actionUpdate") : t("schedule:dialogs.auditLog.actionDelete")}
 </span>
 <span className="flex-1">
 {log.summary || `${log.tableName} ${log.action}`}
 {log.actorName && (
 <span className="text-muted-foreground"> — {log.actorName}</span>
 )}
 {log.source && log.source !== "dashboard" && (
 <span className="text-muted-foreground/60"> ({log.source})</span>
 )}
 </span>
 </li>
 ))}
 </ul>
 )}
 <DialogFooter>
 <DialogClose render={<Button size="sm" />}>
 {t("schedule:actions.close")}
 </DialogClose>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 {/* Double-click time edit — modifies services row for this week only, not the objectif */}
 <Dialog open={!!timeEditService} onOpenChange={(o) => { if (!o) closeTimeEdit(); }}>
  <DialogContent className="max-w-sm">
   <DialogHeader>
    <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide">
     {t("schedule:dialogs.timeEdit.title")}
    </DialogTitle>
    <DialogDescription>
     {timeEditService && (
      <>
       {t("schedule:dialogs.timeEdit.description", { name: shortName(timeEditService.workerName), date: fmtDateMed(timeEditService.date) })}
      </>
     )}
    </DialogDescription>
   </DialogHeader>
   <div className="grid grid-cols-2 gap-[var(--space-md)] py-[var(--space-sm)]">
    <label className="space-y-[var(--space-xs)]">
     <span className="text-[length:var(--text-xs)] font-bold tracking-wide uppercase text-muted-foreground">{t("schedule:dialogs.timeEdit.startLabel")}</span>
     <input
      type="time"
      value={timeEditStart}
      onChange={(e) => setTimeEditStart(e.target.value)}
      className="w-full h-[var(--space-xl)] px-[var(--space-sm)] rounded-md border border-foreground/15 bg-background font-mono text-[length:var(--text-sm)]"
     />
    </label>
    <label className="space-y-[var(--space-xs)]">
     <span className="text-[length:var(--text-xs)] font-bold tracking-wide uppercase text-muted-foreground">{t("schedule:dialogs.timeEdit.endLabel")}</span>
     <input
      type="time"
      value={timeEditEnd}
      onChange={(e) => setTimeEditEnd(e.target.value)}
      className="w-full h-[var(--space-xl)] px-[var(--space-sm)] rounded-md border border-foreground/15 bg-background font-mono text-[length:var(--text-sm)]"
     />
    </label>
   </div>
   <p className="text-[length:var(--text-2xs)] text-muted-foreground leading-snug">
    {t("schedule:dialogs.timeEdit.note")}
   </p>
   {timeEditError && <p className="text-[length:var(--text-xs)] text-destructive font-bold">{timeEditError}</p>}
   <DialogFooter>
    <Button
     size="sm"
     variant="outline"
     onClick={closeTimeEdit}
     disabled={timeEditSaving}
    >
     {t("schedule:actions.cancel")}
    </Button>
    <Button
     size="sm"
     disabled={timeEditSaving || !timeEditService || !timeEditStart || !timeEditEnd || (timeEditStart === timeEditService.startTime.slice(0,5) && timeEditEnd === timeEditService.endTime.slice(0,5))}
     onClick={async () => {
      if (!timeEditService) return;
      setTimeEditSaving(true);
      setTimeEditError("");
      try {
       await api.updateService(timeEditService.id, { startTime: timeEditStart, endTime: timeEditEnd }, forceOpt());
       closeTimeEdit();
       await fetchData(monday);
      } catch (err) {
       setTimeEditError(err instanceof Error ? err.message : t("schedule:toasts.modificationFailed"));
      } finally {
       setTimeEditSaving(false);
      }
     }}
    >
     {timeEditSaving ? t("schedule:actions.loadingShort") : t("schedule:actions.save")}
    </Button>
   </DialogFooter>
  </DialogContent>
 </Dialog>
 <ScheduleMobileTutorial enabled={isMobile && viewMode === "stack"} />
 </DndContext>
 );
}

// ── DragOverlay visuals - portal-rendered, always on top ──
function OverlayServiceCard({ service, feedback = "neutral" }: { service: ServiceRow; feedback?: "neutral" | "valid" | "conflict" | "wrong-role" }) {
 const color = getWorkerColor(service.workerId);
 // Combine ring (via outline, not box-shadow) + glow (via box-shadow) so they don't conflict
 const outlineClass = {
 neutral: "outline-[2px] outline-foreground/30",
 valid: "outline-[3px] outline-emerald-500 dark:outline-emerald-400",
 conflict: "outline-[3px] outline-red-500 dark:outline-red-400",
 "wrong-role": "outline-[3px] outline-red-500 dark:outline-red-400 opacity-60",
 }[feedback];
 const glowShadow = {
 neutral: "0 0 8px rgba(0,0,0,0.15)",
 valid: "0 0 10px 2px rgba(16,185,129,0.45), 0 0 20px 4px rgba(16,185,129,0.2)",
 conflict: "0 0 10px 2px rgba(239,68,68,0.5), 0 0 20px 4px rgba(239,68,68,0.25)",
 "wrong-role": "0 0 10px 2px rgba(239,68,68,0.4), 0 0 20px 4px rgba(239,68,68,0.2)",
 }[feedback];
 return (
 <div
 className={cn(
 "flex flex-col items-center justify-center gap-[2px] rounded-[1.2rem] border px-[var(--space-xs)] cursor-grabbing transition-all duration-200 outline outline-offset-0",
 outlineClass,
 color.bg, color.border, color.text
 )}
 style={{ height: "42px", width: "120px", boxShadow: glowShadow, outlineStyle: "solid" }}
 >
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide leading-tight text-center flex items-center gap-[3px]">
 {getWorkerTier(service.workerId) !== "worker" && <ChefCrown faded={getWorkerTier(service.workerId) === "sous-chef"} />}
 {shortName(service.workerName)}
 </span>
 <span className="text-[length:10px] tabular-nums leading-none text-muted-foreground">
 {service.startTime.slice(0, 5)}-{service.endTime.slice(0, 5)}
 </span>
 </div>
 );
}

function OverlayWorkerChip({ worker, feedback = "neutral" }: { worker: User; feedback?: "neutral" | "valid" | "conflict" | "wrong-role" }) {
 const color = getWorkerColor(worker.id);
 const subs = worker.subRoles ?? [];
 const subLabel = subs.length > 0 ? (subs[0].length > 6 ? subs[0].slice(0, 5) + "." : subs[0]) : null;
 const outlineClass = {
  neutral: "outline-[2px] outline-foreground/30",
  valid: "outline-[3px] outline-emerald-500 dark:outline-emerald-400",
  conflict: "outline-[3px] outline-red-500 dark:outline-red-400",
  "wrong-role": "outline-[3px] outline-red-500 dark:outline-red-400 opacity-60",
 }[feedback];
 const glowShadow = {
  neutral: "0 4px 12px rgba(0,0,0,0.15)",
  valid: "0 0 10px 2px rgba(16,185,129,0.45), 0 0 20px 4px rgba(16,185,129,0.2)",
  conflict: "0 0 10px 2px rgba(239,68,68,0.5), 0 0 20px 4px rgba(239,68,68,0.25)",
  "wrong-role": "0 0 10px 2px rgba(239,68,68,0.4), 0 0 20px 4px rgba(239,68,68,0.2)",
 }[feedback];
 return (
 <div
 className={cn(
 "flex flex-col items-center justify-center gap-[2px] rounded-[1.2rem] border px-[var(--space-xs)] cursor-grabbing transition-all duration-200 outline outline-offset-0",
 outlineClass,
 color.bg, color.border, color.text,
 )}
 style={{ height: "42px", minWidth: "100px", boxShadow: glowShadow, outlineStyle: "solid" }}
 >
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide leading-tight text-center flex items-center justify-center gap-[2px]">
 {getWorkerTier(worker.id) !== "worker" && <ChefCrown faded={getWorkerTier(worker.id) === "sous-chef"} />}
 {shortName(worker.name)}
 </span>
 {subLabel && (
 <span className="inline-flex items-center px-1.5 py-px rounded-full bg-black/10 dark:bg-white/15 text-[8px] font-medium">{subLabel}</span>
 )}
 </div>
 );
}

// ── Service type selector modal - shown when dropping worker on grid ──
function ServiceTypeModal({
 pending,
 zones,
 onSelect,
 onClose,
}: {
 pending: { worker: User; targetDay: string } | null;
 zones: ZoneDefinition[];
 onSelect: (type: string, customTimes?: { startTime: string; endTime: string }) => void;
 onClose: () => void;
}) {
 const { t } = useTranslation(["schedule"]);
 const [mode, setMode] = useState<"pick" | "custom">("pick");
 const [customStart, setCustomStart] = useState("09:00");
 const [customEnd, setCustomEnd] = useState("23:00");

 // Reset to pick mode when modal opens
 useEffect(() => {
 if (pending) {
 queueMicrotask(() => {
 setMode("pick");
 setCustomStart("09:00");
 setCustomEnd("23:00");
 });
 }
 }, [pending]);

 if (!pending) return null;

 const color = getWorkerColor(pending.worker.id);
 const dayLabel = fmtDateShort(pending.targetDay);
 const workerRole = pending.worker.role as "kitchen" | "floor";

 return (
 <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
 <DialogContent showCloseButton={false} className="sm:max-w-xs">
 <DialogHeader>
 <DialogTitle className="text-[length:var(--text-base)] font-bold tracking-wide">
 <span className={cn("inline-block size-[10px] rounded-full mr-[var(--space-sm)]", color.dot)} />
 {shortName(pending.worker.name)} - {dayLabel}
 </DialogTitle>
 </DialogHeader>

 {mode === "pick" ? (
 <div className="flex flex-col gap-[var(--space-sm)]">
 {zones.map((zd) => {
 const dow = dateToDow(pending.targetDay);
 const times = zoneDefaultTimes(zd, workerRole, dow);
 return (
 <button
 key={zd.label}
 onClick={() => onSelect(zd.label)}
 className="w-full text-left px-[var(--space-md)] py-[var(--space-sm)] rounded-lg border border-border hover:bg-accent/50 transition-colors"
 >
 <span className="text-[length:var(--text-sm)] font-bold tracking-wide">{t("schedule:modals.serviceType.zoneTitle", { zone: zd.label.toUpperCase() })}</span>
 <span className="block text-[length:var(--text-xs)] text-muted-foreground">{times.startTime} - {times.endTime}</span>
 </button>
 );
 })}
 <button
 onClick={() => setMode("custom")}
 className="w-full text-left px-[var(--space-md)] py-[var(--space-sm)] rounded-lg border border-border hover:bg-accent/50 transition-colors"
 >
 <span className="text-[length:var(--text-sm)] font-bold tracking-wide">{t("schedule:modals.serviceType.customTitle")}</span>
 <span className="block text-[length:var(--text-xs)] text-muted-foreground">{t("schedule:modals.serviceType.customSubtitle")}</span>
 </button>
 </div>
 ) : (
 <div className="flex flex-col gap-[var(--space-md)]">
 <div className="flex items-center gap-[var(--space-sm)]">
 <div className="flex-1">
 <label className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground mb-1 block">{t("schedule:modals.serviceType.startLabel")}</label>
 <input
 type="time"
 value={customStart}
 onChange={(e) => setCustomStart(e.target.value)}
 className="w-full rounded-lg border border-border bg-background px-[var(--space-sm)] py-[var(--space-xs)] text-[length:var(--text-sm)] tabular-nums"
 />
 </div>
 <span className="text-muted-foreground mt-5">-</span>
 <div className="flex-1">
 <label className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground mb-1 block">{t("schedule:modals.serviceType.endLabel")}</label>
 <input
 type="time"
 value={customEnd}
 onChange={(e) => setCustomEnd(e.target.value)}
 className="w-full rounded-lg border border-border bg-background px-[var(--space-sm)] py-[var(--space-xs)] text-[length:var(--text-sm)] tabular-nums"
 />
 </div>
 </div>
 <div className="flex gap-[var(--space-sm)]">
 <Button variant="outline" className="flex-1" onClick={() => setMode("pick")}>
 {t("schedule:actions.back")}
 </Button>
 <Button className="flex-1" onClick={() => onSelect("custom", { startTime: customStart, endTime: customEnd })}>
 {t("schedule:actions.confirm")}
 </Button>
 </div>
 </div>
 )}
 </DialogContent>
 </Dialog>
 );
}

// ── Drag action bar - prev week / delete / next week ──
// Prev/next are hover-triggered: hovering with a grabbed card navigates
// the schedule while keeping the drag alive. Only delete is a drop target.
function DragActionBar({ onPrevWeek, onNextWeek }: { onPrevWeek: () => void; onNextWeek: () => void }) {
 const { t } = useTranslation(["schedule"]);
 const { setNodeRef: setPrevNodeRef, isOver: prevIsOver } = useDroppable({ id: "nav-prev-week" });
 const { setNodeRef: setDeleteNodeRef, isOver: deleteIsOver } = useDroppable({ id: "delete-service" });
 const { setNodeRef: setNextNodeRef, isOver: nextIsOver } = useDroppable({ id: "nav-next-week" });

 // Navigate on hover after a short delay - fire once per hover entry
 const prevFired = useRef(false);
 const prevTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
 useEffect(() => {
 if (prevIsOver && !prevFired.current) {
 prevTimer.current = setTimeout(() => { prevFired.current = true; onPrevWeek(); }, 1000);
 }
 if (!prevIsOver) { prevFired.current = false; clearTimeout(prevTimer.current); }
 return () => clearTimeout(prevTimer.current);
 }, [prevIsOver, onPrevWeek]);

 const nextFired = useRef(false);
 const nextTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
 useEffect(() => {
 if (nextIsOver && !nextFired.current) {
 nextTimer.current = setTimeout(() => { nextFired.current = true; onNextWeek(); }, 1000);
 }
 if (!nextIsOver) { nextFired.current = false; clearTimeout(nextTimer.current); }
 return () => clearTimeout(nextTimer.current);
 }, [nextIsOver, onNextWeek]);

 return (
 <div
 className="w-[100vw] relative left-1/2 -translate-x-1/2 h-full flex items-stretch"
 style={{ maskImage: "linear-gradient(to bottom, transparent 0%, black 35%)", WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 35%)" }}
 >
 {/* ← Précédent */}
 <div
 ref={setPrevNodeRef}
 className={cn(
 "flex-1 flex items-center justify-center backdrop-blur-sm transition-all duration-200",
 prevIsOver ? "bg-foreground/10" : "bg-transparent"
 )}
 >
 <div className={cn(
 "flex items-center gap-[var(--space-xs)] px-[var(--space-sm)] py-[6px] rounded-lg border transition-all duration-200",
 prevIsOver
 ? "border-foreground/40 bg-foreground/15 text-foreground scale-105 shadow-sm"
 : "border-foreground/15 bg-foreground/5 text-foreground/40"
 )}>
 <ArrowLeft className="size-[14px] shrink-0" />
 <span className="text-[length:var(--text-2xs)] font-bold uppercase tracking-widest hidden sm:inline">
 {t("schedule:actions.previous")}
 </span>
 </div>
 </div>

 {/* Divider */}
 <div className="w-px bg-foreground/10 my-4" />

 {/* Supprimer */}
 <div
 ref={setDeleteNodeRef}
 className={cn(
 "flex-[2] flex flex-col items-center justify-center gap-[4px] backdrop-blur-sm transition-all duration-200",
 deleteIsOver ? "bg-destructive/10" : "bg-transparent"
 )}
 >
 <div className={cn(
 "flex items-center gap-[var(--space-xs)] px-[var(--space-md)] py-[6px] rounded-lg border transition-all duration-200",
 deleteIsOver
 ? "border-destructive/60 bg-destructive/20 text-destructive scale-105 shadow-sm"
 : "border-foreground/15 bg-foreground/5 text-foreground/40"
 )}>
 <Trash2 className="size-[14px] shrink-0" />
 <span className="text-[length:var(--text-2xs)] font-bold uppercase tracking-widest">
 {deleteIsOver ? t("schedule:drag.release") : t("schedule:drag.delete")}
 </span>
 </div>
 {deleteIsOver && (
 <span className="text-[length:var(--text-2xs)] text-destructive/60 uppercase tracking-widest font-medium">
 {t("schedule:drag.willDelete")}
 </span>
 )}
 </div>

 {/* Divider */}
 <div className="w-px bg-foreground/10 my-4" />

 {/* Suivant → */}
 <div
 ref={setNextNodeRef}
 className={cn(
 "flex-1 flex items-center justify-center backdrop-blur-sm transition-all duration-200",
 nextIsOver ? "bg-foreground/10" : "bg-transparent"
 )}
 >
 <div className={cn(
 "flex items-center gap-[var(--space-xs)] px-[var(--space-sm)] py-[6px] rounded-lg border transition-all duration-200",
 nextIsOver
 ? "border-foreground/40 bg-foreground/15 text-foreground scale-105 shadow-sm"
 : "border-foreground/15 bg-foreground/5 text-foreground/40"
 )}>
 <span className="text-[length:var(--text-2xs)] font-bold uppercase tracking-widest hidden sm:inline">
 {t("schedule:actions.next")}
 </span>
 <ArrowRight className="size-[14px] shrink-0" />
 </div>
 </div>
 </div>
 );
}

// ── Draggable worker chip for legend ──
function DraggableWorkerChip({
 worker,
 isSelected,
 isDimmed,
 draggable,
 onClick,
 hoursLabel,
}: {
 worker: User;
 isSelected: boolean;
 isDimmed: boolean;
 draggable: boolean;
 onClick: () => void;
 hoursLabel?: string;
}) {
 const { t } = useTranslation("schedule");
 const dragRef = useRef(false);
 const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
 id: `worker:${worker.id}`,
 data: { worker },
 disabled: !draggable,
 });

 useEffect(() => {
 if (transform && (Math.abs(transform.x) > 3 || Math.abs(transform.y) > 3)) {
 dragRef.current = true;
 }
 if (!transform && !isDragging) {
 dragRef.current = false;
 }
 }, [transform, isDragging]);

 const color = getWorkerColor(worker.id);

 // Don't apply transform - DragOverlay handles the moving visual
 const style: React.CSSProperties = {
 opacity: isDragging ? 0.3 : 1,
 };

 return (
 <button
 ref={setNodeRef}
 style={style}
 onClick={() => {
 if (!dragRef.current) onClick();
 }}
 className={cn(
 "inline-flex items-center gap-[var(--space-xs)] py-[var(--space-xs)] text-[length:var(--text-xs)] font-bold tracking-wide transition-all duration-200",
 draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
 isSelected
 ? "text-foreground"
 : "text-muted-foreground hover:text-foreground",
 isDimmed && "opacity-40"
 )}
 {...attributes}
 {...listeners}
 >
 <span className={cn("size-[10px] rounded-full shrink-0", color.dot)} />
 {getWorkerTier(worker.id) !== "worker" && <ChefCrown faded={getWorkerTier(worker.id) === "sous-chef"} />}
 {worker.sharedFromRestaurantId && (
 <span title={t("legend.sharedWorker")} className="inline-flex shrink-0">
 <Link2 className="size-3 text-muted-foreground/70" aria-label={t("legend.sharedWorker")} />
 </span>
 )}
 <span>{shortName(worker.name)}</span>
 {hoursLabel && (
 <span className="font-mono tabular-nums text-[length:10px] font-medium tracking-normal text-muted-foreground/80">
 {hoursLabel}
 </span>
 )}
 </button>
 );
}

type GhostSlot = {
 role: "kitchen" | "floor";
 startTime: string;
 endTime: string;
 column: number;
 label?: string;
 zone?: string;
};

// ── Day column with droppable area ──
function DayColumn({
 dateStr,
 services,
 selectedWorkerId,
 onServiceClick,
 onServiceDoubleClick,
 isPast,
 isClosed,
 maxOverlap,
 hourlyWeatherCodes,
 roleFilter,
 ghostSlots,
 startHour,
 endHour,
 serviceSubRoleMap,
 workers,
 daySchedule,
 onChanged,
 forceOpt,
}: {
 dateStr: string;
 services: Array<{ service: ServiceRow; column: number; totalColumns: number; alignRight?: boolean }>;
 selectedWorkerId: string | null;
 onServiceClick: (service: ServiceRow, e: React.MouseEvent) => void;
 onServiceDoubleClick?: (service: ServiceRow, rect: DOMRect) => void;
 isPast: boolean;
 isClosed?: boolean;
 hourlyWeatherCodes?: number[] | null;
 maxOverlap: number;
 roleFilter?: "all" | "kitchen" | "floor" | "missing";
 ghostSlots?: GhostSlot[];
 startHour: number;
 endHour: number;
 serviceSubRoleMap?: Map<string, string>;
 workers: User[];
 daySchedule: ServiceRow[];
 onChanged: () => void | Promise<void>;
 forceOpt?: () => { force?: boolean } | undefined;
}) {
 const { t } = useTranslation(["schedule"]);
 const totalHours = endHour - startHour;
 const { setNodeRef, isOver } = useDroppable({ id: dateStr });
 const isWorkerSelected = (id: string) => selectedWorkerId === id;
 const isWorkerDimmed = (id: string) => selectedWorkerId !== null && selectedWorkerId !== id;

 // Uniform bar width based on max overlap across the week
 const barWidthPct = 100 / maxOverlap;

 // Coupure detection: same worker + same column + same alignment with a time gap
 type VerticalBridge = { key: string; column: number; alignRight: boolean; startH: number; endH: number };
 const bridges: VerticalBridge[] = [];
 const byWorker = new Map<string, typeof services>();
 for (const p of services) {
 const arr = byWorker.get(p.service.workerId) || [];
 arr.push(p);
 byWorker.set(p.service.workerId, arr);
 }
 for (const [workerId, list] of byWorker) {
 if (list.length < 2) continue;
 const sorted = list.slice().sort((a, b) => a.service.startTime.localeCompare(b.service.startTime));
 for (let k = 0; k < sorted.length - 1; k++) {
 const a = sorted[k];
 const b = sorted[k + 1];
 if (a.column !== b.column || !!a.alignRight !== !!b.alignRight) continue;
 let aEnd = (() => { const [h, m] = a.service.endTime.split(":").map(Number); return h + m / 60; })();
 const aStart = (() => { const [h, m] = a.service.startTime.split(":").map(Number); return h + m / 60; })();
 if (aEnd <= aStart) aEnd += 24;
 const bStart = (() => { const [h, m] = b.service.startTime.split(":").map(Number); return h + m / 60; })();
 if (bStart - aEnd <= 0) continue;
 bridges.push({ key: `${workerId}-${k}`, column: a.column, alignRight: !!a.alignRight, startH: aEnd, endH: bStart });
 }
 }

 return (
 <div
 ref={setNodeRef}
 className={cn(
 "border-r-2 border-border relative overflow-hidden",
 isOver && "bg-accent/50",
 isPast && "opacity-40",
 isClosed && "closed-hatch"
 )}
 style={{ height: `${totalHours * HOUR_HEIGHT}px` }}
 >
 {/* Hour grid lines + weather icons */}
 {hourMarks(startHour, endHour).map((hour) => {
 const wCode = hourlyWeatherCodes?.[hour] ?? null;
 const top = (hour - startHour) * HOUR_HEIGHT;
 return (
 <div
 key={hour}
 className="absolute w-full border-b border-border/40 flex items-start justify-end"
 style={{ top: `${top}px`, height: `${HOUR_HEIGHT}px` }}
 >
 {wCode !== null && (
 <span className="pr-[1px] pt-[1px] opacity-40">
 <WeatherIconSvg code={wCode} size={10} />
 </span>
 )}
 </div>
 );
 })}

 {/* Services - constant-width bars (hidden in missing mode) */}
 {roleFilter !== "missing" && services.map(({ service, column, alignRight }) => {
 const pos = servicePosition(service.startTime, service.endTime, startHour, endHour);
 if (!pos) return null;

 const isSelected = isWorkerSelected(service.workerId);
 const isDimmed = isWorkerDimmed(service.workerId);

 const width = `calc(${barWidthPct}% - 2px)`;
 const posStyle: React.CSSProperties = alignRight
 ? { right: `calc(${column * barWidthPct}% + 1px)` }
 : { left: `calc(${column * barWidthPct}% + 1px)` };

 return (
 <div
 key={service.id}
 className="absolute"
 style={{
 top: `${pos.topPx}px`,
 height: `${pos.heightPx}px`,
 width,
 ...posStyle,
 zIndex: isSelected ? 10 : 1,
 }}
 >
 <ServiceCard
 service={service}
 topPx={0}
 heightPx={pos.heightPx}
 selected={isSelected}
 dimmed={isDimmed}
 narrow={barWidthPct < 25}
 assignedSubRole={serviceSubRoleMap?.get(service.id)}
 onClick={(e) => onServiceClick(service, e)}
 onDoubleClick={(e) => {
 if (!onServiceDoubleClick) return;
 const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
 onServiceDoubleClick(service, rect);
 }}
 actionSlot={(
 <ServiceActionsMenu
 service={service}
 workers={workers}
 assignedSubRole={serviceSubRoleMap?.get(service.id)}
 daySchedule={daySchedule}
 onChanged={onChanged}
 forceOpt={forceOpt}
 />
 )}
 />
 </div>
 );
 })}

 {/* Coupure gap — empty dashed span between two services of the same worker */}
 {roleFilter !== "missing" && bridges.map((br) => {
 const topPx = (br.startH - startHour) * HOUR_HEIGHT;
 const heightPx = (br.endH - br.startH) * HOUR_HEIGHT;
 if (heightPx <= 0) return null;
 const posStyle: React.CSSProperties = br.alignRight
 ? { right: `calc(${br.column * barWidthPct}% + 1px)` }
 : { left: `calc(${br.column * barWidthPct}% + 1px)` };
 return (
 <div
 key={`br-${br.key}`}
 className="absolute rounded-md bg-foreground/5 border border-dashed border-foreground/20 pointer-events-none"
 style={{ top: `${topPx}px`, height: `${heightPx}px`, width: `calc(${barWidthPct}% - 2px)`, ...posStyle, zIndex: 0 }}
 />
 );
 })}

 {/* Ghost bars — red pill on red background, borders match ServiceCard (kitchen=left, salle=right) */}
 {ghostSlots?.map((ghost, gi) => {
 const pos = servicePosition(ghost.startTime, ghost.endTime, startHour, endHour);
 if (!pos) return null;
 const isMissing = roleFilter === "missing";
 const isRoleMode = roleFilter === "kitchen" || roleFilter === "floor";
 if (isRoleMode && ghost.role !== roleFilter) return null;

 const isSubtle = !isMissing && !isRoleMode;
 const posStyle: React.CSSProperties = ghost.role === "kitchen"
 ? { left: `calc(${ghost.column * barWidthPct}% + 1px)` }
 : { right: `calc(${ghost.column * barWidthPct}% + 1px)` };
 const label = ghost.label ?? (ghost.role === "kitchen" ? t("schedule:roles.kitchen") : t("schedule:roles.floor"));
 return (
 <div
 key={`ghost-${gi}`}
 className={cn(
 "absolute rounded-xl overflow-hidden flex items-center justify-center",
 ghost.role === "kitchen"
 ? "border-l-[3px] border-t-[3px] border-b-[3px]"
 : "border-r-[3px] border-t-[3px] border-b-[3px]",
 isSubtle
 ? "bg-red-100/60 dark:bg-red-950/60 border-red-300/50 dark:border-red-800/50"
 : "bg-red-100 dark:bg-red-950 border-red-400 dark:border-red-700",
 )}
 style={{
 top: `${pos.topPx}px`,
 height: `${pos.heightPx}px`,
 width: `calc(${barWidthPct}% - 2px)`,
 ...posStyle,
 zIndex: isSubtle ? 0 : 1,
 }}
 title={t("schedule:ghost.tooltip", { label, start: ghost.startTime.slice(0,5), end: ghost.endTime.slice(0,5) })}
 >
 <div className="absolute top-[3px] right-[3px] z-20">
 <GhostActionsMenu
 date={dateStr}
 role={ghost.role}
 startTime={ghost.startTime}
 endTime={ghost.endTime}
 zone={ghost.zone}
 targetSubRole={ghost.label}
 workers={workers}
 daySchedule={daySchedule}
 onChanged={onChanged}
 forceOpt={forceOpt}
 />
 </div>
 <span
 className={cn(
 "inline-flex items-center px-[8px] py-[1px] rounded-full bg-red-500 text-white text-[10px] font-medium leading-none whitespace-nowrap",
 isSubtle && "opacity-70",
 )}
 style={{ writingMode: "vertical-lr", transform: "rotate(180deg)", fontFamily: "Helvetica, Arial, sans-serif" }}
 >
 {label}
 </span>
 </div>
 );
 })}
 </div>
 );
}

// ── Month Calendar (used by both grid-month and stack-month) ──
function getMonthWeeks(year: number, month: number): (Date | null)[][] {
 const daysInMonth = new Date(year, month + 1, 0).getDate();
 const startDow = (new Date(year, month, 1).getDay() + 6) % 7; // 0=Mon
 const weeks: (Date | null)[][] = [];
 let dayNum = 1 - startDow;
 while (dayNum <= daysInMonth) {
 const week: (Date | null)[] = [];
 for (let d = 0; d < 7; d++) {
 week.push(dayNum >= 1 && dayNum <= daysInMonth ? new Date(year, month, dayNum) : null);
 dayNum++;
 }
 weeks.push(week);
 }
 return weeks;
}

function MonthCalendar({
 monthDate,
 services,
 roleFilter,
 selectedWorkerId,
 onServiceClick,
 onDayClick,
 getClosureForDate,
}: {
 monthDate: Date;
 services: ServiceRow[];
 roleFilter: "all" | "kitchen" | "floor" | "missing";
 selectedWorkerId: string | null;
 onServiceClick: (service: ServiceRow) => void;
 onDayClick: (dateStr: string) => void;
 getClosureForDate: (dateStr: string) => RestaurantClosure | null;
}) {
 const year = monthDate.getFullYear();
 const month = monthDate.getMonth();
 const weeks = getMonthWeeks(year, month);
 const today = fmt(new Date());

 const filtered = roleFilter === "all" || roleFilter === "missing"
 ? services
 : services.filter((s) => (s.workerRole || s.role) === roleFilter);

 // Group by date
 const byDate = new Map<string, ServiceRow[]>();
 for (const s of filtered) {
 if (selectedWorkerId && selectedWorkerId !== s.workerId) continue;
 const arr = byDate.get(s.date) || [];
 arr.push(s);
 byDate.set(s.date, arr);
 }

 return (
 <div className="border-y border-border overflow-auto bg-card" style={{ width: "100vw", marginLeft: "calc(50% - 50vw)" }}>
 {/* Day-of-week headers */}
 <div className="grid grid-cols-7">
 {DAYS.map((d) => (
 <div key={d} className="border-b border-r border-border bg-muted p-[var(--space-xs)] text-center text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">
 {d}
 </div>
 ))}
 </div>

 {/* Week rows */}
 {weeks.map((week, wi) => (
 <div key={wi} className="grid grid-cols-7" style={{ minHeight: "90px" }}>
 {week.map((date, di) => {
 if (!date) {
 return <div key={di} className="border-r border-b border-border bg-muted/30" />;
 }
 const dateStr = fmt(date);
 const isToday = dateStr === today;
 const isPast = dateStr < today;
 const closure = getClosureForDate(dateStr);
 const dayServices = (byDate.get(dateStr) || []).sort((a, b) => a.startTime.localeCompare(b.startTime));

 return (
 <div
 key={di}
 className={cn(
 "border-r border-b border-border relative flex flex-col overflow-hidden",
 isPast && "opacity-50",
 closure && "closed-hatch",
 )}
 >
 {/* Day number header - clickable to drill into week */}
 <button
 onClick={() => onDayClick(dateStr)}
 className={cn(
 "shrink-0 w-full flex items-center justify-between px-[var(--space-xs)] py-[1px] text-left hover:bg-accent/30 transition-colors",
 isToday && "bg-foreground text-background",
 )}
 >
 <span className={cn(
 "text-[length:var(--text-xs)] font-bold tabular-nums",
 isToday ? "text-background" : "text-foreground",
 )}>
 {date.getDate()}
 </span>
 {dayServices.length > 0 && (
 <span className={cn(
 "text-[length:var(--text-2xs)] tabular-nums font-medium",
 isToday ? "text-background/60" : "text-muted-foreground",
 )}>
 {dayServices.length}
 </span>
 )}
 </button>

 {/* Service content */}
 <MonthGridCell services={dayServices} onServiceClick={onServiceClick} selectedWorkerId={selectedWorkerId} />
 </div>
 );
 })}
 </div>
 ))}
 </div>
 );
}

/** Grid month cell - compact colored bars for each service */
function MonthGridCell({
 services,
 onServiceClick,
 selectedWorkerId,
}: {
 services: ServiceRow[];
 onServiceClick: (service: ServiceRow) => void;
 selectedWorkerId: string | null;
}) {
 const isWorkerDimmed = (id: string) => selectedWorkerId !== null && selectedWorkerId !== id;
 return (
 <div className="flex-1 flex flex-col gap-[1px] p-[2px] overflow-hidden">
 {services.map((service) => {
 const color = getWorkerColor(service.workerId);
 const isDimmed = isWorkerDimmed(service.workerId);
 return (
 <button
 key={service.id}
 onClick={(e) => { e.stopPropagation(); onServiceClick(service); }}
 className={cn(
 "flex items-center gap-[2px] px-[3px] py-[0.5px] rounded-[2px] text-left transition-opacity hover:opacity-80",
 color.bg,
 isDimmed && "opacity-30",
 )}
 >
 <span className={cn("text-[length:var(--text-xs)] font-bold tracking-wide truncate leading-tight flex items-center gap-[2px]", color.text)}>
 {getWorkerTier(service.workerId) !== "worker" && <span className="shrink-0 text-[length:12px]"><ChefCrown faded={getWorkerTier(service.workerId) === "sous-chef"} /></span>}
 {shortName(service.workerName)}
 </span>
 <span className="text-[length:var(--text-2xs)] tabular-nums text-muted-foreground ml-auto shrink-0">
 {service.startTime.slice(0, 5)}
 </span>
 </button>
 );
 })}
 </div>
 );
}

// ── Layout: stack overlapping services side by side ──
type PositionedService = {
 service: ServiceRow;
 column: number;
 totalColumns: number;
 alignRight?: boolean; // service services align from right edge
};

function layoutServices(dayServices: ServiceRow[], _selectedWorkerId: string | null): PositionedService[] {
 if (dayServices.length === 0) return [];
 return layoutGroup(dayServices);
}

/** Greedy interval coloring: assigns each service to the lowest free column.
 * Kitchen services are assigned first (left columns), then service (reuses freed columns). */
function layoutGroup(allServices: ServiceRow[]): PositionedService[] {
 if (allServices.length === 0) return [];

 function toMin(t: string): number {
 const [h, m] = t.split(":").map(Number);
 return h * 60 + m;
 }
 function serviceEnd(s: ServiceRow): number {
 let end = toMin(s.endTime);
 const start = toMin(s.startTime);
 if (end <= start) end += 24 * 60;
 return end;
 }

 // Separate kitchen (left) and service (right), each sorted by start time
 const kitchen = allServices
 .filter(s => (s.workerRole || s.role) === "kitchen")
 .sort((a, b) => a.startTime.localeCompare(b.startTime) || getWorkerColorIndex(a.workerId) - getWorkerColorIndex(b.workerId));
 const salleList = allServices
 .filter(s => (s.workerRole || s.role) !== "kitchen")
 .sort((a, b) => a.startTime.localeCompare(b.startTime) || getWorkerColorIndex(a.workerId) - getWorkerColorIndex(b.workerId));

 // columns[i] = array of occupied time ranges for column i
 const columns: { start: number; end: number }[][] = [];

 function assignColumn(service: ServiceRow): number {
 const sStart = toMin(service.startTime);
 const sEnd = serviceEnd(service);
 for (let col = 0; col < columns.length; col++) {
 const overlaps = columns[col].some(r => sStart < r.end && sEnd > r.start);
 if (!overlaps) {
 columns[col].push({ start: sStart, end: sEnd });
 return col;
 }
 }
 columns.push([{ start: sStart, end: sEnd }]);
 return columns.length - 1;
 }

 // Kitchen: greedy left-aligned (columns 0, 1, 2...)
 const result: PositionedService[] = [];
 for (const svc of kitchen) {
 result.push({ service: svc, column: assignColumn(svc), totalColumns: 0 });
 }

 // Salle: separate column tracker, right-aligned
 const serviceColumns: { start: number; end: number }[][] = [];
 function assignServiceColumn(service: ServiceRow): number {
 const sStart = toMin(service.startTime);
 const sEnd = serviceEnd(service);
 for (let col = 0; col < serviceColumns.length; col++) {
 const overlaps = serviceColumns[col].some(r => sStart < r.end && sEnd > r.start);
 if (!overlaps) {
 serviceColumns[col].push({ start: sStart, end: sEnd });
 return col;
 }
 }
 serviceColumns.push([{ start: sStart, end: sEnd }]);
 return serviceColumns.length - 1;
 }
 for (const svc of salleList) {
 result.push({ service: svc, column: assignServiceColumn(svc), totalColumns: 0, alignRight: true });
 }

 const totalCols = columns.length + serviceColumns.length;
 for (const r of result) r.totalColumns = totalCols;

 return result;
}

// Masse salariale pill (id:1384) — compact week-total in the toolbar, click
// opens a popover with the per-day breakdown (Mon-Sun). "€" formatted FR.
const EUR_FMT_INT = new Intl.NumberFormat("fr-FR", {
 style: "currency", currency: "EUR", maximumFractionDigits: 0, minimumFractionDigits: 0,
});
const EUR_FMT_DEC = new Intl.NumberFormat("fr-FR", {
 style: "currency", currency: "EUR", maximumFractionDigits: 2, minimumFractionDigits: 2,
});

function LaborCostPill({ laborCost, monday }: { laborCost: LaborCostSummary; monday: Date }) {
 const { t } = useTranslation(["schedule"]);
 const [open, setOpen] = useState(false);
 const btnRef = useRef<HTMLButtonElement | null>(null);
 const popRef = useRef<HTMLDivElement | null>(null);
 // Position the portaled popover under the button (its ancestor uses overflow-x-auto,
 // which clips absolute children — rendering to body bypasses the clip).
 const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

 useEffect(() => {
  if (!open) return;
  const updatePos = () => {
   const r = btnRef.current?.getBoundingClientRect();
   if (!r) return;
   setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  };
  updatePos();
  window.addEventListener("resize", updatePos);
  window.addEventListener("scroll", updatePos, true);
  const onClick = (e: MouseEvent) => {
   if (btnRef.current?.contains(e.target as Node)) return;
   if (popRef.current?.contains(e.target as Node)) return;
   setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
  document.addEventListener("mousedown", onClick);
  document.addEventListener("keydown", onKey);
  return () => {
   window.removeEventListener("resize", updatePos);
   window.removeEventListener("scroll", updatePos, true);
   document.removeEventListener("mousedown", onClick);
   document.removeEventListener("keydown", onKey);
  };
 }, [open]);

 const days: Array<{ label: string; date: string; cost: number }> = [];
 for (let i = 0; i < 7; i++) {
  const d = addDays(monday, i);
  const iso = d.toISOString().split("T")[0];
  days.push({ label: JOURS[d.getDay()] ?? "", date: iso, cost: laborCost.daily[iso] ?? 0 });
 }
 const hasUnpriced = laborCost.unpricedWorkerCount > 0;

 const popover = open ? createPortal(
  <div
   ref={popRef}
   style={{ position: "fixed", top: pos.top, right: pos.right, width: 230, zIndex: 50 }}
   className="rounded border border-foreground/20 bg-background shadow-lg p-[var(--space-md)]"
  >
   <div className="flex items-baseline justify-between mb-[var(--space-sm)]">
    <span className="text-[length:var(--text-2xs)] tracking-widest font-bold text-muted-foreground uppercase">{t("schedule:laborCost.weekHeader")}</span>
    <span className="text-[length:var(--text-base)] font-bold">{EUR_FMT_DEC.format(laborCost.weekly)}</span>
   </div>
   <ul className="space-y-[2px] mb-[var(--space-sm)]">
    {days.map(d => (
     <li key={d.date} className="flex items-center justify-between text-[length:var(--text-xs)]">
      <span className="text-muted-foreground">{d.label}</span>
      <span className={d.cost > 0 ? "" : "text-muted-foreground/50"}>{EUR_FMT_DEC.format(d.cost)}</span>
     </li>
    ))}
   </ul>
   {hasUnpriced && (
    <p className="text-[length:var(--text-2xs)] leading-snug text-amber-700 dark:text-amber-300 border-t border-foreground/10 pt-[var(--space-xs)]">
     {t("schedule:laborCost.unpricedNote", { count: laborCost.unpricedWorkerCount })}
    </p>
   )}
   <p className="text-[length:var(--text-2xs)] leading-snug text-muted-foreground/70 mt-[var(--space-xs)]">
    {t("schedule:laborCost.footnote")}
   </p>
  </div>,
  document.body,
 ) : null;

 return (
  <>
   <button
    ref={btnRef}
    type="button"
    onClick={() => setOpen(v => !v)}
    className="group flex flex-col items-end gap-0 text-right shrink-0 transition-colors cursor-pointer"
    title={t("schedule:laborCost.tooltip")}
   >
    <span className="text-[length:var(--text-2xs)] uppercase tracking-[0.14em] text-muted-foreground group-hover:text-foreground/70">
     {t("schedule:laborCost.title")} <span className="italic normal-case tracking-normal">{t("schedule:laborCost.perWeek")}</span>
    </span>
    <span className="font-mono text-[length:var(--text-base)] md:text-[length:var(--text-lg)] font-bold text-foreground leading-[1.1] group-hover:underline underline-offset-4 decoration-1">
     {EUR_FMT_INT.format(laborCost.weekly)}
     {hasUnpriced && <span className="ml-[2px] text-[length:var(--text-xs)] font-normal text-amber-600 dark:text-amber-400 align-top">*</span>}
    </span>
   </button>
   {popover}
  </>
 );
}
