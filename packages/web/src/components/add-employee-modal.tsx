import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/query-keys";
import {
 Dialog,
 DialogContent,
 DialogHeader,
 DialogTitle,
 DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
 Select,
 SelectContent,
 SelectItem,
 SelectTrigger,
 SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
 HCR_LEVELS,
 HCR_LEVEL_LABELS,
 HCR_GRID_2026,
 DEFAULT_SUBROLE_TO_HCR,
 KITCHEN_DEFAULT_SUBROLES,
 FLOOR_DEFAULT_SUBROLES,
 highestHcrFromSubRoles,
 type HcrLevel,
} from "@comptoir/shared/hcr";
import { DEFAULT_CONTRACT_HOURS, DEFAULT_CONTRACT_TYPE } from "@comptoir/shared";

const HCR_RANK = Object.fromEntries(HCR_LEVELS.map((lvl, i) => [lvl, i])) as Record<HcrLevel, number>;

function lowestTierSubRole(catalog: string[], hcrMap: Record<string, HcrLevel>): string | null {
  if (catalog.length === 0) return null;
  if (catalog.length === 1) return catalog[0];
  let best = catalog[0];
  let bestRank = HCR_RANK[(hcrMap[best] ?? DEFAULT_SUBROLE_TO_HCR[best]) as HcrLevel] ?? 99;
  for (const sr of catalog.slice(1)) {
   const rank = HCR_RANK[(hcrMap[sr] ?? DEFAULT_SUBROLE_TO_HCR[sr]) as HcrLevel] ?? 99;
   if (rank < bestRank) { best = sr; bestRank = rank; }
  }
  return best;
}
import { LEGAL_LINKS } from "@comptoir/shared/legal";

interface AddEmployeeModalProps {
 open: boolean;
 onClose: () => void;
 onSuccess: () => void;
 lightDefaults?: boolean;
 /** Pre-select the role when the modal opens. */
 initialRole?: "kitchen" | "floor" | "manager";
}

const labelClass = "text-[length:var(--text-xs)] tracking-wide font-bold";
const inputClass = "border-foreground/20 bg-transparent text-[length:var(--text-sm)]";

// Tiny visual cue: which fields the employee can fill in themselves later via self-service.
function SelfServiceBadge() {
 const { t } = useTranslation("staff");
 return (
  <span
   title={t("addModal.selfServiceBadgeTooltip")}
   className="ml-1 inline-flex items-center px-1 py-px rounded-sm text-[length:var(--text-2xs)] font-medium tracking-wide border border-foreground/15 text-muted-foreground"
  >
   {t("addModal.selfServiceBadge")}
  </span>
 );
}

function LegalLink({ href, children }: { href: string; children: React.ReactNode }) {
 return (
  <a href={href} target="_blank" rel="noopener noreferrer"
   className="underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors">
   {children}
  </a>
 );
}

type ContractType = "CDI" | "CDD" | "saisonnier" | "extra";

function addMonths(isoDate: string, months: number): string {
 if (!isoDate) return "";
 const d = new Date(isoDate + "T00:00:00");
 d.setMonth(d.getMonth() + months);
 return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AddEmployeeModal({ open, onClose, onSuccess, lightDefaults = false, initialRole }: AddEmployeeModalProps) {
 const { t } = useTranslation(["staff", "common", "roles"]);
 const [firstName, setFirstName] = useState("");
 const [lastName, setLastName] = useState("");
 const [email, setEmail] = useState("");
 const [phone, setPhone] = useState("");
 const [role, setRole] = useState<"kitchen" | "floor" | "manager">(initialRole ?? "floor");
 const [priority, setPriority] = useState(1);
 const [priorityHelp, setPriorityHelp] = useState<{ rect: DOMRect } | null>(null);
 const [address, setAddress] = useState("");
 const [iban, setIban] = useState("");
 const [startDate, setStartDate] = useState("");
 const [emergencyContact, setEmergencyContact] = useState("");
 const [emergencyPhone, setEmergencyPhone] = useState("");
 const [notes, setNotes] = useState("");

 // Sub-roles + HCR
 const [subRoles, setSubRoles] = useState<string[]>([]);
 const [hcrLevel, setHcrLevel] = useState<HcrLevel | "">("");
 const [hourlyRateEur, setHourlyRateEur] = useState("");

 // Contract
 const [contractType, setContractType] = useState<ContractType>(DEFAULT_CONTRACT_TYPE);
 const [contractHours, setContractHours] = useState(String(DEFAULT_CONTRACT_HOURS));
 const [contractEndDate, setContractEndDate] = useState("");
 const [generateContract, setGenerateContract] = useState(!lightDefaults);
 const [inviteSelfService, setInviteSelfService] = useState(!lightDefaults);

 // Loaded from preferences
 const [kitchenSubRoles, setKitchenSubRoles] = useState<string[]>([]);
 const [floorSubRoles, setFloorSubRoles] = useState<string[]>([]);
 const [restaurantHcrGrid, setRestaurantHcrGrid] = useState<Partial<Record<HcrLevel, number>>>({});
 const [subroleHcrMap, setSubroleHcrMap] = useState<Record<string, HcrLevel>>({});

 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");
 const [success, setSuccess] = useState(false);
 const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
 const [inviteSent, setInviteSent] = useState<string | null>(null);
 const [inviteKind, setInviteKind] = useState<"dossier" | "login" | null>(null);

 // Inline "+ Nouveau sous-rôle" form
 const [adding, setAdding] = useState(false);
 const [newSubRoleName, setNewSubRoleName] = useState("");
 const [newSubRoleNiveau, setNewSubRoleNiveau] = useState<HcrLevel>("II-1");
 const [addingError, setAddingError] = useState("");
 const [persistingSubRole, setPersistingSubRole] = useState(false);

 const queryClient = useQueryClient();
 const preferencesQuery = useQuery({
  queryKey: qk.settings.preferences(),
  queryFn: async () => (await api.getPreferences()).data,
  enabled: open,
 });

 useEffect(() => {
  if (!open) return;
  if (initialRole) setRole(initialRole);
  const p = preferencesQuery.data;
  if (!p) return;
  const kitchen = p.kitchenSubRoles ?? [];
  const floor = p.floorSubRoles ?? [];
  const hcrMap = (p.subroleHcrMap ?? {}) as Record<string, HcrLevel>;
  setKitchenSubRoles(kitchen);
  setFloorSubRoles(floor);
  setRestaurantHcrGrid((p.hcrGrid ?? {}) as Partial<Record<HcrLevel, number>>);
  setSubroleHcrMap(hcrMap);
  setContractType(p.defaultContractType ?? DEFAULT_CONTRACT_TYPE);
  setContractHours(String(p.defaultContractHours ?? DEFAULT_CONTRACT_HOURS));
  const effectiveRole = initialRole ?? "floor";
  const catalog = effectiveRole === "kitchen" ? kitchen : floor;
  const pick = lowestTierSubRole(catalog, hcrMap);
  if (pick) setSubRoles([pick]);
 }, [open, preferencesQuery.data, initialRole]);

 // Manager is "executive" — no zone, no sub-roles, no HCR. The form just skips those sections.
 const availableSubRoles = role === "kitchen" ? kitchenSubRoles : role === "floor" ? floorSubRoles : [];
 const mappedFromSubrole = useMemo(
  () => highestHcrFromSubRoles(subRoles, subroleHcrMap),
  [subRoles, subroleHcrMap],
 );
 const effectiveLevel: HcrLevel | null = (hcrLevel as HcrLevel) || mappedFromSubrole;
 const effectiveGrid = { ...HCR_GRID_2026, ...restaurantHcrGrid } as Record<HcrLevel, number>;
 // Grid values are stored in cents; convert to euros for display.
 const gridRateEur = effectiveLevel ? effectiveGrid[effectiveLevel] / 100 : null;

 const resetForm = () => {
  setFirstName(""); setLastName(""); setEmail(""); setPhone(""); setRole(initialRole ?? "floor");
  setAddress(""); setIban(""); setStartDate("");
  setEmergencyContact(""); setEmergencyPhone(""); setNotes("");
  setSubRoles([]); setHcrLevel(""); setHourlyRateEur("");
  setContractType(DEFAULT_CONTRACT_TYPE); setContractHours(String(DEFAULT_CONTRACT_HOURS)); setContractEndDate("");
  setGenerateContract(!lightDefaults); setInviteSelfService(!lightDefaults);
  setPriority(1);
  setError(""); setSuccess(false); setTemporaryPassword(null); setInviteSent(null); setInviteKind(null);
 };

 const toggleSubRole = (sr: string) => {
  setSubRoles((prev) => {
   const EXCLUSIVE_GROUPS = [["Chef", "Sous-chef"], ["Chef de rang", "Sous-chef de rang"]];
   if (prev.includes(sr)) return prev.filter((r) => r !== sr);
   let next = [...prev, sr];
   for (const group of EXCLUSIVE_GROUPS) {
    if (group.includes(sr)) next = next.filter((r) => r === sr || !group.includes(r));
   }
   return next;
  });
 };

 // Auto-suggest niveau when the user types a name that matches the canonical catalog
 // (case-insensitive, trimmed). Admin can still override the dropdown after.
 useEffect(() => {
  if (!adding) return;
  const trimmed = newSubRoleName.trim();
  if (!trimmed) return;
  const match = Object.keys(DEFAULT_SUBROLE_TO_HCR).find(
   (k) => k.toLowerCase() === trimmed.toLowerCase(),
  );
  if (match) setNewSubRoleNiveau(DEFAULT_SUBROLE_TO_HCR[match]!);
 }, [newSubRoleName, adding]);

 const cancelAddSubRole = () => {
  setAdding(false);
  setNewSubRoleName("");
  setNewSubRoleNiveau("II-1");
  setAddingError("");
 };

 // Persist a new sub-role into the restaurant's catalog (and the niveau map),
 // then auto-select it on the employee being created. Used by both the suggestion
 // chips (one-click) and the free-form "Ou créez un nouveau" form below.
 const persistNewSubRole = async (name: string, niveau: HcrLevel) => {
  if (availableSubRoles.some((s) => s.toLowerCase() === name.toLowerCase())) {
   setAddingError(t("staff:addModal.position.errors.subRoleExists"));
   return;
  }
  setAddingError("");
  setPersistingSubRole(true);
  const nextCatalog = [...availableSubRoles, name];
  const nextHcrMap = { ...subroleHcrMap, [name]: niveau };
  try {
   await api.updatePreferences(
    role === "kitchen"
     ? { kitchenSubRoles: nextCatalog, subroleHcrMap: nextHcrMap }
     : { floorSubRoles: nextCatalog, subroleHcrMap: nextHcrMap },
   );
   if (role === "kitchen") setKitchenSubRoles(nextCatalog);
   else setFloorSubRoles(nextCatalog);
   setSubroleHcrMap(nextHcrMap);
   setSubRoles((prev) => [...prev, name]);
   queryClient.invalidateQueries({ queryKey: qk.settings.preferences() });
   cancelAddSubRole();
  } catch (err) {
   setAddingError(err instanceof Error ? err.message : t("staff:addModal.position.errors.saveFailed"));
  } finally {
   setPersistingSubRole(false);
  }
 };

 const confirmAddSubRole = async () => {
  const name = newSubRoleName.trim();
  if (!name) {
   setAddingError(t("staff:addModal.position.errors.subRoleNameRequired"));
   return;
  }
  await persistNewSubRole(name, newSubRoleNiveau);
 };

 // Extras have no guaranteed weekly hours; reset end date only for CDI.
 useEffect(() => {
  if (contractType === "CDI") setContractEndDate("");
  setContractHours((prev) => contractType === "extra" ? "0" : prev === "0" ? String(DEFAULT_CONTRACT_HOURS) : prev);
 }, [contractType]);

 const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setSaving(true);
  setError("");
  setTemporaryPassword(null);
  setInviteSent(null);
  setInviteKind(null);
  try {
   if ((contractType === "CDD" || contractType === "saisonnier") && !contractEndDate) {
    throw new Error("La date de fin est obligatoire pour un CDD ou un contrat saisonnier.");
   }
   const created = await api.createUser({
    firstName: firstName.trim() || null,
    lastName: lastName.trim() || null,
    email, phone, role, priority,
    address: address || null,
    iban: iban || null,
    startDate: startDate || null,
    emergencyContact: emergencyContact || null,
    emergencyPhone: emergencyPhone || null,
    notes: notes || null,
    subRoles,
    contractType,
    contractEndDate: contractEndDate || null,
    contractHours: contractHours ? Number(contractHours) : null,
    hcrLevel: (hcrLevel as HcrLevel) || mappedFromSubrole || null,
    hourlyRate: hourlyRateEur ? Math.round(parseFloat(hourlyRateEur) * 100) : null,
   });
   // Dispatch contract PDF + self-service invite. Failures don't block the employee
   // creation — the admin can retry from the employee detail page.
   const createdId = created?.data?.id;
   let inviteOk = false;
   if (createdId) {
    const followups: Promise<unknown>[] = [];
    if (generateContract) {
     followups.push(api.generateContract(createdId, {
      kind: contractType,
      save: true,
      inputs: {
       startDate: startDate || undefined,
       endDate: contractEndDate || undefined,
       ...(contractType === "extra" && contractEndDate ? { extraDates: contractEndDate } : {}),
      },
     }));
    }
    if (inviteSelfService && email) {
     followups.push(api.inviteWorker(createdId).then((res) => { if (res.data.sent) { inviteOk = true; setInviteKind("dossier"); } }));
    } else if (lightDefaults && email) {
     followups.push(api.inviteWorkerLogin(createdId).then((res) => { if (res.data.sent) { inviteOk = true; setInviteKind("login"); } }));
    }
    await Promise.allSettled(followups);
   }
   queryClient.invalidateQueries({ queryKey: qk.employees.all() });
   const oneTimePassword = created?.data?.temporaryPassword ?? null;
   if (inviteOk) {
    setInviteSent(email);
    setTemporaryPassword(null);
   } else {
    setTemporaryPassword(oneTimePassword);
   }
   setSuccess(true);
   if (inviteOk || !oneTimePassword) {
    setTimeout(() => {
     resetForm();
     onSuccess();
     onClose();
    }, 2000);
   }
  } catch (err: unknown) {
   setError(err instanceof Error ? err.message : t("staff:addModal.errors.createFailed"));
  } finally {
   setSaving(false);
  }
 };

 return (
  <>
  {priorityHelp && (
   <>
    <div className="fixed inset-0 z-[60]" onClick={() => setPriorityHelp(null)} />
    <div
     className="fixed z-[70] bg-popover border border-border rounded-lg shadow-xl p-3 w-[min(320px,calc(100vw-16px))] space-y-2"
     style={{ top: priorityHelp.rect.bottom + 6, left: Math.min(window.innerWidth - 328, Math.max(8, priorityHelp.rect.left - 200)) }}
    >
     <div className="flex items-center gap-1.5">
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-foreground text-[10px] leading-none font-bold">?</span>
      <span className="text-sm font-semibold">{t("staff:addModal.priority.helpTitle")}</span>
     </div>
     <p className="text-xs text-muted-foreground leading-relaxed">
      {t("staff:addModal.priority.helpBody1Prefix")}<span className="font-semibold text-foreground">{t("staff:addModal.priority.helpBody1Highlight")}</span>{t("staff:addModal.priority.helpBody1Suffix")}
     </p>
     <p className="text-xs text-muted-foreground leading-relaxed">
      {t("staff:addModal.priority.helpBody2")}
     </p>
    </div>
   </>
  )}
  <Dialog open={open} onOpenChange={(o) => { if (!o) { resetForm(); onClose(); } }}>
   <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
    <DialogHeader>
     <DialogTitle className="text-[length:var(--text-xl)] font-bold tracking-wide">{t("staff:addModal.title")}</DialogTitle>
     <DialogDescription className="text-[length:var(--text-xs)] tracking-wide">
      <span className="text-destructive">*</span> {t("staff:addModal.legendRequired")} ·{" "}
      <span className="inline-flex items-center px-1 py-px rounded-sm text-[length:var(--text-2xs)] font-medium tracking-wide border border-foreground/15 text-muted-foreground">{t("staff:addModal.selfServiceBadge")}</span>{" "}
      {t("staff:addModal.legendSelfService")}
     </DialogDescription>
    </DialogHeader>

    {success ? (
     <div className="py-[var(--space-xl)] text-center">
      <p className="text-[length:var(--text-lg)] font-bold ">{t("staff:addModal.successTitle")}</p>
      <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)]">
       {t("staff:addModal.successBody", { name: [firstName, lastName].filter(Boolean).join(" ") })}
      </p>
      {inviteSent && (
       <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)]">
        Invitation envoyée à <span className="font-mono text-foreground">{inviteSent}</span>. {inviteKind === "login" ? "L'employé recevra un lien pour choisir son mot de passe et se connecter." : "L'employé recevra un lien pour compléter son dossier et choisir son mot de passe."}
       </p>
      )}
      {!inviteSent && inviteSelfService && (
       <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-sm)]">
        {t("staff:addModal.successInviteNote")}
       </p>
      )}
      {temporaryPassword && (
       <div className="mt-[var(--space-md)] rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-[var(--space-md)] text-left">
        <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-wide text-amber-800 dark:text-amber-300">Invitation non envoyée — mot de passe temporaire</p>
        <p className="mt-[var(--space-xs)] font-mono text-[length:var(--text-sm)] break-all">{temporaryPassword}</p>
        <p className="mt-[var(--space-xs)] text-[length:var(--text-xs)] text-amber-700 dark:text-amber-400">
         À communiquer une seule fois à l'employé. Il devra le changer à la première connexion. Vous pourrez renvoyer une invitation depuis sa fiche si besoin.
        </p>
       </div>
      )}
      {temporaryPassword && (
       <Button
        type="button"
        className="mt-[var(--space-md)]"
        onClick={() => { resetForm(); onSuccess(); onClose(); }}
       >
        Fermer
       </Button>
      )}
     </div>
    ) : (
     <form onSubmit={handleSubmit} className="space-y-[var(--space-xl)]">
      {/* ─── Rôle ─── primary categorisation, picked first */}
      <section className="space-y-[var(--space-sm)]">
       <Label className="text-[length:var(--text-sm)] font-bold tracking-wide uppercase">
        {t("staff:addModal.sections.role")} <span className="text-destructive">*</span>
       </Label>
       <Select value={role} onValueChange={(v) => {
        const nextRole = v as "kitchen" | "floor" | "manager";
        setRole(nextRole);
        if (nextRole === "manager") {
         setSubRoles([]);
        } else {
         const catalog = nextRole === "kitchen" ? kitchenSubRoles : floorSubRoles;
         const pick = lowestTierSubRole(catalog, subroleHcrMap);
         setSubRoles(pick ? [pick] : []);
        }
       }}>
        <SelectTrigger className="!w-[200px] border-foreground/30 bg-transparent text-[length:var(--text-lg)] font-semibold !h-[52px] px-[var(--space-md)] data-[size=default]:!h-[52px]">
         <SelectValue>{t(`roles:${role}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
         <SelectItem value="kitchen">{t("roles:kitchen")}</SelectItem>
         <SelectItem value="floor">{t("roles:floor")}</SelectItem>
         <SelectItem value="manager">{t("roles:manager")}</SelectItem>
        </SelectContent>
       </Select>
      </section>

      {/* ─── Identité ─── */}
      <section className="space-y-[var(--space-md)]">
       <p className="text-[length:var(--text-xs)] font-bold text-muted-foreground tracking-wide uppercase">{t("staff:addModal.sections.identity")}</p>
       <div className="grid grid-cols-2 gap-[var(--space-md)]">
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-firstname" className={labelClass}>{t("staff:addModal.identity.firstName")} <span className="text-destructive">*</span></Label>
         <Input id="emp-firstname" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jean" required className={inputClass} />
        </div>
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-lastname" className={labelClass}>{t("staff:addModal.identity.lastName")} <span className="text-destructive">*</span></Label>
         <Input id="emp-lastname" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Dupont" required className={inputClass} />
        </div>
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-email" className={labelClass}>{t("common:fields.email")} <span className="text-destructive">*</span></Label>
         <Input id="emp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jean@lecomptoir.fr" required className={inputClass} />
        </div>
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-phone" className={labelClass}>{t("common:fields.phone")} <span className="text-destructive">*</span></Label>
         <Input id="emp-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+33600000000" required className={inputClass} />
        </div>
       </div>
      </section>

      {/* ─── Poste & compétences ─── */}
      <section className="space-y-[var(--space-md)]">
       <div className="flex items-center justify-between">
        <p className="text-[length:var(--text-xs)] font-bold text-muted-foreground tracking-wide uppercase">{t("staff:addModal.sections.positionSkills")}</p>
        <div className="flex items-center gap-[var(--space-xs)]">
         <span className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground">{t("staff:addModal.priority.label")}</span>
         {[1, 2, 3].map((p) => (
          <button
           key={p}
           type="button"
           onClick={() => setPriority(p)}
           className={cn(
            "text-[length:10px] font-bold rounded px-[6px] py-[2px] leading-tight transition-colors",
            priority === p ? "bg-foreground text-background" : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
           )}
          >{p}</button>
         ))}
         <button
          type="button"
          onClick={(e) => {
           const rect = e.currentTarget.getBoundingClientRect();
           setPriorityHelp(prev => prev ? null : { rect });
          }}
          className="inline-flex items-center justify-center w-[16px] h-[16px] rounded-full border border-foreground/30 text-[10px] font-bold text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
          title={t("staff:addModal.priority.helpButtonTitle")}
         >?</button>
        </div>
       </div>
       <div className="grid grid-cols-2 gap-[var(--space-md)]">
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-start" className={labelClass}>{t("staff:addModal.position.startDate")}</Label>
         <div className="flex gap-[var(--space-sm)]">
          <Input id="emp-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`flex-1 ${inputClass}`} />
          <Button
           type="button"
           variant="outline"
           size="sm"
           className="shrink-0 tracking-wide text-[length:var(--text-xs)]"
           onClick={() => {
            const d = new Date();
            setStartDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
           }}
          >
           {t("common:actions.today")}
          </Button>
         </div>
        </div>
       </div>

       {/* Sub-role picker — Cuisine / Salle only. Responsable is off-schedule, no sub-roles. */}
       {role !== "manager" && (
       <div className="space-y-[var(--space-xs)]">
        <Label className={labelClass}>{t("staff:addModal.position.subRolesLabel")}</Label>
        <div className="flex flex-wrap gap-1.5">
         {availableSubRoles.map((sr) => {
          const active = subRoles.includes(sr);
          return (
           <button
            key={sr}
            type="button"
            onClick={() => toggleSubRole(sr)}
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
         {!adding && (
          <button
           type="button"
           onClick={() => setAdding(true)}
           title={t("staff:addModal.position.addSubRoleButtonTooltip", { role: t(`roles:${role}`) })}
           className="px-2 py-0.5 rounded-full text-[length:var(--text-xs)] font-medium border border-dashed border-foreground/30 text-muted-foreground hover:text-foreground hover:border-foreground/60 transition-colors"
          >
           {t("staff:addModal.position.addSubRoleButton")}
          </button>
         )}
        </div>

        {adding && (() => {
         const defaults = role === "kitchen" ? KITCHEN_DEFAULT_SUBROLES : FLOOR_DEFAULT_SUBROLES;
         const suggestions = defaults.filter((d) => !availableSubRoles.includes(d));
         return (
         <div className="mt-[var(--space-xs)] p-[var(--space-sm)] border border-foreground/20 rounded-[0.2rem] space-y-[var(--space-sm)] bg-muted/30">
          <p className="text-[length:var(--text-2xs)] text-muted-foreground tracking-wide">
           {t("staff:addModal.position.newSubRoleHeader", { role: t(`roles:${role}`) })}
          </p>

          {suggestions.length > 0 && (
           <div className="space-y-[var(--space-xs)]">
            <Label className={labelClass}>Suggestions (convention HCR)</Label>
            <div className="flex flex-wrap gap-1.5">
             {suggestions.map((sr) => {
              const niveau = DEFAULT_SUBROLE_TO_HCR[sr];
              return (
               <button
                key={sr}
                type="button"
                onClick={() => persistNewSubRole(sr, niveau!)}
                disabled={persistingSubRole}
                title={`Ajouter ${sr} (niveau ${niveau}) au catalogue`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--text-xs)] font-medium border border-foreground/20 bg-background hover:bg-foreground hover:text-background transition-colors disabled:opacity-50"
               >
                <span>+ {sr}</span>
                <span className="text-[length:10px] opacity-60 tabular-nums">{niveau}</span>
               </button>
              );
             })}
            </div>
           </div>
          )}

          <div className="space-y-[var(--space-xs)]">
           <Label className={labelClass}>
            {suggestions.length > 0 ? t("staff:addModal.position.customLabelOr") : t("staff:addModal.position.customLabel")}
           </Label>
           <div className="flex gap-[var(--space-xs)] items-end">
            <div className="flex-1 space-y-[var(--space-xs)]">
             <Label htmlFor="new-subrole-name" className="text-[length:var(--text-2xs)] tracking-wide font-medium text-muted-foreground">{t("staff:addModal.position.customNameLabel")}</Label>
             <Input
              id="new-subrole-name"
              value={newSubRoleName}
              onChange={(e) => setNewSubRoleName(e.target.value)}
              placeholder={role === "kitchen" ? t("staff:addModal.position.customNamePlaceholderKitchen") : t("staff:addModal.position.customNamePlaceholderFloor")}
              className={inputClass}
              autoFocus
             />
            </div>
            <div className="space-y-[var(--space-xs)] w-[140px]">
             <Label className="text-[length:var(--text-2xs)] tracking-wide font-medium text-muted-foreground">Niveau HCR</Label>
             <Select value={newSubRoleNiveau} onValueChange={(v) => setNewSubRoleNiveau(v as HcrLevel)}>
              <SelectTrigger className={inputClass}>
               <SelectValue>{newSubRoleNiveau}</SelectValue>
              </SelectTrigger>
              <SelectContent>
               {HCR_LEVELS.map((lvl) => (
                <SelectItem key={lvl} value={lvl}>{lvl} — {HCR_LEVEL_LABELS[lvl].split(" — ")[1]}</SelectItem>
               ))}
              </SelectContent>
             </Select>
            </div>
           </div>
          </div>

          {addingError && (
           <p className="text-[length:var(--text-2xs)] text-destructive">{addingError}</p>
          )}
          <div className="flex gap-[var(--space-xs)] justify-end">
           <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelAddSubRole}
            disabled={persistingSubRole}
            className="tracking-wide text-[length:var(--text-xs)]"
           >
            {t("common:actions.cancel")}
           </Button>
           <Button
            type="button"
            size="sm"
            onClick={confirmAddSubRole}
            disabled={persistingSubRole || !newSubRoleName.trim()}
            className="tracking-wide text-[length:var(--text-xs)]"
           >
            {persistingSubRole ? t("common:status.loadingShort") : t("staff:addModal.position.addCustomButton")}
           </Button>
          </div>
         </div>
         );
        })()}

        <p className="text-[length:var(--text-2xs)] text-muted-foreground">
         {t("staff:addModal.position.subRoleHelpHcr")}
        </p>

        {subRoles.length === 0 && !adding && (
         <p className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--text-2xs)] font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
          {t("staff:addModal.position.noSkillsWarning")}
         </p>
        )}
       </div>
       )}

      </section>

      {/* ─── Contrat ─── */}
      <section className="space-y-[var(--space-md)]">
       <div className="flex items-baseline justify-between gap-2">
        <p className="text-[length:var(--text-xs)] font-bold text-muted-foreground tracking-wide uppercase">{t("staff:addModal.sections.contract")}</p>
        <LegalLink href={LEGAL_LINKS.cdi.url}>
         <span className="text-[length:var(--text-2xs)] text-muted-foreground">Code du travail ↗</span>
        </LegalLink>
       </div>
       <div className="grid grid-cols-2 gap-[var(--space-md)]">
        <div className="space-y-[var(--space-xs)]">
         <Label className={labelClass}>Type <span className="text-destructive">*</span></Label>
         <Select value={contractType} onValueChange={(v) => setContractType(v as ContractType)}>
          <SelectTrigger className={inputClass}>
           <SelectValue>{contractType}</SelectValue>
          </SelectTrigger>
          <SelectContent>
           <SelectItem value="CDI">CDI — durée indéterminée</SelectItem>
           <SelectItem value="CDD">CDD — durée déterminée</SelectItem>
           <SelectItem value="saisonnier">Saisonnier</SelectItem>
           <SelectItem value="extra">Extra / CDD d'usage</SelectItem>
          </SelectContent>
         </Select>
        </div>
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-hours" className={labelClass}>Heures garanties / semaine <span className="text-destructive">*</span></Label>
         <Input id="emp-hours" type="number" min={contractType === "extra" ? 0 : 1} max={48} value={contractHours} onChange={(e) => setContractHours(e.target.value)} placeholder={contractType === "extra" ? "0" : String(DEFAULT_CONTRACT_HOURS)} className={inputClass} />
         {contractType === "extra" && (
          <p className="text-[length:var(--text-2xs)] text-muted-foreground">0 h garantie — les heures sont portées par les missions/shifts.</p>
         )}
        </div>
       </div>

       {(contractType === "CDD" || contractType === "saisonnier" || contractType === "extra") && (
        <div className="space-y-[var(--space-sm)] border-l-2 border-foreground/10 pl-[var(--space-md)]">
         {contractType !== "extra" && (
          <div className="space-y-[var(--space-xs)]">
           <Label className={labelClass}>Durée du contrat <span className="text-destructive">*</span></Label>
           <div className="flex flex-wrap gap-1.5">
            {[
             { label: "1 mois", months: 1 },
             { label: "3 mois", months: 3 },
             { label: "6 mois", months: 6 },
             { label: "1 an", months: 12 },
            ].map(({ label, months }) => {
             const target = addMonths(startDate || new Date().toISOString().slice(0, 10), months);
             const active = contractEndDate === target;
             return (
              <button
               key={months}
               type="button"
               onClick={() => setContractEndDate(target)}
               className={cn(
                "px-2 py-0.5 rounded-full text-[length:var(--text-xs)] font-medium border transition-colors",
                active
                 ? "bg-foreground text-background border-foreground"
                 : "bg-transparent text-muted-foreground border-foreground/15 hover:border-foreground/30"
               )}
              >
               {label}
              </button>
             );
            })}
           </div>
          </div>
         )}
         <div className="space-y-[var(--space-xs)]">
          <Label htmlFor="emp-end" className={labelClass}>{contractType === "extra" ? "Date de mission / fin si connue" : "Date de fin précise"} {contractType !== "extra" && <span className="text-destructive">*</span>}</Label>
          <Input id="emp-end" type="date" value={contractEndDate} onChange={(e) => setContractEndDate(e.target.value)} className={inputClass} />
         </div>
         <p className="text-[length:var(--text-2xs)] text-muted-foreground leading-snug">
          {contractType === "CDD" ? (
           <>
            Le CDD est <strong>renouvelable deux fois</strong>, dans la limite de la durée maximale légale (généralement 18 mois renouvellements compris).{" "}
            <LegalLink href={LEGAL_LINKS.cddRenewal.url}>Voir art. L1243-13-1 ↗</LegalLink>
           </>
          ) : contractType === "extra" ? (
           <>
            L'extra / CDD d'usage sert à couvrir une <strong>mission ponctuelle</strong>, sans heures hebdomadaires garanties. La date peut rester vide si elle n'est pas encore connue.{" "}
            <LegalLink href={LEGAL_LINKS.cddUsage.url}>Voir règles ↗</LegalLink>{" · "}
            <LegalLink href={LEGAL_LINKS.cddModel.url}>Modèle CDD officiel ↗</LegalLink>
           </>
          ) : (
           <>
            Le contrat saisonnier peut comporter une <strong>clause de reconduction</strong> d'une saison à l'autre.{" "}
            <LegalLink href={LEGAL_LINKS.cddSaisonnier.url}>Voir art. L1242-2 3° ↗</LegalLink>
           </>
          )}
         </p>
        </div>
       )}

       {/* HCR + taux horaire */}
       <div className="grid grid-cols-2 gap-[var(--space-md)]">
        <div className="space-y-[var(--space-xs)]">
         <Label className={labelClass}>
          Niveau HCR{" "}
          <LegalLink href={LEGAL_LINKS.hcrConvention.url}>
           <span className="text-[length:var(--text-2xs)] font-normal text-muted-foreground">(IDCC 1979 ↗)</span>
          </LegalLink>
         </Label>
         <select
          value={hcrLevel}
          onChange={(e) => setHcrLevel(e.target.value as HcrLevel | "")}
          className={`w-full bg-transparent border-b border-foreground/20 text-[length:var(--text-sm)] outline-none focus:border-foreground py-[6px]`}
         >
          <option value="">{mappedFromSubrole ? `Auto (${mappedFromSubrole})` : "—"}</option>
          {HCR_LEVELS.map((lvl) => (
           <option key={lvl} value={lvl}>{lvl} · {HCR_LEVEL_LABELS[lvl].split(" — ")[1] ?? lvl}</option>
          ))}
         </select>
         {!hcrLevel && mappedFromSubrole && (
          <p className="text-[length:var(--text-2xs)] text-muted-foreground">Auto-attribué depuis le sous-rôle</p>
         )}
        </div>
        <div className="space-y-[var(--space-xs)]">
         <Label className={labelClass}>
          Taux horaire brut{" "}
          <LegalLink href={LEGAL_LINKS.hcrSalaryGrid.url}>
           <span className="text-[length:var(--text-2xs)] font-normal text-muted-foreground">(grille ↗)</span>
          </LegalLink>
         </Label>
         <div className="flex items-center gap-[var(--space-xs)]">
          <Input
           type="number"
           step="0.01"
           min={0}
           value={hourlyRateEur}
           onChange={(e) => setHourlyRateEur(e.target.value)}
           placeholder={gridRateEur !== null ? gridRateEur.toFixed(2) : "—"}
           className={cn(inputClass, "font-mono")}
          />
          <span className="text-[length:var(--text-xs)] text-muted-foreground">€/h</span>
         </div>
         {!hourlyRateEur && gridRateEur !== null && (
          <p className="text-[length:var(--text-2xs)] text-muted-foreground">Suit la grille ({gridRateEur.toFixed(2)} €/h)</p>
         )}
        </div>
       </div>
      </section>

      {/* ─── Coordonnées (employee can self-fill) ─── */}
      <section className="space-y-[var(--space-md)]">
       <p className="text-[length:var(--text-xs)] font-bold text-muted-foreground tracking-wide uppercase">{t("staff:addModal.sections.contact")}</p>
       <div className="space-y-[var(--space-xs)]">
        <Label htmlFor="emp-address" className={labelClass}>{t("staff:addModal.contact.address")}<SelfServiceBadge /></Label>
        <Input id="emp-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Rue de Paris, 75001" className={inputClass} />
       </div>
       <div className="space-y-[var(--space-xs)]">
        <Label htmlFor="emp-iban" className={labelClass}>{t("staff:addModal.contact.iban")}<SelfServiceBadge /></Label>
        <Input id="emp-iban" value={iban} onChange={(e) => setIban(e.target.value)} placeholder="FR76 3000 6000..." className={inputClass} />
       </div>
       <div className="grid grid-cols-2 gap-[var(--space-md)]">
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-ec-name" className={labelClass}>{t("staff:addModal.contact.emergencyContact")}<SelfServiceBadge /></Label>
         <Input id="emp-ec-name" value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)} className={inputClass} />
        </div>
        <div className="space-y-[var(--space-xs)]">
         <Label htmlFor="emp-ec-phone" className={labelClass}>{t("staff:addModal.contact.emergencyPhone")}<SelfServiceBadge /></Label>
         <Input id="emp-ec-phone" value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} className={inputClass} />
        </div>
       </div>
       <div className="space-y-[var(--space-xs)]">
        <Label htmlFor="emp-notes" className={labelClass}>{t("staff:addModal.contact.notes")}</Label>
        <Input id="emp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Allergies, préférences..." className={inputClass} />
       </div>
      </section>

      {/* ─── Embauche / DPAE ─── */}
      <section className="space-y-[var(--space-sm)] rounded-md border border-foreground/10 p-[var(--space-md)] bg-foreground/[0.02]">
       <p className="text-[length:var(--text-xs)] font-bold text-muted-foreground tracking-wide uppercase">{t("staff:addModal.sections.hiring")}</p>
       <label className="flex items-start gap-[var(--space-sm)] cursor-pointer">
        <input
         type="checkbox"
         checked={generateContract}
         onChange={(e) => setGenerateContract(e.target.checked)}
         className="mt-[3px] w-4 h-4 rounded border-foreground/20 cursor-pointer"
        />
        <span className="text-[length:var(--text-xs)] leading-snug">
         <span className="font-semibold">{t("staff:addModal.hiring.generateContractLabel", { type: contractType })}</span>{" "}
         <span className="text-muted-foreground">{t("staff:addModal.hiring.generateContractHint")}</span>
        </span>
       </label>
       <label className="flex items-start gap-[var(--space-sm)] cursor-pointer">
        <input
         type="checkbox"
         checked={inviteSelfService}
         onChange={(e) => setInviteSelfService(e.target.checked)}
         className="mt-[3px] w-4 h-4 rounded border-foreground/20 cursor-pointer"
        />
        <span className="text-[length:var(--text-xs)] leading-snug">
         <span className="font-semibold">{t("staff:addModal.hiring.inviteSelfServiceLabel")}</span>{" "}
         <span className="text-muted-foreground">{t("staff:addModal.hiring.inviteSelfServiceHint")}</span>
        </span>
       </label>
       <p className="text-[length:var(--text-2xs)] text-muted-foreground leading-snug">
        Une fois le dossier complet, la <LegalLink href={LEGAL_LINKS.dpae.url}>DPAE auprès de l'URSSAF ↗</LegalLink>{" "}
        sera proposée à la validation.
       </p>
      </section>

      {error && <p className="text-[length:var(--text-sm)] text-destructive font-bold">{error}</p>}

      {(() => {
       const needsSubRole = (role === "kitchen" || role === "floor") && subRoles.length === 0;
       return (
        <Button type="submit" className="w-full tracking-wide text-[length:var(--text-xs)] font-bold h-[var(--space-2xl)]" disabled={saving || needsSubRole}>
         {saving ? t("common:status.loadingShort") : t("staff:addModal.submit")}
        </Button>
       );
      })()}

     </form>
    )}
   </DialogContent>
  </Dialog>
  </>
 );
}
