import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import { loadEmployeeDetail } from "@/lib/employee-detail-loader";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type User, type WorkerRestriction, type Document, type DocumentBlob, type HolidayRequest, type ReplacementRequest, type HolidayDocument, type WorkerPreferredDay, type RestrictionRequest, type WorkerChecklist, type ChecklistItem, type RequirementKey, type LatenessRecord, type WorkerShareAuthorization } from "@/lib/api";
import { uploadUserDocumentFile } from "@/lib/document-upload";
import { documentSrc } from "@/lib/document-view";
import { useAuth } from "@/hooks/use-auth";
import { hasPermission } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDateFR, fmtDateYear } from "@/lib/date-utils";
import { ArrowLeft, ArrowRight, Check, ChevronRight, X } from "lucide-react";
import { cn, formatPhone } from "@/lib/utils";
import { HCR_LEVELS, HCR_LEVEL_LABELS, HCR_GRID_2026, highestHcrFromSubRoles, type HcrLevel } from "@comptoir/shared/hcr";
import { LEGAL_LINKS } from "@comptoir/shared/legal";
import { DEFAULT_CONTRACT_HOURS } from "@comptoir/shared";
import { ManagerPermissionsPanel } from "@/components/manager-permissions-panel";

const DAY_LABELS = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];

/** Available priority levels: always current max + 1 across all staff */
function getAvailablePriorities(allUsers: { priority: number; role: string }[]): number[] {
 const staff = allUsers.filter((u) => u.role !== "admin");
 const max = staff.reduce((m, u) => Math.max(m, u.priority), 1);
 const ceiling = Math.min(max + 1, 10);
 return Array.from({ length: ceiling }, (_, i) => i + 1);
}

export function EmployeePage() {
 const { t } = useTranslation("roles");
 const { id: paramId } = useParams<{ id: string }>();
 const { user: authUser } = useAuth();
 const navigate = useNavigate();
 const id = paramId || authUser?.id;
 const activeRestaurantId = authUser?.activeRestaurantId ?? authUser?.restaurantId ?? "";
 const ownerRestaurants = authUser?.restaurants ?? [];
 // Admin viewing an employee via /staff/:id vs worker viewing own profile via /my-profile
 const isAdminView = authUser?.role === "admin" && !!paramId;
 const isSelfView = !paramId || paramId === authUser?.id;

 const [employee, setEmployee] = useState<User | null>(null);
 const [allUsers, setAllUsers] = useState<User[]>([]);
 const [loading, setLoading] = useState(true);
 const [editing, setEditing] = useState(false);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");

 // Editable fields
 const [phone, setPhone] = useState("");
 const [address, setAddress] = useState("");
 const [iban, setIban] = useState("");
 const [startDate, setStartDate] = useState("");
 const [emergencyContact, setEmergencyContact] = useState("");
 const [emergencyPhone, setEmergencyPhone] = useState("");
 const [notes, setNotes] = useState("");

 const [matricule, setMatricule] = useState("");
 const [contractType, setContractType] = useState<"" | "CDI" | "CDD" | "saisonnier" | "extra">("");
 const [contractEndDate, setContractEndDate] = useState<string>("");
 const [contractHours, setContractHours] = useState<string>("");
 const [hcrLevel, setHcrLevel] = useState<HcrLevel | "">("");
 const [hourlyRateEur, setHourlyRateEur] = useState<string>(""); // editable override as euros string ("14.10")
 const [restaurantHcrGrid, setRestaurantHcrGrid] = useState<Partial<Record<HcrLevel, number>>>({});
 const [subroleHcrMap, setSubroleHcrMap] = useState<Record<string, HcrLevel>>({});
 const [availableSubRoles, setAvailableSubRoles] = useState<{ kitchen: string[]; floor: string[] }>({ kitchen: [], floor: [] });
 const [addingSubRole, setAddingSubRole] = useState(false);
 const [showTempDeactivate, setShowTempDeactivate] = useState(false);
 const [tempFrom, setTempFrom] = useState("");
 const [tempUntil, setTempUntil] = useState("");

 async function handleAddSubRole(dept: "kitchen" | "floor", name: string) {
 if (!isAdmin) return;
 const trimmed = name.trim();
 if (!trimmed || !id) { setAddingSubRole(false); return; }
 const key = dept === "kitchen" ? "kitchenSubRoles" : "floorSubRoles";
 const existing = availableSubRoles[dept];
 if (existing.includes(trimmed)) { setAddingSubRole(false); return; }
 const updated = [...existing, trimmed];
 setAvailableSubRoles(prev => ({ ...prev, [dept]: updated }));
 const userCurrent = employee?.subRoles ?? [];
 const userNext = [...userCurrent, trimmed];
 setEmployee(prev => prev ? { ...prev, subRoles: userNext } : prev);
 try {
 await api.updatePreferences({ [key]: updated });
 await api.updateUser(id, { subRoles: userNext });
 } catch { /* reload on error */ }
 setAddingSubRole(false);
 }

 // Availability grid — 7 days, each with midi/soir booleans



 // Restrictions — time-slot based unavailability
 const [restrictions, setRestrictions] = useState<WorkerRestriction[]>([]);
 const [restrDirty, setRestrDirty] = useState(false);
 const [restrSaving, setRestrSaving] = useState(false);
 const [openDays, setOpenDays] = useState<Record<string, "both" | "midi" | "soir">>({ "2": "both", "3": "both", "4": "both", "5": "both", "6": "both", "7": "both" });

 // Documents
 const [documents, setDocuments] = useState<Document[]>([]);
 const [uploading, setUploading] = useState(false);
 const [viewingDoc, setViewingDoc] = useState<DocumentBlob | null>(null);

 // Onboarding checklist
 const [checklist, setChecklist] = useState<WorkerChecklist | null>(null);
 const [uploadingKey, setUploadingKey] = useState<RequirementKey | null>(null);

 // Contract generation
 const [generatingContract, setGeneratingContract] = useState(false);
 type MissingFieldKey = "address" | "hcrLevel" | "hourlyRate" | "contractHours" | "contractEndDate";
 type MissingField = { key: MissingFieldKey; label: string };
 const [contractWarning, setContractWarning] = useState<{ kind: "CDI" | "CDD" | "saisonnier" | "extra"; missing: MissingField[] } | null>(null);
 const [highlightFields, setHighlightFields] = useState<Set<MissingFieldKey>>(new Set());

 const dropHighlight = (key: MissingFieldKey) => {
   if (!highlightFields.has(key)) return;
   setHighlightFields(prev => { const next = new Set(prev); next.delete(key); return next; });
 };
 const highlightClass = (key: MissingFieldKey) =>
   highlightFields.has(key) ? "ring-2 ring-amber-400 ring-offset-1 rounded-sm" : "";

 function missingContractFields(kind: "CDI" | "CDD" | "saisonnier" | "extra"): MissingField[] {
   if (!employee) return [];
   const missing: MissingField[] = [];
   if (!employee.address) missing.push({ key: "address", label: "Adresse postale" });
   if (!employee.hcrLevel) missing.push({ key: "hcrLevel", label: "Niveau HCR" });
   if (!employee.hourlyRate || employee.hourlyRate === 0) missing.push({ key: "hourlyRate", label: "Taux horaire" });
   if (kind === "extra" ? employee.contractHours == null : !employee.contractHours) missing.push({ key: "contractHours", label: "Heures hebdomadaires" });
   if ((kind === "CDD" || kind === "saisonnier") && !employee.contractEndDate) missing.push({ key: "contractEndDate", label: "Date de fin" });
   return missing;
 }

 async function handleGenerateContract(kind: "CDI" | "CDD" | "saisonnier" | "extra", skipCheck = false) {
   if (!id) return;
   if (!skipCheck) {
     const missing = missingContractFields(kind);
     if (missing.length > 0) {
       setContractWarning({ kind, missing });
       return;
     }
   }
   setContractWarning(null);
   setGeneratingContract(true);
   try {
     const res = await api.generateContract(id, { kind, save: true });
     // Open rendered HTML in a new tab for preview / print-to-PDF
     const blob = new Blob([res.data.html], { type: "text/html" });
     const url = URL.createObjectURL(blob);
     window.open(url, "_blank");
     // Refresh documents list since we saved it
     const docsRes = await api.getUserDocuments(id);
     setDocuments(docsRes.data);
   } catch (err) {
     setError(err instanceof Error ? err.message : "Échec de la génération");
   } finally {
     setGeneratingContract(false);
   }
 }

 async function handleUploadSignedContract(e: React.ChangeEvent<HTMLInputElement>) {
   const file = e.target.files?.[0];
   if (!file || !id) return;
   if (file.size > 5 * 1024 * 1024) { setError("Fichier trop volumineux (max 5 Mo)"); return; }
   try {
     const upload = await uploadUserDocumentFile(id, file);
     const today = new Date().toISOString().slice(0, 10);
     await api.uploadUserDocument(id, {
       name: `Contrat signé — ${today}`,
       type: "contract",
       filename: upload.filename,
       mimeType: upload.mimeType,
       size: upload.size,
       storageKey: upload.storageKey,
       signedAt: today,
     });
     const res = await api.getUserDocuments(id);
     setDocuments(res.data);
   } catch (err) {
     setError(err instanceof Error ? err.message : "Échec du téléchargement");
   } finally {
     e.target.value = "";
   }
 }

 async function handleToggleDocSigned(doc: Document) {
   if (!id) return;
   const next = doc.signedAt ? null : new Date().toISOString().slice(0, 10);
   try {
     await api.markDocumentSigned(id, doc.id, next);
     const res = await api.getUserDocuments(id);
     setDocuments(res.data);
   } catch (err) {
     setError(err instanceof Error ? err.message : "Échec de la mise à jour");
   }
 }

 async function handleExportDpae() {
   if (!id) return;
   try {
     const blob = await api.exportDpaeCsv([id]);
     const url = URL.createObjectURL(blob);
     const link = document.createElement("a");
     link.href = url;
     link.download = `dpae-${employee?.name?.replace(/\s+/g, "-").toLowerCase() ?? "employee"}.csv`;
     document.body.appendChild(link);
     link.click();
     document.body.removeChild(link);
     URL.revokeObjectURL(url);
   } catch (err) {
     setError(err instanceof Error ? err.message : "Échec de l'export DPAE");
   }
 }

 async function refreshChecklist() {
  if (!id) return;
  try {
    const res = await api.getUserChecklist(id);
    setChecklist(res.data);
  } catch { /* ignore */ }
 }

 async function handleRequirementUpload(e: React.ChangeEvent<HTMLInputElement>, item: ChecklistItem) {
  const file = e.target.files?.[0];
  if (!file || !id) return;
  if (file.size > 5 * 1024 * 1024) { setError("Fichier trop volumineux (max 5 Mo)"); return; }
  setUploadingKey(item.key);
  setError("");
  try {
    const upload = await uploadUserDocumentFile(id, file);
    const docType =
      item.category === "identity" ? "id" :
      item.category === "medical" ? "medical" :
      item.category === "qualification" ? "certificate" : "other";
    await api.uploadUserDocument(id, {
      name: item.label,
      type: docType,
      filename: upload.filename,
      mimeType: upload.mimeType,
      size: upload.size,
      storageKey: upload.storageKey,
      requirementKey: item.key,
    });
    await Promise.all([
      api.getUserDocuments(id).then(r => setDocuments(r.data)),
      refreshChecklist(),
    ]);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Échec du téléchargement");
  } finally {
    setUploadingKey(null);
    e.target.value = "";
  }
 }

 // Worker preferences
 const [preferred, setPreferred] = useState<WorkerPreferredDay[]>([]);

 // History — holidays & replacements
 const [holidays, setHolidays] = useState<HolidayRequest[]>([]);
 const [replacements, setReplacements] = useState<ReplacementRequest[]>([]);
 const [holidayDocs, setHolidayDocs] = useState<Record<string, HolidayDocument[]>>({});
 const [expandedHoliday, setExpandedHoliday] = useState<string | null>(null);

 // Pending restriction change requests from this worker
 const [restrictionRequests, setRestrictionRequests] = useState<RestrictionRequest[]>([]);

 // Lateness — month-to-date for this worker (records + monthly total)
 const [lateness, setLateness] = useState<LatenessRecord[]>([]);
 const [latenessTotalMin, setLatenessTotalMin] = useState(0);
 const [earlyLeaveTotalMin, setEarlyLeaveTotalMin] = useState(0);
 useEffect(() => {
   if (!id) return;
   const now = new Date();
   const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
   const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
   const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
   api.getLateness(from, to, id).then((res) => {
     setLateness(res.data.records);
     const t = res.data.totals.find((x) => x.userId === id);
     setLatenessTotalMin(t?.totalLateMin ?? 0);
     setEarlyLeaveTotalMin(t?.totalEarlyLeaveMin ?? 0);
   }).catch(() => { /* silent — section just shows empty */ });
 }, [id]);

 const queryClient = useQueryClient();
 const detailQuery = useQuery({
 queryKey: qk.employees.detail(id ?? ""),
 enabled: !!id,
 queryFn: () => loadEmployeeDetail(id!),
 });

 useEffect(() => {
 setLoading(detailQuery.isPending);
 }, [detailQuery.isPending]);

 useEffect(() => {
 const d = detailQuery.data;
 if (!d || !id) return;
 setChecklist(d.checklistRes.data);
 setRestrictionRequests(d.rreqRes.data.filter((r: RestrictionRequest) => r.workerId === id));
 setAvailableSubRoles({
 kitchen: d.prefsRes.data.kitchenSubRoles ?? [],
 floor: d.prefsRes.data.floorSubRoles ?? [],
 });
 setRestaurantHcrGrid((d.prefsRes.data.hcrGrid ?? {}) as Partial<Record<HcrLevel, number>>);
 setSubroleHcrMap((d.prefsRes.data.subroleHcrMap ?? {}) as Record<string, HcrLevel>);
 setRestrictions(d.restrRes.data);
 setDocuments(d.docsRes.data);
 setOpenDays(d.openDaysRes.data);
 setAllUsers(d.usersRes.data);
 setHolidays(d.holidaysRes.data.filter((h) => h.workerId === id));
 setReplacements(d.replacementsRes.data.filter((s) => s.requesterId === id || s.targetId === id));
 const prefMap = new Map(d.prefRes.data.map((dd) => [dd.dayOfWeek, dd]));
 const prefFull: WorkerPreferredDay[] = [];
 for (let day = 1; day <= 7; day++) {
 prefFull.push(prefMap.get(day) || { dayOfWeek: day, midi: false, soir: false });
 }
 setPreferred(prefFull);
 const emp = d.usersRes.data.find((u) => u.id === id);
 if (emp) {
 setEmployee(emp);
 setPhone(emp.phone || "");
 setAddress(emp.address || "");
 setIban(emp.iban || "");
 setStartDate(emp.startDate || "");
 setEmergencyContact(emp.emergencyContact || "");
 setEmergencyPhone(emp.emergencyPhone || "");
 setNotes(emp.notes || "");
 setMatricule(emp.matricule || "");
 setContractType(emp.contractType || "");
 setContractEndDate(emp.contractEndDate || "");
 setContractHours(emp.contractHours ? String(emp.contractHours) : "");
 setHcrLevel((emp.hcrLevel ?? "") as HcrLevel | "");
 setHourlyRateEur(typeof emp.hourlyRate === "number" ? (emp.hourlyRate / 100).toFixed(2) : "");
 }
 }, [detailQuery.data, id]);

 const refetchDetail = () => queryClient.invalidateQueries({ queryKey: qk.employees.all() });

 const isAdmin = authUser?.role === "admin";
 const canEdit = hasPermission(authUser, "TEAM_EDIT");
 const canSeeSensitive = canEdit;
 const canManageWorkerShares =
   isAdminView &&
   canEdit &&
   (authUser?.ownerRole === "owner_admin" || authUser?.ownerRole === "owner_manager") &&
   !!activeRestaurantId &&
   !!employee &&
   (employee.role === "kitchen" || employee.role === "floor");
 const workerAllowsMultiRestaurant = employee?.multiRestaurantWilling !== false;
 const shareTargetRestaurants = ownerRestaurants.filter((restaurant) => restaurant.id !== activeRestaurantId);
 const shareTargetRestaurantIds = shareTargetRestaurants.map((restaurant) => restaurant.id).sort().join("|");
 const workerSharesQuery = useQuery({
   queryKey: qk.workerShares.employeeTargets(id, activeRestaurantId, shareTargetRestaurantIds),
   enabled: canManageWorkerShares && shareTargetRestaurants.length > 0,
   queryFn: async () => {
     const batches = await Promise.all(shareTargetRestaurants.map(async (restaurant) => (await api.listWorkerShares(restaurant.id)).data));
     return batches.flat().filter((share) => share.userId === id && share.sourceRestaurantId === activeRestaurantId);
   },
 });
 const workerSharesByTarget = new Map<string, WorkerShareAuthorization>();
 for (const share of workerSharesQuery.data ?? []) {
   if (share.status !== "revoked") workerSharesByTarget.set(share.targetRestaurantId, share);
 }
 const [workerShareBusyId, setWorkerShareBusyId] = useState<string | null>(null);

 async function handleToggleWorkerShare(targetRestaurantId: string) {
   if (!id || !employee || !activeRestaurantId || !(employee.role === "kitchen" || employee.role === "floor")) return;
   if (!workerAllowsMultiRestaurant) {
     setError("Le salarié doit d'abord autoriser les propositions multi-restaurant depuis son espace personnel.");
     return;
   }
   const current = workerSharesByTarget.get(targetRestaurantId);
   setWorkerShareBusyId(targetRestaurantId);
   setError("");
   try {
     if (current) await api.revokeWorkerShare(current.id);
     else await api.createWorkerShare(targetRestaurantId, {
       sourceRestaurantId: activeRestaurantId,
       userId: id,
       role: employee.role,
     });
     await queryClient.invalidateQueries({ queryKey: qk.workerShares.all() });
   } catch (err) {
     setError(err instanceof Error ? err.message : "Échec de la mise à jour du partage");
   } finally {
     setWorkerShareBusyId(null);
   }
 }

 const handleSave = async () => {
 if (!id) return;
 setSaving(true);
 setError("");
 try {
 await api.updateUser(id, {
 phone: phone || undefined,
 address: address || null,
 iban: iban || null,
 startDate: startDate || null,
 emergencyContact: emergencyContact || null,
 emergencyPhone: emergencyPhone || null,
 notes: notes || null,
 ...(canEdit ? {
 matricule: matricule || null,
 contractType: contractType || null,
 contractEndDate: (contractType === "CDD" || contractType === "saisonnier" || contractType === "extra") ? (contractEndDate || null) : null,
 contractHours: contractHours ? parseInt(contractHours, 10) : null,
 hcrLevel: hcrLevel || null,
 hourlyRate: hourlyRateEur ? Math.round(parseFloat(hourlyRateEur) * 100) : null,
 } : {}),
 });
 setEditing(false);
 refetchDetail();
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec de l'enregistrement");
 } finally {
 setSaving(false);
 }
 };

 async function handleDeactivate() {
  if (!id || !confirm("Désactiver cet employé ? Il sera retiré de la liste active et du staffing automatique.")) return;
  try {
   await api.deleteUser(id);
   navigate("/staff");
  } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
 }

 async function handleReactivate() {
  if (!id) return;
  try {
   await api.reactivateUser(id);
   setEmployee(prev => prev ? { ...prev, active: true } : prev);
  } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
 }

 async function handleTempDeactivate() {
  if (!id || !tempFrom || !tempUntil || tempFrom > tempUntil) return;
  try {
   await api.tempDeactivateUser(id, tempFrom, tempUntil);
   setEmployee(prev => prev ? { ...prev, inactiveFrom: tempFrom, inactiveUntil: tempUntil } : prev);
   setShowTempDeactivate(false);
  } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
 }

 async function handleCancelTempDeactivation() {
  if (!id) return;
  try {
   await api.cancelTempDeactivation(id);
   setEmployee(prev => prev ? { ...prev, inactiveFrom: null, inactiveUntil: null } : prev);
  } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
 }

 async function handlePriorityChange(priority: number) {
 if (!id || !employee) return;
 setEmployee({ ...employee, priority });
 setAllUsers((prev) => prev.map((u) => (u.id === id ? { ...u, priority } : u)));
 try {
 await api.updateUser(id, { priority });
 } catch {
 refetchDetail();
 }
 }



 async function handleSaveRestrictions() {
 if (!id) return;
 setRestrSaving(true);
 try {
 await api.updateRestrictions(id, restrictions);
 setRestrDirty(false);
 } catch (err) {
 console.error(err);
 } finally {
 setRestrSaving(false);
 }
 }

 async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
 const file = e.target.files?.[0];
 if (!file || !id) return;
 if (file.size > 5 * 1024 * 1024) {
 setError("Fichier trop volumineux (max 5 Mo)");
 return;
 }
 setUploading(true);
 setError("");
 try {
 const upload = await uploadUserDocumentFile(id, file);
 const ext = file.name.toLowerCase();
 const docType = ext.includes("contract") ? "contract"
 : ext.includes("certificate") || ext.includes("diplom") ? "certificate"
 : ext.includes("id") || ext.includes("passport") || ext.includes("carte") ? "id"
 : ext.includes("medical") || ext.includes("doctor") || ext.includes("arret") ? "medical"
 : "other";
 await api.uploadUserDocument(id, {
 name: file.name.replace(/\.[^.]+$/, ""),
 type: docType,
 filename: upload.filename,
 mimeType: upload.mimeType,
 size: upload.size,
 storageKey: upload.storageKey,
 });
 const res = await api.getUserDocuments(id);
 setDocuments(res.data);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec du téléchargement");
 } finally {
 setUploading(false);
 e.target.value = "";
 }
 }

 async function handleViewDoc(doc: Document) {
 if (!id) return;
 try {
 const res = await api.getUserDocument(id, doc.id);
 setViewingDoc(res.data);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec du chargement du document");
 }
 }

 async function handleDeleteDoc(docId: string) {
 if (!id) return;
 try {
 await api.deleteUserDocument(id, docId);
 setDocuments((prev) => prev.filter((d) => d.id !== docId));
 if (viewingDoc?.id === docId) setViewingDoc(null);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec de la suppression");
 }
 }

 async function handleConfirmDoc(docId: string) {
 if (!id) return;
 try {
 const res = await api.confirmUserDocument(id, docId);
 setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, reviewedAt: res.data.reviewedAt, reviewedBy: res.data.reviewedBy } : d));
 if (refreshChecklist) refreshChecklist();
 queryClient.invalidateQueries({ queryKey: qk.employees.dossierStatus() });
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec de la validation");
 }
 }

 function formatFileSize(bytes: number): string {
 if (bytes < 1024) return `${bytes}B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
 return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
 }

 async function toggleHolidayDocs(holidayId: string) {
 if (expandedHoliday === holidayId) {
 setExpandedHoliday(null);
 return;
 }
 setExpandedHoliday(holidayId);
 if (!holidayDocs[holidayId]) {
 try {
 const res = await api.getHolidayDocuments(holidayId);
 setHolidayDocs((prev) => ({ ...prev, [holidayId]: res.data }));
 } catch {
 setHolidayDocs((prev) => ({ ...prev, [holidayId]: [] }));
 }
 }
 }

 async function viewHolidayDoc(holidayId: string, doc: HolidayDocument) {
 try {
 const res = await api.getHolidayDocument(holidayId, doc.id);
 setViewingDoc(res.data as unknown as DocumentBlob);
 } catch {
 setError("Échec du chargement du document");
 }
 }

 function getUserName(userId: string): string {
 return allUsers.find((u) => u.id === userId)?.name || "Inconnu";
 }

 const STATUS_STYLE: Record<string, string> = {
 pending: "text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700",
 approved: "text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700",
 rejected: "text-red-600 dark:text-red-400 border-red-300 dark:border-red-700",
 accepted: "text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700",
 expired: "text-muted-foreground border-foreground/15",
 cancelled: "text-muted-foreground border-foreground/15",
 };

 const STATUS_LABEL: Record<string, string> = {
 pending: "En attente",
 awaiting_admin_decision: "Attente gérant",
 awaiting_worker_reply: "Proposé",
 approved: "Approuvé",
 rejected: "Refusé",
 accepted: "Accepté",
 expired: "Expiré",
 cancelled: "Annulé",
 };

 const DOC_TYPE_LABELS: Record<string, string> = {
 id: "ID",
 contract: "CONTRACT",
 certificate: "CERTIFICATE",
 medical: "MEDICAL",
 other: "OTHER",
 };

 if (loading) return <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">Chargement...</p>;
 if (!employee) return <p className="text-destructive font-bold ">Employé introuvable</p>;

 const inputClass = "border-foreground/20 bg-transparent text-[length:var(--text-sm)]";
 const labelClass = "text-[length:var(--text-xs)] tracking-wide font-semibold text-muted-foreground";
 const sectionClass = "border-b border-foreground/20 pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]";

 return (
 <div className="space-y-[var(--space-xl)]" style={{ maxWidth: "610px" }}>
 <div className="flex flex-wrap items-center justify-between gap-[var(--space-sm)] sticky top-[40px] md:top-[46px] z-30 bg-background py-[var(--space-sm)] -mt-[var(--space-sm)]">
 <div className="flex flex-wrap items-center gap-[var(--space-sm)] md:gap-[var(--space-md)]">
 {isAdmin && (
 <Link to="/staff" className="text-muted-foreground hover:text-foreground text-[length:var(--text-xs)] tracking-wide font-medium">
 <ArrowLeft className="size-3" /> Équipe
 </Link>
 )}
 {isAdmin && (() => {
 const staff = allUsers.filter(u => u.role !== "admin").sort((a, b) => {
 if (a.role !== b.role) return a.role === "kitchen" ? -1 : 1;
 return (a.priority ?? 99) - (b.priority ?? 99);
 });
 const idx = staff.findIndex(u => u.id === id);
 const prev = idx > 0 ? staff[idx - 1] : null;
 const next = idx < staff.length - 1 ? staff[idx + 1] : null;
 return (
 <div className="flex items-center gap-[2px]">
 <button
 disabled={!prev}
 onClick={() => prev && navigate(`/staff/${prev.id}`)}
 className="p-[var(--space-xs)] rounded-[0.2rem] border border-foreground/15 hover:border-foreground/40 disabled:opacity-20 disabled:cursor-default transition-colors"
 title={prev?.name}
 >
 <ArrowLeft className="size-3" />
 </button>
 <button
 disabled={!next}
 onClick={() => next && navigate(`/staff/${next.id}`)}
 className="p-[var(--space-xs)] rounded-[0.2rem] border border-foreground/15 hover:border-foreground/40 disabled:opacity-20 disabled:cursor-default transition-colors"
 title={next?.name}
 >
 <ArrowRight className="size-3" />
 </button>
 </div>
 );
 })()}
 <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em]">{employee.name}</h1>
 <span className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground border border-border px-[var(--space-sm)] py-[var(--space-xs)]">
 {t(employee.role, { defaultValue: employee.role })}
 </span>
 </div>
 {canEdit && !editing && (
 <Button variant="outline" onClick={() => setEditing(true)} className="tracking-wide text-[length:var(--text-xs)] font-bold">
 Modifier
 </Button>
 )}
 {canEdit && editing && (
 <div className="flex gap-[var(--space-sm)]">
 <Button onClick={handleSave} disabled={saving} className="tracking-wide text-[length:var(--text-xs)] font-bold">
 {saving ? "..." : "Enregistrer"}
 </Button>
 <Button variant="outline" onClick={() => setEditing(false)} className="tracking-wide text-[length:var(--text-xs)] font-bold">
 Annuler
 </Button>
 </div>
 )}
 </div>

 {error && <p className="text-[length:var(--text-sm)] text-destructive font-bold">{error}</p>}

 {/* Status banners */}
 {employee.active === false && (
  <div className="flex items-center justify-between bg-red-500/10 border border-red-500/25 rounded px-[var(--space-md)] py-[var(--space-sm)]">
   <span className="text-[length:var(--text-sm)] font-medium text-red-700 dark:text-red-400">Employé désactivé</span>
   {isAdmin && (
    <Button variant="outline" size="sm" onClick={handleReactivate} className="text-[length:var(--text-xs)] font-bold">
     Réactiver
    </Button>
   )}
  </div>
 )}
 {employee.active !== false && employee.inactiveFrom && employee.inactiveUntil && (() => {
  const today = new Date().toISOString().slice(0, 10);
  const isCurrent = today >= employee.inactiveFrom! && today <= employee.inactiveUntil!;
  return (
   <div className="flex items-center justify-between bg-amber-500/10 border border-amber-500/25 rounded px-[var(--space-md)] py-[var(--space-sm)]">
    <span className="text-[length:var(--text-sm)] font-medium text-amber-700 dark:text-amber-400">
     {isCurrent ? "Absent temporairement" : "Absence prévue"} — {fmtDateFR(employee.inactiveFrom!)} au {fmtDateFR(employee.inactiveUntil!)}
    </span>
    {isAdmin && (
     <Button variant="outline" size="sm" onClick={handleCancelTempDeactivation} className="text-[length:var(--text-xs)] font-bold">
      Annuler
     </Button>
    )}
   </div>
  );
 })()}

 {/* Admin action buttons */}
 {isAdmin && employee.role !== "admin" && employee.active !== false && (
  <div className="flex gap-[var(--space-sm)]">
   {!employee.inactiveFrom && (
    <Button variant="outline" size="sm" onClick={() => { setTempFrom(new Date().toISOString().slice(0, 10)); setTempUntil(""); setShowTempDeactivate(true); }} className="text-[length:var(--text-xs)] font-bold text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/10">
     Absence temporaire
    </Button>
   )}
   <Button variant="outline" size="sm" onClick={handleDeactivate} className="text-[length:var(--text-xs)] font-bold text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/10">
    Désactiver
   </Button>
  </div>
 )}

 {/* Temp deactivation form */}
 {showTempDeactivate && (
  <div className="bg-amber-500/5 border border-amber-500/20 rounded p-[var(--space-md)] space-y-[var(--space-sm)]">
   <p className="text-[length:var(--text-sm)] font-medium">Période d'absence</p>
   <div className="flex gap-[var(--space-sm)] items-end">
    <div>
     <label className="text-[length:var(--text-xs)] text-muted-foreground block mb-1">Du</label>
     <input type="date" value={tempFrom} onChange={e => setTempFrom(e.target.value)} className="border border-foreground/20 rounded px-2 py-1 text-[length:var(--text-sm)] bg-background" />
    </div>
    <div>
     <label className="text-[length:var(--text-xs)] text-muted-foreground block mb-1">Au</label>
     <input type="date" value={tempUntil} min={tempFrom} onChange={e => setTempUntil(e.target.value)} className="border border-foreground/20 rounded px-2 py-1 text-[length:var(--text-sm)] bg-background" />
    </div>
    <Button size="sm" disabled={!tempFrom || !tempUntil || tempFrom > tempUntil} onClick={handleTempDeactivate} className="text-[length:var(--text-xs)] font-bold">
     Confirmer
    </Button>
    <Button variant="outline" size="sm" onClick={() => setShowTempDeactivate(false)} className="text-[length:var(--text-xs)] font-bold">
     Annuler
    </Button>
   </div>
  </div>
 )}

 {/* Priority */}
 {canEdit && employee.role !== "admin" && (
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-lg)]">Priorité</p>
 <Select value={String(employee.priority)} onValueChange={(v) => handlePriorityChange(Number(v))}>
   <SelectTrigger className="relative h-6 min-w-[36px] w-auto text-[length:var(--text-xs)] font-bold border-foreground/20 px-0 rounded-full gap-0 [&_[data-slot=select-value]]:absolute [&_[data-slot=select-value]]:inset-0 [&_[data-slot=select-value]]:flex [&_[data-slot=select-value]]:items-center [&_[data-slot=select-value]]:justify-center [&_svg]:absolute [&_svg]:right-[3px] [&_svg]:size-3">
     <SelectValue className="pr-[5px]" />
   </SelectTrigger>
   <SelectContent>
     {getAvailablePriorities(allUsers).map((p) => (
       <SelectItem key={p} value={String(p)} className="text-[length:var(--text-xs)] font-medium">{p}</SelectItem>
     ))}
   </SelectContent>
 </Select>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-sm)]">
 1 = premier à être planifié. Les employés de priorité supérieure comblent les créneaux restants.
 </p>
 </div>
 )}

 {/* Contact */}
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-lg)]">Contact</p>
 <div className="space-y-[var(--space-lg)]">
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-lg)]">
 <div>
 <Label className={labelClass}>E-mail</Label>
 <p className="text-[length:var(--text-sm)] font-medium mt-[var(--space-xs)]">{employee.email}</p>
 </div>
 <div>
 <Label className={labelClass}>Téléphone</Label>
 {editing ? (
 <Input value={phone} onChange={(e) => setPhone(e.target.value)} className={`mt-[var(--space-xs)] ${inputClass}`} />
 ) : (
 <p className="text-[length:var(--text-sm)] font-medium mt-[var(--space-xs)]">{employee.phone ? formatPhone(employee.phone) : "—"}</p>
 )}
 </div>
 </div>
 {(canSeeSensitive || editing) && (
 <div>
 <Label className={labelClass}>Adresse</Label>
 {editing ? (
 <Input id="field-address" value={address} onChange={(e) => { setAddress(e.target.value); dropHighlight("address"); }} placeholder="123 Rue de Paris..." className={`mt-[var(--space-xs)] ${inputClass} ${highlightClass("address")}`} />
 ) : (
 <p className="text-[length:var(--text-sm)] font-medium mt-[var(--space-xs)]">{employee.address || "—"}</p>
 )}
 </div>
 )}
 </div>
 </div>

 {/* Employment */}
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-lg)]">Emploi</p>
 <div className="space-y-[var(--space-lg)]">
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-lg)]">
 <div>
 <Label className={labelClass}>Rôle</Label>
 <p className="text-[length:var(--text-sm)] font-bold mt-[var(--space-xs)]">{t(employee.role, { defaultValue: employee.role })}</p>
 </div>
 <div>
 <Label className={labelClass}>Date d'embauche</Label>
 {editing ? (
 <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`mt-[var(--space-xs)] ${inputClass}`} />
 ) : (
 <p className="text-[length:var(--text-sm)] font-medium mt-[var(--space-xs)]">{employee.startDate ? fmtDateYear(employee.startDate) : "—"}</p>
 )}
 </div>
 {isAdmin && (
 <div>
 <Label className={labelClass}>Matricule (Silae)</Label>
 {editing ? (
 <Input value={matricule} onChange={(e) => setMatricule(e.target.value)} placeholder="EX: SAL001" className={`mt-[var(--space-xs)] ${inputClass}`} />
 ) : (
 <p className="text-[length:var(--text-sm)] font-mono font-medium mt-[var(--space-xs)]">{employee.matricule || <span className="text-muted-foreground/40">—</span>}</p>
 )}
 </div>
 )}
 <div>
 <Label className={labelClass}>
 Contrat <a href={LEGAL_LINKS.cdi.url} target="_blank" rel="noopener noreferrer" className="text-[length:var(--text-2xs)] font-normal text-muted-foreground underline decoration-dotted underline-offset-2">↗</a>
 </Label>
 {editing ? (
 <select
 value={contractType}
 onChange={(e) => setContractType(e.target.value as "" | "CDI" | "CDD" | "saisonnier" | "extra")}
 className={`mt-[var(--space-xs)] w-full h-9 rounded-[0.2rem] px-[var(--space-sm)] ${inputClass}`}
 >
 <option value="">—</option>
 <option value="CDI">CDI</option>
 <option value="CDD">CDD</option>
 <option value="saisonnier">Saisonnier</option>
 <option value="extra">Extra / CDD d'usage</option>
 </select>
 ) : (
 <p className="text-[length:var(--text-sm)] font-bold mt-[var(--space-xs)]">{employee.contractType || <span className="text-muted-foreground/40">—</span>}</p>
 )}
 </div>
 {(editing ? (contractType === "CDD" || contractType === "saisonnier" || contractType === "extra") : (employee.contractType === "CDD" || employee.contractType === "saisonnier" || employee.contractType === "extra")) && (
 <div>
 <Label className={labelClass}>{contractType === "extra" ? "Mission / fin si connue" : "Fin de contrat"}</Label>
 {editing ? (
 <>
 {contractType !== "extra" && (
 <div className="flex flex-wrap gap-1 mt-[var(--space-xs)]">
 {[
 { label: "1 mois", months: 1 },
 { label: "3 mois", months: 3 },
 { label: "6 mois", months: 6 },
 { label: "1 an", months: 12 },
 ].map(({ label, months }) => {
 const base = startDate || employee.startDate || new Date().toISOString().slice(0, 10);
 const d = new Date(base + "T00:00:00");
 d.setMonth(d.getMonth() + months);
 const target = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
 const active = contractEndDate === target;
 return (
 <button key={months} type="button" onClick={() => setContractEndDate(target)}
 className={cn(
 "px-1.5 py-0.5 rounded-full text-[length:var(--text-2xs)] font-medium border transition-colors",
 active
 ? "bg-foreground text-background border-foreground"
 : "bg-transparent text-muted-foreground border-foreground/15 hover:border-foreground/30"
 )}>{label}</button>
 );
 })}
 </div>
 )}
 <Input
 id="field-contractEndDate"
 type="date"
 value={contractEndDate}
 onChange={(e) => { setContractEndDate(e.target.value); dropHighlight("contractEndDate"); }}
 className={`mt-[var(--space-xs)] ${inputClass} ${highlightClass("contractEndDate")}`}
 />
 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[2px] leading-snug">
 {contractType === "CDD" ? (
 <>CDD <strong>renouvelable 2 fois</strong> (max 18 mois). <a href={LEGAL_LINKS.cddRenewal.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">art. L1243-13-1 ↗</a></>
 ) : contractType === "extra" ? (
 <>Extra / CDD d'usage — <strong>mission ponctuelle</strong>, sans heures garanties ; date optionnelle si non connue. <a href={LEGAL_LINKS.cddUsage.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">règles ↗</a> · <a href={LEGAL_LINKS.cddModel.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">modèle CDD officiel ↗</a></>
 ) : (
 <>Saisonnier — <strong>clause de reconduction</strong> possible. <a href={LEGAL_LINKS.cddSaisonnier.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">art. L1242-2 3° ↗</a></>
 )}
 </p>
 </>
 ) : (
 <p className="text-[length:var(--text-sm)] font-bold mt-[var(--space-xs)]">{employee.contractEndDate || <span className="text-muted-foreground/40">—</span>}</p>
 )}
 </div>
 )}
 <div>
 <Label className={labelClass}>Heures / semaine</Label>
 {editing ? (
 <Input
 id="field-contractHours"
 type="number"
 min={contractType === "extra" ? 0 : 1}
 max={48}
 value={contractHours}
 onChange={(e) => { setContractHours(e.target.value); dropHighlight("contractHours"); }}
 placeholder={String(DEFAULT_CONTRACT_HOURS)}
 className={`mt-[var(--space-xs)] ${inputClass} ${highlightClass("contractHours")}`}
 />
 ) : (
 <p className="text-[length:var(--text-sm)] font-bold mt-[var(--space-xs)]">{employee.contractHours != null ? `${employee.contractHours}h` : <span className="text-muted-foreground/40">—</span>}</p>
 )}
 </div>
 </div>
 {canSeeSensitive && (
 <div>
 <Label className={labelClass}>IBAN</Label>
 {editing ? (
 <Input value={iban} onChange={(e) => setIban(e.target.value)} placeholder="FR76 3000 6000..." className={`mt-[var(--space-xs)] ${inputClass}`} />
 ) : (
 <p className="text-[length:var(--text-sm)] font-medium font-mono mt-[var(--space-xs)]">{employee.iban || "—"}</p>
 )}
 </div>
 )}

 {/* Niveau HCR + Taux horaire brut */}
 {canEdit && employee.role !== "admin" && (() => {
   const subRoles = employee.subRoles ?? [];
   // Highest niveau across the employee's sub-roles — recomputed on every render so toggling badges updates live.
   const mappedFromSubrole = highestHcrFromSubRoles(subRoles, subroleHcrMap);
   const effectiveLevel: HcrLevel | null = (hcrLevel as HcrLevel) || mappedFromSubrole;
   // Grid values are stored in cents; convert to euros for display + comparison.
   const effectiveGrid: Record<HcrLevel, number> = { ...HCR_GRID_2026, ...restaurantHcrGrid } as Record<HcrLevel, number>;
   const gridRateEur = effectiveLevel ? effectiveGrid[effectiveLevel] / 100 : null;
   const displayRate = hourlyRateEur ? parseFloat(hourlyRateEur) : gridRateEur;
   const isOverride = !!hourlyRateEur && gridRateEur !== null && Math.abs(parseFloat(hourlyRateEur) - gridRateEur) > 0.005;
   return (
     <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-md)]">
       <div>
         <Label className={labelClass}>
           Niveau HCR <a href={LEGAL_LINKS.hcrConvention.url} target="_blank" rel="noopener noreferrer" className="text-[length:var(--text-2xs)] font-normal text-muted-foreground underline decoration-dotted underline-offset-2">(IDCC 1979 ↗)</a>
         </Label>
         {editing ? (
           <>
             <select
               id="field-hcrLevel"
               value={hcrLevel}
               onChange={(e) => { setHcrLevel(e.target.value as HcrLevel | ""); dropHighlight("hcrLevel"); }}
               className={`mt-[var(--space-xs)] w-full bg-transparent border-b border-foreground/20 text-[length:var(--text-sm)] outline-none focus:border-foreground py-[4px] ${highlightClass("hcrLevel")}`}
             >
               <option value="">{mappedFromSubrole ? `Auto (${mappedFromSubrole})` : "—"}</option>
               {HCR_LEVELS.map((lvl) => (
                 <option key={lvl} value={lvl}>{lvl} · {HCR_LEVEL_LABELS[lvl].split(" — ")[1] ?? lvl}</option>
               ))}
             </select>
             {!hcrLevel && mappedFromSubrole && (
               <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[2px]">Auto-attribué depuis le sous-rôle</p>
             )}
           </>
         ) : (
           <p className="text-[length:var(--text-sm)] font-bold mt-[var(--space-xs)]">
             {effectiveLevel ? (
               <>
                 {effectiveLevel} <span className="text-muted-foreground font-normal">· {HCR_LEVEL_LABELS[effectiveLevel]?.split(" — ")[1] ?? ""}</span>
                 {!employee.hcrLevel && mappedFromSubrole && <span className="ml-1 text-[length:var(--text-xs)] font-normal text-muted-foreground">(auto)</span>}
               </>
             ) : <span className="text-muted-foreground/40">—</span>}
           </p>
         )}
       </div>
       <div>
         <Label className={labelClass}>
           Taux horaire brut <a href={LEGAL_LINKS.hcrSalaryGrid.url} target="_blank" rel="noopener noreferrer" className="text-[length:var(--text-2xs)] font-normal text-muted-foreground underline decoration-dotted underline-offset-2">(grille ↗)</a>
         </Label>
         {editing ? (
           <div className="mt-[var(--space-xs)] flex items-center gap-[var(--space-xs)]">
             <Input
               id="field-hourlyRate"
               type="number"
               step="0.01"
               min={0}
               value={hourlyRateEur}
               onChange={(e) => { setHourlyRateEur(e.target.value); dropHighlight("hourlyRate"); }}
               placeholder={gridRateEur !== null ? gridRateEur.toFixed(2) : "—"}
               className={cn(inputClass, "font-mono", highlightClass("hourlyRate"))}
             />
             <span className="text-[length:var(--text-xs)] text-muted-foreground">€/h</span>
           </div>
         ) : (
           <p className={cn("text-[length:var(--text-sm)] font-bold font-mono mt-[var(--space-xs)]", isOverride && "text-amber-500")}>
             {displayRate !== null ? `${displayRate.toFixed(2)} €/h` : <span className="text-muted-foreground/40">—</span>}
             {!hourlyRateEur && gridRateEur !== null && <span className="ml-1 text-[length:var(--text-xs)] font-normal text-muted-foreground">(grille)</span>}
             {isOverride && <span className="ml-1 text-[length:var(--text-xs)] font-normal">(surchargé)</span>}
           </p>
         )}
       </div>
     </div>
   );
 })()}

 {/* Sub-role badges (workers only — managers have no sub-roles, off-schedule) */}
 {canEdit && employee.role !== "admin" && employee.role !== "manager" && (() => {
 const dept = employee.role as "kitchen" | "floor";
 const visibleRoles = availableSubRoles[dept] ?? [];
 const current = employee.subRoles ?? [];
 return (
 <div className="mt-[var(--space-sm)]">
 <Label className={labelClass}>Compétences</Label>
 <div className="flex flex-wrap gap-1.5 mt-[var(--space-xs)]">
 {visibleRoles.map(sr => {
 const active = current.includes(sr);
 return (
 <button
 key={sr}
 type="button"
 onClick={async () => {
 if (!id) return;
 const EXCLUSIVE_GROUPS = [["Chef", "Sous-chef"], ["Chef de rang", "Sous-chef de rang"]];
 let next = active ? current.filter(r => r !== sr) : [...current, sr];
 if (!active) {
   for (const group of EXCLUSIVE_GROUPS) {
     if (group.includes(sr)) { next = next.filter(r => r === sr || !group.includes(r)); }
   }
 }
 // Kitchen/floor workers must keep at least one sub-role — the API will
 // reject a patch that empties the list anyway.
 if (next.length === 0 && (employee?.role === "kitchen" || employee?.role === "floor")) return;
 setEmployee(prev => prev ? { ...prev, subRoles: next } : prev);
 try {
 await api.updateUser(id, { subRoles: next });
 } catch {
 setEmployee(prev => prev ? { ...prev, subRoles: current } : prev);
 }
 }}
 className={cn(
 "px-2 py-0.5 rounded-full text-[length:var(--text-xs)] font-medium border transition-colors",
 active
 ? "bg-foreground text-background border-foreground"
 : "bg-transparent text-muted-foreground border-foreground/15 hover:border-foreground/30"
 )}
 >
 {sr}
 </button>
 );
 })}
 {isAdmin && (addingSubRole ? (
 <input
 autoFocus
 type="text"
 placeholder="Nom..."
 className="px-2 py-0.5 rounded-full text-[length:var(--text-xs)] font-medium border border-foreground/30 bg-transparent w-[100px] outline-none focus:border-foreground/60"
 onKeyDown={async (e) => {
 if (e.key === "Enter" && e.currentTarget.value.trim()) {
 await handleAddSubRole(dept, e.currentTarget.value);
 } else if (e.key === "Escape") {
 setAddingSubRole(false);
 }
 }}
 onBlur={async (e) => {
 if (e.currentTarget.value.trim()) {
 await handleAddSubRole(dept, e.currentTarget.value);
 } else {
 setAddingSubRole(false);
 }
 }}
 />
 ) : (
 <button
 type="button"
 onClick={() => setAddingSubRole(true)}
 className={cn(
 "px-2 py-0.5 rounded-full text-[length:var(--text-xs)] font-medium border border-dashed transition-colors",
 "border-foreground/15 text-muted-foreground/40 hover:border-foreground/30 hover:text-muted-foreground"
 )}
 >
 +
 </button>
 ))}
 </div>
 </div>
 );
 })()}
 </div>
 </div>

 {/* Weekly restrictions — time-slot based unavailability. Skip for managers (off-schedule). */}
 {canEdit && employee.role !== "admin" && employee.role !== "manager" && (() => {
 const restrCount = restrictions.length;

 function addRestriction(dayOfWeek: number, fullDay: boolean) {
 const newR: WorkerRestriction = fullDay
 ? { dayOfWeek, startTime: null, endTime: null }
 : { dayOfWeek, startTime: "08:00", endTime: "14:00" };
 setRestrictions(prev => [...prev, newR]);
 setRestrDirty(true);
 }

 function removeRestriction(index: number) {
 setRestrictions(prev => prev.filter((_, i) => i !== index));
 setRestrDirty(true);
 }

 function updateRestriction(index: number, field: "startTime" | "endTime" | "reason", value: string) {
 setRestrictions(prev => prev.map((r, i) => i === index ? { ...r, [field]: value || null } : r));
 setRestrDirty(true);
 }

 function toggleFullDay(dayOfWeek: number) {
 const hasFullDay = restrictions.some(r => r.dayOfWeek === dayOfWeek && !r.startTime && !r.endTime);
 if (hasFullDay) {
 setRestrictions(prev => prev.filter(r => !(r.dayOfWeek === dayOfWeek && !r.startTime && !r.endTime)));
 } else {
 // Remove time-range restrictions for this day, add full day
 setRestrictions(prev => [
 ...prev.filter(r => r.dayOfWeek !== dayOfWeek),
 { dayOfWeek, startTime: null, endTime: null },
 ]);
 }
 setRestrDirty(true);
 }

 const pendingReqs = restrictionRequests.filter(r => r.status === "pending");

 async function reviewRequest(reqId: string, action: "approve" | "reject") {
 try {
 await api.reviewRestrictionRequest(reqId, action);
 // Update request status locally
 setRestrictionRequests(prev => prev.map(r => r.id === reqId ? { ...r, status: action === "approve" ? "approved" : "rejected" } : r));
 // On approve, reload restrictions so the grid reflects the newly-applied rows
 if (action === "approve" && id) {
 const res = await api.getRestrictions(id);
 setRestrictions(res.data);
 }
 } catch (err) {
 setError(err instanceof Error ? err.message : "Erreur");
 }
 }

 return (
 <div className={sectionClass}>
 <div className="flex items-center justify-between mb-[var(--space-md)]">
 <div>
 <p className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">Disponibilités</p>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground/60 mt-[2px]">
 {restrCount === 0
 ? "Disponible tous les jours d'ouverture"
 : `${restrCount} restriction${restrCount > 1 ? "s" : ""} configurée${restrCount > 1 ? "s" : ""}`
 }
 </p>
 </div>
 {restrDirty && (
 <Button onClick={handleSaveRestrictions} disabled={restrSaving} size="sm"
 className="h-6 px-[var(--space-sm)] tracking-normal text-[length:var(--text-xs)] font-bold">
 {restrSaving ? "..." : "Enregistrer"}
 </Button>
 )}
 </div>

 {/* Pending change requests from the worker */}
 {pendingReqs.length > 0 && (
 <div className="mb-[var(--space-md)] p-[var(--space-md)] border border-amber-400/40 bg-amber-500/10 rounded">
 <p className="text-[length:var(--text-xs)] font-bold tracking-wide text-amber-700 dark:text-amber-400 mb-[var(--space-xs)]">
 {pendingReqs.length} demande{pendingReqs.length > 1 ? "s" : ""} en attente de votre validation
 </p>
 <ul className="space-y-[var(--space-sm)]">
 {pendingReqs.map((req) => (
 <li key={req.id} className="text-[length:var(--text-xs)]">
 <div className="flex items-start justify-between gap-[var(--space-sm)]">
 <div className="flex-1">
 <p className="font-medium">
 {req.kind === "permanent"
 ? "Changement permanent"
 : `Changement temporaire · ${fmtDateFR(req.effectiveFrom!)} → ${fmtDateFR(req.effectiveUntil!)}`}
 </p>
 {req.note && <p className="text-muted-foreground mt-[var(--space-xs)]">« {req.note} »</p>}
 <ul className="mt-[var(--space-xs)] space-y-[1px]">
 {req.restrictions.map((r, i) => (
 <li key={i} className="font-mono text-[length:var(--text-2xs)] text-muted-foreground">
 {DAY_LABELS[r.dayOfWeek - 1]}{" "}
 {(!r.startTime && !r.endTime) ? "Jour entier" : `${r.startTime} → ${r.endTime}`}
 {r.reason && <span className="ml-[var(--space-sm)]">— {r.reason}</span>}
 </li>
 ))}
 </ul>
 </div>
 <div className="flex flex-col gap-[var(--space-xs)] shrink-0">
 <button
 onClick={() => reviewRequest(req.id, "approve")}
 className="text-[length:var(--text-2xs)] tracking-wide font-bold bg-foreground text-background rounded-full px-[var(--space-md)] py-[2px] cursor-pointer"
 >
 Approuver
 </button>
 <button
 onClick={() => reviewRequest(req.id, "reject")}
 className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground hover:text-red-400 cursor-pointer"
 >
 Refuser
 </button>
 </div>
 </div>
 </li>
 ))}
 </ul>
 </div>
 )}

 {/* Weekly overview grid */}
 <div className="grid grid-cols-7 gap-[3px] mb-[var(--space-md)]">
 {DAY_LABELS.map((label, i) => {
 const day = i + 1;
 const closed = !openDays[String(day)];
 const dayRestr = restrictions.filter(r => r.dayOfWeek === day);
 const hasFullDay = dayRestr.some(r => !r.startTime && !r.endTime);
 const hasPartial = dayRestr.some(r => r.startTime && r.endTime);

 return (
 <div key={label} className="text-center">
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground">{label}</span>
 {closed ? (
 <div className="mt-[3px] rounded-[0.2rem] py-[6px] bg-foreground/[0.03]">
 <span className="text-[length:var(--text-2xs)] text-muted-foreground/20 font-medium">Fermé</span>
 </div>
 ) : (
 <button type="button" onClick={() => toggleFullDay(day)}
 className={`mt-[3px] w-full rounded-[0.2rem] py-[6px] border transition-all ${
 hasFullDay
 ? "bg-red-500/8 border-red-400/20 hover:bg-red-500/15"
 : hasPartial
 ? "bg-amber-500/8 border-amber-400/20 hover:bg-amber-500/15"
 : "bg-emerald-500/8 border-emerald-500/15 hover:bg-emerald-500/15"
 }`}
 title={hasFullDay ? "Indisponible toute la journée — cliquer pour supprimer" : hasPartial ? "Restriction partielle" : "Disponible — cliquer pour bloquer la journée"}
 >
 {hasFullDay ? (
 <span className="text-red-400 text-[length:var(--text-xs)] font-bold">×</span>
 ) : hasPartial ? (
 <span className="text-amber-500 text-[length:9px] font-bold">PARTIEL</span>
 ) : (
 <span className="text-emerald-600/60 dark:text-emerald-400/60 text-[length:var(--text-2xs)] font-bold">✓</span>
 )}
 </button>
 )}
 </div>
 );
 })}
 </div>

 {/* Restriction list */}
 {restrictions.length > 0 && (
 <div className="space-y-[6px] mb-[var(--space-md)]">
 {[1, 2, 3, 4, 5, 6, 7].map(day => {
 const dayRestr = restrictions
 .map((r, idx) => ({ ...r, _idx: idx }))
 .filter(r => r.dayOfWeek === day);
 if (dayRestr.length === 0) return null;
 return dayRestr.map(r => (
 <div key={r._idx} className="flex items-center gap-[var(--space-sm)] bg-red-500/5 rounded-[0.3rem] px-[var(--space-sm)] py-[4px]">
 <span className="text-[length:var(--text-2xs)] font-bold text-muted-foreground w-[32px] shrink-0">{DAY_LABELS[day - 1]}</span>
 {!r.startTime && !r.endTime ? (
 <span className="text-[length:var(--text-2xs)] text-red-400 font-medium">Journée entière</span>
 ) : (
 <div className="flex items-center gap-[4px]">
 <input type="time" value={r.startTime || ""}
 onChange={e => updateRestriction(r._idx, "startTime", e.target.value)}
 className="bg-transparent border border-foreground/10 rounded px-[4px] py-[1px] text-[length:var(--text-2xs)] w-[80px]"
 />
 <span className="text-muted-foreground/40 text-[length:var(--text-2xs)]">→</span>
 <input type="time" value={r.endTime || ""}
 onChange={e => updateRestriction(r._idx, "endTime", e.target.value)}
 className="bg-transparent border border-foreground/10 rounded px-[4px] py-[1px] text-[length:var(--text-2xs)] w-[80px]"
 />
 </div>
 )}
 <button type="button" onClick={() => removeRestriction(r._idx)}
 className="ml-auto text-muted-foreground/40 hover:text-red-400 transition-colors">
 <X size={12} />
 </button>
 </div>
 ));
 })}
 </div>
 )}

 {/* Add restriction buttons per day */}
 <div className="flex flex-wrap gap-[4px]">
 {DAY_LABELS.map((label, i) => {
 const day = i + 1;
 const closed = !openDays[String(day)];
 const hasFullDay = restrictions.some(r => r.dayOfWeek === day && !r.startTime && !r.endTime);
 if (closed || hasFullDay) return null;
 return (
 <button key={day} type="button" onClick={() => addRestriction(day, false)}
 className="text-[length:9px] font-bold tracking-wide text-muted-foreground/50 hover:text-foreground/70 border border-dashed border-foreground/10 rounded-[0.2rem] px-[6px] py-[2px] transition-colors"
 >
 + {label}
 </button>
 );
 })}
 </div>

 <p className="text-[length:var(--text-xs)] text-muted-foreground/60 mt-[var(--space-sm)]">
 Par défaut, l'employé est disponible partout. Ajoutez des restrictions pour bloquer des jours ou créneaux horaires.
 </p>

 {/* Admin OT override — surcharges the global rule from Préférences › Règle for this employee only. Admin-only UI. */}
 {isAdminView && (
 <div className="mt-[var(--space-lg)] border-t border-foreground/10 pt-[var(--space-md)]">
 <div className="flex items-center justify-between mb-1">
 <span className="text-[length:var(--text-sm)] font-medium">Plafond d'heures sup. (override)</span>
 <span className="text-[length:var(--text-sm)] font-bold font-mono">
 {employee.adminOtOverride ?? 48}h
 {!employee.adminOtOverride && <span className="text-muted-foreground font-normal text-[length:var(--text-xs)] ml-1">(règle globale)</span>}
 </span>
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-2xs)] text-muted-foreground font-mono shrink-0">39h</span>
 <input
 type="range"
 min={39}
 max={48}
 step={1}
 value={employee.adminOtOverride ?? 48}
 onChange={async (e) => {
 const val = parseInt(e.target.value);
 const override = val >= 48 ? null : val;
 setEmployee(prev => prev ? { ...prev, adminOtOverride: override } : prev);
 await api.updateUser(id!, { adminOtOverride: override });
 }}
 className="flex-1 accent-foreground cursor-pointer"
 />
 <span className="text-[length:var(--text-2xs)] text-muted-foreground font-mono shrink-0">48h</span>
 </div>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-1">
 {employee.adminOtOverride
 ? `Surcharge la règle globale (Préférences › Règle) pour cet employé uniquement.`
 : `Aucune surcharge — suit la règle globale définie dans Préférences › Règle.`}
 </p>
 </div>
 )}

 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[var(--space-md)]">
 Les autorisations vers d'autres restaurants se règlent dans la section Multi-restaurant de cette fiche.
 </p>
 </div>
 );
 })()}

 {/* ── Worker Preferences ── */}
 {employee.role !== "admin" && (() => {
 const hasAnyPref = preferred.length === 7 && preferred.some((d) => d.midi || d.soir);
 return (
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-lg)]">Préférences employé</p>
 <div className="space-y-[var(--space-md)]">
 {/* Worker OT preference — editable if worker views own /my-profile, read-only if admin views /staff/:id */}
 <div>
 <div className="flex items-center justify-between mb-1">
 <span className="text-[length:var(--text-sm)] font-medium">Heures max / semaine{isAdminView && <span className="text-muted-foreground font-normal text-[length:var(--text-xs)] ml-1">(choix employé)</span>}</span>
 <span className="text-[length:var(--text-sm)] font-bold font-mono">
 {employee.maxWeeklyHours ?? employee.contractHours ?? 35}h
 {!employee.maxWeeklyHours && <span className="text-muted-foreground font-normal text-[length:var(--text-xs)] ml-1">(contrat)</span>}
 </span>
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-2xs)] text-muted-foreground font-mono shrink-0">{employee.contractHours ?? 35}h</span>
 <input
 type="range"
 min={employee.contractHours ?? 35}
 max={48}
 step={1}
 value={employee.maxWeeklyHours ?? employee.contractHours ?? 35}
 disabled={!isSelfView}
 readOnly={!isSelfView}
 onChange={isSelfView ? async (e) => {
 const val = parseInt(e.target.value);
 const contractH = employee.contractHours ?? 35;
 const maxH = val <= contractH ? null : val;
 setEmployee(prev => prev ? { ...prev, maxWeeklyHours: maxH, overtimeWilling: maxH !== null } : prev);
 await api.updateMyProfile({ maxWeeklyHours: maxH, overtimeWilling: maxH !== null });
 } : undefined}
 className={`flex-1 accent-foreground ${isSelfView ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
 />
 <span className="text-[length:var(--text-2xs)] text-muted-foreground font-mono shrink-0">48h</span>
 </div>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-1">
 {employee.maxWeeklyHours
 ? `+${employee.maxWeeklyHours - (employee.contractHours ?? 35)}h supp. ${isSelfView ? "acceptées" : "acceptées par l'employé"}`
 : isSelfView
 ? `Glissez pour indiquer combien d'heures supplémentaires vous acceptez par semaine.`
 : `L'employé n'a pas exprimé d'acceptation d'heures supplémentaires.`}
 </p>
 </div>

 {/* Coupure willing */}
 <div className="flex items-center gap-[var(--space-sm)]">
 <div className={`w-[16px] h-[16px] rounded-[0.15rem] border-2 flex items-center justify-center shrink-0 ${
 employee.coupureWilling
 ? "border-sky-500 bg-sky-500"
 : "border-foreground/10 bg-transparent"
 }`}>
 {employee.coupureWilling && (
 <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-white">
 <path d="M2 5L4 7L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 )}
 </div>
 <span className="text-[length:var(--text-sm)] font-medium">Accepte les coupures</span>
 </div>

 {/* Multi-restaurant opt-in — chosen by the worker */}
 <div className="flex items-start gap-[var(--space-sm)]">
 <div className={`w-[16px] h-[16px] rounded-[0.15rem] border-2 flex items-center justify-center shrink-0 mt-[2px] ${
 employee.multiRestaurantWilling !== false
 ? "border-emerald-500 bg-emerald-500"
 : "border-foreground/10 bg-transparent"
 }`}>
 {employee.multiRestaurantWilling !== false && <Check className="w-[10px] h-[10px] text-white" strokeWidth={2.4} />}
 </div>
 <div>
 <span className="text-[length:var(--text-sm)] font-medium">Autorise les propositions multi-restaurant</span>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-1">
 {employee.multiRestaurantWilling !== false
 ? "Le responsable peut l'autoriser restaurant par restaurant dans la section Multi-restaurant."
 : "Le salarié a désactivé cette autorisation depuis son espace personnel."}
 </p>
 </div>
 </div>

 {/* Preferred schedule grid — unified matin/midi/soir display (same buckets as /my-profile) */}
 {hasAnyPref && (() => {
 const TIME_BUCKETS: Array<{ key: "midi" | "soir"; label: string }> = [
 { key: "midi", label: "< 14H" },
 { key: "soir", label: "≥ 14H" },
 ];
 return (
 <div>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mb-[var(--space-sm)]">
 Créneaux préférés
 </p>
 <div className="grid grid-cols-7 gap-[var(--space-xs)] opacity-60">
 {DAY_LABELS.map((d) => (
 <div key={d} className="text-center text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground pb-[var(--space-xs)]">
 {d}
 </div>
 ))}
 {preferred.map((d, i) => {
 const day = i + 1;
 const closed = !openDays[String(day)];
 if (closed) {
 return (
 <div key={i} className="flex flex-col items-center justify-center opacity-30" style={{ height: 80 }}>
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground">FERMÉ</span>
 </div>
 );
 }
 return (
 <div key={i} className="flex flex-col gap-[2px]">
 {TIME_BUCKETS.map((bucket) => {
 const active = !!d[bucket.key];
 return (
 <div key={bucket.key}
 className={`rounded-[0.2rem] border-dashed border-2 px-[2px] flex items-center justify-center ${
 active ? "bg-foreground/15 border-foreground/40" : "border-foreground/10"
 }`}
 style={{ height: 24 }}
 >
 <span className={`text-[length:var(--text-2xs)] uppercase tracking-widest font-bold ${active ? "text-foreground/70" : "text-muted-foreground/30"}`}>
 {bucket.label}
 </span>
 </div>
 );
 })}
 </div>
 );
 })}
 </div>
 </div>
 );
 })()}
 </div>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground/60 mt-[var(--space-sm)]">
 Ces préférences sont définies par l'employé dans son espace personnel.
 </p>
 </div>
 );
 })()}

 {/* Multi-restaurant authorizations */}
 {employee.role !== "admin" && (
 <div className={sectionClass}>
 <div className="flex items-start justify-between gap-[var(--space-md)] mb-[var(--space-md)]">
 <div>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-xs)]">Multi-restaurant</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground">
 Cochez les restaurants où ce salarié peut être proposé. Les heures restent rattachées au restaurant où le service est effectué.
 </p>
 </div>
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground border border-foreground/10 rounded-[0.2rem] px-[var(--space-xs)] py-[2px] whitespace-nowrap">
 RH/documents séparés
 </span>
 </div>
 {!canManageWorkerShares ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground">
 Cette section est disponible pour les responsables du compte avec plusieurs restaurants.
 </p>
 ) : shareTargetRestaurants.length === 0 ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground">
 Ajoutez un deuxième restaurant au compte pour autoriser ce salarié ailleurs.
 </p>
 ) : (
 <>
 {!workerAllowsMultiRestaurant && (
 <p className="mb-[var(--space-sm)] text-[length:var(--text-xs)] text-amber-700 dark:text-amber-300 border border-amber-400/40 bg-amber-400/10 rounded-[0.2rem] px-[var(--space-sm)] py-[var(--space-xs)]">
 Le salarié a désactivé l'autorisation générale dans son espace. Les autorisations existantes restent visibles mais ne rendent pas le salarié planifiable ailleurs.
 </p>
 )}
 <div className="overflow-x-auto border border-foreground/10 rounded-[0.2rem]">
 <table className="w-full min-w-[520px] border-collapse text-[length:var(--text-xs)]">
 <thead className="bg-muted/50 text-left">
 <tr>
 <th className="border-b border-r border-foreground/10 px-[var(--space-sm)] py-[var(--space-xs)] font-bold">Restaurant</th>
 <th className="border-b border-r border-foreground/10 px-[var(--space-sm)] py-[var(--space-xs)] font-bold">Établissement principal</th>
 <th className="border-b border-foreground/10 px-[var(--space-sm)] py-[var(--space-xs)] font-bold">Établissement secondaire</th>
 </tr>
 </thead>
 <tbody>
 {ownerRestaurants.map((restaurant) => {
 const isPrimary = restaurant.id === activeRestaurantId;
 const share = workerSharesByTarget.get(restaurant.id);
 const enabled = isPrimary || !!share;
 return (
 <tr key={restaurant.id} className="border-b border-foreground/10 last:border-b-0">
 <td className="border-r border-foreground/10 px-[var(--space-sm)] py-[var(--space-xs)] font-bold">{restaurant.name}</td>
 <td className="border-r border-foreground/10 px-[var(--space-sm)] py-[var(--space-xs)] text-center">
 <input type="checkbox" checked={isPrimary} disabled className="h-4 w-4 accent-foreground" aria-label={`${restaurant.name} principal`} />
 </td>
 <td className="border-r border-foreground/10 px-[var(--space-sm)] py-[var(--space-xs)] text-center">
 <input
 type="checkbox"
 checked={enabled}
 disabled={isPrimary || !workerAllowsMultiRestaurant || workerShareBusyId === restaurant.id || workerSharesQuery.isPending}
 onChange={() => handleToggleWorkerShare(restaurant.id)}
 className="h-4 w-4 accent-foreground disabled:opacity-60"
 aria-label={`${restaurant.name} secondaire`}
 />
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </>
 )}
 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[var(--space-md)] pt-[var(--space-sm)] border-t border-foreground/10">
 Les documents, notes et paramètres RH restent séparés par restaurant. Les exports et récapitulatifs indiquent le restaurant analytique de chaque service effectué.
 </p>
 </div>
 )}

 {/* Emergency — filled by the employee on their own profile, read-only here */}
 <div className={sectionClass}>
 <div className="flex items-center justify-between mb-[var(--space-lg)]">
  <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">Urgence</p>
  <span className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground">Renseigné par l'employé</span>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-lg)]">
 <div>
 <Label className={labelClass}>Nom</Label>
 <p className="text-[length:var(--text-sm)] font-medium mt-[var(--space-xs)]">{employee.emergencyContact || <span className="text-muted-foreground/60">— à renseigner par l'employé</span>}</p>
 </div>
 <div>
 <Label className={labelClass}>Téléphone</Label>
 <p className="text-[length:var(--text-sm)] font-medium mt-[var(--space-xs)]">{employee.emergencyPhone || <span className="text-muted-foreground/60">— à renseigner par l'employé</span>}</p>
 </div>
 </div>
 </div>

 {/* Onboarding checklist — required documents per HCR convention */}
 {checklist && (
   <div className={sectionClass}>
     <div className="flex items-center justify-between mb-[var(--space-sm)]">
       <p className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">
         Dossier d'onboarding
       </p>
       <span className={`text-[length:var(--text-xs)] font-bold ${
         checklist.readyForDpae
           ? "text-emerald-600 dark:text-emerald-400"
           : "text-muted-foreground"
       }`}>
         {checklist.mandatoryValid}/{checklist.mandatoryTotal} obligatoires
         {checklist.readyForDpae && " ✓ prêt pour la DPAE"}
         {checklist.expiringWithin30d > 0 && ` · ${checklist.expiringWithin30d} bientôt expiré${checklist.expiringWithin30d > 1 ? "s" : ""}`}
       </span>
     </div>
     {/* Progress bar */}
     <div className="h-[4px] bg-foreground/10 rounded-full overflow-hidden mb-[var(--space-md)]">
       <div
         className={`h-full transition-all ${checklist.readyForDpae ? "bg-emerald-500" : "bg-foreground"}`}
         style={{ width: `${checklist.percentComplete}%` }}
       />
     </div>
     {checklist.missingDpaeFields.length > 0 && (
       <div className="mb-[var(--space-sm)] rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-[var(--space-sm)]">
         <p className="text-[length:var(--text-xs)] font-bold text-amber-800 dark:text-amber-300">Informations DPAE à compléter</p>
         <p className="text-[length:var(--text-xs)] text-amber-700 dark:text-amber-400 mt-[2px]">
           {checklist.missingDpaeFields.join(" · ")}
         </p>
       </div>
     )}
     {checklist.missingPayrollFields.length > 0 && (
       <div className="mb-[var(--space-md)] rounded-md border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 p-[var(--space-sm)]">
         <p className="text-[length:var(--text-xs)] font-bold text-sky-800 dark:text-sky-300">Informations paie / RH à compléter</p>
         <p className="text-[length:var(--text-xs)] text-sky-700 dark:text-sky-400 mt-[2px]">
           {checklist.missingPayrollFields.join(" · ")}
         </p>
       </div>
     )}
     {/* Grouped by category */}
     <div className="space-y-[var(--space-xs)]">
       {(["identity","administrative","medical","qualification","legal"] as const).map(cat => {
         const items = checklist.items.filter(i => i.category === cat);
         if (items.length === 0) return null;
         const catLabel = cat === "identity" ? "Identité"
           : cat === "administrative" ? "Administratif"
           : cat === "medical" ? "Médical"
           : cat === "qualification" ? "Qualifications"
           : "Légal";
         return (
           <div key={cat} className="space-y-[2px]">
             <p className="text-[length:var(--text-2xs)] font-bold uppercase tracking-widest text-muted-foreground mt-[var(--space-xs)]">
               {catLabel}
             </p>
             {items.map(item => {
               const statusBadge = item.status === "valid" ? { text: "✓", cls: "text-emerald-600 dark:text-emerald-400" }
                 : item.status === "expiring_soon" ? { text: "⚠", cls: "text-amber-600 dark:text-amber-400" }
                 : item.status === "expired" ? { text: "✗", cls: "text-rose-600 dark:text-rose-400" }
                 : item.status === "pending_review" ? { text: "⏳", cls: "text-amber-600 dark:text-amber-400" }
                 : item.status === "uploaded" ? { text: "●", cls: "text-sky-600 dark:text-sky-400" }
                 : { text: item.mandatory ? "◯" : "·", cls: "text-muted-foreground" };
               const isUploading = uploadingKey === item.key;
               return (
                 <div key={item.key} className="flex items-center gap-[var(--space-xs)] py-[2px]">
                   <span className={`text-[length:var(--text-sm)] font-bold w-[14px] text-center ${statusBadge.cls}`}>
                     {statusBadge.text}
                   </span>
                   <div className="flex-1 min-w-0">
                     <div className="flex items-center gap-[var(--space-xs)]">
                       <span className="text-[length:var(--text-sm)] font-medium">{item.label}</span>
                       {!item.mandatory && (
                         <span className="text-[length:var(--text-2xs)] text-muted-foreground">facultatif</span>
                       )}
                     </div>
                     {item.hint && (
                       <p className="text-[length:var(--text-xs)] text-muted-foreground">{item.hint}</p>
                     )}
                     {item.expiresAt && !item.hint && (
                       <p className="text-[length:var(--text-xs)] text-muted-foreground">Expire le {item.expiresAt}</p>
                     )}
                   </div>
                   <label className={`cursor-pointer text-[length:var(--text-xs)] font-bold px-[var(--space-sm)] py-[2px] rounded-[0.2rem] border border-foreground/20 hover:border-foreground/40 text-muted-foreground transition-colors whitespace-nowrap ${isUploading ? "opacity-50 pointer-events-none" : ""}`}>
                     {isUploading ? "..." : item.status === "missing" ? "+ Ajouter" : "Remplacer"}
                     <input type="file" className="hidden" onChange={(e) => handleRequirementUpload(e, item)} accept=".pdf,.jpg,.jpeg,.png,.webp" />
                   </label>
                 </div>
               );
             })}
           </div>
         );
       })}
     </div>
   </div>
 )}

 {/* Contrats — generated drafts + signed scans */}
 {(() => {
   const contracts = documents.filter(d => d.type === "contract");
   if (contracts.length === 0) return null;
   const anySigned = contracts.some(c => c.signedAt);
   return (
     <div className={sectionClass}>
       <div className="flex items-center justify-between mb-[var(--space-sm)] flex-wrap gap-[var(--space-xs)]">
         <div className="flex items-center gap-[var(--space-sm)]">
           <p className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">Contrats</p>
           {anySigned && (
             <span className="text-[length:var(--text-xs)] font-bold text-emerald-600 dark:text-emerald-400">
               ✓ Signé
             </span>
           )}
         </div>
         <label className="cursor-pointer text-[length:var(--text-xs)] tracking-wide font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 hover:border-foreground/40 text-muted-foreground transition-colors">
           + Uploader version signée
           <input type="file" className="hidden" onChange={handleUploadSignedContract} accept=".pdf,.jpg,.jpeg,.png,.webp" />
         </label>
       </div>
       <p className="text-[length:var(--text-xs)] text-muted-foreground mb-[var(--space-sm)]">
         Génère un contrat, imprime-le, signe-le avec l'employé, puis uploade la version signée (ou marque un brouillon existant comme signé).
       </p>
       <div className="space-y-[var(--space-xs)]">
         {contracts.map(doc => (
           <div key={doc.id} className="flex items-center gap-[var(--space-sm)] group">
             <span className={cn(
               "text-[length:var(--text-2xs)] tracking-wide font-bold px-[var(--space-xs)] py-[0px] rounded-[0.2rem] leading-[14px] whitespace-nowrap shrink-0 border",
               doc.signedAt
                 ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5"
                 : "border-foreground/15 text-muted-foreground"
             )}>
               {doc.signedAt ? `signé ${doc.signedAt}` : "brouillon"}
             </span>
             <button type="button" onClick={() => handleViewDoc(doc)} className="text-[length:var(--text-sm)] font-medium hover:underline truncate text-left">
               {doc.name}
             </button>
             <span className="flex-1" />
             <button
               type="button"
               onClick={() => handleToggleDocSigned(doc)}
               className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
             >
               {doc.signedAt ? "Marquer brouillon" : "Marquer signé"}
             </button>
           </div>
         ))}
       </div>
     </div>
   );
 })()}

 {/* Documents */}
 <div className={sectionClass}>
 <div className="flex items-center justify-between mb-[var(--space-md)] flex-wrap gap-[var(--space-xs)]">
 <p className="text-[length:var(--text-xs)] font-bold tracking-wide text-muted-foreground">Documents</p>
 <div className="flex items-center gap-[var(--space-xs)] flex-wrap">
 {employee.contractType ? (
  <button
   type="button"
   disabled={generatingContract}
   onClick={() => handleGenerateContract(employee.contractType as "CDI" | "CDD" | "saisonnier" | "extra")}
   className={`text-[length:var(--text-xs)] tracking-wide font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 text-muted-foreground hover:border-foreground/40 transition-colors ${generatingContract ? "opacity-50" : ""}`}
   title={`Générer un contrat ${employee.contractType} (basé sur la fiche Emploi)`}
  >
   {generatingContract ? "..." : `Générer contrat ${employee.contractType}`}
  </button>
 ) : (
  <select
   disabled={generatingContract}
   value=""
   onChange={(e) => { if (e.target.value) { handleGenerateContract(e.target.value as "CDI" | "CDD" | "saisonnier" | "extra"); e.target.value = ""; } }}
   className={`text-[length:var(--text-xs)] tracking-wide font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 text-muted-foreground bg-transparent hover:border-foreground/40 transition-colors ${generatingContract ? "opacity-50" : ""}`}
   title="Type de contrat absent — choisir le type à générer"
  >
   <option value="">{generatingContract ? "..." : "Générer contrat"}</option>
   <option value="CDI">CDI</option>
   <option value="CDD">CDD</option>
   <option value="saisonnier">Saisonnier</option>
   <option value="extra">Extra</option>
  </select>
 )}
 <button
  type="button"
  onClick={handleExportDpae}
  title="Exporter le CSV DPAE pour URSSAF net-entreprises"
  className="text-[length:var(--text-xs)] tracking-wide font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 text-muted-foreground hover:border-foreground/40 transition-colors"
 >
  DPAE URSSAF
 </button>
 <label className={`cursor-pointer text-[length:var(--text-xs)] tracking-wide font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 hover:border-foreground/40 text-muted-foreground transition-colors ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
 {uploading ? "..." : "+ Télécharger"}
 <input type="file" className="hidden" onChange={handleFileUpload} accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx" />
 </label>
 </div>
 </div>

 {contractWarning && (
   <div className="mb-[var(--space-md)] rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-[var(--space-sm)] space-y-[var(--space-xs)]">
     <p className="text-[length:var(--text-xs)] font-bold text-amber-800 dark:text-amber-300">
       Contrat {contractWarning.kind} incomplet — informations manquantes
     </p>
     <p className="text-[length:var(--text-xs)] text-amber-700 dark:text-amber-400">
       {contractWarning.missing.map(m => m.label).join(" · ")}
     </p>
     <p className="text-[length:var(--text-2xs)] text-amber-700/80 dark:text-amber-400/80 italic">
       Sans ces champs, le contrat sera généré avec des espaces réservés (ex. « à compter du [date de début à préciser] », « demeurant [adresse à compléter] »).
     </p>
     <div className="flex gap-[var(--space-xs)] flex-wrap pt-[var(--space-xs)]">
       <Button
         type="button"
         variant="default"
         size="sm"
         onClick={() => {
           const keys = contractWarning.missing.map(m => m.key);
           setHighlightFields(new Set(keys));
           setEditing(true);
           setContractWarning(null);
           setTimeout(() => {
             const first = keys[0];
             if (first) document.getElementById(`field-${first}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
           }, 80);
         }}
       >
         Compléter le dossier
       </Button>
       <Button
         type="button"
         variant="outline"
         size="sm"
         onClick={() => handleGenerateContract(contractWarning.kind, true)}
       >
         Générer le brouillon quand même
       </Button>
       <Button
         type="button"
         variant="ghost"
         size="sm"
         onClick={() => setContractWarning(null)}
       >
         Annuler
       </Button>
     </div>
   </div>
 )}

 {documents.length === 0 ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground">Aucun document</p>
 ) : (
 <div className="space-y-[var(--space-xs)]">
 {documents.map((doc) => (
 <div key={doc.id} className="flex items-center gap-[var(--space-sm)] group">
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground border border-foreground/15 px-[var(--space-xs)] py-[0px] rounded-[0.2rem] leading-[14px] whitespace-nowrap shrink-0 shrink-0">
 {DOC_TYPE_LABELS[doc.type] || doc.type}
 </span>
 <button
 type="button"
 onClick={() => handleViewDoc(doc)}
 className="text-[length:var(--text-sm)] font-medium hover:underline truncate text-left"
 >
 {doc.name}
 </button>
 <span className="text-[length:var(--text-xs)] text-muted-foreground shrink-0">
 {formatFileSize(doc.size)}
 </span>
 <span className="flex-1" />
 {!doc.reviewedAt ? (
  <button
   type="button"
   onClick={() => handleConfirmDoc(doc.id)}
   className="text-[length:var(--text-xs)] tracking-wide font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 hover:bg-amber-200 dark:hover:bg-amber-900/60 px-[var(--space-sm)] py-[1px] rounded-[0.2rem] shrink-0"
   title="Marquer ce document comme validé pour qu'il compte dans le dossier"
  >
   ✓ Valider
  </button>
 ) : (
  <span
   className="text-[length:var(--text-2xs)] font-bold text-emerald-700 dark:text-emerald-400 shrink-0"
   title={`Validé le ${new Date(doc.reviewedAt).toLocaleDateString("fr-FR")}`}
  >
   ✓ validé
  </span>
 )}
 <button
 type="button"
 onClick={() => handleDeleteDoc(doc.id)}
 className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
 >
 Supprimer
 </button>
 </div>
 ))}
 </div>
 )}

 {/* Document viewer overlay */}
 {viewingDoc && (
 <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-[var(--space-sm)] md:p-[var(--space-lg)]" onClick={() => setViewingDoc(null)}>
 <div className="bg-background border border-border rounded-[0.2rem] max-w-3xl w-full max-h-[90vh] md:max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
 <div className="flex items-center justify-between p-[var(--space-md)] border-b border-border">
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground border border-foreground/15 px-[var(--space-xs)] py-[0px] rounded-[0.2rem] leading-[14px] whitespace-nowrap shrink-0">
 {DOC_TYPE_LABELS[viewingDoc.type] || viewingDoc.type}
 </span>
 <span className="text-[length:var(--text-sm)] font-bold">{viewingDoc.name}</span>
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <a
 href={documentSrc(viewingDoc)}
 download={viewingDoc.filename}
 className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground hover:text-foreground"
 >
 Télécharger
 </a>
 <button
 type="button"
 onClick={() => setViewingDoc(null)}
 className="text-[length:var(--text-sm)] text-muted-foreground hover:text-foreground font-bold"
 >
 <X className="size-4" />
 </button>
 </div>
 </div>
 <div className="flex-1 overflow-auto p-[var(--space-md)] flex items-center justify-center">
 {viewingDoc.mimeType.startsWith("image/") ? (
 <img
 src={documentSrc(viewingDoc)}
 alt={viewingDoc.name}
 className="max-w-full max-h-[70vh] object-contain"
 />
 ) : viewingDoc.mimeType === "application/pdf" ? (
 <iframe
 src={documentSrc(viewingDoc)}
 className="w-full h-[70vh]"
 title={viewingDoc.name}
 />
 ) : (
 <div className="text-center space-y-[var(--space-md)]">
 <p className="text-muted-foreground text-[length:var(--text-sm)]">Aperçu non disponible pour ce type de fichier</p>
 <a
 href={documentSrc(viewingDoc)}
 download={viewingDoc.filename}
 className="text-[length:var(--text-sm)] font-bold underline"
 >
 Télécharger {viewingDoc.filename}
 </a>
 </div>
 )}
 </div>
 </div>
 </div>
 )}
 </div>

 {/* ── History: Time Off ── */}
 {employee.role !== "admin" && (
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-md)]">Congés</p>
 {holidays.length === 0 ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground">Aucune demande de congé</p>
 ) : (
 <div className="space-y-[var(--space-sm)]">
 {[...holidays].sort((a, b) => b.startDate.localeCompare(a.startDate)).map((h) => (
 <div key={h.id} className="space-y-[var(--space-xs)]">
 <div className="flex items-center gap-[var(--space-sm)] flex-nowrap">
 <span className={`text-[length:var(--text-2xs)] tracking-wide font-bold px-[var(--space-xs)] py-[0px] rounded-[0.2rem] border leading-[14px] whitespace-nowrap shrink-0 ${STATUS_STYLE[h.status] || ""}`}>
 {STATUS_LABEL[h.status] || h.status}
 </span>
 {h.medical && (
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground border border-foreground/15 px-[var(--space-xs)] py-[0px] rounded-[0.2rem] leading-[14px] whitespace-nowrap shrink-0">
 MEDICAL
 </span>
 )}
 <span className="text-[length:var(--text-sm)] font-bold">
 {h.startDate === h.endDate ? fmtDateFR(h.startDate) : `${fmtDateFR(h.startDate)} → ${fmtDateFR(h.endDate)}`}
 </span>
 <span className="flex-1" />
 {h.documentCount > 0 && (
 <button
 type="button"
 onClick={() => toggleHolidayDocs(h.id)}
 className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground hover:text-foreground"
 >
 {h.documentCount} DOC{h.documentCount > 1 ? "S" : ""} <ChevronRight className={cn("size-3 transition-transform inline-block", expandedHoliday === h.id && "rotate-90")} />
 </button>
 )}
 </div>
 {h.reason && (
 <p className="text-[length:var(--text-xs)] text-muted-foreground ml-[var(--space-lg)]">{h.reason}</p>
 )}
 {/* Expanded documents for this holiday */}
 {expandedHoliday === h.id && holidayDocs[h.id] && (
 <div className="ml-[var(--space-lg)] space-y-[var(--space-xs)]">
 {holidayDocs[h.id].map((doc) => (
 <div key={doc.id} className="flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground border border-foreground/15 px-[var(--space-xs)] py-[0px] rounded-[0.2rem] leading-[14px] whitespace-nowrap shrink-0 shrink-0">
 {DOC_TYPE_LABELS[doc.type] || doc.type}
 </span>
 <button
 type="button"
 onClick={() => viewHolidayDoc(h.id, doc)}
 className="text-[length:var(--text-sm)] font-medium hover:underline truncate text-left"
 >
 {doc.name}
 </button>
 <span className="text-[length:var(--text-xs)] text-muted-foreground shrink-0">
 {formatFileSize(doc.size)}
 </span>
 </div>
 ))}
 </div>
 )}
 </div>
 ))}
 </div>
 )}
 </div>
 )}

 {/* ── Retards (mois en cours) ── */}
 {employee.role !== "admin" && (
 <div className={sectionClass}>
 <div className="flex items-baseline justify-between mb-[var(--space-md)] flex-wrap gap-[var(--space-xs)]">
   <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">Retards · mois en cours</p>
   <p className="text-[length:var(--text-xs)] text-muted-foreground tabular-nums">
     {latenessTotalMin > 0 || earlyLeaveTotalMin > 0
       ? `Cumul : ${Math.floor(latenessTotalMin / 60)}h${String(latenessTotalMin % 60).padStart(2, "0")} de retard${earlyLeaveTotalMin > 0 ? ` · ${Math.floor(earlyLeaveTotalMin / 60)}h${String(earlyLeaveTotalMin % 60).padStart(2, "0")} de départ anticipé` : ""}`
       : "Aucun retard à signaler"}
   </p>
 </div>
 {lateness.length === 0 ? (
   <p className="text-[length:var(--text-sm)] text-muted-foreground">—</p>
 ) : (
   <div className="space-y-[var(--space-xs)]">
     {lateness.map((r) => {
       const tapInTime = new Date(r.tapIn);
       const tapInHHMM = `${String(tapInTime.getHours()).padStart(2, "0")}:${String(tapInTime.getMinutes()).padStart(2, "0")}`;
       const tapOutHHMM = r.tapOut ? (() => { const d = new Date(r.tapOut!); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; })() : null;
       return (
         <div key={r.id} className="flex items-center gap-[var(--space-sm)] flex-nowrap text-[length:var(--text-sm)]">
           <span className="text-muted-foreground tabular-nums shrink-0 w-[80px]">{fmtDateYear(r.date)}</span>
           {r.lateMin > 0 && (
             <span className="inline-flex items-center gap-[var(--space-xs)] text-amber-600 dark:text-amber-400 font-bold tabular-nums">
               +{r.lateMin}min
               <span className="text-muted-foreground font-normal">({r.scheduledStart?.slice(0,5)} → {tapInHHMM})</span>
             </span>
           )}
           {r.earlyLeaveMin > 0 && (
             <span className="inline-flex items-center gap-[var(--space-xs)] text-orange-600 dark:text-orange-400 font-bold tabular-nums">
               −{r.earlyLeaveMin}min
               <span className="text-muted-foreground font-normal">({tapOutHHMM} → {r.scheduledEnd?.slice(0,5)})</span>
             </span>
           )}
         </div>
       );
     })}
   </div>
 )}
 </div>
 )}

 {/* ── History: Replacements — workers only (admin/manager don't have shifts to swap) ── */}
 {employee.role !== "admin" && employee.role !== "manager" && (
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-md)]">Remplacements</p>
 {replacements.length === 0 ? (
 <p className="text-[length:var(--text-sm)] text-muted-foreground">Aucune demande de remplacement</p>
 ) : (
 <div className="space-y-[var(--space-sm)]">
 {[...replacements].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => {
 const isRequester = s.requesterId === id;
 const otherName = isRequester ? (s.targetId ? getUserName(s.targetId) : "—") : getUserName(s.requesterId);
 const DirectionIcon = isRequester ? ArrowRight : ArrowLeft;
 return (
 <div key={s.id} className="flex items-center gap-[var(--space-sm)] flex-nowrap">
 <span className={`text-[length:var(--text-2xs)] tracking-wide font-bold px-[var(--space-xs)] py-[0px] rounded-[0.2rem] border leading-[14px] whitespace-nowrap shrink-0 ${STATUS_STYLE[s.status] || ""}`}>
 {STATUS_LABEL[s.status] || s.status}
 </span>
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground border border-foreground/15 px-[var(--space-xs)] py-[0px] rounded-[0.2rem] leading-[14px] whitespace-nowrap shrink-0 shrink-0">
 {isRequester ? "SORTANT" : "ENTRANT"}
 </span>
 <span className="text-[length:var(--text-sm)] font-bold flex items-center gap-[var(--space-xs)]">
 <DirectionIcon className="size-3" /> {otherName}
 </span>
 {s.message && (
 <span className="text-[length:var(--text-xs)] text-muted-foreground truncate">— {s.message}</span>
 )}
 <span className="flex-1" />
 <span className="text-[length:var(--text-xs)] text-muted-foreground shrink-0">
 {fmtDateYear(s.createdAt.slice(0, 10))}
 </span>
 </div>
 );
 })}
 </div>
 )}
 </div>
 )}

 {/* Notes */}
 {canSeeSensitive && (
 <ManagerNotes employeeId={id!} managerNotes={employee.managerNotes} sectionClass={sectionClass} />
 )}

 {/* Manager permissions — admin-only, only when this employee is a manager */}
 {isAdmin && employee.role === "manager" && (
 <ManagerPermissionsPanel
  userId={id!}
  initialPermissions={employee.permissions}
  sectionClass={sectionClass}
  onSaved={() => queryClient.invalidateQueries({ queryKey: qk.employees.detail(id!) })}
 />
 )}
 </div>
 );
}

type NoteEntry = { date: string; text: string };

function parseNotes(raw: string | null | undefined): NoteEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  // Legacy: plain string → single undated note
  if (raw.trim()) return [{ date: "", text: raw.trim() }];
  return [];
}

function ManagerNotes({ employeeId, managerNotes, sectionClass }: {
  employeeId: string;
  managerNotes: string | null | undefined;
  sectionClass: string;
}) {
  const [notes, setNotes] = useState<NoteEntry[]>(() => parseNotes(managerNotes));
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setNotes(parseNotes(managerNotes)); }, [managerNotes]);

  const save = async (updated: NoteEntry[]) => {
    setSaving(true);
    try {
      await api.updateUser(employeeId, { managerNotes: JSON.stringify(updated) });
      setNotes(updated);
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleAdd = async () => {
    if (!draft.trim()) return;
    const entry: NoteEntry = { date: new Date().toISOString().slice(0, 10), text: draft.trim() };
    const updated = [entry, ...notes];
    await save(updated);
    setDraft("");
    setDrafting(false);
  };

  const handleDelete = async (idx: number) => {
    const updated = notes.filter((_, i) => i !== idx);
    await save(updated);
  };

  const fmtDate = (d: string) => {
    if (!d) return "—";
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y}`;
  };

  return (
    <div className={sectionClass}>
      <div className="flex items-center justify-between mb-[var(--space-md)]">
        <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">Notes</p>
        {!drafting && (
          <button
            onClick={() => setDrafting(true)}
            className="text-[length:var(--text-xs)] font-bold text-muted-foreground hover:text-foreground transition-colors px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 hover:border-foreground/40"
          >
            + Nouvelle note
          </button>
        )}
      </div>

      {drafting && (
        <div className="mb-[var(--space-md)]">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Écrire une note..."
            className="w-full rounded border border-border bg-background px-3 py-2 text-[length:var(--text-sm)] text-foreground resize-none"
            rows={3}
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              onClick={() => { setDrafting(false); setDraft(""); }}
              className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors"
            >
              Annuler
            </button>
            <button
              onClick={handleAdd}
              disabled={saving || !draft.trim()}
              className="text-[length:var(--text-xs)] font-bold text-foreground bg-muted px-3 py-1 rounded hover:bg-muted/80 transition-colors disabled:opacity-50"
            >
              {saving ? "..." : "Enregistrer"}
            </button>
          </div>
        </div>
      )}

      {notes.length === 0 && !drafting && (
        <p className="text-[length:var(--text-sm)] text-muted-foreground">Aucune note</p>
      )}

      <div className="space-y-[var(--space-sm)]">
        {notes.map((note, i) => (
          <div key={i} className="group flex items-start gap-[var(--space-sm)]">
            <div className="flex-1">
              <p className="text-[length:var(--text-sm)] whitespace-pre-wrap">{note.text} <span className="text-[9px] font-mono text-muted-foreground/50">{fmtDate(note.date)}</span></p>
            </div>
            <button
              onClick={() => handleDelete(i)}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all text-[length:var(--text-xs)] shrink-0 mt-1"
              title="Supprimer"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
