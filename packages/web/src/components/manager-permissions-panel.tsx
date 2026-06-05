import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ALL_PERMISSIONS, ROLE_DEFAULTS, parsePermissions, type Permission } from "@comptoir/shared";
import { Button } from "@/components/ui/button";

type Props = {
  userId: string;
  initialPermissions: string | null | undefined;
  sectionClass: string;
  onSaved?: () => void;
};

export function ManagerPermissionsPanel({ userId, initialPermissions, sectionClass, onSaved }: Props) {
  const { t } = useTranslation("staff");
  const defaults = ROLE_DEFAULTS.manager;

  // Effective state shown in the UI: parsed override merged onto role defaults.
  const initial = useMemo(() => {
    const overrides = parsePermissions(initialPermissions);
    const result = {} as Record<Permission, boolean>;
    for (const p of ALL_PERMISSIONS) {
      result[p] = typeof overrides[p] === "boolean" ? (overrides[p] as boolean) : defaults[p];
    }
    return result;
  }, [initialPermissions, defaults]);

  const [state, setState] = useState<Record<Permission, boolean>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setState(initial); }, [initial]);

  // Compute the override payload: only keys whose value differs from the role default.
  const overrides = useMemo(() => {
    const out: Partial<Record<Permission, boolean>> = {};
    for (const p of ALL_PERMISSIONS) {
      if (state[p] !== defaults[p]) out[p] = state[p];
    }
    return out;
  }, [state, defaults]);

  const dirty = useMemo(() => {
    const initialOverrides = parsePermissions(initialPermissions);
    if (Object.keys(initialOverrides).length !== Object.keys(overrides).length) return true;
    for (const k of Object.keys(overrides)) {
      if (initialOverrides[k as Permission] !== overrides[k as Permission]) return true;
    }
    return false;
  }, [overrides, initialPermissions]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/permissions`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? t("permissions.errors.updateFailed"));
      }
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("permissions.errors.network"));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    const cleared = {} as Record<Permission, boolean>;
    for (const p of ALL_PERMISSIONS) cleared[p] = defaults[p];
    setState(cleared);
  }

  return (
    <div className={sectionClass}>
      <h3 className="font-bold tracking-wide text-[length:var(--text-sm)] mb-[var(--space-md)]">{t("permissions.title")}</h3>
      <p className="text-[length:var(--text-xs)] text-muted-foreground mb-[var(--space-md)]">
        {t("permissions.intro")}
      </p>

      <div className="space-y-[var(--space-xs)]">
        {ALL_PERMISSIONS.map((p) => {
          const label = t(`permissions.items.${p}.label`);
          const help = t(`permissions.items.${p}.help`);
          const overridden = state[p] !== defaults[p];
          return (
            <label
              key={p}
              className="flex items-start gap-[var(--space-sm)] py-1 cursor-pointer"
              title={help}
            >
              <input
                type="checkbox"
                checked={state[p]}
                onChange={(e) => setState({ ...state, [p]: e.target.checked })}
                className="mt-1 cursor-pointer"
              />
              <div className="flex-1">
                <div className="text-[length:var(--text-sm)] font-medium">
                  {label}
                  {overridden && (
                    <span className="ml-2 text-[length:var(--text-xs)] text-amber-600 dark:text-amber-400">
                      {t("permissions.modifiedBadge")}
                    </span>
                  )}
                </div>
                <div className="text-[length:var(--text-xs)] text-muted-foreground">{help}</div>
              </div>
            </label>
          );
        })}
      </div>

      {error && (
        <div className="mt-[var(--space-md)] text-[length:var(--text-xs)] text-destructive">{error}</div>
      )}

      <div className="mt-[var(--space-lg)] flex gap-[var(--space-sm)]">
        <Button onClick={save} disabled={!dirty || saving} size="sm">
          {saving ? t("permissions.savingButton") : t("permissions.saveButton")}
        </Button>
        <Button onClick={reset} variant="outline" size="sm" disabled={saving}>
          {t("permissions.resetButton")}
        </Button>
      </div>
    </div>
  );
}
