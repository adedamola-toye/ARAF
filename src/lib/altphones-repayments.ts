/**
 * Altphones facility position: allocates the repayments received (oldest instalment first) across the final
 * schedule and derives each instalment's status, arrears and the facility status. Pure, so the facility page,
 * the portfolio report and the server share one calculation.
 *
 * An instalment is overdue once its due date has passed (the due date itself is not overdue). A facility is
 * fully repaid only when the repayments recorded cover the total repayable: never because a date passed.
 */

export interface ScheduleRow {
  seq: number;
  dueDate: string; // YYYY-MM-DD
  amountKobo: number;
}

export type InstalmentStatus = "PAID" | "PART_PAID" | "OVERDUE" | "DUE" | "UPCOMING";
export type FacilityStatus = "NOT_STARTED" | "ACTIVE" | "OVERDUE" | "FULLY_REPAID";

export interface InstalmentPosition extends ScheduleRow {
  paidKobo: number;
  status: InstalmentStatus;
}

export interface FacilityPosition {
  instalments: InstalmentPosition[];
  totalKobo: number;
  repaidKobo: number;
  outstandingKobo: number;
  dueToDateKobo: number;
  arrearsKobo: number;
  /** Instalments whose due date has passed and that are not fully paid. */
  overdueInstalments: number;
  /** Days since the oldest unpaid due date (0 when nothing is overdue). */
  daysOverdue: number;
  status: FacilityStatus;
  nextDue: InstalmentPosition | null;
}

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export function facilityPosition(schedule: ScheduleRow[], repaidKobo: number, today: string): FacilityPosition {
  const rows = [...schedule].sort((a, b) => a.seq - b.seq);
  let left = Math.max(0, repaidKobo);
  let dueToDate = 0;
  let arrears = 0;
  let overdue = 0;
  let oldest: string | null = null;
  const instalments = rows.map((r) => {
    const paid = Math.min(left, r.amountKobo);
    left -= paid;
    const past = r.dueDate < today;
    if (r.dueDate <= today) dueToDate += r.amountKobo;
    let status: InstalmentStatus;
    if (paid >= r.amountKobo) status = "PAID";
    else if (past) {
      status = "OVERDUE";
      overdue++;
      arrears += r.amountKobo - paid;
      oldest ??= r.dueDate;
    } else if (r.dueDate === today) status = "DUE";
    else status = paid > 0 ? "PART_PAID" : "UPCOMING";
    return { ...r, paidKobo: paid, status };
  });
  const total = rows.reduce((s, r) => s + r.amountKobo, 0);
  const repaid = Math.min(Math.max(0, repaidKobo), total);
  const status: FacilityStatus = total > 0 && repaid >= total ? "FULLY_REPAID" : overdue > 0 ? "OVERDUE" : repaid > 0 ? "ACTIVE" : "NOT_STARTED";
  return {
    instalments,
    totalKobo: total,
    repaidKobo: repaid,
    outstandingKobo: total - repaid,
    dueToDateKobo: dueToDate,
    arrearsKobo: arrears,
    overdueInstalments: overdue,
    daysOverdue: oldest ? days(oldest, today) : 0,
    status,
    nextDue: instalments.find((i) => i.status !== "PAID") ?? null,
  };
}

/** Arrears ageing bucket used in reporting. */
export function ageingBucket(overdueInstalments: number): "CURRENT" | "1" | "2" | "3+" {
  if (overdueInstalments <= 0) return "CURRENT";
  if (overdueInstalments === 1) return "1";
  if (overdueInstalments === 2) return "2";
  return "3+";
}

export const INSTALMENT_STATUS_LABEL: Record<InstalmentStatus, string> = { PAID: "Paid", PART_PAID: "Part paid", OVERDUE: "Overdue", DUE: "Due today", UPCOMING: "Upcoming" };
export const FACILITY_STATUS_LABEL: Record<FacilityStatus, string> = { NOT_STARTED: "No repayment yet", ACTIVE: "Current", OVERDUE: "In arrears", FULLY_REPAID: "Fully repaid" };
