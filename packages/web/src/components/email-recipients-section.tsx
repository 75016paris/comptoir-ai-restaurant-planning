import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type EmailRecipient } from "@/lib/api";
import { toast } from "sonner";
import { X } from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailRecipientsSection() {
  const { t } = useTranslation("preferences");
  const [rows, setRows] = useState<EmailRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listEmailRecipients()
      .then(setRows)
      .catch(() => toast.error(t("emailRecipients.errors.load")))
      .finally(() => setLoading(false));
  }, [t]);

  const handleCreate = async () => {
    const label = newLabel.trim();
    const email = newEmail.trim().toLowerCase();
    if (!label) return toast.error(t("emailRecipients.errors.nameRequired"));
    if (!EMAIL_RE.test(email)) return toast.error(t("emailRecipients.errors.invalidEmail"));
    setSaving(true);
    try {
      const created = await api.createEmailRecipient({ label, email });
      setRows(prev => [...prev, created]);
      setNewLabel("");
      setNewEmail("");
      setAdding(false);
    } catch {
      toast.error(t("emailRecipients.errors.add"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: string, field: "sendMonthlyDigest" | "sendLeaveAlerts", value: boolean) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
    try {
      await api.updateEmailRecipient(id, { [field]: value });
    } catch {
      toast.error(t("emailRecipients.errors.update"));
      setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: !value } : r));
    }
  };

  const handleRename = async (id: string, patch: { label?: string; email?: string }) => {
    const before = rows.find(r => r.id === id);
    if (!before) return;
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    try {
      await api.updateEmailRecipient(id, patch);
    } catch {
      toast.error(t("emailRecipients.errors.update"));
      setRows(prev => prev.map(r => r.id === id ? before : r));
    }
  };

  const handleDelete = async (id: string) => {
    const before = rows;
    setRows(prev => prev.filter(r => r.id !== id));
    try {
      await api.deleteEmailRecipient(id);
    } catch {
      toast.error(t("emailRecipients.errors.delete"));
      setRows(before);
    }
  };

  return (
    <div className="space-y-[var(--space-sm)] pt-[var(--space-md)]">
      <div className="flex items-center justify-between">
        <p className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground">
          {t("emailRecipients.heading")}
        </p>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("emailRecipients.addLabel")}
          </button>
        )}
      </div>
      <p className="text-[length:var(--text-xs)] text-muted-foreground">
        {t("emailRecipients.intro")}
      </p>

      {loading ? (
        <p className="text-[length:var(--text-xs)] text-muted-foreground">{t("emailRecipients.loading")}</p>
      ) : (
        <div className="space-y-[var(--space-xs)]">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-[var(--space-sm)] border-b border-foreground/10 py-[var(--space-xs)]">
              <input
                value={r.label}
                onChange={(e) => setRows(prev => prev.map(x => x.id === r.id ? { ...x, label: e.target.value } : x))}
                onBlur={(e) => handleRename(r.id, { label: e.target.value.trim() })}
                placeholder={t("emailRecipients.namePlaceholder")}
                className="flex-1 bg-transparent border-b border-foreground/10 focus:border-foreground outline-none text-[length:var(--text-sm)] pb-[1px]"
              />
              <input
                type="email"
                value={r.email}
                onChange={(e) => setRows(prev => prev.map(x => x.id === r.id ? { ...x, email: e.target.value } : x))}
                onBlur={(e) => {
                  const v = e.target.value.trim().toLowerCase();
                  if (EMAIL_RE.test(v)) handleRename(r.id, { email: v });
                  else toast.error(t("emailRecipients.errors.invalidEmail"));
                }}
                placeholder={t("emailRecipients.emailPlaceholder")}
                className="flex-1 bg-transparent border-b border-foreground/10 focus:border-foreground outline-none text-[length:var(--text-sm)] text-muted-foreground pb-[1px]"
              />
              <label className="flex items-center gap-[4px] text-[length:var(--text-xs)] text-muted-foreground whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={r.sendMonthlyDigest}
                  onChange={(e) => handleToggle(r.id, "sendMonthlyDigest", e.target.checked)}
                  className="accent-foreground"
                />
                {t("emailRecipients.monthlyDigest")}
              </label>
              <label className="flex items-center gap-[4px] text-[length:var(--text-xs)] text-muted-foreground whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={r.sendLeaveAlerts}
                  onChange={(e) => handleToggle(r.id, "sendLeaveAlerts", e.target.checked)}
                  className="accent-foreground"
                />
                {t("emailRecipients.leaveAlerts")}
              </label>
              <button
                type="button"
                onClick={() => handleDelete(r.id)}
                className="text-muted-foreground/50 hover:text-destructive transition-colors"
                aria-label={t("emailRecipients.deleteAria")}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}

          {adding && (
            <div className="flex items-center gap-[var(--space-sm)] border-b border-foreground/20 py-[var(--space-xs)]">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("emailRecipients.namePlaceholderExample")}
                autoFocus
                className="flex-1 bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-sm)] pb-[1px]"
              />
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder={t("emailRecipients.emailPlaceholder")}
                className="flex-1 bg-transparent border-b border-foreground/20 focus:border-foreground outline-none text-[length:var(--text-sm)] pb-[1px]"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={saving}
                className="text-[length:var(--text-xs)] uppercase tracking-widest font-bold px-[var(--space-sm)] py-[2px] rounded-full border border-foreground text-background bg-foreground hover:bg-transparent hover:text-foreground transition-colors"
              >
                {saving ? t("actions.loadingShort") : t("emailRecipients.okButton")}
              </button>
              <button
                type="button"
                onClick={() => { setAdding(false); setNewLabel(""); setNewEmail(""); }}
                className="text-muted-foreground/50 hover:text-foreground transition-colors"
                aria-label={t("emailRecipients.cancelAria")}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {rows.length === 0 && !adding && (
            <p className="text-[length:var(--text-xs)] text-muted-foreground italic">{t("emailRecipients.empty")}</p>
          )}
        </div>
      )}
    </div>
  );
}
