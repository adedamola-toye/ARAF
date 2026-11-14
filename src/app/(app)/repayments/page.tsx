import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { repaymentMonitor, retailScope } from "@/server/retail-reports";
import { cbsStatus } from "@/server/integrations/cbs";
import { listProducts } from "@/server/domain/products";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Repayment monitoring" };

const CBS_LABEL = { NOT_CONNECTED: "Not connected", IN_TESTING: "In testing", CONNECTED: "Connected", SUSPENDED: "Suspended" } as const;
const SOURCE_LABEL: Record<string, string> = { MANUAL_EVIDENCE: "Manual entry with evidence", INTEGRATION: "Integration" };

export default async function Repayments({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session } = await requireUser();
  const scope = await retailScope(db, session.staffId);
  if (!scope) redirect("/forbidden");
  const sp = await searchParams;
  const products = await listProducts(db, { retailOnly: true });
  const f = { product: products.some((p) => p.code === sp.product) ? sp.product! : null };
  const now = new Date();
  const m = await repaymentMonitor(db, scope, f, now);
  const cbs = await cbsStatus(db);
  const t = m.totals;
  return (
    <>
      <PageHeader eyebrow="Reporting" title="Repayment monitoring" intro={<>Scope: <strong>{scope.label}</strong>. Expected schedules against repayments recorded in ARAF, as of {m.asOf} (Lagos).</>} />
      <div className={`alert ${cbs.status === "CONNECTED" ? "alert-info" : "alert-warn"}`} role="status">
        <div>
          <strong>Core banking: {CBS_LABEL[cbs.status]}.</strong> {cbs.status === "CONNECTED" ? `Last synchronised ${cbs.last_sync_at ? formatLagos(cbs.last_sync_at) : "—"}.` : "These figures come only from repayments recorded in ARAF (manual entries with evidence). They are not core banking balances and may lag what the customer has actually paid."}
          {cbs.note && cbs.status !== "NOT_CONNECTED" && <> {cbs.note}</>}
        </div>
      </div>

      <form className="filters" method="get" aria-label="Filters">
        <div className="field">
          <label htmlFor="product">Product</label>
          <select id="product" name="product" defaultValue={f.product ?? ""}>
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn">Apply</button>
      </form>

      <div className="metric-grid">
        <div className="metric"><div className="k">Active facilities</div><div className="v tnum">{t.facilities}</div></div>
        <div className="metric"><div className="k">Due to date</div><div className="v tnum">{formatKobo(t.dueToDateKobo)}</div></div>
        <div className="metric"><div className="k">Repaid (recorded)</div><div className="v tnum">{formatKobo(t.paidKobo)}</div></div>
        <div className="metric"><div className="k">Overdue</div><div className="v tnum">{formatKobo(t.overdueKobo)}</div><div className="small muted">{t.dueToDateKobo ? `${((t.overdueKobo / t.dueToDateKobo) * 100).toFixed(1)}% of amount due` : "—"}</div></div>
        <div className="metric"><div className="k">Outstanding</div><div className="v tnum">{formatKobo(t.outstandingKobo)}</div></div>
        <div className="metric">
          <div className="k">{m.pdo?.name ?? "Past Due Obligation (PDO)"}</div>
          <div className="v small">{m.pdo?.status === "APPROVED" ? "Definition approved; calculation not yet enabled" : "Awaiting approved definition"}</div>
          <div className="small muted">Not calculated until Credit approves how PDO is measured.</div>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
        <section className="card" aria-labelledby="h-age">
          <h2 id="h-age">Days past due</h2>
          <table className="data">
            <thead><tr><th scope="col">Bucket</th><th scope="col" className="num">Facilities</th><th scope="col" className="num">Overdue</th><th scope="col" className="num">Outstanding</th></tr></thead>
            <tbody>
              {m.buckets.map((b) => (
                <tr key={b.label}><td>{b.label}</td><td className="num">{b.count}</td><td className="num">{formatKobo(b.overdueKobo)}</td><td className="num">{formatKobo(b.outstandingKobo)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="h-src">
          <h2 id="h-src">Where repayment records come from</h2>
          {m.sources.length ? (
            <ul className="plain-list small">
              {m.sources.map((s) => (
                <li key={s.source}>{SOURCE_LABEL[s.source] ?? s.source}: {s.count} record{s.count === 1 ? "" : "s"}, last recorded {s.last ? formatLagos(s.last) : "—"}</li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No repayments have been recorded yet.</p>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>WakeelBoost repayment schedules exist in ARAF but repayments against them are not recorded here, so they are not shown.</p>
        </section>
      </div>

      <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
        {([["By product", m.byProduct], ["By location", m.byLocation]] as const).map(([title, rows]) => (
          <section key={title} className="card">
            <h2>{title}</h2>
            {rows.length ? (
              <table className="data">
                <thead><tr><th scope="col">{title.slice(3)}</th><th scope="col" className="num">Facilities</th><th scope="col" className="num">Overdue</th><th scope="col" className="num">Outstanding</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{r.count}</td><td className="num">{formatKobo(r.overdueKobo)}</td><td className="num">{formatKobo(r.outstandingKobo)}</td></tr>)}</tbody>
              </table>
            ) : (
              <p className="small muted">No active facilities.</p>
            )}
          </section>
        ))}
      </div>

      <section className="card" aria-labelledby="h-od" style={{ marginTop: "var(--space-4)" }}>
        <h2 id="h-od">Overdue facilities</h2>
        {m.overdue.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Request</th><th scope="col">Customer</th><th scope="col">Product</th><th scope="col" className="num">Days past due</th><th scope="col" className="num">Overdue</th><th scope="col" className="num">Outstanding</th><th scope="col">Next due</th></tr></thead>
              <tbody>
                {m.overdue.map((o) => (
                  <tr key={o.ref}>
                    <td><Link href={`/requests/${o.applicationId}`} className="mono">{o.ref}</Link></td>
                    <td>{o.customer}</td>
                    <td>{o.product}</td>
                    <td className="num">{o.dpd}</td>
                    <td className="num">{formatKobo(o.overdueKobo)}</td>
                    <td className="num">{formatKobo(o.outstandingKobo)}</td>
                    <td>{o.nextDue ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">No facility is overdue on the recorded repayments.</p>
        )}
      </section>
    </>
  );
}
