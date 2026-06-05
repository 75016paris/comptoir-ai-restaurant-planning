import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme-toggle";
import { PasswordAdvice } from "@/components/password-advice";

export function ResetPasswordPage() {
 const { t } = useTranslation("auth");
 const [searchParams] = useSearchParams();
 const token = searchParams.get("token") || "";
 const [password, setPassword] = useState("");
 const [confirmPassword, setConfirmPassword] = useState("");
 const [done, setDone] = useState(false);
 const [error, setError] = useState("");
 const [loading, setLoading] = useState(false);

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 setError("");

 if (password !== confirmPassword) {
 setError(t("register.passwordsDoNotMatch"));
 return;
 }
 if (password.length < 8) {
 setError(t("register.passwordTooShort"));
 return;
 }

 setLoading(true);
 try {
 await api.resetPassword(token, password);
 setDone(true);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : t("resetPassword.genericError"));
 } finally {
 setLoading(false);
 }
 };

 if (!token) {
 return (
 <div className="min-h-screen bg-background flex flex-col">
 <div className="flex justify-end p-[var(--space-md)]">
 <ThemeToggle />
 </div>
 <div className="flex-1 flex items-center justify-center px-[var(--space-lg)]">
 <div className="w-full text-center" style={{ maxWidth: "377px" }}>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mb-[var(--space-lg)]">
 {t("resetPassword.invalidLinkBody")}
 </p>
 <Link
 to="/forgot-password"
 className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide transition-colors"
 >
 {t("actions.forgotPassword")}
 </Link>
 </div>
 </div>
 </div>
 );
 }

 return (
 <div className="min-h-screen bg-background flex flex-col">
 <div className="flex justify-end p-[var(--space-md)]">
 <ThemeToggle />
 </div>

 <div className="flex-1 flex items-center justify-center px-[var(--space-lg)]">
 <div className="w-full" style={{ maxWidth: "377px" }}>
 {/* Brand */}
 <div className="mb-[var(--space-2xl)]">
 <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-none">
 Comptoir
 </h1>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)] tracking-wide">
 {t("resetPassword.title")}
 </p>
 </div>

 {done ? (
 <div className="space-y-[var(--space-lg)]">
 <div className="p-[var(--space-md)] border border-foreground/20 bg-foreground/5">
 <p className="text-[length:var(--text-sm)] font-medium">
 {t("resetPassword.doneTitle")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
 {t("resetPassword.doneBody")}
 </p>
 </div>

 <Link to="/">
 <Button className="w-full h-[var(--space-2xl)] text-[length:var(--text-sm)] tracking-wide font-bold">
 {t("resetPassword.doneCta")}
 </Button>
 </Link>
 </div>
 ) : (
 <>
 <form onSubmit={handleSubmit} className="space-y-[var(--space-lg)]">
 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="password" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.newPassword")}
 </Label>
 <Input
 id="password"
 type="password"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 placeholder="••••••••"
 required
 minLength={8}
 autoFocus
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
 {loading ? "..." : t("actions.reset")}
 </Button>
 </form>

 <div className="mt-[var(--space-xl)] text-center">
 <Link
 to="/"
 className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide transition-colors"
 >
 {t("actions.backToLogin")}
 </Link>
 </div>
 </>
 )}
 </div>
 </div>
 </div>
 );
}
