import { type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthUser } from "@/lib/api";
import { qk, setActiveRestaurantQueryScope } from "@/lib/query-keys";
import { AuthContext } from "./use-auth";

export function AuthProvider({ children }: { children: ReactNode }) {
 const queryClient = useQueryClient();

 const meQuery = useQuery({
 queryKey: qk.auth.me(),
 queryFn: async () => {
 try {
 const res = await api.me();
 return res.data;
 } catch {
 return null;
 }
 },
 staleTime: Infinity,
 retry: false,
 });

 const user: AuthUser | null = meQuery.data ?? null;
 const loading = meQuery.isPending;
 setActiveRestaurantQueryScope(user?.activeRestaurantId ?? user?.restaurantId ?? null);

 const setMe = (next: AuthUser | null) => {
 setActiveRestaurantQueryScope(next?.activeRestaurantId ?? next?.restaurantId ?? null);
 queryClient.setQueryData(qk.auth.me(), next);
 };

 const login = async (email: string, password: string) => {
 const res = (await api.login(email, password)) as { data: AuthUser };
 setMe(res.data);
 };

 const demoLogin = async (email: string) => {
 const res = (await api.demoLogin(email)) as { data: AuthUser };
 setMe(res.data);
 };

 const logout = async () => {
 await api.logout();
 setActiveRestaurantQueryScope(null);
 setMe(null);
 queryClient.clear();
 };

 const refresh = async () => {
 const res = await api.me();
 setMe(res.data);
 return res.data;
 };

 const switchRestaurant = async (restaurantId: string) => {
 await api.switchActiveRestaurant(restaurantId);
 setActiveRestaurantQueryScope(restaurantId);
 queryClient.removeQueries({ queryKey: qk.restaurant.all() });
 const res = await api.me();
 setActiveRestaurantQueryScope(res.data.activeRestaurantId ?? res.data.restaurantId ?? restaurantId);
 queryClient.setQueryData(qk.auth.me(), res.data);
 };

 return (
 <AuthContext.Provider value={{ user, loading, login, demoLogin, logout, refresh, switchRestaurant }}>
 {children}
 </AuthContext.Provider>
 );
}
