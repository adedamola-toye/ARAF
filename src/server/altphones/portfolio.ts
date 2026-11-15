/**
 * Altphones management reporting: the repayment portfolio (ARAF facilities and verified historical accounts),
 * arrears ageing, monthly collections, performance by location / officer / channel, inventory against the
 * opening count and migration progress.
 *
 * ARAF facilities are positioned live from their schedule and repayments (`facilityPosition`). Historical
 * accounts use the figures held on the account (register evidence plus reconciled repayments), as at their last
 * reconciliation. Exports carry facility references only: no names, BVNs, phone or account numbers.
 */
import type { Db } from "../db";
import { activeRoles, currentSettings, PM_ROLE } from "./core";
import { ageingBucket, facilityPosition, type FacilityPosition, type ScheduleRow } from "@/lib/altphones-repayments";

export const PORTFOLIO_ROLES = [PM_ROLE, "SUPER_ADMIN", "COLLECTIONS_OFFICER", "REPORTING_ADMIN", "EXECUTIVE_VIEW"] as const;

/** Product Manager, Super Admin, Collections, Reporting / Executive view, and the configured Unit Head. */
export async function portfolioAccess(q: Db, staffId: string): Promise<boolean> {
  const roles = await activeRoles(q, staffId);
  if (PORTFOLIO_ROLES.some((r) => roles.has(r))) return true;
  return roles.has("UNIT_HEAD") && (await currentSettings(q)).unit_head_staff_id === staffId;
}

export type Bucket = "CURRENT" | "1" | "2" | "3+" | "FULLY_REPAID" | "CANCELLED" | "UNCONFIRMED";
export const BUCKET_LABEL: Record<Bucket, string> = {
  CURRENT: "Current (no arrears)",
  "1": "1 instalment overdue",
  "2": "2 instalments overdue",
  "3+": "3 or more overdue",
  FULLY_REPAID: "Fully repaid",
  CANCELLED: "Cancelled",
  UNCONFIRMED: "Unconfirmed (pending reconciliation)",
};

export interface PortfolioFacility {
  source: "ARAF" | "HISTORICAL";
  id: string;
  ref: string;
  customer: string | null;
  location: string;
  officer: string;
  channel: string;
  units: number;
  financedKobo: number;
  totalKobo: number;
  repaidKobo: number;
  outstandingKobo: number;
  arrearsKobo: number;
  overdueInstalments: number;
  daysOverdue: number | null;
  bucket: Bucket;
  nextDue: string | null;
}

const CHANNEL: Record<string, string> = { DO: "Delight Officer", SA: "Smile Associate" };

export async function portfolioFacilities(q: Db, today: string): Promise<PortfolioFacility[]> {
  const live = (
    await q.query<{ id: string; ref: string; customer_name: string | null; channel: string; financed_kobo: string | null; location: string | null; officer: string | null }>(
      `SELECT a.id, a.ref, a.customer_name, a.channel, a.financed_kobo::text AS financed_kobo, l.name AS location, s.full_name AS officer
         FROM altphones_applications a LEFT JOIN locations l ON l.id = a.origin_location_id LEFT JOIN staff s ON s.id = a.originator_id
        WHERE a.kind = 'CREDIT' AND a.status = 'DISBURSED' AND NOT a.legacy ORDER BY a.ref`,
    )
  ).rows;
  const sched = new Map<string, ScheduleRow[]>();
  for (const r of (await q.query<{ application_id: string; seq: number; due_date: string; amount_kobo: string }>("SELECT application_id, seq, to_char(due_date,'YYYY-MM-DD') AS due_date, amount_kobo::text FROM altphones_schedule WHERE application_id = ANY($1)", [live.map((x) => x.id)])).rows) {
    const list = sched.get(r.application_id) ?? [];
    list.push({ seq: r.seq, dueDate: r.due_date, amountKobo: Number(r.amount_kobo) });
    sched.set(r.application_id, list);
  }
  const paid = new Map((await q.query<{ application_id: string; s: string }>("SELECT application_id, sum(amount_kobo)::text AS s FROM altphones_repayments WHERE application_id = ANY($1) GROUP BY 1", [live.map((x) => x.id)])).rows.map((r) => [r.application_id, Number(r.s)]));
  const out: PortfolioFacility[] = live.map((a) => {
    const p: FacilityPosition = facilityPosition(sched.get(a.id) ?? [], paid.get(a.id) ?? 0, today);
    return {
      source: "ARAF",
      id: a.id,
      ref: a.ref,
      customer: a.customer_name,
      location: a.location ?? "Not recorded",
      officer: a.officer ?? "Not recorded",
      channel: CHANNEL[a.channel] ?? a.channel,
      units: 1,
      financedKobo: Number(a.financed_kobo ?? 0),
      totalKobo: p.totalKobo,
      repaidKobo: p.repaidKobo,
      outstandingKobo: p.outstandingKobo,
      arrearsKobo: p.arrearsKobo,
      overdueInstalments: p.overdueInstalments,
      daysOverdue: p.daysOverdue,
      bucket: p.status === "FULLY_REPAID" ? "FULLY_REPAID" : ageingBucket(p.overdueInstalments),
      nextDue: p.nextDue?.dueDate ?? null,
    };
  });
  const hist = (
    await q.query<{
      id: string; ref: string; customer_name: string; source_sheet: string; status: string; units: number | null; instalment_kobo: string | null; total_obligation_kobo: string | null;
      amount_repaid_kobo: string; outstanding_kobo: string; arrears_kobo: string; location: string | null; location_label: string | null; officer: string | null; referrer_label: string | null;
    }>(
      `SELECT h.id, h.ref, h.customer_name, h.source_sheet, h.status, h.units, h.instalment_kobo::text, h.total_obligation_kobo::text, h.amount_repaid_kobo::text,
              h.outstanding_kobo::text, h.arrears_kobo::text, l.name AS location, h.location_label, s.full_name AS officer, h.referrer_label
         FROM altphones_historical_accounts h LEFT JOIN locations l ON l.id = h.location_id LEFT JOIN staff s ON s.id = h.officer_id ORDER BY h.ref`,
    )
  ).rows;
  for (const h of hist) {
    const inst = Number(h.instalment_kobo ?? 0);
    const arrears = Number(h.arrears_kobo);
    const overdue = h.status === "IN_ARREARS" && inst > 0 ? Math.max(1, Math.ceil(arrears / inst)) : 0;
    const bucket: Bucket = h.status === "COMPLETED" ? "FULLY_REPAID" : h.status === "CANCELLED" ? "CANCELLED" : h.status === "UNCONFIRMED" ? "UNCONFIRMED" : ageingBucket(overdue);
    out.push({
      source: "HISTORICAL",
      id: h.id,
      ref: h.ref,
      customer: h.customer_name,
      location: h.location ?? h.location_label ?? "Not recorded",
      officer: h.officer ?? h.referrer_label ?? "Not recorded",
      channel: /EXTERNAL/i.test(h.source_sheet) ? "Historical – external" : /INTERNAL/i.test(h.source_sheet) ? "Historical – internal" : `Historical – ${h.source_sheet.toLowerCase()}`,
      units: h.units ?? 1,
      financedKobo: Number(h.total_obligation_kobo ?? 0),
      totalKobo: Number(h.total_obligation_kobo ?? 0),
      repaidKobo: Number(h.amount_repaid_kobo),
      outstandingKobo: h.status === "CANCELLED" ? 0 : Number(h.outstanding_kobo),
      arrearsKobo: h.status === "CANCELLED" ? 0 : arrears,
      overdueInstalments: overdue,
      daysOverdue: null,
      bucket,
      nextDue: null,
    });
  }
  return out;
}

export interface GroupRow {
  key: string;
  facilities: number;
  units: number;
  financedKobo: number;
  outstandingKobo: number;
  arrearsKobo: number;
  inArrears: number;
  fullyRepaid: number;
}

export function groupBy(list: PortfolioFacility[], key: (f: PortfolioFacility) => string): GroupRow[] {
  const m = new Map<string, GroupRow>();
  for (const f of list) {
    if (f.bucket === "CANCELLED") continue;
    const k = key(f);
    const g = m.get(k) ?? { key: k, facilities: 0, units: 0, financedKobo: 0, outstandingKobo: 0, arrearsKobo: 0, inArrears: 0, fullyRepaid: 0 };
    g.facilities++;
    g.units += f.units;
    g.financedKobo += f.financedKobo;
    g.outstandingKobo += f.outstandingKobo;
    g.arrearsKobo += f.arrearsKobo;
    if (f.arrearsKobo > 0) g.inArrears++;
    if (f.bucket === "FULLY_REPAID") g.fullyRepaid++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.facilities - a.facilities || a.key.localeCompare(b.key));
}

export function ageing(list: PortfolioFacility[]) {
  const buckets: Bucket[] = ["CURRENT", "1", "2", "3+", "FULLY_REPAID", "CANCELLED", "UNCONFIRMED"];
  return buckets.map((b) => {
    const rows = list.filter((f) => f.bucket === b);
    const of = (s: PortfolioFacility["source"]) => rows.filter((f) => f.source === s);
    return {
      bucket: b,
      label: BUCKET_LABEL[b],
      araf: of("ARAF").length,
      historical: of("HISTORICAL").length,
      total: rows.length,
      outstandingKobo: rows.reduce((s, f) => s + f.outstandingKobo, 0),
      arrearsKobo: rows.reduce((s, f) => s + f.arrearsKobo, 0),
    };
  });
}

export interface CollectionMonth {
  month: string; // YYYY-MM
  expectedKobo: number;
  collectedKobo: number;
  rate: number | null;
}

/**
 * Expected against collected, per calendar month (last `months` months including the current one).
 * ARAF: instalments due in the month against repayments received in it (reversals deducted).
 * Historical: each account's instalment for every month of its term, against reconciled repayments and the
 * months the register marks as paid.
 */
export async function collections(q: Db, today: string, months = 12): Promise<CollectionMonth[]> {
  const r = await q.query<{ m: string; expected: string; collected: string }>(
    `WITH months AS (SELECT to_char(d, 'YYYY-MM') AS m, d::date AS d FROM generate_series(date_trunc('month', $1::date) - make_interval(months => $2 - 1), date_trunc('month', $1::date), interval '1 month') d),
          live_exp AS (SELECT to_char(s.due_date, 'YYYY-MM') AS m, sum(s.amount_kobo) AS v FROM altphones_schedule s JOIN altphones_applications a ON a.id = s.application_id
                        WHERE a.kind = 'CREDIT' AND a.status = 'DISBURSED' AND NOT a.legacy GROUP BY 1),
          live_col AS (SELECT to_char(paid_on, 'YYYY-MM') AS m, sum(amount_kobo) AS v FROM altphones_repayments GROUP BY 1),
          hist_exp AS (SELECT to_char(g, 'YYYY-MM') AS m, sum(h.instalment_kobo) AS v
                         FROM altphones_historical_accounts h, generate_series(date_trunc('month', h.start_date), date_trunc('month', h.start_date) + make_interval(months => h.tenor_months - 1), interval '1 month') g
                        WHERE h.status <> 'CANCELLED' AND h.start_date IS NOT NULL AND h.tenor_months > 0 AND h.instalment_kobo IS NOT NULL GROUP BY 1),
          hist_col AS (SELECT to_char(paid_on, 'YYYY-MM') AS m, sum(amount_kobo) AS v FROM altphones_historical_repayments GROUP BY 1),
          hist_reg AS (SELECT to_char(i.month, 'YYYY-MM') AS m, sum(h.instalment_kobo) AS v FROM altphones_historical_instalments i JOIN altphones_historical_accounts h ON h.id = i.account_id
                        WHERE i.status = 'PAID' AND i.source = 'REGISTER' AND h.instalment_kobo IS NOT NULL GROUP BY 1)
     SELECT months.m,
            (coalesce(le.v,0) + coalesce(he.v,0))::text AS expected,
            (coalesce(lc.v,0) + coalesce(hc.v,0) + coalesce(hr.v,0))::text AS collected
       FROM months LEFT JOIN live_exp le ON le.m = months.m LEFT JOIN live_col lc ON lc.m = months.m
            LEFT JOIN hist_exp he ON he.m = months.m LEFT JOIN hist_col hc ON hc.m = months.m LEFT JOIN hist_reg hr ON hr.m = months.m
      ORDER BY months.m`,
    [today, months],
  );
  return r.rows.map((x) => {
    const e = Number(x.expected);
    const c = Number(x.collected);
    return { month: x.m, expectedKobo: e, collectedKobo: c, rate: e > 0 ? Math.round((c / e) * 1000) / 10 : null };
  });
}

export interface InventoryRow {
  location: string;
  state: string;
  type: string;
  opening: number;
  received: number;
  issued: number;
  adjusted: number;
  physical: number;
  reserved: number;
}

/** Stock by location against the opening count: opening + received − issued ± adjustments = on hand. */
export async function inventoryAgainstOpening(q: Db): Promise<InventoryRow[]> {
  return (
    await q.query<{ location: string; state: string; type: string; opening: string; received: string; issued: string; adjusted: string; physical: string; reserved: string }>(
      `SELECT l.name AS location, l.state, l.outlet_type AS type,
              coalesce(sum(g.physical_delta) FILTER (WHERE g.movement = 'OPENING'),0)::text AS opening,
              coalesce(sum(g.physical_delta) FILTER (WHERE g.movement = 'RECEIPT'),0)::text AS received,
              coalesce(-sum(g.physical_delta) FILTER (WHERE g.movement IN ('SALE','DISBURSEMENT')),0)::text AS issued,
              coalesce(sum(g.physical_delta) FILTER (WHERE g.movement NOT IN ('OPENING','RECEIPT','SALE','DISBURSEMENT','RESERVE','RELEASE')),0)::text AS adjusted,
              coalesce((SELECT sum(physical) FROM altphones_stock s WHERE s.location_id = l.id),0)::text AS physical,
              coalesce((SELECT sum(reserved) FROM altphones_stock s WHERE s.location_id = l.id),0)::text AS reserved
         FROM locations l LEFT JOIN altphones_stock_ledger g ON g.location_id = l.id
        WHERE l.outlet_type IN ('BRANCH','ALTSHOP','ALTBOX') AND (l.active OR EXISTS (SELECT 1 FROM altphones_stock_ledger x WHERE x.location_id = l.id))
        GROUP BY l.id, l.name, l.state, l.outlet_type ORDER BY l.state, l.name`,
    )
  ).rows.map((r) => ({ ...r, opening: Number(r.opening), received: Number(r.received), issued: Number(r.issued), adjusted: Number(r.adjusted), physical: Number(r.physical), reserved: Number(r.reserved) }));
}

export async function migrationProgress(q: Db) {
  const batches = (await q.query<{ status: string; n: string }>("SELECT status, count(*)::text AS n FROM altphones_migration_batches GROUP BY 1 ORDER BY 1")).rows.map((r) => ({ status: r.status, n: Number(r.n) }));
  const records = (
    await q.query<{ pending: string; total: string; published: string }>(
      `SELECT count(*) FILTER (WHERE b.status NOT IN ('PUBLISHED','DISCARDED','REJECTED'))::text AS pending, count(*)::text AS total,
              (SELECT count(*) FROM altphones_historical_accounts)::text AS published
         FROM altphones_migration_records r JOIN altphones_migration_batches b ON b.id = r.batch_id`,
    )
  ).rows[0];
  return { batches, pendingRecords: Number(records.pending), totalRecords: Number(records.total), publishedAccounts: Number(records.published) };
}
