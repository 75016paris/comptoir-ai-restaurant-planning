import React, { useEffect, useState } from "react";
import { api, type User, type Document, type DocumentBlob, type HolidayRequest, type ReplacementRequest, type WorkerPreferredDay, type WorkerRestriction, type RestrictionRequest, type WorkerChecklist, type ChecklistItem, type RequirementKey } from "@/lib/api";
import { uploadUserDocumentFile } from "@/lib/document-upload";
import { documentSrc } from "@/lib/document-view";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordAdvice } from "@/components/password-advice";
import { fmtDateFR } from "@/lib/date-utils";
import { formatPhone, cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const DAYS_SHORT = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];
const TIME_BUCKETS: Array<{ key: "midi" | "soir"; label: string }> = [
 { key: "midi", label: "< 14H" },
 { key: "soir", label: "≥ 14H" },
];

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

function formatFileSize(bytes: number): string {
 if (bytes < 1024) return `${bytes}B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
 return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function MyProfilePage() {
 const { t } = useTranslation("roles");
 const { user: authUser } = useAuth();
 const id = authUser?.id;

 const [me, setMe] = useState<User | null>(null);
 const [loading, setLoading] = useState(true);
 const [editing, setEditing] = useState(false);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");

 // Editable contact fields
 const [phone, setPhone] = useState("");
 const [email, setEmail] = useState("");
 const [address, setAddress] = useState("");
 const [iban, setIban] = useState("");
 const [emergencyContact, setEmergencyContact] = useState("");
 const [emergencyPhone, setEmergencyPhone] = useState("");
 const [dateOfBirth, setDateOfBirth] = useState("");
 const [birthPlace, setBirthPlace] = useState("");
 const [nationality, setNationality] = useState("");
 const [nir, setNir] = useState("");

 // Documents
 const [documents, setDocuments] = useState<Document[]>([]);

 // Onboarding checklist (employee-side)
 const [checklist, setChecklist] = useState<WorkerChecklist | null>(null);
 const [uploadingKey, setUploadingKey] = useState<RequirementKey | null>(null);

 async function refreshChecklist() {
  if (!id) return;
  try {
   const res = await api.getUserChecklist(id);
   setChecklist(res.data);
  } catch { /* ignore — admin may not have enabled checklist yet */ }
 }

 async function handleChecklistUpload(e: React.ChangeEvent<HTMLInputElement>, item: ChecklistItem) {
  const file = e.target.files?.[0];
  if (!file || !id) return;
  if (file.size > 5 * 1024 * 1024) { setError("Fichier trop volumineux (max 5 Mo)"); return; }
  setUploadingKey(item.key);
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
   const [docsRes] = await Promise.all([api.getUserDocuments(id), refreshChecklist()]);
   setDocuments(docsRes.data);
  } catch (err) {
   setError(err instanceof Error ? err.message : "Échec du téléchargement");
  } finally {
   setUploadingKey(null);
   e.target.value = "";
  }
 }
 const [uploading, setUploading] = useState(false);
 const [viewingDoc, setViewingDoc] = useState<DocumentBlob | null>(null);

 // Holidays / replacements history
 const [holidays, setHolidays] = useState<HolidayRequest[]>([]);
 const [replacements, setReplacements] = useState<ReplacementRequest[]>([]);

 // Preferred schedule (2-bucket: midi/soir per day) — gated by workerPreferencesEnabled
 const [prefEnabled, setPrefEnabled] = useState(false);
 const [preferred, setPreferred] = useState<WorkerPreferredDay[]>([]);
 const [prefDirty, setPrefDirty] = useState(false);
 const [prefSaving, setPrefSaving] = useState(false);
 const [openDays, setOpenDays] = useState<Record<string, "both" | "midi" | "soir">>({});

 // Disponibilités (read-only current state) + request flow
 const [restrictions, setRestrictions] = useState<WorkerRestriction[]>([]);
 const [restrictionRequests, setRestrictionRequests] = useState<RestrictionRequest[]>([]);
 const [showRequestModal, setShowRequestModal] = useState(false);

 useEffect(() => {
 if (!id) return;
 setLoading(true);
 Promise.all([
 api.getUser(id),
 api.getUserDocuments(id),
 api.listHolidays(),
 api.allReplacements(),
 api.getPreferredSchedule(id),
 api.getOpenDays(),
 api.getWorkerConfig(),
 api.getRestrictions(id),
 api.listRestrictionRequests(),
 api.getUserChecklist(id).catch(() => ({ data: null as WorkerChecklist | null })),
 ]).then(([userRes, docsRes, holidaysRes, replacementsRes, prefRes, openDaysRes, configRes, restrRes, rreqRes, checklistRes]) => {
 setChecklist(checklistRes.data);
 setPrefEnabled(!!configRes.data.workerPreferencesEnabled);
 setRestrictions(restrRes.data);
 setRestrictionRequests(rreqRes.data);
 const u = userRes.data;
 setMe(u);
 setPhone(u.phone || "");
 setEmail(u.email || "");
 setAddress(u.address || "");
 setIban(u.iban || "");
 setEmergencyContact(u.emergencyContact || "");
 setEmergencyPhone(u.emergencyPhone || "");
 setDateOfBirth(u.dateOfBirth || "");
 setBirthPlace(u.birthPlace || "");
 setNationality(u.nationality || "");
 setNir(u.nir || "");
 setDocuments(docsRes.data);
 setHolidays(holidaysRes.data.filter((h) => h.workerId === id));
 setReplacements(replacementsRes.data.filter((s) => s.requesterId === id || s.targetId === id));
 setOpenDays(openDaysRes.data);
 // Build full 7-day preferred grid, carrying over existing matin/midi/soir keys only
 const prefMap = new Map(prefRes.data.map((d) => [d.dayOfWeek, d]));
 const prefFull: WorkerPreferredDay[] = [];
 for (let day = 1; day <= 7; day++) {
 const existing = prefMap.get(day);
 prefFull.push({
 dayOfWeek: day,
 midi: !!existing?.midi,
 soir: !!existing?.soir,
 });
 }
 setPreferred(prefFull);
 }).catch((e) => {
 console.error(e);
 setError("Impossible de charger le profil");
 }).finally(() => setLoading(false));
 }, [id]);

 const togglePrefBucket = (dayIndex: number, bucket: "midi" | "soir") => {
 setPreferred((prev) => prev.map((d, i) => {
 if (i !== dayIndex) return d;
 return { ...d, [bucket]: !d[bucket] };
 }));
 setPrefDirty(true);
 };

 const savePreferred = async () => {
 if (!id) return;
 setPrefSaving(true);
 try {
 await api.updatePreferredSchedule(id, preferred);
 setPrefDirty(false);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec de l'enregistrement des préférences");
 } finally {
 setPrefSaving(false);
 }
 };

 const handleSaveContact = async () => {
 setSaving(true);
 setError("");
 try {
 await api.updateMyProfile({
 phone: phone || undefined,
 email: email || undefined,
 address: address || null,
 iban: iban || null,
 emergencyContact: emergencyContact || null,
 emergencyPhone: emergencyPhone || null,
 dateOfBirth: dateOfBirth || null,
 birthPlace: birthPlace || null,
 nationality: nationality || null,
 nir: nir || null,
 });
 setMe((prev) => prev ? { ...prev, phone, email, address, iban, emergencyContact, emergencyPhone, dateOfBirth, birthPlace, nationality, nir } : prev);
 setEditing(false);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec de l'enregistrement");
 } finally {
 setSaving(false);
 }
 };

 const handleOtSliderChange = async (val: number) => {
 if (!me) return;
 const contractH = me.contractHours ?? 35;
 const maxH = val <= contractH ? null : val;
 const willing = maxH !== null;
 setMe({ ...me, maxWeeklyHours: maxH, overtimeWilling: willing });
 try {
 await api.updateMyProfile({ maxWeeklyHours: maxH, overtimeWilling: willing });
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec de l'enregistrement");
 }
 };

 const handleMultiRestaurantToggle = async (val: boolean) => {
 if (!me) return;
 const previous = me.multiRestaurantWilling;
 setMe({ ...me, multiRestaurantWilling: val });
 setError("");
 try {
 await api.updateMyProfile({ multiRestaurantWilling: val });
 } catch (err: unknown) {
 setMe((prev) => prev ? { ...prev, multiRestaurantWilling: previous } : prev);
 setError(err instanceof Error ? err.message : "Échec de l'enregistrement");
 }
 };

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
 if (!id || !confirm("Supprimer ce document ?")) return;
 try {
 await api.deleteUserDocument(id, docId);
 setDocuments((prev) => prev.filter((d) => d.id !== docId));
 if (viewingDoc?.id === docId) setViewingDoc(null);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : "Échec de la suppression");
 }
 }

 if (loading) return <p className="text-muted-foreground text-[length:var(--text-sm)] tracking-wide">Chargement...</p>;
 if (!me) return <p className="text-destructive font-bold">Profil introuvable</p>;

 const inputClass = "border-foreground/20 bg-transparent text-[length:var(--text-sm)]";
 const labelClass = "text-[length:var(--text-xs)] tracking-wide font-semibold text-muted-foreground";
 const sectionClass = "border-b border-foreground/20 pb-[var(--space-lg)] -mx-[var(--space-md)] px-[var(--space-md)] md:-mx-[var(--space-lg)] md:px-[var(--space-lg)]";

 const contractH = me.contractHours ?? 35;
 const currentMax = me.maxWeeklyHours ?? contractH;

 return (
 <div className="space-y-[var(--space-xl)]" style={{ maxWidth: "610px" }}>
 {/* Header */}
 <div className="sticky top-[40px] md:top-[46px] z-30 bg-background py-[var(--space-sm)] -mt-[var(--space-sm)]">
 <h1 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em]">
 Mon profil
 </h1>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
 {me.name} · {t(me.role, { defaultValue: me.role })}
 </p>
 </div>

 {error && <p className="text-destructive text-[length:var(--text-sm)] font-medium">{error}</p>}

 {/* Identité & contrat (read-only) */}
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-lg)]">Identité & contrat</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-md)] text-[length:var(--text-sm)]">
 <div>
 <p className={labelClass}>Nom</p>
 <p className="font-medium">{me.name}</p>
 </div>
 <div>
 <p className={labelClass}>Rôle</p>
 <p className="font-medium">{t(me.role, { defaultValue: me.role })}</p>
 </div>
 <div>
 <p className={labelClass}>Contrat</p>
 <p className="font-medium">
 {me.contractType ?? "—"}
 {me.contractHours ? ` · ${me.contractHours}h/sem` : ""}
 </p>
 {me.contractEndDate && (
 <p className="text-[length:var(--text-xs)] text-muted-foreground">jusqu'au {fmtDateFR(me.contractEndDate)}</p>
 )}
 </div>
 {me.subRoles && me.subRoles.length > 0 && (
 <div className="sm:col-span-2">
 <p className={labelClass}>Compétences</p>
 <div className="flex flex-wrap gap-1.5 mt-[var(--space-xs)]">
 {me.subRoles.map((sr) => (
 <span key={sr} className="px-2 py-0.5 rounded-full text-[length:var(--text-xs)] font-medium border bg-foreground text-background border-foreground">
 {sr}
 </span>
 ))}
 </div>
 </div>
 )}
 {me.matricule && (
 <div>
 <p className={labelClass}>Matricule</p>
 <p className="font-mono text-[length:var(--text-xs)]">{me.matricule}</p>
 </div>
 )}
 {me.startDate && (
 <div>
 <p className={labelClass}>Entrée</p>
 <p className="font-medium">{fmtDateFR(me.startDate)}</p>
 </div>
 )}
 </div>
 <p className="text-[length:var(--text-xs)] text-muted-foreground/70 mt-[var(--space-md)]">
 Ces informations sont gérées par votre gérant.
 </p>
 </div>

 {/* Coordonnées (editable) */}
 <div className={sectionClass}>
 <div className="flex items-center justify-between mb-[var(--space-lg)]">
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">Coordonnées</p>
 {!editing ? (
 <button onClick={() => setEditing(true)} className="text-[length:var(--text-xs)] tracking-wide font-bold border border-foreground/20 hover:border-foreground hover:bg-foreground/5 rounded-full px-[var(--space-md)] py-[var(--space-xs)] transition-colors cursor-pointer">
 Modifier
 </button>
 ) : (
 <div className="flex gap-[var(--space-sm)]">
 <button
 onClick={() => {
 setEditing(false);
 setPhone(me.phone || "");
 setEmail(me.email || "");
 setAddress(me.address || "");
 setIban(me.iban || "");
 setEmergencyContact(me.emergencyContact || "");
 setEmergencyPhone(me.emergencyPhone || "");
 setDateOfBirth(me.dateOfBirth || "");
 setBirthPlace(me.birthPlace || "");
 setNationality(me.nationality || "");
 setNir(me.nir || "");
 }}
 className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground border border-foreground/15 hover:text-foreground hover:border-foreground/30 rounded-full px-[var(--space-md)] py-[var(--space-xs)] transition-colors cursor-pointer"
 >
 Annuler
 </button>
 <button
 onClick={handleSaveContact}
 disabled={saving}
 className="text-[length:var(--text-xs)] tracking-wide font-bold text-background bg-foreground border border-foreground hover:bg-foreground/90 rounded-full px-[var(--space-md)] py-[var(--space-xs)] disabled:opacity-50 transition-colors cursor-pointer"
 >
 {saving ? "Enregistrement..." : "Enregistrer"}
 </button>
 </div>
 )}
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-md)]">
 <div>
 <Label className={labelClass}>E-mail</Label>
 {editing ? (
 <Input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@example.com" />
 ) : (
 <p className="font-mono text-[length:var(--text-xs)] break-all">{me.email}</p>
 )}
 </div>
 <div>
 <Label className={labelClass}>Téléphone</Label>
 {editing ? (
 <Input className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+33 6 12 34 56 78" />
 ) : (
 <p className="font-mono text-[length:var(--text-sm)]">{formatPhone(me.phone ?? "") || "—"}</p>
 )}
 </div>
 <div className="sm:col-span-2">
 <Label className={labelClass}>Adresse</Label>
 {editing ? (
 <Input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="12 rue..." />
 ) : (
 <p className="text-[length:var(--text-sm)]">{me.address || "—"}</p>
 )}
 </div>
 <div>
 <Label className={labelClass}>IBAN</Label>
 {editing ? (
 <Input className={inputClass} value={iban} onChange={(e) => setIban(e.target.value)} placeholder="FR76..." />
 ) : (
 <p className="font-mono text-[length:var(--text-xs)]">{me.iban || "—"}</p>
 )}
 </div>
 <div className="sm:col-span-2 mt-[var(--space-sm)]">
 <p className={labelClass}>Urgence</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-md)] mt-[var(--space-xs)]">
 <div>
 <Label className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground/60">Contact</Label>
 {editing ? (
 <Input className={inputClass} value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)} placeholder="Prénom Nom" />
 ) : (
 <p className="text-[length:var(--text-sm)]">{me.emergencyContact || "—"}</p>
 )}
 </div>
 <div>
 <Label className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground/60">Téléphone</Label>
 {editing ? (
 <Input className={inputClass} value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} placeholder="+33..." />
 ) : (
 <p className="font-mono text-[length:var(--text-sm)]">{formatPhone(me.emergencyPhone ?? "") || "—"}</p>
 )}
 </div>
 </div>
 </div>
 <div className="sm:col-span-2 mt-[var(--space-sm)]">
 <p className={labelClass}>État civil — DPAE / URSSAF</p>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground/70 mt-[var(--space-xs)]">Requis pour la déclaration préalable d'embauche (Code du travail L1221-10).</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-md)] mt-[var(--space-sm)]">
 <div>
 <Label className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground/60">Date de naissance</Label>
 {editing ? (
 <Input className={inputClass} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
 ) : (
 <p className="font-mono text-[length:var(--text-sm)]">{me.dateOfBirth || "—"}</p>
 )}
 </div>
 <div>
 <Label className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground/60">Lieu de naissance</Label>
 {editing ? (
 <Input className={inputClass} value={birthPlace} onChange={(e) => setBirthPlace(e.target.value)} placeholder="Paris, France" />
 ) : (
 <p className="text-[length:var(--text-sm)]">{me.birthPlace || "—"}</p>
 )}
 </div>
 <div>
 <Label className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground/60">Nationalité</Label>
 {editing ? (
 <Input className={inputClass} value={nationality} onChange={(e) => setNationality(e.target.value)} placeholder="Française" />
 ) : (
 <p className="text-[length:var(--text-sm)]">{me.nationality || "—"}</p>
 )}
 </div>
 <div>
 <Label className="text-[length:var(--text-2xs)] tracking-wide text-muted-foreground/60">Numéro de sécurité sociale (NIR)</Label>
 {editing ? (
 <Input className={inputClass} value={nir} onChange={(e) => setNir(e.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="13 chiffres + 2 clé" inputMode="numeric" />
 ) : (
 <p className="font-mono text-[length:var(--text-xs)]">{me.nir ? `${"•".repeat(Math.max(0, me.nir.length - 4))}${me.nir.slice(-4)}` : "—"}</p>
 )}
 </div>
 </div>
 </div>
 </div>
 </div>

 {/* Disponibilités — read-only display + request change flow */}
 <div className={sectionClass}>
 <div className="flex items-center justify-between mb-[var(--space-md)]">
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">Disponibilités</p>
 <button
 onClick={() => setShowRequestModal(true)}
 className="text-[length:var(--text-xs)] tracking-wide font-bold border border-foreground/20 hover:border-foreground hover:bg-foreground/5 rounded-full px-[var(--space-md)] py-[var(--space-xs)] transition-colors cursor-pointer"
 >
 Demander un changement
 </button>
 </div>
 {restrictions.length === 0 ? (
 <p className="text-[length:var(--text-xs)] text-muted-foreground">
 Vous êtes disponible tous les jours d'ouverture du restaurant.
 </p>
 ) : (
 <>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground mb-[var(--space-md)]">
 {restrictions.length} restriction{restrictions.length > 1 ? "s" : ""} configurée{restrictions.length > 1 ? "s" : ""}
 </p>
 <div className="grid grid-cols-7 gap-[var(--space-xs)]">
 {DAYS_SHORT.map((lbl, i) => {
 const day = i + 1;
 const dayOpen = openDays[String(day)];
 const dayRestr = restrictions.filter(r => r.dayOfWeek === day);
 const fullDay = dayRestr.some(r => !r.startTime && !r.endTime);
 return (
 <div key={lbl} className={cn(
 "border rounded-[0.2rem] px-[2px] py-[var(--space-xs)] flex flex-col items-center justify-center",
 !dayOpen ? "opacity-30 border-foreground/10"
 : fullDay ? "border-red-400/40 bg-red-500/10"
 : dayRestr.length > 0 ? "border-amber-400/40 bg-amber-500/10"
 : "border-foreground/10"
 )} style={{ minHeight: 44 }}>
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground">{lbl}</span>
 <span className="text-[length:var(--text-2xs)] mt-[2px] font-medium">
 {!dayOpen ? "Fermé" : fullDay ? "Bloqué" : dayRestr.length > 0 ? "Partiel" : "✓"}
 </span>
 </div>
 );
 })}
 </div>
 {/* Detail of time-windowed restrictions */}
 {restrictions.filter(r => r.startTime && r.endTime).length > 0 && (
 <ul className="mt-[var(--space-md)] space-y-[2px]">
 {restrictions.filter(r => r.startTime && r.endTime).map((r, i) => (
 <li key={i} className="text-[length:var(--text-2xs)] text-muted-foreground font-mono">
 {DAYS_SHORT[r.dayOfWeek - 1]} {r.startTime} → {r.endTime}
 {r.effectiveFrom && r.effectiveUntil && (
 <span className="ml-[var(--space-sm)] text-foreground/60">
 ({fmtDateFR(r.effectiveFrom)} → {fmtDateFR(r.effectiveUntil)})
 </span>
 )}
 {r.reason && <span className="ml-[var(--space-sm)] text-muted-foreground/60">— {r.reason}</span>}
 </li>
 ))}
 </ul>
 )}
 </>
 )}
 {/* Pending / history requests */}
 {restrictionRequests.length > 0 && (
 <div className="mt-[var(--space-lg)] pt-[var(--space-md)] border-t border-foreground/10">
 <p className="text-[length:var(--text-2xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-xs)]">Mes demandes</p>
 <ul className="space-y-[var(--space-xs)]">
 {restrictionRequests.slice(0, 5).map((req) => (
 <li key={req.id} className="flex items-center justify-between text-[length:var(--text-xs)]">
 <div>
 <span className="font-medium">{req.kind === "permanent" ? "Permanente" : `${fmtDateFR(req.effectiveFrom!)} → ${fmtDateFR(req.effectiveUntil!)}`}</span>
 {req.note && <span className="ml-[var(--space-sm)] text-muted-foreground">— {req.note}</span>}
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className={cn("text-[length:var(--text-2xs)] tracking-wide font-bold border px-1.5 py-0 rounded", STATUS_STYLE[req.status] ?? "")}>
 {STATUS_LABEL[req.status] ?? req.status}
 </span>
 {req.status === "pending" && (
 <button
 onClick={async () => {
 try {
 await api.cancelRestrictionRequest(req.id);
 setRestrictionRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: "cancelled" } : r));
 } catch (err) { setError(err instanceof Error ? err.message : "Erreur"); }
 }}
 className="text-[length:var(--text-2xs)] text-muted-foreground/60 hover:text-red-400 cursor-pointer"
 >
 annuler
 </button>
 )}
 </div>
 </li>
 ))}
 </ul>
 </div>
 )}
 </div>

 {/* Préférences employé */}
 {(
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-lg)]">Préférences de planning</p>

 {/* Heures max / semaine (OT slider) */}
 <div className="flex items-center justify-between mb-1">
 <span className="text-[length:var(--text-sm)] font-medium">Heures max / semaine</span>
 <span className="text-[length:var(--text-sm)] font-bold font-mono">
 {currentMax}h
 {!me.maxWeeklyHours && <span className="text-muted-foreground font-normal text-[length:var(--text-xs)] ml-1">(contrat)</span>}
 </span>
 </div>
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-2xs)] text-muted-foreground font-mono shrink-0">{contractH}h</span>
 <input
 type="range"
 min={contractH}
 max={48}
 step={1}
 value={currentMax}
 onChange={(e) => handleOtSliderChange(parseInt(e.target.value))}
 className="flex-1 accent-foreground cursor-pointer"
 />
 <span className="text-[length:var(--text-2xs)] text-muted-foreground font-mono shrink-0">48h</span>
 </div>

 {/* Coupures — worker accepts split shifts */}
 <div className="mt-[var(--space-lg)]">
 <label className="flex items-center gap-[var(--space-sm)] cursor-pointer group">
 <input
 type="checkbox"
 checked={!!me.coupureWilling}
 onChange={async (e) => {
 const val = e.target.checked;
 setMe((prev) => prev ? { ...prev, coupureWilling: val } : prev);
 try { await api.updateMyProfile({ coupureWilling: val }); }
 catch (err) { setError(err instanceof Error ? err.message : "Échec de l'enregistrement"); }
 }}
 className="w-4 h-4 accent-foreground rounded-sm cursor-pointer"
 />
 <span className="text-[length:var(--text-sm)] font-medium group-hover:text-foreground transition-colors">J'accepte les coupures</span>
 </label>
 </div>

 {/* Multi-restaurant — employee opt-in gate */}
 <div className="mt-[var(--space-lg)] pt-[var(--space-md)] border-t border-foreground/10">
 <label className="flex items-start gap-[var(--space-sm)] cursor-pointer group">
 <input
 type="checkbox"
 checked={me.multiRestaurantWilling !== false}
 onChange={(e) => handleMultiRestaurantToggle(e.target.checked)}
 className="w-4 h-4 accent-foreground rounded-sm cursor-pointer mt-[2px]"
 />
 <span className="flex-1">
 <span className="block text-[length:var(--text-sm)] font-medium group-hover:text-foreground transition-colors">
 J'autorise mon employeur à me proposer dans un autre établissement du même compte
 </span>
 <span className="block text-[length:var(--text-2xs)] text-muted-foreground mt-1">
 Activé par défaut. Le responsable choisit ensuite les établissements précis; vos documents, notes et paramètres RH restent séparés.
 </span>
 </span>
 </label>
 </div>

 {/* Créneaux préférés — 3-bucket grid (matin/midi/soir × 7 days) */}
 {prefEnabled ? (
 <div className="mt-[var(--space-lg)]">
 <div className="flex items-center justify-between mb-[var(--space-sm)]">
 <p className="text-[length:var(--text-sm)] font-medium">Créneaux préférés</p>
 {prefDirty && (
 <button
 onClick={savePreferred}
 disabled={prefSaving}
 className="text-[length:var(--text-xs)] tracking-wide font-bold hover:underline underline-offset-4 disabled:opacity-50 cursor-pointer"
 >
 {prefSaving ? "Enregistrement..." : "Enregistrer"}
 </button>
 )}
 </div>
 <div className="grid grid-cols-7 gap-[var(--space-xs)]">
 {DAYS_SHORT.map((d) => (
 <div key={d} className="text-center text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground pb-[var(--space-xs)]">
 {d}
 </div>
 ))}
 {preferred.map((d, i) => {
 const day = i + 1;
 const dayOpen = openDays[String(day)];
 const closed = !dayOpen;
 if (closed) {
 return (
 <div key={i} className="flex flex-col items-center justify-center opacity-30" style={{ minHeight: 80 }}>
 <span className="text-[length:var(--text-2xs)] tracking-wide font-bold text-muted-foreground">FERMÉ</span>
 </div>
 );
 }
 return (
 <div key={i} className="flex flex-col gap-[2px]">
 {TIME_BUCKETS.map((bucket) => {
 const active = !!d[bucket.key];
 return (
 <button
 key={bucket.key}
 type="button"
 onClick={() => togglePrefBucket(i, bucket.key)}
 className={cn(
 "rounded-[0.2rem] border-dashed border-2 transition-colors px-[2px] flex items-center justify-center",
 active
 ? "bg-foreground/15 border-foreground/40"
 : "border-foreground/10 hover:border-foreground/20"
 )}
 style={{ height: 24 }}
 >
 <span className={cn(
 "text-[length:var(--text-2xs)] uppercase tracking-widest font-bold",
 active ? "text-foreground/70" : "text-muted-foreground/40"
 )}>
 {bucket.label}
 </span>
 </button>
 );
 })}
 </div>
 );
 })}
 </div>
 <p className="text-[length:var(--text-2xs)] text-muted-foreground/70 mt-[var(--space-xs)]">
 Avant 14h · Après 14h.
 </p>
 </div>
 ) : (
 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[var(--space-lg)] pt-[var(--space-md)] border-t border-foreground/10">
 Les créneaux préférés sont désactivés par le restaurant, mais vos préférences d'heures et de coupure restent visibles.
 </p>
 )}

 <p className="text-[length:var(--text-2xs)] text-muted-foreground mt-[var(--space-lg)] pt-[var(--space-md)] border-t border-foreground/10">
 Ces préférences sont transmises à votre manager et prises en compte dans l'élaboration du planning. Elles ne constituent toutefois pas un engagement d'application.
 </p>
 </div>
 )}

 {/* Onboarding checklist — employee-side view of required documents */}
 {checklist && checklist.items.length > 0 && (
   <div className={sectionClass}>
     <div className="flex items-center justify-between mb-[var(--space-sm)]">
       <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">
         Dossier à compléter
       </p>
       <span className={`text-[length:var(--text-xs)] font-bold ${
         checklist.readyForDpae ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
       }`}>
         {checklist.mandatoryValid}/{checklist.mandatoryTotal} obligatoires
         {checklist.readyForDpae && " ✓ complet"}
       </span>
     </div>
     <div className="h-[4px] bg-foreground/10 rounded-full overflow-hidden mb-[var(--space-md)]">
       <div
         className={`h-full transition-all ${checklist.readyForDpae ? "bg-emerald-500" : "bg-foreground"}`}
         style={{ width: `${checklist.percentComplete}%` }}
       />
     </div>
     <p className="text-[length:var(--text-xs)] text-muted-foreground mb-[var(--space-sm)]">
       Tu peux aussi m'envoyer tes documents directement par WhatsApp — ils arriveront dans ton dossier automatiquement.
     </p>
     <div className="space-y-[var(--space-xs)]">
       {checklist.items.filter(i => i.mandatory || i.status !== "missing").map(item => {
         const badge = item.status === "valid" ? { text: "✓", cls: "text-emerald-600 dark:text-emerald-400" }
           : item.status === "expiring_soon" ? { text: "⚠", cls: "text-amber-600 dark:text-amber-400" }
           : item.status === "expired" ? { text: "✗", cls: "text-rose-600 dark:text-rose-400" }
           : item.status === "uploaded" ? { text: "●", cls: "text-sky-600 dark:text-sky-400" }
           : { text: item.mandatory ? "◯" : "·", cls: "text-muted-foreground" };
         const isUploading = uploadingKey === item.key;
         return (
           <div key={item.key} className="flex items-center gap-[var(--space-xs)]">
             <span className={`text-[length:var(--text-sm)] font-bold w-[14px] text-center ${badge.cls}`}>{badge.text}</span>
             <div className="flex-1 min-w-0">
               <span className="text-[length:var(--text-sm)] font-medium">{item.label}</span>
               {!item.mandatory && <span className="text-[length:var(--text-2xs)] text-muted-foreground ml-[var(--space-xs)]">facultatif</span>}
               {item.hint && <p className="text-[length:var(--text-xs)] text-muted-foreground">{item.hint}</p>}
             </div>
             <label className={`cursor-pointer text-[length:var(--text-xs)] font-bold px-[var(--space-sm)] py-[2px] rounded-[0.2rem] border border-foreground/20 hover:border-foreground/40 text-muted-foreground transition-colors whitespace-nowrap ${isUploading ? "opacity-50 pointer-events-none" : ""}`}>
               {isUploading ? "..." : item.status === "missing" ? "+ Ajouter" : "Remplacer"}
               <input type="file" className="hidden" onChange={(e) => handleChecklistUpload(e, item)} accept=".pdf,.jpg,.jpeg,.png,.webp" />
             </label>
           </div>
         );
       })}
     </div>
   </div>
 )}

 {/* Documents */}
 <div className={sectionClass}>
 <div className="flex items-center justify-between mb-[var(--space-md)]">
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">Mes documents</p>
 <label className={`cursor-pointer text-[length:var(--text-xs)] tracking-wide font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground/20 hover:border-foreground/40 text-muted-foreground transition-colors ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
 {uploading ? "..." : "+ Télécharger"}
 <input type="file" className="hidden" disabled={uploading} onChange={handleFileUpload} />
 </label>
 </div>
 {documents.length === 0 ? (
 <p className="text-[length:var(--text-xs)] text-muted-foreground/60">Aucun document.</p>
 ) : (
 <ul className="space-y-[var(--space-xs)]">
 {documents.map((doc) => (
 <li key={doc.id} className="flex items-center justify-between gap-[var(--space-sm)] py-[var(--space-xs)]">
 <button
 onClick={() => handleViewDoc(doc)}
 className="flex-1 text-left flex items-center gap-[var(--space-sm)] cursor-pointer group"
 >
 <span className="text-[length:var(--text-2xs)] tracking-widest font-bold text-muted-foreground bg-foreground/5 border border-foreground/10 rounded px-1.5 py-0 shrink-0">
 {DOC_TYPE_LABELS[doc.type] ?? doc.type.toUpperCase()}
 </span>
 <span className="text-[length:var(--text-sm)] group-hover:underline underline-offset-4">{doc.name}</span>
 <span className="text-[length:var(--text-2xs)] text-muted-foreground/60 font-mono ml-auto shrink-0">{formatFileSize(doc.size)}</span>
 </button>
 <button onClick={() => handleDeleteDoc(doc.id)} className="text-muted-foreground/40 hover:text-red-400 text-[length:var(--text-xs)] cursor-pointer">
 supprimer
 </button>
 </li>
 ))}
 </ul>
 )}
 </div>

 {/* Sécurité — changer mon mot de passe */}
 <div className={sectionClass}>
 <ChangePasswordCard />
 </div>

 {/* Historique — congés */}
 {holidays.length > 0 && (
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-md)]">Mes congés ({holidays.length})</p>
 <ul className="space-y-[var(--space-xs)]">
 {holidays.slice(0, 10).map((h) => (
 <li key={h.id} className="flex items-center justify-between py-[var(--space-xs)] text-[length:var(--text-sm)]">
 <span>
 {fmtDateFR(h.startDate)} → {fmtDateFR(h.endDate)}
 </span>
 <span className={`text-[length:var(--text-2xs)] tracking-wide font-bold border px-1.5 py-0 rounded ${STATUS_STYLE[h.status] ?? ""}`}>
 {STATUS_LABEL[h.status] ?? h.status}
 </span>
 </li>
 ))}
 </ul>
 </div>
 )}

 {/* Historique — remplacements */}
 {replacements.length > 0 && (
 <div className={sectionClass}>
 <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground mb-[var(--space-md)]">Mes remplacements ({replacements.length})</p>
 <ul className="space-y-[var(--space-xs)]">
 {replacements.slice(0, 10).map((s) => (
 <li key={s.id} className="flex items-center justify-between py-[var(--space-xs)] text-[length:var(--text-sm)]">
 <span>Demande du {fmtDateFR(s.createdAt.slice(0, 10))}</span>
 <span className={`text-[length:var(--text-2xs)] tracking-wide font-bold border px-1.5 py-0 rounded ${STATUS_STYLE[s.status] ?? ""}`}>
 {STATUS_LABEL[s.status] ?? s.status}
 </span>
 </li>
 ))}
 </ul>
 </div>
 )}

 {/* Restriction change request modal */}
 {showRequestModal && (
 <RestrictionRequestModal
 restaurantOpenDays={openDays}
 currentRestrictions={restrictions}
 onClose={() => setShowRequestModal(false)}
 onSubmit={async (payload) => {
 try {
 const res = await api.createRestrictionRequest(payload);
 setRestrictionRequests((prev) => [res.data, ...prev]);
 setShowRequestModal(false);
 } catch (err) {
 setError(err instanceof Error ? err.message : "Échec de l'envoi");
 }
 }}
 />
 )}

 {/* Document viewer modal */}
 {viewingDoc && (
 <div className="fixed inset-0 bg-background/95 z-50 flex flex-col p-[var(--space-lg)]" onClick={() => setViewingDoc(null)}>
 <div className="flex items-center justify-between mb-[var(--space-md)]">
 <p className="font-bold">{viewingDoc.name}</p>
 <button onClick={() => setViewingDoc(null)} className="text-muted-foreground hover:text-foreground">Fermer</button>
 </div>
 <div className="flex-1 overflow-auto" onClick={(e) => e.stopPropagation()}>
 {viewingDoc.mimeType.startsWith("image/") ? (
 <img src={documentSrc(viewingDoc)} alt={viewingDoc.name} className="max-w-full" />
 ) : (
 <iframe src={documentSrc(viewingDoc)} className="w-full h-full" title={viewingDoc.name} />
 )}
 </div>
 </div>
 )}
 </div>
 );
}

// ── Restriction change request modal ──

type ModalProps = {
 restaurantOpenDays: Record<string, "both" | "midi" | "soir">;
 currentRestrictions: WorkerRestriction[];
 onClose: () => void;
 onSubmit: (payload: {
 kind: "permanent" | "temporary";
 effectiveFrom?: string | null;
 effectiveUntil?: string | null;
 restrictions: WorkerRestriction[];
 note?: string | null;
 }) => Promise<void>;
};

function RestrictionRequestModal({ restaurantOpenDays, currentRestrictions, onClose, onSubmit }: ModalProps) {
 const [kind, setKind] = useState<"permanent" | "temporary">("permanent");
 const [effectiveFrom, setEffectiveFrom] = useState("");
 const [effectiveUntil, setEffectiveUntil] = useState("");
 const [note, setNote] = useState("");
 const [restrictions, setRestrictions] = useState<WorkerRestriction[]>(
 () => currentRestrictions.filter(r => !r.effectiveFrom && !r.effectiveUntil).map(r => ({ ...r })),
 );
 const [submitting, setSubmitting] = useState(false);
 const [localError, setLocalError] = useState("");

 const addRestriction = (dayOfWeek: number, fullDay: boolean) => {
 const newR: WorkerRestriction = fullDay
 ? { dayOfWeek, startTime: null, endTime: null }
 : { dayOfWeek, startTime: "09:00", endTime: "14:00" };
 setRestrictions((prev) => [...prev, newR]);
 };
 const removeRestriction = (index: number) => {
 setRestrictions((prev) => prev.filter((_, i) => i !== index));
 };
 const updateField = (index: number, field: "startTime" | "endTime" | "reason", value: string) => {
 setRestrictions((prev) => prev.map((r, i) => i === index ? { ...r, [field]: value || null } : r));
 };

 const handleSubmit = async () => {
 setLocalError("");
 if (kind === "temporary") {
 if (!effectiveFrom || !effectiveUntil) {
 setLocalError("Choisissez une date de début et de fin.");
 return;
 }
 if (effectiveFrom > effectiveUntil) {
 setLocalError("La date de début doit être avant la date de fin.");
 return;
 }
 }
 setSubmitting(true);
 try {
 await onSubmit({
 kind,
 effectiveFrom: kind === "temporary" ? effectiveFrom : null,
 effectiveUntil: kind === "temporary" ? effectiveUntil : null,
 restrictions,
 note: note || null,
 });
 } catch (err) {
 setLocalError(err instanceof Error ? err.message : "Échec");
 } finally {
 setSubmitting(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-background/95 z-50 flex items-center justify-center p-[var(--space-md)]" onClick={onClose}>
 <div
 className="bg-background border border-foreground/20 rounded-lg p-[var(--space-lg)] w-full overflow-y-auto"
 style={{ maxWidth: 640, maxHeight: "90vh" }}
 onClick={(e) => e.stopPropagation()}
 >
 <div className="flex items-center justify-between mb-[var(--space-md)]">
 <h2 className="text-[length:var(--text-lg)] font-bold tracking-[-0.02em]">Demande de changement</h2>
 <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-[length:var(--text-sm)]">Annuler</button>
 </div>

 <p className="text-[length:var(--text-xs)] text-muted-foreground mb-[var(--space-md)]">
 Votre demande sera envoyée à votre manager. Elle ne prend effet qu'une fois approuvée.
 </p>

 {/* Kind */}
 <div className="mb-[var(--space-md)]">
 <p className="text-[length:var(--text-xs)] font-semibold text-muted-foreground mb-[var(--space-xs)]">Durée</p>
 <div className="flex gap-[var(--space-sm)]">
 <button
 onClick={() => setKind("permanent")}
 className={cn(
 "text-[length:var(--text-xs)] tracking-wide font-bold border rounded-full px-[var(--space-md)] py-[var(--space-xs)] transition-colors cursor-pointer",
 kind === "permanent" ? "bg-foreground text-background border-foreground" : "border-foreground/20 hover:border-foreground/40"
 )}
 >
 Permanente
 </button>
 <button
 onClick={() => setKind("temporary")}
 className={cn(
 "text-[length:var(--text-xs)] tracking-wide font-bold border rounded-full px-[var(--space-md)] py-[var(--space-xs)] transition-colors cursor-pointer",
 kind === "temporary" ? "bg-foreground text-background border-foreground" : "border-foreground/20 hover:border-foreground/40"
 )}
 >
 Temporaire
 </button>
 </div>
 </div>

 {/* Date range for temporary */}
 {kind === "temporary" && (
 <div className="mb-[var(--space-md)] grid grid-cols-2 gap-[var(--space-sm)]">
 <div>
 <Label className="text-[length:var(--text-xs)] text-muted-foreground">Du</Label>
 <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="mt-[var(--space-xs)]" />
 </div>
 <div>
 <Label className="text-[length:var(--text-xs)] text-muted-foreground">Au</Label>
 <Input type="date" value={effectiveUntil} onChange={(e) => setEffectiveUntil(e.target.value)} className="mt-[var(--space-xs)]" />
 </div>
 </div>
 )}

 {/* Restrictions editor */}
 <div className="mb-[var(--space-md)]">
 <p className="text-[length:var(--text-xs)] font-semibold text-muted-foreground mb-[var(--space-xs)]">Indisponibilités demandées</p>
 {restrictions.length === 0 ? (
 <p className="text-[length:var(--text-xs)] text-muted-foreground/70 mb-[var(--space-sm)]">Aucune restriction. Cliquez sur un jour pour ajouter.</p>
 ) : (
 <ul className="space-y-[var(--space-xs)] mb-[var(--space-sm)]">
 {restrictions.map((r, i) => (
 <li key={i} className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-xs)]">
 <span className="font-bold w-[28px] shrink-0">{DAYS_SHORT[r.dayOfWeek - 1]}</span>
 {!r.startTime && !r.endTime ? (
 <span className="flex-1 text-muted-foreground">Jour entier</span>
 ) : (
 <>
 <input type="time" value={r.startTime ?? ""} onChange={(e) => updateField(i, "startTime", e.target.value)} className="bg-transparent border border-foreground/10 rounded px-[4px] py-[1px] text-[length:var(--text-2xs)] w-[80px]" />
 <span className="text-muted-foreground/40">→</span>
 <input type="time" value={r.endTime ?? ""} onChange={(e) => updateField(i, "endTime", e.target.value)} className="bg-transparent border border-foreground/10 rounded px-[4px] py-[1px] text-[length:var(--text-2xs)] w-[80px]" />
 </>
 )}
 <input placeholder="Raison (optionnel)" value={r.reason ?? ""} onChange={(e) => updateField(i, "reason", e.target.value)} className="flex-1 bg-transparent border border-foreground/10 rounded px-[4px] py-[1px] text-[length:var(--text-2xs)]" />
 <button onClick={() => removeRestriction(i)} className="text-muted-foreground/40 hover:text-red-400 text-[length:var(--text-xs)] cursor-pointer">×</button>
 </li>
 ))}
 </ul>
 )}
 <div className="flex flex-wrap gap-[4px]">
 {DAYS_SHORT.map((lbl, i) => {
 const day = i + 1;
 const closed = !restaurantOpenDays[String(day)];
 if (closed) return null;
 return (
 <div key={day} className="flex gap-[2px]">
 <button type="button" onClick={() => addRestriction(day, false)}
 className="text-[length:9px] font-bold tracking-wide text-muted-foreground/50 hover:text-foreground/70 border border-dashed border-foreground/10 rounded-[0.2rem] px-[6px] py-[2px] transition-colors cursor-pointer">
 + {lbl}
 </button>
 </div>
 );
 })}
 </div>
 </div>

 {/* Note */}
 <div className="mb-[var(--space-lg)]">
 <Label className="text-[length:var(--text-xs)] text-muted-foreground">Justification (optionnel)</Label>
 <textarea
 value={note}
 onChange={(e) => setNote(e.target.value)}
 className="mt-[var(--space-xs)] w-full border border-foreground/20 bg-transparent rounded px-[var(--space-sm)] py-[var(--space-xs)] text-[length:var(--text-sm)]"
 rows={2}
 placeholder="Ex: garde enfant le mercredi..."
 />
 </div>

 {localError && <p className="text-destructive text-[length:var(--text-sm)] font-medium mb-[var(--space-sm)]">{localError}</p>}

 <div className="flex items-center justify-end gap-[var(--space-sm)]">
 <button onClick={onClose} className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground hover:text-foreground cursor-pointer">
 Annuler
 </button>
 <button
 onClick={handleSubmit}
 disabled={submitting}
 className="text-[length:var(--text-xs)] tracking-wide font-bold bg-foreground text-background rounded-full px-[var(--space-lg)] py-[var(--space-xs)] disabled:opacity-50 cursor-pointer"
 >
 {submitting ? "Envoi..." : "Envoyer la demande"}
 </button>
 </div>
 </div>
 </div>
 );
}

function ChangePasswordCard() {
 const [open, setOpen] = useState(false);
 const [currentPassword, setCurrentPassword] = useState("");
 const [newPassword, setNewPassword] = useState("");
 const [confirmPassword, setConfirmPassword] = useState("");
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");
 const [done, setDone] = useState(false);

 const reset = () => {
  setCurrentPassword("");
  setNewPassword("");
  setConfirmPassword("");
  setError("");
  setDone(false);
 };

 const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setError("");
  if (newPassword !== confirmPassword) {
   setError("Les mots de passe ne correspondent pas");
   return;
  }
  if (newPassword.length < 8) {
   setError("Le mot de passe doit contenir au moins 8 caractères");
   return;
  }
  if (newPassword === currentPassword) {
   setError("Le nouveau mot de passe doit être différent de l'ancien");
   return;
  }
  setSaving(true);
  try {
   await api.changeMyPassword(currentPassword, newPassword);
   setDone(true);
   setCurrentPassword("");
   setNewPassword("");
   setConfirmPassword("");
  } catch (err: unknown) {
   setError(err instanceof Error ? err.message : "Échec de l'enregistrement");
  } finally {
   setSaving(false);
  }
 };

 const inputClass = "border-foreground/20 bg-transparent text-[length:var(--text-sm)]";
 const labelClass = "text-[length:var(--text-xs)] tracking-wide font-semibold text-muted-foreground";

 return (
  <div>
   <div className="flex items-center justify-between">
    <p className="text-[length:var(--text-xs)] font-semibold tracking-wide text-muted-foreground">Mot de passe</p>
    {!open ? (
     <button
      onClick={() => { reset(); setOpen(true); }}
      className="text-[length:var(--text-xs)] tracking-wide font-bold border border-foreground/20 hover:border-foreground hover:bg-foreground/5 rounded-full px-[var(--space-md)] py-[var(--space-xs)] transition-colors cursor-pointer"
     >
      Changer
     </button>
    ) : (
     <button
      onClick={() => { reset(); setOpen(false); }}
      className="text-[length:var(--text-xs)] tracking-wide text-muted-foreground border border-foreground/15 hover:text-foreground hover:border-foreground/30 rounded-full px-[var(--space-md)] py-[var(--space-xs)] transition-colors cursor-pointer"
     >
      Fermer
     </button>
    )}
   </div>

   {!open && !done && (
    <p className="text-[length:var(--text-xs)] text-muted-foreground/80 mt-[var(--space-xs)]">
     Vos autres sessions seront déconnectées pour protéger votre compte.
    </p>
   )}

   {open && !done && (
    <form onSubmit={handleSubmit} className="mt-[var(--space-md)] space-y-[var(--space-md)]">
     <div>
      <Label htmlFor="cp-current" className={labelClass}>Mot de passe actuel</Label>
      <Input
       id="cp-current"
       className={inputClass}
       type="password"
       value={currentPassword}
       onChange={(e) => setCurrentPassword(e.target.value)}
       autoComplete="current-password"
       required
      />
     </div>
     <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-md)]">
      <div>
       <Label htmlFor="cp-new" className={labelClass}>Nouveau</Label>
       <Input
        id="cp-new"
        className={inputClass}
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        autoComplete="new-password"
        required
        minLength={8}
       />
      </div>
      <div>
       <Label htmlFor="cp-confirm" className={labelClass}>Confirmer</Label>
       <Input
        id="cp-confirm"
        className={inputClass}
        type="password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        autoComplete="new-password"
        required
        minLength={8}
       />
      </div>
     </div>

     <PasswordAdvice />

     {error && (
      <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>
     )}

     <div className="flex justify-end">
      <button
       type="submit"
       disabled={saving}
       className="text-[length:var(--text-xs)] tracking-wide font-bold text-background bg-foreground border border-foreground hover:bg-foreground/90 rounded-full px-[var(--space-md)] py-[var(--space-xs)] disabled:opacity-50 transition-colors cursor-pointer"
      >
       {saving ? "Enregistrement..." : "Enregistrer"}
      </button>
     </div>
    </form>
   )}

   {done && (
    <p className="mt-[var(--space-md)] text-[length:var(--text-sm)] text-emerald-600 dark:text-emerald-400">
     Mot de passe modifié. Vos autres sessions ont été déconnectées.
    </p>
   )}
  </div>
 );
}
