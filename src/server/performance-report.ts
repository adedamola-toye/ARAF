/**
 * Management performance reporting with drill-down in any order (Unit Head, product, officer, location,
 * facility …). One fact row per facility (WakeelBoost and retail) or per AltPhones transaction, attributed to
 * the person who originated it and, separately, to the people who acted on it. Scope is enforced here, on the
 * server: God's Eye, Super Admin and Reporting Admin see everything; a Divisional Head sees the units of the
 * Unit Heads who report to them; a Unit Head sees the staff who report to them (reporting lines). Customer
 * identifiers are never returned.
 */
import type { Db } from "./db";
import { activeRoles } from "./domain/access";
import { supervision } from "./domain/org";
import { STAGE_LABELS, type Stage } from "./domain/stages";

export const REPORT_ROLES = ["EXECUTIVE_VIEW", "SUPER_ADMIN", "REPORTING_ADMIN", "DIVISIONAL_HEAD", "UNIT_HEAD", "RBE", "MERCHANT_OFFICER_HEAD"] as const;

export type Scope =
  | { kind: "ALL" }
  | { kind: "STAFF"; staffIds: string[]; teams?: string[]; regions?: string[]; viewerId?: string; label: string }
  | { kind: "NONE"; reason: string };

/**
 * What the viewer may see. Uses the same supervision rule as case access (domain/org.ts), so every facility in a
 * viewer's report can be opened by them.
 */
export async function reportScope(q: Db, staffId: string): Promise<Scope> {
  const roles = (await activeRoles(q, staffId)).map((r) => r.role);
  if (roles.some((r) => ["EXECUTIVE_VIEW", "SUPER_ADMIN", "REPORTING_ADMIN"].includes(r))) return { kind: "ALL" };
  if (!["DIVISIONAL_HEAD", "UNIT_HEAD", "RBE", "MERCHANT_OFFICER_HEAD"].some((r) => roles.includes(r as never)))
    return { kind: "NONE", reason: "Reports are available to God's Eye, Super Admin, Reporting Admin, Divisional Heads, Unit Heads, Regional Business Executives and the Merchant Officer Head." };
  // Always includes every request the viewer reviewed or approved (or is the designated RBE / Unit Head for), so it
  // works with no setup; reporting lines, where set, add the requests of the people who report to them.
  const sv = await supervision(q, staffId);
  return { kind: "STAFF", staffIds: sv.staffIds, teams: sv.teams, regions: sv.regions, viewerId: staffId, label: sv.label || "requests you reviewed or approved, and your team" };
}

// ─────────────────────────── financing facts ───────────────────────────

export const FIN_DIMENSIONS = {
  segment: "Business line",
  businessUnit: "Business unit",
  region: "Region",
  reportingHead: "Reporting head",
  rbe: "RBE",
  division: "Divisional Head",
  unitHead: "Unit Head",
  product: "Product",
  category: "Customer category",
  officer: "Originating officer",
  moLead: "Merchant Officer Lead",
  moHead: "Merchant Officer Head",
  location: "Location",
  status: "Status",
  facility: "Facility",
} as const;
export type FinDim = keyof typeof FIN_DIMENSIONS;
export const DEFAULT_ORDER: FinDim[] = ["unitHead", "product", "officer", "location", "facility"];

export interface FinFact {
  id: string;
  ref: string;
  officerId: string;
  /** DBC, Non-DBC, Merchant Officer line, RM (unclassified) or Other channels. */
  segment: string;
  businessUnit: string;
  region: string;
  /** The approver the originator reports into for this request: RBE (Non-DBC), DBC Unit Head, MO Head or Unit Head. */
  reportingHead: string;
  rbe: string;
  approvedAt: Date | null;
  disbursedAt: Date | null;
  declinedAt: Date | null;
  division: string;
  unitHead: string;
  product: string;
  category: string;
  officer: string;
  officerRole: string;
  moLead: string;
  moHead: string;
  location: string;
  status: string;
  facility: string;
  stage: string;
  submittedAt: Date | null;
  requestedKobo: number;
  approved: boolean;
  approvedKobo: number;
  disbursed: boolean;
  disbursedKobo: number;
  completed: boolean;
  declined: boolean;
  pending: boolean;
  turnaroundHours: number | null;
  slaBreaches: number;
  invoicePending: boolean;
  invoiceCompleted: boolean;
  creditException: boolean;
  awaitingRmConfirmation: boolean;
  missingEvidence: boolean;
}

export interface FinFilters {
  from?: string | null; // YYYY-MM-DD (submitted)
  to?: string | null;
  product?: string | null;
  category?: string | null;
  status?: string | null;
  creditException?: "yes" | "no" | null;
  invoice?: "pending" | "completed" | null;
  sla?: "breached" | null;
  disbursed?: "yes" | "no" | null;
  /** Exact-match filters on any reporting dimension (business line, RBE, Unit Head, officer, location …). */
  dims?: Partial<Record<FinDim, string>>;
}

const CATEGORY: Record<string, string> = { BUSINESS_OWNER: "Business", SALARY_EARNER: "Salaried" };
const POST_APPROVAL = ["OFFER_PREPARATION", "CO3_PACK_REVIEW", "DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION", "DISBURSEMENT_BOOKING", "PAYMENT_RECONCILIATION", "COMPLETION", "FULFILMENT", "VENDOR_CONFIRMATION", "COMPLETED", "CLOSED"];

/**
 * Only a real calendar date in YYYY-MM-DD form is used as a bound; a malformed or missing value means "no bound".
 * Query strings are user input, so they must never reach PostgreSQL's date cast unchecked.
 */
export function dateBound(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

export async function financingFacts(q: Db, scope: Scope, f: FinFilters = {}): Promise<FinFact[]> {
  if (scope.kind === "NONE") return [];
  const from = dateBound(f.from);
  const to = dateBound(f.to);
  const rows = (
    await q.query(
      `WITH apps AS (
         SELECT a.* FROM applications a
          WHERE a.submitted_at IS NOT NULL
            AND ($1::uuid[] IS NULL OR a.initiator_id = ANY($1) OR a.assigned_rm_id = ANY($1) OR a.team = ANY($4::text[]) OR a.region = ANY($5::text[]) OR a.initiator_id IN (SELECT id FROM staff WHERE region = ANY($5::text[])) OR a.routing_unit_head_id = $6 OR a.selected_rbe_id = $6
                 OR EXISTS (SELECT 1 FROM decisions d WHERE d.application_id = a.id AND d.actor_id = $6))
            AND ($2::date IS NULL OR a.submitted_at >= $2::date)
            AND ($3::date IS NULL OR a.submitted_at < ($3::date + 1))
       )
       SELECT a.id, a.ref, a.initiator_id, a.stage, a.status, a.product_code, coalesce(a.product_label, 'WakeelBoost') AS product, a.customer_profile, a.initiator_role,
              a.submitted_at, coalesce(a.requested_amount_kobo, 0) AS requested,
              o.full_name AS officer, uh.full_name AS unit_head, dh.full_name AS division,
              CASE WHEN a.initiator_role = 'MERCHANT_OFFICER' THEN en.full_name WHEN a.initiator_role = 'MERCHANT_OFFICER_LEAD' THEN o.full_name END AS mo_lead,
              mh.full_name AS mo_head,
              coalesce(lo.name, ou.name, a.region) AS location,
              o.business_unit AS staff_unit, o.region AS staff_region,
              coalesce(a.routing_segment, rc.segment) AS segment, rc.dbc_region, rc.business_unit AS rm_unit,
              CASE WHEN coalesce(a.routing_segment, rc.segment) = 'NON_DBC' THEN coalesce(CASE WHEN a.routing_segment = 'NON_DBC' THEN sr.full_name END, cr.full_name) END AS rbe,
              rh.full_name AS routing_head, ds.disbursed_on, a.rejected_at,
              (SELECT max(d.created_at) FROM decisions d WHERE d.application_id = a.id AND d.invalidated_at IS NULL AND d.action IN ('APPROVE','PROCEED')
                  AND d.stage IN ('DIVISIONAL_HEAD_REVIEW','UNIT_HEAD_REVIEW')) AS approved_at,
              (SELECT coalesce((ra.inputs->>'principalKobo')::bigint, NULL) FROM retail_assessments ra WHERE ra.application_id = a.id AND ra.kind = 'FINAL' AND ra.superseded_at IS NULL ORDER BY ra.created_at DESC LIMIT 1) AS approved_principal,
              ds.amount_kobo AS disbursed_kobo,
              (SELECT count(DISTINCT (s.task_key, s.assigned_at)) FROM sla_reminders s JOIN tasks t ON t.id::text = split_part(s.task_key, '#', 1) WHERE t.application_id = a.id) AS sla_breaches,
              (SELECT ic.status FROM invoice_confirmations ic WHERE ic.application_id = a.id ORDER BY ic.created_at DESC LIMIT 1) AS invoice_status,
              EXISTS (SELECT 1 FROM credit_exceptions ce WHERE ce.application_id = a.id AND ce.status <> 'SUPERSEDED') AS credit_exception,
              EXISTS (SELECT 1 FROM documents dd WHERE dd.application_id = a.id AND dd.category = 'FULFILMENT_EVIDENCE' AND dd.scan_status = 'CLEAN' AND dd.superseded_at IS NULL) AS has_evidence
         FROM apps a
         JOIN staff o ON o.id = a.initiator_id
         LEFT JOIN org_links lu ON lu.staff_id = a.initiator_id AND lu.relation = 'UNIT_HEAD'
         LEFT JOIN staff uh ON uh.id = lu.manager_id
         LEFT JOIN org_links ld ON ld.staff_id = lu.manager_id AND ld.relation = 'DIVISIONAL_HEAD'
         LEFT JOIN staff dh ON dh.id = ld.manager_id
         LEFT JOIN staff en ON en.id = a.endorser_id
         LEFT JOIN staff mh ON mh.id = a.mo_head_id
         LEFT JOIN locations lo ON lo.id = a.origination_location_id
         LEFT JOIN locations ou ON ou.id = a.outlet_location_id
         LEFT JOIN disbursements ds ON ds.application_id = a.id
         LEFT JOIN rm_classifications rc ON rc.staff_id = a.initiator_id AND a.initiator_role = 'RM'
         LEFT JOIN org_links lr ON lr.staff_id = a.initiator_id AND lr.relation = 'RBE'
         LEFT JOIN staff cr ON cr.id = lr.manager_id
         LEFT JOIN staff sr ON sr.id = a.selected_rbe_id
         LEFT JOIN staff rh ON rh.id = a.routing_unit_head_id`,
      [scope.kind === "STAFF" ? scope.staffIds : null, from, to, scope.kind === "STAFF" ? (scope.teams ?? []) : [], scope.kind === "STAFF" ? (scope.regions ?? []) : [], scope.kind === "STAFF" ? (scope.viewerId ?? null) : null],
    )
  ).rows;
  const facts: FinFact[] = rows.map((r) => {
    const approved = POST_APPROVAL.includes(r.stage) || !!r.approved_at;
    const disbursed = r.disbursed_kobo !== null;
    const completed = ["COMPLETED", "CLOSED"].includes(r.stage);
    const declined = r.stage === "REJECTED";
    const awaiting = r.stage === "FULFILMENT" || r.stage === "VENDOR_CONFIRMATION";
    const mo = ["MERCHANT_OFFICER", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD"].includes(r.initiator_role);
    const segment = mo ? "Merchant Officer line" : r.segment === "DBC" ? "DBC" : r.segment === "NON_DBC" ? "Non-DBC" : r.initiator_role === "RM" ? "RM (unclassified)" : "Other channels";
    const reportingHead = segment === "Non-DBC" ? r.rbe : segment === "DBC" ? r.routing_head : mo ? (r.mo_head ?? (r.initiator_role === "MERCHANT_OFFICER_HEAD" ? r.officer : null)) : r.unit_head;
    return {
      id: r.id,
      ref: r.ref,
      officerId: r.initiator_id,
      segment,
      businessUnit: r.rm_unit ?? r.staff_unit ?? "Not set",
      region: r.dbc_region ? `DBC ${r.dbc_region === "NORTH" ? "North" : "South & West"}` : (r.staff_region ?? "Not set"),
      reportingHead: reportingHead ?? "Not mapped",
      rbe: r.rbe ?? "—",
      approvedAt: r.approved_at ?? null,
      declinedAt: r.rejected_at ?? null,
      disbursedAt: r.disbursed_on ? new Date(`${r.disbursed_on instanceof Date ? r.disbursed_on.toISOString().slice(0, 10) : r.disbursed_on}T12:00:00Z`) : null,
      division: r.division ?? "Not mapped",
      unitHead: r.unit_head ?? "Not mapped",
      product: r.product,
      category: CATEGORY[r.customer_profile] ?? (r.product_code ? "—" : "Business"),
      officer: r.officer,
      officerRole: r.initiator_role,
      moLead: r.mo_lead ?? "—",
      moHead: r.mo_head ?? "—",
      location: r.location ?? "—",
      status: STAGE_LABELS[r.stage as Stage] ?? r.stage,
      facility: r.ref,
      stage: r.stage,
      submittedAt: r.submitted_at,
      requestedKobo: Number(r.requested),
      approved,
      approvedKobo: approved ? Number(r.approved_principal ?? r.requested) : 0,
      disbursed,
      disbursedKobo: disbursed ? Number(r.disbursed_kobo) : 0,
      completed,
      declined,
      pending: !completed && !declined && !["WITHDRAWN", "EXPIRED"].includes(r.stage),
      turnaroundHours: r.approved_at && r.submitted_at ? (new Date(r.approved_at).getTime() - new Date(r.submitted_at).getTime()) / 3_600_000 : null,
      slaBreaches: Number(r.sla_breaches ?? 0),
      invoicePending: ["PENDING", "PENDING_DISPATCH", "DISPATCH_FAILED", "RETURNED"].includes(r.invoice_status),
      invoiceCompleted: r.invoice_status === "COMPLETED",
      creditException: !!r.credit_exception,
      awaitingRmConfirmation: awaiting,
      missingEvidence: awaiting && !r.has_evidence,
    };
  });
  return facts.filter(
    (x) =>
      (!f.product || x.product === f.product) &&
      (!f.category || x.category === f.category) &&
      (!f.status || x.status === f.status) &&
      (!f.creditException || (f.creditException === "yes") === x.creditException) &&
      (!f.invoice || (f.invoice === "pending" ? x.invoicePending : x.invoiceCompleted)) &&
      (!f.sla || x.slaBreaches > 0) &&
      (!f.disbursed || (f.disbursed === "yes") === x.disbursed) &&
      Object.entries(f.dims ?? {}).every(([d, v]) => !v || String(x[d as FinDim]) === v),
  );
}

// ─────────────────────────── overview: trend and officer table ───────────────────────────

export interface TrendPoint {
  label: string;
  start: string;
  requestedKobo: number;
  approvedKobo: number;
  disbursedKobo: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Daily buckets up to a month, weekly up to six months, monthly otherwise. Each amount is dated by its own event. */
export function trend(facts: FinFact[], from?: string | null, to?: string | null): { grain: "day" | "week" | "month"; points: TrendPoint[] } {
  const fromBound = dateBound(from);
  const toBound = dateBound(to);
  const dates = facts.flatMap((x) => [x.submittedAt, x.approvedAt, x.disbursedAt]).filter((d): d is Date => !!d).map((d) => new Date(d));
  const end = toBound ? new Date(`${toBound}T23:59:59Z`) : new Date(Math.max(Date.now(), ...dates.map((d) => d.getTime())));
  const start = fromBound ? new Date(`${fromBound}T00:00:00Z`) : dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : new Date(end.getTime() - 180 * 86_400_000);
  const span = end.getTime() - start.getTime();
  const grain = span <= 31 * 86_400_000 ? "day" : span <= 182 * 86_400_000 ? "week" : "month";
  const bucketOf = (d: Date) => {
    if (grain === "month") return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    if (grain === "day") return ymd(d);
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); // Monday
    return ymd(x);
  };
  const keys: string[] = [];
  for (let k = bucketOf(start); k <= bucketOf(end); ) {
    keys.push(k);
    const d = new Date(`${k}T00:00:00Z`);
    if (grain === "month") d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + (grain === "day" ? 1 : 7));
    k = ymd(d);
    if (keys.length > 120) break;
  }
  const m = new Map<string, TrendPoint>(keys.map((k) => [k, { label: k, start: k, requestedKobo: 0, approvedKobo: 0, disbursedKobo: 0 }]));
  const add = (d: Date | null, field: "requestedKobo" | "approvedKobo" | "disbursedKobo", v: number) => {
    if (!d || !v) return;
    const p = m.get(bucketOf(new Date(d)));
    if (p) p[field] += v;
  };
  for (const x of facts) {
    add(x.submittedAt, "requestedKobo", x.requestedKobo);
    if (x.approved) add(x.approvedAt ?? x.submittedAt, "approvedKobo", x.approvedKobo);
    if (x.disbursed) add(x.disbursedAt, "disbursedKobo", x.disbursedKobo);
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const points = [...m.values()].map((p) => {
    const d = new Date(`${p.start}T00:00:00Z`);
    return { ...p, label: grain === "month" ? `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` };
  });
  return { grain, points };
}

export interface OfficerRow {
  officer: string;
  role: string;
  segment: string;
  businessUnit: string;
  reportingHead: string;
  products: string;
  locations: string;
  requests: number;
  requestedKobo: number;
  approvedKobo: number;
  disbursedKobo: number;
  pending: number;
  avgTurnaroundHours: number | null;
  /** Share of the officer's facilities that never breached the SLA (0–100). */
  slaOnTimePercent: number;
}

const uniq = (xs: string[]) => [...new Set(xs.filter((x) => x && x !== "—"))].sort();
export function officerPerformance(facts: FinFact[], roleLabel: (r: string) => string = (r) => r): OfficerRow[] {
  const m = new Map<string, FinFact[]>();
  for (const x of facts) m.set(x.officer, [...(m.get(x.officer) ?? []), x]);
  return [...m.entries()]
    .map(([officer, xs]) => {
      const t = xs.filter((x) => x.turnaroundHours !== null);
      return {
        officer,
        role: uniq(xs.map((x) => roleLabel(x.officerRole))).join(", "),
        segment: uniq(xs.map((x) => x.segment)).join(", "),
        businessUnit: uniq(xs.map((x) => x.businessUnit)).join(", "),
        reportingHead: uniq(xs.map((x) => x.reportingHead)).join(", "),
        products: uniq(xs.map((x) => x.product)).join(", "),
        locations: uniq(xs.map((x) => x.location)).join(", "),
        requests: xs.length,
        requestedKobo: xs.reduce((s, x) => s + x.requestedKobo, 0),
        approvedKobo: xs.reduce((s, x) => s + x.approvedKobo, 0),
        disbursedKobo: xs.reduce((s, x) => s + x.disbursedKobo, 0),
        pending: xs.filter((x) => x.pending).length,
        avgTurnaroundHours: t.length ? t.reduce((s, x) => s + x.turnaroundHours!, 0) / t.length : null,
        slaOnTimePercent: Math.round((100 * xs.filter((x) => x.slaBreaches === 0).length) / xs.length),
      };
    })
    .sort((a, b) => b.requestedKobo - a.requestedKobo || a.officer.localeCompare(b.officer));
}

export interface FinGroup {
  key: string;
  requests: number;
  requestedKobo: number;
  approved: number;
  approvedKobo: number;
  disbursed: number;
  disbursedKobo: number;
  completed: number;
  declined: number;
  pending: number;
  avgTurnaroundHours: number | null;
  slaBreaches: number;
  invoicePending: number;
  invoiceCompleted: number;
  creditExceptions: number;
  awaitingRmConfirmation: number;
  missingEvidence: number;
}

/** Each facility is counted once per group, however many people acted on it. */
export function groupFacts(facts: FinFact[], dim: FinDim): FinGroup[] {
  const m = new Map<string, FinFact[]>();
  for (const x of facts) {
    const k = String(x[dim]);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return [...m.entries()]
    .map(([key, xs]) => {
      const t = xs.filter((x) => x.turnaroundHours !== null);
      return {
        key,
        requests: xs.length,
        requestedKobo: xs.reduce((s, x) => s + x.requestedKobo, 0),
        approved: xs.filter((x) => x.approved).length,
        approvedKobo: xs.reduce((s, x) => s + x.approvedKobo, 0),
        disbursed: xs.filter((x) => x.disbursed).length,
        disbursedKobo: xs.reduce((s, x) => s + x.disbursedKobo, 0),
        completed: xs.filter((x) => x.completed).length,
        declined: xs.filter((x) => x.declined).length,
        pending: xs.filter((x) => x.pending).length,
        avgTurnaroundHours: t.length ? t.reduce((s, x) => s + x.turnaroundHours!, 0) / t.length : null,
        slaBreaches: xs.reduce((s, x) => s + x.slaBreaches, 0),
        invoicePending: xs.filter((x) => x.invoicePending).length,
        invoiceCompleted: xs.filter((x) => x.invoiceCompleted).length,
        creditExceptions: xs.filter((x) => x.creditException).length,
        awaitingRmConfirmation: xs.filter((x) => x.awaitingRmConfirmation).length,
        missingEvidence: xs.filter((x) => x.missingEvidence).length,
      };
    })
    .sort((a, b) => b.requestedKobo - a.requestedKobo || a.key.localeCompare(b.key));
}

/** Workflow actions by the person who performed them (not the originator), within the same facilities. */
export async function actionsByPerformer(q: Db, appIds: string[]) {
  if (!appIds.length) return [];
  return (
    await q.query<{ performer: string; role: string; action: string; stage: string; n: number }>(
      `SELECT s.full_name AS performer, d.actor_role AS role, d.action, d.stage, count(*)::int AS n
         FROM decisions d JOIN staff s ON s.id = d.actor_id
        WHERE d.application_id = ANY($1) AND d.invalidated_at IS NULL
        GROUP BY 1,2,3,4 ORDER BY 1, 5 DESC`,
      [appIds],
    )
  ).rows.map((r) => ({ ...r, stage: STAGE_LABELS[r.stage as Stage] ?? r.stage }));
}

// ─────────────────────────── AltPhones (person level) ───────────────────────────

export const ALT_DIMENSIONS = { unitHead: "Unit Head", location: "Location (at the time of sale)", officer: "Originating DO / SA", model: "Phone model", status: "Status" } as const;
export type AltDim = keyof typeof ALT_DIMENSIONS;

export interface AltFact {
  id: string;
  ref: string;
  unitHead: string;
  location: string;
  officer: string;
  officerRole: string;
  model: string;
  status: string;
  date: Date | null;
  downPaymentKobo: number;
  financedKobo: number;
  completed: boolean;
  pending: boolean;
  reserved: boolean;
  consumed: boolean;
  released: boolean;
}

export async function altphonesFacts(q: Db, scope: Scope, f: { from?: string | null; to?: string | null } = {}): Promise<AltFact[]> {
  if (scope.kind === "NONE") return [];
  const from = dateBound(f.from);
  const to = dateBound(f.to);
  const rows = (
    await q.query(
      `SELECT a.id, a.ref, a.status, a.reservation_status, a.originator_role, coalesce(a.submitted_at, a.created_at) AS d,
              coalesce(a.down_payment_kobo, 0) AS dp, coalesce(a.financed_kobo, 0) AS fin, a.model_name,
              o.full_name AS officer, coalesce(l.name, a.origin_address, '—') AS location, uh.full_name AS unit_head
         FROM altphones_applications a
         JOIN staff o ON o.id = a.originator_id
         LEFT JOIN locations l ON l.id = a.origin_location_id
         LEFT JOIN org_links lu ON lu.staff_id = a.originator_id AND lu.relation = 'UNIT_HEAD'
         LEFT JOIN staff uh ON uh.id = lu.manager_id
        WHERE NOT a.legacy AND a.status <> 'DRAFT'
          AND ($1::uuid[] IS NULL OR a.originator_id = ANY($1))
          AND ($2::date IS NULL OR coalesce(a.submitted_at, a.created_at) >= $2::date)
          AND ($3::date IS NULL OR coalesce(a.submitted_at, a.created_at) < ($3::date + 1))`,
      [scope.kind === "STAFF" ? scope.staffIds : null, from, to],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    unitHead: r.unit_head ?? "Not mapped",
    location: r.location,
    officer: r.officer,
    officerRole: r.originator_role,
    model: r.model_name ?? "—",
    status: String(r.status).replace(/_/g, " ").toLowerCase(),
    date: r.d,
    downPaymentKobo: Number(r.dp),
    financedKobo: Number(r.fin),
    completed: ["DISBURSED", "COMPLETED"].includes(r.status),
    pending: !["DISBURSED", "COMPLETED", "CREDIT_DECLINED", "CANCELLED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(r.status),
    reserved: r.reservation_status === "RESERVED",
    consumed: r.reservation_status === "CONSUMED",
    released: r.reservation_status === "RELEASED",
  }));
}

export function groupAlt(facts: AltFact[], dim: AltDim) {
  const m = new Map<string, AltFact[]>();
  for (const x of facts) m.set(String(x[dim]), [...(m.get(String(x[dim])) ?? []), x]);
  return [...m.entries()]
    .map(([key, xs]) => ({
      key,
      transactions: xs.length,
      completed: xs.filter((x) => x.completed).length,
      pending: xs.filter((x) => x.pending).length,
      downPaymentKobo: xs.reduce((s, x) => s + x.downPaymentKobo, 0),
      financedKobo: xs.reduce((s, x) => s + x.financedKobo, 0),
      reserved: xs.filter((x) => x.reserved).length,
      stockOut: xs.filter((x) => x.consumed).length,
      released: xs.filter((x) => x.released).length,
    }))
    .sort((a, b) => b.transactions - a.transactions || a.key.localeCompare(b.key));
}

/** AltPhones workflow actions by the person who performed them (BPM, PM, Unit Head, completion, confirmations). */
export async function altActionsByPerformer(q: Db, ids: string[]) {
  if (!ids.length) return [];
  return (
    await q.query<{ performer: string; action: string; n: number }>(
      `SELECT s.full_name AS performer, x.action, count(*)::int AS n FROM (
          SELECT bpm_reviewer_id AS who, 'BPM review' AS action FROM altphones_applications WHERE id = ANY($1) AND bpm_reviewer_id IS NOT NULL
          UNION ALL SELECT pm_reviewer_id, 'Product Manager review' FROM altphones_applications WHERE id = ANY($1) AND pm_reviewer_id IS NOT NULL
          UNION ALL SELECT unit_head_id, 'Unit Head review' FROM altphones_applications WHERE id = ANY($1) AND unit_head_id IS NOT NULL
          UNION ALL SELECT details_confirmed_by, 'Customer details confirmed' FROM altphones_applications WHERE id = ANY($1) AND details_confirmed_by IS NOT NULL
          UNION ALL SELECT internal_mandate_confirmed_by, 'Second mandate confirmed' FROM altphones_applications WHERE id = ANY($1) AND internal_mandate_confirmed_by IS NOT NULL
          UNION ALL SELECT completed_by, 'Sale completed (stock out)' FROM altphones_applications WHERE id = ANY($1) AND completed_by IS NOT NULL
        ) x JOIN staff s ON s.id = x.who GROUP BY 1,2 ORDER BY 1, 3 DESC`,
      [ids],
    )
  ).rows;
}

// ─────────────────────────── CSV ───────────────────────────

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}
