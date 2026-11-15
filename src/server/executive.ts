/**
 * Institution-wide (God's Eye) and Altphones operations reporting. Read-only: every figure is a direct
 * aggregate of ARAF's own records, labelled where it is "per ARAF records" (core banking is not connected).
 * Customer identifiers are never returned here.
 */
import type { Db } from "./db";
import { activeRoles } from "./domain/access";

export const EXECUTIVE_ROLES = ["EXECUTIVE_VIEW", "SUPER_ADMIN", "DIVISIONAL_HEAD"] as const;

export async function executiveAccess(q: Db, staffId: string): Promise<boolean> {
  const roles = (await activeRoles(q, staffId)).map((r) => r.role);
  return roles.some((r) => (EXECUTIVE_ROLES as readonly string[]).includes(r));
}

const num = (v: unknown) => Number(v ?? 0);

export async function executiveOverview(q: Db, now: Date) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const one = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await q.query<T>(sql, args)).rows[0];
  const many = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await q.query<T>(sql, args)).rows;

  const requests = await one<{ all_n: string; all_v: string; m_n: string; m_v: string }>(
    `SELECT count(*) FILTER (WHERE submitted_at IS NOT NULL)::text AS all_n, coalesce(sum(requested_amount_kobo) FILTER (WHERE submitted_at IS NOT NULL),0)::text AS all_v,
            count(*) FILTER (WHERE submitted_at >= $1)::text AS m_n, coalesce(sum(requested_amount_kobo) FILTER (WHERE submitted_at >= $1),0)::text AS m_v FROM applications`,
    [since],
  );
  const approvals = await one<{ all_n: string; m_n: string }>(
    `SELECT count(DISTINCT application_id)::text AS all_n, count(DISTINCT application_id) FILTER (WHERE created_at >= $1)::text AS m_n
       FROM decisions WHERE action = 'APPROVE' AND stage IN ('DIVISIONAL_HEAD_REVIEW','UNIT_HEAD_REVIEW','HEAD_OF_UNIT_APPROVAL') AND invalidated_at IS NULL`,
    [since],
  );
  const bookings = await one<{ n: string; v: string; m_n: string }>(`SELECT count(*)::text AS n, coalesce(sum(principal_kobo),0)::text AS v, count(*) FILTER (WHERE booked_at >= $1)::text AS m_n FROM facilities`, [since]);
  const disb = await one<{ n: string; v: string; m_n: string; m_v: string }>(
    `SELECT count(*)::text AS n, coalesce(sum(amount_kobo),0)::text AS v, count(*) FILTER (WHERE disbursed_on >= $1::date)::text AS m_n, coalesce(sum(amount_kobo) FILTER (WHERE disbursed_on >= $1::date),0)::text AS m_v FROM disbursements`,
    [since],
  );
  const repay = await one<{ retail: string; hist: string }>(
    `SELECT (SELECT coalesce(sum(CASE event_type WHEN 'RECEIVED' THEN amount_kobo ELSE -amount_kobo END),0) FROM repayment_events)::text AS retail,
            (SELECT coalesce(sum(amount_repaid_kobo),0) FROM altphones_historical_accounts)::text AS hist`,
  );
  const outstanding = await one<{ n: string; v: string }>(
    `SELECT count(*)::text AS n, coalesce(sum(f.total_payable_kobo - coalesce(p.paid,0)),0)::text AS v
       FROM facilities f LEFT JOIN (SELECT facility_id, sum(CASE event_type WHEN 'RECEIVED' THEN amount_kobo ELSE -amount_kobo END) AS paid FROM repayment_events GROUP BY 1) p ON p.facility_id = f.id
      WHERE f.status IN ('ACTIVE','IN_ARREARS','RESTRUCTURED')`,
  );
  const histOutstanding = await one<{ n: string; v: string }>(`SELECT count(*) FILTER (WHERE outstanding_kobo > 0)::text AS n, coalesce(sum(outstanding_kobo),0)::text AS v FROM altphones_historical_accounts WHERE status <> 'CANCELLED'`);
  const queues = await many<{ stage: string; n: string; unassigned: string; oldest: Date }>(
    `SELECT stage, count(*)::text AS n, count(*) FILTER (WHERE assignee_id IS NULL)::text AS unassigned, min(entered_at) AS oldest FROM tasks WHERE status = 'OPEN' GROUP BY stage ORDER BY count(*) DESC`,
  );
  const altQueues = await many<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM altphones_applications WHERE status IN ('UNDER_BPM_REVIEW','UNDER_PM_REVIEW','UNDER_UNIT_HEAD_REVIEW','APPROVED') AND NOT legacy GROUP BY status`,
  );
  const productivity = await many<{ name: string; submitted: string; decisions: string; alt_sales: string }>(
    `WITH s AS (SELECT initiator_id AS id, count(*) AS n FROM applications WHERE submitted_at >= $1 GROUP BY 1),
          d AS (SELECT actor_id AS id, count(*) AS n FROM decisions WHERE created_at >= $1 GROUP BY 1),
          a AS (SELECT originator_id AS id, count(*) AS n FROM altphones_applications WHERE submitted_at >= $1 AND NOT legacy GROUP BY 1)
     SELECT st.full_name AS name, coalesce(s.n,0)::text AS submitted, coalesce(d.n,0)::text AS decisions, coalesce(a.n,0)::text AS alt_sales
       FROM staff st LEFT JOIN s ON s.id = st.id LEFT JOIN d ON d.id = st.id LEFT JOIN a ON a.id = st.id
      WHERE coalesce(s.n,0) + coalesce(d.n,0) + coalesce(a.n,0) > 0 ORDER BY coalesce(s.n,0) + coalesce(d.n,0) + coalesce(a.n,0) DESC LIMIT 25`,
    [since],
  );
  const bpm = await many<{ name: string; decided: string; approved: string; returned: string; rejected: string; waiting: string; avg_hours: string | null }>(
    `SELECT s.full_name AS name,
            count(r.id)::text AS decided, count(r.id) FILTER (WHERE r.action = 'APPROVE')::text AS approved,
            count(r.id) FILTER (WHERE r.action = 'RETURN')::text AS returned, count(r.id) FILTER (WHERE r.action = 'REJECT')::text AS rejected,
            (SELECT count(*) FROM altphones_applications a WHERE a.routed_bpm_id = s.id AND a.status = 'UNDER_BPM_REVIEW')::text AS waiting,
            round(avg(extract(epoch FROM (r.decided_at - a.submitted_at)) / 3600)::numeric, 1)::text AS avg_hours
       FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
       LEFT JOIN altphones_reviews r ON r.actor_id = s.id AND r.stage = 'BPM'
       LEFT JOIN altphones_applications a ON a.id = r.application_id
      WHERE ra.role = 'BUSINESS_PERFORMANCE_MANAGER' AND ra.active GROUP BY s.id, s.full_name ORDER BY count(r.id) DESC, s.full_name`,
  );
  const locations = await many<{ name: string; state: string; type: string; alt_sales: string; alt_completed: string; retail: string; physical: string; reserved: string }>(
    `SELECT l.name, l.state, l.outlet_type AS type,
            (SELECT count(*) FROM altphones_applications a WHERE a.origin_location_id = l.id AND a.submitted_at IS NOT NULL AND NOT a.legacy)::text AS alt_sales,
            (SELECT count(*) FROM altphones_applications a WHERE a.origin_location_id = l.id AND a.status IN ('COMPLETED','DISBURSED') AND NOT a.legacy)::text AS alt_completed,
            (SELECT count(*) FROM applications a WHERE coalesce(a.origination_location_id, a.outlet_location_id) = l.id AND a.submitted_at IS NOT NULL)::text AS retail,
            coalesce((SELECT sum(physical) FROM altphones_stock s WHERE s.location_id = l.id),0)::text AS physical,
            coalesce((SELECT sum(reserved) FROM altphones_stock s WHERE s.location_id = l.id),0)::text AS reserved
       FROM locations l WHERE l.active ORDER BY 4 DESC, 6 DESC, l.name LIMIT 40`,
  );
  const stock = await one<{ physical: string; reserved: string; issued30: string; locations: string; empty: string }>(
    `SELECT coalesce(sum(physical),0)::text AS physical, coalesce(sum(reserved),0)::text AS reserved,
            (SELECT count(*) FROM altphones_stock_ledger WHERE movement IN ('SALE','DISBURSEMENT') AND occurred_at >= $1)::text AS issued30,
            (SELECT count(*) FROM locations WHERE active AND outlet_type IN ('BRANCH','ALTSHOP'))::text AS locations,
            (SELECT count(*) FROM locations l WHERE l.active AND l.outlet_type IN ('BRANCH','ALTSHOP') AND NOT EXISTS (SELECT 1 FROM altphones_stock s WHERE s.location_id = l.id AND s.physical > 0))::text AS empty
       FROM altphones_stock`,
    [since],
  );
  const migration = await many<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM altphones_migration_batches GROUP BY status`);
  const historical = await many<{ repayment_status: string | null; n: string }>(`SELECT repayment_status, count(*)::text AS n FROM altphones_historical_accounts GROUP BY 1 ORDER BY 1`);
  const kyc = await many<{ ref: string; application_id: string; team_lead: string; reason: string; decided_at: Date }>(
    `SELECT a.ref, a.id AS application_id, s.full_name AS team_lead, r.skip_reason AS reason, r.decided_at
       FROM vf_photo_reviews r JOIN applications a ON a.id = r.application_id JOIN staff s ON s.id = r.decided_by
      WHERE r.decision = 'SKIPPED' ORDER BY r.decided_at DESC LIMIT 50`,
  );
  return {
    asOf: now,
    requests: { all: num(requests.all_n), allKobo: num(requests.all_v), last30: num(requests.m_n), last30Kobo: num(requests.m_v) },
    approvals: { all: num(approvals.all_n), last30: num(approvals.m_n) },
    bookings: { all: num(bookings.n), principalKobo: num(bookings.v), last30: num(bookings.m_n) },
    disbursements: { all: num(disb.n), kobo: num(disb.v), last30: num(disb.m_n), last30Kobo: num(disb.m_v) },
    repayments: { retailKobo: num(repay.retail), historicalKobo: num(repay.hist) },
    outstanding: { facilities: num(outstanding.n), kobo: num(outstanding.v), historicalAccounts: num(histOutstanding.n), historicalKobo: num(histOutstanding.v) },
    queues,
    altQueues,
    productivity,
    bpm,
    locations,
    stock: { physical: num(stock.physical), reserved: num(stock.reserved), issued30: num(stock.issued30), locations: num(stock.locations), empty: num(stock.empty) },
    migration,
    historical,
    kyc,
  };
}

/** Altphones operations for the Product Manager and the Unit Head. */
export async function altphonesOperations(q: Db, now: Date) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const many = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await q.query<T>(sql, args)).rows;
  const one = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await q.query<T>(sql, args)).rows[0];
  const byStatus = await many<{ status: string; kind: string; n: string }>(`SELECT status, kind, count(*)::text AS n FROM altphones_applications WHERE NOT legacy GROUP BY 1,2 ORDER BY 1,2`);
  const originated30 = await one<{ n: string }>(`SELECT count(*)::text AS n FROM altphones_applications WHERE submitted_at >= $1 AND NOT legacy`, [since]);
  const turnaround = await many<{ stage: string; n: string; avg_hours: string | null }>(
    `SELECT r.stage, count(*)::text AS n, round(avg(extract(epoch FROM (r.decided_at - prev.at)) / 3600)::numeric, 1)::text AS avg_hours
       FROM altphones_reviews r
       JOIN LATERAL (SELECT coalesce((SELECT max(r2.decided_at) FROM altphones_reviews r2 WHERE r2.application_id = r.application_id AND r2.decided_at < r.decided_at), a.submitted_at) AS at
                       FROM altphones_applications a WHERE a.id = r.application_id) prev ON true
      WHERE r.decided_at >= $1 GROUP BY r.stage ORDER BY array_position(ARRAY['BPM','PM','UNIT_HEAD'], r.stage)`,
    [since],
  );
  const pending = await one<{ locations: string; addresses: string; bpm: string; status: string; imports: string; movements: string; counts: string }>(
    `SELECT (SELECT count(*) FROM altphones_address_requests WHERE status = 'PENDING' AND basis = 'NEW_LOCATION')::text AS locations,
            (SELECT count(*) FROM altphones_address_requests WHERE status = 'PENDING' AND basis <> 'NEW_LOCATION')::text AS addresses,
            (SELECT count(*) FROM altphones_bpm_requests WHERE status = 'PENDING')::text AS bpm,
            (SELECT count(*) FROM altphones_location_status_requests WHERE status = 'PENDING')::text AS status,
            (SELECT count(*) FROM altphones_imports WHERE status = 'SUBMITTED')::text AS imports,
            (SELECT count(*) FROM altphones_stock_movements WHERE status = 'PENDING')::text AS movements,
            (SELECT count(*) FROM altphones_stock_counts WHERE status = 'SUBMITTED')::text AS counts`,
  );
  const exceptions = await one<{ placeholder: string; unrouted: string; noAddress: string; returned: string; importErrors: string }>(
    `SELECT (SELECT count(*) FROM altphones_applications WHERE routed_to_placeholder AND status = 'UNDER_BPM_REVIEW')::text AS placeholder,
            (SELECT count(*) FROM locations l WHERE l.active AND l.outlet_type IN ('ALTSHOP','ALTBOX') AND NOT EXISTS (SELECT 1 FROM altphones_bpm_locations b WHERE b.location_id = l.id) AND NOT EXISTS (SELECT 1 FROM altphones_bpm_states s WHERE s.state = l.state))::text AS unrouted,
            (SELECT count(*) FROM locations WHERE address_status <> 'REGISTERED')::text AS "noAddress",
            (SELECT count(*) FROM altphones_address_requests WHERE status = 'RETURNED')::text AS returned,
            (SELECT count(*) FROM altphones_imports WHERE status IN ('PREVIEW','SUBMITTED') AND jsonb_array_length(errors) > 0)::text AS "importErrors"`,
  );
  const discrepancies = await many<{ ref: string; location: string; variance: string; submitted_at: Date }>(
    `SELECT c.ref, l.name AS location, sum(cl.counted - cl.system_at_submit)::text AS variance, c.submitted_at
       FROM altphones_stock_counts c JOIN locations l ON l.id = c.location_id JOIN altphones_stock_count_lines cl ON cl.count_id = c.id
      WHERE c.status = 'SUBMITTED' GROUP BY c.id, c.ref, l.name, c.submitted_at HAVING sum(cl.counted - cl.system_at_submit) <> 0 ORDER BY c.submitted_at`,
  );
  const stockByLocation = await many<{ name: string; state: string; physical: string; reserved: string }>(
    `SELECT l.name, l.state, coalesce(sum(s.physical),0)::text AS physical, coalesce(sum(s.reserved),0)::text AS reserved
       FROM locations l JOIN altphones_stock s ON s.location_id = l.id GROUP BY l.id, l.name, l.state ORDER BY sum(s.physical) DESC, l.name LIMIT 30`,
  );
  const issued30 = await one<{ n: string }>(`SELECT count(*)::text AS n FROM altphones_stock_ledger WHERE movement IN ('SALE','DISBURSEMENT') AND occurred_at >= $1`, [since]);
  const vf = await one<{ inflight: string; skips: string; skips30: string }>(
    `SELECT (SELECT count(*) FROM applications WHERE product_code = 'VENDOR_FINANCING' AND status = 'IN_PROGRESS')::text AS inflight,
            (SELECT count(*) FROM vf_photo_reviews WHERE decision = 'SKIPPED')::text AS skips,
            (SELECT count(*) FROM vf_photo_reviews WHERE decision = 'SKIPPED' AND decided_at >= $1)::text AS skips30`,
    [since],
  );
  return { byStatus, originated30: num(originated30.n), turnaround, pending, exceptions, discrepancies, stockByLocation, issued30: num(issued30.n), vf };
}
