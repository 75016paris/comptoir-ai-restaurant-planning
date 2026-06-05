import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme-toggle";

export function ForgotPasswordPage() {
 const { t } = useTranslation("auth");
 const [email, setEmail] = useState("");
 const [sent, setSent] = useState(false);
 const [error, setError] = useState("");
 const [loading, setLoading] = useState(false);

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 setError("");
 setLoading(true);
 try {
 await api.forgotPassword(email);
 setSent(true);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : t("forgotPassword.genericError"));
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
 {/* Brand */}
 <div className="mb-[var(--space-2xl)]">
 <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-none">
 Comptoir
 </h1>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)] tracking-wide">
 {t("forgotPassword.title")}
 </p>
 </div>

 {sent ? (
 <div className="space-y-[var(--space-lg)]">
 <div className="p-[var(--space-md)] border border-foreground/20 bg-foreground/5">
 <p className="text-[length:var(--text-sm)] font-medium">
 {t("forgotPassword.sentTitle")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
 {t("forgotPassword.sentBody")}
 </p>
 </div>

 <div className="text-center">
 <Link
 to="/"
 className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide transition-colors"
 >
 {t("actions.backToLogin")}
 </Link>
 </div>
 </div>
 ) : (
 <>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mb-[var(--space-lg)]">
 {t("forgotPassword.intro")}
 </p>

 <form onSubmit={handleSubmit} className="space-y-[var(--space-lg)]">
 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="email" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.email")}
 </Label>
 <Input
 id="email"
 type="email"
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 placeholder={t("fields.emailPlaceholder")}
 required
 autoFocus
 className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)]"
 />
 </div>

 {error && (
 <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>
 )}

 <Button
 type="submit"
 className="w-full h-[var(--space-2xl)] text-[length:var(--text-sm)] tracking-wide font-bold"
 disabled={loading}
 >
 {loading ? "..." : t("actions.sendLink")}
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
