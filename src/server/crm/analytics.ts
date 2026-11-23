/**
 * CX analytics, all derived from CRM records (nothing estimated or invented).
 *
 *  - Ticket metrics cover tickets created in the period (Lagos dates, inclusive); "now" figures (open,
 *    unassigned, escalated, overdue, backlog) are a snapshot at the time of the report.
 *  - Handling time comes from the immutable assignment segments: a ticket that passed through three teams
 *    contributes each team's own time to that team. Overall elapsed time (creation → resolution) and
 *    SLA-adjusted time (business time under the ticket's policy, less paused time) are reported separately.
 */
import type { Db } from "../db";
import { lagosParts } from "../time";
import { slaMs } from "./calendar";
import { OPEN_STATUSES, crmSettings, type CrmSettings } from "./core";

export interface Period {
  from: string; // YYYY-MM-DD (Lagos)
  to: string; // YYYY-MM-DD (Lagos), inclusive
}

const BOUNDS = "t.created_at >= ($1::date)::timestamp AT TIME ZONE 'Africa/Lagos' AND t.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Africa/Lagos')";
const SEG_BOUNDS = "a.started_at < (($2::date + 1)::timestamp AT TIME ZONE 'Africa/Lagos') AND coalesce(a.ended_at, 'infinity') >= ($1::date)::timestamp AT TIME ZONE 'Africa/Lagos'";

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

interface TRow {
  id: string;
  ref: string;
  subject: string;
  status: string;
  priority: string;
  product_name: string;
  category_name: string;
  subcategory_name: string;
  team_id: string;
  team_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  resolved_by: string | null;
  resolver_name: string | null;
  region: string | null;
  created_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  resolution_due: Date | null;
  paused_at: Date | null;
  sla_paused_ms: string;
  sla_business_hours: boolean | null;
  escalated: boolean;
  reassign_count: number;
  reopen_count: number;
  satisfaction: number | null;
}

const T_SELECT = `SELECT t.id, t.ref, t.subject, t.status, t.priority, t.product_name, t.category_name, t.subcategory_name, t.team_id, tm.name AS team_name,
    t.assignee_id, o.full_name AS assignee_name, t.resolved_by, rb.full_name AS resolver_name, c.region, t.created_at, t.first_response_at, t.resolved_at, t.closed_at,
    t.resolution_due, t.paused_at, t.sla_paused_ms, t.sla_business_hours, t.escalated, t.reassign_count, t.reopen_count, t.satisfaction
  FROM crm_tickets t JOIN crm_teams tm ON tm.id = t.team_id JOIN staff c ON c.id = t.creator_id LEFT JOIN staff o ON o.id = t.assignee_id LEFT JOIN staff rb ON rb.id = t.resolved_by`;

const isOpen = (s: string) => (OPEN_STATUSES as string[]).includes(s);
const overdue = (t: Pick<TRow, "status" | "resolution_due" | "paused_at">, now: Date) => isOpen(t.status) && !!t.resolution_due && !t.paused_at && new Date(t.resolution_due) < now;
/** null = no resolution target; true = met; false = breached (resolved late, or open past due). Undecided open tickets are null. */
function slaOutcome(t: TRow, now: Date): boolean | null {
  if (!t.resolution_due) return null;
  if (t.resolved_at) return new Date(t.resolved_at) <= new Date(t.resolution_due);
  return overdue(t, now) ? false : null;
}

function countBy<T>(rows: T[], key: (r: T) => string | null) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) ?? "—";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface CrmAnalytics {
  period: Period;
  totals: { received: number; open_in_period: number; resolved: number; closed: number; reopened: number; escalated: number };
  now: { open: number; new_unassigned: number; unassigned: number; in_progress: number; pending_info: number; escalated: number; overdue: number };
  performance: {
    avg_resolution_ms: number | null;
    median_resolution_ms: number | null;
    avg_sla_resolution_ms: number | null;
    first_response_avg_ms: number | null;
    avg_team_handling_ms: number | null;
    avg_officer_handling_ms: number | null;
    sla_compliance_pct: number | null;
    sla_breach_pct: number | null;
    sla_met: number;
    sla_breached: number;
    reassignment_rate_pct: number | null;
    reopen_rate_pct: number | null;
    satisfaction_avg: number | null;
    satisfaction_count: number;
  };
  byProduct: { label: string; count: number }[];
  byCategory: { label: string; count: number }[];
  byTeam: { label: string; count: number }[];
  byOfficer: { label: string; count: number }[];
  byPriority: { label: string; count: number }[];
  byLocation: { label: string; count: number }[];
  byDay: { label: string; count: number }[];
  topIssues: { label: string; count: number }[];
  oldestOpen: { id: string; ref: string; subject: string; team_name: string; assignee_name: string | null; priority: string; status: string; age_ms: number; overdue: boolean }[];
}

export async function crmAnalytics(q: Db, period: Period, now = new Date(), cal?: CrmSettings): Promise<CrmAnalytics> {
  const s = cal ?? (await crmSettings(q));
  const rows = (await q.query<TRow>(`${T_SELECT} WHERE ${BOUNDS}`, [period.from, period.to])).rows;
  const all = (await q.query<TRow>(`${T_SELECT} WHERE t.status = ANY($1)`, [OPEN_STATUSES])).rows;
  const resolved = rows.filter((t) => t.resolved_at);
  const gross = resolved.map((t) => new Date(t.resolved_at!).getTime() - new Date(t.created_at).getTime());
  const adjusted = resolved.map((t) => Math.max(0, slaMs(new Date(t.created_at), new Date(t.resolved_at!), t.sla_business_hours ?? true, s) - Number(t.sla_paused_ms)));
  const fr = rows.filter((t) => t.first_response_at).map((t) => new Date(t.first_response_at!).getTime() - new Date(t.created_at).getTime());
  const outcomes = rows.map((t) => slaOutcome(t, now));
  const met = outcomes.filter((o) => o === true).length;
  const breached = outcomes.filter((o) => o === false).length;
  const ids = rows.map((r) => r.id);
  const segs = ids.length
    ? (await q.query<{ ticket_id: string; team_id: string; officer_id: string | null; started_at: Date; ended_at: Date | null }>("SELECT ticket_id, team_id, officer_id, started_at, ended_at FROM crm_assignments WHERE ticket_id = ANY($1::uuid[])", [ids])).rows
    : [];
  const perTeam = new Map<string, number>();
  const perOfficer = new Map<string, number>();
  for (const g of segs) {
    const d = (g.ended_at ? new Date(g.ended_at) : now).getTime() - new Date(g.started_at).getTime();
    perTeam.set(`${g.ticket_id}|${g.team_id}`, (perTeam.get(`${g.ticket_id}|${g.team_id}`) ?? 0) + d);
    if (g.officer_id) perOfficer.set(`${g.ticket_id}|${g.officer_id}`, (perOfficer.get(`${g.ticket_id}|${g.officer_id}`) ?? 0) + d);
  }
  const sat = rows.filter((t) => t.satisfaction).map((t) => t.satisfaction!);
  const dayKey = (d: Date) => {
    const p = lagosParts(d);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  };
  return {
    period,
    totals: {
      received: rows.length,
      open_in_period: rows.filter((t) => isOpen(t.status)).length,
      resolved: resolved.length,
      closed: rows.filter((t) => t.status === "CLOSED").length,
      reopened: rows.filter((t) => t.reopen_count > 0).length,
      escalated: rows.filter((t) => t.escalated).length,
    },
    now: {
      open: all.length,
      new_unassigned: all.filter((t) => t.status === "UNASSIGNED" && !t.assignee_id && t.reassign_count === 0).length,
      unassigned: all.filter((t) => t.status === "UNASSIGNED").length,
      in_progress: all.filter((t) => t.status === "IN_PROGRESS").length,
      pending_info: all.filter((t) => t.status === "PENDING_INFO").length,
      escalated: all.filter((t) => t.escalated).length,
      overdue: all.filter((t) => overdue(t, now)).length,
    },
    performance: {
      avg_resolution_ms: avg(gross),
      median_resolution_ms: median(gross),
      avg_sla_resolution_ms: avg(adjusted),
      first_response_avg_ms: avg(fr),
      avg_team_handling_ms: avg([...perTeam.values()]),
      avg_officer_handling_ms: avg([...perOfficer.values()]),
      sla_compliance_pct: pct(met, met + breached),
      sla_breach_pct: pct(breached, met + breached),
      sla_met: met,
      sla_breached: breached,
      reassignment_rate_pct: pct(rows.filter((t) => t.reassign_count > 0).length, rows.length),
      reopen_rate_pct: pct(rows.filter((t) => t.reopen_count > 0).length, rows.length),
      satisfaction_avg: sat.length ? Math.round((sat.reduce((a, b) => a + b, 0) / sat.length) * 10) / 10 : null,
      satisfaction_count: sat.length,
    },
    byProduct: countBy(rows, (t) => t.product_name),
    byCategory: countBy(rows, (t) => t.category_name),
    byTeam: countBy(rows, (t) => t.team_name),
    byOfficer: countBy(rows.filter((t) => t.resolver_name ?? t.assignee_name), (t) => t.resolver_name ?? t.assignee_name),
    byPriority: countBy(rows, (t) => t.priority),
    byLocation: countBy(rows, (t) => t.region),
    byDay: countBy(rows, (t) => dayKey(new Date(t.created_at))).sort((a, b) => a.label.localeCompare(b.label)),
    topIssues: countBy(rows, (t) => `${t.category_name} — ${t.subcategory_name}`).slice(0, 10),
    oldestOpen: all
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, 10)
      .map((t) => ({ id: t.id, ref: t.ref, subject: t.subject, team_name: t.team_name, assignee_name: t.assignee_name, priority: t.priority, status: t.status, age_ms: now.getTime() - new Date(t.created_at).getTime(), overdue: overdue(t, now) })),
  };
}

// ------------------------------------------------------------------ team and officer performance

interface Seg {
  ticket_id: string;
  team_id: string;
  team_name: string;
  officer_id: string | null;
  officer_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  resolution_due: Date | null;
  sla_business_hours: boolean | null;
}

async function segments(q: Db, period: Period): Promise<Seg[]> {
  return (
    await q.query<Seg>(
      `SELECT a.ticket_id, a.team_id, tm.name AS team_name, a.officer_id, o.full_name AS officer_name, a.started_at, a.ended_at, a.end_reason, t.resolution_due, t.sla_business_hours
         FROM crm_assignments a JOIN crm_teams tm ON tm.id = a.team_id JOIN crm_tickets t ON t.id = a.ticket_id LEFT JOIN staff o ON o.id = a.officer_id
        WHERE ${SEG_BOUNDS} ORDER BY a.ticket_id, a.started_at, a.id`,
      [period.from, period.to],
    )
  ).rows;
}

export interface HolderPerformance {
  received: number;
  assigned: number;
  resolved: number;
  transferred_out: number;
  pending_now: number;
  handling_ms_total: number;
  handling_business_ms_total: number;
  avg_handling_ms: number | null;
  median_handling_ms: number | null;
  max_handling_ms: number | null;
  sla_met: number;
  sla_breached: number;
  sla_compliance_pct: number | null;
  backlog: { under_1d: number; d1_3: number; d3_7: number; over_7d: number };
}

function summarise(segs: Seg[], now: Date, s: CrmSettings, open: { id: string; created_at: Date; resolution_due: Date | null; paused_at: Date | null }[]): HolderPerformance {
  const perTicket = new Map<string, number>();
  let business = 0;
  for (const g of segs) {
    const end = g.ended_at ? new Date(g.ended_at) : now;
    const d = end.getTime() - new Date(g.started_at).getTime();
    perTicket.set(g.ticket_id, (perTicket.get(g.ticket_id) ?? 0) + d);
    business += slaMs(new Date(g.started_at), end, g.sla_business_hours ?? true, s);
  }
  const times = [...perTicket.values()];
  const resolvedSegs = segs.filter((g) => g.end_reason === "RESOLVED");
  const met = resolvedSegs.filter((g) => g.resolution_due && new Date(g.ended_at!) <= new Date(g.resolution_due)).length;
  const lateResolved = resolvedSegs.filter((g) => g.resolution_due && new Date(g.ended_at!) > new Date(g.resolution_due)).length;
  const lateOpen = open.filter((t) => t.resolution_due && !t.paused_at && new Date(t.resolution_due) < now).length;
  const age = (t: { created_at: Date }) => (now.getTime() - new Date(t.created_at).getTime()) / 86_400_000;
  return {
    received: new Set(segs.map((g) => g.ticket_id)).size,
    assigned: new Set(segs.filter((g) => g.officer_id).map((g) => g.ticket_id)).size,
    resolved: new Set(resolvedSegs.map((g) => g.ticket_id)).size,
    transferred_out: segs.filter((g) => g.end_reason === "TRANSFERRED" || g.end_reason === "CX_HEAD_OVERRIDE").length,
    pending_now: open.length,
    handling_ms_total: times.reduce((a, b) => a + b, 0),
    handling_business_ms_total: business,
    avg_handling_ms: avg(times),
    median_handling_ms: median(times),
    max_handling_ms: times.length ? Math.max(...times) : null,
    sla_met: met,
    sla_breached: lateResolved + lateOpen,
    sla_compliance_pct: pct(met, met + lateResolved + lateOpen),
    backlog: {
      under_1d: open.filter((t) => age(t) < 1).length,
      d1_3: open.filter((t) => age(t) >= 1 && age(t) < 3).length,
      d3_7: open.filter((t) => age(t) >= 3 && age(t) < 7).length,
      over_7d: open.filter((t) => age(t) >= 7).length,
    },
  };
}

export async function teamPerformance(q: Db, period: Period, now = new Date()): Promise<(HolderPerformance & { team_id: string; team_name: string })[]> {
  const s = await crmSettings(q);
  const segs = await segments(q, period);
  const teams = (await q.query<{ id: string; name: string }>("SELECT id, name FROM crm_teams WHERE active OR id IN (SELECT DISTINCT team_id FROM crm_assignments) ORDER BY name")).rows;
  const open = (await q.query<{ id: string; team_id: string; created_at: Date; resolution_due: Date | null; paused_at: Date | null }>("SELECT id, team_id, created_at, resolution_due, paused_at FROM crm_tickets WHERE status = ANY($1)", [OPEN_STATUSES])).rows;
  return teams.map((t) => ({ team_id: t.id, team_name: t.name, ...summarise(segs.filter((g) => g.team_id === t.id), now, s, open.filter((o) => o.team_id === t.id)) }));
}

export async function officerPerformance(q: Db, period: Period, now = new Date(), teamIds?: string[]): Promise<(HolderPerformance & { officer_id: string; officer_name: string })[]> {
  const s = await crmSettings(q);
  const segs = (await segments(q, period)).filter((g) => g.officer_id && (!teamIds || teamIds.includes(g.team_id)));
  const open = (await q.query<{ id: string; assignee_id: string; team_id: string; created_at: Date; resolution_due: Date | null; paused_at: Date | null }>("SELECT id, assignee_id, team_id, created_at, resolution_due, paused_at FROM crm_tickets WHERE status = ANY($1) AND assignee_id IS NOT NULL", [OPEN_STATUSES])).rows;
  const officers = new Map<string, string>();
  for (const g of segs) officers.set(g.officer_id!, g.officer_name ?? "—");
  return [...officers.entries()]
    .map(([id, name]) => {
      const mine = segs.filter((g) => g.officer_id === id);
      const out = summarise(mine, now, s, open.filter((o) => o.assignee_id === id && (!teamIds || teamIds.includes(o.team_id))));
      // For an officer, "transferred out" includes hand-offs to a colleague.
      out.transferred_out = mine.filter((g) => ["TRANSFERRED", "CX_HEAD_OVERRIDE", "REASSIGNED"].includes(g.end_reason ?? "")).length;
      return { officer_id: id, officer_name: name, ...out };
    })
    .sort((a, b) => a.officer_name.localeCompare(b.officer_name));
}

/** Per-ticket handling breakdown: time with each team and officer (for the ticket page). */
export function handlingBreakdown(segs: { team_name: string; officer_name: string | null; started_at: Date; ended_at: Date | null }[], now = new Date()) {
  const team = new Map<string, number>();
  const officer = new Map<string, number>();
  for (const g of segs) {
    const d = (g.ended_at ? new Date(g.ended_at) : now).getTime() - new Date(g.started_at).getTime();
    team.set(g.team_name, (team.get(g.team_name) ?? 0) + d);
    if (g.officer_name) officer.set(g.officer_name, (officer.get(g.officer_name) ?? 0) + d);
  }
  return { team: [...team.entries()], officer: [...officer.entries()] };
}

// ------------------------------------------------------------------ per-ticket time measurements

export interface TicketTimings {
  creation_to_routing_ms: number | null;
  awaiting_first_assignment_ms: number | null;
  first_response_ms: number | null;
  investigation_ms: number | null;
  pending_information_ms: number;
  total_resolution_ms: number | null;
  sla_resolution_ms: number | null;
  resolution_to_closure_ms: number | null;
  breach_ms: number | null;
  reassignments: number;
  reopenings: number;
}

/**
 * Every §14.1 measurement for one ticket, from server timestamps and the immutable event history.
 * Open intervals run to `now`. Pending information is the sum of each request → reply (or resolution) interval.
 */
export function ticketTimings(
  t: { created_at: Date; routed_at: Date | null; first_assigned_at: Date | null; first_response_at: Date | null; started_at: Date | null; resolved_at: Date | null; closed_at: Date | null; resolution_due: Date | null; paused_at: Date | null; sla_paused_ms: string | number; sla_business_hours: boolean | null; reassign_count: number; reopen_count: number; status: string },
  events: { at: Date; kind: string }[],
  now: Date,
  cal: Parameters<typeof slaMs>[3],
): TicketTimings {
  const ms = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : null);
  const created = new Date(t.created_at);
  let pending = 0;
  let openAt: Date | null = null;
  for (const e of [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())) {
    if (e.kind === "INFO_REQUESTED" && !openAt) openAt = new Date(e.at);
    else if (openAt && ["RESUMED", "INFO_PROVIDED", "RESOLVED", "TRANSFERRED"].includes(e.kind)) {
      pending += new Date(e.at).getTime() - openAt.getTime();
      openAt = null;
    }
  }
  if (openAt) pending += now.getTime() - openAt.getTime();
  const end = t.resolved_at ? new Date(t.resolved_at) : null;
  const bh = t.sla_business_hours ?? true;
  const due = t.resolution_due ? new Date(t.resolution_due) : null;
  const breachEnd = end ?? (isOpen(t.status) && !t.paused_at ? now : null);
  return {
    creation_to_routing_ms: ms(created, t.routed_at),
    awaiting_first_assignment_ms: t.first_assigned_at ? ms(created, t.first_assigned_at) : isOpen(t.status) ? ms(created, now) : null,
    first_response_ms: ms(created, t.first_response_at),
    investigation_ms: t.started_at ? ms(t.started_at, end ?? now) : null,
    pending_information_ms: pending,
    total_resolution_ms: ms(created, end),
    sla_resolution_ms: end ? Math.max(0, slaMs(created, end, bh, cal) - Number(t.sla_paused_ms)) : null,
    resolution_to_closure_ms: ms(end, t.closed_at),
    breach_ms: due && breachEnd && breachEnd > due ? slaMs(due, breachEnd, bh, cal) : due ? 0 : null,
    reassignments: t.reassign_count,
    reopenings: t.reopen_count,
  };
}
