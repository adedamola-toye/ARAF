/**
 * ARAF | Weekly Performance Briefing.
 *
 * "Your week in review" for a reporting scope (one officer, a team, or the bank for Divisional Heads), from actual
 * records only:
 *   - successful disbursements (recorded postings) this week, compared with the previous week — the dominant figure;
 *   - applications received (submitted; drafts never count), final approvals (never counted as disbursements),
 *     median turnaround to final approval, open applications that exceeded the service level;
 *   - performance by product, month-to-date disbursements and progress against approved monthly targets;
 *   - bouquet performance (Divisional Heads) and attention items.
 * Each facility is counted once per window; windows do not overlap (Monday 00:00 to the Sunday send time, Lagos).
 * No customer identifiers, salaries or other confidential records appear in the email.
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { config } from "../config";
import { forbidden, invalid } from "../errors";
import { formatKobo } from "../money";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { holdsRole } from "../domain/access";
import { financingFacts, type FinFact, type Scope } from "../performance-report";
import type { DhPeriod } from "./dh-weekly";

export const BRIEFING_CODE = "PERSONAL_BRIEFING";
/** Roles that originate financing and receive a personal briefing when it is switched on. */
export const BRIEFING_ROLES = ["RM", "ANM", "MERCHANT_OFFICER", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD", "TEAM_LEAD"];

const inWin = (d: Date | null, a: Date, b: Date) => !!d && new Date(d) >= a && new Date(d) < b;
const sum = (xs: FinFact[], f: (x: FinFact) => number) => xs.reduce((s, x) => s + f(x), 0);
const money = (k: number) => formatKobo(k);
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const hrs = (h: number | null) => (h === null ? "—" : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

function change(cur: number, prev: number): { text: string; dir: "up" | "down" | "flat" } {
  if (cur === prev) return { text: "same as the previous week", dir: "flat" };
  if (prev === 0) return { text: "up from nothing the previous week", dir: "up" };
  const pct = Math.round(((cur - prev) / prev) * 100);
  return { text: `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on the previous week`, dir: pct > 0 ? "up" : "down" };
}

export interface Briefing {
  weekEnding: string;
  disbursed: { n: number; kobo: number; prevN: number; prevKobo: number; change: ReturnType<typeof change> };
  submitted: { n: number; kobo: number; prevN: number };
  approved: { n: number; kobo: number };
  medianTurnaround: string;
  overSla: number;
  products: { product: string; submitted: number; disbursed: number; disbursedKobo: number }[];
  mtd: { n: number; kobo: number };
  target: { kobo: number; pct: number } | null;
  bouquets: { n: number; facilities: number; kobo: number } | null;
  attention: string[];
}

/** Build the briefing for a scope over the period ending at `p.sendAt`. */
export async function computeBriefing(q: Db, scope: Scope, p: DhPeriod, opts: { targetStaffId?: string | null; bouquetsForDh?: string | null } = {}): Promise<Briefing> {
  const facts = await financingFacts(q, scope);
  const end = p.sendAt;
  const prevStart = new Date(p.weekStart.getTime() - 7 * 86_400_000);
  const w = (a: Date, b: Date) => ({
    submitted: facts.filter((x) => inWin(x.submittedAt, a, b)),
    approved: facts.filter((x) => x.approved && inWin(x.approvedAt, a, b)),
    disbursed: facts.filter((x) => x.disbursed && inWin(x.disbursedAt, a, b)),
  });
  const W = w(p.weekStart, end);
  const P = w(prevStart, p.weekStart);
  const M = w(p.monthStart, end);
  const dk = (x: FinFact) => x.disbursedKobo;
  const products = [...new Set([...W.submitted, ...W.disbursed].map((x) => x.product))].sort().map((product) => ({
    product,
    submitted: W.submitted.filter((x) => x.product === product).length,
    disbursed: W.disbursed.filter((x) => x.product === product).length,
    disbursedKobo: sum(W.disbursed.filter((x) => x.product === product), dk),
  }));
  let target: Briefing["target"] = null;
  if (opts.targetStaffId) {
    const t = (
      await q.query<{ v: string }>(
        `SELECT target_value::text AS v FROM performance_targets WHERE scope_type = 'STAFF' AND staff_id = $1 AND metric = 'DISBURSED_VALUE' AND status = 'APPROVED' AND period_month = $2::date`,
        [opts.targetStaffId, p.fromMonth],
      )
    ).rows[0];
    if (t) target = { kobo: Number(t.v), pct: Math.round((sum(M.disbursed, dk) / Number(t.v)) * 100) };
  }
  let bouquets: Briefing["bouquets"] = null;
  if (opts.bouquetsForDh) {
    const b = (
      await q.query<{ n: number; f: number; k: string }>(
        `SELECT count(*)::int AS n, coalesce(sum(concurred_count), 0)::int AS f, coalesce(sum(concurred_total_kobo), 0)::text AS k FROM bouquets
          WHERE status = 'CONCURRED' AND concurred_at >= $1 AND concurred_at < $2 AND ($3::uuid IS NULL OR divisional_head_id = $3)`,
        [p.weekStart, end, opts.bouquetsForDh === "ALL" ? null : opts.bouquetsForDh],
      )
    ).rows[0];
    bouquets = { n: b.n, facilities: b.f, kobo: Number(b.k) };
  }
  const pending = facts.filter((x) => x.pending);
  const attention: string[] = [];
  const nOver = pending.filter((x) => x.slaBreaches > 0).length;
  if (nOver) attention.push(`${nOver} open application${nOver === 1 ? "" : "s"} exceeded the service level at some stage`);
  const rmConf = facts.filter((x) => x.awaitingRmConfirmation).length;
  if (rmConf) attention.push(`${rmConf} disbursed facilit${rmConf === 1 ? "y awaits" : "ies await"} RM confirmation`);
  const ev = facts.filter((x) => x.missingEvidence).length;
  if (ev) attention.push(`${ev} facilit${ev === 1 ? "y is" : "ies are"} missing acquisition evidence`);
  const inv = pending.filter((x) => x.invoicePending).length;
  if (inv) attention.push(`${inv} invoice confirmation${inv === 1 ? " is" : "s are"} pending`);
  return {
    weekEnding: p.to,
    disbursed: { n: W.disbursed.length, kobo: sum(W.disbursed, dk), prevN: P.disbursed.length, prevKobo: sum(P.disbursed, dk), change: change(sum(W.disbursed, dk), sum(P.disbursed, dk)) },
    submitted: { n: W.submitted.length, kobo: sum(W.submitted, (x) => x.requestedKobo), prevN: P.submitted.length },
    approved: { n: W.approved.length, kobo: sum(W.approved, (x) => x.approvedKobo) },
    medianTurnaround: hrs(median(W.approved.map((x) => x.turnaroundHours).filter((x): x is number => x !== null))),
    overSla: nOver,
    products,
    mtd: { n: M.disbursed.length, kobo: sum(M.disbursed, dk) },
    target,
    bouquets,
    attention,
  };
}

const weekEndingLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const briefingSubject = (p: DhPeriod) => `ARAF | Weekly Performance Briefing | Week Ending ${weekEndingLabel(p.to)}`;

/** Plain-text lines for the briefing (the email's text part). */
export function briefingText(b: Briefing): string[] {
  const out = [
    "YOUR WEEK IN REVIEW",
    `Successful disbursements: ${money(b.disbursed.kobo)} (${b.disbursed.n}) — ${b.disbursed.change.text} (${money(b.disbursed.prevKobo)}, ${b.disbursed.prevN})`,
    `Applications received: ${b.submitted.n} (${money(b.submitted.kobo)}); previous week ${b.submitted.prevN}. Drafts are not counted.`,
    `Final approvals: ${b.approved.n} (${money(b.approved.kobo)}). Approvals are not disbursements.`,
    `Median turnaround to final approval: ${b.medianTurnaround}`,
    `Open applications that exceeded the service level: ${b.overSla}`,
    `Month-to-date disbursements: ${money(b.mtd.kobo)} (${b.mtd.n})${b.target ? ` — ${b.target.pct}% of the ${money(b.target.kobo)} target` : ""}`,
  ];
  if (b.bouquets) out.push(`Bouquet concurrence this week: ${b.bouquets.n} bouquet(s), ${b.bouquets.facilities} facilities, ${money(b.bouquets.kobo)}`);
  if (b.products.length) out.push("", "By product (this week):", ...b.products.map((x) => `  ${x.product}: ${x.submitted} received · ${x.disbursed} disbursed (${money(x.disbursedKobo)})`));
  out.push("", "Needs attention:", ...(b.attention.length ? b.attention.map((a) => `  - ${a}`) : ["  Nothing outstanding."]), "");
  return out;
}

const STAT = (label: string, value: string, hint?: string) =>
  `<td style="padding:12px 12px 12px 0;vertical-align:top;width:50%"><div style="font:12px/1.4 Arial,Helvetica,sans-serif;color:#6b6e76">${esc(label)}</div><div style="font:700 18px/1.3 Arial,Helvetica,sans-serif;color:#1c1d20">${esc(value)}</div>${hint ? `<div style="font:12px/1.4 Arial,Helvetica,sans-serif;color:#6b6e76">${esc(hint)}</div>` : ""}</td>`;

/** The briefing block (HTML), usable on its own or at the top of a longer report. */
export function briefingHtml(b: Briefing): string {
  const arrow = b.disbursed.change.dir === "up" ? "▲" : b.disbursed.change.dir === "down" ? "▼" : "■";
  const colour = b.disbursed.change.dir === "down" ? "#b42318" : b.disbursed.change.dir === "up" ? "#1f6b45" : "#6b6e76";
  const rows = [
    [STAT("Applications received", String(b.submitted.n), `${money(b.submitted.kobo)} · previous week ${b.submitted.prevN}`), STAT("Final approvals", String(b.approved.n), money(b.approved.kobo))],
    [STAT("Median turnaround", b.medianTurnaround, "submission to final approval"), STAT("Exceeding the service level", String(b.overSla), "open applications")],
    [STAT("Month-to-date disbursements", money(b.mtd.kobo), `${b.mtd.n} facilit${b.mtd.n === 1 ? "y" : "ies"}`), b.target ? STAT("Monthly target", `${b.target.pct}%`, `of ${money(b.target.kobo)}`) : STAT("Monthly target", "—", "no approved target")],
  ];
  if (b.bouquets) rows.push([STAT("Bouquets concurred", String(b.bouquets.n), `${b.bouquets.facilities} facilities · ${money(b.bouquets.kobo)}`), "<td></td>"]);
  const products = b.products.length
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:8px">${b.products
        .map(
          (x) =>
            `<tr><td style="padding:8px 0;border-bottom:1px solid #ececef;font:13px Arial,Helvetica,sans-serif;color:#1c1d20">${esc(x.product)}</td><td style="padding:8px 0;border-bottom:1px solid #ececef;font:13px Arial,Helvetica,sans-serif;color:#6b6e76;text-align:right">${x.submitted} received · ${x.disbursed} disbursed</td><td style="padding:8px 0 8px 12px;border-bottom:1px solid #ececef;font:600 13px Arial,Helvetica,sans-serif;color:#1c1d20;text-align:right;white-space:nowrap">${esc(money(x.disbursedKobo))}</td></tr>`,
        )
        .join("")}</table>`
    : `<p style="font:13px Arial,Helvetica,sans-serif;color:#6b6e76;margin:8px 0 0">No applications or disbursements this week.</p>`;
  return `<div style="margin:20px 0 0">
<p style="margin:0 0 6px;font:600 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6b6e76">Your week in review</p>
<div style="font:12px/1.4 Arial,Helvetica,sans-serif;color:#6b6e76">Successful disbursements</div>
<div style="font:700 34px/1.15 Arial,Helvetica,sans-serif;color:#1c1d20;letter-spacing:-0.5px">${esc(money(b.disbursed.kobo))}</div>
<div style="font:13px/1.5 Arial,Helvetica,sans-serif;color:${colour}">${arrow} ${esc(b.disbursed.change.text)} <span style="color:#6b6e76">(${esc(money(b.disbursed.prevKobo))}) · ${b.disbursed.n} facilit${b.disbursed.n === 1 ? "y" : "ies"}</span></div>
<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:12px">${rows.map((r) => `<tr>${r.join("")}</tr>`).join("")}</table>
<h2 style="font:600 14px/1.3 Arial,Helvetica,sans-serif;color:#1c1d20;margin:20px 0 0">Performance by product</h2>${products}
<h2 style="font:600 14px/1.3 Arial,Helvetica,sans-serif;color:#1c1d20;margin:20px 0 6px">Needs attention</h2>
${b.attention.length ? `<ul style="margin:0;padding-left:18px">${b.attention.map((a) => `<li style="font:13px/1.6 Arial,Helvetica,sans-serif;color:#1c1d20">${esc(a)}</li>`).join("")}</ul>` : `<p style="font:13px Arial,Helvetica,sans-serif;color:#6b6e76;margin:0">Nothing outstanding.</p>`}
</div>`;
}

/** Full email: white card, restrained yellow accent, Outlook-safe tables, confidential footer. */
export function briefingEmailHtml(name: string, p: DhPeriod, inner: string, intro?: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5"><tr><td style="padding:24px 8px">
<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden">
<tr><td style="height:4px;background:#ffc928;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 24px 28px">
<p style="margin:0;font:700 13px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.12em;color:#1c1d20">ARAF</p>
<p style="margin:2px 0 16px;font:12px/1.4 Arial,Helvetica,sans-serif;color:#6b6e76">Weekly Performance Briefing · week ending ${esc(weekEndingLabel(p.to))}</p>
<p style="margin:0;font:15px/1.5 Arial,Helvetica,sans-serif;color:#1c1d20">Dear ${esc(name)},</p>
${intro ? `<p style="margin:6px 0 0;font:13px/1.5 Arial,Helvetica,sans-serif;color:#6b6e76">${esc(intro)}</p>` : ""}
${inner}
<p style="margin:24px 0 0"><a href="${esc(config.appUrl)}/overview" style="display:inline-block;background:#ffc928;color:#1c1d20;text-decoration:none;font:700 14px Arial,Helvetica,sans-serif;padding:12px 22px;border-radius:999px">Open ARAF</a></p>
</td></tr></table>
<p style="max-width:640px;margin:12px auto 0;font:11px/1.5 Arial,Helvetica,sans-serif;color:#6b6e76;text-align:center">Internal and confidential. The Alternative Bank. Figures come from ARAF records as at the report cut-off (Africa/Lagos). Do not forward outside the bank.</p>
</td></tr></table></body></html>`;
}

/** Recipients of the personal briefing: active originating officers. */
async function briefingRecipients(q: Db) {
  return (
    await q.query<{ id: string; email: string; full_name: string }>(
      `SELECT DISTINCT s.id, s.email, s.full_name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = ANY($1)
        WHERE s.status = 'ACTIVE' ORDER BY s.full_name`,
      [BRIEFING_ROLES],
    )
  ).rows;
}

const personalScope = (id: string, name: string): Scope => ({ kind: "STAFF", staffIds: [id], label: `${name}'s own applications` });

/** Called inside the Sunday run: one personal briefing per originating officer, once per week (idempotent). */
export async function sendPersonalBriefings(tx: Db, runId: string, p: DhPeriod, now: Date): Promise<number> {
  const s = (await tx.query("SELECT enabled FROM schedule_settings WHERE code = $1", [BRIEFING_CODE])).rows[0];
  if (!s?.enabled) return 0;
  let sent = 0;
  for (const r of await briefingRecipients(tx)) {
    const b = await computeBriefing(tx, personalScope(r.id, r.full_name), p, { targetStaffId: r.id });
    const del = await tx.query<{ id: string }>(
      `INSERT INTO digest_deliveries (run_id, code, period_key, recipient_id, summary, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code, period_key, recipient_id) DO NOTHING RETURNING id`,
      [runId, BRIEFING_CODE, p.key, r.id, JSON.stringify({ disbursedKobo: b.disbursed.kobo, disbursed: b.disbursed.n, submitted: b.submitted.n }), now],
    );
    if (!del.rowCount) continue;
    const out = await enqueueEmail(tx, now, {
      kind: BRIEFING_CODE,
      dedupeKey: `briefing:${p.key}:${r.id}`,
      to: [r.email],
      subject: briefingSubject(p),
      html: briefingEmailHtml(r.full_name, p, briefingHtml(b), "Your own applications this week, from ARAF records."),
      text: simpleEmail([`Dear ${r.full_name},`, "", ...briefingText(b), `Open ARAF: ${config.appUrl}/overview`, "", "Internal and confidential."]),
    });
    await tx.query("UPDATE digest_deliveries SET outbox_id = $2 WHERE id = $1", [del.rows[0].id, out.id]);
    sent++;
  }
  return sent;
}

/** Super Admin preview: the briefing a given officer would receive, from live data up to now. Not sent. */
export async function previewBriefing(q: Db, staffId: string, now: Date): Promise<{ subject: string; html: string } | null> {
  const s = (await q.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE id = $1", [staffId])).rows[0];
  if (!s) return null;
  const { dhPeriodFor } = await import("./dh-weekly");
  const p = { ...dhPeriodFor(now, 18, 0), sendAt: new Date(now.getTime() + 1000) };
  const b = await computeBriefing(q, personalScope(s.id, s.full_name), p, { targetStaffId: s.id });
  return { subject: `[PREVIEW] ${briefingSubject(p)}`, html: briefingEmailHtml(s.full_name, p, briefingHtml(b), "PREVIEW from live data up to now. Not sent.") };
}

/** Super Admin test send: a chosen officer's briefing, delivered to the Super Admin only, marked [TEST]. */
export async function sendBriefingTest(ctx: Ctx, staffId: string): Promise<{ to: string }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    const pv = await previewBriefing(tx, staffId, ctx.now);
    if (!pv) throw invalid("Choose a member of staff.");
    const me = (await tx.query<{ email: string }>("SELECT email FROM staff WHERE id = $1", [actor.staffId])).rows[0];
    await enqueueEmail(tx, ctx.now, { kind: `${BRIEFING_CODE}_TEST`, dedupeKey: `briefing-test:${ctx.now.getTime()}:${staffId}`, to: [me.email], subject: pv.subject.replace("[PREVIEW]", "[TEST]"), html: pv.html, text: "Test briefing: view the HTML version." });
    await audit(tx, ctx, { action: "BRIEFING_TEST_SENT", actorRole: "SUPER_ADMIN", details: { forStaffId: staffId } });
    return { to: me.email };
  });
}
