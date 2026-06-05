import { useState, useCallback } from "react";

export type SortDir = "asc" | "desc" | null;
export type SortState<K extends string> = { col: K; dir: SortDir };

export function useSort<K extends string>(defaultCol?: K) {
  const [sort, setSort] = useState<SortState<K>>({ col: defaultCol as K, dir: null });
  const toggle = useCallback((col: K) => {
    setSort(prev => {
      if (prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      if (prev.dir === "desc") return { col, dir: null };
      return { col, dir: "asc" };
    });
  }, []);
  return { sort, toggle };
}

export function applySortNum<T>(items: T[], sort: SortState<string>, getters: Record<string, (item: T) => number | string>): T[] {
  if (!sort.dir || !getters[sort.col]) return items;
  const getter = getters[sort.col];
  const sorted = [...items].sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb);
    return (va as number) - (vb as number);
  });
  return sort.dir === "desc" ? sorted.reverse() : sorted;
}
