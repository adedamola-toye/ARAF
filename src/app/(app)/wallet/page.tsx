import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { walletDay, walletMonth, walletMonthsAvailable } from "@/server/domain/wallet";
import { formatKobo } from "@/server/money";
import { formatLagos, lagosDate, isValidDateString } from "@/server/time";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { PageHeader } from "@/components/PageHeader";
import { WalletCard } from "@/components/WalletCard";
import { auditOutsideTx } from "@/server/audit";

export const metadata = { title: "Requested Today" };

export default async function WalletPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { roles, session, ctx } = await requireUser();
  if (!roles.includes("RM")) redirect("/forbidden");
  const sp = await searchParams;
  const today = lagosDate(new Date());
  const day = sp.day && isValidDateString(sp.day) && sp.day <= today ? sp.day : today;
  // Scope: always the signed-in RM's own ledger rows.
  const d = await walletDay(db, session.staffId, day);
  const todayTotals = day === today ? d : await walletDay(db, session.staffId, today);
  const showMonth = sp.view === "month";
  const months = showMonth ? await walletMonthsAvailable(db, session.staffId) : [];
  const currentMonth = today.slice(0, 7);
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : currentMonth;
  const m = showMonth ? await walletMonth(db, session.staffId, month) : null;
  await auditOutsideTx(ctx, { action: "WALLET_VIEWED", details: { day, month: showMonth ? month : null } });
  return (
    <>
      <PageHeader eyebrow="Relationship Manager" title="Requested financing" intro="Each submitted application counts once, on the Lagos date it was first submitted, at the amount submitted. Corrections, resubmissions and retries never add to it." />
      <WalletCard totalKobo={todayTotals.totalKobo} count={todayTotals.count} day={today} />
      <section className="card" aria-labelledby="h-day" style={{ marginTop: "var(--space-4)" }}>
        <div className="card-head">
          <h2 id="h-day">Daily breakdown · {day}</h2>
          <form method="get" className="row">
            <label htmlFor="day" className="small">Day</label>
            <input id="day" name="day" type="date" defaultValue={day} max={today} />
            <button className="btn btn-sm">Show</button>
          </form>
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>Total requested on {day}: <strong className="tnum">{formatKobo(d.totalKobo)}</strong> across {d.count} application{d.count === 1 ? "" : "s"}.</p>
        <div className="table-wrap">
          <table className="data responsive">
            <thead>
              <tr><th>Request</th><th>Customer</th><th>Product</th><th className="right">Requested (submitted)</th><th>Submitted</th><th>Current status</th><th className="right">Approved · disbursed</th></tr>
            </thead>
            <tbody>
              {d.rows.length === 0 && <tr><td colSpan={7} className="empty">No applications submitted on this day.</td></tr>}
              {d.rows.map((r) => (
                <tr key={r.application_id} className="clickable">
                  <td data-label="Request"><Link className="row-link mono" href={`/requests/${r.application_id}`}>{r.ref}</Link></td>
                  <td data-label="Customer">{r.customer_name}</td>
                  <td data-label="Product">{r.product_label}</td>
                  <td data-label="Requested" className="num">{formatKobo(r.requested_amount_kobo)}{r.latest_requested_amount_kobo && r.latest_requested_amount_kobo !== r.requested_amount_kobo ? <div className="small muted">now {formatKobo(r.latest_requested_amount_kobo)}</div> : null}</td>
                  <td data-label="Submitted" className="small nowrap">{formatLagos(r.submitted_at)}</td>
                  <td data-label="Status"><span className="badge">{r.status.toLowerCase()}</span> <span className="small muted">{STAGE_LABELS[r.stage as Stage] ?? r.stage}</span></td>
                  <td data-label="Approved · disbursed" className="num small">{r.approved_kobo ? formatKobo(r.approved_kobo) : "—"} · {r.disbursed_kobo ? formatKobo(r.disbursed_kobo) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {!showMonth ? (
        <p style={{ marginTop: "var(--space-4)" }}>
          <Link className="btn" href={`/wallet?view=month&day=${day}`}>View Monthly Requested Total</Link>
        </p>
      ) : (
        m && (
          <section className="card" aria-labelledby="h-month" style={{ marginTop: "var(--space-4)" }}>
            <div className="card-head">
              <h2 id="h-month">Monthly requested total · {month}</h2>
              <form method="get" className="row">
                <input type="hidden" name="view" value="month" />
                <label htmlFor="month" className="small">Month</label>
                <select id="month" name="month" defaultValue={month}>
                  {[...new Set([currentMonth, ...months])].sort().reverse().map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                <button className="btn btn-sm">Show</button>
              </form>
            </div>
            <div className="metric-grid">
              <div className="metric"><div className="k">Total requested</div><div className="v tnum">{formatKobo(m.totalKobo)}</div></div>
              <div className="metric"><div className="k">Applications</div><div className="v">{m.count}</div></div>
              <div className="metric"><div className="k">Days with requests</div><div className="v">{m.days.length}</div></div>
            </div>
            <table className="data" style={{ marginTop: 12 }}>
              <thead><tr><th>Day</th><th className="right">Applications</th><th className="right">Requested</th></tr></thead>
              <tbody>
                {m.days.length === 0 && <tr><td colSpan={3} className="empty">No requests in this month.</td></tr>}
                {m.days.map((x) => <tr key={x.day}><td><Link href={`/wallet?day=${x.day}&view=month&month=${month}`}>{x.day}</Link></td><td className="num">{x.count}</td><td className="num">{formatKobo(x.totalKobo)}</td></tr>)}
              </tbody>
            </table>
            <p className="small muted">The monthly total is the sum of the daily balances above; nothing is counted twice.</p>
          </section>
        )
      )}
    </>
  );
}
