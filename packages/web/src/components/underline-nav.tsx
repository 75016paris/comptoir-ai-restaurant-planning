import { useRef, useState, useLayoutEffect, useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface UnderlineNavItem {
 value: string;
 label: ReactNode;
 href?: string;
 disabled?: boolean;
}

interface UnderlineNavProps {
 items: UnderlineNavItem[];
 value: string;
 onChange?: (value: string) => void;
 className?: string;
 inactiveClassName?: string;
 activeClassName?: string;
 gapClassName?: string;
 /** Override the default item typography (font size / weight / padding). */
 itemClassName?: string;
 /** Override the underline thickness / offset. */
 barClassName?: string;
}

export function UnderlineNav({
 items,
 value,
 onChange,
 className,
 inactiveClassName = "text-muted-foreground/50",
 activeClassName = "text-foreground",
 gapClassName = "gap-[var(--space-md)]",
 itemClassName = "text-[length:var(--text-xs)] font-bold tracking-wide pb-[2px]",
 barClassName = "h-[2px]",
}: UnderlineNavProps) {
 const containerRef = useRef<HTMLDivElement>(null);
 const itemRefs = useRef(new Map<string, HTMLElement>());
 const [activeBar, setActiveBar] = useState<{ left: number; width: number } | null>(null);
 const [hoverBar, setHoverBar] = useState<{ left: number; width: number } | null>(null);

 const measure = useCallback((val: string) => {
 const el = itemRefs.current.get(val);
 const container = containerRef.current;
 if (!el || !container) return null;
 const cr = container.getBoundingClientRect();
 const er = el.getBoundingClientRect();
 return { left: er.left - cr.left, width: er.width };
 }, []);

 const itemsHash = items.map((i) => `${i.value}:${String(i.label)}`).join("|");

 useLayoutEffect(() => {
 const frame = requestAnimationFrame(() => {
 const pos = measure(value);
 if (pos) setActiveBar(pos);
 else setActiveBar(null);
 });
 return () => cancelAnimationFrame(frame);
 }, [value, itemsHash, measure]);

 const display = hoverBar ?? activeBar;

 return (
 <div
 ref={containerRef}
 className={cn("relative inline-flex items-center", gapClassName, className)}
 onMouseLeave={() => setHoverBar(null)}
 >
 {items.map((item) => {
 const isActive = value === item.value;
 const classes = cn(
 "cursor-pointer transition-colors whitespace-nowrap",
 itemClassName,
 isActive ? activeClassName : inactiveClassName,
 item.disabled && "opacity-50 !cursor-not-allowed"
 );
 const handleEnter = () => {
 if (item.disabled) return;
 const pos = measure(item.value);
 if (pos) setHoverBar(pos);
 };
 if (item.href) {
 return (
 <Link
 key={item.value}
 to={item.href}
 ref={(el) => {
 if (el) itemRefs.current.set(item.value, el);
 }}
 onMouseEnter={handleEnter}
 className={classes}
 >
 {item.label}
 </Link>
 );
 }
 return (
 <button
 key={item.value}
 ref={(el) => {
 if (el) itemRefs.current.set(item.value, el);
 }}
 onClick={() => !item.disabled && onChange?.(item.value)}
 onMouseEnter={handleEnter}
 className={classes}
 disabled={item.disabled}
 >
 {item.label}
 </button>
 );
 })}
 {display && (
 <div
 className={cn("absolute bottom-0 bg-foreground transition-all duration-200 ease-out pointer-events-none", barClassName)}
 style={{ left: display.left, width: display.width }}
 />
 )}
 </div>
 );
}
