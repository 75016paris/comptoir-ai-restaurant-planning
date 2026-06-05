import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { loadEmployeeDetail } from "@/lib/employee-detail-loader";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { hasPermission } from "@/lib/permissions";
import { api, type User, type HolidayRequest, type ReplacementRequest } from "@/lib/api";
import { formatPhone } from "@/lib/utils";
import { fmtDateShort } from "@/lib/date-utils";
import { Button } from "@/components/ui/button";
import {
 Table,
 TableBody,
 TableCell,
 TableHead,
 TableHeader,
 TableRow,
} from "@/components/ui/table";
import {
 Select,
 SelectContent,
 SelectItem,
 SelectTrigger,
 SelectValue,
} from "@/components/ui/select";
import { AddEmployeeModal } from "@/components/add-employee-modal";
import { StaffingAnalysisPanel } from "@/components/staffing-analysis";
import { SortableHead } from "@/components/sortable-head";
import { useSort, applySortNum } from "@/components/sortable-head-utils";

function getAvailablePriorities(staff: { priority: number }[]): number[] {
 const max = staff.reduce((m, u) => Math.max(m, u.priority), 1);
 const ceiling = Math.min(max + 1, 10);
 return Array.from({ length: ceiling }, (_, i) => i + 1);
}

const labelClass = "text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground";

/** Check if user is currently in their temp-inactive period */
function isTempInactiveNow(u: User): boolean {
 if (!u.inactiveFrom || !u.inactiveUntil) return false;
 const today = new Date().toISOString().slice(0, 10);
 return today >= u.inactiveFrom && today <= u.inactiveUntil;
}

/** Check if user has a future temp-inactive period */
function hasTempInactive(u: User): boolean {
 return !!(u.inactiveFrom && u.inactiveUntil);
}

// ── Icons ──
function TrashIcon({ className }: { className?: string }) {
 return (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className ?? "w-4 h-4"}>
   <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
  </svg>
 );
}

function ClockIcon({ className }: { className?: string }) {
 return (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className ?? "w-4 h-4"}>
   <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clipRule="evenodd" />
  </svg>
 );
}

function UndoIcon({ className }: { className?: string }) {
 return (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className ?? "w-4 h-4"}>
   <path fillRule="evenodd" d="M7.793 2.232a.75.75 0 01-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 010 10.75H10.75a.75.75 0 010-1.5h2.875a3.875 3.875 0 000-7.75H3.622l4.146 3.957a.75.75 0 01-1.036 1.085l-5.5-5.25a.75.75 0 010-1.085l5.5-5.25a.75.75 0 011.06.025z" clipRule="evenodd" />
  </svg>
 );
}

function XIcon({ className }: { className?: string }) {
 return (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className ?? "w-4 h-4"}>
   <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
  </svg>
 );
}

// ── Temp Deactivation Modal ──
function TempDeactivateModal({ user, onConfirm, onCancel }: {
 user: User;
 onConfirm: (from: string, until: string) => void;
 onCancel: () => void;
}) {
 const { t } = useTranslation(["staff", "common", "roles"]);
 const today = new Date().toISOString().slice(0, 10);
 const [from, setFrom] = useState(today);
 const [until, setUntil] = useState("");

 return (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
   <div className="bg-background border border-border rounded-lg p-[var(--space-lg)] w-full max-w-[360px] space-y-[var(--space-md)]" onClick={e => e.stopPropagation()}>
    <div className="flex items-center justify-between">
     <h3 className="font-bold text-[length:var(--text-base)]">{t("staff:tempAbsenceModal.title")}</h3>
     <button onClick={onCancel} className="text-muted-foreground hover:text-foreground"><XIcon /></button>
    </div>
    <p className="text-[length:var(--text-sm)] text-muted-foreground">
     <Trans
      i18nKey="staff:tempAbsenceModal.description"
      values={{ name: user.name }}
      components={[<span className="font-medium text-foreground" />]}
     />
    </p>
    <div className="grid grid-cols-2 gap-[var(--space-sm)]">
     <div>
      <label className="text-[length:var(--text-xs)] font-medium text-muted-foreground block mb-1">{t("common:fields.from")}</label>
      <input
       type="date"
       value={from}
       min={today}
       onChange={e => setFrom(e.target.value)}
       className="w-full border border-foreground/20 rounded px-2 py-1 text-[length:var(--text-sm)] bg-background"
      />
     </div>
     <div>
      <label className="text-[length:var(--text-xs)] font-medium text-muted-foreground block mb-1">{t("common:fields.until")}</label>
      <input
       type="date"
       value={until}
       min={from || today}
       onChange={e => setUntil(e.target.value)}
       className="w-full border border-foreground/20 rounded px-2 py-1 text-[length:var(--text-sm)] bg-background"
      />
     </div>
    </div>
    <div className="flex justify-end gap-[var(--space-sm)]">
     <Button variant="outline" onClick={onCancel} className="text-[length:var(--text-xs)]">{t("common:actions.cancel")}</Button>
     <Button
      disabled={!from || !until || from > until}
      onClick={() => onConfirm(from, until)}
      className="text-[length:var(--text-xs)]"
     >
      {t("common:actions.confirm")}
     </Button>
    </div>
   </div>
  </div>
 );
}

export function StaffPage() {
 const { t } = useTranslation(["staff", "common", "roles"]);
 const navigate = useNavigate();
 const queryClient = useQueryClient();
 const { user: authUser } = useAuth();
 const isAdmin = authUser?.role === "admin";
 const canTeamEdit = hasPermission(authUser, "TEAM_EDIT");
 const [showAddModal, setShowAddModal] = useState(false);
 const [tempDeactivateTarget, setTempDeactivateTarget] = useState<User | null>(null);

 const usersQuery = useQuery({
  queryKey: qk.employees.list(true),
  queryFn: async () => (await api.listUsers({ includeInactive: true })).data,
 });
 const users: User[] = usersQuery.data ?? [];
 const loading = usersQuery.isPending;

 const holidaysQuery = useQuery({
  queryKey: qk.holidays.list(),
  queryFn: async () => (await api.listHolidays()).data,
 });
 const holidays: HolidayRequest[] = holidaysQuery.data ?? [];

 const replacementsQuery = useQuery({
  queryKey: qk.replacements.pending(),
  queryFn: async () => (await api.pendingReplacements()).data,
 });
 const replacements: ReplacementRequest[] = replacementsQuery.data ?? [];

 const dossierStatusQuery = useQuery({
  queryKey: qk.employees.dossierStatus(),
  queryFn: async () => (await api.getDossierStatus()).data,
 });
 const dossierByWorker = new Map(
  (dossierStatusQuery.data?.workers ?? []).map(w => [w.workerId, w]),
 );

 const preferencesQuery = useQuery({
  queryKey: qk.settings.preferences(),
  queryFn: async () => (await api.getPreferences()).data,
 });
 const availableSubRoles = {
  kitchen: preferencesQuery.data?.kitchenSubRoles ?? [],
  floor: preferencesQuery.data?.floorSubRoles ?? [],
 };

 const setUsers = (updater: (prev: User[]) => User[]) => {
  queryClient.setQueryData<User[]>(qk.employees.list(true), (prev) => updater(prev ?? []));
 };
 const fetchUsers = () => {
  queryClient.invalidateQueries({ queryKey: qk.employees.all() });
 };

 const [addingRole, setAddingRole] = useState<string | null>(null);
 const [editingSubRolesFor, setEditingSubRolesFor] = useState<string | null>(null);
 const addInputRef = useRef<HTMLInputElement>(null);

 async function addSubRole(dept: "kitchen" | "floor", name: string, userId: string) {
  if (!isAdmin) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const key = dept === "kitchen" ? "kitchenSubRoles" : "floorSubRoles";
  const existing = availableSubRoles[dept];
  if (existing.includes(trimmed)) return;
  const updated = [...existing, trimmed];
  queryClient.setQueryData<{ kitchenSubRoles?: string[]; floorSubRoles?: string[] } & Record<string, unknown>>(
   qk.settings.preferences(),
   (prev) => prev ? { ...prev, [key]: updated } : prev,
  );
  const userCurrent = users.find(u => u.id === userId)?.subRoles ?? [];
  const userNext = [...userCurrent, trimmed];
  setUsers(prev => prev.map(u => u.id === userId ? { ...u, subRoles: userNext } : u));
  try {
   await api.updatePreferences({ [key]: updated });
   await api.updateUser(userId, { subRoles: userNext });
  } catch { fetchUsers(); }
  setAddingRole(null);
 }

 const EXCLUSIVE_GROUPS = [["Chef", "Sous-chef"], ["Chef de rang", "Sous-chef de rang"]];
 async function toggleSubRole(userId: string, sr: string, current: string[]) {
  if (!canTeamEdit) return;
  const active = current.includes(sr);
  let next = active ? current.filter(r => r !== sr) : [...current, sr];
  if (!active) {
   for (const group of EXCLUSIVE_GROUPS) {
    if (group.includes(sr)) { next = next.filter(r => r === sr || !group.includes(r)); }
   }
  }
  // Kitchen/floor workers must keep at least one sub-role — API rejects empty.
  const target = users.find(u => u.id === userId);
  if (next.length === 0 && target && (target.role === "kitchen" || target.role === "floor")) return;
  setUsers(prev => prev.map(u => u.id === userId ? { ...u, subRoles: next } : u));
  try { await api.updateUser(userId, { subRoles: next }); } catch { fetchUsers(); }
 }

 async function handleDeactivate(userId: string) {
  if (!isAdmin || !confirm(t("staff:actions.deactivateConfirm"))) return;
  try {
   await api.deleteUser(userId);
   fetchUsers();
  } catch (e) { console.error(e); }
 }

 async function handleReactivate(userId: string) {
  if (!isAdmin) return;
  try {
   await api.reactivateUser(userId);
   fetchUsers();
  } catch (e) { console.error(e); }
 }

 async function handleTempDeactivate(userId: string, from: string, until: string) {
  if (!isAdmin) return;
  try {
   await api.tempDeactivateUser(userId, from, until);
   setUsers(prev => prev.map(u => u.id === userId ? { ...u, inactiveFrom: from, inactiveUntil: until } : u));
  } catch (e) { console.error(e); }
  setTempDeactivateTarget(null);
 }

 async function handleCancelTempDeactivation(userId: string) {
  if (!isAdmin) return;
  try {
   await api.cancelTempDeactivation(userId);
   setUsers(prev => prev.map(u => u.id === userId ? { ...u, inactiveFrom: null, inactiveUntil: null } : u));
  } catch (e) { console.error(e); }
 }

 const today = new Date().toISOString().slice(0, 10);
 type Alert = { label: string; dates?: string; color: string };
 function getWorkerAlerts(userId: string): Alert[] {
  const alerts: Alert[] = [];
  for (const h of holidays) {
   if (h.workerId === userId && h.endDate >= today && (h.status === "pending" || h.status === "approved")) {
    alerts.push({
     label: h.status === "pending" ? t("staff:alerts.holidayPending") : t("staff:alerts.holidayApproved"),
     dates: `${fmtDateShort(h.startDate)} – ${fmtDateShort(h.endDate)}`,
     color: h.status === "pending" ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
    });
   }
  }
  for (const s of replacements) {
   if (s.requesterId === userId) alerts.push({ label: t("staff:alerts.replacementOutgoing"), color: "text-sky-500" });
   else if (s.targetId === userId) alerts.push({ label: t("staff:alerts.replacementIncoming"), color: "text-sky-500" });
  }
  return alerts;
 }

 // Split staff: active (incl temp-inactive) vs permanently deactivated
 const allStaff = users.filter(u => u.role !== "admin");
 const activeStaff = allStaff.filter(u => u.active !== false);
 const deactivatedStaff = allStaff.filter(u => u.active === false);

 type StaffSortCol = "name" | "contract" | "phone" | "priority";
 const { sort: staffSort, toggle: staffToggle } = useSort<StaffSortCol>();

 const contractOrder: Record<string, number> = { CDI: 0, CDD: 1, saisonnier: 2, extra: 3 };
 const defaultSort = (list: User[]) => [...list].sort((a, b) => {
  const ca = contractOrder[a.contractType ?? ""] ?? 4;
  const cb = contractOrder[b.contractType ?? ""] ?? 4;
  if (ca !== cb) return ca - cb;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.name.localeCompare(b.name);
 });

 const sortStaff = (list: User[]) => {
  if (!staffSort.dir) return defaultSort(list);
  return applySortNum(list, staffSort, {
   name: u => u.name,
   contract: u => `${contractOrder[u.contractType ?? ""] ?? 4}_${u.contractHours ?? 0}`,
   phone: u => u.phone ?? "",
   priority: u => u.priority,
  });
 };
 const sortedActive = sortStaff(activeStaff);
 const sortedDeactivated = defaultSort(deactivatedStaff);
 const availPriorities = getAvailablePriorities(activeStaff);

 async function handlePriorityChange(userId: string, priority: number) {
  if (!canTeamEdit) return;
  setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, priority } : u)));
  try { await api.updateUser(userId, { priority }); } catch { fetchUsers(); }
 }

 // Shared row renderer
 function renderStaffRow(u: User, role: "kitchen" | "floor" | "manager", opts: { showActions: boolean; showPriority: boolean }) {
  const alerts = getWorkerAlerts(u.id);
  const tempInactive = isTempInactiveNow(u);
  const hasTempPeriod = hasTempInactive(u);
  const rowOpacity = tempInactive ? "opacity-40" : "";

  return (
   <TableRow
    key={u.id}
    className={`border-foreground/5 ${rowOpacity}`}
    onMouseEnter={() => {
     queryClient.prefetchQuery({
      queryKey: qk.employees.detail(u.id),
      queryFn: () => loadEmployeeDetail(u.id),
      staleTime: 30_000,
     });
    }}
   >
    <TableCell className="font-bold text-[length:var(--text-sm)] py-[var(--space-sm)]">
     <div className="flex items-center gap-[var(--space-sm)]">
      <span
       className="cursor-pointer hover:underline w-fit"
       onClick={() => navigate(`/staff/${u.id}`)}
      >
       {u.name}
      </span>
      {(() => {
       const ds = dossierByWorker.get(u.id);
       if (!ds) return null;
       if (ds.pendingReview > 0) {
        return (
         <span
          className="text-[length:var(--text-2xs)] font-medium text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 px-[var(--space-xs)] py-[1px] rounded-full cursor-pointer"
          title={`${ds.pendingReview} document${ds.pendingReview > 1 ? "s" : ""} en attente de validation`}
          onClick={(e) => { e.stopPropagation(); navigate(`/staff/${u.id}`); }}
         >
          {ds.pendingReview} à valider
         </span>
        );
       }
       if (ds.missingMandatory > 0) {
        return (
         <span
          className="text-[length:var(--text-2xs)] font-medium text-muted-foreground bg-foreground/5 border border-foreground/10 px-[var(--space-xs)] py-[1px] rounded-full"
          title={`${ds.missingMandatory} item${ds.missingMandatory > 1 ? "s" : ""} obligatoire${ds.missingMandatory > 1 ? "s" : ""} manquant${ds.missingMandatory > 1 ? "s" : ""}`}
         >
          dossier incomplet
         </span>
        );
       }
       if (ds.readyForDpae) {
        return (
         <span
          className="text-[length:var(--text-2xs)] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800 px-[var(--space-xs)] py-[1px] rounded-full cursor-pointer"
          title="Dossier complet — DPAE URSSAF exportable depuis la fiche"
          onClick={(e) => { e.stopPropagation(); navigate(`/staff/${u.id}`); }}
         >
          prêt DPAE
         </span>
        );
       }
       return null;
      })()}
      {tempInactive && u.inactiveUntil && (
       <span className="text-[length:var(--text-2xs)] text-muted-foreground font-normal whitespace-nowrap">
        {t("staff:table.tempReturning", { date: fmtDateShort(u.inactiveUntil) })}
       </span>
      )}
      {hasTempPeriod && !tempInactive && u.inactiveFrom && u.inactiveUntil && (
       <span className="text-[length:var(--text-2xs)] text-amber-600 dark:text-amber-400 font-normal whitespace-nowrap">
        {t("staff:table.tempAbsentRange", { from: fmtDateShort(u.inactiveFrom), until: fmtDateShort(u.inactiveUntil) })}
       </span>
      )}
     </div>
     {alerts.length > 0 && (
      <div className="mt-[3px] flex flex-wrap gap-x-[var(--space-sm)] gap-y-[2px]">
       {alerts.map((a, i) => (
        <span key={i}
         className={`text-[length:var(--text-xs)] font-medium cursor-pointer hover:underline ${a.color}`}
         onClick={(e) => { e.stopPropagation(); navigate("/holidays"); }}
        >
         {a.label}{a.dates && <span className="text-muted-foreground font-normal"> · {a.dates}</span>}
        </span>
       ))}
      </div>
     )}
    </TableCell>
    <TableCell className="py-[var(--space-sm)] hidden sm:table-cell">
     <div className="flex flex-wrap gap-1">
      {u.contractType && (
       <span className={`px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border ${
        u.contractType === "CDI" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25" :
        u.contractType === "CDD" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25" :
        u.contractType === "extra" ? "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/25" :
        "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/25"
       }`}>{u.contractType === "saisonnier" ? t("staff:table.contractAbbr.saisonnier") : u.contractType === "extra" ? "Extra" : u.contractType}</span>
      )}
      {u.contractHours != null && (
       <span className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border bg-foreground/5 text-muted-foreground border-foreground/10">{u.contractHours}h</span>
      )}
      {u.contractEndDate && (u.contractType === "CDD" || u.contractType === "saisonnier" || u.contractType === "extra") && (
       <span className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border bg-foreground/5 text-muted-foreground border-foreground/10">→ {u.contractEndDate}</span>
      )}
      {!u.contractType && u.contractHours == null && (
       <span className="text-muted-foreground/40 text-[length:var(--text-xs)]">—</span>
      )}
     </div>
    </TableCell>
    <TableCell className="text-muted-foreground text-[length:var(--text-sm)] py-[var(--space-sm)] font-mono tabular-nums hidden md:table-cell">
     {u.phone ? formatPhone(u.phone) : "—"}
    </TableCell>
    <TableCell className="py-[var(--space-sm)] hidden md:table-cell">
      <div className="flex flex-wrap gap-1 max-w-[360px]">
       {(() => {
        const assigned = u.subRoles ?? [];
        const editable = role !== "manager" && canTeamEdit;
        const available = role === "manager" ? [] : availableSubRoles[role] ?? [];
        const extras = available.filter(sr => !assigned.includes(sr));
        return (
         <>
          {assigned.length > 0 ? assigned.map(sr => (
           <button
            key={sr}
            type="button"
            disabled={!editable}
            onClick={(e) => { e.stopPropagation(); toggleSubRole(u.id, sr, assigned); }}
            className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border bg-foreground text-background border-foreground transition-colors disabled:cursor-default"
           >
            {sr}
           </button>
          )) : (
           <span className="text-muted-foreground/40 text-[length:var(--text-xs)]">—</span>
          )}
          {editable && extras.length > 0 && editingSubRolesFor !== u.id && (
           <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditingSubRolesFor(u.id); }}
            className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border border-dashed border-foreground/15 text-muted-foreground/50 hover:border-foreground/30 hover:text-muted-foreground transition-colors"
           >
            +{extras.length}
           </button>
          )}
          {editable && editingSubRolesFor === u.id && extras.map(sr => (
           <button
            key={sr}
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleSubRole(u.id, sr, assigned); }}
            className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border bg-transparent text-muted-foreground/50 border-foreground/15 hover:border-foreground/30 hover:text-muted-foreground transition-colors"
           >
            + {sr}
           </button>
          ))}
          {editable && editingSubRolesFor === u.id && (
           <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditingSubRolesFor(null); }}
            className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border border-foreground/10 text-muted-foreground/50 hover:text-foreground transition-colors"
           >
            ×
           </button>
          )}
         </>
        );
       })()}
       {isAdmin && (addingRole === u.id ? (
         <input
          ref={addInputRef}
          autoFocus
          type="text"
          placeholder={t("staff:table.subRolePlaceholder")}
          className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border border-foreground/30 bg-transparent w-[80px] outline-none focus:border-foreground/60"
          onKeyDown={(e) => {
           if (e.key === "Enter" && e.currentTarget.value.trim() && role !== "manager") {
            addSubRole(role, e.currentTarget.value, u.id);
           } else if (e.key === "Escape") {
            setAddingRole(null);
           }
          }}
          onBlur={(e) => {
           if (e.currentTarget.value.trim() && role !== "manager") {
            addSubRole(role, e.currentTarget.value, u.id);
           } else {
            setAddingRole(null);
           }
          }}
         />
        ) : (
         <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setAddingRole(u.id); }}
          className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border border-dashed border-foreground/15 text-muted-foreground/40 hover:border-foreground/30 hover:text-muted-foreground transition-colors"
         >
          +
         </button>
        ))}
      </div>
     </TableCell>
    {opts.showPriority && (
     <TableCell className="py-[var(--space-sm)] text-center">
      <Select value={String(u.priority)} onValueChange={(v) => handlePriorityChange(u.id, Number(v))}>
       <SelectTrigger className="relative h-6 min-w-[36px] w-auto text-[length:var(--text-xs)] font-bold border-foreground/20 px-0 mx-auto rounded-full gap-0 [&_[data-slot=select-value]]:absolute [&_[data-slot=select-value]]:inset-0 [&_[data-slot=select-value]]:flex [&_[data-slot=select-value]]:items-center [&_[data-slot=select-value]]:justify-center [&_svg]:absolute [&_svg]:right-[3px] [&_svg]:size-3">
        <SelectValue className="pr-[5px]" />
       </SelectTrigger>
       <SelectContent>
        {availPriorities.map((p) => (
         <SelectItem key={p} value={String(p)} className="text-[length:var(--text-xs)] font-medium">{p}</SelectItem>
        ))}
       </SelectContent>
      </Select>
     </TableCell>
    )}
    {opts.showActions && (
     <TableCell className="py-[var(--space-sm)] text-right">
      <div className="flex items-center justify-end gap-1">
       {hasTempPeriod ? (
        <button
         type="button"
         title={t("staff:actions.cancelTempAbsence")}
         onClick={(e) => { e.stopPropagation(); handleCancelTempDeactivation(u.id); }}
         className="p-1 rounded text-amber-500 hover:bg-amber-500/10 transition-colors"
        >
         <XIcon className="w-3.5 h-3.5" />
        </button>
       ) : (
        <button
         type="button"
         title={t("staff:actions.tempAbsence")}
         onClick={(e) => { e.stopPropagation(); setTempDeactivateTarget(u); }}
         className="p-1 rounded text-muted-foreground/40 hover:text-amber-500 hover:bg-amber-500/10 transition-colors"
        >
         <ClockIcon className="w-3.5 h-3.5" />
        </button>
       )}
       <button
        type="button"
        title={t("staff:actions.deactivate")}
        onClick={(e) => { e.stopPropagation(); handleDeactivate(u.id); }}
        className="p-1 rounded text-muted-foreground/40 hover:text-red-500 hover:bg-red-500/10 transition-colors"
       >
        <TrashIcon className="w-3.5 h-3.5" />
       </button>
      </div>
     </TableCell>
    )}
   </TableRow>
  );
 }

 function renderTableHeaders(opts: { showPriority: boolean; showActions: boolean }) {
  return (
   <TableRow className="border-foreground/10">
    <SortableHead col="name" label={t("staff:table.headers.name")} sort={staffSort} toggle={staffToggle} align="left" />
    <SortableHead col="contract" label={t("staff:table.headers.contract")} sort={staffSort} toggle={staffToggle} align="left" className="w-[120px] hidden sm:table-cell" />
    <SortableHead col="phone" label={t("staff:table.headers.phone")} sort={staffSort} toggle={staffToggle} align="left" className="w-[180px] hidden md:table-cell" />
    <TableHead className="text-[length:var(--text-xs)] tracking-wide font-bold hidden md:table-cell">{t("staff:table.headers.skills")}</TableHead>
    {opts.showPriority && <SortableHead col="priority" label={t("staff:table.headers.priority")} sort={staffSort} toggle={staffToggle} align="left" className="w-[60px] text-center" />}
    {opts.showActions && <TableHead className="text-[length:var(--text-xs)] tracking-wide font-bold w-[70px]" />}
   </TableRow>
  );
 }

 function renderStaffColGroup(opts: { showPriority: boolean; showActions: boolean }) {
  return (
   <colgroup>
    <col />
    <col className="hidden sm:table-column w-[120px]" />
    <col className="hidden md:table-column w-[180px]" />
    <col className="hidden md:table-column w-[330px]" />
    {opts.showPriority && <col className="w-[60px]" />}
    {opts.showActions && <col className="w-[70px]" />}
   </colgroup>
  );
 }

 return (
  <div className="space-y-[var(--space-lg)]">
   <div className="flex items-center justify-between">
    <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em]">{t("staff:page.title")}</h1>
    {isAdmin && (
     <Button onClick={() => setShowAddModal(true)} className="tracking-wide text-[length:var(--text-xs)] font-bold">
      <span className="sm:hidden">{t("staff:page.addButtonShort")}</span>
      <span className="hidden sm:inline">{t("staff:page.addButton")}</span>
     </Button>
    )}
   </div>

   {/* ── Stat cards ── */}
   {(() => {
    const contractBadgeCls: Record<string, string> = {
     CDI: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
     CDD: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
     saisonnier: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
     extra: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
    };
    const roleBreakdown = (role: "kitchen" | "floor" | "manager") => {
     const members = activeStaff.filter(u => u.role === role);
     const byCt: Record<string, number> = {};
     for (const u of members) {
      const ct = u.contractType || "autre";
      byCt[ct] = (byCt[ct] || 0) + 1;
     }
     // Sub-role counts
     const srCounts: Record<string, number> = {};
     for (const u of members) {
      for (const sr of u.subRoles ?? []) {
       srCounts[sr] = (srCounts[sr] || 0) + 1;
      }
     }
     return { members, byCt, srCounts };
    };
    const kitchen = roleBreakdown("kitchen");
    const floor = roleBreakdown("floor");
    const manager = roleBreakdown("manager");
    const renderContractPills = (byCt: Record<string, number>) => {
     const order = ["CDI", "CDD", "saisonnier", "extra", "autre"];
     return order.filter(ct => byCt[ct]).map(ct => (
      <span key={ct} className={`inline-flex items-center gap-[2px] px-[var(--space-xs)] py-[1px] rounded-full text-[length:var(--text-2xs)] font-bold ${contractBadgeCls[ct] || "bg-foreground/5 text-muted-foreground"}`}>
       {byCt[ct]} {ct === "saisonnier" ? t("staff:table.contractAbbr.saisonnier") : ct === "extra" ? "Extra" : ct}
      </span>
     ));
    };
    const renderSubRoles = (srCounts: Record<string, number>) => {
     const entries = Object.entries(srCounts).sort((a, b) => b[1] - a[1]);
     if (entries.length === 0) return null;
     return entries.map(([sr, n]) => (
      <span key={sr} className="inline-flex items-center gap-[2px] px-[var(--space-xs)] py-[1px] rounded-full text-[length:var(--text-2xs)] font-medium border border-foreground/10 bg-foreground/5 text-muted-foreground">
       {n} {sr}
      </span>
     ));
    };
    return (
     <div className={`grid ${manager.members.length > 0 ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2 md:grid-cols-3"} gap-x-[var(--space-lg)] gap-y-[var(--space-sm)] border-b border-border pb-[var(--space-md)]`}>
      {/* Total */}
      <div className="text-center flex flex-col justify-center">
       <p className="text-[length:var(--text-3xl)] font-bold">{activeStaff.length}</p>
       <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("staff:stats.active")}</p>
      </div>
      {/* Manager (shown only when at least one exists) */}
      {manager.members.length > 0 && (
       <div className="space-y-[2px]">
        <div className="flex items-baseline gap-[var(--space-sm)]">
         <span className="text-[length:var(--text-xl)] font-bold">{manager.members.length}</span>
         <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("staff:stats.managerShort")}</span>
        </div>
        <div className="flex flex-wrap gap-[3px]">
         {renderContractPills(manager.byCt)}
        </div>
       </div>
      )}
      {/* Kitchen */}
      <div className="space-y-[2px]">
       <div className="flex items-baseline gap-[var(--space-sm)]">
        <span className="text-[length:var(--text-xl)] font-bold">{kitchen.members.length}</span>
        <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("roles:kitchen")}</span>
       </div>
       <div className="flex flex-wrap gap-[3px]">
        {renderContractPills(kitchen.byCt)}
       </div>
       {Object.keys(kitchen.srCounts).length > 0 && (
        <div className="flex flex-wrap gap-[3px]">
         {renderSubRoles(kitchen.srCounts)}
        </div>
       )}
      </div>
      {/* Floor */}
      <div className="space-y-[2px]">
       <div className="flex items-baseline gap-[var(--space-sm)]">
        <span className="text-[length:var(--text-xl)] font-bold">{floor.members.length}</span>
        <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("roles:floor")}</span>
       </div>
       <div className="flex flex-wrap gap-[3px]">
        {renderContractPills(floor.byCt)}
       </div>
       {Object.keys(floor.srCounts).length > 0 && (
        <div className="flex flex-wrap gap-[3px]">
         {renderSubRoles(floor.srCounts)}
        </div>
       )}
      </div>
     </div>
    );
   })()}

   {/* ── Active team tables by role ── */}
   {loading ? (
    <p className="text-muted-foreground text-[length:var(--text-sm)]">{t("common:status.loading")}</p>
   ) : (
    <div className="space-y-[var(--space-lg)]">
     {(["manager", "kitchen", "floor"] as const).map((role) => {
      const members = sortedActive.filter(u => u.role === role);
      if (members.length === 0) return null;
      const label = t(`roles:${role}`);
      return (
       <div key={role} className="space-y-[var(--space-xs)]">
        <p className={labelClass}>{label} ({members.length})</p>
        <Table className="table-fixed">
         {renderStaffColGroup({ showPriority: canTeamEdit, showActions: isAdmin })}
         <TableHeader>
          {renderTableHeaders({ showPriority: canTeamEdit, showActions: isAdmin })}
         </TableHeader>
         <TableBody>
          {members.map(u => renderStaffRow(u, role, { showActions: isAdmin, showPriority: canTeamEdit }))}
         </TableBody>
        </Table>
       </div>
      );
     })}

     {/* ── Deactivated section ── */}
     {deactivatedStaff.length > 0 && (
      <div className="space-y-[var(--space-xs)] pt-[var(--space-md)] border-t border-border">
       <p className={labelClass}>{t("staff:table.deactivatedSection")} ({deactivatedStaff.length})</p>
       <Table className="table-fixed">
        <colgroup>
         <col />
         <col className="hidden sm:table-column w-[120px]" />
         <col className="hidden md:table-column w-[180px]" />
         <col className="w-[80px]" />
        </colgroup>
        <TableHeader>
         <TableRow className="border-foreground/10">
          <TableHead className="text-[length:var(--text-xs)] tracking-wide font-bold">{t("staff:table.headers.name")}</TableHead>
          <TableHead className="text-[length:var(--text-xs)] tracking-wide font-bold w-[120px] hidden sm:table-cell">{t("staff:table.headers.contract")}</TableHead>
          <TableHead className="text-[length:var(--text-xs)] tracking-wide font-bold w-[180px] hidden md:table-cell">{t("staff:table.headers.phone")}</TableHead>
          <TableHead className="text-[length:var(--text-xs)] tracking-wide font-bold w-[80px]" />
         </TableRow>
        </TableHeader>
        <TableBody>
         {sortedDeactivated.map(u => (
          <TableRow key={u.id} className="border-foreground/5 opacity-50">
           <TableCell className="font-bold text-[length:var(--text-sm)] py-[var(--space-sm)]">
            <span
             className="cursor-pointer hover:underline w-fit"
             onClick={() => navigate(`/staff/${u.id}`)}
            >
             {u.name}
            </span>
           </TableCell>
           <TableCell className="py-[var(--space-sm)] hidden sm:table-cell">
            <div className="flex flex-wrap gap-1">
             {u.contractType && (
              <span className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border bg-foreground/5 text-muted-foreground border-foreground/10">
               {u.contractType === "saisonnier" ? t("staff:table.contractAbbr.saisonnier") : u.contractType === "extra" ? "Extra" : u.contractType}
              </span>
             )}
             {u.contractEndDate && (u.contractType === "CDD" || u.contractType === "saisonnier" || u.contractType === "extra") && (
              <span className="px-1.5 py-0 rounded-full text-[length:var(--text-2xs)] font-medium border bg-foreground/5 text-muted-foreground border-foreground/10">→ {u.contractEndDate}</span>
             )}
            </div>
           </TableCell>
           <TableCell className="text-muted-foreground text-[length:var(--text-sm)] py-[var(--space-sm)] font-mono tabular-nums hidden md:table-cell">
            {u.phone ? formatPhone(u.phone) : "—"}
           </TableCell>
           <TableCell className="py-[var(--space-sm)] text-right">
            {isAdmin && (
             <button
              type="button"
              title={t("staff:actions.reactivate")}
              onClick={(e) => { e.stopPropagation(); handleReactivate(u.id); }}
              className="p-1 rounded text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors"
             >
              <UndoIcon className="w-3.5 h-3.5" />
             </button>
            )}
           </TableCell>
          </TableRow>
         ))}
        </TableBody>
       </Table>
      </div>
     )}
    </div>
   )}

   {/* ── Staffing Analysis ── */}
   <div className="-mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]">
    <StaffingAnalysisPanel />
   </div>

   {isAdmin && (
    <AddEmployeeModal
     open={showAddModal}
     onClose={() => setShowAddModal(false)}
     onSuccess={() => { setShowAddModal(false); fetchUsers(); }}
    />
   )}

   {/* Temp deactivation modal */}
   {isAdmin && tempDeactivateTarget && (
    <TempDeactivateModal
     user={tempDeactivateTarget}
     onConfirm={(from, until) => handleTempDeactivate(tempDeactivateTarget.id, from, until)}
     onCancel={() => setTempDeactivateTarget(null)}
    />
   )}
  </div>
 );
}
