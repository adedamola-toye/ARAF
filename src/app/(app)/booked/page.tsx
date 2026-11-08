import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { bookedRequests, repaymentPrompts } from "@/server/domain/views";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { INITIATOR_ROLES } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { addDaysToDateString, formatDateOnly, lagosDate } from "@/server/time";

export const metadata = { title: "Booked Requests" };

export default async function Booked() {
  const { session, roles } = await requireUser();
  const isReporter = roles.includes("SUPER_ADMIN") || roles.includes("REPORTING_ADMIN");
  const isInitiator = INITIATOR_ROLES.some((r) => roles.includes(r));
  if (!isReporter && !isInitiator) redirect("/forbidden");
  const showAll = isReporter && !INITIATOR_ROLES.includes(session.activeRole as never);
  const rows = await bookedRequests(db, { initiatorId: showAll ? null : session.staffId });
  const today = lagosDate(new Date());
  const prompts = showAll ? [] : await repaymentPrompts(db, session.staffId, today, addDaysToDateString(today, 14));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Booked Requests</h1>
          <p>{showAll ? "All successful disbursements (reporting view)." : "Successful disbursements on requests you initiated, with repayment dates."}</p>
        </div>
      </div>
      {prompts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Repayment prompts: due in the next 14 days</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {prompts.map((p, i) => (
              <li key={i}>
                <strong>{formatDateOnly(p.due_date)}</strong> · <Link href={`/requests/${p.id}`}>{p.ref}</Link> {p.customer_name} · instalment {p.seq} · {formatKobo(p.amount_kobo)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Request ID</th>
              <th>Customer</th>
              <th>Owner</th>
              <th className="right">Requested</th>
              <th className="right">Approved</th>
              <th className="right">Disbursed</th>
              <th>Transaction ref</th>
              <th>Booking date</th>
              <th>Status</th>
              <th>Vendor confirmation</th>
              <th>Payment schedule</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="empty">
                  No disbursements yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="clickable">
                <td className="nowrap">
                  <Link className="row-link mono" href={`/requests/${r.id}`}>
                    {r.ref}
                  </Link>
                </td>
                <td>{r.customer_name}</td>
                <td className="small">{r.owner_name}</td>
                <td className="num">{formatKobo(r.requested_amount_kobo)}</td>
                <td className="num">{formatKobo(r.approved_amount_kobo)}</td>
                <td className="num">
                  <strong>{formatKobo(r.disbursed_kobo)}</strong>
                </td>
                <td className="mono small">{r.transaction_ref}</td>
                <td className="small nowrap">{formatDateOnly(r.disbursed_on)}</td>
                <td>
                  <span className={`badge ${r.status === "CLOSED" ? "badge-dark" : "badge-green"}`}>{r.status === "CLOSED" ? "Closed" : STAGE_LABELS[r.stage as Stage]}</span>
                </td>
                <td>{r.vendor_confirmed_at ? <span className="badge badge-green">Confirmed</span> : <span className="badge badge-yellow">Pending</span>}</td>
                <td className="small nowrap">
                  {(r.schedule ?? []).map((s: { seq: number; due: string; amount: string }) => (
                    <div key={s.seq}>
                      {formatDateOnly(s.due)} · {formatKobo(s.amount)}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
