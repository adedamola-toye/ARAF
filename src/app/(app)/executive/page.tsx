import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { executiveAccess, executiveOverview } from "@/server/executive";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "God's Eye" };
const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");
const ALT_STATUS: Record<string, string> = { UNDER_BPM_REVIEW: "Altphones: BPM review", UNDER_PM_REVIEW: "Altphones: Product Manager review", UNDER_UNIT_HEAD_REVIEW: "Altphones: Unit Head review", APPROVED: "Altphones: approved, awaiting disbursement" };

function Csv({ dataset }: { dataset: string }) {
  return (
    <a className="btn btn-ghost btn-sm" href={`/api/executive/export?dataset=${dataset}`}>
      Export CSV
    </a>
  );
}

export default async function Executive() {
  const { session } = await requireUser();
  if (!(await executiveAccess(db, session.staffId))) redirect("/forbidden");
  const o = await executiveOverview(db, new Date());
  const metric = (k: string, v: string, sub?: string) => (
    <div key={k} className="metric">
      <div className="k">{k}</div>
      <div className="v tnum">{v}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
  return (
    <>
      <PageHeader eyebrow="Reporting" title="God's Eye" intro={<>Institution-wide, read-only view across retail, WakeelBoost and Altphones. Figures are from ARAF&apos;s own records (core banking is not connected) as of {formatLagos(o.asOf)}. This view cannot approve or change anything.</>} />
      <section aria-labelledby="h-flow">
        <h2 id="h-flow" className="section-title">Requests to repayments</h2>
        <div className="metric-grid">
          {metric("Requests submitted", n(o.requests.all), `${n(o.requests.last30)} in the last 30 days · ${formatKobo(o.requests.last30Kobo)}`)}
          {metric("Final approvals", n(o.approvals.all), `${n(o.approvals.last30)} in the last 30 days`)}
          {metric("Bookings", n(o.bookings.all), `${formatKobo(o.bookings.principalKobo)} principal`)}
          {metric("Disbursements", n(o.disbursements.all), `${formatKobo(o.disbursements.kobo)} · ${formatKobo(o.disbursements.last30Kobo)} in 30 days`)}
          {metric("Repayments recorded", formatKobo(o.repayments.retailKobo), `Altphones historical: ${formatKobo(o.repayments.historicalKobo)}`)}
          {metric("Outstanding facilities", n(o.outstanding.facilities), `${formatKobo(o.outstanding.kobo)} · historical Altphones ${formatKobo(o.outstanding.historicalKobo)}`)}
        </div>
      </section>

      <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
        <section className="card" aria-labelledby="h-q">
          <div className="card-head"><h2 id="h-q">Approval queues</h2><Csv dataset="queues" /></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Stage</th><th scope="col" className="num">Open</th><th scope="col" className="num">Unassigned</th><th scope="col">Oldest since</th></tr></thead>
              <tbody>
                {o.queues.map((q) => <tr key={q.stage}><td>{STAGE_LABELS[q.stage as Stage] ?? q.stage}</td><td className="num">{n(q.n)}</td><td className="num">{n(q.unassigned)}</td><td className="small">{formatLagos(q.oldest)}</td></tr>)}
                {o.altQueues.map((q) => <tr key={q.status}><td>{ALT_STATUS[q.status] ?? q.status}</td><td className="num">{n(q.n)}</td><td className="num">—</td><td>—</td></tr>)}
                {!o.queues.length && !o.altQueues.length && <tr><td colSpan={4} className="muted">Nothing waiting.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card" aria-labelledby="h-stock">
          <h2 id="h-stock">Stock utilisation (Altphones)</h2>
          <div className="metric-grid">
            {metric("Phones in stock", n(o.stock.physical))}
            {metric("Reserved for paid customers", n(o.stock.reserved))}
            {metric("Issued in 30 days", n(o.stock.issued30))}
            {metric("Stock-holding locations with none", `${n(o.stock.empty)} of ${n(o.stock.locations)}`)}
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="h-staff" style={{ marginTop: "var(--space-4)" }}>
        <div className="card-head"><h2 id="h-staff">Staff productivity (last 30 days)</h2><Csv dataset="productivity" /></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th scope="col">Staff</th><th scope="col" className="num">Requests submitted</th><th scope="col" className="num">Decisions</th><th scope="col" className="num">Altphones sales</th></tr></thead>
            <tbody>{o.productivity.length ? o.productivity.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{n(p.submitted)}</td><td className="num">{n(p.decisions)}</td><td className="num">{n(p.alt_sales)}</td></tr>) : <tr><td colSpan={4} className="muted">No activity in the last 30 days.</td></tr>}</tbody>
          </table>
        </div>
      </section>

      <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
        <section className="card" aria-labelledby="h-bpm">
          <div className="card-head"><h2 id="h-bpm">BPM performance</h2><Csv dataset="bpm" /></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">BPM</th><th scope="col" className="num">Decided</th><th scope="col" className="num">Approved</th><th scope="col" className="num">Waiting</th><th scope="col" className="num">Avg hours</th></tr></thead>
              <tbody>{o.bpm.length ? o.bpm.map((b) => <tr key={b.name}><td>{b.name}</td><td className="num">{n(b.decided)}</td><td className="num">{n(b.approved)}</td><td className="num">{n(b.waiting)}</td><td className="num">{b.avg_hours ?? "—"}</td></tr>) : <tr><td colSpan={5} className="muted">No BPM set up.</td></tr>}</tbody>
            </table>
          </div>
        </section>
        <section className="card" aria-labelledby="h-mig">
          <div className="card-head"><h2 id="h-mig">Historical migration</h2><Csv dataset="historical" /></div>
          <p className="small" style={{ marginTop: 0 }}>Batches: {o.migration.length ? o.migration.map((m) => `${m.status.toLowerCase()} ${m.n}`).join(" · ") : "none yet"}</p>
          <ul className="plain-list small">{o.historical.map((h) => <li key={h.repayment_status ?? "none"}>{(h.repayment_status ?? "—").replace(/_/g, " ").toLowerCase()}: {n(h.n)} accounts</li>)}</ul>
        </section>
      </div>

      <section className="card" aria-labelledby="h-loc" style={{ marginTop: "var(--space-4)" }}>
        <div className="card-head"><h2 id="h-loc">Location performance</h2><Csv dataset="locations" /></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th scope="col">Location</th><th scope="col">State</th><th scope="col" className="num">Altphones sales</th><th scope="col" className="num">Completed</th><th scope="col" className="num">Retail requests</th><th scope="col" className="num">In stock</th><th scope="col" className="num">Reserved</th></tr></thead>
            <tbody>{o.locations.map((l) => <tr key={`${l.name}-${l.state}`}><td>{l.name}</td><td>{l.state}</td><td className="num">{n(l.alt_sales)}</td><td className="num">{n(l.alt_completed)}</td><td className="num">{n(l.retail)}</td><td className="num">{n(l.physical)}</td><td className="num">{n(l.reserved)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="h-kyc" style={{ marginTop: "var(--space-4)" }}>
        <div className="card-head"><h2 id="h-kyc">Vendor Financing KYC exceptions</h2><Csv dataset="kyc" /></div>
        <p className="small muted" style={{ marginTop: 0 }}>Business photographs a Team Lead did not upload, with the reason given. Not rejections.</p>
        {o.kyc.length ? (
          <ul className="plain-list small">{o.kyc.map((k) => <li key={`${k.ref}-${k.decided_at}`}><span className="mono">{k.ref}</span> · {k.team_lead} · {formatLagos(k.decided_at)} · “{k.reason}”</li>)}</ul>
        ) : (
          <p className="small muted">None.</p>
        )}
      </section>
    </>
  );
}
