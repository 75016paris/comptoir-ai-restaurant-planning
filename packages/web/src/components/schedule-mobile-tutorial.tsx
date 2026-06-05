import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "comptoir.schedule.tutorial-mobile.dismissed";
const TUTORIAL_WIDTH = 340;
const TUTORIAL_HEIGHT = 220;

function readDismissed(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("resetTutorial") === "1") {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch { return false; }
}

function writeDismissed() {
  try { localStorage.setItem(STORAGE_KEY, "1"); } catch {
    // Ignore storage failures (private mode / disabled localStorage).
  }
}

export function ScheduleMobileTutorial({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("schedule");
  const [dismissed, setDismissed] = useState(readDismissed);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const dismiss = () => {
    setDismissed(true);
    writeDismissed();
  };

  // Dismiss when the user taps anywhere within the tutorial's bounding rect —
  // since the wrapper has pointer-events: none, the underlying schedule element
  // still receives the tap, but we can detect the location and remove the
  // overlay so subsequent taps go through cleanly.
  useEffect(() => {
    if (!enabled || dismissed) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = wrapperRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        dismiss();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [enabled, dismissed]);

  if (!enabled || dismissed) return null;

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "fixed bottom-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none",
        "drop-shadow-md",
      )}
      style={{ width: TUTORIAL_WIDTH }}
      aria-hidden="true"
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        className="absolute -top-2 -right-2 size-6 rounded-full bg-background border border-border text-muted-foreground hover:text-foreground flex items-center justify-center pointer-events-auto z-10 shadow-sm"
        aria-label={t("mobileTutorial.closeAria")}
      >
        <X className="size-3.5" />
      </button>
      <iframe
        src="/tutorial-titulaires-mobile.html?embed=1"
        title={t("mobileTutorial.iframeTitle")}
        className="w-full border-0 bg-transparent"
        style={{ height: TUTORIAL_HEIGHT }}
        loading="lazy"
      />
    </div>
  );
}
