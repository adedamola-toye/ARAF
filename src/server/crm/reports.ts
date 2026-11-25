/**
 * CX reports: daily, weekly, monthly and on-demand. The same data drives the on-screen report, the CSV and PDF
 * exports and the scheduled email. Scheduled reports go only to active CX Heads (when ticked) and extra
 * recipients the Super Admin authorised; each period is sent once (recorded in crm_report_runs). Emails are
 * queued in the existing outbox: delivery depends on the bank's configured mail transport.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { db, withTx, type Db } from "../db";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { config } from "../config";
import { enqueueEmail } from "../notify/outbox";
import { addDaysToDateString, formatDuration, fromLagos, lagosDate, lagosParts, lagosWeekStart } from "../time";
import { crmAnalytics, officerPerformance, teamPerformance, type CrmAnalytics, type HolderPerformance, type Period } from "./analytics";
import { crmSettings, holdersOf, PRIORITY_LABELS, STATUS_LABELS, type Priority, type TicketStatus } from "./core";

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY";
export const FREQ_LABEL: Record<Frequency | "ON_DEMAND", string> = { DAILY: "Daily complaint report", WEEKLY: "Weekly operational report", MONTHLY: "Monthly CX performance report", ON_DEMAND: "CX report" };

/** The last completed period before `now` (Lagos): yesterday, last Monday–Sunday, or last calendar month. */
export function lastPeriod(freq: Frequency, now: Date): Period & { key: string } {
  const today = lagosDate(now);
  if (freq === "DAILY") {
    const d = addDaysToDateString(today, -1);
    return { from: d, to: d, key: d };
  }
  if (freq === "WEEKLY") {
    const thisMonday = lagosDate(lagosWeekStart(now));
    const from = addDaysToDateString(thisMonday, -7);
    return { from, to: addDaysToDateString(thisMonday, -1), key: from };
  }
  const p = lagosParts(now);
  const y = p.month === 1 ? p.year - 1 : p.year;
  const m = p.month === 1 ? 12 : p.month - 1;
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  return { from, to: addDaysToDateString(`${p.year}-${String(p.month).padStart(2, "0")}-01`, -1), key: from };
}

export interface CxReport {
  title: string;
  period: Period;
  generatedAt: Date;
  analytics: CrmAnalytics;
  teams: (HolderPerformance & { team_id: string; team_name: string })[];
  officers: (HolderPerformance & { officer_id: string; officer_name: string })[];
  repeat: { label: string; count: number }[];
  opportunities: string[];
}

export async function buildCxReport(q: Db, freq: Frequency | "ON_DEMAND", now = new Date(), range?: Period): Promise<CxReport> {
  const period = range ?? lastPeriod(freq === "ON_DEMAND" ? "WEEKLY" : freq, now);
  const cal = await crmSettings(q);
  const analytics = await crmAnalytics(q, period, now, cal);
  // Every active team and every active member appears, even with no tickets in the period, so the CX lead sees
  // the whole team's performance rather than only the people who happened to be assigned something.
  const teams = await teamPerformance(q, period, now);
  const officers = await officerPerformance(q, period, now);
  // Repeat complaints: the same issue raised by the same person, or about the same request, more than once in the period.
  const repeat = (
    await q.query<{ label: string; count: string }>(
      `SELECT category_name || ' — ' || subcategory_name AS label, count(*) AS count FROM crm_tickets t
        WHERE t.created_at >= ($1::date)::timestamp AT TIME ZONE 'Africa/Lagos' AND t.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Africa/Lagos')
        GROUP BY subcategory_id, category_name, subcategory_name, coalesce(application_id::text, creator_id::text) HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 10`,
      [period.from, period.to],
    )
  ).rows.map((r) => ({ label: r.label, count: Number(r.count) }));
  // Improvement opportunities are stated only from the figures above (no invented commentary).
  const opp: string[] = [];
  const top = analytics.topIssues[0];
  if (top && top.count >= 3) opp.push(`Most frequent issue: ${top.label} (${top.count}). Review the root cause and publish guidance in the knowledge base.`);
  const slowest = [...teams].filter((t) => t.avg_handling_ms !== null).sort((a, b) => (b.avg_handling_ms ?? 0) - (a.avg_handling_ms ?? 0))[0];
  if (slowest && teams.length > 1) opp.push(`Longest average handling time: ${slowest.team_name} (${formatDuration(slowest.avg_handling_ms ?? 0)} per ticket).`);
  const breaching = teams.filter((t) => t.sla_breached > 0).sort((a, b) => b.sla_breached - a.sla_breached)[0];
  if (breaching) opp.push(`Most SLA breaches: ${breaching.team_name} (${breaching.sla_breached}).`);
  if ((analytics.performance.reassignment_rate_pct ?? 0) >= 25) opp.push(`${analytics.performance.reassignment_rate_pct}% of tickets were reassigned or transferred: check the routing rules for misroutes.`);
  if (analytics.now.unassigned) opp.push(`${analytics.now.unassigned} ticket(s) are waiting for a Team Lead to assign them.`);
  return { title: FREQ_LABEL[freq], period, generatedAt: now, analytics, teams, officers, repeat, opportunities: opp };
}

const dur = (ms: number | null) => (ms === null ? "—" : formatDuration(ms));
const pc = (v: number | null) => (v === null ? "—" : `${v}%`);

function csvCell(v: string | number | null) {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportCsv(r: CxReport): string {
  const L: (string | number | null)[][] = [];
  const a = r.analytics;
  L.push([r.title, `${r.period.from} to ${r.period.to}`]);
  L.push([]);
  L.push(["Metric", "Value"]);
  const kv: [string, string | number][] = [
    ["Complaints received", a.totals.received],
    ["Resolved", a.totals.resolved],
    ["Closed", a.totals.closed],
    ["Reopened", a.totals.reopened],
    ["Escalated", a.totals.escalated],
    ["Open now", a.now.open],
    ["Unassigned now", a.now.unassigned],
    ["Overdue now", a.now.overdue],
    ["Average resolution time (elapsed)", dur(a.performance.avg_resolution_ms)],
    ["Median resolution time (elapsed)", dur(a.performance.median_resolution_ms)],
    ["Average SLA-adjusted resolution time", dur(a.performance.avg_sla_resolution_ms)],
    ["Average first response", dur(a.performance.first_response_avg_ms)],
    ["SLA compliance", pc(a.performance.sla_compliance_pct)],
    ["SLA breaches", a.performance.sla_breached],
    ["Reassignment rate", pc(a.performance.reassignment_rate_pct)],
    ["Reopening rate", pc(a.performance.reopen_rate_pct)],
  ];
  for (const [k, v] of kv) L.push([k, v]);
  L.push([]);
  L.push(["Team", "Received", "Assigned", "Resolved", "Transferred out", "Pending now", "Avg handling", "Median handling", "Max handling", "SLA met", "SLA breached", "SLA compliance"]);
  for (const t of r.teams) L.push([t.team_name, t.received, t.assigned, t.resolved, t.transferred_out, t.pending_now, dur(t.avg_handling_ms), dur(t.median_handling_ms), dur(t.max_handling_ms), t.sla_met, t.sla_breached, pc(t.sla_compliance_pct)]);
  L.push([]);
  L.push(["Officer", "Tickets handled", "Resolved", "Handed on", "Open now", "Avg handling", "Median handling", "SLA met", "SLA breached"]);
  for (const o of r.officers) L.push([o.officer_name, o.received, o.resolved, o.transferred_out, o.pending_now, dur(o.avg_handling_ms), dur(o.median_handling_ms), o.sla_met, o.sla_breached]);
  for (const [title, rows] of [["Product", a.byProduct], ["Category", a.byCategory], ["Top issues", a.topIssues], ["Repeat complaints", r.repeat]] as const) {
    L.push([]);
    L.push([title, "Complaints"]);
    for (const x of rows) L.push([x.label, x.count]);
  }
  L.push([]);
  L.push(["Oldest unresolved", "Subject", "Team", "Officer", "Priority", "Status", "Age", "Overdue"]);
  for (const o of a.oldestOpen) L.push([o.ref, o.subject, o.team_name, o.assignee_name ?? "", PRIORITY_LABELS[o.priority as Priority], STATUS_LABELS[o.status as TicketStatus], dur(o.age_ms), o.overdue ? "Yes" : "No"]);
  return "﻿" + L.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ PDF

const NAVY = rgb(0.082, 0.169, 0.349);
const MUTED = rgb(0.38, 0.42, 0.5);
/** pdf-lib standard fonts are WinAnsi: replace characters they cannot encode. */
const safe = (s: string) => s.replace(/₦/g, "NGN ").replace(/[—–]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

export async function reportPdf(r: CxReport): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([842, 595]); // A4 landscape
  let y = 555;
  const left = 40;
  const text = (s: string, x: number, size = 9, f: PDFFont = font, color = rgb(0.1, 0.1, 0.1)) => page.drawText(safe(s).slice(0, 120), { x, y, size, font: f, color });
  const need = (h: number) => {
    if (y - h < 40) {
      page = doc.addPage([842, 595]);
      y = 555;
    }
  };
  const heading = (s: string) => {
    need(40);
    y -= 14;
    text(s, left, 12, bold, NAVY);
    y -= 16;
  };
  const table = (cols: [string, number][], rows: (string | number)[][]) => {
    need(30);
    let x = left;
    for (const [h, w] of cols) {
      text(h, x, 8, bold, MUTED);
      x += w;
    }
    y -= 13;
    for (const row of rows) {
      need(14);
      x = left;
      row.forEach((c, i) => {
        const w = cols[i][1];
        text(String(c).slice(0, Math.max(4, Math.floor(w / 4.6))), x, 8.5);
        x += w;
      });
      y -= 12;
    }
    if (!rows.length) {
      text("No records in this period.", left, 8.5, font, MUTED);
      y -= 12;
    }
  };
  text("ARAF - Retail Asset Factory · The Alternative Bank", left, 9, bold, MUTED);
  y -= 20;
  text(r.title, left, 18, bold, NAVY);
  y -= 16;
  text(`Period ${r.period.from} to ${r.period.to} · generated ${r.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · internal use only`, left, 9, font, MUTED);
  const a = r.analytics;
  heading("Summary");
  table(
    [["Received", 80], ["Resolved", 80], ["Closed", 70], ["Reopened", 70], ["Open now", 70], ["Unassigned", 75], ["Overdue", 70], ["SLA compliance", 90], ["Avg resolution", 100], ["First response", 100]],
    [[a.totals.received, a.totals.resolved, a.totals.closed, a.totals.reopened, a.now.open, a.now.unassigned, a.now.overdue, pc(a.performance.sla_compliance_pct), dur(a.performance.avg_resolution_ms), dur(a.performance.first_response_avg_ms)]],
  );
  heading("Team performance (time each team held its tickets)");
  table(
    [["Team", 170], ["Received", 55], ["Resolved", 55], ["Transferred out", 80], ["Pending", 55], ["Avg handling", 75], ["Median", 65], ["Max", 65], ["SLA met", 55], ["Breached", 55], ["Compliance", 60]],
    r.teams.map((t) => [t.team_name, t.received, t.resolved, t.transferred_out, t.pending_now, dur(t.avg_handling_ms), dur(t.median_handling_ms), dur(t.max_handling_ms), t.sla_met, t.sla_breached, pc(t.sla_compliance_pct)]),
  );
  heading("Officer performance");
  table(
    [["Officer", 170], ["Handled", 60], ["Resolved", 60], ["Handed on", 65], ["Open now", 60], ["Avg handling", 80], ["Median", 70], ["SLA met", 60], ["Breached", 60]],
    r.officers.map((o) => [o.officer_name, o.received, o.resolved, o.transferred_out, o.pending_now, dur(o.avg_handling_ms), dur(o.median_handling_ms), o.sla_met, o.sla_breached]),
  );
  heading("Complaints by product and top issues");
  table([["Product", 250], ["Complaints", 80]], a.byProduct.map((x) => [x.label, x.count]));
  y -= 6;
  table([["Issue", 420], ["Complaints", 80]], a.topIssues.map((x) => [x.label, x.count]));
  heading("Oldest unresolved complaints");
  table(
    [["Reference", 95], ["Subject", 230], ["Team", 140], ["Officer", 120], ["Priority", 60], ["Age", 60], ["Overdue", 50]],
    a.oldestOpen.map((o) => [o.ref, o.subject, o.team_name, o.assignee_name ?? "-", PRIORITY_LABELS[o.priority as Priority], dur(o.age_ms), o.overdue ? "Yes" : "No"]),
  );
  if (r.opportunities.length) {
    heading("Operational improvement opportunities (from the figures above)");
    for (const o of r.opportunities) {
      need(14);
      text(`• ${o}`, left, 9);
      y -= 13;
    }
  }
  return Buffer.from(await doc.save());
}

// ------------------------------------------------------------------ email and schedule

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function reportEmail(r: CxReport) {
  const a = r.analytics;
  const link = `${config.appUrl.replace(/\/$/, "")}/crm/reports`;
  const lines = [
    `${r.title}: ${r.period.from} to ${r.period.to}`,
    "",
    `Received ${a.totals.received} · resolved ${a.totals.resolved} · closed ${a.totals.closed} · reopened ${a.totals.reopened}`,
    `Open now ${a.now.open} · unassigned ${a.now.unassigned} · overdue ${a.now.overdue} · escalated ${a.now.escalated}`,
    `SLA compliance ${pc(a.performance.sla_compliance_pct)} · breaches ${a.performance.sla_breached} · average resolution ${dur(a.performance.avg_resolution_ms)}`,
    "",
    "Teams (received / resolved / transferred out / pending / average handling / SLA compliance):",
    ...r.teams.map((t) => `- ${t.team_name}: ${t.received} / ${t.resolved} / ${t.transferred_out} / ${t.pending_now} / ${dur(t.avg_handling_ms)} / ${pc(t.sla_compliance_pct)}`),
    ...(r.opportunities.length ? ["", "Improvement opportunities:", ...r.opportunities.map((o) => `- ${o}`)] : []),
    "",
    `Full report, CSV and PDF: ${link}`,
    "",
    "ARAF — Retail Asset Factory · The Alternative Bank. Internal use only.",
  ];
  const row = (cells: string[], th = false) => `<tr>${cells.map((c) => `<${th ? "th" : "td"} style="border:1px solid #d9dee8;padding:6px 8px;text-align:left;font-size:13px">${esc(c)}</${th ? "th" : "td"}>`).join("")}</tr>`;
  const html = `<div style="font-family:Arial,sans-serif;color:#1b2333;max-width:760px">
<p style="color:#6b7385;font-size:12px;margin:0">ARAF — Retail Asset Factory · The Alternative Bank</p>
<h2 style="color:#152b59;margin:6px 0">${esc(r.title)}</h2><p style="margin:0 0 12px">${esc(r.period.from)} to ${esc(r.period.to)}</p>
<table style="border-collapse:collapse;margin-bottom:14px">${row(["Received", "Resolved", "Open now", "Unassigned", "Overdue", "SLA compliance", "Avg resolution"], true)}${row([String(a.totals.received), String(a.totals.resolved), String(a.now.open), String(a.now.unassigned), String(a.now.overdue), pc(a.performance.sla_compliance_pct), dur(a.performance.avg_resolution_ms)])}</table>
<table style="border-collapse:collapse;margin-bottom:14px">${row(["Team", "Received", "Resolved", "Transferred out", "Pending", "Avg handling", "SLA compliance"], true)}${r.teams.map((t) => row([t.team_name, String(t.received), String(t.resolved), String(t.transferred_out), String(t.pending_now), dur(t.avg_handling_ms), pc(t.sla_compliance_pct)])).join("")}</table>
${r.opportunities.length ? `<ul>${r.opportunities.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}
<p><a href="${esc(link)}">Open the full report in ARAF</a> (CSV and PDF downloads).</p><p style="color:#6b7385;font-size:12px">Internal use only.</p></div>`;
  return { subject: `ARAF CRM — ${r.title} (${r.period.from}${r.period.to !== r.period.from ? ` to ${r.period.to}` : ""})`, text: lines.join("\n"), html };
}

/** Worker: send each enabled schedule's last completed period once, after its send hour (catching up if the worker was down). */
export async function runCrmReports(now = new Date()): Promise<number> {
  const schedules = (await db.query<{ frequency: Frequency; send_hour: number; include_cx_heads: boolean; extra_recipient_ids: string[] }>("SELECT frequency, send_hour, include_cx_heads, extra_recipient_ids FROM crm_report_schedules WHERE enabled")).rows;
  let sent = 0;
  for (const s of schedules) {
    const p = lastPeriod(s.frequency, now);
    // The period is due from its send hour on the first day after it ends.
    const day = addDaysToDateString(p.to, 1).split("-").map(Number);
    if (now < fromLagos(day[0], day[1], day[2], s.send_hour)) continue;
    if ((await db.query("SELECT 1 FROM crm_report_runs WHERE frequency = $1 AND period_key = $2", [s.frequency, p.key])).rowCount) continue;
    const to = new Map<string, string>();
    if (s.include_cx_heads) for (const h of await holdersOf(db, "CX_HEAD")) to.set(h.id, h.email);
    const extra = (
      await db.query<{ id: string; email: string }>(
        "SELECT s.id, s.email FROM staff s WHERE s.id = ANY($1::uuid[]) AND s.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = s.id AND ra.active AND ra.role IN ('CX_HEAD','SUPER_ADMIN','REPORTING_ADMIN','EXECUTIVE_VIEW'))",
        [s.extra_recipient_ids],
      )
    ).rows;
    for (const e of extra) to.set(e.id, e.email);
    const r = await buildCxReport(db, s.frequency, now, p);
    const mail = reportEmail(r);
    await withTx(async (tx) => {
      const ins = await tx.query("INSERT INTO crm_report_runs (frequency, period_key, run_at, recipients) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [s.frequency, p.key, now, to.size]);
      if (!ins.rowCount) return;
      if (to.size) await enqueueEmail(tx, now, { kind: "CRM_REPORT", dedupeKey: `crm-report:${s.frequency}:${p.key}`, to: [...to.values()], subject: mail.subject, text: mail.text, html: mail.html });
      await audit(tx, systemCtx(now), { action: "CRM_REPORT_QUEUED", details: { frequency: s.frequency, period: p, recipients: to.size } });
      sent++;
    });
  }
  return sent;
}
