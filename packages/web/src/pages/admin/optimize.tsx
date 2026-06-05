import { useTranslation } from "react-i18next";
import { AutoOptimizeTab } from "@/components/optimize/auto-optimize";

export function OptimizePage() {
  const { t } = useTranslation("optimize");

  return (
    <div className="space-y-[var(--space-lg)]">
      <div className="flex items-center justify-between">
        <h1 className="text-[length:var(--text-2xl)] md:text-[length:var(--text-3xl)] font-bold tracking-[-0.03em]">
          {t("tabs.auto")}
        </h1>
      </div>

      <AutoOptimizeTab />
    </div>
  );
}
