/**
 * Weather display components for schedule views.
 * WMO weather codes → SVG icons, temperature anomaly indicators.
 */
import {
 IconSun, IconCloud, IconCloudRain, IconCloudSnow,
 IconCloudStorm, IconDroplets, IconUmbrella, IconSunLow, IconCloudFog,
} from "@tabler/icons-react";
import { TrendingUp, TrendingDown, Sunrise, Sunset, Sun, Radio, CircleCheck, ChevronRight } from "lucide-react";

type WeatherIcon = "sun" | "partly-cloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "showers" | "thunderstorm";

function wmoToIcon(code: number | null): WeatherIcon {
 if (code === null || code === undefined) return "cloudy";
 if (code === 0) return "sun";
 if (code <= 2) return "partly-cloudy";
 if (code === 3) return "cloudy";
 if (code <= 48) return "fog";
 if (code <= 57) return "drizzle";
 if (code <= 67) return "rain";
 if (code <= 77) return "snow";
 if (code <= 82) return "showers";
 return "thunderstorm";
}

const ICON_MAP: Record<WeatherIcon, typeof IconSun> = {
 "sun": IconSun,
 "partly-cloudy": IconSunLow,
 "cloudy": IconCloud,
 "fog": IconCloudFog,
 "drizzle": IconDroplets,
 "rain": IconCloudRain,
 "snow": IconCloudSnow,
 "showers": IconUmbrella,
 "thunderstorm": IconCloudStorm,
};

/** Weather icon — compact, monochrome, inherits currentColor */
export function WeatherIconSvg({ code, size = 14 }: { code: number | null; size?: number }) {
 const icon = wmoToIcon(code);
 const Icon = ICON_MAP[icon];
 return <Icon size={size} stroke={1.5} className="inline-block opacity-60" />;
}

/** Temperature anomaly badge: red thermo (+/++/+++) or blue thermo (-/--/---) */
export function TempAnomalyBadge({ tempMax, normalMax }: { tempMax: number | null; normalMax: number | null }) {
 if (tempMax === null || normalMax === null) return null;
 const diff = tempMax - normalMax;

 let level: string;
 let color: string;

 if (diff >= 9) { level = "+++"; color = "text-red-600"; }
 else if (diff >= 6) { level = "++"; color = "text-red-500"; }
 else if (diff >= 3) { level = "+"; color = "text-red-400"; }
 else if (diff <= -9) { level = "---"; color = "text-blue-600"; }
 else if (diff <= -6) { level = "--"; color = "text-blue-500"; }
 else if (diff <= -3) { level = "-"; color = "text-blue-400"; }
 else return null;

 const isHot = diff > 0;
 return (
 <span className={`inline-flex items-center gap-[1px] text-[length:var(--text-2xs)] font-bold ${color}`} title={`${diff > 0 ? "+" : ""}${diff.toFixed(0)}°C vs normale`}>
 <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor" className="shrink-0">
 {isHot ? (
 // Red thermometer
 <path d="M4 0C3.2 0 2.5.7 2.5 1.5V6c-.6.4-1 1.1-1 1.9C1.5 9.3 2.6 10 4 10s2.5-.7 2.5-2.1c0-.8-.4-1.5-1-1.9V1.5C5.5.7 4.8 0 4 0zm0 8.5c-.8 0-1.5-.5-1.5-1.2 0-.5.3-.9.7-1.1V1.5c0-.4.4-.8.8-.8s.8.4.8.8v4.7c.4.2.7.6.7 1.1 0 .7-.7 1.2-1.5 1.2z" />
 ) : (
 // Blue thermometer
 <path d="M4 0C3.2 0 2.5.7 2.5 1.5V6c-.6.4-1 1.1-1 1.9C1.5 9.3 2.6 10 4 10s2.5-.7 2.5-2.1c0-.8-.4-1.5-1-1.9V1.5C5.5.7 4.8 0 4 0zm0 8.5c-.8 0-1.5-.5-1.5-1.2 0-.5.3-.9.7-1.1V4c0-.2.4-.2.8 0v2.2c.4.2.7.6.7 1.1 0 .7-.7 1.2-1.5 1.2z" />
 )}
 </svg>
 {level}
 </span>
 );
}

/** Bigger weather header badge for grid day headers — splits MIDI/SOIR if temps differ >=3° */
export function WeatherHeaderBadge({ w, isToday }: { w: WeatherDay; isToday: boolean }) {
 const muted = isToday ? "text-background/60" : "text-muted-foreground/60";

 // Pull representative hourly values for midi (12h) and soir (19h)
 const midiTemp = w.hourlyTemperatures?.[12] ?? null;
 const soirTemp = w.hourlyTemperatures?.[19] ?? null;
 const midiCode = w.hourlyWeatherCodes?.[12] ?? w.weatherCode;
 const soirCode = w.hourlyWeatherCodes?.[19] ?? w.weatherCode;

 const showSplit = midiTemp !== null && soirTemp !== null && Math.abs(midiTemp - soirTemp) >= 3;

 if (showSplit) {
 return (
 <div className="flex items-center justify-center gap-[8px]">
 <div className="flex items-center gap-[3px]">
 <WeatherIconSvg code={midiCode} size={14} />
 <span className={cn("text-[length:13px] font-bold", muted)}>{Math.round(midiTemp)}°</span>
 </div>
 <ChevronRight className={cn("size-3", muted)} />
 <div className="flex items-center gap-[3px]">
 <WeatherIconSvg code={soirCode} size={14} />
 <span className={cn("text-[length:13px] font-bold", muted)}>{Math.round(soirTemp)}°</span>
 </div>
 </div>
 );
 }

 const temp = w.tempMax;
 return (
 <div className="flex items-center justify-center gap-[4px]">
 <WeatherIconSvg code={w.weatherCode} size={16} />
 {temp !== null && <span className={cn("text-[length:14px] font-bold", muted)}>{Math.round(temp)}°</span>}
 </div>
 );
}

/** Ephemeris display — sunrise/sunset times */
export function EphemerisBadge({ sunrise, sunset }: { sunrise: string | null; sunset: string | null }) {
 if (!sunrise || !sunset) return null;
 return (
    <span className="inline-flex items-center gap-[3px] text-[length:7px] text-muted-foreground/50 font-bold" title={`Lever ${sunrise} — Coucher ${sunset}`}>
 ☀{sunrise}—{sunset}
 </span>
 );
}

const WMO_LABELS: Record<number, string> = {
 0: "Ciel dégagé", 1: "Peu nuageux", 2: "Partiellement nuageux", 3: "Couvert",
 45: "Brouillard", 48: "Brouillard givrant",
 51: "Bruine légère", 53: "Bruine modérée", 55: "Bruine forte",
 61: "Pluie légère", 63: "Pluie modérée", 65: "Pluie forte",
 71: "Neige légère", 73: "Neige modérée", 75: "Neige forte",
 80: "Averses légères", 81: "Averses modérées", 82: "Averses violentes",
 95: "Orage", 96: "Orage grêle légère", 99: "Orage grêle forte",
};

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { WeatherDay, CalendarEvent } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Clickable weather summary — shows infobox on click */
export function WeatherZoneSummary({ code, tempMax, tempMin: _tempMin, normalMax, weatherDay }: {
 code: number | null; tempMax: number | null; tempMin: number | null; normalMax: number | null;
 weatherDay?: WeatherDay | null;
}) {
 const [open, setOpen] = useState(false);
 const ref = useRef<HTMLSpanElement>(null);

 return (
 <span ref={ref} className="relative inline-flex items-center gap-[3px] cursor-pointer" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
 <WeatherIconSvg code={code} size={12} />
 {tempMax !== null && (
 <span className="text-[length:var(--text-2xs)] font-bold text-muted-foreground/60">
 {Math.round(tempMax)}°
 </span>
 )}
 <TempAnomalyBadge tempMax={tempMax} normalMax={normalMax} />
 {open && weatherDay && createPortal(
 <WeatherInfobox day={weatherDay} onClose={() => setOpen(false)} anchorRef={ref} />,
 document.body
 )}
 </span>
 );
}

/** Infobox popover with full weather details */
function WeatherInfobox({ day, onClose, anchorRef, inline }: { day: WeatherDay; onClose: () => void; anchorRef: React.RefObject<HTMLSpanElement | null>; inline?: boolean }) {
 const [pos, setPos] = useState({ top: 0, left: 0 });
 useEffect(() => {
 if (inline || !anchorRef.current) return;
 const rect = anchorRef.current.getBoundingClientRect();
 setPos({ top: rect.bottom + 4, left: rect.left + rect.width / 2 });
 }, [anchorRef, inline]);
 // Close on click outside
 useEffect(() => {
 if (inline) return;
 const handler = (e: MouseEvent) => {
 if (anchorRef.current?.contains(e.target as Node)) return;
 onClose();
 };
 document.addEventListener("mousedown", handler);
 return () => document.removeEventListener("mousedown", handler);
 }, [onClose, anchorRef, inline]);
 const codeLabel = WMO_LABELS[day.weatherCode ?? 0] || "Inconnu";
 const diffMax = (day.tempMax != null && day.normalTempMax != null) ? day.tempMax - day.normalTempMax : null;

 // Compute daylight duration
 const daylightMin = (day.sunrise && day.sunset) ? (() => {
 const [sh, sm] = day.sunrise.split(":").map(Number);
 const [eh, em] = day.sunset.split(":").map(Number);
 return (eh * 60 + em) - (sh * 60 + sm);
 })() : null;
 const daylightH = daylightMin ? Math.floor(daylightMin / 60) : null;
 const daylightM = daylightMin ? daylightMin % 60 : null;

 // Hourly data for timeline
 const temps = day.hourlyTemperatures || [];
 const codes = day.hourlyWeatherCodes || [];
 const hasHourly = temps.length >= 24;

 // Key hours for restaurant: 6h-1h (opening hours)
 const keyHours = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0];

 const content = (
 <>
 {/* Header */}
 <div className="flex items-center justify-between mb-[var(--space-sm)]">
 <div className="flex items-center gap-[var(--space-sm)]">
 <WeatherIconSvg code={day.weatherCode} size={20} />
 <div>
 <div className="text-[length:var(--text-sm)] font-bold">{codeLabel}</div>
 <div className="text-[length:var(--text-xs)] text-muted-foreground">{day.date}</div>
 </div>
 </div>
 <div className="text-right">
 <div className="text-[length:var(--text-base)] font-bold">
 {day.tempMax != null ? `${day.tempMax.toFixed(1)}°` : "—"}
 </div>
 <div className="text-[length:var(--text-xs)] text-muted-foreground">
 {day.tempMin != null ? `${day.tempMin.toFixed(1)}°` : ""}
 </div>
 </div>
 </div>

 {/* Temperature comparison bar */}
 <div className="space-y-[3px] text-[length:var(--text-xs)] mb-[var(--space-sm)]">
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-muted-foreground w-[50px] text-right shrink-0">Actuel</span>
 <div className="flex-1 h-[6px] bg-muted rounded-full overflow-hidden relative">
 {day.tempMin != null && day.tempMax != null && (() => {
 const rangeMin = Math.min(day.tempMin, day.normalTempMin ?? day.tempMin) - 2;
 const rangeMax = Math.max(day.tempMax, day.normalTempMax ?? day.tempMax) + 2;
 const left = ((day.tempMin - rangeMin) / (rangeMax - rangeMin)) * 100;
 const width = ((day.tempMax - day.tempMin) / (rangeMax - rangeMin)) * 100;
 return <div className="absolute h-full bg-foreground/70 rounded-full" style={{ left: `${left}%`, width: `${width}%` }} />;
 })()}
 </div>
 <span className="font-bold w-[65px] text-right">{day.tempMin?.toFixed(0)}°–{day.tempMax?.toFixed(0)}°</span>
 </div>
 {day.normalTempMax != null && day.normalTempMin != null && (
 <div className="flex items-center gap-[var(--space-sm)]">
 <span className="text-muted-foreground/60 w-[50px] text-right shrink-0">Normale</span>
 <div className="flex-1 h-[6px] bg-muted rounded-full overflow-hidden relative">
 {(() => {
 const rangeMin = Math.min(day.tempMin ?? day.normalTempMin, day.normalTempMin) - 2;
 const rangeMax = Math.max(day.tempMax ?? day.normalTempMax, day.normalTempMax) + 2;
 const left = ((day.normalTempMin - rangeMin) / (rangeMax - rangeMin)) * 100;
 const width = ((day.normalTempMax - day.normalTempMin) / (rangeMax - rangeMin)) * 100;
 return <div className="absolute h-full bg-muted-foreground/30 rounded-full" style={{ left: `${left}%`, width: `${width}%` }} />;
 })()}
 </div>
 <span className="text-muted-foreground/60 w-[65px] text-right">{day.normalTempMin.toFixed(0)}°–{day.normalTempMax.toFixed(0)}°</span>
 </div>
 )}
 {/* Anomaly */}
 {diffMax !== null && Math.abs(diffMax) >= 3 && (
 <div className={`text-right text-[length:var(--text-xs)] font-bold ${diffMax > 0 ? "text-red-500" : "text-blue-500"}`}>
 {diffMax > 0 ? <TrendingUp className="size-3 inline" /> : <TrendingDown className="size-3 inline" />} {Math.abs(diffMax).toFixed(1)}°C au-{diffMax > 0 ? "dessus" : "dessous"} de la normale
 </div>
 )}
 </div>

 {/* Hourly weather timeline */}
 {hasHourly && (
 <div className="border-t border-border/40 pt-[var(--space-sm)] mb-[var(--space-sm)]">
          <div className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground mb-[3px]">Heures clés</div>
 <div className="flex gap-[1px]">
 {keyHours.map((h) => {
 const t = temps[h];
 const c = codes[h];
 const isSunrise = day.sunrise ? Math.abs(h - parseInt(day.sunrise)) === 0 : false;
 const isSunset = day.sunset ? Math.abs(h - parseInt(day.sunset)) === 0 : false;
 return (
 <div key={h} className="flex flex-col items-center" style={{ width: `${100 / keyHours.length}%` }}>
                  <span className="text-[length:7px] text-muted-foreground/50">{String(h).padStart(2, "0")}</span>
 <WeatherIconSvg code={c} size={10} />
                  <span className="text-[length:7px] font-bold">{t != null ? `${Math.round(t)}°` : ""}</span>
 {(isSunrise || isSunset) && (
 <span className="text-amber-500">{isSunrise ? <Sunrise className="size-2.5" /> : <Sunset className="size-2.5" />}</span>
 )}
 </div>
 );
 })}
 </div>
 </div>
 )}

 {/* Mini temperature sparkline */}
 {hasHourly && (
 <div className="border-t border-border/40 pt-[var(--space-sm)] mb-[var(--space-sm)]">
          <div className="text-[length:var(--text-2xs)] uppercase tracking-widest font-bold text-muted-foreground mb-[3px]">Température 24h</div>
 <svg viewBox="0 0 288 40" className="w-full h-[40px]">
 {/* Background grid */}
 {[6, 12, 18, 0].map((h) => (
 <line key={h} x1={h * 12} y1={0} x2={h * 12} y2={40} stroke="currentColor" strokeOpacity={0.1} />
 ))}
 {/* Temperature curve */}
 <polyline
 fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.6}
 points={temps.map((t, i) => {
 const minT = Math.min(...temps.filter(v => v != null));
 const maxT = Math.max(...temps.filter(v => v != null));
 const range = maxT - minT || 1;
 const x = i * 12;
 const y = 38 - ((t - minT) / range) * 36;
 return `${x},${y}`;
 }).join(" ")}
 />
 {/* Min/Max dots */}
 {(() => {
 const minT = Math.min(...temps.filter(v => v != null));
 const maxT = Math.max(...temps.filter(v => v != null));
 const range = maxT - minT || 1;
 const minI = temps.indexOf(minT);
 const maxI = temps.indexOf(maxT);
 return (
 <>
 <circle cx={maxI * 12} cy={38 - ((maxT - minT) / range) * 36} r={3} fill="currentColor" fillOpacity={0.8} />
 <text x={maxI * 12} y={38 - ((maxT - minT) / range) * 36 - 5} textAnchor="middle" fontSize={7} fill="currentColor" fillOpacity={0.6}>{maxT.toFixed(0)}°</text>
 <circle cx={minI * 12} cy={38} r={3} fill="currentColor" fillOpacity={0.4} />
 <text x={minI * 12} y={38 + 8} textAnchor="middle" fontSize={7} fill="currentColor" fillOpacity={0.4}>{minT.toFixed(0)}°</text>
 </>
 );
 })()}
 </svg>
 </div>
 )}

 {/* Ephemeris + Daylight */}
 {day.sunrise && day.sunset && (
 <div className="border-t border-border/40 pt-[var(--space-sm)] text-[length:var(--text-xs)]">
 <div className="flex justify-between">
 <span className="text-muted-foreground flex items-center gap-1"><Sunrise className="size-3" /> Lever</span>
 <span className="font-bold">{day.sunrise}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted-foreground flex items-center gap-1"><Sunset className="size-3" /> Coucher</span>
 <span className="font-bold">{day.sunset}</span>
 </div>
 {daylightH !== null && daylightM !== null && (
 <div className="flex justify-between">
 <span className="text-muted-foreground flex items-center gap-1"><Sun className="size-3" /> Durée du jour</span>
 <span className="font-bold">{daylightH}h{String(daylightM).padStart(2, "0")}</span>
 </div>
 )}
 {/* Daylight bar */}
 <div className="mt-[3px] h-[4px] bg-muted rounded-full overflow-hidden relative">
 {(() => {
 const [sh] = day.sunrise.split(":").map(Number);
 const [eh] = day.sunset.split(":").map(Number);
 const left = (sh / 24) * 100;
 const width = ((eh - sh) / 24) * 100;
 return <div className="absolute h-full bg-amber-400/60 rounded-full" style={{ left: `${left}%`, width: `${width}%` }} />;
 })()}
 </div>
          <div className="flex justify-between text-[length:7px] text-muted-foreground/40 mt-[1px]">
 <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>24h</span>
 </div>
 </div>
 )}

 {/* Source */}
 <div className="text-[length:var(--text-2xs)] text-muted-foreground/40 text-right mt-[var(--space-sm)] border-t border-border/40 pt-[2px]">
 <span className="inline-flex items-center gap-1">{day.isForecast ? <><Radio className="size-3 inline" /> Prévision</> : <><CircleCheck className="size-3 inline" /> Confirmé</>} · Open-Meteo</span>
 </div>
 </>
 );

 if (inline) return <div>{content}</div>;

 return (
 <div className="fixed z-50 bg-background border border-border rounded-[0.2rem] shadow-lg p-[var(--space-md)] text-left -translate-x-1/2"
 style={{ top: pos.top, left: pos.left, width: 320 }}
 onClick={(e) => e.stopPropagation()}
 >
 {content}
 </div>
 );
}

// ── Day Infobox — unified popover for calendar events + weather ──

export function DayInfobox({ weatherDay, holiday, vacation, onClose, anchorRef }: {
 weatherDay?: WeatherDay | null;
 holiday?: CalendarEvent | null;
 vacation?: CalendarEvent | null;
 dateStr?: string;
 onClose: () => void;
 anchorRef: React.RefObject<HTMLElement | null>;
}) {
 const [pos, setPos] = useState({ top: 0, left: 0 });
 useEffect(() => {
 if (!anchorRef.current) return;
 const rect = anchorRef.current.getBoundingClientRect();
 const left = Math.min(Math.max(rect.left + rect.width / 2, 170), window.innerWidth - 170);
 setPos({ top: rect.bottom + 4, left });
 }, [anchorRef]);
 useEffect(() => {
 const handler = (e: MouseEvent) => {
 if (anchorRef.current?.contains(e.target as Node)) return;
 onClose();
 };
 document.addEventListener("mousedown", handler);
 return () => document.removeEventListener("mousedown", handler);
 }, [onClose, anchorRef]);

 const hasWeather = !!weatherDay;

 return createPortal(
 <div
 className="fixed z-50 bg-background border border-border rounded-[0.2rem] shadow-lg p-[var(--space-md)] text-left -translate-x-1/2"
 style={{ top: pos.top, left: pos.left, width: 320 }}
 onClick={(e) => e.stopPropagation()}
 >
 {/* 1. Jour férié */}
 {holiday && (
 <div className="flex items-center gap-[var(--space-sm)] pb-[var(--space-sm)] border-b border-border/40 mb-[var(--space-sm)]">
 <div>
 <div className="text-[length:var(--text-xs)] tracking-wide font-bold text-red-500 dark:text-red-400">Jour férié</div>
 <div className="text-[length:var(--text-sm)] font-bold">{holiday.name}</div>
 </div>
 </div>
 )}

 {/* 2. Vacances scolaires */}
 {vacation && (
 <div className={cn("flex items-center gap-[var(--space-sm)]", hasWeather || holiday ? "pb-[var(--space-sm)] border-b border-border/40 mb-[var(--space-sm)]" : "")}>
 <div>
 <div className="text-[length:var(--text-xs)] tracking-wide font-bold text-blue-500 dark:text-blue-400">Vacances scolaires</div>
 <div className="text-[length:var(--text-sm)] font-bold">{vacation.name}</div>
 {vacation.endDate && (
 <div className="text-[length:var(--text-xs)] text-muted-foreground">du {vacation.date} au {vacation.endDate}</div>
 )}
 </div>
 </div>
 )}

 {/* 3. Météo */}
 {hasWeather ? (
 <WeatherInfobox day={weatherDay!} onClose={() => {}} anchorRef={{ current: null }} inline />
 ) : (
 <div className="text-[length:var(--text-xs)] text-muted-foreground/60 text-center py-[var(--space-sm)]">
 Météo non disponible pour cette date
 </div>
 )}
 </div>,
 document.body
 );
}
