// Color system — independent palette picks for Cuisine & Salle
// Each palette has 3 tiers:
//   vivid  → label cards (zone headers on stack)
//   medium → Chef / Sous-chef cards
//   pale   → all other roles (Cuisinier, Serveur, Plongeur, Barman…)

import type { ColorScheme } from "./api";

export type WorkerColor = { bg: string; border: string; text: string; dot: string };

// ── Single-role palettes ──────────────────────────────────────────────────────
// Each palette: vivid (label), medium (chef/sous-chef, 2 variants), pale (others, 4 variants)
export type RolePalette = {
  label: WorkerColor;
  chef: WorkerColor[];    // 2 variants for chef/sous-chef
  worker: WorkerColor[];  // 4 variants for other roles
};

const PALETTES: Record<string, RolePalette> = {
  amber: {
    label:  { bg: "bg-amber-300",  border: "border-amber-500",  text: "text-amber-950",  dot: "bg-amber-600" },
    chef: [
      { bg: "bg-amber-200",  border: "border-amber-400",  text: "text-amber-900",  dot: "bg-amber-500" },
      { bg: "bg-yellow-200", border: "border-yellow-400", text: "text-yellow-900", dot: "bg-yellow-500" },
    ],
    worker: [
      { bg: "bg-amber-100",  border: "border-amber-300",  text: "text-amber-800",  dot: "bg-amber-400" },
      { bg: "bg-yellow-100", border: "border-yellow-300", text: "text-yellow-800", dot: "bg-yellow-400" },
      { bg: "bg-amber-50",   border: "border-amber-200",  text: "text-amber-700",  dot: "bg-amber-300" },
      { bg: "bg-yellow-50",  border: "border-yellow-200", text: "text-yellow-700", dot: "bg-yellow-300" },
    ],
  },
  sky: {
    label:  { bg: "bg-sky-300",  border: "border-sky-500",  text: "text-sky-950",  dot: "bg-sky-600" },
    chef: [
      { bg: "bg-sky-200",   border: "border-sky-400",   text: "text-sky-900",   dot: "bg-sky-500" },
      { bg: "bg-blue-200",  border: "border-blue-400",  text: "text-blue-900",  dot: "bg-blue-500" },
    ],
    worker: [
      { bg: "bg-sky-100",   border: "border-sky-300",   text: "text-sky-800",   dot: "bg-sky-400" },
      { bg: "bg-blue-100",  border: "border-blue-300",  text: "text-blue-800",  dot: "bg-blue-400" },
      { bg: "bg-sky-50",    border: "border-sky-200",   text: "text-sky-700",   dot: "bg-sky-300" },
      { bg: "bg-blue-50",   border: "border-blue-200",  text: "text-blue-700",  dot: "bg-blue-300" },
    ],
  },
  lime: {
    label:  { bg: "bg-lime-300",  border: "border-lime-500",  text: "text-lime-950",  dot: "bg-lime-600" },
    chef: [
      { bg: "bg-lime-200",   border: "border-lime-400",   text: "text-lime-900",   dot: "bg-lime-500" },
      { bg: "bg-green-200",  border: "border-green-400",  text: "text-green-900",  dot: "bg-green-500" },
    ],
    worker: [
      { bg: "bg-lime-100",   border: "border-lime-300",   text: "text-lime-800",   dot: "bg-lime-400" },
      { bg: "bg-green-100",  border: "border-green-300",  text: "text-green-800",  dot: "bg-green-400" },
      { bg: "bg-lime-50",    border: "border-lime-200",   text: "text-lime-700",   dot: "bg-lime-300" },
      { bg: "bg-green-50",   border: "border-green-200",  text: "text-green-700",  dot: "bg-green-300" },
    ],
  },
  violet: {
    label:  { bg: "bg-violet-300",  border: "border-violet-500",  text: "text-violet-950",  dot: "bg-violet-600" },
    chef: [
      { bg: "bg-violet-200", border: "border-violet-400", text: "text-violet-900", dot: "bg-violet-500" },
      { bg: "bg-purple-200", border: "border-purple-400", text: "text-purple-900", dot: "bg-purple-500" },
    ],
    worker: [
      { bg: "bg-violet-100", border: "border-violet-300", text: "text-violet-800", dot: "bg-violet-400" },
      { bg: "bg-purple-100", border: "border-purple-300", text: "text-purple-800", dot: "bg-purple-400" },
      { bg: "bg-violet-50",  border: "border-violet-200", text: "text-violet-700", dot: "bg-violet-300" },
      { bg: "bg-purple-50",  border: "border-purple-200", text: "text-purple-700", dot: "bg-purple-300" },
    ],
  },
  teal: {
    label:  { bg: "bg-teal-300",  border: "border-teal-500",  text: "text-teal-950",  dot: "bg-teal-600" },
    chef: [
      { bg: "bg-teal-200",   border: "border-teal-400",   text: "text-teal-900",   dot: "bg-teal-500" },
      { bg: "bg-cyan-200",   border: "border-cyan-400",   text: "text-cyan-900",   dot: "bg-cyan-500" },
    ],
    worker: [
      { bg: "bg-teal-100",   border: "border-teal-300",   text: "text-teal-800",   dot: "bg-teal-400" },
      { bg: "bg-cyan-100",   border: "border-cyan-300",   text: "text-cyan-800",   dot: "bg-cyan-400" },
      { bg: "bg-teal-50",    border: "border-teal-200",   text: "text-teal-700",   dot: "bg-teal-300" },
      { bg: "bg-cyan-50",    border: "border-cyan-200",   text: "text-cyan-700",   dot: "bg-cyan-300" },
    ],
  },
  emerald: {
    label:  { bg: "bg-emerald-300",  border: "border-emerald-500",  text: "text-emerald-950",  dot: "bg-emerald-600" },
    chef: [
      { bg: "bg-emerald-200", border: "border-emerald-400", text: "text-emerald-900", dot: "bg-emerald-500" },
      { bg: "bg-green-200",   border: "border-green-400",   text: "text-green-900",   dot: "bg-green-500" },
    ],
    worker: [
      { bg: "bg-emerald-100", border: "border-emerald-300", text: "text-emerald-800", dot: "bg-emerald-400" },
      { bg: "bg-green-100",   border: "border-green-300",   text: "text-green-800",   dot: "bg-green-400" },
      { bg: "bg-emerald-50",  border: "border-emerald-200", text: "text-emerald-700", dot: "bg-emerald-300" },
      { bg: "bg-green-50",    border: "border-green-200",   text: "text-green-700",   dot: "bg-green-300" },
    ],
  },
  rose: {
    label:  { bg: "bg-rose-300",  border: "border-rose-500",  text: "text-rose-950",  dot: "bg-rose-600" },
    chef: [
      { bg: "bg-rose-200",  border: "border-rose-400",  text: "text-rose-900",  dot: "bg-rose-500" },
      { bg: "bg-pink-200",  border: "border-pink-400",  text: "text-pink-900",  dot: "bg-pink-500" },
    ],
    worker: [
      { bg: "bg-rose-100",  border: "border-rose-300",  text: "text-rose-800",  dot: "bg-rose-400" },
      { bg: "bg-pink-100",  border: "border-pink-300",  text: "text-pink-800",  dot: "bg-pink-400" },
      { bg: "bg-rose-50",   border: "border-rose-200",  text: "text-rose-700",  dot: "bg-rose-300" },
      { bg: "bg-pink-50",   border: "border-pink-200",  text: "text-pink-700",  dot: "bg-pink-300" },
    ],
  },
  slate: {
    label:  { bg: "bg-slate-300",  border: "border-slate-500",  text: "text-slate-950",  dot: "bg-slate-600" },
    chef: [
      { bg: "bg-slate-200",  border: "border-slate-400",  text: "text-slate-900",  dot: "bg-slate-500" },
      { bg: "bg-gray-200",   border: "border-gray-400",   text: "text-gray-900",   dot: "bg-gray-500" },
    ],
    worker: [
      { bg: "bg-slate-100",  border: "border-slate-300",  text: "text-slate-800",  dot: "bg-slate-400" },
      { bg: "bg-gray-100",   border: "border-gray-300",   text: "text-gray-800",   dot: "bg-gray-400" },
      { bg: "bg-slate-50",   border: "border-slate-200",  text: "text-slate-700",  dot: "bg-slate-300" },
      { bg: "bg-gray-50",    border: "border-gray-200",   text: "text-gray-700",   dot: "bg-gray-300" },
    ],
  },
};

export const PALETTE_NAMES: Record<string, string> = {
  amber: "Ambre", sky: "Ciel", lime: "Citron vert", violet: "Violet",
  teal: "Sarcelle", emerald: "Émeraude", rose: "Rose", slate: "Ardoise",
};

export const ALL_PALETTE_KEYS = Object.keys(PALETTES);

export function getPalette(key: string): RolePalette {
  return PALETTES[key] || PALETTES.amber;
}

// ── Backward-compat: map old paired ColorScheme → independent picks ──────────
const LEGACY_MAP: Record<ColorScheme, { kitchen: string; floor: string }> = {
  classic: { kitchen: "amber", floor: "sky" },
  sunset:  { kitchen: "lime",  floor: "violet" },
  ocean:   { kitchen: "teal",  floor: "amber" },
  earth:   { kitchen: "sky",   floor: "emerald" },
  garden:  { kitchen: "amber", floor: "sky" },
  candy:   { kitchen: "lime",  floor: "violet" },
};

// ── Runtime state ──────────────────────────────────────────────────────────────

let kitchenPalette = "amber";
let floorPalette = "sky";

const WORKER_COLORS: Record<string, WorkerColor> = {};
const WORKER_COLOR_INDEX: Record<string, number> = {};
// Track chef tier for crown rendering
const WORKER_TIER: Record<string, "chef" | "sous-chef" | "worker"> = {};
const WORKER_SUB_ROLES: Record<string, string[]> = {};

export function setColorPalettes(kitchen: string, floor: string) {
  kitchenPalette = PALETTES[kitchen] ? kitchen : "amber";
  floorPalette = PALETTES[floor] ? floor : "sky";
}

/** Backward compat — old ColorScheme → new independent picks */
export function setColorScheme(scheme: ColorScheme) {
  const mapped = LEGACY_MAP[scheme] || LEGACY_MAP.classic;
  setColorPalettes(mapped.kitchen, mapped.floor);
}

export function getColorPalettes(): { kitchen: string; floor: string } {
  return { kitchen: kitchenPalette, floor: floorPalette };
}

export function getKitchenLabel(): WorkerColor { return getPalette(kitchenPalette).label; }
export function getFloorLabel(): WorkerColor { return getPalette(floorPalette).label; }

export const KITCHEN_LABEL = new Proxy({} as WorkerColor, {
  get: (_, prop: string) => getPalette(kitchenPalette).label[prop as keyof WorkerColor],
});
export const FLOOR_LABEL = new Proxy({} as WorkerColor, {
  get: (_, prop: string) => getPalette(floorPalette).label[prop as keyof WorkerColor],
});

export function getWorkerColor(workerId: string): WorkerColor {
  return WORKER_COLORS[workerId] || getPalette(kitchenPalette).worker[0];
}

export function getWorkerColorIndex(workerId: string): number {
  return WORKER_COLOR_INDEX[workerId] ?? 0;
}

export function getWorkerTier(workerId: string): "chef" | "sous-chef" | "worker" {
  return WORKER_TIER[workerId] ?? "worker";
}

export function getWorkerSubRoles(workerId: string): string[] {
  return WORKER_SUB_ROLES[workerId] ?? [];
}

export function resetColors() {
  for (const key of Object.keys(WORKER_COLORS)) delete WORKER_COLORS[key];
  for (const key of Object.keys(WORKER_COLOR_INDEX)) delete WORKER_COLOR_INDEX[key];
  for (const key of Object.keys(WORKER_TIER)) delete WORKER_TIER[key];
  for (const key of Object.keys(WORKER_SUB_ROLES)) delete WORKER_SUB_ROLES[key];
}

import { hasChefLabel, hasSousChefLabel } from "@comptoir/shared";

export function assignColors(
  workers: Array<{
    id: string;
    name: string;
    role?: string;
    subRoles?: string[];
    primaryKitchenColor?: string | null;
    primaryFloorColor?: string | null;
  }>,
) {
  resetColors();
  const kitchen = workers.filter(w => w.role === "kitchen").sort((a, b) => a.name.localeCompare(b.name));
  const floor   = workers.filter(w => w.role === "floor").sort((a, b) => a.name.localeCompare(b.name));

  function assign(list: typeof workers, paletteKey: string) {
    const chefCounters = new Map<string, number>();
    const workerCounters = new Map<string, number>();
    list.forEach((w, i) => {
      const roles = w.subRoles ?? [];
      const isChef = hasChefLabel(roles);
      const isSousChef = !isChef && hasSousChefLabel(roles);
      const workerPaletteKey = (w.role === "kitchen" ? w.primaryKitchenColor : w.primaryFloorColor) || paletteKey;
      const pal = getPalette(workerPaletteKey);

      if (isChef || isSousChef) {
        const key = `${workerPaletteKey}:chef`;
        const chefIdx = chefCounters.get(key) ?? 0;
        WORKER_COLORS[w.id] = pal.chef[chefIdx % pal.chef.length];
        WORKER_TIER[w.id] = isChef ? "chef" : "sous-chef";
        chefCounters.set(key, chefIdx + 1);
      } else {
        const key = `${workerPaletteKey}:worker`;
        const workerIdx = workerCounters.get(key) ?? 0;
        WORKER_COLORS[w.id] = pal.worker[workerIdx % pal.worker.length];
        WORKER_TIER[w.id] = "worker";
        workerCounters.set(key, workerIdx + 1);
      }
      WORKER_COLOR_INDEX[w.id] = i;
      if (roles.length > 0) WORKER_SUB_ROLES[w.id] = roles;
    });
  }

  assign(kitchen, kitchenPalette);
  assign(floor, floorPalette);
}

// ── Backward compat exports ──────────────────────────────────────────────────

/** @deprecated — use getPalette + ALL_PALETTE_KEYS */
export function getSchemeBands(scheme: ColorScheme): { kitchen: WorkerColor[]; floor: WorkerColor[] } {
  const mapped = LEGACY_MAP[scheme] || LEGACY_MAP.classic;
  const kp = getPalette(mapped.kitchen), sp = getPalette(mapped.floor);
  return { kitchen: [kp.label, ...kp.chef], floor: [sp.label, ...sp.chef] };
}

/** @deprecated */
export function getSchemeLabel(scheme: ColorScheme): { kitchen: WorkerColor; floor: WorkerColor } {
  const mapped = LEGACY_MAP[scheme] || LEGACY_MAP.classic;
  return { kitchen: getPalette(mapped.kitchen).label, floor: getPalette(mapped.floor).label };
}

/** @deprecated — kept for backward compat, hidden from picker */
export const ALL_SCHEMES: ColorScheme[] = ["classic", "sunset", "ocean", "earth"];
