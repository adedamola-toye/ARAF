import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireRole } from "../../_lib/auth";
import { db } from "@/server/db";
import { cadOverview, type CadRow } from "@/server/domain/cad";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { formatDuration, formatLagos, fromLagos, lagosParts } from "@/server/time";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Disbursements" };

const TABS = [
  ["ready", "Ready for disbursement"],
  ["checking", "Awaiting verification"],
  ["processing", "Processing (uncertain)"],
  ["held", "Held"],
  ["failed", "Failed attempts"],
  ["done", "Successfully disbursed"],
] as const;
type Tab = (typeof TABS)[number][0];

function Rows({ rows, now }: { rows: CadRow[]; now: number }) {
  if (!rows.length) return <p className="muted">Nothing here.</p>;
  return (
    <ul className="home-list">
      {rows.map((r) => (
        <li key={r.application_id}>
          <Link className="home-row" href={`/requests/${r.application_id}${r.mine && r.task_id ? `?task=${r.task_id}` : ""}`}>
            <span className="home-main">
              <strong>{r.customer_name ?? r.ref}</strong>
              <span className="small muted">
                {r.ref} · {r.product_label ?? "WakeelBoost"} · {STAGE_LABELS[r.stage as Stage]} · {r.assignee_name ?? "unassigned"}
                {r.assigned_at ? ` · waiting ${formatDuration(now - new Date(r.assigned_at).getTime())}` : ""}
                {r.hold_reason ? ` · held: ${r.hold_reason}` : ""}
              </span>
            </span>
            {r.mine && <span className="badge badge-blue">Yours</span>}
            <Money size="table" as="span" kobo={r.amount_kobo} />
            <ArrowRight className="icon" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** CAD workspace. Every figure comes from records; success only from a recorded core-banking reference. */
export default async function Disbursements({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { session } = await requireRole(["DISBURSEMENT_OFFICER_1", "DISBURSEMENT_OFFICER_2", "SUPER_ADMIN"]);
  const sp = await searchParams;
  const tab: Tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? "ready") as Tab;
  const now = new Date();
  const l = lagosParts(now);
  const o = await cadOverview(db, session.staffId, fromLagos(l.year, l.month, 1));
  const count: Record<Tab, number> = {
    ready: o.ready.rows.length,
    checking: o.checking.rows.length,
    processing: o.processing.rows.length,
    held: o.held.rows.length,
    failed: o.failed.length,
    done: o.done.length,
  };
  return (
    <>
      <PageHeader eyebrow="CAD" title="Disbursements" intro="ARAF records postings made in core banking; it does not move funds. A facility counts as disbursed only once its transaction reference is recorded." />
      <section className="grid-3" style={{ marginBottom: "var(--space-6)" }} aria-label="Disbursement figures">
        <Money size="hero" label="Ready for disbursement" kobo={o.ready.kobo} hint={`${o.ready.rows.length} facilit${o.ready.rows.length === 1 ? "y" : "ies"} checked by DO1, awaiting booking`} />
        <Money size="lg" label="Awaiting verification (DO1)" kobo={o.checking.kobo} hint={`${o.checking.rows.length} facilit${o.checking.rows.length === 1 ? "y" : "ies"}`} />
        <Money size="lg" label="Disbursed this month" kobo={o.month.kobo} hint={`${o.month.n} recorded posting${o.month.n === 1 ? "" : "s"}`} />
      </section>
      {(o.held.rows.length > 0 || o.processing.rows.length > 0) && (
        <div className="alert alert-warn" role="status">
          {o.processing.rows.length > 0 && `${o.processing.rows.length} posting${o.processing.rows.length === 1 ? " has an" : "s have an"} uncertain outcome to verify. `}
          {o.held.rows.length > 0 && `${o.held.rows.length} on hold.`}
        </div>
      )}
      <nav className="tabs" aria-label="Disbursement queues">
        {TABS.map(([k, label]) => (
          <Link key={k} className="tab" href={`/disbursements?tab=${k}`} aria-current={tab === k ? "page" : undefined}>
            {label} <span className="badge">{count[k]}</span>
          </Link>
        ))}
      </nav>
      {tab === "ready" && <Rows rows={o.ready.rows} now={now.getTime()} />}
      {tab === "checking" && <Rows rows={o.checking.rows} now={now.getTime()} />}
      {tab === "processing" && <Rows rows={o.processing.rows} now={now.getTime()} />}
      {tab === "held" && <Rows rows={o.held.rows} now={now.getTime()} />}
      {tab === "failed" &&
        (o.failed.length ? (
          <ul className="home-list">
            {o.failed.map((f, i) => (
              <li key={i}>
                <Link className="home-row" href={`/requests/${f.application_id}`}>
                  <span className="home-main">
                    <strong>{f.customer_name ?? f.ref}</strong>
                    <span className="small muted">
                      {f.ref} · {formatLagos(f.recorded_at)} · {f.note}
                    </span>
                  </span>
                  <span className={`badge ${f.outcome === "UNCERTAIN" && !f.resolution ? "badge-red" : "badge-warn"}`}>
                    {f.outcome === "FAILED" ? "Failed" : f.resolution === "POSTED" ? "Verified posted" : f.resolution ? "Verified not posted" : "Uncertain"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No failed or uncertain postings this month.</p>
        ))}
      {tab === "done" &&
        (o.done.length ? (
          <div className="table-wrap">
            <table className="data responsive">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Amount</th>
                  <th>Reference</th>
                  <th>Value date</th>
                  <th>Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {o.done.map((d) => (
                  <tr key={d.application_id}>
                    <td data-label="Customer">
                      <Link href={`/disbursements/${d.application_id}`}>{d.customer_name ?? d.ref}</Link>
                      <div className="small muted">{d.ref}</div>
                    </td>
                    <td className="num" data-label="Amount">
                      <Money size="table" as="span" kobo={d.amount_kobo} />
                    </td>
                    <td data-label="Reference" className="tnum">
                      {d.transaction_ref}
                    </td>
                    <td data-label="Value date">{d.disbursed_on}</td>
                    <td data-label="Recorded by">
                      {d.recorded_by_name}
                      <div className="small muted">{formatLagos(d.recorded_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No disbursements recorded yet.</p>
        ))}
      {o.correction.length > 0 && (
        <p className="small muted" style={{ marginTop: "var(--space-4)" }}>
          {o.correction.length} facilit
          {o.correction.length === 1 ? "y is" : "ies are"} back with Credit Officer 3 for correction.
        </p>
      )}
    </>
  );
}
