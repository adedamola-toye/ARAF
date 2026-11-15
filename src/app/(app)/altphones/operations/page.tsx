import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { altphonesAccess } from "@/server/altphones/views";
import { altphonesOperations } from "@/server/executive";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Altphones operations" };
const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");

export default async function AltOperations() {
  const { session, roles } = await requireUser();
  const access = await altphonesAccess(db, session.staffId);
  const isUh = roles.includes("UNIT_HEAD") && access.reviewer;
  if (!access.pm && !access.admin && !isUh) redirect("/altphones");
  const o = await altphonesOperations(db, new Date());
  const pend = o.pending;
  const ex = o.exceptions;
  const metric = (k: string, v: string, href?: string) => (
    <div key={k} className="metric">
      <div className="k">{href ? <Link href={href}>{k}</Link> : k}</div>
      <div className="v tnum">{v}</div>
    </div>
  );
  const sum = (s: string[]) => o.byStatus.filter((x) => s.includes(x.status)).reduce((a, x) => a + Number(x.n), 0);
  return (
    <>
      <PageHeader eyebrow="Altphones" title="Operations" intro="Product Manager and Unit Head view of Altphones origination, approvals, locations, stock and data exceptions. Figures come from ARAF's records." />
      <section aria-labelledby="h-apps">
        <h2 id="h-apps" className="section-title">Applications</h2>
        <div className="metric-grid">
          {metric("Originated (30 days)", n(o.originated30))}
          {metric("Pending approval", n(sum(["UNDER_BPM_REVIEW", "UNDER_PM_REVIEW", "UNDER_UNIT_HEAD_REVIEW"])), "/altphones/reviews")}
          {metric("Approved, not disbursed", n(sum(["APPROVED"])))}
          {metric("Disbursed / completed", n(sum(["DISBURSED", "COMPLETED"])))}
          {metric("Declined or rejected", n(sum(["CREDIT_DECLINED", "REJECTED"])))}
          {metric("Phones issued (30 days)", n(o.issued30))}
        </div>
      </section>

      <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
        <section className="card" aria-labelledby="h-wait">
          <h2 id="h-wait">Waiting for a decision</h2>
          <ul className="plain-list">
            <li>New locations: <strong>{n(pend.locations)}</strong> · address registrations: <strong>{n(pend.addresses)}</strong> · activation changes: <strong>{n(pend.status)}</strong></li>
            <li>BPM mapping requests: <strong>{n(pend.bpm)}</strong></li>
            <li>Setup imports: <strong>{n(pend.imports)}</strong> · stock movements: <strong>{n(pend.movements)}</strong> · stock counts: <strong>{n(pend.counts)}</strong></li>
          </ul>
          <p className="small" style={{ marginBottom: 0 }}><Link href="/altphones/locations?tab=requests">Open approvals</Link></p>
        </section>
        <section className="card" aria-labelledby="h-ex">
          <h2 id="h-ex">Data exceptions</h2>
          <ul className="plain-list">
            <li>Sales waiting with the Placeholder BPM: <strong>{n(ex.placeholder)}</strong></li>
            <li>Active Altshops/Altboxes with no BPM mapped: <strong>{n(ex.unrouted)}</strong></li>
            <li>Locations without a registered address: <strong>{n(ex.noAddress)}</strong></li>
            <li>Location requests returned for correction: <strong>{n(ex.returned)}</strong></li>
            <li>Imports with invalid rows: <strong>{n(ex.importErrors)}</strong></li>
          </ul>
        </section>
      </div>

      <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
        <section className="card" aria-labelledby="h-tat">
          <h2 id="h-tat">Approval turnaround (30 days)</h2>
          <table className="data">
            <thead><tr><th scope="col">Stage</th><th scope="col" className="num">Decisions</th><th scope="col" className="num">Average hours</th></tr></thead>
            <tbody>{o.turnaround.length ? o.turnaround.map((t) => <tr key={t.stage}><td>{{ BPM: "BPM", PM: "Product Manager", UNIT_HEAD: "Unit Head" }[t.stage] ?? t.stage}</td><td className="num">{n(t.n)}</td><td className="num">{t.avg_hours ?? "—"}</td></tr>) : <tr><td colSpan={3} className="muted">No decisions in the last 30 days.</td></tr>}</tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="h-disc">
          <h2 id="h-disc">Inventory discrepancies awaiting approval</h2>
          {o.discrepancies.length ? (
            <ul className="plain-list small">{o.discrepancies.map((d) => <li key={d.ref}><span className="mono">{d.ref}</span> · {d.location}: {Number(d.variance) > 0 ? "+" : ""}{d.variance} units · {formatLagos(d.submitted_at)}</li>)}</ul>
          ) : (
            <p className="small muted">None.</p>
          )}
        </section>
      </div>

      <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
        <section className="card" aria-labelledby="h-stock">
          <div className="card-head"><h2 id="h-stock">Stock by location</h2><a className="btn btn-ghost btn-sm" href="/api/executive/export?dataset=locations">Export CSV</a></div>
          <table className="data">
            <thead><tr><th scope="col">Location</th><th scope="col" className="num">In stock</th><th scope="col" className="num">Reserved</th></tr></thead>
            <tbody>{o.stockByLocation.map((l) => <tr key={`${l.name}-${l.state}`}><td>{l.name}<div className="small muted">{l.state}</div></td><td className="num">{n(l.physical)}</td><td className="num">{n(l.reserved)}</td></tr>)}</tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="h-vf">
          <h2 id="h-vf">Vendor Financing (Unit Head)</h2>
          <ul className="plain-list">
            <li>In progress: <strong>{n(o.vf.inflight)}</strong></li>
            <li>Business photographs skipped by Team Leads: <strong>{n(o.vf.skips)}</strong> ({n(o.vf.skips30)} in 30 days) — reasons are on each request and in <Link href="/notifications">Notifications</Link>.</li>
          </ul>
          <p className="small" style={{ marginBottom: 0 }}>
            <a href="/api/executive/export?dataset=bpm">BPM performance (CSV)</a> · <a href="/api/executive/export?dataset=historical">Historical accounts (CSV)</a>
          </p>
        </section>
      </div>
    </>
  );
}
