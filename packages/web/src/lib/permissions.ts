import { can, type Permission } from "@comptoir/shared";
import type { AuthUser } from "@/lib/api";

export function hasPermission(user: AuthUser | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  return can({ role: user.role, permissions: user.permissions ?? null }, permission);
}
