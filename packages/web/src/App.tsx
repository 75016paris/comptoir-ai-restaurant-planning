import { type ReactNode, lazy, Suspense, useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { AuthProvider } from "@/hooks/auth-provider";
import { AppLayout } from "@/components/layout";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/hooks/theme-provider";
import { setSubscriptionBlockedHandler, type AuthUser } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import type { Permission } from "@comptoir/shared";

// Lazy-loaded pages — each becomes its own chunk
const LoginPage = lazy(() => import("@/pages/login").then(m => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import("@/pages/register").then(m => ({ default: m.RegisterPage })));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password").then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password").then(m => ({ default: m.ResetPasswordPage })));
const DemoPage = lazy(() => import("@/pages/demo").then(m => ({ default: m.DemoPage })));
const WatchDemoPage = lazy(() => import("@/pages/watch-demo").then(m => ({ default: m.WatchDemoPage })));
const AdminSchedulePage = lazy(() => import("@/pages/admin/schedule").then(m => ({ default: m.AdminSchedulePage })));
const StaffPage = lazy(() => import("@/pages/admin/staff").then(m => ({ default: m.StaffPage })));
const HoursPage = lazy(() => import("@/pages/admin/hours").then(m => ({ default: m.HoursPage })));
const EmployeePage = lazy(() => import("@/pages/admin/employee").then(m => ({ default: m.EmployeePage })));
const PreferencesPage = lazy(() => import("@/pages/admin/preferences").then(m => ({ default: m.PreferencesPage })));
const ObjectifCalendarPage = lazy(() => import("@/pages/admin/objectif-calendar").then(m => ({ default: m.ObjectifCalendarPage })));
const ObjectifTitulairesPage = lazy(() => import("@/pages/admin/objectif-titulaires").then(m => ({ default: m.ObjectifTitulairesPage })));
const OptimizePage = lazy(() => import("@/pages/admin/optimize").then(m => ({ default: m.OptimizePage })));

const MySchedulePage = lazy(() => import("@/pages/worker/my-schedule").then(m => ({ default: m.MySchedulePage })));
const MyHoursPage = lazy(() => import("@/pages/worker/my-hours").then(m => ({ default: m.MyHoursPage })));
const MyProfilePage = lazy(() => import("@/pages/worker/my-profile").then(m => ({ default: m.MyProfilePage })));
const HolidaysPage = lazy(() => import("@/pages/holidays").then(m => ({ default: m.HolidaysPage })));
const HolidaysCalendarPage = lazy(() => import("@/pages/holidays-calendar").then(m => ({ default: m.HolidaysCalendarPage })));
const SubscriptionBlockedPage = lazy(() => import("@/pages/subscription-blocked").then(m => ({ default: m.SubscriptionBlockedPage })));
const WhatsAppDemoPage = lazy(() => import("@/pages/whatsapp-demo").then(m => ({ default: m.WhatsAppDemoPage })));
const DemoWhatsAppRedirect = lazy(() => import("@/pages/demo-whatsapp-redirect").then(m => ({ default: m.DemoWhatsAppRedirect })));
const ChangePasswordPage = lazy(() => import("@/pages/change-password").then(m => ({ default: m.ChangePasswordPage })));
const LegalAcceptancePage = lazy(() => import("@/pages/legal-acceptance").then(m => ({ default: m.LegalAcceptancePage })));
const OnboardingPage = lazy(() => import("@/pages/onboarding").then(m => ({ default: m.OnboardingPage })));
const PublicDossierPage = lazy(() => import("@/pages/dossier").then(m => ({ default: m.PublicDossierPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const APP_VERSION = __APP_VERSION__;
const VERSION_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const VERSION_TOAST_ID = "new-version-available";

type VersionPayload = {
 version?: unknown;
};

function VersionUpdateNotifier() {
 useEffect(() => {
  let cancelled = false;
  let updateFound = false;

  async function checkVersion() {
   if (updateFound) return;

   try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;

    const payload = await response.json() as VersionPayload;
    const remoteVersion = typeof payload.version === "string" ? payload.version : null;
    if (cancelled || !remoteVersion || remoteVersion === APP_VERSION) return;

    updateFound = true;

    toast("Nouvelle version disponible", {
     id: VERSION_TOAST_ID,
     action: {
      label: "Actualiser",
      onClick: () => window.location.reload(),
     },
     duration: Number.POSITIVE_INFINITY,
    });
   } catch {
    // Ignore silently: the app must keep working if the static version file is unavailable.
   }
  }

  void checkVersion();
  const intervalId = window.setInterval(() => void checkVersion(), VERSION_CHECK_INTERVAL_MS);

  return () => {
   cancelled = true;
   window.clearInterval(intervalId);
  };
 }, []);

 return null;
}

function defaultHomeRoute(user: AuthUser | null | undefined): string {
 if (!user) return "/";
 if (user.role === "admin" || user.role === "manager") {
  if (hasPermission(user, "PLANNING_EDIT")) return "/schedule";
  if (hasPermission(user, "TEAM_VIEW")) return "/staff";
  if (hasPermission(user, "HOURS_VIEW")) return "/hours";
  return "/holidays";
 }
 return "/my-schedule";
}

function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
 const { user } = useAuth();
 if (!user || !roles.includes(user.role)) {
 return <Navigate to={defaultHomeRoute(user)} replace />;
 }
 return <>{children}</>;
}

function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
 const { user } = useAuth();
 if (!hasPermission(user, permission)) {
  return <Navigate to={defaultHomeRoute(user)} replace />;
 }
 return <>{children}</>;
}

function AppRoutes() {
 const { user, loading } = useAuth();
 const [blocked, setBlocked] = useState(false);

 const handleBlocked = useCallback(() => setBlocked(true), []);

 useEffect(() => {
 setSubscriptionBlockedHandler(handleBlocked);
 }, [handleBlocked]);

 if (loading) {
 return (
 <div className="min-h-screen flex items-center justify-center">
 <p className="text-muted-foreground">Loading...</p>
 </div>
 );
 }

 if (!user) {
 return (
 <Routes>
 <Route path="/register" element={<RegisterPage />} />
 <Route path="/forgot-password" element={<ForgotPasswordPage />} />
 <Route path="/reset-password" element={<ResetPasswordPage />} />
 <Route path="/dossier/:token" element={<PublicDossierPage />} />
 <Route path="/demo" element={<DemoPage />} />
 <Route path="/watch-demo" element={<WatchDemoPage />} />
 <Route path="/demo/whatsapp" element={<DemoWhatsAppRedirect />} />
 <Route path="*" element={<LoginPage />} />
 </Routes>
 );
 }

 // First-login gate (id:8c1d) — force password change before anything else.
 if (user.mustChangePassword) {
 return (
 <Routes>
 <Route path="*" element={<ChangePasswordPage />} />
 </Routes>
 );
 }

 // Legal gates (id:2d5d) — owner/admin accepts binding CGU/DPA; workers/managers acknowledge user notices.
 if (user.ownerLegalAcceptanceRequired || user.userNoticeAcceptanceRequired) {
 return (
 <Routes>
 <Route path="*" element={<LegalAcceptancePage />} />
 </Routes>
 );
 }

 // Onboarding gate (id:d8a5) — admins must finish the setup wizard before reaching the app.
 if (user.role === "admin" && !user.onboardingCompletedAt) {
 return (
 <Routes>
 <Route path="/onboarding" element={<Navigate to="/onboarding/profil" replace />} />
 <Route path="/onboarding/:step" element={<OnboardingPage />} />
 <Route path="/preferences/objectif/:profileId" element={<div className="max-w-7xl mx-auto px-[var(--space-lg)] py-[var(--space-lg)]"><ObjectifCalendarPage /></div>} />
 <Route path="/preferences/objectif/:profileId/titulaires" element={<div className="max-w-7xl mx-auto"><ObjectifTitulairesPage /></div>} />
 <Route path="*" element={<Navigate to="/onboarding/profil" replace />} />
 </Routes>
 );
 }

 // Subscription expired — show blocked screen but allow preferences
 if (user && blocked) {
 return (
 <Routes>
 <Route element={<AppLayout />}>
 <Route path="/preferences" element={<PreferencesPage />} />
 <Route path="*" element={<SubscriptionBlockedPage />} />
 </Route>
 </Routes>
 );
 }

 const homeRoute = defaultHomeRoute(user);

 return (
 <Routes>
 {/* Fullscreen routes — no AppLayout chrome */}
 <Route path="/change-password" element={<ChangePasswordPage />} />
 <Route path="/watch-demo" element={<WatchDemoPage />} />
 {/* Magic-link dossier — same component for both logged-in and out users; the
     token is its own auth, so an admin opening their own test invite lands here
     instead of being bounced to /schedule by the catch-all below. */}
 <Route path="/dossier/:token" element={<PublicDossierPage />} />

 <Route element={<AppLayout />}>
 {/* Admin + manager routes (operational dashboard) */}
 <Route path="/schedule" element={<RequireRole roles={["admin", "manager"]}><RequirePermission permission="PLANNING_EDIT"><AdminSchedulePage /></RequirePermission></RequireRole>} />
 <Route path="/staff" element={<RequireRole roles={["admin", "manager"]}><RequirePermission permission="TEAM_VIEW"><StaffPage /></RequirePermission></RequireRole>} />
 <Route path="/staff/:id" element={<RequireRole roles={["admin", "manager"]}><RequirePermission permission="TEAM_VIEW"><EmployeePage /></RequirePermission></RequireRole>} />
 <Route path="/hours" element={<RequireRole roles={["admin", "manager"]}><RequirePermission permission="HOURS_VIEW"><HoursPage /></RequirePermission></RequireRole>} />
 <Route path="/optimize" element={<RequireRole roles={["admin", "manager"]}><RequirePermission permission="OPTIMIZE_RUN"><OptimizePage /></RequirePermission></RequireRole>} />
 {/* Admin-only routes (restaurant settings) */}
 <Route path="/preferences" element={<RequireRole roles={["admin"]}><PreferencesPage /></RequireRole>} />
 <Route path="/preferences/objectif/:profileId" element={<RequireRole roles={["admin"]}><ObjectifCalendarPage /></RequireRole>} />
 <Route path="/preferences/objectif/:profileId/titulaires" element={<RequireRole roles={["admin", "manager"]}><RequirePermission permission="PLANNING_EDIT"><ObjectifTitulairesPage /></RequirePermission></RequireRole>} />


 {/* Worker routes */}
 <Route path="/my-schedule" element={<RequireRole roles={["kitchen", "floor"]}><MySchedulePage /></RequireRole>} />
 <Route path="/my-hours" element={<RequireRole roles={["kitchen", "floor"]}><MyHoursPage /></RequireRole>} />
 <Route path="/my-profile" element={<RequireRole roles={["kitchen", "floor"]}><MyProfilePage /></RequireRole>} />

 {/* Shared routes */}
 <Route path="/holidays" element={<HolidaysPage />} />
 <Route path="/holidays/calendar" element={<HolidaysCalendarPage />} />
 <Route path="/whatsapp-demo" element={<WhatsAppDemoPage />} />

 {/* Default redirect */}
 <Route path="*" element={<Navigate to={homeRoute} replace />} />
 </Route>
 </Routes>
 );
}

const PageLoader = (
 <div className="min-h-screen flex items-center justify-center">
 <p className="text-muted-foreground">Loading...</p>
 </div>
);

function SiteFooter() {
 return (
 <footer className="border-t border-border px-[var(--space-md)] py-[var(--space-md)] text-center text-[length:var(--text-xs)] text-muted-foreground flex items-center justify-center gap-[var(--space-sm)]">
 <a href="/cgu.html" className="hover:text-foreground transition-colors">
 CGU
 </a>
 <span aria-hidden="true">·</span>
 <a href="/confidentialite.html" className="hover:text-foreground transition-colors">
 Confidentialité & RGPD
 </a>
 </footer>
 );
}

export default function App() {
 return (
 <ThemeProvider>
 <QueryClientProvider client={queryClient}>
 <BrowserRouter>
 <AuthProvider>
 <Suspense fallback={PageLoader}>
 <AppRoutes />
 </Suspense>
 <SiteFooter />
 <VersionUpdateNotifier />
 <Toaster />
 </AuthProvider>
 </BrowserRouter>
 {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />}
 </QueryClientProvider>
 </ThemeProvider>
 );
}
