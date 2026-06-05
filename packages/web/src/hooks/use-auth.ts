import { createContext, useContext } from "react";
import type { AuthUser } from "@/lib/api";

export type AuthContextType = {
 user: AuthUser | null;
 loading: boolean;
 login: (email: string, password: string) => Promise<void>;
 demoLogin: (email: string) => Promise<void>;
 logout: () => Promise<void>;
 refresh: () => Promise<AuthUser | null>;
 switchRestaurant: (restaurantId: string) => Promise<void>;
};

export const AuthContext = createContext<AuthContextType>(null!);

export function useAuth() {
 return useContext(AuthContext);
}
