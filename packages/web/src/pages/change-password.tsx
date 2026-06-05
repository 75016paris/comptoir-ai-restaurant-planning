import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme-toggle";
import { PasswordAdvice } from "@/components/password-advice";

/**
 * Forced password change on first login (id:8c1d) — reached when AuthUser.mustChangePassword.
 * Also used as the standalone /change-password route.
 */
export function ChangePasswordPage() {
 const { t } = useTranslation("auth");
 const { user, refresh, logout } = useAuth();
 const forced = !!user?.mustChangePassword;

 const [currentPassword, setCurrentPassword] = useState("");
 const [newPassword, setNewPassword] = useState("");
 const [confirmPassword, setConfirmPassword] = useState("");
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState("");
 const [done, setDone] = useState(false);

 const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setError("");
  if (newPassword !== confirmPassword) {
   setError(t("changePassword.passwordsDoNotMatch"));
   return;
  }
  if (newPassword.length < 8) {
   setError(t("changePassword.passwordTooShort"));
   return;
  }
  if (newPassword === currentPassword) {
   setError(t("changePassword.sameAsOld"));
   return;
  }
  setLoading(true);
  try {
   await api.changeMyPassword(currentPassword, newPassword);
   await refresh();
   setDone(true);
  } catch (err: unknown) {
   setError(err instanceof Error ? err.message : t("changePassword.genericError"));
  } finally {
   setLoading(false);
  }
 };

 return (
  <div className="min-h-screen bg-background flex flex-col">
   <div className="flex justify-end p-[var(--space-md)]">
    <ThemeToggle />
   </div>

   <div className="flex-1 flex items-center justify-center px-[var(--space-lg)]">
    <div className="w-full" style={{ maxWidth: "377px" }}>
     <div className="mb-[var(--space-2xl)]">
      <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-none">
       Comptoir
      </h1>
      <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)] tracking-wide">
       {forced ? t("changePassword.titleForced") : t("changePassword.titleStandalone")}
      </p>
     </div>

     {forced && (
      <p className="mb-[var(--space-lg)] text-[length:var(--text-xs)] leading-relaxed text-muted-foreground">
       {t("changePassword.forcedIntro")}
      </p>
     )}

     {done ? (
      <div className="space-y-[var(--space-lg)]">
       <div className="p-[var(--space-md)] border border-foreground/20 bg-foreground/5">
        <p className="text-[length:var(--text-sm)] font-medium">{t("changePassword.doneTitle")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
         {t("changePassword.doneBody")}
        </p>
       </div>
       <Button
        onClick={() => { window.location.href = "/"; }}
        className="w-full h-[var(--space-2xl)] text-[length:var(--text-sm)] tracking-wide font-bold"
       >
        {t("actions.continue")}
       </Button>
      </div>
     ) : (
      <form onSubmit={handleSubmit} className="space-y-[var(--space-lg)]">
       <div className="space-y-[var(--space-sm)]">
        <Label htmlFor="currentPassword" className="text-[length:var(--text-xs)] tracking-wide font-medium">
         {t("fields.currentPassword")}
        </Label>
        <Input
         id="currentPassword"
         type="password"
         value={currentPassword}
         onChange={(e) => setCurrentPassword(e.target.value)}
         placeholder="••••••••"
         required
         autoFocus
         className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)]"
        />
       </div>

       <div className="space-y-[var(--space-sm)]">
        <Label htmlFor="newPassword" className="text-[length:var(--text-xs)] tracking-wide font-medium">
         {t("fields.newPassword")}
        </Label>
        <Input
         id="newPassword"
         type="password"
         value={newPassword}
         onChange={(e) => setNewPassword(e.target.value)}
         placeholder="••••••••"
         required
         minLength={8}
         className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)]"
        />
       </div>

       <div className="space-y-[var(--space-sm)]">
        <Label htmlFor="confirmPassword" className="text-[length:var(--text-xs)] tracking-wide font-medium">
         {t("fields.confirm")}
        </Label>
        <Input
         id="confirmPassword"
         type="password"
         value={confirmPassword}
         onChange={(e) => setConfirmPassword(e.target.value)}
         placeholder="••••••••"
         required
         minLength={8}
         className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)]"
        />
       </div>

       <PasswordAdvice />

       {error && (
        <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>
       )}

       <Button
        type="submit"
        className="w-full h-[var(--space-2xl)] text-[length:var(--text-sm)] tracking-wide font-bold"
        disabled={loading}
       >
        {loading ? "..." : t("actions.save")}
       </Button>

       <div className="text-center">
        <button
         type="button"
         onClick={async () => { await logout(); window.location.href = "/"; }}
         className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide transition-colors"
        >
         {t("actions.signOut")}
        </button>
       </div>
      </form>
     )}
    </div>
   </div>
  </div>
 );
}
