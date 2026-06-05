/**
 * Public no-login profile-completion page reached from the invitation email's
 * magic link. Talks only to /api/public/onboarding/:token (no /auth, no session).
 *
 * RGPD posture: page edits the worker's own data only (art. 16 rectification).
 * Address is captured as 3 inputs (street, postal code, city); the server keeps
 * the legacy single-line `address` synced for downstream consumers.
 */
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useParams } from "react-router-dom";

type ChecklistItem = {
  key: string;
  label: string;
  description: string;
  mandatory: boolean;
  status: "missing" | "pending_review" | "uploaded" | "valid" | "expiring_soon" | "expired";
  category: "identity" | "medical" | "qualification" | "other" | string;
};

type DossierData = {
  worker: {
    firstName: string | null;
    lastName: string | null;
    name: string;
    email: string;
    addressStreet: string | null;
    addressPostalCode: string | null;
    addressCity: string | null;
    iban: string | null;
    emergencyContact: string | null;
    emergencyPhone: string | null;
    dateOfBirth: string | null;
    birthPlace: string | null;
    nationality: string | null;
    nir: string | null;
  };
  restaurantName: string;
  expiresAt: string;
  checklist: { items: ChecklistItem[]; readyForDpae: boolean };
};

const MAX_DOC_BYTES = 5 * 1024 * 1024;

export function PublicDossierPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<DossierData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);

  // Form state
  const [addressStreet, setAddressStreet] = useState("");
  const [addressPostalCode, setAddressPostalCode] = useState("");
  const [addressCity, setAddressCity] = useState("");
  const [iban, setIban] = useState("");
  const [emergencyContact, setEmergencyContact] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [birthPlace, setBirthPlace] = useState("");
  const [nationality, setNationality] = useState("");
  const [nir, setNir] = useState("");

  async function refresh() {
    if (!token) return;
    const r = await fetch(`/api/public/onboarding/${token}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || "Lien invalide ou expiré");
    }
    const { data }: { data: DossierData } = await r.json();
    setData(data);
    setAddressStreet(data.worker.addressStreet || "");
    setAddressPostalCode(data.worker.addressPostalCode || "");
    setAddressCity(data.worker.addressCity || "");
    setIban(data.worker.iban || "");
    setEmergencyContact(data.worker.emergencyContact || "");
    setEmergencyPhone(data.worker.emergencyPhone || "");
    setDateOfBirth(data.worker.dateOfBirth || "");
    setBirthPlace(data.worker.birthPlace || "");
    setNationality(data.worker.nationality || "Française");
    setNir(data.worker.nir || "");
  }

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : "Erreur"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/public/onboarding/${token}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addressStreet: addressStreet || null,
          addressPostalCode: addressPostalCode || null,
          addressCity: addressCity || null,
          iban: iban || null,
          emergencyContact: emergencyContact || null,
          emergencyPhone: emergencyPhone || null,
          dateOfBirth: dateOfBirth || null,
          birthPlace: birthPlace || null,
          nationality: nationality || null,
          nir: nir || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Erreur d'enregistrement");
      }
      setSavedAt(new Date());
      // Re-pull checklist so the worker can see what's still missing right after save.
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Erreur d'enregistrement");
    } finally {
      setSaving(false);
    }
  }

  async function handleDocUpload(file: File, item: ChecklistItem) {
    if (!token) return;
    if (file.size > MAX_DOC_BYTES) {
      setError(`"${file.name}" dépasse 5 Mo`);
      return;
    }
    setError("");
    setUploadingKey(item.key);
    try {
      const docType =
        item.category === "identity" ? "id" :
        item.category === "medical" ? "medical" :
        item.category === "qualification" ? "certificate" : "other";
      const form = new FormData();
      form.append("file", file);
      form.append("name", item.label);
      form.append("type", docType);
      form.append("requirementKey", item.key);
      const res = await fetch(`/api/public/onboarding/${token}/documents`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Échec upload (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec upload");
    } finally {
      setUploadingKey(null);
    }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Chargement…</div>;
  }
  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <p className="text-lg font-semibold mb-2">Lien invalide ou expiré</p>
          <p className="text-sm text-muted-foreground">
            Demandez à votre employeur de vous renvoyer un nouveau lien d'invitation.
          </p>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const displayName =
    [data.worker.firstName, data.worker.lastName].filter(Boolean).join(" ") || data.worker.name;
  const inputBase =
    "w-full rounded-lg border border-foreground/15 bg-background px-3 py-3 text-base focus:outline-none focus:border-foreground/40";

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="max-w-md mx-auto px-4 py-6">
        <header className="mb-6">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{data.restaurantName}</p>
          <h1 className="text-2xl font-semibold mt-1">Bonjour {displayName}</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Complétez les informations ci-dessous pour finaliser votre embauche (DPAE/URSSAF).
            Aucun mot de passe nécessaire — ce lien reste valable 72 heures.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-5">
          <Section title="Adresse postale">
            <Field label="Rue et numéro">
              <input className={inputBase} value={addressStreet} onChange={(e: ChangeEvent<HTMLInputElement>) => setAddressStreet(e.target.value)} placeholder="12 rue Exemple" autoComplete="street-address" />
            </Field>
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <Field label="Code postal">
                <input className={inputBase + " font-mono"} inputMode="numeric" value={addressPostalCode} onChange={(e) => setAddressPostalCode(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="75011" autoComplete="postal-code" />
              </Field>
              <Field label="Ville">
                <input className={inputBase} value={addressCity} onChange={(e) => setAddressCity(e.target.value)} placeholder="Paris" autoComplete="address-level2" />
              </Field>
            </div>
          </Section>

          <Section title="Coordonnées">
            <Field label="IBAN" hint="Pour le virement de la paie">
              <input className={inputBase + " font-mono"} value={iban} onChange={(e) => setIban(e.target.value.toUpperCase().replace(/\s/g, ""))} placeholder="FR76…" autoComplete="off" />
            </Field>
          </Section>

          <Section title="Contact d'urgence">
            <Field label="Nom du contact">
              <input className={inputBase} value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)} placeholder="Prénom Nom" autoComplete="off" />
            </Field>
            <Field label="Téléphone du contact">
              <input className={inputBase + " font-mono"} type="tel" value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} placeholder="+33 6 …" autoComplete="off" />
            </Field>
          </Section>

          <Section title="État civil" hint="Requis pour la déclaration URSSAF (DPAE).">
            <Field label="Date de naissance">
              <input className={inputBase} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} autoComplete="bday" />
            </Field>
            <Field label="Lieu de naissance">
              <input className={inputBase} value={birthPlace} onChange={(e) => setBirthPlace(e.target.value)} placeholder="Paris, France" autoComplete="off" />
            </Field>
            <Field label="Nationalité">
              <input className={inputBase} value={nationality} onChange={(e) => setNationality(e.target.value)} placeholder="Française" autoComplete="off" />
            </Field>
            <Field label="Numéro de sécurité sociale (NIR)" hint="Facultatif — laissez vide si non encore attribué">
              <input className={inputBase + " font-mono"} inputMode="numeric" value={nir} onChange={(e) => setNir(e.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="13 chiffres + 2 clé" autoComplete="off" />
            </Field>
          </Section>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg bg-foreground text-background font-semibold py-4 text-base disabled:opacity-50"
          >
            {saving ? "Enregistrement…" : savedAt ? "Mettre à jour" : "Envoyer mes informations"}
          </button>

          {savedAt && !error && (
            <p className="text-center text-sm text-emerald-700">
              ✓ Enregistré à {savedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.
            </p>
          )}
        </form>

        {/* Documents — token-gated upload */}
        {data.checklist?.items?.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Documents</h2>
            <div className="rounded-xl bg-background border border-foreground/10 divide-y divide-foreground/10">
              {data.checklist.items.map((item) => (
                <DocRow
                  key={item.key}
                  item={item}
                  uploading={uploadingKey === item.key}
                  onPick={(file) => handleDocUpload(file, item)}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Formats acceptés : PDF, JPG, PNG, WebP — 5 Mo max par fichier.
            </p>
          </div>
        )}

        <footer className="mt-8 pt-6 border-t border-foreground/10 text-xs text-muted-foreground space-y-1">
          <p><strong>Vos données.</strong> Ces informations et documents sont utilisés uniquement pour la déclaration URSSAF (DPAE — Code du travail L1221-10) et la gestion de votre paie.</p>
          <p>Ils restent visibles uniquement par votre employeur et ne sont partagés avec aucun tiers en dehors des organismes légaux.</p>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl bg-background p-4 space-y-4 border border-foreground/10">
      <legend className="px-2 text-xs uppercase tracking-wide text-muted-foreground">{title}</legend>
      {hint && <p className="text-xs text-muted-foreground -mt-2">{hint}</p>}
      {children}
    </fieldset>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground mt-1">{hint}</span>}
    </label>
  );
}

function DocRow({ item, uploading, onPick }: { item: ChecklistItem; uploading: boolean; onPick: (file: File) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const badge =
    item.status === "valid" ? { sym: "✓", cls: "text-emerald-600" } :
    item.status === "pending_review" ? { sym: "⏳", cls: "text-amber-600" } :
    item.status === "expired" ? { sym: "⚠", cls: "text-destructive" } :
    item.status === "expiring_soon" ? { sym: "⏳", cls: "text-amber-600" } :
    item.status === "uploaded" ? { sym: "✓", cls: "text-emerald-600" } :
    { sym: item.mandatory ? "○" : "·", cls: "text-muted-foreground" };
  const cta = uploading ? "Envoi…" : item.status === "missing" ? "Ajouter" : "Remplacer";
  return (
    <div className="flex items-center gap-3 p-3">
      <span className={`text-base font-bold w-5 text-center ${badge.cls}`}>{badge.sym}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
          <span>{item.label}</span>
          {item.mandatory && <span className="text-xs text-muted-foreground">(obligatoire)</span>}
          {item.status === "pending_review" && (
            <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 px-1.5 py-px rounded">
              en attente de validation
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">{item.description}</div>
      </div>
      <button
        type="button"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
        className="text-xs font-semibold border border-foreground/20 hover:border-foreground rounded-full px-3 py-1.5 disabled:opacity-50"
      >
        {cta}
      </button>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
