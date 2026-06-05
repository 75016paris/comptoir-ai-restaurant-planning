/**
 * Bottom-anchored stack of unseen admin alerts. Polled once on mount +
 * every 60s so a worker completing their dossier surfaces here without
 * a full reload. Distinct from worker-facing notifications.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

type AdminAlert = {
  id: string;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
  createdAt: string;
};

async function fetchUnseen(): Promise<AdminAlert[]> {
  try {
    const r = await fetch("/api/admin-alerts?unseen=1");
    if (!r.ok) return [];
    const { data } = await r.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function markSeen(ids: string[]) {
  try {
    await fetch("/api/admin-alerts/mark-seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } catch { /* swallow */ }
}

export function AdminAlertsPopup() {
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetchUnseen().then((a) => { if (!cancelled) setAlerts(a); });
    const t = setInterval(async () => {
      const a = await fetchUnseen();
      if (!cancelled) setAlerts(a);
    }, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (alerts.length === 0) return null;

  function dismiss(a: AdminAlert) {
    setAlerts((prev) => prev.filter((x) => x.id !== a.id));
    markSeen([a.id]);
  }
  function open(a: AdminAlert) {
    markSeen([a.id]);
    setAlerts((prev) => prev.filter((x) => x.id !== a.id));
    if (a.actionUrl) navigate(a.actionUrl);
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[360px]">
      {alerts.slice(0, 3).map((a) => (
        <div
          key={a.id}
          className="rounded-xl border border-foreground/15 bg-background shadow-lg p-3 flex gap-3 items-start"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{a.title}</p>
            <p className="text-xs text-muted-foreground mt-1">{a.body}</p>
            {a.actionUrl && (
              <button
                onClick={() => open(a)}
                className="mt-2 text-xs font-semibold underline underline-offset-2"
              >
                Ouvrir
              </button>
            )}
          </div>
          <button
            onClick={() => dismiss(a)}
            aria-label="Masquer"
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
