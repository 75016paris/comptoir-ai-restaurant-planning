import { createContext, useContext } from "react";

export type Theme = "light" | "dark";

export interface ThemeContextValue {
 theme: Theme;
 resolved: "light" | "dark";
 setTheme: (t: Theme) => void;
}

export const ThemeCtx = createContext<ThemeContextValue>({
 theme: "light",
 resolved: "light",
 setTheme: () => {},
});

export function useTheme() {
 return useContext(ThemeCtx);
}
