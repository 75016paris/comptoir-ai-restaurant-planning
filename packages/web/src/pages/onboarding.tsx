import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { api, type OnboardingState, type User, type AdminPreferences, type ComplianceRuleMeta } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme-toggle";
import { AddEmployeeModal } from "@/components/add-employee-modal";
import { Check, ChevronRight, ExternalLink, MessageCircle, Plus, Trash2 } from "lucide-react";
import { formatPhone } from "@/lib/utils";
import { KITCHEN_DEFAULT_SUBROLES, FLOOR_DEFAULT_SUBROLES, DEFAULT_SUBROLE_TO_HCR, HCR_LEVEL_LABELS } from "@comptoir/shared/hcr";

const STEPS = [
  { slug: "profil", key: "profil" },
  { slug: "sous-roles", key: "sousRoles" },
  { slug: "equipe", key: "equipe" },
  { slug: "services", key: "services" },
  { slug: "style", key: "style" },
  { slug: "whatsapp", key: "whatsapp" },
  { slug: "planning", key: "planning" },
] as const;

type StepSlug = (typeof STEPS)[number]["slug"];

function splitAddress(addr: string | null | undefined): { street: string; postalCode: string; city: string } {
  if (!addr) return { street: "", postalCode: "", city: "" };
  const m = addr.match(/^(.+?),\s*(\d{5})\s+(.+)$/);
  if (m) return { street: m[1].trim(), postalCode: m[2], city: m[3].trim() };
  return { street: addr, postalCode: "", city: "" };
}

export function OnboardingPage() {
  const params = useParams<{ step?: string }>();
  const stepSlug = (params.step ?? STEPS[0].slug) as StepSlug;
  const stepIdx = STEPS.findIndex((s) => s.slug === stepSlug);

  if (stepIdx < 0) {
    return <Navigate to={`/onboarding/${STEPS[0].slug}`} replace />;
  }

  return <OnboardingShell stepIdx={stepIdx} />;
}

function OnboardingShell({ stepIdx }: { stepIdx: number }) {
  const { t } = useTranslation("onboarding");
  const { user, refresh, switchRestaurant } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [switchingRestaurant, setSwitchingRestaurant] = useState(false);

  useEffect(() => {
    api.getOnboardingState().then((res) => {
      setState(res.data);
      setLoading(false);
    });
  }, []);

  const goNext = () => {
    if (stepIdx < STEPS.length - 1) {
      navigate(`/onboarding/${STEPS[stepIdx + 1].slug}`);
    }
  };
  const goPrev = () => {
    if (stepIdx > 0) navigate(`/onboarding/${STEPS[stepIdx - 1].slug}`);
  };
  const finish = async () => {
    await api.completeOnboarding();
    await refresh();
    navigate("/schedule");
  };
  const reload = async () => {
    const res = await api.getOnboardingState();
    setState(res.data);
  };
  const activeRestaurantId = user?.activeRestaurantId ?? user?.restaurantId ?? "";
  const accessibleRestaurants = user?.restaurants ?? [];
  const canSwitchRestaurant = accessibleRestaurants.length > 1;
  const handleRestaurantChange = async (restaurantId: string) => {
    if (!restaurantId || restaurantId === activeRestaurantId || switchingRestaurant) return;
    const target = accessibleRestaurants.find((restaurant) => restaurant.id === restaurantId);
    setSwitchingRestaurant(true);
    try {
      await switchRestaurant(restaurantId);
      if (target?.onboardingCompletedAt) {
        navigate("/schedule", { replace: true });
        return;
      }
      const res = await api.getOnboardingState();
      setState(res.data);
      navigate("/onboarding/profil", { replace: true });
    } finally {
      setSwitchingRestaurant(false);
    }
  };

  if (loading || !state) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <div className="flex justify-between items-center p-[var(--space-md)] border-b border-border">
        <div>
          <h1 className="text-[length:var(--text-lg)] font-bold tracking-[-0.03em]">Comptoir</h1>
          <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
            {t("topBar.header", { restaurantName: state.restaurant.name })}
          </p>
        </div>
        <div className="flex items-center gap-[var(--space-sm)]">
          {canSwitchRestaurant && (
            <select
              value={activeRestaurantId}
              onChange={(event) => void handleRestaurantChange(event.target.value)}
              disabled={switchingRestaurant}
              aria-label="Changer de restaurant"
              className="h-8 max-w-[220px] rounded-md border border-border bg-background px-2 text-[length:var(--text-xs)] font-medium text-foreground"
            >
              {accessibleRestaurants.map((restaurant) => (
                <option key={restaurant.id} value={restaurant.id}>
                  {restaurant.name}
                </option>
              ))}
            </select>
          )}
          <ThemeToggle />
        </div>
      </div>

      {/* Progress strip — desktop */}
      <div className="hidden md:block px-[var(--space-lg)] py-[var(--space-md)] border-b border-border">
        <div className="max-w-2xl mx-auto flex items-center gap-[var(--space-xs)]">
          {STEPS.map((s, i) => {
            const clickable = i < stepIdx;
            const inner = (
              <div
                className={
                  "flex items-center gap-[var(--space-xs)] flex-1 " +
                  (i === stepIdx ? "text-foreground" : i < stepIdx ? "text-foreground/70" : "text-muted-foreground")
                }
              >
                <div
                  className={
                    "h-6 w-6 rounded-full flex items-center justify-center text-[length:var(--text-xs)] font-bold border " +
                    (i < stepIdx
                      ? "bg-foreground text-background border-foreground"
                      : i === stepIdx
                      ? "border-foreground"
                      : "border-foreground/20")
                  }
                >
                  {i < stepIdx ? <Check className="h-3 w-3" /> : i + 1}
                </div>
                <span className="text-[length:var(--text-xs)] tracking-wide font-medium">{t(`steps.${s.key}`)}</span>
              </div>
            );
            return (
              <div key={s.slug} className="flex items-center gap-[var(--space-xs)] flex-1">
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/onboarding/${s.slug}`)}
                    className="flex-1 text-left hover:opacity-80 transition-opacity"
                  >
                    {inner}
                  </button>
                ) : (
                  inner
                )}
                {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Progress strip — mobile (current step label + count) */}
      <div className="md:hidden px-[var(--space-lg)] py-[var(--space-sm)] border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[var(--space-sm)]">
            <div className="h-6 w-6 rounded-full flex items-center justify-center text-[length:var(--text-xs)] font-bold border border-foreground">
              {stepIdx + 1}
            </div>
            <span className="text-[length:var(--text-sm)] font-medium tracking-tight">{t(`steps.${STEPS[stepIdx].key}`)}</span>
          </div>
          <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
            {t("progress.stepCount", { current: stepIdx + 1, total: STEPS.length })}
          </span>
        </div>
        <div className="mt-[var(--space-sm)] h-[2px] bg-foreground/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-foreground transition-all duration-300"
            style={{ width: `${((stepIdx + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-[var(--space-lg)] py-[var(--space-xl)]">
          {stepIdx === 0 && <Step1Profile state={state} onSaved={() => { reload(); goNext(); }} onBack={null} />}
          {stepIdx === 1 && <Step2Subroles state={state} onSaved={() => { reload(); goNext(); }} onBack={goPrev} />}
          {stepIdx === 2 && <Step4Employees state={state} onSaved={() => { reload(); goNext(); }} onBack={goPrev} />}
          {stepIdx === 3 && <Step3Services state={state} onSaved={() => { reload(); goNext(); }} onCustom={(profileId) => navigate(`/preferences/objectif/${profileId}?fromOnboarding=1`)} onBack={goPrev} />}
          {stepIdx === 4 && <StepStyle state={state} onSaved={() => { reload(); goNext(); }} onBack={goPrev} />}
          {stepIdx === 5 && <StepWhatsApp state={state} onSaved={goNext} onBack={goPrev} />}
          {stepIdx === 6 && <Step5Finish state={state} onFinish={finish} onBack={goPrev} />}
        </div>
      </div>
    </div>
  );
}

// ── Step 1: Restaurant profile ───────────────────────────────────────────────
function Step1Profile({ state, onSaved, onBack }: { state: OnboardingState; onSaved: () => void; onBack: null | (() => void) }) {
  const { t, i18n } = useTranslation("onboarding");
  const initial = useMemo(() => splitAddress(state.restaurant.address), [state.restaurant.address]);
  const placeholderName = state.restaurant.name === "Mon restaurant" ? "" : state.restaurant.name;
  const [name, setName] = useState(placeholderName);
  const [street, setStreet] = useState(initial.street);
  const [postalCode, setPostalCode] = useState(initial.postalCode);
  const [city, setCity] = useState(initial.city);
  const [siret, setSiret] = useState(state.restaurant.siret ?? "");
  const [botLocale, setBotLocale] = useState<"fr" | "en" | "es" | "pt">(state.restaurant.whatsappBotLocale ?? "fr");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const validPostalCode = /^\d{5}$/.test(postalCode.trim());

  useEffect(() => {
    if (error) setError("");
  }, [error, name, street, postalCode, city, siret]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!name.trim()) {
      setError(t("step1Profile.errors.missingName"));
      return;
    }
    if (!street.trim()) {
      setError(t("step1Profile.errors.missingStreet"));
      return;
    }
    if (!validPostalCode) {
      setError(t("step1Profile.errors.invalidPostal"));
      return;
    }
    if (!city.trim()) {
      setError(t("step1Profile.errors.missingCity"));
      return;
    }
    const siretCleaned = siret.replace(/\s+/g, "");
    if (siretCleaned && !/^\d{14}$/.test(siretCleaned)) {
      setError(t("step1Profile.errors.invalidSiret"));
      return;
    }
    setSaving(true);
    try {
      await api.saveOnboardingProfile({
        name: name.trim(),
        street: street.trim(),
        postalCode: postalCode.trim(),
        city: city.trim(),
        siret: siretCleaned || null,
        whatsappBotLocale: botLocale,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-[var(--space-lg)]">
      <div>
        <h2 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight">
          {t("step1Profile.title")}
        </h2>
        <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
          {t("step1Profile.subtitle")}
        </p>
      </div>

      <div className="space-y-[var(--space-sm)]">
        <Label htmlFor="name" className="text-[length:var(--text-xs)] tracking-wide font-medium">
          {t("step1Profile.nameLabel")}
        </Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("step1Profile.namePlaceholder")}
          required
          className="h-[var(--space-2xl)] border-foreground/20 bg-transparent rounded-full px-[var(--space-md)]"
        />
      </div>

      <div className="space-y-[var(--space-sm)]">
        <Label htmlFor="street" className="text-[length:var(--text-xs)] tracking-wide font-medium">
          {t("step1Profile.streetLabel")}
        </Label>
        <Input
          id="street"
          value={street}
          onChange={(e) => setStreet(e.target.value)}
          placeholder={t("step1Profile.streetPlaceholder")}
          required
          className="h-[var(--space-2xl)] border-foreground/20 bg-transparent rounded-full px-[var(--space-md)]"
        />
      </div>

      <div className="grid grid-cols-3 gap-[var(--space-md)]">
        <div className="space-y-[var(--space-sm)]">
          <Label htmlFor="postal" className="text-[length:var(--text-xs)] tracking-wide font-medium">
            {t("step1Profile.postalLabel")}
          </Label>
          <Input
            id="postal"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value.replace(/\D/g, "").slice(0, 5))}
            placeholder={t("step1Profile.postalPlaceholder")}
            inputMode="numeric"
            required
            className="h-[var(--space-2xl)] border-foreground/20 bg-transparent rounded-full px-[var(--space-md)]"
          />
        </div>
        <div className="col-span-2 space-y-[var(--space-sm)]">
          <Label htmlFor="city" className="text-[length:var(--text-xs)] tracking-wide font-medium">
            {t("step1Profile.cityLabel")}
          </Label>
          <Input
            id="city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder={t("step1Profile.cityPlaceholder")}
            required
            className="h-[var(--space-2xl)] border-foreground/20 bg-transparent rounded-full px-[var(--space-md)]"
          />
        </div>
      </div>
      <p className="text-[length:var(--text-xs)] text-muted-foreground">
        {validPostalCode
          ? t("step1Profile.postalDetected", { code: postalCode.trim() })
          : t("step1Profile.postalHint")}
      </p>

      <div className="space-y-[var(--space-sm)]">
        <Label htmlFor="siret" className="text-[length:var(--text-xs)] tracking-wide font-medium">
          {t("step1Profile.siretLabel")}
        </Label>
        <Input
          id="siret"
          value={siret}
          onChange={(e) => setSiret(e.target.value)}
          placeholder={t("step1Profile.siretPlaceholder")}
          inputMode="numeric"
          maxLength={17}
          className="h-[var(--space-2xl)] border-foreground/20 bg-transparent rounded-full px-[var(--space-md)]"
        />
        <p className="text-[length:var(--text-xs)] text-muted-foreground">
          {t("step1Profile.siretHint")}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-md)]">
        <div className="space-y-[var(--space-sm)]">
          <Label htmlFor="interfaceLocale" className="text-[length:var(--text-xs)] tracking-wide font-medium">
            {t("step1Profile.interfaceLocaleLabel")}
          </Label>
          <select
            id="interfaceLocale"
            value={i18n.resolvedLanguage ?? i18n.language}
            onChange={(e) => i18n.changeLanguage(e.target.value)}
            className="block w-full h-[var(--space-2xl)] border border-foreground/20 bg-transparent rounded-full px-[var(--space-md)] text-[length:var(--text-sm)] outline-none focus:border-foreground transition-colors"
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
          </select>
        </div>
        <div className="space-y-[var(--space-sm)]">
          <Label htmlFor="botLocale" className="text-[length:var(--text-xs)] tracking-wide font-medium">
            {t("step1Profile.botLocaleLabel")}
          </Label>
          <select
            id="botLocale"
            value={botLocale}
            onChange={(e) => setBotLocale(e.target.value as typeof botLocale)}
            className="block w-full h-[var(--space-2xl)] border border-foreground/20 bg-transparent rounded-full px-[var(--space-md)] text-[length:var(--text-sm)] outline-none focus:border-foreground transition-colors"
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
          </select>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            {t("step1Profile.botLocaleHint")}
          </p>
        </div>
      </div>

      {error && <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>}

      <div className="flex justify-between items-center pt-[var(--space-md)]">
        {onBack ? (
          <Button type="button" variant="ghost" onClick={onBack}>
            {t("actions.back")}
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={saving} className="px-[var(--space-xl)]">
          {saving ? t("actions.saving") : t("actions.continue")}
        </Button>
      </div>
    </form>
  );
}

// ── Step 2: Sub-role catalog ─────────────────────────────────────────────────
function Step2Subroles({ state, onSaved, onBack }: { state: OnboardingState; onSaved: () => void; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const PRECHECKED_KITCHEN = ["Chef", "Cuisinier"];
  const PRECHECKED_SALLE = ["Chef de rang", "Serveur"];

  const [kitchen, setKitchen] = useState<Set<string>>(
    new Set(state.restaurant.kitchenSubRoles.length ? state.restaurant.kitchenSubRoles : PRECHECKED_KITCHEN)
  );
  const [floor, setFloor] = useState<Set<string>>(
    new Set(state.restaurant.floorSubRoles.length ? state.restaurant.floorSubRoles : PRECHECKED_SALLE)
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void) => (v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (kitchen.size === 0 && floor.size === 0) {
      setError(t("step2Subroles.errors.noneSelected"));
      return;
    }
    setSaving(true);
    try {
      await api.saveOnboardingSubroles({
        kitchenSubRoles: Array.from(kitchen),
        floorSubRoles: Array.from(floor),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-[var(--space-lg)]">
      <div>
        <h2 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight">
          {t("step2Subroles.title")}
        </h2>
        <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
          {t("step2Subroles.subtitle")}
        </p>
      </div>

      <SubroleSection
        title={t("step2Subroles.kitchenLabel")}
        options={KITCHEN_DEFAULT_SUBROLES as readonly string[]}
        selected={kitchen}
        onToggle={toggle(kitchen, setKitchen)}
      />
      <SubroleSection
        title={t("step2Subroles.floorLabel")}
        options={FLOOR_DEFAULT_SUBROLES as readonly string[]}
        selected={floor}
        onToggle={toggle(floor, setFloor)}
      />

      {error && <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>}

      <div className="flex justify-between items-center pt-[var(--space-md)]">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t("actions.back")}
        </Button>
        <Button type="submit" disabled={saving} className="px-[var(--space-xl)]">
          {saving ? t("actions.saving") : t("actions.continue")}
        </Button>
      </div>
    </form>
  );
}

function SubroleSection({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: readonly string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
}) {
  return (
    <div className="space-y-[var(--space-sm)]">
      <Label className="text-[length:var(--text-xs)] tracking-wide font-medium">{title}</Label>
      <div className="space-y-[var(--space-xs)]">
        {options.map((opt) => {
          const on = selected.has(opt);
          const hcr = DEFAULT_SUBROLE_TO_HCR[opt];
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className={
                "w-full flex items-center justify-between gap-[var(--space-md)] px-[var(--space-lg)] py-[var(--space-sm)] border rounded-full text-left transition-colors " +
                (on
                  ? "bg-foreground/5 border-foreground"
                  : "bg-transparent border-foreground/20 hover:border-foreground/40")
              }
            >
              <div className="flex items-center gap-[var(--space-sm)]">
                <div
                  className={
                    "h-4 w-4 border flex items-center justify-center " +
                    (on ? "bg-foreground border-foreground" : "border-foreground/30")
                  }
                >
                  {on && <Check className="h-3 w-3 text-background" />}
                </div>
                <span className="text-[length:var(--text-sm)] font-medium">{opt}</span>
              </div>
              {hcr && (
                <span className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">
                  {hcr} · {HCR_LEVEL_LABELS[hcr]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 3: Service template ─────────────────────────────────────────────────
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function Step3Services({ state, onSaved, onCustom, onBack }: { state: OnboardingState; onSaved: () => void; onCustom: (profileId: string) => void; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const [kind, setKind] = useState<string>("midi-soir");
  const [kitchenCount, setKitchenCount] = useState(2);
  const [salleCount, setSalleCount] = useState(2);
  const [openDays, setOpenDays] = useState<number[]>(() => {
    const od = state.restaurant.openDays as unknown;
    if (Array.isArray(od) && od.length) return od as number[];
    if (od && typeof od === "object") {
      const nums = Object.keys(od).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
      if (nums.length) return nums.sort();
    }
    return [2, 3, 4, 5, 6, 7];
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (error) setError("");
  }, [error, kind, kitchenCount, salleCount, openDays]);

  const toggleDay = (d: number) =>
    setOpenDays((arr) => (arr.includes(d) ? arr.filter((x) => x !== d) : [...arr, d].sort()));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (openDays.length === 0) {
      setError(t("step3Services.errors.noOpenDays"));
      return;
    }
    if (kind !== "custom" && kitchenCount + salleCount === 0) {
      setError(t("step3Services.errors.noStaff"));
      return;
    }
    setSaving(true);
    try {
      const res = await api.saveOnboardingServiceTemplate({ kind, kitchenCount, salleCount, openDays });
      if (kind === "custom" && res.data.profileId) {
        onCustom(res.data.profileId);
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setSaving(false);
    }
  };

  const OPTIONS = ["midi", "soir", "midi-soir", "coupure", "custom"] as const;

  return (
    <form onSubmit={submit} className="space-y-[var(--space-lg)]">
      <div>
        <h2 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight">
          {t("step3Services.title")}
        </h2>
        <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
          {t("step3Services.subtitle")}
        </p>
      </div>

      <div className="space-y-[var(--space-sm)]">
        <Label className="text-[length:var(--text-xs)] tracking-wide font-medium">{t("step3Services.openDaysLabel")}</Label>
        <div className="flex flex-wrap gap-[var(--space-xs)]">
          {DAY_KEYS.map((dayKey, i) => {
            const d = i + 1;
            const on = openDays.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={
                  "h-[var(--space-2xl)] px-[var(--space-md)] border rounded-full text-[length:var(--text-sm)] font-medium tracking-wide transition-colors " +
                  (on
                    ? "bg-foreground text-background border-foreground"
                    : "bg-transparent text-foreground border-foreground/20 hover:border-foreground/40")
                }
              >
                {t(`days.${dayKey}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-[var(--space-xs)]">
        {OPTIONS.map((value) => {
          const on = kind === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setKind(value)}
              className={
                "w-full flex items-start justify-between gap-[var(--space-md)] px-[var(--space-md)] py-[var(--space-md)] border rounded-md text-left transition-colors " +
                (on
                  ? "bg-foreground/5 border-foreground"
                  : "bg-transparent border-foreground/20 hover:border-foreground/40")
              }
            >
              <div>
                <div className="text-[length:var(--text-sm)] font-bold tracking-tight">
                  {t(`step3Services.options.${value}.label`)}
                </div>
                <div className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
                  {t(`step3Services.options.${value}.desc`)}
                </div>
              </div>
              <div
                className={
                  "h-4 w-4 rounded-full border flex items-center justify-center shrink-0 mt-[var(--space-xs)] " +
                  (on ? "bg-foreground border-foreground" : "border-foreground/30")
                }
              >
                {on && <div className="h-2 w-2 rounded-full bg-background" />}
              </div>
            </button>
          );
        })}
      </div>

      {kind !== "custom" && (
        <div className="grid grid-cols-2 gap-[var(--space-md)]">
          <div className="space-y-[var(--space-sm)]">
            <Label className="text-[length:var(--text-xs)] tracking-wide font-medium">
              {t("step3Services.kitchenCountLabel")}
            </Label>
            <Input
              type="number"
              min={0}
              max={20}
              value={kitchenCount}
              onChange={(e) => setKitchenCount(Number(e.target.value))}
              className="h-[var(--space-2xl)] border-foreground/20 bg-transparent rounded-full px-[var(--space-md)]"
            />
          </div>
          <div className="space-y-[var(--space-sm)]">
            <Label className="text-[length:var(--text-xs)] tracking-wide font-medium">
              {t("step3Services.floorCountLabel")}
            </Label>
            <Input
              type="number"
              min={0}
              max={20}
              value={salleCount}
              onChange={(e) => setSalleCount(Number(e.target.value))}
              className="h-[var(--space-2xl)] border-foreground/20 bg-transparent rounded-full px-[var(--space-md)]"
            />
          </div>
        </div>
      )}

      {error && <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>}

      <div className="flex justify-between items-center pt-[var(--space-md)]">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t("actions.back")}
        </Button>
        <Button type="submit" disabled={saving} className="px-[var(--space-xl)]">
          {saving ? t("actions.saving") : t("actions.continue")}
        </Button>
      </div>
    </form>
  );
}

// ── Step 4: Employees (split Cuisine / Salle) ──────────────────────────────
function Step4Employees({ onSaved, onBack }: { state: OnboardingState; onSaved: () => void; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const [employees, setEmployees] = useState<User[] | null>(null);
  const [modalRole, setModalRole] = useState<"kitchen" | "floor" | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = async () => {
    const res = await api.listUsers();
    setEmployees(res.data.filter((u) => u.role !== "admin"));
  };

  useEffect(() => {
    refresh();
  }, []);

  const removeEmployee = async (id: string) => {
    setRemovingId(id);
    try {
      await api.deleteUser(id);
      await refresh();
    } finally {
      setRemovingId(null);
    }
  };

  const kitchen = (employees ?? []).filter((u) => u.role === "kitchen");
  const floor = (employees ?? []).filter((u) => u.role === "floor");
  const totalCount = (employees ?? []).length;

  const renderEmployeeRow = (u: User) => {
    const subRoles: string[] = Array.isArray(u.subRoles) ? u.subRoles : [];
    return (
      <div
        key={u.id}
        className="flex items-center justify-between gap-[var(--space-md)] border border-foreground/20 rounded-full px-[var(--space-lg)] py-[var(--space-sm)]"
      >
        <div className="flex items-center gap-[var(--space-md)] min-w-0">
          <span className="text-[length:var(--text-sm)] font-medium truncate">{u.name}</span>
          {subRoles.length > 0 && (
            <span className="text-[length:var(--text-xs)] text-muted-foreground truncate hidden md:inline">
              {subRoles.join(" · ")}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => removeEmployee(u.id)}
          disabled={removingId === u.id}
          className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
          title={t("step4Employees.removeTitle")}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    );
  };

  const renderSection = (role: "kitchen" | "floor", list: User[]) => {
    const label = t(role === "kitchen" ? "step4Employees.kitchenLabel" : "step4Employees.floorLabel");
    const lower = t(role === "kitchen" ? "step4Employees.kitchenLower" : "step4Employees.floorLower");
    return (
      <div className="space-y-[var(--space-sm)]">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[length:var(--text-sm)] font-bold tracking-tight">
            {label}
            <span className="ml-[var(--space-sm)] text-[length:var(--text-xs)] text-muted-foreground font-normal">
              {t("step4Employees.count", { count: list.length })}
            </span>
          </h3>
        </div>
        {list.length === 0 ? (
          <div className="border border-dashed border-foreground/15 rounded-md p-[var(--space-md)] text-center">
            <p className="text-[length:var(--text-xs)] text-muted-foreground">
              {t("step4Employees.emptySection", { section: lower })}
            </p>
          </div>
        ) : (
          list.map(renderEmployeeRow)
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={() => setModalRole(role)}
          className="w-full border border-dashed border-foreground/20 hover:border-foreground/40 rounded-full h-[var(--space-2xl)]"
        >
          <Plus className="h-4 w-4 mr-[var(--space-xs)]" />
          {t("step4Employees.addInSection", { section: lower })}
        </Button>
      </div>
    );
  };

  const oneSideEmpty = totalCount > 0 && (kitchen.length === 0 || floor.length === 0);
  const missingRole: "kitchen" | "floor" | null = oneSideEmpty ? (kitchen.length === 0 ? "kitchen" : "floor") : null;

  return (
    <div className="space-y-[var(--space-lg)]">
      <div>
        <h2 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight">
          {t("step4Employees.title")}
        </h2>
        <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
          {t("step4Employees.subtitle")}
        </p>
      </div>

      {employees === null ? (
        <p className="text-[length:var(--text-sm)] text-muted-foreground">{t("step4Employees.loading")}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-lg)]">
          {renderSection("kitchen", kitchen)}
          {renderSection("floor", floor)}
        </div>
      )}

      {missingRole && (
        <p className="text-[length:var(--text-xs)] text-amber-600 dark:text-amber-400 font-medium">
          {t("step4Employees.missingSideWarn", {
            section: t(missingRole === "kitchen" ? "step4Employees.kitchenLower" : "step4Employees.floorLower"),
          })}
        </p>
      )}

      <div className="flex justify-between items-center pt-[var(--space-md)]">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t("actions.back")}
        </Button>
        <Button onClick={onSaved} disabled={totalCount === 0} className="px-[var(--space-xl)]">
          {t("actions.continue")}
        </Button>
      </div>

      <AddEmployeeModal
        open={modalRole !== null}
        onClose={() => setModalRole(null)}
        onSuccess={refresh}
        lightDefaults
        initialRole={modalRole ?? undefined}
      />
    </div>
  );
}


// ── Step 4b: Solver style ────────────────────────────────────────────────────
function StepStyle({ state, onSaved, onBack }: { state: OnboardingState; onSaved: () => void; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const STYLE_VALUES: OnboardingState["restaurant"]["preferredStyle"][] = ["equilibre", "equipe-stable", "economique", "resilience"];
  const OT_MODE_VALUES: AdminPreferences["overtimeMode"][] = ["strict", "controlled", "flexible"];
  const OT_DIST_VALUES: AdminPreferences["overtimeDistribution"][] = ["willing-first", "by-priority", "even"];

  const [selected, setSelected] = useState<OnboardingState["restaurant"]["preferredStyle"]>(state.restaurant.preferredStyle);
  const [prefs, setPrefs] = useState<AdminPreferences | null>(null);
  const [rules, setRules] = useState<ComplianceRuleMeta[]>([]);
  const [hoverOtMode, setHoverOtMode] = useState<AdminPreferences["overtimeMode"] | null>(null);
  const [hoverOtDist, setHoverOtDist] = useState<AdminPreferences["overtimeDistribution"] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.getPreferences(), api.getComplianceRules()]).then(([p, r]) => {
      setPrefs(p.data);
      setRules(r.data.filter((x) => !["COMPTOIR-CHEF-01", "COMPTOIR-OT-01"].includes(x.code)));
    });
  }, []);

  const updatePref = async <K extends keyof AdminPreferences>(key: K, value: AdminPreferences[K]) => {
    if (!prefs) return;
    const prev = prefs[key];
    setPrefs({ ...prefs, [key]: value });
    try {
      await api.updatePreferences({ [key]: value } as Partial<AdminPreferences>);
    } catch {
      setPrefs((p) => (p ? { ...p, [key]: prev } : p));
    }
  };

  const toggleRule = async (code: string) => {
    if (!prefs) return;
    const cur = prefs.disabledComplianceRules ?? [];
    const next = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
    await updatePref("disabledComplianceRules", next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.saveOnboardingPreferredStyle(selected);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setSaving(false);
    }
  };

  const detailsClass =
    "group border border-foreground/15 rounded-md overflow-hidden [&[open]]:border-foreground/30";
  const summaryClass =
    "cursor-pointer list-none flex items-center justify-between px-[var(--space-md)] py-[var(--space-sm)] hover:bg-foreground/5 transition-colors select-none";

  return (
    <form onSubmit={submit} className="space-y-[var(--space-lg)]">
      <div>
        <h2 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight">
          {t("stepStyle.title")}
        </h2>
        <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
          {t("stepStyle.subtitle")}
        </p>
      </div>

      <div className="space-y-[var(--space-xs)]">
        {STYLE_VALUES.map((value) => {
          const on = selected === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setSelected(value)}
              className={
                "w-full flex items-start justify-between gap-[var(--space-md)] px-[var(--space-md)] py-[var(--space-md)] border rounded-md text-left transition-colors " +
                (on
                  ? "bg-foreground/5 border-foreground"
                  : "bg-transparent border-foreground/20 hover:border-foreground/40")
              }
            >
              <div>
                <div className="text-[length:var(--text-sm)] font-bold tracking-tight">
                  {t(`preferences:styleLabels.${value}`)}
                </div>
                <div className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
                  {t(`stepStyle.styleDescriptions.${value}`)}
                </div>
              </div>
              <div
                className={
                  "h-4 w-4 rounded-full border flex items-center justify-center shrink-0 mt-[var(--space-xs)] " +
                  (on ? "bg-foreground border-foreground" : "border-foreground/30")
                }
              >
                {on && <div className="h-2 w-2 rounded-full bg-background" />}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Règle avancée ── */}
      <details className={detailsClass}>
        <summary className={summaryClass}>
          <span className="text-[length:var(--text-sm)] font-bold tracking-tight">{t("stepStyle.advancedRule")}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="px-[var(--space-md)] py-[var(--space-md)] border-t border-foreground/10 space-y-[var(--space-md)]">
          {!prefs ? (
            <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("stepStyle.loading")}</p>
          ) : (
            <>
              <div className="space-y-[var(--space-sm)]">
                <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("stepStyle.overtime.title")}</p>
                <p className="text-[length:var(--text-xs)] text-muted-foreground">
                  {t("stepStyle.overtime.intro")}
                </p>
                {/* Mode */}
                <div className="space-y-[var(--space-xs)]">
                  <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("stepStyle.overtime.modeLabel")}</p>
                  <div className="flex gap-[var(--space-xs)]">
                    {OT_MODE_VALUES.map((value) => {
                      const active = (hoverOtMode ?? prefs.overtimeMode) === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => updatePref("overtimeMode", value)}
                          onMouseEnter={() => setHoverOtMode(value)}
                          onMouseLeave={() => setHoverOtMode(null)}
                          className={
                            "flex-1 border rounded-[0.2rem] p-[var(--space-sm)] text-left transition-colors " +
                            (active ? "border-foreground bg-foreground text-background" : "border-foreground/15")
                          }
                        >
                          <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest block">{t(`stepStyle.overtime.modes.${value}.label`)}</span>
                          <span className={"text-[length:var(--text-xs)] block mt-[1px] " + (active ? "opacity-70" : "text-muted-foreground")}>{t(`stepStyle.overtime.modes.${value}.desc`)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Weekly cap — controlled only */}
                {prefs.overtimeMode === "controlled" && (
                  <div className="space-y-[var(--space-xs)]">
                    <div className="flex items-center justify-between">
                      <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("stepStyle.overtime.capLabel")}</p>
                      <span className="font-mono text-[length:var(--text-sm)] font-bold">{prefs.overtimeWeeklyCap}h</span>
                    </div>
                    <input
                      type="range"
                      min={39}
                      max={48}
                      step={1}
                      value={prefs.overtimeWeeklyCap}
                      onChange={(e) => updatePref("overtimeWeeklyCap", parseInt(e.target.value))}
                      className="w-full accent-foreground"
                    />
                    <div className="flex justify-between text-[length:var(--text-2xs)] text-muted-foreground uppercase tracking-widest">
                      <span>{t("stepStyle.overtime.tick39")}</span>
                      <span className={prefs.overtimeWeeklyCap <= 43 ? "font-bold text-foreground" : ""}>{t("stepStyle.overtime.tick43")}</span>
                      <span className={prefs.overtimeWeeklyCap > 43 && prefs.overtimeWeeklyCap <= 47 ? "font-bold text-foreground" : ""}>{t("stepStyle.overtime.tick47")}</span>
                      <span className={prefs.overtimeWeeklyCap === 48 ? "font-bold text-foreground" : ""}>{t("stepStyle.overtime.tick48")}</span>
                    </div>
                    <p className="text-[length:var(--text-xs)] text-muted-foreground">
                      {prefs.overtimeWeeklyCap <= 39
                        ? t("stepStyle.overtime.capExplanation39")
                        : prefs.overtimeWeeklyCap <= 43
                          ? t("stepStyle.overtime.capExplanation110", { count: prefs.overtimeWeeklyCap - 39 })
                          : prefs.overtimeWeeklyCap <= 47
                            ? t("stepStyle.overtime.capExplanation120", { count: prefs.overtimeWeeklyCap - 43 })
                            : t("stepStyle.overtime.capExplanationMax")}
                    </p>
                  </div>
                )}

                {/* Distribution — not in strict */}
                {prefs.overtimeMode !== "strict" && (
                  <div className="space-y-[var(--space-xs)]">
                    <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest text-foreground">{t("stepStyle.overtime.distributionLabel")}</p>
                    <p className="text-[length:var(--text-xs)] text-muted-foreground">
                      {t("stepStyle.overtime.distributionIntro")}
                    </p>
                    <div className="flex gap-[var(--space-xs)]">
                      {OT_DIST_VALUES.map((value) => {
                        const active = (hoverOtDist ?? prefs.overtimeDistribution) === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => updatePref("overtimeDistribution", value)}
                            onMouseEnter={() => setHoverOtDist(value)}
                            onMouseLeave={() => setHoverOtDist(null)}
                            className={
                              "flex-1 border rounded-[0.2rem] p-[var(--space-sm)] text-left transition-colors " +
                              (active ? "border-foreground bg-foreground text-background" : "border-foreground/15")
                            }
                          >
                            <span className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest block">{t(`stepStyle.overtime.distributions.${value}.label`)}</span>
                            <span className={"text-[length:var(--text-xs)] block mt-[1px] " + (active ? "opacity-70" : "text-muted-foreground")}>{t(`stepStyle.overtime.distributions.${value}.desc`)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-[var(--space-xs)]">
                <SwitchRow
                  label={t("stepStyle.tapInOut.label")}
                  desc={t("stepStyle.tapInOut.desc")}
                  on={prefs.tapInOutEnabled}
                  onChange={(v) => updatePref("tapInOutEnabled", v)}
                />
                {prefs.tapInOutEnabled && (
                  <div className="pl-[var(--space-md)] border-l-2 border-foreground/15 space-y-[var(--space-sm)]">
                    <SwitchRow
                      label={t("stepStyle.tapInOut.adminConfirmLabel")}
                      desc={t("stepStyle.tapInOut.adminConfirmDesc")}
                      on={prefs.tapInOutAdminConfirmation}
                      onChange={(v) => updatePref("tapInOutAdminConfirmation", v)}
                    />
                    <div className="space-y-[var(--space-xs)]">
                      <p className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest">{t("stepStyle.tapInOut.modeLabel")}</p>
                      <div className="space-y-[var(--space-xs)]">
                        {([
                          { value: "sync", labelKey: "stepStyle.tapInOut.syncLabel", descKey: "stepStyle.tapInOut.syncDesc" },
                          { value: "lateness_only", labelKey: "stepStyle.tapInOut.latenessLabel", descKey: "stepStyle.tapInOut.latenessDesc" },
                        ] as const).map((opt) => {
                          const on = prefs.tapInOutMode === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => updatePref("tapInOutMode", opt.value)}
                              className={
                                "w-full flex items-start justify-between gap-[var(--space-md)] px-[var(--space-md)] py-[var(--space-sm)] border rounded-md text-left transition-colors " +
                                (on ? "bg-foreground/5 border-foreground" : "bg-transparent border-foreground/20 hover:border-foreground/40")
                              }
                            >
                              <div>
                                <div className="text-[length:var(--text-xs)] font-bold tracking-tight">{t(opt.labelKey)}</div>
                                <div className="text-[length:var(--text-xs)] text-muted-foreground mt-[1px]">{t(opt.descKey)}</div>
                              </div>
                              <div className={"h-4 w-4 rounded-full border flex items-center justify-center shrink-0 mt-[var(--space-xs)] " + (on ? "bg-foreground border-foreground" : "border-foreground/30")}>
                                {on && <div className="h-2 w-2 rounded-full bg-background" />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {prefs.tapInOutMode === "sync" && (
                        <div className="pl-[var(--space-md)] border-l-2 border-foreground/15 pt-[var(--space-xs)]">
                          <SwitchRow
                            label={t("stepStyle.tapInOut.earlyLabel")}
                            desc={t("stepStyle.tapInOut.earlyDesc")}
                            on={prefs.tapInCountsAsHours}
                            onChange={(v) => updatePref("tapInCountsAsHours", v)}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <SwitchRow
                label={t("stepStyle.workerPreferences.label")}
                desc={t("stepStyle.workerPreferences.desc")}
                on={prefs.workerPreferencesEnabled}
                onChange={(v) => updatePref("workerPreferencesEnabled", v)}
              />
            </>
          )}
        </div>
      </details>

      {/* ── Conformité ── */}
      <details className={detailsClass}>
        <summary className={summaryClass}>
          <span className="text-[length:var(--text-sm)] font-bold tracking-tight">{t("stepStyle.compliance.title")}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="px-[var(--space-md)] py-[var(--space-md)] border-t border-foreground/10 space-y-[var(--space-sm)]">
          <p className="text-[length:var(--text-xs)] text-muted-foreground">
            {t("stepStyle.compliance.intro")}
          </p>
          {!prefs || rules.length === 0 ? (
            <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("stepStyle.loading")}</p>
          ) : (
            <div className="space-y-[var(--space-xs)]">
              {rules.map((rule) => {
                const disabled = (prefs.disabledComplianceRules ?? []).includes(rule.code);
                return (
                  <div key={rule.code} className="space-y-[1px]">
                    <div className="flex items-center gap-[var(--space-sm)]">
                      <button
                        type="button"
                        onClick={() => toggleRule(rule.code)}
                        className={
                          "w-[14px] h-[14px] rounded-[0.15rem] border-2 flex items-center justify-center shrink-0 transition-colors " +
                          (disabled ? "border-foreground/20 bg-transparent" : "border-foreground bg-foreground")
                        }
                      >
                        {!disabled && (
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-background">
                            <path d="M1 4L3 6L7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                      <span className={"text-[length:var(--text-sm)] font-bold shrink-0 " + (disabled ? "text-muted-foreground line-through" : "")}>
                        {rule.label}
                      </span>
                      <span className="flex-1 border-b border-dotted border-foreground/20" />
                      <span className="text-[length:var(--text-2xs)] font-bold uppercase tracking-widest text-muted-foreground shrink-0">
                        {rule.code}
                      </span>
                    </div>
                    <p className={"pl-[22px] text-[length:var(--text-xs)] text-muted-foreground " + (disabled ? "opacity-50" : "")}>{rule.description}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </details>

      {error && <p className="text-[length:var(--text-sm)] text-destructive font-medium">{error}</p>}

      <div className="flex justify-between items-center pt-[var(--space-md)]">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t("actions.back")}
        </Button>
        <Button type="submit" disabled={saving} className="px-[var(--space-xl)]">
          {saving ? t("actions.saving") : t("actions.continue")}
        </Button>
      </div>
    </form>
  );
}

function SwitchRow({ label, desc, on, onChange }: { label: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="w-full flex items-center justify-between gap-[var(--space-md)] text-left"
    >
      <div className="min-w-0">
        <div className="text-[length:var(--text-xs)] font-bold uppercase tracking-widest">{label}</div>
        <div className="text-[length:var(--text-xs)] text-muted-foreground mt-[1px]">{desc}</div>
      </div>
      <div
        className={
          "shrink-0 w-[34px] h-[20px] rounded-full border-2 transition-colors flex items-center " +
          (on ? "border-foreground bg-foreground" : "border-foreground/20 bg-transparent")
        }
      >
        <div
          className={
            "h-[12px] w-[12px] rounded-full transition-all " +
            (on ? "ml-[18px] bg-background" : "ml-[2px] bg-foreground/40")
          }
        />
      </div>
    </button>
  );
}

// ── Step 5: WhatsApp setup ───────────────────────────────────────────────────
function StepWhatsApp({ state, onSaved, onBack }: { state: OnboardingState; onSaved: () => void; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const { user, refresh } = useAuth();
  const explicitJoinUrl = String(import.meta.env.VITE_WHATSAPP_ONBOARDING_URL || import.meta.env.VITE_WHATSAPP_JOIN_URL || "").trim();
  const sandboxCode = String(import.meta.env.VITE_TWILIO_SANDBOX_JOIN_CODE || "").trim();
  const joinUrl = explicitJoinUrl || (sandboxCode ? `https://wa.me/14155238886?text=${encodeURIComponent(`join ${sandboxCode}`)}` : "");
  const joinUrlDetails = (() => {
    if (!joinUrl) return { phone: "", message: "" };
    try {
      const url = new URL(joinUrl);
      const phone = url.hostname === "wa.me" ? url.pathname.replace(/^\//, "") : "";
      return { phone, message: url.searchParams.get("text") || "Bonjour Bernardo" };
    } catch {
      return { phone: "", message: "Bonjour Bernardo" };
    }
  })();
  const bernardoPhone = joinUrlDetails.phone
    ? formatPhone(`+${joinUrlDetails.phone}`).replace(/\./g, " ")
    : "";
  const testMessage = joinUrlDetails.message;
  const [copied, setCopied] = useState<"phone" | "message" | null>(null);
  const [adminPhone, setAdminPhone] = useState(user?.phone || "");
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneError, setPhoneError] = useState("");
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [reminderFrequency, setReminderFrequency] = useState<AdminPreferences["reminderFrequency"]>("weekly");
  const [reminderSaving, setReminderSaving] = useState(false);
  const [reminderError, setReminderError] = useState("");
  const savedAdminPhone = user?.phone || "";

  useEffect(() => {
    setAdminPhone(user?.phone || "");
  }, [user?.phone]);

  const copyFallback = async (kind: "phone" | "message", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1500);
  };

  const saveAdminPhone = async () => {
    const phone = adminPhone.trim();
    setPhoneError("");
    setPhoneSaved(false);
    if (!user) return;
    if (!phone) {
      setPhoneError(t("stepWhatsApp.adminPhoneRequired"));
      return;
    }
    setPhoneSaving(true);
    try {
      await api.updateUser(user.id, { phone });
      await refresh();
      setPhoneSaved(true);
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setPhoneSaving(false);
    }
  };

  const continueOnboarding = async () => {
    setReminderError("");
    setReminderSaving(true);
    try {
      await api.updatePreferences({ reminderFrequency });
      onSaved();
    } catch (err) {
      setReminderError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setReminderSaving(false);
    }
  };

  return (
    <div className="space-y-[var(--space-lg)]">
      <div>
        <h2 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight">
          {t("stepWhatsApp.title")}
        </h2>
        <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
          {t("stepWhatsApp.subtitle")}
        </p>
      </div>

      <div className="border border-foreground/20 rounded-md p-[var(--space-md)] space-y-[var(--space-md)]">
        <div className="flex items-start gap-[var(--space-sm)]">
          <div className="h-9 w-9 rounded-full bg-foreground text-background flex items-center justify-center shrink-0">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[length:var(--text-sm)] font-bold tracking-tight">{t("stepWhatsApp.connectTitle")}</p>
            <p className="text-[length:var(--text-xs)] text-muted-foreground mt-[var(--space-xs)]">
              {joinUrl ? t("stepWhatsApp.connectBodyReady") : t("stepWhatsApp.connectBodyMissing")}
            </p>
          </div>
        </div>

        {joinUrl && (
          <div className="space-y-[var(--space-md)]">
            <a
              href={joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-[var(--space-xs)] rounded-full bg-foreground text-background px-[var(--space-md)] py-[var(--space-sm)] text-[length:var(--text-sm)] font-bold hover:opacity-90 transition-opacity"
            >
              {t("stepWhatsApp.openWhatsapp")}
              <ExternalLink className="h-4 w-4" />
            </a>

            {bernardoPhone && (
              <div className="rounded-md border border-foreground/10 bg-foreground/5 p-[var(--space-sm)] space-y-[var(--space-sm)]">
                <p className="text-[length:var(--text-xs)] font-bold tracking-tight">{t("stepWhatsApp.phoneFallbackTitle")}</p>
                <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("stepWhatsApp.phoneFallbackBody")}</p>
                <div className="grid sm:grid-cols-2 gap-[var(--space-sm)]">
                  <div className="space-y-[2px]">
                    <p className="text-[length:var(--text-2xs)] uppercase tracking-widest text-muted-foreground">{t("stepWhatsApp.bernardoNumberLabel")}</p>
                    <div className="flex items-center gap-[var(--space-xs)]">
                      <span className="font-mono text-[length:var(--text-sm)]">{bernardoPhone}</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => copyFallback("phone", bernardoPhone)}>
                        {copied === "phone" ? t("stepWhatsApp.copied") : t("stepWhatsApp.copy")}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-[2px]">
                    <p className="text-[length:var(--text-2xs)] uppercase tracking-widest text-muted-foreground">{t("stepWhatsApp.testMessageLabel")}</p>
                    <div className="flex items-center gap-[var(--space-xs)]">
                      <span className="font-mono text-[length:var(--text-sm)]">{testMessage}</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => copyFallback("message", testMessage)}>
                        {copied === "message" ? t("stepWhatsApp.copied") : t("stepWhatsApp.copy")}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border border-foreground/20 rounded-md p-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className="text-[length:var(--text-sm)] font-bold tracking-tight">{t("stepWhatsApp.pairingTitle")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("stepWhatsApp.pairingBody")}</p>

        <div className="space-y-[var(--space-xs)]">
          <Label htmlFor="admin-whatsapp-phone" className="text-[length:var(--text-xs)] tracking-wide font-medium">
            {t("stepWhatsApp.adminPhoneLabel")}
          </Label>
          <div className="flex flex-col sm:flex-row gap-[var(--space-sm)]">
            <Input
              id="admin-whatsapp-phone"
              type="tel"
              value={adminPhone}
              onChange={(e) => { setAdminPhone(e.target.value); setPhoneSaved(false); }}
              placeholder="+33 6 12 34 56 78"
              className="sm:flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={saveAdminPhone}
              disabled={phoneSaving || adminPhone.trim() === savedAdminPhone.trim()}
            >
              {phoneSaving ? t("stepWhatsApp.adminPhoneSaving") : t("stepWhatsApp.adminPhoneSave")}
            </Button>
          </div>
          <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("stepWhatsApp.adminPhoneHelp")}</p>
          {phoneError && <p className="text-[length:var(--text-xs)] text-destructive font-medium">{phoneError}</p>}
          {phoneSaved && <p className="text-[length:var(--text-xs)] text-emerald-600 dark:text-emerald-400 font-medium">{t("stepWhatsApp.adminPhoneSaved")}</p>}
        </div>

        <ul className="space-y-[var(--space-xs)]">
          <li className="flex items-center gap-[var(--space-sm)] text-[length:var(--text-sm)]">
            <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{t("stepWhatsApp.phoneRows.team", { count: state.counts.employees })}</span>
          </li>
        </ul>
      </div>

      <div className="border border-foreground/20 rounded-md p-[var(--space-md)] space-y-[var(--space-sm)]">
        <p className="text-[length:var(--text-sm)] font-bold tracking-tight">{t("stepWhatsApp.remindersTitle")}</p>
        <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("stepWhatsApp.remindersBody")}</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-[var(--space-xs)]">
          {([
            { value: "off", label: t("stepWhatsApp.reminderOptions.off"), desc: t("stepWhatsApp.reminderOptions.offDesc") },
            { value: "daily", label: t("stepWhatsApp.reminderOptions.daily"), desc: t("stepWhatsApp.reminderOptions.dailyDesc") },
            { value: "weekly", label: t("stepWhatsApp.reminderOptions.weekly"), desc: t("stepWhatsApp.reminderOptions.weeklyDesc") },
          ] as const).map((opt) => {
            const active = reminderFrequency === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setReminderFrequency(opt.value)}
                className={
                  "rounded-md border p-[var(--space-sm)] text-left transition-colors " +
                  (active ? "border-foreground bg-foreground text-background" : "border-foreground/15 hover:border-foreground/40")
                }
              >
                <span className="block text-[length:var(--text-xs)] font-bold uppercase tracking-widest">{opt.label}</span>
                <span className={"block mt-[2px] text-[length:var(--text-xs)] " + (active ? "opacity-75" : "text-muted-foreground")}>{opt.desc}</span>
              </button>
            );
          })}
        </div>
        {reminderError && <p className="text-[length:var(--text-xs)] text-destructive font-medium">{reminderError}</p>}
      </div>

      <div className="border border-foreground/20 bg-foreground/5 rounded-md p-[var(--space-md)] space-y-[var(--space-xs)]">
        <p className="text-[length:var(--text-sm)] font-bold tracking-tight">{t("stepWhatsApp.whatWorksTitle")}</p>
        <ul className="text-[length:var(--text-xs)] text-muted-foreground space-y-[var(--space-xs)]">
          <li>• {t("stepWhatsApp.whatWorks.schedule")}</li>
          <li>• {t("stepWhatsApp.whatWorks.replacements")}</li>
          <li>• {t("stepWhatsApp.whatWorks.timeclock")}</li>
        </ul>
      </div>

      <div className="flex justify-between items-center pt-[var(--space-md)]">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t("actions.back")}
        </Button>
        <Button onClick={continueOnboarding} disabled={reminderSaving} className="px-[var(--space-xl)]">
          {reminderSaving ? t("actions.saving") : joinUrl ? t("stepWhatsApp.continueReady") : t("stepWhatsApp.continueMissing")}
        </Button>
      </div>
    </div>
  );
}

// ── Step 6: Finish ───────────────────────────────────────────────────────────
function Step5Finish({ state, onFinish, onBack }: { state: OnboardingState; onFinish: () => Promise<void>; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const [finishing, setFinishing] = useState(false);

  const ack = (label: string, ok: boolean) => (
    <li className="flex items-center gap-[var(--space-sm)] text-[length:var(--text-sm)]">
      <div
        className={
          "h-5 w-5 rounded-full border flex items-center justify-center shrink-0 " +
          (ok ? "bg-foreground border-foreground" : "border-foreground/30")
        }
      >
        {ok && <Check className="h-3 w-3 text-background" />}
      </div>
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </li>
  );

  const handle = async () => {
    setFinishing(true);
    try {
      await onFinish();
    } finally {
      setFinishing(false);
    }
  };

  const subRolesCount = state.restaurant.kitchenSubRoles.length + state.restaurant.floorSubRoles.length;

  return (
    <div className="space-y-[var(--space-lg)]">
      <div>
        <h2 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] leading-tight">
          {t("step5Finish.title")}
        </h2>
        <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-xs)]">
          {t("step5Finish.subtitle")}
        </p>
      </div>

      <ul className="space-y-[var(--space-sm)] border border-foreground/20 rounded-md p-[var(--space-md)]">
        {state.restaurant.address && ack(t("step5Finish.summary.address", { address: state.restaurant.address }), true)}
        {state.restaurant.schoolZone &&
          ack(
            t("step5Finish.summary.zones", {
              schoolZone: state.restaurant.schoolZone,
              holidayZone: state.restaurant.holidayZone ?? "–",
            }),
            true,
          )}
        {ack(
          t("step5Finish.summary.subRoles", { count: subRolesCount }),
          subRolesCount > 0,
        )}
        {ack(t("step5Finish.summary.profiles", { count: state.counts.profiles }), state.counts.profiles > 0)}
        {ack(t("step5Finish.summary.employees", { count: state.counts.employees }), state.counts.employees > 0)}
      </ul>

      <div className="border border-foreground/20 bg-foreground/5 rounded-md p-[var(--space-md)] space-y-[var(--space-sm)]">
        <h3 className="text-[length:var(--text-sm)] font-bold tracking-tight">{t("step5Finish.afterTitle")}</h3>
        <ul className="text-[length:var(--text-xs)] text-muted-foreground space-y-[var(--space-xs)] tracking-wide">
          <li>
            • <Trans i18nKey="onboarding:step5Finish.after.schedule" components={{ strong: <strong className="text-foreground" /> }} />
          </li>
          <li>
            • <Trans i18nKey="onboarding:step5Finish.after.preferences" components={{ strong: <strong className="text-foreground" /> }} />
          </li>
          <li>
            • <Trans i18nKey="onboarding:step5Finish.after.staff" components={{ strong: <strong className="text-foreground" /> }} />
          </li>
          <li>• {t("step5Finish.after.whatsapp")}</li>
        </ul>
      </div>

      <div className="flex justify-between items-center pt-[var(--space-md)]">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t("actions.back")}
        </Button>
        <Button onClick={handle} disabled={finishing} className="px-[var(--space-xl)]">
          {finishing ? t("actions.saving") : t("step5Finish.finishButton")}
        </Button>
      </div>
    </div>
  );
}
