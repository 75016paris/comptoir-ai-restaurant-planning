import { useTheme } from "@/hooks/use-theme";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
 const { theme, setTheme } = useTheme();

 function cycle() {
 setTheme(theme === "light" ? "dark" : "light");
 }

 const icon = theme === "light" ? "☾︎" : "☀︎";
 const label = theme === "light" ? "Light" : "Dark";

 return (
 <Button
 variant="ghost"
 size="sm"
 onClick={cycle}
 className="font-medium text-xs tracking-wide"
 title={`Theme: ${label}`}
 >
 <span className="text-base">{icon}</span>
 </Button>
 );
}
