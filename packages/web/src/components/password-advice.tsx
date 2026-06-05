import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Collapsible education block for password-setting screens (register, reset).
 * Nudges towards passphrases + a password manager instead of the typical
 * "Sup3r!Secret" soup that nobody remembers.
 */
export function PasswordAdvice() {
 const { t } = useTranslation("auth");
 return (
  <details className="group border border-foreground/10 rounded-sm bg-foreground/[0.02]">
   <summary className="flex items-center gap-[var(--space-xs)] px-[var(--space-sm)] py-[var(--space-xs)] cursor-pointer list-none select-none text-[length:var(--text-xs)] tracking-wide text-muted-foreground hover:text-foreground transition-colors">
    <KeyRound className="size-[14px]" />
    <span className="font-semibold">{t("passwordAdvice.summary")}</span>
    <span className="ml-auto text-[length:var(--text-2xs)] opacity-50 group-open:hidden">{t("passwordAdvice.show")}</span>
    <span className="ml-auto text-[length:var(--text-2xs)] opacity-50 hidden group-open:inline">{t("passwordAdvice.hide")}</span>
   </summary>
   <div className="px-[var(--space-sm)] pb-[var(--space-sm)] pt-[var(--space-xs)] space-y-[var(--space-sm)] text-[length:var(--text-2xs)] leading-relaxed text-muted-foreground">
    <div>
     <p className="text-foreground font-semibold mb-[var(--space-2xs)]">{t("passwordAdvice.fourWordsTitle")}</p>
     <p>
      {t("passwordAdvice.fourWordsBody")}
     </p>
     <p className="mt-[var(--space-xs)]">
      {t("passwordAdvice.exampleLabel")} <code className="px-[4px] py-[1px] rounded bg-muted font-mono text-foreground">fromage-piano-orage-citron</code>
     </p>
     <p className="mt-[var(--space-xs)]">
      {t("passwordAdvice.avoidNote")}
     </p>
    </div>
    <div>
     <p className="text-foreground font-semibold mb-[var(--space-2xs)]">{t("passwordAdvice.managerTitle")}</p>
     <p>
      {t("passwordAdvice.managerBody")}
     </p>
     <ul className="mt-[var(--space-xs)] pl-[var(--space-md)] space-y-[var(--space-2xs)] list-disc">
      <li>
       <a href="https://bitwarden.com/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
        Bitwarden
       </a>
       {t("passwordAdvice.bitwardenNote")}
      </li>
      <li>
       <a href="https://1password.com/fr/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
        1Password
       </a>
       {t("passwordAdvice.onePasswordNote")}
      </li>
      <li>
       <a href="https://keepass.info/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
        KeePass
       </a>
       {t("passwordAdvice.keepassNote")}
      </li>
     </ul>
    </div>
    <p className="italic">
     {t("passwordAdvice.neverReuse")}
    </p>
   </div>
  </details>
 );
}
