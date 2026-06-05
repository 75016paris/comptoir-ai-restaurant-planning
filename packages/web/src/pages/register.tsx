import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme-toggle";
import { PasswordAdvice } from "@/components/password-advice";

export function RegisterPage() {
 const { t } = useTranslation("auth");
 const [searchParams] = useSearchParams();
 const [form, setForm] = useState({
 adminName: "",
 email: "",
 phone: "",
 password: "",
 confirmPassword: "",
 });
 const [error, setError] = useState("");
 const [loading, setLoading] = useState(false);

 const cancelled = searchParams.get("cancelled") === "1";

 const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
 setForm((f) => ({ ...f, [field]: e.target.value }));

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 setError("");

 if (form.password !== form.confirmPassword) {
 setError(t("register.passwordsDoNotMatch"));
 return;
 }
 if (form.password.length < 8) {
 setError(t("register.passwordTooShort"));
 return;
 }

 setLoading(true);
 try {
 const res = await api.register({
 adminName: form.adminName,
 email: form.email,
 phone: form.phone,
 password: form.password,
 });
 // Redirect to Stripe checkout or success page
 window.location.href = res.data.url;
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : t("register.registerFailed"));
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="min-h-screen bg-background flex flex-col">
 {/* Top bar */}
 <div className="flex justify-end p-[var(--space-md)]">
 <ThemeToggle />
 </div>

 <div className="flex-1 flex items-center justify-center px-[var(--space-lg)] py-[var(--space-xl)]">
 <div className="w-full" style={{ maxWidth: "377px" }}>
 {/* Brand */}
 <div className="mb-[var(--space-2xl)]">
 <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-none">
 Comptoir
 </h1>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)] tracking-wide">
 {t("register.title")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
 {t("register.pricing")}
 </p>
 </div>

 {cancelled && (
 <div className="mb-[var(--space-lg)] p-[var(--space-md)] border border-foreground/20 bg-foreground/5">
 <p className="text-[length:var(--text-sm)] font-medium">
 {t("register.cancelledTitle")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
 {t("register.cancelledBody")}
 </p>
 </div>
 )}

 <form onSubmit={handleSubmit} className="space-y-[var(--space-md)]">
 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="adminName" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.yourName")}
 </Label>
 <Input
 id="adminName"
 value={form.adminName}
 onChange={set("adminName")}
 placeholder={t("fields.yourNamePlaceholder")}
 required
 className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)] rounded-full px-[var(--space-md)]"
 />
 </div>

 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="email" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.email")}
 </Label>
 <Input
 id="email"
 type="email"
 value={form.email}
 onChange={set("email")}
 placeholder={t("fields.emailPlaceholder")}
 required
 className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)] rounded-full px-[var(--space-md)]"
 />
 </div>

 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="phone" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.phone")}
 </Label>
 <Input
 id="phone"
 type="tel"
 value={form.phone}
 onChange={set("phone")}
 placeholder={t("fields.phonePlaceholder")}
 required
 className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)] rounded-full px-[var(--space-md)]"
 />
 </div>

 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="password" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.password")}
 </Label>
 <Input
 id="password"
 type="password"
 value={form.password}
 onChange={set("password")}
 placeholder="••••••••"
 required
 minLength={8}
 className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)] rounded-full px-[var(--space-md)]"
 />
 </div>

 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="confirmPassword" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.confirmPassword")}
 </Label>
 <Input
 id="confirmPassword"
 type="password"
 value={form.confirmPassword}
 onChange={set("confirmPassword")}
 placeholder="••••••••"
 required
 minLength={8}
 className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)] rounded-full px-[var(--space-md)]"
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
 {loading ? "..." : t("actions.freeTrialCta")}
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
 </div>
 </div>
 </div>
 );
}
