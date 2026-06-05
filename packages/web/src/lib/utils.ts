import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import i18n from "@/i18n"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Format a French phone number: 0612345678 or +33612345678 → +33.6.12.34.56.78
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // Normalize to 9-digit national number
  let nat: string;
  if (digits.startsWith("0033") && digits.length === 13) {
    nat = digits.slice(4);
  } else if (digits.startsWith("33") && digits.length === 11) {
    nat = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 10) {
    nat = digits.slice(1);
  } else {
    return raw; // unrecognized format, return as-is
  }
  const g = (s: number, e: number) => nat.slice(s, e);
  return `+33.${g(0,1)}.${g(1,3)}.${g(3,5)}.${g(5,7)}.${g(7,9)}`;
}

export function shortName(full: string) {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export function errorMessage(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return fallback ?? i18n.t("common:status.error");
}
