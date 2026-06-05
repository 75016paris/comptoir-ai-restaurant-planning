import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useSearchParams, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme-toggle";

export function LoginPage() {
 const { t } = useTranslation("auth");
 const { login } = useAuth();
 const [searchParams] = useSearchParams();
 const [email, setEmail] = useState("");
 const [password, setPassword] = useState("");
 const [error, setError] = useState("");
 const [loading, setLoading] = useState(false);

 const justRegistered = searchParams.get("registered") === "1";
 const contactHref = `mailto:info@cosmobot.fr?subject=${encodeURIComponent(t("login.contactSubject"))}&body=${encodeURIComponent(t("login.contactBody"))}`;

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 setError("");
 setLoading(true);
 try {
 await login(email, password);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : t("login.loginFailed"));
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

 {/* Login form — golden ratio positioning */}
 <div className="flex-1 flex items-center justify-center px-[var(--space-lg)]">
 <div className="w-full" style={{ maxWidth: "377px" }}>
 {/* Brand */}
 <div className="relative mb-[var(--space-3xl)]">
 <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-none">
 Comptoir
 </h1>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)] tracking-wide">
 {t("brand.tagline")}
 </p>
 </div>

 {/* Success message after registration */}
 {justRegistered && (
 <div className="mb-[var(--space-lg)] p-[var(--space-md)] border border-foreground/20 bg-foreground/5">
 <p className="text-[length:var(--text-sm)] font-medium">
 {t("login.registeredTitle")}
 </p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
 {t("login.registeredBody")}
 </p>
 </div>
 )}

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
 className="h-[var(--space-2xl)] border-foreground/20 bg-transparent text-[length:var(--text-base)]"
 />
 </div>
 <div className="space-y-[var(--space-sm)]">
 <Label htmlFor="password" className="text-[length:var(--text-xs)] tracking-wide font-medium">
 {t("fields.password")}
 </Label>
 <Input
 id="password"
 type="password"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 placeholder="••••••••"
 required
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
 {loading ? "..." : t("actions.signIn")}
 </Button>

 <div className="text-center">
 <Link
 to="/forgot-password"
 className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide transition-colors"
 >
 {t("actions.forgotPassword")}
 </Link>
 </div>
 </form>

 {/* Separator */}
 <div className="flex items-center gap-[var(--space-md)] my-[var(--space-xl)]">
 <div className="flex-1 h-px bg-border" />
 <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{t("login.or")}</span>
 <div className="flex-1 h-px bg-border" />
 </div>

 {/* Create account */}
 <Link to="/register">
 <Button
 variant="outline"
 className="w-full h-[var(--space-2xl)] text-[length:var(--text-sm)] tracking-wide font-bold border-foreground/20"
 >
 {t("actions.createAccount")}
 </Button>
 </Link>

 {/* Help request */}
 <div className="mt-[var(--space-lg)] p-[var(--space-md)] border border-border bg-muted/30 text-center">
 <p className="text-[length:var(--text-xs)] text-muted-foreground leading-relaxed mb-[var(--space-md)]">
 {t("login.contactIntro")}
 </p>
 <a
 href={contactHref}
 className="inline-flex w-full h-[var(--space-2xl)] items-center justify-center rounded-full border border-foreground/20 text-[length:var(--text-sm)] tracking-wide font-bold hover:bg-muted transition-colors"
 >
 {t("actions.requestContact")}
 </a>
 </div>

 {/* Watch video */}
 <div className="mt-[var(--space-lg)] text-center">
 <Link
 to="/watch-demo"
 className="inline-flex items-center gap-[var(--space-sm)] text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide font-bold transition-colors"
 >
 {t("actions.watchVideo")}
 <span className="text-[length:var(--text-sm)]">&rarr;</span>
 </Link>
 </div>

 {/* Demo link */}
 <div className="mt-[var(--space-xl)] pt-[var(--space-lg)] border-t border-border text-center">
 <Link
 to="/demo"
 className="inline-flex items-center gap-[var(--space-sm)] text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide font-bold transition-colors"
 >
 {t("actions.tryDemo")}
 <span className="text-[length:var(--text-sm)]">&rarr;</span>
 </Link>
 </div>

 </div>
 </div>
 </div>
 );
}

