/**
 * Weekly Divisional Head report: every Sunday at 18:00 Africa/Lagos (configurable time), covering the week just
 * ending (Monday 00:00 to the send time) and month to date (1st 00:00 to the send time). Sent to every active
 * Divisional Head, plus any extra recipients the Super Admin adds. Bank-wide: the Divisional Head is the final
 * approver of every financing request.
 *
 * Idempotent per (week, recipient): restarts, retries and several workers never send a second copy; a run missed
 * while the worker was down is caught up within three days.
 */
import type { Db } from "../db";
import { db, withTx } from "../db";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { config } from "../config";
import { formatKobo } from "../money";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { STAGE_LABELS, TERMINAL_STAGES, type Stage } from "../domain/stages";
import { ROLE_LABELS, type Role } from "../domain/roles";
import { financingFacts, groupFacts, type FinFact } from "../performance-report";
import { addDaysToDateString, fromLagos, lagosDate, lagosWeekStart } from "../time";
import { CATCH_UP_MS } from "./schedules";

export const DH_CODE = "DH_WEEKLY_REPORT";

export interface DhPeriod {
  key: string;
  sendAt: Date;
  weekStart: Date;
  monthStart: Date;
  weekLabel: string;
  monthLabel: string;
  fromWeek: string;
  fromMonth: string;
  to: string;
}

/** The Sunday send instant of the Lagos week containing `ref`, and its windows. */
export function dhPeriodFor(ref: Date, hour: number, minute: number): DhPeriod {
  const weekStart = lagosWeekStart(ref);
  const monday = lagosDate(weekStart);
  const sunday = addDaysToDateString(monday, 6);
  const [y, m, d] = sunday.split("-").map(Number);
  const sendAt = fromLagos(y, m, d, hour, minute);
  const monthStart = fromLagos(y, m, 1);
  const fmt = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return {
    key: `D${sunday}`,
    sendAt,
    weekStart,
    monthStart,
    weekLabel: `${fmt(monday)} – ${fmt(sunday)}`,
    monthLabel: `${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })} to date (1 – ${d} ${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })})`,
    fromWeek: monday,
    fromMonth: `${sunday.slice(0, 8)}01`,
    to: sunday,
  };
}

/** The period due now (this week's Sunday, or last week's if it was missed), or null. */
export function duePeriod(now: Date, hour: number, minute: number): DhPeriod | null {
  for (const ref of [now, new Date(now.getTime() - 7 * 86_400_000)]) {
    const p = dhPeriodFor(ref, hour, minute);
    if (now >= p.sendAt && now.getTime() - p.sendAt.getTime() <= CATCH_UP_MS) return p;
  }
  return null;
}

// ─────────────────────────── report content ───────────────────────────

const inWin = (d: Date | null, a: Date, b: Date) => !!d && new Date(d) >= a && new Date(d) < b;
const money = (k: number) => formatKobo(k).replace(/\.00$/, "");
const hrs = (h: number | null) => (h === null ? "—" : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

interface Window {
  submitted: FinFact[];
  approved: FinFact[];
  disbursed: FinFact[];
  declined: FinFact[];
}
function windowOf(facts: FinFact[], a: Date, b: Date): Window {
  return {
    submitted: facts.filter((x) => inWin(x.submittedAt, a, b)),
    approved: facts.filter((x) => x.approved && inWin(x.approvedAt, a, b)),
    disbursed: facts.filter((x) => x.disbursed && inWin(x.disbursedAt, a, b)),
    declined: facts.filter((x) => inWin(x.declinedAt, a, b)),
  };
}
const sum = (xs: FinFact[], f: (x: FinFact) => number) => xs.reduce((s, x) => s + f(x), 0);

/** Two-column table in plain text: label | week | month to date. */
function table(title: string, rows: [string, string, string][]): string[] {
  if (!rows.length) return [title, "  (nothing recorded)", ""];
  const w0 = Math.max(...rows.map((r) => r[0].length), 10);
  const w1 = Math.max(...rows.map((r) => r[1].length), "This week".length);
  return [title, `  ${"".padEnd(w0)}   ${"This week".padStart(w1)}   Month to date`, ...rows.map((r) => `  ${r[0].padEnd(w0)}   ${r[1].padStart(w1)}   ${r[2]}`), ""];
}

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Figures never break inside themselves; a long cell wraps only between its "·" parts. */
const cell = (v: string) => v.split(" · ").map((x) => esc(x).replace(/ /g, "&nbsp;")).join(" ·<wbr> ");
const H2 = (t: string) => `<h2 style="font:600 15px/1.3 Arial,Helvetica,sans-serif;color:#152b59;margin:24px 0 8px">${esc(t)}</h2>`;
const TD = "padding:7px 10px;border-bottom:1px solid #dee5f3;font:13px/1.4 Arial,Helvetica,sans-serif;color:#152b59;vertical-align:top";
const TH = "padding:7px 10px;border-bottom:2px solid #c4cee2;font:600 12px/1.4 Arial,Helvetica,sans-serif;color:#5f6c87;text-align:left";

export async function buildDhReport(q: Db, p: DhPeriod, now: Date) {
  const end = p.sendAt;
  const html: string[] = [];
  /** A label | this week | month-to-date section, rendered as text lines and as an HTML table. */
  const T = (title: string, rows: [string, string, string][]) => {
    html.push(H2(title));
    html.push(
      rows.length
        ? `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:760px"><tr><th style="${TH}"></th><th style="${TH};text-align:right;white-space:nowrap">This week</th><th style="${TH};text-align:right;white-space:nowrap">Month to date</th></tr>${rows
            .map((r) => `<tr><td style="${TD}">${esc(r[0])}</td><td style="${TD};text-align:right">${cell(r[1])}</td><td style="${TD};text-align:right">${cell(r[2])}</td></tr>`)
            .join("")}</table>`
        : `<p style="font:13px Arial,sans-serif;color:#5f6c87">Nothing recorded.</p>`,
    );
    return table(title, rows);
  };
  /** A list section (snapshot or ranking). */
  const L = (title: string, items: string[], empty: string) => {
    html.push(H2(title));
    html.push(items.length ? `<ul style="margin:0;padding-left:18px">${items.map((i) => `<li style="font:13px/1.6 Arial,Helvetica,sans-serif;color:#152b59">${esc(i)}</li>`).join("")}</ul>` : `<p style="font:13px Arial,sans-serif;color:#5f6c87">${esc(empty)}</p>`);
    return [title, ...(items.length ? items.map((i) => `  ${i}`) : [`  ${empty}`]), ""];
  };
  const facts = await financingFacts(q, { kind: "ALL" });
  const W = windowOf(facts, p.weekStart, end);
  const M = windowOf(facts, p.monthStart, end);
  const nAmt = (xs: FinFact[], f: (x: FinFact) => number) => `${xs.length} · ${money(sum(xs, f))}`;
  const req = (x: FinFact) => x.requestedKobo;
  const avgTurn = (xs: FinFact[]) => {
    const t = xs.filter((x) => x.turnaroundHours !== null);
    return t.length ? sum(t, (x) => x.turnaroundHours!) / t.length : null;
  };
  const rate = (w: Window) => (w.approved.length + w.declined.length ? `${Math.round((100 * w.approved.length) / (w.approved.length + w.declined.length))}%` : "—");

  const headlineTitle = "1. FINANCING HEADLINES";
  const headlineRows: [string, string, string][] = [
    ["Requests submitted", nAmt(W.submitted, req), nAmt(M.submitted, req)],
    ["Final approvals", nAmt(W.approved, (x) => x.approvedKobo), nAmt(M.approved, (x) => x.approvedKobo)],
    ["Disbursed", nAmt(W.disbursed, (x) => x.disbursedKobo), nAmt(M.disbursed, (x) => x.disbursedKobo)],
    ["Declined", String(W.declined.length), String(M.declined.length)],
    ["Approval rate (approved ÷ decided)", rate(W), rate(M)],
    ["Avg. turnaround to final approval", hrs(avgTurn(W.approved)), hrs(avgTurn(M.approved))],
  ];

  const breakdown = (title: string, dim: "segment" | "product") => {
    const keys = [...new Set([...M.submitted, ...M.disbursed].map((x) => String(x[dim])))].sort();
    return T(
      title,
      keys.map((k) => {
        const f = (xs: FinFact[]) => xs.filter((x) => String(x[dim]) === k);
        return [k, `${f(W.submitted).length} req · ${money(sum(f(W.submitted), req))} · disb ${money(sum(f(W.disbursed), (x) => x.disbursedKobo))}`, `${f(M.submitted).length} req · ${money(sum(f(M.submitted), req))} · disb ${money(sum(f(M.disbursed), (x) => x.disbursedKobo))}`];
      }),
    );
  };

  // Pipeline now (snapshot at the send time).
  const open = (
    await q.query<{ stage: Stage; n: number; oldest_hours: number | null; overdue: number }>(
      `SELECT t.stage, count(*)::int AS n,
              round(max(extract(epoch FROM ($1::timestamptz - coalesce(t.assigned_at, t.entered_at))) / 3600)::numeric, 1)::float AS oldest_hours,
              count(*) FILTER (WHERE coalesce(t.assigned_at, t.entered_at) < $1::timestamptz - interval '3 hours')::int AS overdue
         FROM tasks t JOIN applications a ON a.id = t.application_id
        WHERE t.status = 'OPEN' AND NOT (a.stage = ANY($2::text[]))
        GROUP BY t.stage ORDER BY count(*) DESC`,
      [end, TERMINAL_STAGES],
    )
  ).rows;
  const pipelineTitle = "4. PIPELINE NOW (open tasks at the time of this report)";
  const pipelineItems = open.map((r) => `${STAGE_LABELS[r.stage] ?? r.stage}: ${r.n} open · ${r.overdue} over 3 h · oldest waiting ${hrs(r.oldest_hours)}`);

  // Approval efficiency: stage turnaround of tasks completed, SLA reminders sent.
  const stageTurn = async (a: Date) =>
    (
      await q.query<{ stage: Stage; n: number; avg: number }>(
        `SELECT stage, count(*)::int AS n, round(avg(extract(epoch FROM (completed_at - coalesce(assigned_at, entered_at))) / 3600)::numeric, 1)::float AS avg
           FROM tasks WHERE completed_at >= $1 AND completed_at < $2 GROUP BY stage`,
        [a, end],
      )
    ).rows;
  const tW = await stageTurn(p.weekStart);
  const tM = await stageTurn(p.monthStart);
  const stages = [...new Set(tM.map((r) => r.stage))].sort((x, y) => (STAGE_LABELS[x] ?? x).localeCompare(STAGE_LABELS[y] ?? y));
  const sla = async (a: Date) => Number((await q.query("SELECT count(*)::int AS n FROM sla_reminders WHERE sent_at >= $1 AND sent_at < $2", [a, end])).rows[0].n);
  const efficiencyTitle = "3. APPROVAL EFFICIENCY (tasks completed; average hours from assignment to action)";
  const efficiencyRows: [string, string, string][] = [
    ...stages.map((s): [string, string, string] => {
      const w = tW.find((r) => r.stage === s);
      const m = tM.find((r) => r.stage === s)!;
      return [STAGE_LABELS[s] ?? s, w ? `${w.n} · ${hrs(w.avg)}` : "—", `${m.n} · ${hrs(m.avg)}`];
    }),
    ["SLA reminders sent (3-hour)", String(await sla(p.weekStart)), String(await sla(p.monthStart))],
  ];

  // Controls.
  const count = async (sql: string, a: Date) => Number((await q.query(sql, [a, end])).rows[0].n);
  const exSql = "SELECT count(*)::int AS n FROM credit_exceptions WHERE raised_at >= $1 AND raised_at < $2";
  const icSql = "SELECT count(*)::int AS n FROM invoice_confirmations WHERE status = 'COMPLETED' AND completed_at >= $1 AND completed_at < $2";
  const icPending = Number((await q.query("SELECT count(*)::int AS n FROM invoice_confirmations WHERE status IN ('PENDING','PENDING_DISPATCH','DISPATCH_FAILED','RETURNED')")).rows[0].n);
  const awaiting = facts.filter((x) => x.awaitingRmConfirmation);
  const controlsTitle = "5. CONTROLS";
  const controlsRows: [string, string, string][] = [
    ["SeedFi credit-score exceptions raised", String(await count(exSql, p.weekStart)), String(await count(exSql, p.monthStart))],
    ["Invoice confirmations completed", String(await count(icSql, p.weekStart)), String(await count(icSql, p.monthStart))],
    ["Invoice confirmations pending now", String(icPending), ""],
    ["Awaiting RM disbursement confirmation now", `${awaiting.length}${awaiting.filter((x) => x.missingEvidence).length ? ` (${awaiting.filter((x) => x.missingEvidence).length} without evidence)` : ""}`, ""],
  ];

  // People.
  const top = groupFacts(M.submitted, "officer").slice(0, 5);
  const originatorItems = top.map((g, i) => `${i + 1}. ${g.key}: ${g.requests} request(s), ${money(g.requestedKobo)}`);
  const approvers = (
    await q.query<{ name: string; stage: Stage; n: number }>(
      `SELECT s.full_name AS name, d.stage, count(*)::int AS n FROM decisions d JOIN staff s ON s.id = d.actor_id
        WHERE d.created_at >= $1 AND d.created_at < $2 AND d.invalidated_at IS NULL AND d.decision_kind IN ('BUSINESS_REVIEW','CREDIT','DECLINE')
        GROUP BY 1,2 ORDER BY 3 DESC, 1 LIMIT 12`,
      [p.weekStart, end],
    )
  ).rows;
  const reviewerItems = approvers.map((r) => `${r.name} — ${STAGE_LABELS[r.stage] ?? r.stage}: ${r.n}`);

  // AltPhones and Staff Salary Advance.
  const alt = async (a: Date) =>
    (
      await q.query<{ n: number; done: number; fin: string; dp: string }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('DISBURSED','COMPLETED'))::int AS done,
                coalesce(sum(financed_kobo) FILTER (WHERE status IN ('DISBURSED','COMPLETED')), 0) AS fin, coalesce(sum(down_payment_kobo), 0) AS dp
           FROM altphones_applications WHERE NOT legacy AND status <> 'DRAFT' AND coalesce(submitted_at, created_at) >= $1 AND coalesce(submitted_at, created_at) < $2`,
        [a, end],
      )
    ).rows[0];
  const aW = await alt(p.weekStart);
  const aM = await alt(p.monthStart);
  const ssa = async (a: Date) =>
    (
      await q.query<{ sub: number; appr: number; disb: number; amt: string }>(
        `SELECT count(*) FILTER (WHERE first_submitted_at >= $1 AND first_submitted_at < $2)::int AS sub,
                count(*) FILTER (WHERE approved_at >= $1 AND approved_at < $2)::int AS appr,
                count(*) FILTER (WHERE disbursed_at >= $1 AND disbursed_at < $2)::int AS disb,
                coalesce(sum(disbursed_amount_kobo) FILTER (WHERE disbursed_at >= $1 AND disbursed_at < $2), 0) AS amt
           FROM staff_requests`,
        [a, end],
      )
    ).rows[0];
  const sW = await ssa(p.weekStart);
  const sM = await ssa(p.monthStart);
  const othersTitle = "8. ALTPHONES AND STAFF SALARY ADVANCE";
  const othersRows: [string, string, string][] = [
    ["AltPhones transactions", String(aW.n), String(aM.n)],
    ["AltPhones completed sales · financing", `${aW.done} · ${money(Number(aW.fin))}`, `${aM.done} · ${money(Number(aM.fin))}`],
    ["AltPhones down payments", money(Number(aW.dp)), money(Number(aM.dp))],
    ["Staff Salary Advance submitted", String(sW.sub), String(sM.sub)],
    ["Staff Salary Advance approved", String(sW.appr), String(sM.appr)],
    ["Staff Salary Advance disbursed", `${sW.disb} · ${money(Number(sW.amt))}`, `${sM.disb} · ${money(Number(sM.amt))}`],
  ];

  // ── 9. Unit Heads and their direct reports: everything each person did (from the audit trail).
  const unitHeads = (
    await q.query<{ id: string; name: string }>(
      `SELECT DISTINCT s.id, s.full_name AS name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'UNIT_HEAD'
        WHERE s.status = 'ACTIVE' ORDER BY s.full_name`,
    )
  ).rows;
  const reportsOf = async (uh: string) =>
    (
      await q.query<{ id: string; name: string; roles: string[] }>(
        `SELECT s.id, s.full_name AS name, coalesce(array_agg(DISTINCT ra.role) FILTER (WHERE ra.role IS NOT NULL), '{}') AS roles
           FROM staff s LEFT JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
          WHERE s.status = 'ACTIVE' AND s.id <> $1 AND (
                s.id IN (SELECT staff_id FROM org_links WHERE manager_id = $1 AND relation = 'UNIT_HEAD')
             OR s.id IN (SELECT c.staff_id FROM routing_assignments x JOIN rm_classifications c ON c.segment = 'DBC'
                          AND c.dbc_region = CASE x.key WHEN 'DBC_UNIT_HEAD_NORTH' THEN 'NORTH' WHEN 'DBC_UNIT_HEAD_SOUTH_WEST' THEN 'SOUTH_WEST' END
                          WHERE x.staff_id = $1))
          GROUP BY s.id, s.full_name ORDER BY s.full_name`,
        [uh],
      )
    ).rows;
  const teams = new Map<string, Awaited<ReturnType<typeof reportsOf>>>();
  for (const u of unitHeads) teams.set(u.id, await reportsOf(u.id));
  const NOISE = "(VIEW|VIEWED|DOWNLOAD|LOGIN|LOGOUT|SESSION|SCAN|ASSIGNED|STAGE_CHANGED|VERIFIED|ACCESS_DENIED|OTP|ONBOARDING|EXPORTED)";
  const DECISION = "^(TASK_(APPROVE|ENDORSE|RECOMMEND|PROCEED|REJECT|RETURN)|(ALTPHONES|STAFF_FIN)_.*(APPROVE|APPROVED|DECLINE|DECLINED|RETURN|RETURNED|FORWARD))$";
  // Everyone's activity (all staff), so that every person can be registered in exactly one place below.
  const activity = async (a: Date) =>
    (
      await q.query<{ actor_id: string; action: string; n: number }>(
        `SELECT e.actor_id, e.action, count(*)::int AS n FROM audit_events e JOIN staff s ON s.id = e.actor_id
          WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND e.outcome = 'SUCCESS' AND e.action !~ $3
          GROUP BY 1, 2`,
        [a, end, NOISE],
      )
    ).rows;
  const actW = await activity(p.weekStart);
  const actM = await activity(p.monthStart);
  const openNow = (
    await q.query<{ assignee_id: string; n: number; overdue: number }>(
      `SELECT t.assignee_id, count(*)::int AS n, count(*) FILTER (WHERE coalesce(t.assigned_at, t.entered_at) < $1::timestamptz - interval '3 hours')::int AS overdue
         FROM tasks t WHERE t.status = 'OPEN' AND t.assignee_id IS NOT NULL GROUP BY 1`,
      [end],
    )
  ).rows;
  const altBy = async (a: Date) =>
    (
      await q.query<{ originator_id: string; n: number }>(
        `SELECT originator_id, count(*)::int AS n FROM altphones_applications
          WHERE NOT legacy AND status <> 'DRAFT' AND coalesce(submitted_at, created_at) >= $1 AND coalesce(submitted_at, created_at) < $2 GROUP BY 1`,
        [a, end],
      )
    ).rows;
  const altW = await altBy(p.weekStart);
  const altM = await altBy(p.monthStart);
  const decisionRe = new RegExp(DECISION);
  const cellFor = (id: string, w: Window, acts: { actor_id: string; action: string; n: number }[], alts: { originator_id: string; n: number }[]) => {
    const mine = w.submitted.filter((x) => x.officerId === id);
    const disb = w.disbursed.filter((x) => x.officerId === id);
    const a = acts.filter((x) => x.actor_id === id);
    const decisions = a.filter((x) => decisionRe.test(x.action)).reduce((t, x) => t + x.n, 0);
    const total = a.reduce((t, x) => t + x.n, 0);
    const phones = alts.find((x) => x.originator_id === id)?.n ?? 0;
    const parts = [] as string[];
    if (mine.length) parts.push(`${mine.length} req ${money(sum(mine, req))}`);
    if (disb.length) parts.push(`disb ${money(sum(disb, (x) => x.disbursedKobo))}`);
    if (phones) parts.push(`${phones} AltPhones`);
    parts.push(`${decisions} decision${decisions === 1 ? "" : "s"}`, `${total} action${total === 1 ? "" : "s"}`);
    return parts.join(" · ");
  };
  const actionLabel = (code: string) =>
    code.replace(/^TASK_/, "").replace(/^STAFF_FIN_/, "Salary advance ").replace(/^ALTPHONES_/, "AltPhones ").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  const topActions = (id: string) =>
    actW
      .filter((x) => x.actor_id === id)
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map((x) => `${actionLabel(x.action)} ×${x.n}`)
      .join(", ");
  const openLabel = (id: string) => {
    const o = openNow.find((x) => x.assignee_id === id);
    return o ? ` — ${o.n} open now${o.overdue ? `, ${o.overdue} over 3 h` : ""}` : "";
  };
  const roleName = (roles: string[]) => roles.map((r) => ROLE_LABELS[r as Role] ?? r).join(", ") || "No active role";
  type Person = { id: string; name: string; roles: string[] };
  // Every Relationship Manager is shown with their classification, so DBC and Non-DBC work is always distinguishable.
  const segOf = new Map(
    (await q.query<{ staff_id: string; segment: string; dbc_region: string | null }>("SELECT staff_id, segment, dbc_region FROM rm_classifications")).rows.map((r) => [
      r.staff_id,
      r.segment === "NON_DBC" ? "Non-DBC" : `DBC ${r.dbc_region === "NORTH" ? "North" : "South & West"}`,
    ]),
  );
  const personLabel = (m: Person) => `${m.name} (${roleName(m.roles)}${m.roles.includes("RM") ? ` · ${segOf.get(m.id) ?? "not yet classified"}` : ""})`;
  /** Who has been registered in a section already (each person appears under one leader at most once per section). */
  const listed = new Set<string>();
  /** A leader's table: their own work first (if any), then each member, with each person's most frequent actions. */
  const teamTable = (title: string, leader: { id: string; name: string; label: string } | null, members: Person[], emptyNote: string) => {
    const rows: [string, string, string][] = [
      ...(leader ? [[`${leader.name} (${leader.label}, own work)${openLabel(leader.id)}`, cellFor(leader.id, W, actW, altW), cellFor(leader.id, M, actM, altM)] as [string, string, string]] : []),
      ...members.map((m): [string, string, string] => [`${personLabel(m)}${openLabel(m.id)}`, cellFor(m.id, W, actW, altW), cellFor(m.id, M, actM, altM)]),
    ];
    if (leader) listed.add(leader.id);
    members.forEach((m) => listed.add(m.id));
    const lines = T(title, rows);
    const who = [...(leader ? [{ id: leader.id, name: leader.name }] : []), ...members];
    const notes = [...(members.length ? [] : [emptyNote]), ...who.map((m) => (topActions(m.id) ? `${m.name} this week: ${topActions(m.id)}` : "")).filter(Boolean)];
    if (notes.length) html.push(`<p style="margin:6px 0 0;font:12px/1.6 Arial,Helvetica,sans-serif;color:#5f6c87">${notes.map(esc).join("<br>")}</p>`);
    return [...lines.slice(0, -1), ...notes.map((n) => `  ${n}`), ""];
  };
  const unitSections: (() => string[])[] = unitHeads.map((u, i) => () => {
    const team = teams.get(u.id) ?? [];
    return teamTable(`9.${i + 1} ${u.name}, Unit Head (${team.length} direct report${team.length === 1 ? "" : "s"})`, { id: u.id, name: u.name, label: "Unit Head" }, team, "No direct reports are mapped yet (Administration → Reporting lines, or RM classification for DBC Unit Heads).");
  });

  // ── 10. Non-DBC: each Regional Business Executive and the Relationship Managers assigned to them.
  const staffWithRoles = async (where: string, params: unknown[]) =>
    (
      await q.query<Person>(
        `SELECT s.id, s.full_name AS name, coalesce(array_agg(DISTINCT ra.role) FILTER (WHERE ra.role IS NOT NULL), '{}') AS roles
           FROM staff s LEFT JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
          WHERE s.status = 'ACTIVE' AND (${where}) GROUP BY s.id, s.full_name ORDER BY s.full_name`,
        params,
      )
    ).rows;
  const rbes = await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role = 'RBE' AND active)", []);
  const rbeTeams = new Map<string, Person[]>();
  for (const r of rbes) rbeTeams.set(r.id, await staffWithRoles("s.id IN (SELECT staff_id FROM org_links WHERE manager_id = $1 AND relation = 'RBE')", [r.id]));
  const unclassified = await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role = 'RM' AND active) AND s.id NOT IN (SELECT staff_id FROM rm_classifications)", []);
  const nonDbcLine = (w: Window) => {
    const f = (xs: FinFact[]) => xs.filter((x) => x.segment === "Non-DBC");
    return `${f(w.submitted).length} req · ${money(sum(f(w.submitted), req))} · ${f(w.approved).length} approved · disb ${money(sum(f(w.disbursed), (x) => x.disbursedKobo))}`;
  };
  const nonDbcSections = () => [
    ...T("10. NON-DBC BUSINESS (Relationship Managers outside DBC, reviewed by their RBE)", [["Non-DBC total", nonDbcLine(W), nonDbcLine(M)]]),
    ...(rbes.length
      ? rbes.flatMap((r, i) => {
          const team = rbeTeams.get(r.id) ?? [];
          return teamTable(`10.${i + 1} ${r.name}, Regional Business Executive (${team.length} RM${team.length === 1 ? "" : "s"})`, { id: r.id, name: r.name, label: "RBE" }, team, "No Relationship Managers are assigned to this RBE yet (Configuration centre → RM classification and routing).");
        })
      : L("10.1 Regional Business Executives", [], "No active Regional Business Executives.")),
    ...(unclassified.length
      ? teamTable(`10.${rbes.length + 1} Relationship Managers not yet classified as DBC or Non-DBC (${unclassified.length})`, null, unclassified, "")
      : []),
  ];

  // ── 11. Merchant Officer line: each Head, their Leads and the Leads' officers.
  const moHeads = await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role = 'MERCHANT_OFFICER_HEAD' AND active)", []);
  const moSections = async () => {
    const out: string[] = [];
    let i = 0;
    for (const h of moHeads) {
      const leads = await staffWithRoles("s.id IN (SELECT staff_id FROM org_links WHERE manager_id = $1 AND relation = 'MO_HEAD')", [h.id]);
      const officers = leads.length ? await staffWithRoles("s.id IN (SELECT staff_id FROM org_links WHERE manager_id = ANY($1::uuid[]) AND relation = 'MO_LEAD')", [leads.map((l) => l.id)]) : [];
      out.push(...teamTable(`11.${++i} ${h.name}, Merchant Officer Head (${leads.length} Lead${leads.length === 1 ? "" : "s"}, ${officers.length} officer${officers.length === 1 ? "" : "s"})`, { id: h.id, name: h.name, label: "Merchant Officer Head" }, [...leads, ...officers], "No Leads are mapped to this Head yet (Administration → Reporting lines)."));
    }
    const unmapped = (await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role IN ('MERCHANT_OFFICER','MERCHANT_OFFICER_LEAD') AND active)", [])).filter((x) => !listed.has(x.id));
    if (unmapped.length) out.push(...teamTable(`11.${++i} Merchant Officers and Leads without a reporting line (${unmapped.length})`, null, unmapped, ""));
    return out.length ? out : L("11. MERCHANT OFFICER LINE", [], "No Merchant Officer Head or officers.");
  };

  // ── 12. Everyone else who did work in the month (credit, CX, operations, AltPhones, support …), so nobody is left out.
  const otherSection = async () => {
    const active = [...new Set(actM.map((x) => x.actor_id))].filter((id) => !listed.has(id));
    const people = active.length ? await staffWithRoles("s.id = ANY($1::uuid[])", [active]) : [];
    people.sort((a, b) => roleName(a.roles).localeCompare(roleName(b.roles)) || a.name.localeCompare(b.name));
    return teamTable(`12. EVERYONE ELSE WHO WORKED ON ARAF THIS MONTH (${people.length})`, null, people, "Nobody else recorded work this month.");
  };

  const link = `${config.appUrl}/reports/performance?from=${p.fromMonth}&to=${p.to}`;
  const summary = {
    week: { submitted: W.submitted.length, submittedKobo: sum(W.submitted, req), approved: W.approved.length, disbursed: W.disbursed.length, disbursedKobo: sum(W.disbursed, (x) => x.disbursedKobo), declined: W.declined.length },
    month: { submitted: M.submitted.length, submittedKobo: sum(M.submitted, req), approved: M.approved.length, disbursed: M.disbursed.length, disbursedKobo: sum(M.disbursed, (x) => x.disbursedKobo), declined: M.declined.length },
  };
  html.length = 0; // render in reading order
  const body = [
    ...T(headlineTitle, headlineRows),
    ...breakdown("2a. BY BUSINESS LINE (requests · amount requested · amount disbursed)", "segment"),
    ...breakdown("2b. BY PRODUCT (requests · amount requested · amount disbursed)", "product"),
    ...T(efficiencyTitle, efficiencyRows),
    ...L(pipelineTitle, pipelineItems, "No open tasks."),
    ...T(controlsTitle, controlsRows),
    ...L("6. TOP ORIGINATORS (month to date, by amount requested)", originatorItems, "None."),
    ...L("7. REVIEW AND APPROVAL DECISIONS THIS WEEK (by person)", reviewerItems, "None."),
    ...T(othersTitle, othersRows),
    ...(unitHeads.length
      ? [
          ...L("9. UNIT HEADS AND THEIR DIRECT REPORTS", ["Sections 9 to 12 register what every person did. For each person: requests originated and amount, amount disbursed, AltPhones sales, decisions (approvals, endorsements, recommendations, returns, declines) and all work actions recorded in the audit trail, this week and month to date; open tasks now."], ""),
          ...unitSections.flatMap((f) => f()),
        ]
      : L("9. UNIT HEADS AND THEIR DIRECT REPORTS", [], "No active Unit Heads.")),
    ...nonDbcSections(),
    ...L("11. MERCHANT OFFICER LINE", ["Each Merchant Officer Head, their Leads and the Leads' officers."], ""),
    ...(await moSections()),
    ...(await otherSection()),
    `Full interactive report (month to date, drill down by business line, Unit Head / RBE, product, officer, location and facility): ${link}`,
  ];
  html.push(`<p style="margin:24px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#1d438e;color:#ffffff;text-decoration:none;font:600 13px Arial,Helvetica,sans-serif;padding:10px 16px;border-radius:8px">Open the Performance Overview</a></p>`);
  void now;
  return { body, summary, html: html.join("") };
}

/** The HTML email: a simple, table-based layout that renders in Outlook and on phones. */
export function dhEmailHtml(name: string, p: DhPeriod, time: string, sections: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f7f9ff"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f9ff"><tr><td style="padding:24px 8px">
<table role="presentation" cellspacing="0" cellpadding="0" style="max-width:800px;margin:0 auto;background:#ffffff;border:1px solid #dee5f3;border-radius:12px"><tr><td style="padding:24px 24px 28px">
<p style="margin:0 0 4px;font:600 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#5f6c87">Retail Asset Factory · Weekly report</p>
<h1 style="margin:0 0 12px;font:700 20px/1.3 Arial,Helvetica,sans-serif;color:#152b59">Week ${esc(p.weekLabel)} and ${esc(p.monthLabel.split(" (")[0])}</h1>
<p style="margin:0 0 4px;font:14px/1.5 Arial,Helvetica,sans-serif;color:#2b3f69">Dear ${esc(name)},</p>
<p style="margin:0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#2b3f69">Here is the bank-wide report as at ${esc(time)} on Sunday (Africa/Lagos). Amounts are in naira; each facility is counted once, credited to its originator.</p>
${sections}
</td></tr></table>
<p style="max-width:800px;margin:12px auto 0;font:12px Arial,Helvetica,sans-serif;color:#5f6c87;text-align:center">A platform by The Alternative Bank. Internal use only.</p>
</td></tr></table></body></html>`;
}

// ─────────────────────────── the scheduled run ───────────────────────────

export async function runDhWeeklyReport(now = new Date()): Promise<{ ran: boolean; sent: number; period: string | null }> {
  const s = (await db.query("SELECT * FROM schedule_settings WHERE code = $1", [DH_CODE])).rows[0];
  if (!s?.enabled) return { ran: false, sent: 0, period: null };
  const p = duePeriod(now, s.hour ?? 18, s.minute ?? 0);
  if (!p) return { ran: false, sent: 0, period: null };
  return withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedule:${DH_CODE}`]);
    await tx.query(
      "INSERT INTO schedule_runs (code, period_key, period_start, period_end, started_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code, period_key) DO NOTHING",
      [DH_CODE, p.key, p.monthStart, p.sendAt, now],
    );
    const run = (await tx.query("SELECT * FROM schedule_runs WHERE code = $1 AND period_key = $2", [DH_CODE, p.key])).rows[0];
    if (run.status === "DONE") return { ran: false, sent: 0, period: p.key };
    // Everyone profiled as Divisional Head, plus any extra recipients the Super Admin added.
    const recipients = (
      await tx.query<{ id: string; email: string; full_name: string }>(
        `SELECT DISTINCT s.id, s.email, s.full_name FROM staff s LEFT JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'DIVISIONAL_HEAD'
          WHERE s.status = 'ACTIVE' AND (ra.staff_id IS NOT NULL OR s.id = ANY($1::uuid[])) ORDER BY s.full_name`,
        [s.recipient_staff_ids ?? []],
      )
    ).rows;
    const { body, summary, html } = await buildDhReport(tx, p, now);
    let sent = 0;
    for (const r of recipients) {
      const del = await tx.query<{ id: string }>(
        `INSERT INTO digest_deliveries (run_id, code, period_key, recipient_id, summary, created_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code, period_key, recipient_id) DO NOTHING RETURNING id`,
        [run.id, DH_CODE, p.key, r.id, JSON.stringify(summary), now],
      );
      if (!del.rowCount) continue;
      const out = await enqueueEmail(tx, now, {
        kind: DH_CODE,
        dedupeKey: `dh-weekly:${p.key}:${r.id}`,
        to: [r.email],
        subject: `Retail Asset Factory weekly report: week ${p.weekLabel} and ${p.monthLabel.split(" (")[0]}`,
        html: dhEmailHtml(r.full_name, p, `${String(s.hour ?? 18).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")}`, html),
        text: simpleEmail([
          `Dear ${r.full_name},`,
          "",
          `Here is the bank-wide Retail Asset Factory report for the week ${p.weekLabel} and for ${p.monthLabel}, as at ${String(s.hour ?? 18).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")} on Sunday (Africa/Lagos).`,
          "Amounts are in naira; counts are facilities. Each facility is counted once, credited to its originator.",
          "",
          ...body,
        ]),
      });
      await tx.query("UPDATE digest_deliveries SET outbox_id = $2 WHERE id = $1", [del.rows[0].id, out.id]);
      sent++;
    }
    await tx.query("UPDATE schedule_runs SET status = 'DONE', finished_at = $2 WHERE id = $1", [run.id, now]);
    await audit(tx, systemCtx(now), { action: "DH_WEEKLY_REPORT_RUN", details: { period: p.key, recipients: recipients.length, sent } });
    return { ran: true, sent, period: p.key };
  });
}

