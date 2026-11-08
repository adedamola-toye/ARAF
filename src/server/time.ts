/**
 * Time helpers. Timestamps are stored in UTC; Africa/Lagos (WAT, UTC+01:00, no DST) is used
 * for display and for business date rules. Offsets are derived through Intl so that the code
 * stays correct if the zone rules ever change.
 */
export const LAGOS_TZ = "Africa/Lagos";

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: LAGOS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

export interface LagosParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function lagosParts(d: Date): LagosParts {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(d)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
    weekday: WD[p.weekday],
  };
}

/** Lagos calendar date (YYYY-MM-DD) for an instant. */
export function lagosDate(d: Date): string {
  const p = lagosParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC instant for a Lagos wall-clock time. */
export function fromLagos(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // offset = lagos wall clock - utc at the guess instant
  const p = lagosParts(new Date(guess));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = wall - guess;
  return new Date(guess - offset);
}

export function addDaysToDateString(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function isValidDateString(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const displayFmt = new Intl.DateTimeFormat("en-NG", {
  timeZone: LAGOS_TZ,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function formatLagos(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return `${displayFmt.format(date)} WAT`;
}
export function formatDateOnly(s: string | Date | null | undefined): string {
  if (!s) return "—";
  const str = typeof s === "string" ? s.slice(0, 10) : lagosDate(s);
  const [y, m, d] = str.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Monday 00:00 Lagos of the week containing `d`. */
export function lagosWeekStart(d: Date): Date {
  const p = lagosParts(d);
  const daysSinceMonday = (p.weekday + 6) % 7;
  const today = fromLagos(p.year, p.month, p.day);
  return new Date(today.getTime() - daysSinceMonday * 86400000);
}
