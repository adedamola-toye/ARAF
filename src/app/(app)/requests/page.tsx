import Link from "next/link";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { initiatorRequests } from "@/server/domain/views";
import { type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role, INITIATOR_ROLES } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { formatDuration, formatLagos } from "@/server/time";
import { REMINDER_MIN_AGE_MS } from "@/server/domain/workflow";
import { ReminderButton } from "./[id]/CaseClient";
import { PageHeader } from "@/components/PageHeader";
import { StageChip, WaitChip } from "@/components/Status";
import { ClipboardList, FilePlus2 } from "lucide-react";

export const metadata = { title: "View Progress" };

export default async function Progress() {
  const { session, roles } = await requireUser();
  const rows = await initiatorRequests(db, session.staffId);
  const isInitiator = INITIATOR_ROLES.some((r) => roles.includes(r));
  const now = Date.now();
  const drafts = rows.filter((r) => r.status === "DRAFT");
  const live = rows.filter((r) => r.status !== "DRAFT");
  return (
    <>
      <PageHeader
        eyebrow="Work"
        title="View Progress"
        intro="Requests you initiated: current owner, stage and time waiting. Open a request for its full handoff history."
        actions={
          isInitiator && (
            <Link className="btn btn-primary" href="/requests/new">
              <FilePlus2 className="icon" aria-hidden="true" /> Initiate New Request
            </Link>
          )
        }
      />
      {drafts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Saved drafts</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {drafts.map((d) => (
              <li key={d.id}>
                <Link href={`/requests/${d.id}/edit`}>{d.ref}</Link> · {d.customer_name || "Unnamed draft"} · last saved {formatLagos(d.updated_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="table-wrap">
        <table className="data responsive">
          <thead>
            <tr>
              <th>Request ID</th>
              <th>Customer</th>
              <th className="right">Amount</th>
              <th>Stage</th>
              <th>Current owner</th>
              <th>In stage since</th>
              <th>Time waiting</th>
              <th>Reminder</th>
            </tr>
          </thead>
          <tbody>
            {live.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  <ClipboardList className="icon" aria-hidden="true" />
                  No submitted requests yet.
                </td>
              </tr>
            )}
            {live.map((r) => {
              const waited = r.assigned_at ? now - new Date(r.assigned_at).getTime() : 0;
              return (
                <tr key={r.id} className="clickable">
                  <td className="nowrap" data-label="Request ID">
                    <Link className="row-link mono" href={`/requests/${r.id}?tab=history`}>
                      {r.ref}
                    </Link>
                  </td>
                  <td data-label="Customer">{r.customer_name}</td>
                  <td className="num" data-label="Amount">{formatKobo(r.requested_amount_kobo)}</td>
                  <td data-label="Stage">
                    <StageChip stage={r.stage as Stage} status={r.status} />
                  </td>
                  <td className="small" data-label="Current owner">
                    {r.owner_name ?? (r.task_id ? <span className="badge badge-red">Awaiting assignment</span> : "—")}
                    {r.owner_role && <div className="muted">{ROLE_LABELS[r.owner_role as Role]}</div>}
                  </td>
                  <td className="small nowrap" data-label="In stage since">{r.entered_at ? formatLagos(r.entered_at) : "—"}</td>
                  <td className="nowrap" data-label="Waiting">{r.assigned_at ? <WaitChip ms={waited} label={formatDuration(waited)} /> : "—"}</td>
                  <td className="row-actions">
                    {r.owner_id && r.owner_id !== session.staffId ? (
                      waited > REMINDER_MIN_AGE_MS ? (
                        <ReminderButton applicationId={r.id} />
                      ) : (
                        <span className="small muted">Available after 6h</span>
                      )
                    ) : (
                      <span className="small muted">—</span>
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
