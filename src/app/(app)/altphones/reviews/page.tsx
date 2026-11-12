import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { altphonesAccess, performance, reviewHistory, reviewQueues, searchApplications } from "@/server/altphones/views";
import { ALT_STATUS_LABELS, formatNaira, type AltStatus } from "@/lib/altphones";
import { AltStatusBadge, AppTable } from "../ui";

export const metadata = { title: "Altphones reviews" };

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");

export default async function AltReviews({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { session } = await requireUser();
  const access = await altphonesAccess(db, session.staffId);
  if (!access.reviewer && !access.admin && !access.pm) redirect("/altphones");
  const [q, history, perf] = await Promise.all([reviewQueues(db, session.staffId), reviewHistory(db, session.staffId, 30), performance(db, Number(sp.days ?? 30) || 30)]);
  const queues = [
    q.bpm && { key: "bpm", title: "Smile Associate applications awaiting your review", rows: q.bpm, empty: "No applications are waiting for Business Performance Manager review." },
    q.pm && { key: "pm", title: "Product review queue", rows: q.pm, empty: "No applications are waiting for product review." },
    q.uh && { key: "uh", title: "Final approval queue", rows: q.uh, empty: "No applications are waiting for your final approval." },
  ].filter(Boolean) as { key: string; title: string; rows: Parameters<typeof AppTable>[0]["rows"]; empty: string }[];
  const canSearch = access.pm || access.admin;
  const search = canSearch && (sp.q !== undefined || sp.status) ? await searchApplications(db, sp.q ?? "", sp.status && sp.status in ALT_STATUS_LABELS ? sp.status : null) : null;
  const t = perf.totals;
  return (
    <>
      <PageHeader eyebrow="Altphones" title="Reviews and performance" intro="Applications waiting for your decision come first." />
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {(
          [
            ["Awaiting you", n((q.bpm?.length ?? 0) + (q.pm?.length ?? 0) + (q.uh?.length ?? 0))],
            ["In review (all stages)", n(t.in_review)],
            ["Approved, awaiting handover", n(t.approved)],
            [`Outright sales (${sp.days ?? 30} days)`, n(t.outright)],
            [`Credit disbursed (${sp.days ?? 30} days)`, n(t.credit)],
            ["Amount financed", formatNaira(t.financed)],
            ["Average approval time", t.avg_turnaround_h === null ? "—" : `${t.avg_turnaround_h} h`],
            ["Refunds outstanding", n(t.refunds)],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>
      {queues.map((qq) => (
        <section key={qq.key} className="card" aria-labelledby={`q-${qq.key}`}>
          <div className="card-head">
            <h2 id={`q-${qq.key}`}>{qq.title}</h2>
            <span className="badge">{qq.rows.length}</span>
          </div>
          <AppTable rows={qq.rows} empty={qq.empty} showOfficer />
        </section>
      ))}
      {q.bpmReturned && q.bpmReturned.length > 0 && (
        <section className="card" aria-labelledby="q-ret">
          <h2 id="q-ret">Returned Smile Associate applications</h2>
          <AppTable rows={q.bpmReturned} empty="" showOfficer />
        </section>
      )}
      <section className="card" aria-labelledby="q-hist">
        <h2 id="q-hist">Your review history</h2>
        {history.length === 0 ? (
          <p className="muted small">No decisions yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Your decision</th>
                  <th scope="col">Now</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.id}-${h.decided_at.toISOString()}`}>
                    <td>
                      <Link className="mono" href={`/altphones/applications/${h.id}`}>
                        {h.ref}
                      </Link>
                      <div className="small muted">{h.customer_name}</div>
                    </td>
                    <td>
                      <span className={`badge ${h.action === "APPROVE" ? "badge-green" : h.action === "REJECT" ? "badge-red" : "badge-warn"}`}>{h.action === "APPROVE" ? "Approved" : h.action === "REJECT" ? "Rejected" : "Returned"}</span>
                      {h.comments && <div className="small">{h.comments}</div>}
                    </td>
                    <td>
                      <AltStatusBadge status={h.status} />
                    </td>
                    <td className="small muted">{formatLagos(h.decided_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="grid-2 alt-reports">
        <section className="card" aria-labelledby="r-off">
          <h2 id="r-off">Officer performance</h2>
          {perf.officers.length === 0 ? (
            <p className="muted small">No sales in this period.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Officer</th>
                  <th scope="col" className="num">Outright</th>
                  <th scope="col" className="num">Credit</th>
                  <th scope="col" className="num">Open</th>
                </tr>
              </thead>
              <tbody>
                {perf.officers.map((o) => (
                  <tr key={`${o.name}-${o.channel}`}>
                    <td>
                      {o.name} <span className="small muted">{o.channel === "SA" ? "SA" : "DO"}</span>
                    </td>
                    <td className="num">{n(o.outright)}</td>
                    <td className="num">{n(o.credit)}</td>
                    <td className="num">{n(o.open)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card" aria-labelledby="r-due">
          <h2 id="r-due">Scheduled repayments</h2>
          {perf.dues.length === 0 ? (
            <p className="muted small">No upcoming instalments.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col" className="num">Instalments</th>
                  <th scope="col" className="num">Amount due</th>
                </tr>
              </thead>
              <tbody>
                {perf.dues.map((d) => (
                  <tr key={d.month}>
                    <td>{d.month}</td>
                    <td className="num">{n(d.n)}</td>
                    <td className="num">{formatNaira(d.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted">
            Stock: {n(perf.stock.physical)} units on hand, {n(perf.stock.reserved)} reserved.
          </p>
        </section>
      </div>
      {canSearch && (
      <section className="card" aria-labelledby="r-find">
        <h2 id="r-find">Find an application</h2>
        <form className="filters" role="search" style={{ marginBottom: search ? "var(--space-4)" : 0 }}>
          <div className="field">
            <label htmlFor="q">Reference, customer or IMEI</label>
            <input id="q" name="q" type="search" defaultValue={sp.q} />
          </div>
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={sp.status ?? ""}>
              <option value="">Any</option>
              {(Object.keys(ALT_STATUS_LABELS) as AltStatus[]).map((s) => (
                <option key={s} value={s}>
                  {ALT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <button className="btn">Search</button>
        </form>
        {search && <AppTable rows={search} empty="No matching applications." showOfficer />}
      </section>
      )}
    </>
  );
}
