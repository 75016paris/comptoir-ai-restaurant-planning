import { serviceMinutes } from "./scheduling.js";

const HCR_OT_THRESHOLD_HOURS = 39;
const HCR_OT_110_HOURS = 4;
const HCR_OT_120_HOURS = 4;

type LaborCostService = {
  workerId: string;
  date: string;
  startTime: string;
  endTime: string;
  rateCents: number | null;
};

export type LaborCostSummary = {
  daily: Record<string, number>;
  weekly: number;
  unpricedWorkerCount: number;
};

function addBandCostCents(rateCents: number, startHour: number, hours: number): number {
  let remaining = hours;
  let cursor = startHour;
  let cost = 0;

  const addBand = (bandEnd: number, multiplier: number) => {
    if (remaining <= 0 || cursor >= bandEnd) return;
    const bandHours = Math.min(remaining, bandEnd - cursor);
    cost += bandHours * rateCents * multiplier;
    cursor += bandHours;
    remaining -= bandHours;
  };

  addBand(HCR_OT_THRESHOLD_HOURS, 1);
  addBand(HCR_OT_THRESHOLD_HOURS + HCR_OT_110_HOURS, 1.10);
  addBand(HCR_OT_THRESHOLD_HOURS + HCR_OT_110_HOURS + HCR_OT_120_HOURS, 1.20);
  if (remaining > 0) cost += remaining * rateCents * 1.50;

  return cost;
}

export function computeLaborCostSummary(services: LaborCostService[]): LaborCostSummary {
  const dailyLaborCostCents: Record<string, number> = {};
  const unpricedWorkerIds = new Set<string>();
  const pricedByWorker = new Map<string, LaborCostService[]>();

  for (const s of services) {
    if (s.rateCents == null) {
      unpricedWorkerIds.add(s.workerId);
      continue;
    }
    const list = pricedByWorker.get(s.workerId) ?? [];
    list.push(s);
    pricedByWorker.set(s.workerId, list);
  }

  for (const workerServices of pricedByWorker.values()) {
    workerServices.sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.startTime.localeCompare(b.startTime)
      || a.endTime.localeCompare(b.endTime)
    );

    let cumulativeHours = 0;
    for (const s of workerServices) {
      const hours = serviceMinutes(s.startTime, s.endTime) / 60;
      const cost = addBandCostCents(s.rateCents!, cumulativeHours, hours);
      dailyLaborCostCents[s.date] = (dailyLaborCostCents[s.date] || 0) + cost;
      cumulativeHours += hours;
    }
  }

  const daily: Record<string, number> = {};
  for (const d of Object.keys(dailyLaborCostCents)) {
    daily[d] = Math.round(dailyLaborCostCents[d]) / 100;
  }
  const weekly = Math.round(
    Object.values(dailyLaborCostCents).reduce((a, b) => a + b, 0)
  ) / 100;

  return { daily, weekly, unpricedWorkerCount: unpricedWorkerIds.size };
}
