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
import { financingFacts, type FinFact } from "../performance-report";
import { addDaysToDateString, fromLagos, lagosDate, lagosWeekStart } from "../time";
import { CATCH_UP_MS } from "./schedules";
import type { Ctx } from "../context";
import { forbidden, invalid } from "../errors";
import { briefingHtml, briefingSubject, briefingText, computeBriefing, sendPersonalBriefings } from "./briefing";
import { holdsRole } from "../domain/access";

export const DH_CODE = "DH_WEEKLY_REPORT";
export const TEAM_CODE = "TEAM_WEEKLY_REPORT";

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
/** Column headings on narrow screens. */
const SHORT_HEAD: Record<string, string> = { Requests: "Req", Requested: "Req ₦", Disbursed: "Disb ₦", AltPhones: "Alt", Decisions: "Dec", Actions: "Act" };
/** Short naira for narrow screens: ₦950k, ₦77.0m, ₦2.33bn. */
const shortNaira = (k: number) => {
  const n = k / 100;
  if (n >= 1e9) return `₦${(n / 1e9).toFixed(2)}bn`;
  if (n >= 1e6) return `₦${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `₦${Math.round(n / 1e3)}k`;
  return `₦${Math.round(n)}`;
};
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
  let html: string[] = [];
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
  const othersTitle = "7. ALTPHONES AND STAFF SALARY ADVANCE";
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
  interface Stats {
    req: number;
    reqK: number;
    disbK: number;
    phones: number;
    dec: number;
    act: number;
  }
  const statsFor = (id: string, w: Window, acts: { actor_id: string; action: string; n: number }[], alts: { originator_id: string; n: number }[]): Stats => {
    const mine = w.submitted.filter((x) => x.officerId === id);
    const a = acts.filter((x) => x.actor_id === id);
    return {
      req: mine.length,
      reqK: sum(mine, req),
      disbK: sum(w.disbursed.filter((x) => x.officerId === id), (x) => x.disbursedKobo),
      phones: alts.find((x) => x.originator_id === id)?.n ?? 0,
      dec: a.filter((x) => decisionRe.test(x.action)).reduce((t, x) => t + x.n, 0),
      act: a.reduce((t, x) => t + x.n, 0),
    };
  };
  const addStats = (xs: Stats[]): Stats => xs.reduce((t, x) => ({ req: t.req + x.req, reqK: t.reqK + x.reqK, disbK: t.disbK + x.disbK, phones: t.phones + x.phones, dec: t.dec + x.dec, act: t.act + x.act }), { req: 0, reqK: 0, disbK: 0, phones: 0, dec: 0, act: 0 });
  /** A people table of figures: per person a name row, then This week and Month to date rows; team total last. */
  const numTable = (title: string, entries: { label: string; w: Stats; m: Stats }[], emptyNote: string, total?: { label: string; w: Stats; m: Stats }) => {
    const phones = entries.some((e) => e.w.phones || e.m.phones);
    const head = ["", "Requests", "Requested", "Disbursed", ...(phones ? ["AltPhones"] : []), "Decisions", "Actions"];
    const fig = (x: Stats) => [String(x.req), money(x.reqK), money(x.disbK), ...(phones ? [String(x.phones)] : []), String(x.dec), String(x.act)];
    // On phones the money columns show a short form (₦77.0m); the exact amount is shown everywhere else.
    const figHtml = (x: Stats) => fig(x).map((v, i) => (i === 1 || i === 2 ? `<span class="nfull">${esc(v)}</span><span class="nshort" style="display:none;max-height:0;overflow:hidden">${esc(shortNaira(i === 1 ? x.reqK : x.disbK))}</span>` : esc(v)));
    const totalRow = total ?? (entries.length > 1 ? { label: "TEAM TOTAL", w: addStats(entries.map((e) => e.w)), m: addStats(entries.map((e) => e.m)) } : null);
    const all = totalRow ? [...entries, totalRow] : entries;
    // HTML
    const C = "padding:5px 6px;border-bottom:1px solid #eef2f9;font:12px/1.35 Arial,Helvetica,sans-serif;color:#152b59;text-align:right;white-space:nowrap";
    const NAME = "padding:9px 6px 3px;font:600 12.5px/1.35 Arial,Helvetica,sans-serif;color:#152b59;text-align:left";
    const PER = "padding:5px 6px;border-bottom:1px solid #eef2f9;font:12px/1.35 Arial,Helvetica,sans-serif;color:#5f6c87;text-align:left;white-space:nowrap";
    html.push(H2(title));
    if (!entries.length) html.push(`<p style="font:13px Arial,sans-serif;color:#5f6c87">${esc(emptyNote)}</p>`);
    else
      html.push(
        `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:760px"><tr>${head
          .map((h, i) => `<th class="nx" style="${TH};${i ? "text-align:right;" : ""}padding:6px;white-space:nowrap"><span class="nfull">${esc(h)}</span><span class="nshort" style="display:none;max-height:0;overflow:hidden">${esc(SHORT_HEAD[h] ?? h)}</span></th>`)
          .join("")}</tr>${all
          .map((e) => {
            const total = e === totalRow;
            const bg = total ? "background:#f3f6fc;" : "";
            return `<tr><td colspan="${head.length}" style="${NAME};${bg}${total ? "border-top:2px solid #c4cee2" : ""}">${esc(e.label)}</td></tr>${(
              [
                ["Week", e.w],
                ["MTD", e.m],
              ] as const
            )
              .map(([per, st]) => `<tr><td class="nx" style="${PER};${bg}">${per}</td>${figHtml(st).map((v) => `<td class="nx" style="${C};${bg}${total ? "font-weight:700" : ""}">${v}</td>`).join("")}</tr>`)
              .join("")}`;
          })
          .join("")}</table>`,
      );
    if (entries.length && emptyNote) html.push(`<p style="margin:6px 0 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:#5f6c87">${esc(emptyNote)}</p>`);
    // Text
    const rows = all.flatMap((e) => [[e.label], ["  Week", ...fig(e.w)], ["  MTD", ...fig(e.m)]]);
    const widths = head.map((h, i) => Math.max(h.length, ...rows.filter((r) => r.length > 1).map((r) => (r[i] ?? "").length)));
    const line = (r: string[]) => "  " + r.map((v, i) => (i ? v.padStart(widths[i]) : v.padEnd(widths[0]))).join("  ");
    return [title, ...(entries.length ? [line(head), ...rows.map((r) => (r.length === 1 ? `  ${r[0]}` : line(r)))] : [`  ${emptyNote}`]), ...(entries.length && emptyNote ? [`  ${emptyNote}`] : []), ""];
  };
  const openLabel = (id: string) => {
    const o = openNow.find((x) => x.assignee_id === id);
    return o ? ` · ${o.n} open now${o.overdue ? ` (${o.overdue} over 3 h)` : ""}` : "";
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
  const personLabel = (m: Person) => `${m.name} — ${roleName(m.roles)}${m.roles.includes("RM") ? ` · ${segOf.get(m.id) ?? "not yet classified"}` : ""}`;
  const staffWithRoles = async (where: string, params: unknown[]) =>
    (
      await q.query<Person & { email: string }>(
        `SELECT s.id, s.full_name AS name, s.email, coalesce(array_agg(DISTINCT ra.role) FILTER (WHERE ra.role IS NOT NULL), '{}') AS roles
           FROM staff s LEFT JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
          WHERE s.status = 'ACTIVE' AND (${where}) GROUP BY s.id, s.full_name, s.email ORDER BY s.full_name`,
        params,
      )
    ).rows;
  const both = (ids: string[]) => ({ w: addStats(ids.map((id) => statsFor(id, W, actW, altW))), m: addStats(ids.map((id) => statsFor(id, M, actM, altM))) });
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // ── Units: every team, cumulatively (the Divisional Head's view). Each person's work is counted in their unit.
  const units: { label: string; ids: string[] }[] = [];
  for (const u of unitHeads) {
    const team = teams.get(u.id) ?? [];
    units.push({ label: `${u.name}'s unit — Unit Head + ${plural(team.length, "direct report")}`, ids: [u.id, ...team.map((m) => m.id)] });
  }
  const rbes = await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role = 'RBE' AND active)", []);
  for (const r of rbes) {
    const team = await staffWithRoles("s.id IN (SELECT staff_id FROM org_links WHERE manager_id = $1 AND relation = 'RBE')", [r.id]);
    units.push({ label: `${r.name}'s Non-DBC team — RBE + ${plural(team.length, "Relationship Manager")}`, ids: [r.id, ...team.map((m) => m.id)] });
  }
  const unclassified = await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role = 'RM' AND active) AND s.id NOT IN (SELECT staff_id FROM rm_classifications)", []);
  if (unclassified.length) units.push({ label: `Relationship Managers not yet classified as DBC or Non-DBC (${unclassified.length})`, ids: unclassified.map((m) => m.id) });
  const moHeads = await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role = 'MERCHANT_OFFICER_HEAD' AND active)", []);
  const inMo = new Set<string>();
  for (const h of moHeads) {
    const leads = await staffWithRoles("s.id IN (SELECT staff_id FROM org_links WHERE manager_id = $1 AND relation = 'MO_HEAD')", [h.id]);
    const officers = leads.length ? await staffWithRoles("s.id IN (SELECT staff_id FROM org_links WHERE manager_id = ANY($1::uuid[]) AND relation = 'MO_LEAD')", [leads.map((l) => l.id)]) : [];
    const ids = [h.id, ...leads.map((m) => m.id), ...officers.map((m) => m.id)];
    ids.forEach((x) => inMo.add(x));
    units.push({ label: `${h.name}'s Merchant Officer line — Head + ${plural(leads.length, "Lead")} + ${plural(officers.length, "officer")}`, ids });
  }
  const moLoose = (await staffWithRoles("s.id IN (SELECT staff_id FROM role_assignments WHERE role IN ('MERCHANT_OFFICER','MERCHANT_OFFICER_LEAD') AND active)", [])).filter((x) => !inMo.has(x.id));
  if (moLoose.length) units.push({ label: `Merchant Officers and Leads without a reporting line (${moLoose.length})`, ids: moLoose.map((m) => m.id) });
  // Everyone else who worked this month, by function.
  const inUnits = new Set(units.flatMap((u) => u.ids));
  const restIds = [...new Set(actM.map((x) => x.actor_id))].filter((id) => !inUnits.has(id));
  const rest = restIds.length ? await staffWithRoles("s.id = ANY($1::uuid[])", [restIds]) : [];
  const FUNCTIONS: [string, string[]][] = [
    ["Credit (Credit Officers, Credit Leads, CX)", ["CREDIT_OFFICER_1", "CREDIT_OFFICER_2", "CREDIT_OFFICER_3", "CREDIT_LEAD_1", "CREDIT_LEAD_2", "CX_CREDIT_REVIEWER"]],
    ["Operations (disbursement, invoice confirmation, vendors, collections)", ["DISBURSEMENT_OFFICER_1", "DISBURSEMENT_OFFICER_2", "INVOICE_CONFIRMATION_OFFICER", "VENDOR_MANAGER", "COLLECTIONS_OFFICER"]],
    ["Retail business review (Team Leads, Head of Retail Sales, Head of Unit, OSS)", ["TEAM_LEAD", "HEAD_OF_RETAIL_SALES", "HEAD_OF_UNIT", "OUTLET_SERVICE_SUPERVISOR"]],
    ["AltPhones (Delight Officers, Smile Associates, BPMs, Product Manager)", ["DELIGHT_OFFICER", "SMILE_ASSOCIATE", "BUSINESS_PERFORMANCE_MANAGER", "ALTPHONES_PRODUCT_MANAGER"]],
    ["Agency banking (ANMs and ANM Leads)", ["ANM", "ANM_LEAD_NORTH", "ANM_LEAD_SOUTH"]],
    ["Relationship Managers (DBC, not mapped to a unit)", ["RM"]],
    ["Staff Salary Advance (Product Manager, staff applicants)", ["PRODUCT_MANAGER", "STAFF_APPLICANT"]],
    ["Management, administration and control", ["DIVISIONAL_HEAD", "UNIT_HEAD", "SUPER_ADMIN", "REPORTING_ADMIN", "EXECUTIVE_VIEW", "PRODUCT_CONFIG_APPROVER", "LEGAL_REVIEWER", "SHARIAH_REVIEWER"]],
  ];
  const byFn = new Map<string, string[]>();
  for (const person of rest) {
    const fn = FUNCTIONS.find(([, roles]) => roles.some((r) => person.roles.includes(r)))?.[0] ?? "Other staff";
    byFn.set(fn, [...(byFn.get(fn) ?? []), person.id]);
  }
  for (const [fn] of [...FUNCTIONS, ["Other staff", []] as [string, string[]]]) {
    const ids = byFn.get(fn);
    if (ids?.length) units.push({ label: `${fn} — ${plural(ids.length, "person", "people")}`, ids });
  }
  const everyone = [...new Set(units.flatMap((u) => u.ids))];
  const overlap = units.reduce((t, u) => t + u.ids.length, 0) > everyone.length;
  const unitsSection = () =>
    numTable(
      "8. UNITS AND TEAMS — CUMULATIVE FIGURES",
      units.map((u) => ({ label: u.label, ...both(u.ids) })),
      units.length ? unitsNote : "No units or staff activity recorded.",
      { label: `ALL STAFF — ${plural(everyone.length, "person", "people")}, each counted once`, ...both(everyone) },
    );
  const unitsNote = `Each row adds up everyone in that unit or team: requests they originated, amounts requested and disbursed, AltPhones sales, decisions (approvals, endorsements, recommendations, returns, declines) and all work actions in the audit trail. Week = this week; MTD = month to date.${overlap ? " A person in two teams (for example a Unit Head's report who is also under an RBE) appears in both rows, so add the ALL STAFF row, not the rows, for the overall total." : ""} Individual figures go to each Unit Head and Team Lead in their own Sunday email.`;

  // ── Individual team reports for each Unit Head and each Team Lead.
  const teamReports: { recipient: { id: string; name: string; email: string }; subject: string; title: string; body: string[]; html: string }[] = [];
  const teamReport = (leader: { id: string; name: string; email: string }, leaderLabel: string, members: Person[], emptyNote: string) => {
    const main = html;
    html = [];
    const entries = [
      { id: leader.id, label: `${leader.name} — ${leaderLabel}, own work` },
      ...members.map((m) => ({ id: m.id, label: personLabel(m) })),
    ].map((e) => ({ label: `${e.label}${openLabel(e.id)}`, w: statsFor(e.id, W, actW, altW), m: statsFor(e.id, M, actM, altM) }));
    const body = numTable(`YOUR TEAM — ${plural(members.length, "person", "people")} plus you`, entries, members.length ? "" : emptyNote, { label: "TEAM TOTAL", ...both([leader.id, ...members.map((m) => m.id)]) });
    teamReports.push({ recipient: leader, subject: `Retail Asset Factory weekly team report: week ${p.weekLabel}`, title: `Your team, week ${p.weekLabel} and ${p.monthLabel.split(" (")[0]}`, body, html: html.join("") });
    html = main;
  };
  const uhPeople = await staffWithRoles("s.id = ANY($1::uuid[])", [unitHeads.map((u) => u.id)]);
  for (const u of uhPeople) teamReport(u, "Unit Head", teams.get(u.id) ?? [], "No direct reports are mapped to you yet. The Super Admin sets them under Administration → Reporting lines.");
  const teamLeads = (
    await q.query<{ id: string; name: string; email: string; teams: string[] }>(
      `SELECT s.id, s.full_name AS name, s.email, array_agg(DISTINCT ra.team) FILTER (WHERE ra.team IS NOT NULL) AS teams
         FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'TEAM_LEAD'
        WHERE s.status = 'ACTIVE' GROUP BY s.id, s.full_name, s.email ORDER BY s.full_name`,
    )
  ).rows;
  for (const tl of teamLeads) {
    const members = tl.teams?.length
      ? await staffWithRoles("s.id <> $2 AND s.id IN (SELECT staff_id FROM role_assignments WHERE active AND role IN ('RM','DELIGHT_OFFICER') AND team = ANY($1::text[]))", [tl.teams, tl.id])
      : [];
    teamReport(tl, `Team Lead${tl.teams?.length ? ` (${tl.teams.join(", ")})` : ""}`, members, "No Relationship Managers are on your team yet.");
  }

  // ── Decisions by stage (cumulative counts).
  const decByStage = async (a: Date) =>
    (
      await q.query<{ stage: Stage; ok: number; ret: number; dec: number }>(
        `SELECT stage, count(*) FILTER (WHERE action IN ('APPROVE','ENDORSE','RECOMMEND','PROCEED'))::int AS ok,
                count(*) FILTER (WHERE action IN ('RETURN','REQUEST_INITIATOR','SEND_FOR_CORRECTION'))::int AS ret,
                count(*) FILTER (WHERE action = 'REJECT')::int AS dec
           FROM decisions WHERE created_at >= $1 AND created_at < $2 AND invalidated_at IS NULL AND decision_kind IN ('BUSINESS_REVIEW','CREDIT','DECLINE','CORRECTION')
          GROUP BY stage`,
        [a, end],
      )
    ).rows;
  const dW = await decByStage(p.weekStart);
  const dM = await decByStage(p.monthStart);
  const dStages = [...new Set(dM.map((r) => r.stage))].sort((x, y) => (STAGE_LABELS[x] ?? x).localeCompare(STAGE_LABELS[y] ?? y));
  const dCell = (r?: { ok: number; ret: number; dec: number }) => (r ? `${r.ok} approved · ${r.ret} returned · ${r.dec} declined` : "—");
  const decisionRows: [string, string, string][] = dStages.map((st) => [STAGE_LABELS[st] ?? st, dCell(dW.find((r) => r.stage === st)), dCell(dM.find((r) => r.stage === st))]);
  const dTot = (rs: { ok: number; ret: number; dec: number }[]) => ({ ok: rs.reduce((t, r) => t + r.ok, 0), ret: rs.reduce((t, r) => t + r.ret, 0), dec: rs.reduce((t, r) => t + r.dec, 0) });
  if (dStages.length) decisionRows.push(["All stages", dCell(dTot(dW)), dCell(dTot(dM))]);

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
    ...T("6. DECISIONS BY STAGE (approvals, returns and declines)", decisionRows),
    ...T(othersTitle, othersRows),
    ...unitsSection(),
    `Full interactive report (month to date, drill down by business line, Unit Head / RBE, product, officer, location and facility): ${link}`,
  ];
  html.push(`<p style="margin:24px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#1d438e;color:#ffffff;text-decoration:none;font:600 13px Arial,Helvetica,sans-serif;padding:10px 16px;border-radius:8px">Open the Performance Overview</a></p>`);
  void now;
  return { body, summary, html: html.join(""), teamReports };
}

/** The HTML email: a simple, table-based layout that renders in Outlook and on phones. */
export function dhEmailHtml(name: string, p: DhPeriod, time: string, sections: string, opts: { heading?: string; intro?: string } = {}) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>@media only screen and (max-width:480px){.nx{font-size:10.5px !important;padding:4px 2px !important}.card{padding:18px 10px 22px !important}.nfull{display:none !important}.nshort{display:inline !important;max-height:none !important}}</style></head><body style="margin:0;padding:0;background:#f7f9ff"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f9ff"><tr><td style="padding:24px 8px">
<table role="presentation" cellspacing="0" cellpadding="0" style="max-width:800px;margin:0 auto;background:#ffffff;border:1px solid #dee5f3;border-radius:12px"><tr><td class="card" style="padding:24px 24px 28px">
<p style="margin:0 0 4px;font:600 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#5f6c87">ARAF · Weekly Performance Briefing</p>
<h1 style="margin:0 0 12px;font:700 20px/1.3 Arial,Helvetica,sans-serif;color:#152b59">${esc(opts.heading ?? `Week ${p.weekLabel} and ${p.monthLabel.split(" (")[0]}`)}</h1>
<p style="margin:0 0 4px;font:14px/1.5 Arial,Helvetica,sans-serif;color:#2b3f69">Dear ${esc(name)},</p>
<p style="margin:0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#2b3f69">${esc(opts.intro ?? `Here is the bank-wide report as at ${time} on Sunday (Africa/Lagos). Amounts are in naira; each facility is counted once, credited to its originator.`)}</p>
${sections}
</td></tr></table>
<p style="max-width:800px;margin:12px auto 0;font:12px Arial,Helvetica,sans-serif;color:#5f6c87;text-align:center">A platform by The Alternative Bank. Internal use only.</p>
</td></tr></table></body></html>`;
}

// ─────────────────────────── the scheduled run ───────────────────────────

/**
 * Super Admin test send: the Divisional Head report built from live data up to now (this week so far and month to
 * date), marked [TEST]. Not recorded as the weekly run, so the Sunday report still goes out as normal.
 */
export async function sendDhTestReport(ctx: Ctx, target: "DIVISIONAL_HEADS" | "ME"): Promise<{ sent: number; to: string[] }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    const now = ctx.now;
    const p = { ...dhPeriodFor(now, 18, 0), sendAt: new Date(now.getTime() + 1000) }; // up to and including now
    const recipients = (
      target === "ME"
        ? await tx.query<{ id: string; email: string; full_name: string }>("SELECT id, email, full_name FROM staff WHERE id = $1", [actor.staffId])
        : await tx.query<{ id: string; email: string; full_name: string }>(
            `SELECT DISTINCT s.id, s.email, s.full_name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'DIVISIONAL_HEAD'
              WHERE s.status = 'ACTIVE' ORDER BY s.full_name`,
          )
    ).rows;
    if (!recipients.length) throw invalid("No active Divisional Head is profiled yet. Grant the Divisional Head role first, or send the test to yourself.");
    const built = await buildDhReport(tx, p, now);
    const brief = await computeBriefing(tx, { kind: "ALL" }, p, { bouquetsForDh: "ALL" });
    const body = [...briefingText(brief), ...built.body];
    const html = briefingHtml(brief) + built.html;
    const asAt = now.toLocaleString("en-GB", { timeZone: "Africa/Lagos", weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const intro = `TEST REPORT, sent by ${actor.name} from Scheduled emails. Live figures as at ${asAt} (Africa/Lagos): this week so far and month to date. The regular report goes out on Sunday at 18:00.`;
    const stamp = now.getTime();
    for (const r of recipients) {
      await enqueueEmail(tx, now, {
        kind: "DH_WEEKLY_REPORT_TEST",
        dedupeKey: `dh-weekly-test:${stamp}:${r.id}`,
        to: [r.email],
        subject: `[TEST] ${briefingSubject(p)} (so far)`,
        html: dhEmailHtml(r.full_name, p, asAt, html, { intro }),
        text: simpleEmail([`Dear ${r.full_name},`, "", intro, "", ...body]),
      });
    }
    await audit(tx, ctx, { action: "DH_TEST_REPORT_SENT", actorRole: "SUPER_ADMIN", details: { target, recipients: recipients.map((r) => r.id) } });
    return { sent: recipients.length, to: recipients.map((r) => r.full_name) };
  });
}

export async function runDhWeeklyReport(now = new Date()): Promise<{ ran: boolean; sent: number; teamSent?: number; briefingsSent?: number; period: string | null }> {
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
    const built = await buildDhReport(tx, p, now);
    const { summary, teamReports } = built;
    // Bank-wide "Your week in review" (successful disbursements vs the previous week, bouquets) above the detail.
    const brief = await computeBriefing(tx, { kind: "ALL" }, p, { bouquetsForDh: "ALL" });
    const body = [...briefingText(brief), ...built.body];
    const html = briefingHtml(brief) + built.html;
    const time = `${String(s.hour ?? 18).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")}`;
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
        subject: briefingSubject(p),
        html: dhEmailHtml(r.full_name, p, time, html),
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
    // Individual figures: each Unit Head and each Team Lead receives their own team's report.
    let teamSent = 0;
    const team = (await tx.query("SELECT enabled FROM schedule_settings WHERE code = $1", [TEAM_CODE])).rows[0];
    if (team?.enabled) {
      for (const t of teamReports) {
        const del = await tx.query<{ id: string }>(
          `INSERT INTO digest_deliveries (run_id, code, period_key, recipient_id, summary, created_at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (code, period_key, recipient_id) DO NOTHING RETURNING id`,
          [run.id, TEAM_CODE, p.key, t.recipient.id, JSON.stringify({ people: t.body.length }), now],
        );
        if (!del.rowCount) continue;
        const intro = `Here are the figures for you and each person in your team, as at ${time} on Sunday (Africa/Lagos). Week = this week; MTD = month to date. Requests are those each person originated; Decisions are approvals, endorsements, recommendations, returns and declines; Actions are all work recorded in the audit trail.`;
        const out = await enqueueEmail(tx, now, {
          kind: TEAM_CODE,
          dedupeKey: `team-weekly:${p.key}:${t.recipient.id}`,
          to: [t.recipient.email],
          subject: t.subject,
          html: dhEmailHtml(t.recipient.name, p, time, t.html, { heading: t.title, intro }),
          text: simpleEmail([`Dear ${t.recipient.name},`, "", intro, "", ...t.body]),
        });
        await tx.query("UPDATE digest_deliveries SET outbox_id = $2 WHERE id = $1", [del.rows[0].id, out.id]);
        teamSent++;
      }
    }
    // Personal briefings for originating officers (switched on separately).
    const briefingsSent = await sendPersonalBriefings(tx, run.id, p, now);
    await tx.query("UPDATE schedule_runs SET status = 'DONE', finished_at = $2 WHERE id = $1", [run.id, now]);
    await audit(tx, systemCtx(now), { action: "DH_WEEKLY_REPORT_RUN", details: { period: p.key, recipients: recipients.length, sent, teamReports: teamSent, personalBriefings: briefingsSent } });
    return { ran: true, sent, teamSent, briefingsSent, period: p.key };
  });
}

