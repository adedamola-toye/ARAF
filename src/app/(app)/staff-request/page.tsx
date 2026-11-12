import Link from "next/link";
import { FilePlus2, FileSignature, Inbox } from "lucide-react";
import { requireUser } from "../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { myRequestRows } from "@/server/staff/views";
import { currentSettings } from "@/server/staff/core";
import { bpsLabel, formatNairaKobo, STAFF_NEXT_ACTION, STAFF_STATUS_LABELS, STAFF_STATUS_QUEUE, type StaffStatus } from "@/lib/staff-financing";
import { StaffStatusBadge, eventLabel } from "./StatusBadge";
import { Countdown } from "./StaffForms";
import { startStaffRequestAction } from "./actions";

export const metadata = { title: "Staff Personal Request" };

export default async function StaffRequestHub() {
  const { session } = await requireUser();
  const rows = await myRequestRows(db, session.staffId);
  const settings = await currentSettings(db);
  const offers = rows.filter((r) => r.status === "AWAITING_SIGNED_OFFER" && !r.signed_offer_received_at);
  const open = rows.filter((r) => !["COMPLETED", "DECLINED", "OFFER_EXPIRED"].includes(r.status));
  const done = rows.filter((r) => r.status === "COMPLETED");
  return (
    <>
      <PageHeader
        eyebrow="Staff Personal Request"
        title="My staff financing"
        intro="Apply for personal financing as a member of staff and follow each request from submission to disbursement."
        actions={
          <form action={startStaffRequestAction}>
            <button className="btn btn-primary">
              <FilePlus2 className="icon" aria-hidden="true" /> New financing request
            </button>
          </form>
        }
      />
      <div className="metric-grid" style={{ marginBottom: "var(--space-5)" }}>
        <div className="metric">
          <div className="k">My requests</div>
          <div className="v">{rows.length}</div>
        </div>
        <div className="metric">
          <div className="k">In progress</div>
          <div className="v">{open.length}</div>
        </div>
        <div className="metric">
          <div className="k">Offers requiring action</div>
          <div className="v">{offers.length}</div>
        </div>
        <div className="metric">
          <div className="k">Completed</div>
          <div className="v">{done.length}</div>
        </div>
      </div>

      {offers.map((r) => (
        <div key={r.id} className="alert alert-warn" style={{ marginBottom: "var(--space-4)" }}>
          <FileSignature className="icon" aria-hidden="true" />
          <span>
            <strong>Offer letter ready for {r.ref}.</strong> Sign and upload it by {formatLagos(r.offer_deadline_at)} (<Countdown deadline={new Date(r.offer_deadline_at).toISOString()} />
            ). <Link href={`/staff-request/${r.id}`}>Open the offer</Link>
          </span>
        </div>
      ))}

      {rows.length === 0 ? (
        <div className="card empty-card">
          <div className="empty">
            <Inbox className="icon" aria-hidden="true" />
            <strong>No staff financing requests yet</strong>
            <p>
              Start a request to see the {bpsLabel(settings.deduction_rate_bps)} deduction and your net amount before you submit. Drafts are saved on the server and
              can be resumed at any time.
            </p>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data responsive">
            <thead>
              <tr>
                <th>Reference</th>
                <th className="num">Requested</th>
                <th className="num">Deduction</th>
                <th className="num">Net amount</th>
                <th>Submitted</th>
                <th>Current stage</th>
                <th>Assigned queue</th>
                <th>Latest update</th>
                <th>Next action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable">
                  <td data-label="Reference">
                    <Link className="row-link" href={`/staff-request/${r.id}`}>
                      {r.ref}
                    </Link>
                  </td>
                  <td className="num" data-label="Requested">
                    {r.gross_kobo ? formatNairaKobo(r.gross_kobo) : "—"}
                  </td>
                  <td className="num" data-label="Deduction">
                    {r.deduction_kobo ? formatNairaKobo(r.deduction_kobo) : "—"}
                  </td>
                  <td className="num" data-label="Net amount">
                    <strong>{r.net_kobo ? formatNairaKobo(r.net_kobo) : "—"}</strong>
                  </td>
                  <td data-label="Submitted" className="small">
                    {r.first_submitted_at ? formatLagos(r.first_submitted_at) : "Not yet"}
                  </td>
                  <td data-label="Current stage">
                    <StaffStatusBadge status={r.status} />
                    {r.status === "AWAITING_SIGNED_OFFER" && r.offer_deadline_at && !r.signed_offer_received_at && (
                      <div className="small">
                        <Countdown deadline={new Date(r.offer_deadline_at).toISOString()} />
                      </div>
                    )}
                  </td>
                  <td data-label="Assigned queue" className="small">
                    {STAFF_STATUS_QUEUE[r.status as StaffStatus]}
                  </td>
                  <td data-label="Latest update" className="small">
                    {eventLabel(r.latest_event)}
                    <div className="muted">{r.latest_at ? formatLagos(r.latest_at) : ""}</div>
                  </td>
                  <td data-label="Next action" className="small">
                    {r.status === "AWAITING_SIGNED_OFFER" && r.signed_offer_received_at ? "Signed offer received; awaiting a Disbursement Officer." : STAFF_NEXT_ACTION[r.status as StaffStatus]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ marginTop: "var(--space-4)" }}>
        Final outcomes: {rows.filter((r) => ["COMPLETED", "DECLINED", "OFFER_EXPIRED"].includes(r.status)).map((r) => `${r.ref} ${STAFF_STATUS_LABELS[r.status as StaffStatus].toLowerCase()}`).join(" · ") || "none yet"}.
      </p>
    </>
  );
}
