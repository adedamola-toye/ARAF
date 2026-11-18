import Link from "next/link";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { reviewedRequests } from "@/server/domain/views";
import { STAGE_LABELS, ACTION_LABELS, type Stage, type TaskAction } from "@/server/domain/stages";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { StageChip } from "@/components/Status";
import { ListChecks } from "lucide-react";

export const metadata = { title: "Requests I approved" };

type SP = Record<string, string | undefined>;

/** Every request the officer reviewed, approved or was assigned: where it is now, through disbursement. */
export default async function Approved({ searchParams }: { searchParams: Promise<SP> }) {
  const { session } = await requireUser();
  const sp = await searchParams;
  const all = await reviewedRequests(db, session.staffId);
  const filter = sp.show === "disbursed" ? "disbursed" : sp.show === "open" ? "open" : "all";
  const rows = all.filter((r) => (filter === "disbursed" ? r.disbursed_kobo !== null : filter === "open" ? r.disbursed_kobo === null && !["REJECTED", "WITHDRAWN", "EXPIRED"].includes(r.stage) : true));
  const n = (f: (r: (typeof all)[number]) => boolean) => all.filter(f).length;
  return (
    <>
      <PageHeader
        eyebrow="Work"
        title="Requests I approved"
        intro="Every request you reviewed, approved or were assigned, with where it is now — through documentation, disbursement and RM confirmation. Open one to see its full history."
      />
      <nav className="tabs" aria-label="Show">
        {(
          [
            ["all", `All (${all.length})`],
            ["open", `In progress (${n((r) => r.disbursed_kobo === null && !["REJECTED", "WITHDRAWN", "EXPIRED"].includes(r.stage))})`],
            ["disbursed", `Disbursed (${n((r) => r.disbursed_kobo !== null)})`],
          ] as const
        ).map(([k, l]) => (
          <Link key={k} className="tab" href={k === "all" ? "/requests/approved" : `/requests/approved?show=${k}`} aria-current={filter === k ? "page" : undefined}>
            {l}
          </Link>
        ))}
      </nav>
      <div className="table-wrap">
        <table className="data responsive">
          <thead>
            <tr>
              <th>Request ID</th>
              <th>Customer</th>
              <th>Product</th>
              <th className="right">Amount</th>
              <th>Your decision</th>
              <th>Stage now</th>
              <th>With</th>
              <th className="right">Disbursed</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr>
                <td colSpan={8} className="empty">
                  <ListChecks className="icon" aria-hidden="true" />
                  No requests here yet. Requests appear as soon as one is assigned to you.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const d = r.my_decision as { stage: Stage; action: TaskAction; at: string } | null;
              return (
                <tr key={r.id} className="clickable">
                  <td className="nowrap" data-label="Request ID">
                    <Link className="row-link mono" href={`/requests/${r.id}?tab=history`}>
                      {r.ref}
                    </Link>
                  </td>
                  <td data-label="Customer">{r.customer_name}</td>
                  <td data-label="Product">{r.product_label ?? "WakeelBoost"}</td>
                  <td className="num" data-label="Amount">
                    {r.requested_amount_kobo !== null ? formatKobo(Number(r.requested_amount_kobo)) : "—"}
                  </td>
                  <td className="small" data-label="Your decision">
                    {d ? (
                      <>
                        {ACTION_LABELS[d.action] ?? d.action} · {STAGE_LABELS[d.stage] ?? d.stage}
                        <div className="muted">{formatLagos(new Date(d.at))}</div>
                      </>
                    ) : (
                      <span className="muted">Assigned to you; no decision yet</span>
                    )}
                  </td>
                  <td data-label="Stage now">
                    <StageChip stage={r.stage as Stage} status={r.status} />
                  </td>
                  <td className="small" data-label="With">
                    {r.owner_id === session.staffId ? <strong>You</strong> : (r.owner_name ?? "—")}
                  </td>
                  <td className="num small" data-label="Disbursed">
                    {r.disbursed_kobo !== null ? (
                      <>
                        {formatKobo(Number(r.disbursed_kobo))}
                        <div className="muted">{String(r.disbursed_on instanceof Date ? r.disbursed_on.toISOString().slice(0, 10) : r.disbursed_on)}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
