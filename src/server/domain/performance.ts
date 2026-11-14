/**
 * Performance targets and the daily performance summary for Relationship Managers and Team Leads.
 *
 * Every figure here is derived from recorded data: disbursements (`disbursements.disbursed_on`, Lagos
 * date) and applications. Nothing is estimated or filled in. When no approved target exists the summary
 * says "Target not configured" instead of inventing one.
 *
 * Attribution (no double counting):
 * - a person's own figure counts disbursed requests they are responsible for: the initiator, or the
 *   assigned Relationship Manager when a Delight Officer originated it;
 * - a team figure counts disbursed requests whose team is that team. A Team Lead's own originations are
 *   in their team total once; "My performance" and "My team" are shown side by side, never added.
 *
 * Targets are maker-checker: proposed by a Super Admin, Head of Retail Sales or Unit Head and approved by a
 * different person holding Unit Head, Divisional Head or Head of Retail Sales. Approving a replacement
 * supersedes the previous approved target for the same person/team, metric and month; history is kept.
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { activeRoles } from "./access";
import { addDaysToDateString, lagosDate } from "../time";

export const TARGET_METRICS = ["DISBURSED_VALUE", "DISBURSED_COUNT"] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];
export const TARGET_METRIC_LABELS: Record<TargetMetric, string> = { DISBURSED_VALUE: "Disbursed value (₦)", DISBURSED_COUNT: "Disbursed requests (number)" };
export const TARGET_PROPOSER_ROLES = ["SUPER_ADMIN", "HEAD_OF_RETAIL_SALES", "UNIT_HEAD"] as const;
export const TARGET_APPROVER_ROLES = ["UNIT_HEAD", "DIVISIONAL_HEAD", "HEAD_OF_RETAIL_SALES"] as const;
/** Roles that receive the once-a-day performance summary. */
export const SUMMARY_ROLES = ["RM", "TEAM_LEAD"] as const;

export interface TargetRow {
  id: string;
  scope_type: "STAFF" | "TEAM";
  staff_id: string | null;
  staff_name: string | null;
  team: string | null;
  metric: TargetMetric;
  period_month: string;
  target_value: string;
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED";
  reason: string;
  proposed_by: string;
  proposed_by_name: string;
  proposed_at: Date;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
function monthEnd(day: string) {
  const [y, m] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${day.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

export async function targetAccess(q: Db, staffId: string) {
  const roles = (await activeRoles(q, staffId)).map((r) => r.role);
  return {
    propose: roles.some((r) => (TARGET_PROPOSER_ROLES as readonly string[]).includes(r)),
    approve: roles.some((r) => (TARGET_APPROVER_ROLES as readonly string[]).includes(r)),
  };
}

export async function listTargets(q: Db, opts: { month?: string } = {}): Promise<TargetRow[]> {
  return (
    await q.query<TargetRow>(
      `SELECT t.*, t.period_month::text AS period_month, t.target_value::text AS target_value, s.full_name AS staff_name, p.full_name AS proposed_by_name, d.full_name AS decided_by_name
         FROM performance_targets t LEFT JOIN staff s ON s.id = t.staff_id JOIN staff p ON p.id = t.proposed_by LEFT JOIN staff d ON d.id = t.decided_by
        WHERE ($1::date IS NULL OR t.period_month = $1::date)
        ORDER BY t.period_month DESC, t.status = 'PROPOSED' DESC, t.proposed_at DESC LIMIT 500`,
      [opts.month ?? null],
    )
  ).rows;
}

export interface TargetProposal {
  scopeType: "STAFF" | "TEAM";
  staffId?: string | null;
  team?: string | null;
  metric: TargetMetric;
  /** YYYY-MM */
  month: string;
  /** Kobo for DISBURSED_VALUE, a whole number otherwise. */
  value: number;
  reason: string;
}

export async function proposeTarget(ctx: Ctx, p: TargetProposal) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await targetAccess(tx, actor.staffId)).propose) throw forbidden("Only a Super Admin, Head of Retail Sales or Unit Head can propose targets.");
    const e: Record<string, string> = {};
    if (!["STAFF", "TEAM"].includes(p.scopeType)) e.scopeType = "Choose a person or a team.";
    if (!(TARGET_METRICS as readonly string[]).includes(p.metric)) e.metric = "Choose what the target measures.";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month ?? "")) e.month = "Choose the month.";
    else if (`${p.month}-01` < monthStart(lagosDate(ctx.now))) e.month = "Targets cannot be set for a past month.";
    if (!Number.isSafeInteger(p.value) || p.value <= 0) e.value = "Enter a target above zero.";
    if ((p.reason ?? "").trim().length < 3) e.reason = "Give the reason or source of this target.";
    let staffId: string | null = null;
    let team: string | null = null;
    if (p.scopeType === "STAFF") {
      const ok = p.staffId && (await tx.query("SELECT 1 FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.staff_id = $1 AND ra.active AND s.status = 'ACTIVE' AND ra.role = ANY($2)", [p.staffId, [...SUMMARY_ROLES]])).rowCount;
      if (!ok) e.staffId = "Choose an active Relationship Manager or Team Lead.";
      else staffId = p.staffId!;
    } else if (p.scopeType === "TEAM") {
      team = (p.team ?? "").trim();
      const ok = team && (await tx.query("SELECT 1 FROM role_assignments WHERE active AND team = $1 LIMIT 1", [team])).rowCount;
      if (!ok) e.team = "Choose a team that has active members.";
    }
    if (Object.keys(e).length) throw invalid("Check the target.", e);
    const open = await tx.query("SELECT 1 FROM performance_targets WHERE status = 'PROPOSED' AND scope_type = $1 AND coalesce(staff_id::text, team) = $2 AND metric = $3 AND period_month = $4", [p.scopeType, staffId ?? team, p.metric, `${p.month}-01`]);
    if (open.rowCount) throw conflict("A proposal for this target is already waiting for approval.");
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO performance_targets (scope_type, staff_id, team, metric, period_month, target_value, status, reason, proposed_by, proposed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'PROPOSED',$7,$8,$9) RETURNING id`,
        [p.scopeType, staffId, team, p.metric, `${p.month}-01`, p.value, p.reason.trim(), actor.staffId, ctx.now],
      )
    ).rows[0].id;
    await audit(tx, ctx, { action: "TARGET_PROPOSED", reason: p.reason.trim(), details: { targetId: id, scopeType: p.scopeType, staffId, team, metric: p.metric, month: p.month, value: p.value } });
    return id;
  });
}

export async function decideTarget(ctx: Ctx, id: string, decision: "APPROVE" | "REJECT" | "WITHDRAW", note: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const t = (await tx.query<TargetRow>("SELECT *, period_month::text AS period_month FROM performance_targets WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!t) throw notFound("Target not found.");
    if (t.status !== "PROPOSED") throw conflict("This proposal has already been decided.");
    if (decision === "WITHDRAW") {
      if (t.proposed_by !== actor.staffId) throw forbidden("Only the person who proposed it can withdraw it.");
    } else {
      if (!(await targetAccess(tx, actor.staffId)).approve) throw forbidden("Only a Unit Head, Divisional Head or Head of Retail Sales can approve targets.");
      if (t.proposed_by === actor.staffId) throw forbidden("You cannot approve or reject a target you proposed.");
      if (t.staff_id === actor.staffId) throw forbidden("You cannot decide your own target.");
      if (decision === "REJECT" && (note ?? "").trim().length < 3) throw invalid("Give the reason for rejecting.", { note: "Give the reason for rejecting." });
    }
    const status = decision === "APPROVE" ? "APPROVED" : decision === "REJECT" ? "REJECTED" : "WITHDRAWN";
    let superseded: string | null = null;
    if (decision === "APPROVE") {
      const prev = (await tx.query<{ id: string }>("SELECT id FROM performance_targets WHERE status = 'APPROVED' AND scope_type = $1 AND coalesce(staff_id::text, team) = $2 AND metric = $3 AND period_month = $4 FOR UPDATE", [t.scope_type, t.staff_id ?? t.team, t.metric, t.period_month])).rows[0];
      if (prev) {
        await tx.query("UPDATE performance_targets SET status = 'SUPERSEDED', superseded_by = $2 WHERE id = $1", [prev.id, id]);
        superseded = prev.id;
      }
    }
    await tx.query("UPDATE performance_targets SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1", [id, status, actor.staffId, ctx.now, (note ?? "").trim() || null]);
    await audit(tx, ctx, { action: `TARGET_${status}`, reason: (note ?? "").trim() || null, details: { targetId: id, superseded } });
    return { status, superseded };
  });
}

// ------------------------------------------------------------------ working days

/** Monday–Friday, excluding public holidays recorded in the holiday calendar; inclusive range. */
export async function workingDays(q: Db, from: string, to: string): Promise<number> {
  if (to < from) return 0;
  const hol = new Set((await q.query<{ d: string }>("SELECT holiday_date::text AS d FROM altphones_holidays WHERE holiday_date BETWEEN $1 AND $2", [from, to])).rows.map((r) => r.d));
  let n = 0;
  for (let d = from; d <= to; d = addDaysToDateString(d, 1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6 && !hol.has(d)) n++;
  }
  return n;
}

// ------------------------------------------------------------------ figures

export interface PerformanceBlock {
  label: string;
  target: { value: number; count: number | null; valueTargetId: string | null; countTargetId: string | null } | null;
  mtd: { valueKobo: number; count: number };
  today: { valueKobo: number; count: number };
  yesterday: { valueKobo: number; count: number; date: string | null };
  achievementPercent: number | null;
  /** Average disbursed per working day so far this month. */
  runRateKobo: number;
  projectedKobo: number;
  /** Needed per remaining working day (including today) to reach the value target; null without one. */
  requiredDailyKobo: number | null;
  pipeline: { drafts: number; inReview: number; correction: number; approvedNotDisbursed: number; submittedToday: number };
}

type Who = { kind: "STAFF"; staffId: string } | { kind: "TEAM"; team: string };

const RESPONSIBLE = `(CASE WHEN a.initiator_role = 'DELIGHT_OFFICER' THEN a.assigned_rm_id ELSE a.initiator_id END)`;
const scopeSql = (w: Who) => (w.kind === "STAFF" ? `${RESPONSIBLE} = $1` : `a.team = $1`);
const scopeParam = (w: Who) => (w.kind === "STAFF" ? w.staffId : w.team);

export async function performanceBlock(q: Db, who: Who, label: string, now: Date): Promise<PerformanceBlock> {
  const today = lagosDate(now);
  const start = monthStart(today);
  const end = monthEnd(today);
  const s = scopeSql(who);
  const param = scopeParam(who);
  const sums = (
    await q.query<{ mtd_v: string; mtd_n: string; tod_v: string; tod_n: string }>(
      `SELECT coalesce(sum(di.amount_kobo) FILTER (WHERE di.disbursed_on BETWEEN $2 AND $3),0)::text AS mtd_v,
              count(*) FILTER (WHERE di.disbursed_on BETWEEN $2 AND $3)::text AS mtd_n,
              coalesce(sum(di.amount_kobo) FILTER (WHERE di.disbursed_on = $3),0)::text AS tod_v,
              count(*) FILTER (WHERE di.disbursed_on = $3)::text AS tod_n
         FROM disbursements di JOIN applications a ON a.id = di.application_id WHERE ${s}`,
      [param, start, today],
    )
  ).rows[0];
  const prev = (
    await q.query<{ d: string | null; v: string; n: string }>(
      `WITH last AS (SELECT max(di.disbursed_on) AS d FROM disbursements di JOIN applications a ON a.id = di.application_id WHERE ${s} AND di.disbursed_on < $2)
       SELECT (SELECT d::text FROM last) AS d, coalesce(sum(di.amount_kobo),0)::text AS v, count(di.id)::text AS n
         FROM disbursements di JOIN applications a ON a.id = di.application_id WHERE ${s} AND di.disbursed_on = (SELECT d FROM last)`,
      [param, today],
    )
  ).rows[0];
  const pipe = (
    await q.query<{ drafts: string; in_review: string; correction: string; approved: string; submitted_today: string }>(
      `SELECT count(*) FILTER (WHERE a.stage = 'DRAFT')::text AS drafts,
              count(*) FILTER (WHERE a.stage NOT IN ('DRAFT','INITIATOR_CORRECTION') AND a.status = 'IN_PROGRESS' AND NOT EXISTS (SELECT 1 FROM disbursements d WHERE d.application_id = a.id))::text AS in_review,
              count(*) FILTER (WHERE a.stage = 'INITIATOR_CORRECTION')::text AS correction,
              count(*) FILTER (WHERE a.business_approved_at IS NOT NULL AND a.status IN ('IN_PROGRESS','BOOKED') AND NOT EXISTS (SELECT 1 FROM disbursements d WHERE d.application_id = a.id))::text AS approved,
              count(*) FILTER (WHERE a.submitted_at IS NOT NULL AND (a.submitted_at AT TIME ZONE 'Africa/Lagos')::date = $2::date)::text AS submitted_today
         FROM applications a WHERE ${s} ${who.kind === "TEAM" ? "AND a.stage <> 'DRAFT'" : ""}`,
      [param, today],
    )
  ).rows[0];
  const targets = (
    await q.query<{ id: string; metric: TargetMetric; target_value: string }>(
      `SELECT id, metric, target_value::text FROM performance_targets WHERE status = 'APPROVED' AND period_month = $1 AND ${who.kind === "STAFF" ? "scope_type = 'STAFF' AND staff_id = $2" : "scope_type = 'TEAM' AND team = $2"}`,
      [start, param],
    )
  ).rows;
  const tv = targets.find((t) => t.metric === "DISBURSED_VALUE");
  const tc = targets.find((t) => t.metric === "DISBURSED_COUNT");
  const elapsed = await workingDays(q, start, today);
  const remaining = await workingDays(q, today, end);
  const total = await workingDays(q, start, end);
  const mtdV = Number(sums.mtd_v);
  const runRate = elapsed ? Math.round(mtdV / elapsed) : 0;
  return {
    label,
    target: tv || tc ? { value: tv ? Number(tv.target_value) : 0, count: tc ? Number(tc.target_value) : null, valueTargetId: tv?.id ?? null, countTargetId: tc?.id ?? null } : null,
    mtd: { valueKobo: mtdV, count: Number(sums.mtd_n) },
    today: { valueKobo: Number(sums.tod_v), count: Number(sums.tod_n) },
    yesterday: { valueKobo: Number(prev?.v ?? 0), count: Number(prev?.n ?? 0), date: prev?.d ?? null },
    achievementPercent: tv ? Math.round((mtdV / Number(tv.target_value)) * 1000) / 10 : null,
    runRateKobo: runRate,
    projectedKobo: runRate * total,
    requiredDailyKobo: tv ? (remaining ? Math.max(0, Math.ceil((Number(tv.target_value) - mtdV) / remaining)) : Math.max(0, Number(tv.target_value) - mtdV)) : null,
    pipeline: { drafts: Number(pipe.drafts), inReview: Number(pipe.in_review), correction: Number(pipe.correction), approvedNotDisbursed: Number(pipe.approved), submittedToday: Number(pipe.submitted_today) },
  };
}

export interface DailySummary {
  day: string;
  name: string;
  workingDays: { elapsed: number; remaining: number; total: number };
  mine: PerformanceBlock | null;
  teams: PerformanceBlock[];
  awaitingMe: number;
  generatedAt: string;
}

/** The figures for one person's summary: their own (RM / Team Lead originations) and, for Team Leads, their team(s). */
export async function dailySummary(q: Db, staffId: string, now: Date): Promise<DailySummary | null> {
  const roles = await activeRoles(q, staffId);
  const isRm = roles.some((r) => r.role === "RM");
  const tlTeams = (await q.query<{ team: string }>("SELECT DISTINCT team FROM role_assignments WHERE staff_id = $1 AND active AND role = 'TEAM_LEAD' AND team IS NOT NULL ORDER BY team", [staffId])).rows.map((r) => r.team);
  const isTl = roles.some((r) => r.role === "TEAM_LEAD");
  if (!isRm && !isTl) return null;
  const name = (await q.query<{ full_name: string }>("SELECT full_name FROM staff WHERE id = $1", [staffId])).rows[0]?.full_name ?? "";
  const today = lagosDate(now);
  const start = monthStart(today);
  const end = monthEnd(today);
  return {
    day: today,
    name,
    workingDays: { elapsed: await workingDays(q, start, today), remaining: await workingDays(q, today, end), total: await workingDays(q, start, end) },
    mine: await performanceBlock(q, { kind: "STAFF", staffId }, "My performance", now),
    teams: await Promise.all(tlTeams.map((t) => performanceBlock(q, { kind: "TEAM", team: t }, `My team: ${t}`, now))),
    awaitingMe: Number((await q.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1", [staffId])).rows[0].n),
    generatedAt: now.toISOString(),
  };
}

/** True when this person should see the summary now (an RM or Team Lead who has not seen it today). */
export async function summaryDue(q: Db, staffId: string, now: Date): Promise<boolean> {
  const roles = (await activeRoles(q, staffId)).map((r) => r.role);
  if (!roles.some((r) => (SUMMARY_ROLES as readonly string[]).includes(r))) return false;
  return !(await q.query("SELECT 1 FROM performance_summary_views WHERE staff_id = $1 AND lagos_day = $2", [staffId, lagosDate(now)])).rowCount;
}

export async function markSummarySeen(q: Db, staffId: string, now: Date) {
  await q.query("INSERT INTO performance_summary_views (staff_id, lagos_day, seen_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [staffId, lagosDate(now), now]);
}
