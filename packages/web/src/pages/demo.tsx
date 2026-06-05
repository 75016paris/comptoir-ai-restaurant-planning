import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/theme-toggle";

type DemoRestaurant = {
 key: string;
 accounts: { email: string; nameKey: "manager" | "worker"; name?: string; roleKey: "manager" | "floor" }[];
};

const DEMO_RESTAURANTS: DemoRestaurant[] = [
 {
 key: "monRestaurant",
 accounts: [
 { email: "nouveau@nouveau-restaurant.fr", nameKey: "manager", roleKey: "manager" },
 ],
 },
 {
 key: "chezReno",
 accounts: [
 { email: "reno@chezreno.fr", name: "Jean Reno", nameKey: "manager", roleKey: "manager" },
 { email: "sy@chezreno.fr", name: "Omar Sy", nameKey: "worker", roleKey: "floor" },
 ],
 },
 {
 key: "grandBrasserie",
 accounts: [
 { email: "freeman@grandbrasserie.fr", name: "Morgan Freeman", nameKey: "manager", roleKey: "manager" },
 { email: "hanks@grandbrasserie.fr", name: "Tom Hanks", nameKey: "worker", roleKey: "floor" },
 ],
 },
];

export function DemoPage() {
 const { t } = useTranslation("demo");
 const { demoLogin } = useAuth();
 const [loading, setLoading] = useState<string | null>(null);
 const [error, setError] = useState("");

 const handleLogin = async (email: string) => {
 setError("");
 setLoading(email);
 try {
 await demoLogin(email);
 } catch (err: unknown) {
 setError(err instanceof Error ? err.message : t("page.loginError"));
 setLoading(null);
 }
 };

 return (
 <div className="min-h-screen bg-background flex flex-col">
 {/* Top bar */}
 <div className="flex justify-end p-[var(--space-md)]">
 <ThemeToggle />
 </div>

 <div className="flex-1 flex items-center justify-center px-[var(--space-lg)] py-[var(--space-xl)]">
 <div className="w-full" style={{ maxWidth: "480px" }}>
 {/* Brand */}
 <div className="mb-[var(--space-2xl)]">
 <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-none">
 Comptoir
 </h1>
 <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)] tracking-wide">
 {t("page.subtitle")}
 </p>
 </div>

 <p className="text-[length:var(--text-sm)] text-muted-foreground mb-[var(--space-lg)]">
 {t("page.intro")}
 </p>

 {error && (
 <p className="text-[length:var(--text-sm)] text-destructive font-medium mb-[var(--space-md)]">{error}</p>
 )}

 {/* Restaurant sections */}
 <div className="space-y-[var(--space-2xl)]">
 {DEMO_RESTAURANTS.map((resto) => (
 <div key={resto.key}>
 {/* Restaurant header */}
 <div className="mb-[var(--space-md)]">
 <div className="flex items-baseline gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-lg)] font-bold tracking-[-0.02em]">
 {t(`restaurants.${resto.key}.name`)}
 </span>
 <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide font-medium">
 {t(`restaurants.${resto.key}.subtitle`)}
 </span>
 </div>
 <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
 {t(`restaurants.${resto.key}.description`)}
 </p>
 </div>

 {/* Account cards */}
 <div className="space-y-[var(--space-sm)]">
 {resto.accounts.map((account) => {
 const displayName = account.name ?? t("demoNames.newManager");
 const description = t(`restaurants.${resto.key}.${account.nameKey}`);
 const role = t(`roles.${account.roleKey}`);
 return (
 <button
 key={account.email}
 onClick={() => handleLogin(account.email)}
 disabled={loading !== null}
 className="w-full text-left p-[var(--space-md)] border border-foreground/15 hover:border-foreground/40 transition-colors group cursor-pointer disabled:opacity-50 disabled:cursor-wait"
 >
 <div className="flex items-baseline justify-between mb-[var(--space-xs)]">
 <span className="text-[length:var(--text-base)] font-bold tracking-[-0.02em]">
 {displayName}
 </span>
 <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide font-medium">
 {role}
 </span>
 </div>
 <p className="text-[length:var(--text-xs)] text-muted-foreground leading-[var(--lh-body)]">
 {description}
 </p>
 <div className="mt-[var(--space-sm)] flex items-center gap-[var(--space-sm)]">
 <span className="text-[length:var(--text-xs)] tracking-wide font-bold group-hover:underline underline-offset-4">
 {loading === account.email ? t("page.connecting") : t("page.signIn")}
 </span>
 <span className="text-[length:var(--text-sm)] opacity-0 group-hover:opacity-100 transition-opacity">&rarr;</span>
 </div>
 </button>
 );
 })}
 </div>
 </div>
 ))}
 </div>

 <div className="mt-[var(--space-xl)] text-center">
 <Link
 to="/"
 className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide transition-colors"
 >
 {t("page.backToLogin")}
 </Link>
 </div>
 </div>
 </div>
 </div>
 );
}
