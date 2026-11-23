/**
 * CRM business calendar (Africa/Lagos). Measures SLA time either continuously or counting only working hours
 * on working days that are not holidays. Pure functions: every SLA figure in the CRM goes through these.
 */
import { fromLagos, lagosParts } from "../time";

export interface CrmCalendar {
  working_start: number; // hour of day, 0–23
  working_end: number; // hour of day, 1–24
  working_days: number[]; // ISO weekday: 1 = Monday … 7 = Sunday
  holidays: string[]; // YYYY-MM-DD (Lagos)
}

const DAY = 86_400_000;
const iso = (d: Date) => {
  const w = lagosParts(d).weekday;
  return w === 0 ? 7 : w;
};
const dateKey = (p: { year: number; month: number; day: number }) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

/** Working window [open, close) of the Lagos day containing `t`, or null if it is not a working day. */
function windowOf(t: Date, cal: CrmCalendar): { dayStart: number; open: number; close: number } | null {
  const p = lagosParts(t);
  const dayStart = fromLagos(p.year, p.month, p.day).getTime();
  if (!cal.working_days.includes(iso(t)) || cal.holidays.includes(dateKey(p))) return { dayStart, open: 0, close: 0 };
  return { dayStart, open: dayStart + cal.working_start * 3_600_000, close: dayStart + cal.working_end * 3_600_000 };
}

/** Working milliseconds between a and b (0 when b <= a). */
export function businessMsBetween(a: Date, b: Date, cal: CrmCalendar): number {
  let t = a.getTime();
  const end = b.getTime();
  if (end <= t) return 0;
  let total = 0;
  for (let guard = 0; t < end && guard < 3700; guard++) {
    const w = windowOf(new Date(t), cal)!;
    if (w.close > w.open) {
      const s = Math.max(t, w.open);
      const e = Math.min(end, w.close);
      if (e > s) total += e - s;
    }
    t = w.dayStart + DAY;
  }
  return total;
}

/** The instant `ms` working milliseconds after `from`. */
export function addBusinessMs(from: Date, ms: number, cal: CrmCalendar): Date {
  let t = from.getTime();
  let left = ms;
  if (!cal.working_days.length || cal.working_end <= cal.working_start) return new Date(t + ms);
  for (let guard = 0; guard < 3700; guard++) {
    const w = windowOf(new Date(t), cal)!;
    if (w.close > w.open && t < w.close) {
      const s = Math.max(t, w.open);
      if (s + left <= w.close) return new Date(s + left);
      left -= w.close - s;
    }
    t = w.dayStart + DAY;
  }
  return new Date(from.getTime() + ms);
}

/** SLA time between two instants under a ticket's policy mode. */
export function slaMs(a: Date, b: Date, businessHours: boolean, cal: CrmCalendar): number {
  return businessHours ? businessMsBetween(a, b, cal) : Math.max(0, b.getTime() - a.getTime());
}

export function slaAdd(from: Date, ms: number, businessHours: boolean, cal: CrmCalendar): Date {
  return businessHours ? addBusinessMs(from, ms, cal) : new Date(from.getTime() + ms);
}
