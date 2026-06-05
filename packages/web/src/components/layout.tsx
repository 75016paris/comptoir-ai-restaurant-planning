import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { UnderlineNav } from "@/components/underline-nav";
import { Drawer, DrawerContent, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Building2, Check, ChevronDown, Loader2, LogOut, Menu, Plus } from "lucide-react";
import { toast } from "sonner";
import { AdminAlertsPopup } from "@/components/admin-alerts-popup";
import { api, type AccessibleRestaurant } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { Permission } from "@comptoir/shared";
import {
 DropdownMenu,
 DropdownMenuContent,
 DropdownMenuGroup,
 DropdownMenuItem,
 DropdownMenuLabel,
 DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type NavLinkKey = "planning" | "team" | "hours" | "holidays" | "preferences" | "profile";
type NavItem = { to: string; key: NavLinkKey; permission?: Permission };

const adminNav: NavItem[] = [
 { to: "/schedule", key: "planning", permission: "PLANNING_EDIT" },
 { to: "/staff", key: "team", permission: "TEAM_VIEW" },
 { to: "/hours", key: "hours", permission: "HOURS_VIEW" },
 { to: "/holidays", key: "holidays" },
 { to: "/preferences", key: "preferences" },
];

// Manager nav — same as admin minus Préférences (RESTAURANT_SETTINGS is admin-only).
const managerNav: NavItem[] = [
 { to: "/schedule", key: "planning", permission: "PLANNING_EDIT" },
 { to: "/staff", key: "team", permission: "TEAM_VIEW" },
 { to: "/hours", key: "hours", permission: "HOURS_VIEW" },
 { to: "/holidays", key: "holidays" },
];

const workerNav: NavItem[] = [
 { to: "/my-schedule", key: "planning" },
 { to: "/my-hours", key: "hours" },
 { to: "/holidays", key: "holidays" },
 { to: "/my-profile", key: "profile" },
];

function activeKey(items: NavItem[], pathname: string): string {
 const match = items.find((i) => pathname === i.to || pathname.startsWith(i.to + "/"));
 return match?.to ?? "";
}

export function AppLayout() {
 const { t } = useTranslation("nav");
 const { user, logout, switchRestaurant } = useAuth();
 const location = useLocation();
 const navigate = useNavigate();
 const [menuOpen, setMenuOpen] = useState(false);
 const [switchingRestaurantId, setSwitchingRestaurantId] = useState<string | null>(null);
 const [createRestaurantOpen, setCreateRestaurantOpen] = useState(false);
 const isAdminLike = user?.role === "admin" || user?.role === "manager";
 const dossierStatusQuery = useQuery({
  queryKey: qk.employees.dossierStatus(),
  queryFn: async () => (await api.getDossierStatus()).data,
  enabled: !!user && isAdminLike,
  refetchInterval: 60_000,
 });

 if (!user) return null;

 const baseNav = user.role === "admin" ? adminNav : user.role === "manager" ? managerNav : workerNav;
 const nav = baseNav.filter((item) => !item.permission || hasPermission(user, item.permission));
 const teamBadge = (dossierStatusQuery.data?.totalPendingReview ?? 0) > 0 ? dossierStatusQuery.data!.totalPendingReview : 0;
 const navItems = nav.map((n) => {
  const label = t(`links.${n.key}`);
  if (n.key === "team" && teamBadge > 0) {
   return {
    value: n.to,
    href: n.to,
    label: (
     <span className="inline-flex items-center gap-[var(--space-xs)]">
      {label}
      <span
       className="text-[length:var(--text-2xs)] font-bold text-amber-100 bg-amber-600 dark:bg-amber-700 px-[var(--space-xs)] py-[1px] rounded-full leading-none min-w-[16px] text-center"
       title={`${teamBadge} document${teamBadge > 1 ? "s" : ""} en attente de validation`}
      >
       {teamBadge}
      </span>
     </span>
    ),
   };
  }
  return { value: n.to, href: n.to, label };
 });
 const activePath = activeKey(nav, location.pathname);
 const restaurants = user.restaurants ?? [];
 const canCreateRestaurant = user.role === "admin";
 const canSwitchRestaurant = restaurants.length > 1;
 const showRestaurantMenu = canSwitchRestaurant || canCreateRestaurant;
 const activeRestaurantId = user.activeRestaurantId ?? user.restaurantId;
 const handleRestaurantSwitch = async (restaurantId: string) => {
  if (restaurantId === activeRestaurantId || switchingRestaurantId) return;
  setSwitchingRestaurantId(restaurantId);
  try {
   await switchRestaurant(restaurantId);
   setMenuOpen(false);
  } finally {
   setSwitchingRestaurantId(null);
  }
 };
 const handleRestaurantCreated = async (restaurantId: string) => {
  setSwitchingRestaurantId(restaurantId);
  try {
   await switchRestaurant(restaurantId);
   setMenuOpen(false);
   navigate("/schedule", { replace: true });
  } finally {
   setSwitchingRestaurantId(null);
  }
 };

 return (
 <div className="min-h-screen bg-background">
 {/* Header */}
 <header className="border-b border-border sticky top-0 z-40 bg-background pt-[env(safe-area-inset-top)]">
 <div className="px-[var(--space-md)] md:px-[var(--space-lg)] h-[40px] md:h-[46px] flex items-center justify-between gap-[var(--space-sm)]">
 <div className="flex items-center gap-[var(--space-xl)] min-w-0">
 {/* Hamburger (phones only) */}
 <button
 type="button"
 aria-label={t("openMenu")}
 onClick={() => setMenuOpen(true)}
 className="sm:hidden touch-target -ml-1 mr-1 grid place-items-center h-8 w-8 text-muted-foreground hover:text-foreground"
 >
 <Menu size={18} strokeWidth={2} />
 </button>
 <Link to="/" className="font-heading font-bold text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] tracking-[-0.025em] shrink-0">
 Comptoir
 {user.restaurantName && !showRestaurantMenu && (
 <span className="hidden sm:inline font-thin opacity-20 mx-[0.3em]">·</span>
 )}
 {user.restaurantName && !showRestaurantMenu && (
 <span className="hidden sm:inline font-extralight text-foreground/25 tracking-normal text-[length:var(--text-xl)] md:text-[length:var(--text-2xl)]">{user.restaurantName}</span>
 )}
 </Link>
 {showRestaurantMenu && (
 <RestaurantSwitcher
  restaurants={restaurants}
  activeRestaurantId={activeRestaurantId}
  switchingRestaurantId={switchingRestaurantId}
  onSwitch={handleRestaurantSwitch}
  label={t("restaurantSwitcher.label")}
  switchingLabel={t("restaurantSwitcher.switching")}
  createLabel={t("restaurantSwitcher.create")}
  canCreate={canCreateRestaurant}
  onCreate={() => setCreateRestaurantOpen(true)}
  className="hidden sm:flex"
 />
 )}
 <div className="hidden lg:block">
 <UnderlineNav
 items={navItems}
 value={activePath}
 gapClassName="gap-[var(--space-lg)]"
 inactiveClassName="text-muted-foreground hover:text-foreground"
 />
 </div>
 </div>
 <div className="flex items-center gap-[var(--space-sm)] md:gap-[var(--space-md)] shrink-0">
 <span className="hidden sm:inline text-[length:var(--text-sm)] text-muted-foreground">
 {user.name}
 </span>
 <span className="sm:hidden text-[length:var(--text-xs)] text-muted-foreground font-medium truncate max-w-[80px]">
 {user.name.split(" ")[0]}
 </span>
 <ThemeToggle />
 <Button
 variant="ghost"
 size="sm"
 onClick={logout}
 className="text-muted-foreground hover:text-foreground p-1.5 touch-target"
 title={t("logout")}
 >
 <LogOut size={14} strokeWidth={2} />
 </Button>
 </div>
 </div>
 </header>

 {/* Horizontal nav strip (tablet: sm → lg) */}
 <div className="hidden sm:block lg:hidden border-b border-border sticky top-[40px] z-40 bg-background px-[var(--space-md)] overflow-x-auto scrollbar-none">
 <UnderlineNav
 items={navItems}
 value={activePath}
 gapClassName="gap-[var(--space-lg)]"
 inactiveClassName="text-muted-foreground hover:text-foreground"
 className="py-[var(--space-xs)] pr-[var(--space-lg)]"
 />
 </div>

 {/* Mobile Drawer menu (phones < sm) */}
 <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
 <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
 <div className="px-[var(--space-lg)] pt-[var(--space-md)] pb-[var(--space-lg)]">
 <DrawerTitle className="text-[length:var(--text-base)] font-semibold mb-[var(--space-xs)]">
 {user.restaurantName ?? "Comptoir"}
 </DrawerTitle>
 {showRestaurantMenu && (
 <RestaurantSwitcher
  restaurants={restaurants}
  activeRestaurantId={activeRestaurantId}
  switchingRestaurantId={switchingRestaurantId}
  onSwitch={handleRestaurantSwitch}
  label={t("restaurantSwitcher.label")}
  switchingLabel={t("restaurantSwitcher.switching")}
  createLabel={t("restaurantSwitcher.create")}
  canCreate={canCreateRestaurant}
  onCreate={() => setCreateRestaurantOpen(true)}
  className="mb-[var(--space-md)] w-full"
  align="start"
 />
 )}
 <DrawerDescription className="text-[length:var(--text-xs)] text-muted-foreground mb-[var(--space-lg)]">
 {t("drawer.navigation")}
 </DrawerDescription>
 <nav className="flex flex-col">
 {nav.map((item) => {
 const isActive = activePath === item.to;
 return (
 <button
 key={item.to}
 type="button"
 onClick={() => {
 setMenuOpen(false);
 navigate(item.to);
 }}
 className={
 "text-left py-[var(--space-md)] px-[var(--space-sm)] rounded-md text-[length:var(--text-base)] border-b border-border last:border-b-0 " +
 (isActive ? "font-semibold text-foreground" : "text-muted-foreground")
 }
 >
 {t(`links.${item.key}`)}
 </button>
 );
 })}
 </nav>
 </div>
 </DrawerContent>
 </Drawer>
 <CreateRestaurantDialog
  open={createRestaurantOpen}
  onOpenChange={setCreateRestaurantOpen}
  onCreated={handleRestaurantCreated}
 />

 {/* Content */}
 <main className="px-[var(--space-md)] md:px-[var(--space-lg)] pt-[5px] pb-[calc(var(--space-xl)+env(safe-area-inset-bottom))]">
 <Outlet />
 </main>
 {(user.role === "admin" || user.role === "manager") && <AdminAlertsPopup />}
 </div>
 );
}

function RestaurantSwitcher({
 restaurants,
 activeRestaurantId,
 switchingRestaurantId,
 onSwitch,
 label,
 switchingLabel,
 createLabel,
 canCreate,
 onCreate,
 className,
 align = "start",
}: {
 restaurants?: AccessibleRestaurant[];
 activeRestaurantId: string;
 switchingRestaurantId: string | null;
 onSwitch: (restaurantId: string) => void | Promise<void>;
 label: string;
 switchingLabel: string;
 createLabel: string;
 canCreate?: boolean;
 onCreate?: () => void;
 className?: string;
 align?: "start" | "center" | "end";
}) {
 const active = restaurants?.find((restaurant) => restaurant.id === activeRestaurantId);
 if ((!restaurants || restaurants.length === 0) && !canCreate) return null;

 return (
 <DropdownMenu>
 <DropdownMenuTrigger
 nativeButton
 render={(props) => (
 <button
 {...props}
 type="button"
 className={cn(
 "inline-flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-md border border-border bg-muted/35 px-2 py-1 text-[length:var(--text-xs)] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
 className,
 )}
 aria-label={label}
 title={active?.name ?? label}
 >
 <Building2 className="size-3.5 text-muted-foreground" strokeWidth={2} />
 <span className="truncate">{active?.name ?? label}</span>
 {switchingRestaurantId ? (
 <Loader2 className="size-3.5 animate-spin text-muted-foreground" strokeWidth={2} />
 ) : (
 <ChevronDown className="size-3.5 text-muted-foreground" strokeWidth={2} />
 )}
 </button>
 )}
 />
 <DropdownMenuContent align={align} className="min-w-[220px]">
 <DropdownMenuGroup>
 <DropdownMenuLabel>{label}</DropdownMenuLabel>
 {(restaurants ?? []).map((restaurant) => {
 const isActive = restaurant.id === activeRestaurantId;
 const isSwitching = restaurant.id === switchingRestaurantId;
 return (
 <DropdownMenuItem
 key={restaurant.id}
 onClick={() => onSwitch(restaurant.id)}
 disabled={isActive || !!switchingRestaurantId}
 className="min-h-8"
 >
 <Building2 className="size-3.5 text-muted-foreground" />
 <span className="min-w-0 flex-1 truncate">{restaurant.name}</span>
 {isSwitching ? (
 <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
 ) : isActive ? (
 <Check className="size-3.5 text-foreground" />
 ) : null}
 </DropdownMenuItem>
 );
 })}
 {canCreate && (
 <>
 <div className="-mx-1 my-1 h-px bg-border" />
 <DropdownMenuItem onClick={onCreate} disabled={!!switchingRestaurantId}>
 <Plus className="size-3.5 text-muted-foreground" />
 <span>{createLabel}</span>
 </DropdownMenuItem>
 </>
 )}
 {switchingRestaurantId && (
 <div className="px-1.5 pb-1 pt-0.5 text-[length:var(--text-2xs)] text-muted-foreground">
 {switchingLabel}
 </div>
 )}
 </DropdownMenuGroup>
 </DropdownMenuContent>
 </DropdownMenu>
 );
}

function CreateRestaurantDialog({
 open,
 onOpenChange,
 onCreated,
}: {
 open: boolean;
 onOpenChange: (open: boolean) => void;
 onCreated: (restaurantId: string) => void | Promise<void>;
}) {
 const { t } = useTranslation("nav");
 const [name, setName] = useState("");
 const [address, setAddress] = useState("");
 const [saving, setSaving] = useState(false);

 const handleSubmit = async (event: FormEvent) => {
  event.preventDefault();
  if (!name.trim() || saving) return;
  setSaving(true);
  try {
   const res = await api.createRestaurant({
    name: name.trim(),
    address: address.trim() || null,
   });
   toast.success(t("restaurantSwitcher.created"));
   onOpenChange(false);
   setName("");
   setAddress("");
   await onCreated(res.data.id);
  } catch (err) {
   toast.error(err instanceof Error ? err.message : t("restaurantSwitcher.createFailed"));
  } finally {
   setSaving(false);
  }
 };

 return (
 <Dialog open={open} onOpenChange={onOpenChange}>
 <DialogContent className="max-w-sm">
 <form onSubmit={handleSubmit}>
 <DialogHeader>
 <DialogTitle>{t("restaurantSwitcher.createTitle")}</DialogTitle>
 <DialogDescription>{t("restaurantSwitcher.createDescription")}</DialogDescription>
 </DialogHeader>
 <div className="grid gap-[var(--space-md)] py-[var(--space-md)]">
 <label className="grid gap-[var(--space-xs)]">
 <Label htmlFor="restaurant-name">{t("restaurantSwitcher.nameLabel")}</Label>
 <Input
  id="restaurant-name"
  value={name}
  onChange={(event) => setName(event.target.value)}
  autoComplete="organization"
  maxLength={120}
  required
 />
 </label>
 <label className="grid gap-[var(--space-xs)]">
 <Label htmlFor="restaurant-address">{t("restaurantSwitcher.addressLabel")}</Label>
 <Input
  id="restaurant-address"
  value={address}
  onChange={(event) => setAddress(event.target.value)}
  autoComplete="street-address"
 />
 </label>
 </div>
 <DialogFooter>
 <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
 {t("restaurantSwitcher.cancel")}
 </Button>
 <Button type="submit" size="sm" disabled={!name.trim() || saving}>
 {saving && <Loader2 className="size-3.5 animate-spin" />}
 {t("restaurantSwitcher.createSubmit")}
 </Button>
 </DialogFooter>
 </form>
 </DialogContent>
 </Dialog>
 );
}
