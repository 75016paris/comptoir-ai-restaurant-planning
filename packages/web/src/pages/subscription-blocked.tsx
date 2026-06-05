import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export function SubscriptionBlockedPage() {
 const { t } = useTranslation("auth");
 const { user, logout } = useAuth();
 const [portalLoading, setPortalLoading] = useState(false);

 const openPortal = async () => {
 setPortalLoading(true);
 try {
 const res = await api.createBillingPortal();
 window.location.href = res.data.url;
 } catch {
 // No Stripe linked — fallback to preferences
 window.location.href = "/preferences";
 } finally {
 setPortalLoading(false);
 }
 };

 return (
 <div className="min-h-screen bg-background flex flex-col">
 <div className="flex justify-end p-[var(--space-md)]">
 <ThemeToggle />
 </div>

 <div className="flex-1 flex items-center justify-center px-[var(--space-lg)]">
 <div className="w-full" style={{ maxWidth: "420px" }}>
 <div className="mb-[var(--space-2xl)]">
 <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-none">
 Comptoir
 </h1>
 </div>

 <div className="space-y-[var(--space-lg)]">
 <div className="space-y-[var(--space-sm)]">
 <p className="text-[length:var(--text-xs)] tracking-wide font-bold text-red-600 dark:text-red-400">
 {t("subscriptionBlocked.statusBadge")}
 </p>
 <p className="text-[length:var(--text-base)] leading-relaxed">
 {t("subscriptionBlocked.summary")}
 </p>
 <p className="text-[length:var(--text-sm)] text-muted-foreground leading-relaxed">
 {t("subscriptionBlocked.reassurance")}
 </p>
 </div>

 {user?.role === "admin" ? (
 <div className="space-y-[var(--space-sm)]">
 <Button
 className="w-full h-[var(--space-2xl)] text-[length:var(--text-sm)] tracking-wide font-bold"
 onClick={openPortal}
 disabled={portalLoading}
 >
 {portalLoading ? "..." : t("actions.reactivate")}
 </Button>
 <Button
 variant="outline"
 className="w-full h-[var(--space-2xl)] text-[length:var(--text-sm)] tracking-wide font-bold"
 onClick={() => window.location.href = "/preferences"}
 >
 {t("actions.preferences")}
 </Button>
 </div>
 ) : (
 <div className="p-[var(--space-md)] border border-foreground/20 bg-foreground/5">
 <p className="text-[length:var(--text-sm)] text-muted-foreground">
 {t("subscriptionBlocked.workerNote")}
 </p>
 </div>
 )}

 <button
 onClick={logout}
 className="text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground tracking-wide transition-colors"
 >
 {t("actions.signOut")}
 </button>
 </div>
 </div>
 </div>
 </div>
 );
}
