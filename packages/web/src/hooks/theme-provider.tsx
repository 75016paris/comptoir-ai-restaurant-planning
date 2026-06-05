import { useEffect, useState, type ReactNode } from "react";
import { ThemeCtx, type Theme } from "./use-theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
 const [theme, setThemeState] = useState<Theme>(() => {
 // Accept theme from URL param (e.g. from cosmobot.fr link)
 const params = new URLSearchParams(window.location.search);
 const urlTheme = params.get("theme") as Theme | null;
 if (urlTheme && ["light", "dark"].includes(urlTheme)) {
 localStorage.setItem("comptoir-theme", urlTheme);
 return urlTheme;
 }
 const stored = localStorage.getItem("comptoir-theme") as Theme | null;
 return stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
 });

 const resolved = theme;

 useEffect(() => {
 const root = document.documentElement;
 root.classList.toggle("dark", resolved === "dark");
 }, [resolved]);

 function setTheme(t: Theme) {
 setThemeState(t);
 localStorage.setItem("comptoir-theme", t);
 }

 return (
 <ThemeCtx.Provider value={{ theme, resolved, setTheme }}>
 {children}
 </ThemeCtx.Provider>
 );
}
