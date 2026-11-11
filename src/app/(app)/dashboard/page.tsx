import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { retailDashboard, retailScope } from "@/server/retail-reports";
import { listProducts, PROFILE_LABELS, type CustomerProfile } from "@/server/domain/products";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { formatKobo } from "@/server/money";
import { formatDuration } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { WaitChip } from "@/components/Status";

export const metadata = { title: "Retail dashboard" };

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session } = await requireUser();
  const scope = await retailScope(db, session.staffId);
  if (!scope) redirect("/forbidden");
  const sp = await searchParams;
  const now = new Date();
  const products = await listProducts(db, { retailOnly: true });
  const f = { from: sp.from ?? null, to: sp.to ?? null, product: sp.product ?? null };
  const d = await retailDashboard(db, scope, f, now);
  const a = d.amounts;
  const n = (s: string) => Number(s);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const byProduct = new Map<string, number>();
  const byStage = new Map<string, number>();
  const byChannel = new Map<string, number>();
  const byProfile = new Map<string, number>();
  for (const g of d.byGroup) {
    byProduct.set(g.product, (byProduct.get(g.product) ?? 0) + n(g.n));
    byStage.set(g.stage, (byStage.get(g.stage) ?? 0) + n(g.n));
    byChannel.set(g.channel, (byChannel.get(g.channel) ?? 0) + n(g.n));
    byProfile.set(g.profile, (byProfile.get(g.profile) ?? 0) + n(g.n));
  }
  return (
    <>
      <PageHeader eyebrow="Reporting" title="Retail dashboard" intro={<>Scope: <strong>{scope.label}</strong>. Requested, approved, booked and disbursed amounts are separate measures.</>} />
      <form className="filters" method="get" aria-label="Dashboard filters">
        <div className="field">
          <label htmlFor="product">Product</label>
          <select id="product" name="product" defaultValue={f.product ?? ""}>
            <option value="">All products</option>
            {products.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="from">Created from</label><input id="from" name="from" type="date" defaultValue={f.from ?? ""} /></div>
        <div className="field"><label htmlFor="to">to</label><input id="to" name="to" type="date" defaultValue={f.to ?? ""} /></div>
        <button className="btn">Apply</button>
        <a className="btn btn-ghost" href={`/api/reports/retail?${qs}`}>Export CSV</a>
      </form>

      <section aria-labelledby="h-amounts">
        <h2 id="h-amounts" className="section-title">Amounts</h2>
        <div className="metric-grid">
          <div className="metric"><div className="k">Requested (submitted)</div><div className="v tnum">{formatKobo(a.requested)}</div><div className="small muted">{a.submitted} submitted</div></div>
          <div className="metric"><div className="k">Approved (credit)</div><div className="v tnum">{formatKobo(a.approved)}</div><div className="small muted">{a.credit_approved} fully approved</div></div>
          <div className="metric"><div className="k">Booked</div><div className="v tnum">{formatKobo(a.booked)}</div><div className="small muted">{a.booked_n} facilities</div></div>
          <div className="metric"><div className="k">Successfully disbursed</div><div className="v tnum">{formatKobo(a.disbursed)}</div><div className="small muted">{a.disbursed_n} reconciled payments</div></div>
        </div>
      </section>

      <section aria-labelledby="h-conv">
        <h2 id="h-conv" className="section-title">Conversion</h2>
        <div className="funnel">
          {[
            ["Submitted", n(a.submitted)],
            ["Business approved", n(a.business_approved)],
            ["Credit approved", n(a.credit_approved)],
            ["Booked", n(a.booked_n)],
            ["Disbursed", n(a.disbursed_n)],
          ].map(([label, v], i, arr) => (
            <div key={label as string} className="funnel-step">
              <span className="small muted">{label}</span>
              <strong>{v}</strong>
              <span className="small">{i === 0 ? "" : pct(v as number, arr[0][1] as number)}</span>
            </div>
          ))}
          <div className="funnel-step"><span className="small muted">Declined · withdrawn</span><strong>{a.declined} · {a.withdrawn}</strong></div>
        </div>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="h-mix">
          <h2 id="h-mix">Applications by product, profile and channel</h2>
          <table className="data small">
            <tbody>
              {[...byProduct].map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td className="num">{v}</td></tr>)}
              {[...byProfile].map(([k, v]) => <tr key={k}><th scope="row">{PROFILE_LABELS[k as CustomerProfile] ?? k}</th><td className="num">{v}</td></tr>)}
              {[...byChannel].map(([k, v]) => <tr key={k}><th scope="row">via {ROLE_LABELS[k as Role] ?? k}</th><td className="num">{v}</td></tr>)}
            </tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="h-stage">
          <h2 id="h-stage">By stage</h2>
          <table className="data small">
            <tbody>{[...byStage].map(([k, v]) => <tr key={k}><th scope="row">{STAGE_LABELS[k as Stage] ?? k}</th><td className="num">{v}</td></tr>)}</tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="h-tat">
          <h2 id="h-tat">Stage turnaround (completed steps)</h2>
          <table className="data small">
            <thead><tr><th>Stage</th><th className="right">Steps</th><th className="right">Average h</th><th className="right">Longest h</th></tr></thead>
            <tbody>{d.turnaround.map((t) => <tr key={t.stage}><td>{t.label}</td><td className="num">{t.n}</td><td className="num">{t.avg_hours}</td><td className="num">{t.max_hours}</td></tr>)}</tbody>
          </table>
          <p className="small muted">Open items: {d.ageing.under1d} under 1 day · {d.ageing.d1to3} 1–3 days · {d.ageing.d3to7} 3–7 days · {d.ageing.over7d} over 7 days · {d.ageing.unassigned} unassigned.</p>
        </section>
        <section className="card" aria-labelledby="h-dsr">
          <h2 id="h-dsr">DSR failures and exceptions</h2>
          <table className="data small">
            <tbody>
              <tr><th scope="row">Preliminary DSR / eligibility failures</th><td className="num">{d.dsr.fail_prelim}</td></tr>
              <tr><th scope="row">Final assessment failures</th><td className="num">{d.dsr.fail_final}</td></tr>
              {d.exceptionsByType.map((e) => <tr key={`${e.type}${e.status}`}><th scope="row">{e.type} exceptions {e.status.toLowerCase()}</th><td className="num">{e.n}</td></tr>)}
            </tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="h-reasons">
          <h2 id="h-reasons">Decline and correction reasons</h2>
          <ul className="small">
            {d.declineReasons.map((r) => <li key={`d${r.stage}${r.reason}`}><strong>Declined</strong> at {STAGE_LABELS[r.stage as Stage]}: {r.reason} ({r.n})</li>)}
            {d.correctionReasons.map((r) => <li key={`c${r.stage}${r.reason}`}><strong>Returned</strong> at {STAGE_LABELS[r.stage as Stage]}: {r.reason} ({r.n})</li>)}
            {!d.declineReasons.length && !d.correctionReasons.length && <li className="muted">None in this period.</li>}
          </ul>
        </section>
        <section className="card" aria-labelledby="h-ops">
          <h2 id="h-ops">Outstanding items and operations</h2>
          <table className="data small">
            <tbody>
              <tr><th scope="row">Awaiting initiator correction</th><td className="num">{d.outstanding.corrections}</td></tr>
              <tr><th scope="row">Documents rejected by reviewers</th><td className="num">{d.outstanding.rejected_docs}</td></tr>
              <tr><th scope="row">Payments not yet confirmed or reconciled</th><td className="num">{d.outstanding.payments_uncertain}</td></tr>
              <tr><th scope="row">Open fulfilment tasks</th><td className="num">{d.outstanding.fulfilment_open}</td></tr>
              <tr><th scope="row">Suspended</th><td className="num">{d.outstanding.suspended}</td></tr>
              {d.paymentStatus.map((p) => <tr key={`${p.payment_status}${p.fulfilment_status}`}><th scope="row">Payment {p.payment_status.toLowerCase()} · fulfilment {p.fulfilment_status.toLowerCase().replace("_", " ")}</th><td className="num">{p.n}</td></tr>)}
              <tr><th scope="row">Vendor Financing POS deployment</th><td className="num">{d.pos.map((p) => `${p.status.toLowerCase()} ${p.n}`).join(" · ") || "—"}</td></tr>
            </tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="h-port">
          <h2 id="h-port">Portfolio</h2>
          <div className="metric-grid">
            <div className="metric"><div className="k">Outstanding</div><div className="v tnum">{formatKobo(d.portfolio.outstandingTotal)}</div></div>
            <div className="metric"><div className="k">Overdue</div><div className="v tnum">{formatKobo(d.portfolio.overdueTotal)}</div></div>
            <div className="metric"><div className="k">Due in 30 days</div><div className="v tnum">{formatKobo(d.portfolio.due30)}</div></div>
          </div>
          <p className="small muted">Facilities: {Object.entries(d.portfolio.byStatus).map(([k, v]) => `${k.toLowerCase().replace("_", " ")} ${v}`).join(" · ") || "none"}</p>
          {d.portfolio.overdueList.length > 0 && (
            <ul className="small">{d.portfolio.overdueList.map((o) => <li key={o.ref}><Link href={`/requests/${o.applicationId}`}>{o.ref}</Link> {o.customer}: {formatKobo(o.overdueKobo)} overdue, {o.dpd} days</li>)}</ul>
          )}
        </section>
      </div>

      <section aria-labelledby="h-pipe" style={{ marginTop: "var(--space-5)" }}>
        <h2 id="h-pipe" className="section-title">Pipeline: current stage, owner and elapsed time</h2>
        <div className="table-wrap">
          <table className="data responsive">
            <thead><tr><th>Request</th><th>Customer · product</th><th>Stage</th><th>Owner</th><th>Elapsed</th><th>Required action</th></tr></thead>
            <tbody>
              {d.pipeline.length === 0 && <tr><td colSpan={6} className="empty">Nothing open in this scope.</td></tr>}
              {d.pipeline.map((r) => {
                const ms = now.getTime() - new Date(r.entered_at).getTime();
                return (
                  <tr key={r.application_id} className="clickable">
                    <td data-label="Request"><Link className="row-link mono" href={`/requests/${r.application_id}`}>{r.ref}</Link></td>
                    <td data-label="Customer">{r.customer_name}<div className="small muted">{r.product} · {formatKobo(r.requested)}</div></td>
                    <td data-label="Stage" className="small">{STAGE_LABELS[r.stage as Stage]}{r.suspended && <span className="badge badge-red">Suspended</span>}</td>
                    <td data-label="Owner" className="small">{r.owner ?? <span className="badge badge-red">Unassigned (exception)</span>}<div className="muted">{ROLE_LABELS[r.owner_role as Role] ?? r.owner_role}</div></td>
                    <td data-label="Elapsed"><WaitChip ms={ms} label={formatDuration(ms)} /></td>
                    <td data-label="Required action" className="small">{r.required_action}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
