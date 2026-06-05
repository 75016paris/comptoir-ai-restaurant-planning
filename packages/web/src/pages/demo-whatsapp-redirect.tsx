/**
 * Auto-login redirect for direct WhatsApp demo links.
 * /demo/whatsapp → auto-login as Chez Reno admin → /whatsapp-demo
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";

const DEMO_ADMIN_EMAIL = "reno@chezreno.fr";

export function DemoWhatsAppRedirect() {
 const { t } = useTranslation("demo");
 const { user, loading, demoLogin } = useAuth();
 const [error, setError] = useState("");
 const loginStartedRef = useRef(false);

 useEffect(() => {
 if (loading) return;
 // Already logged in as demo admin → redirect
 if (user?.restaurantStatus === "demo") return;
 // Not logged in → auto-login
 if (!user && !loginStartedRef.current) {
 loginStartedRef.current = true;
 demoLogin(DEMO_ADMIN_EMAIL).catch((err) => {
 setError(err instanceof Error ? err.message : t("redirect.loginError"));
 loginStartedRef.current = false;
 });
 }
 }, [user, loading, demoLogin, t]);

 if (error) {
 return (
 <div className="min-h-screen flex items-center justify-center">
 <p className="text-destructive text-[length:var(--text-sm)]">{error}</p>
 </div>
 );
 }

 // Once logged in as demo, redirect to the WhatsApp demo page
 if (user?.restaurantStatus === "demo") {
 return <Navigate to="/whatsapp-demo" replace />;
 }

 // Loading / logging in
 return (
 <div className="min-h-screen flex items-center justify-center">
 <p className="text-muted-foreground text-[length:var(--text-sm)]">{t("redirect.loadingDemo")}</p>
 </div>
 );
}
