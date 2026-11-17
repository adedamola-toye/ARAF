import Link from "next/link";
import { requireRole } from "../../../_lib/auth";
import { db } from "@/server/db";
import { creditExceptionReport } from "@/server/domain/credit-exception";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Credit score exceptions" };

const STATUS: Record<string, string> = { PENDING_REVIEW: "Pending review", APPROVED: "Approved", DECLINED: "Declined", WITHDRAWN: "Withdrawn", SUPERSEDED: "Superseded" };

export default async function CreditExceptions() {
  await requireRole(["SUPER_ADMIN", "UNIT_HEAD", "TEAM_LEAD", "DIVISIONAL_HEAD", "EXECUTIVE_VIEW", "REPORTING_ADMIN"]);
  const r = await creditExceptionReport(db);
  const tiles: [string, number][] = [
    ["Low-score exceptions", r.total],
    ["Pending Team Lead review", r.pendingTeamLead],
    ["Pending Unit Head review", r.pendingUnitHead],
    ["Approved through the workflow", r.approved],
    ["Declined", r.declined],
    ["Disbursed exception facilities", r.disbursed],
  ];
  return (
    <>
      <PageHeader eyebrow="Reports" title="Credit score exceptions" intro="Requests submitted with Proceed with Reason after SeedFi returned a low credit score. These are reported separately from standard credit approvals." />
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {tiles.map(([k, v]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>
      <section className="card">
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col">Product</th>
                <th scope="col">Exception</th>
                <th scope="col">Stage</th>
                <th scope="col">Raised</th>
                <th scope="col">Team Lead</th>
                <th scope="col">Unit Head</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link href={`/requests/${x.application_id}`}>{x.ref}</Link>
                  </td>
                  <td>{x.customer_name ?? "—"}</td>
                  <td>{x.product_label ?? "—"}</td>
                  <td>{STATUS[x.status] ?? x.status}</td>
                  <td>{x.stage.replace(/_/g, " ").toLowerCase()}</td>
                  <td>{formatLagos(x.raised_at)}</td>
                  <td>{x.tl_ack_at ? formatLagos(x.tl_ack_at) : "—"}</td>
                  <td>{x.uh_ack_at ? formatLagos(x.uh_ack_at) : "—"}</td>
                </tr>
              ))}
              {!r.rows.length && (
                <tr>
                  <td colSpan={8} className="muted">
                    No credit score exceptions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
