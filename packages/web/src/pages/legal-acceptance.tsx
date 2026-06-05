import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

export function LegalAcceptancePage() {
 const { user, refresh, logout } = useAuth();
 const ownerMode = !!user?.ownerLegalAcceptanceRequired;
 const [checked, setChecked] = useState(false);
 const [whatsappOptIn, setWhatsappOptIn] = useState(!ownerMode || !!user?.whatsappOptIn);
 const [submitting, setSubmitting] = useState(false);
 const [error, setError] = useState("");
 const versions = user?.ownerLegalVersions;

 const accept = async () => {
  if (!checked) return;
  setError("");
  setSubmitting(true);
  try {
   if (ownerMode) await api.acceptOwnerLegal();
   else await api.acceptUserNotice({ whatsappOptIn });
   await refresh();
  } catch (err) {
   setError(err instanceof Error ? err.message : "Impossible d'enregistrer l'acceptation");
  } finally {
   setSubmitting(false);
  }
 };

 return (
  <div className="min-h-screen bg-background flex items-center justify-center px-[var(--space-lg)] py-[var(--space-2xl)]">
   <div className="w-full max-w-2xl border border-border rounded-lg bg-card p-[var(--space-xl)] space-y-[var(--space-lg)]">
    <div>
     <p className="text-[length:var(--text-xs)] uppercase tracking-widest text-muted-foreground font-bold">Comptoir</p>
     <h1 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] mt-[var(--space-xs)]">
      {ownerMode ? "Conditions légales du compte restaurant" : "Notice confidentialité utilisateur"}
     </h1>
     <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)]">
      {ownerMode ? (
       <>Vous êtes connecté comme administrateur principal de <span className="font-semibold text-foreground">{user?.restaurantName}</span>. Pour continuer, le représentant du restaurant doit accepter les conditions contractuelles Comptoir.</>
      ) : (
       <>Avant d'utiliser Comptoir, merci de confirmer que vous avez pris connaissance de la notice de confidentialité et des règles d'utilisation liées à votre compte salarié/manager.</>
      )}
     </p>
    </div>

    <div className="rounded-md border border-border bg-background p-[var(--space-md)] space-y-[var(--space-sm)] text-[length:var(--text-sm)]">
     <p className="font-semibold">
      {ownerMode ? `Documents concernés${versions ? ` — version ${versions.terms}` : ""}` : `Documents concernés — version ${user?.userNoticeVersion ?? "2026-05-11"}`}
     </p>
     <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
      {ownerMode && <li><a className="underline hover:text-foreground" href="/cgu.html" target="_blank" rel="noreferrer">CGU / conditions d'utilisation</a></li>}
      {ownerMode && <li><a className="underline hover:text-foreground" href="/rgpd/conditions-traitement.html" target="_blank" rel="noreferrer">Conditions de traitement des données / DPA</a></li>}
      <li><a className="underline hover:text-foreground" href="/confidentialite.html" target="_blank" rel="noreferrer">Notice confidentialité & salariés</a></li>
      {ownerMode && <li><a className="underline hover:text-foreground" href="/rgpd/sous-traitants.html" target="_blank" rel="noreferrer">Inventaire des sous-traitants</a></li>}
     </ul>
    </div>

    <label className="flex items-start gap-[var(--space-sm)] text-[length:var(--text-sm)] cursor-pointer">
     <input
      type="checkbox"
      checked={checked}
      onChange={(e) => setChecked(e.target.checked)}
      className="mt-1 size-4 accent-foreground cursor-pointer"
     />
     <span>
      {ownerMode
       ? "Je confirme être habilité à accepter ces documents pour le restaurant ou l'entité cliente, et j'accepte les CGU ainsi que les conditions de traitement des données Comptoir."
       : "Je reconnais avoir pris connaissance de la notice de confidentialité Comptoir et des règles d'utilisation de mon compte."}
     </span>
    </label>

    {!ownerMode && (
     <label className="flex items-start gap-[var(--space-sm)] text-[length:var(--text-sm)] cursor-pointer rounded-md border border-border bg-background p-[var(--space-md)]">
      <input
       type="checkbox"
       checked={whatsappOptIn}
       onChange={(e) => setWhatsappOptIn(e.target.checked)}
       className="mt-1 size-4 accent-foreground cursor-pointer"
      />
      <span>
       <span className="font-semibold block">Activer WhatsApp (optionnel)</span>
       <span className="text-muted-foreground">J'accepte de recevoir les messages opérationnels Comptoir sur WhatsApp et d'utiliser l'assistant Bernardo, y compris l'envoi de messages vocaux qui sont transcrits en texte par un sous-traitant d'inférence IA avant traitement. Je peux refuser et continuer à utiliser l'application web.</span>
      </span>
     </label>
    )}

    {error && <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>}

    <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-[var(--space-sm)]">
     <button type="button" onClick={logout} className="text-[length:var(--text-sm)] text-muted-foreground hover:text-foreground transition-colors">
      Se déconnecter
     </button>
     <Button onClick={accept} disabled={!checked || submitting} className="font-bold">
      {submitting ? "Enregistrement..." : "Accepter et continuer"}
     </Button>
    </div>
   </div>
  </div>
 );
}
