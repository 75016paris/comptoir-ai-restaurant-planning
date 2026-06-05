import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ArrowUp, ArrowDown } from "lucide-react";
import type { SortState } from "./sortable-head-utils";

export function SortableHead<K extends string>({ col, label, sort, toggle, align = "right", className }: {
  col: K; label: string; sort: SortState<K>; toggle: (col: K) => void; align?: "left" | "right"; className?: string;
}) {
  const active = sort.col === col && sort.dir !== null;
  return (
    <TableHead
      className={cn(
        "text-[length:var(--text-xs)] tracking-wide font-bold cursor-pointer select-none hover:text-foreground transition-colors",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
      onClick={() => toggle(col)}
    >
      <span className="inline-flex items-center gap-[2px]">
        {align === "right" && active && (
          sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
        )}
        {label}
        {align === "left" && active && (
          sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
        )}
      </span>
    </TableHead>
  );
}
