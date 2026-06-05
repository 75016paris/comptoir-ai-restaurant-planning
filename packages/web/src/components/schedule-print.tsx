import { type ServiceRow, type User, type RestaurantClosure } from "@/lib/api";
import { fmtDateFR, toISO, JOURS } from "@/lib/date-utils";
import { hasChefLabel } from "@comptoir/shared";

function addDays(date: Date, n: number): Date {
 const d = new Date(date);
 d.setDate(d.getDate() + n);
 return d;
}



/** First name only — compact for print */
function printName(full: string): string {
 return full.trim().split(/\s+/)[0];
}

type Props = {
 monday: Date;
 services: ServiceRow[];
 workers: User[];
 closures: RestaurantClosure[];
 restaurantName?: string;
};

type DayData = {
 date: Date;
 dateStr: string;
 dayNameFull: string;
 closure: RestaurantClosure | undefined;
 midi: ServiceRow[];
 soir: ServiceRow[];
};

/** Print-optimized weekly schedule — kitchen and salle separated */
export function SchedulePrint({ monday, services, workers, closures, restaurantName }: Props) {
 const weekLabel = `${fmtDateFR(toISO(monday))} – ${fmtDateFR(toISO(addDays(monday, 6)))} ${addDays(monday, 6).getFullYear()}`;

 // Build day data for each role
 const buildDays = (role: "kitchen" | "floor"): DayData[] =>
 Array.from({ length: 7 }, (_, i) => {
 const date = addDays(monday, i);
 const dateStr = toISO(date);
 const closure = closures.find(c => dateStr >= c.startDate && dateStr <= c.endDate);
 const roleServices = services.filter(s => s.date === dateStr && (s.workerRole || s.role) === role);
 const midi = roleServices.filter(s => s.startTime < "16:00").sort((a, b) => a.startTime.localeCompare(b.startTime));
 const soir = roleServices.filter(s => s.startTime >= "16:00").sort((a, b) => a.startTime.localeCompare(b.startTime));
 return { date, dateStr, dayNameFull: JOURS[date.getDay()], closure, midi, soir };
 });

 // Hours per worker
 const workerHours = new Map<string, number>();
 for (const s of services) {
 const [sh, sm] = s.startTime.split(":").map(Number);
 const [eh, em] = s.endTime.split(":").map(Number);
 let mins = (eh * 60 + em) - (sh * 60 + sm);
 if (mins < 0) mins += 24 * 60;
 workerHours.set(s.workerId, (workerHours.get(s.workerId) || 0) + mins / 60);
 }

 const kitchenDays = buildDays("kitchen");
 const salleDays = buildDays("floor");
 const kitchenWorkers = workers.filter(w => w.role === "kitchen").sort((a, b) => a.name.localeCompare(b.name));
 const salleWorkers = workers.filter(w => w.role === "floor").sort((a, b) => a.name.localeCompare(b.name));

 return (
 <div id="schedule-print" className="schedule-print">
 {/* Page 1: Cuisine */}
 <div className="print-page">
 <PrintHeader title={restaurantName} subtitle={`Cuisine — ${weekLabel}`} />
 <ScheduleTable days={kitchenDays} />
 <HoursSummary workers={kitchenWorkers} workerHours={workerHours} />
 <PrintFooter />
 </div>

 {/* Page 2: Salle */}
 <div className="print-page print-page-break">
 <PrintHeader title={restaurantName} subtitle={`Salle — ${weekLabel}`} />
 <ScheduleTable days={salleDays} />
 <HoursSummary workers={salleWorkers} workerHours={workerHours} />
 <PrintFooter />
 </div>
 </div>
 );
}

function PrintHeader({ title, subtitle }: { title?: string; subtitle: string }) {
 return (
 <div className="print-header">
 <div className="print-title">{title || "Planning"}</div>
 <div className="print-subtitle">{subtitle}</div>
 </div>
 );
}

function PrintFooter() {
 return (
 <div className="print-footer">
 Imprimé le {new Date().toLocaleDateString("fr-FR")} à {new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
 </div>
 );
}

function ScheduleTable({ days }: { days: DayData[] }) {
 return (
 <table className="print-table">
 <thead>
 <tr>
 <th className="print-zone-col"></th>
 {days.map(d => (
 <th key={d.dateStr} className={`print-day-header ${d.closure ? "print-closed" : ""}`}>
 <div className="print-day-name">{d.dayNameFull}</div>
 <div className="print-day-date">{d.date.getDate()}/{String(d.date.getMonth() + 1).padStart(2, "0")}</div>
 {d.closure && <div className="print-closed-label">FERMÉ</div>}
 </th>
 ))}
 </tr>
 </thead>
 <tbody>
 <ZoneRow zone="MIDI" days={days} getServices={d => d.midi} />
 <ZoneRow zone="SOIR" days={days} getServices={d => d.soir} />
 </tbody>
 </table>
 );
}

function ZoneRow({ zone, days, getServices }: { zone: string; days: DayData[]; getServices: (d: DayData) => ServiceRow[] }) {
 return (
 <tr className="print-zone-row">
 <td className="print-zone-label">{zone}</td>
 {days.map(d => {
 const zoneServices = getServices(d);
 return (
 <td key={d.dateStr} className={`print-cell ${d.closure ? "print-closed-cell" : ""}`}>
 {d.closure || zoneServices.length === 0 ? (
 <div className="print-empty">—</div>
 ) : (
 <div className="print-services">
 {zoneServices.map(s => (
 <div key={s.id} className="print-service">
 <span className="print-worker-name">{hasChefLabel(s.workerSubRoles) ? "★ " : ""}{printName(s.workerName)}</span>
 <span className="print-service-time">{s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}</span>
 </div>
 ))}
 </div>
 )}
 </td>
 );
 })}
 </tr>
 );
}

function HoursSummary({ workers, workerHours }: { workers: User[]; workerHours: Map<string, number> }) {
 const withHours = workers.filter(w => workerHours.has(w.id));
 if (withHours.length === 0) return null;

 return (
 <div className="print-summary">
 <div className="print-summary-title">Heures de la semaine</div>
 <div className="print-summary-grid">
 {withHours.map(w => (
 <div key={w.id} className="print-summary-item">
 <span className="print-summary-name">{printName(w.name)}</span>
 <span className="print-summary-hours">{workerHours.get(w.id)!.toFixed(1)}h</span>
 </div>
 ))}
 </div>
 </div>
 );
}
