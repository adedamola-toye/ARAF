import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { bookedRequests, repaymentPrompts } from "@/server/domain/views";
import { type Stage } from "@/server/domain/stages";
import { PageHeader } from "@/components/PageHeader";
import { StageChip } from "@/components/Status";
import { INITIATOR_ROLES } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { addDaysToDateString, formatDateOnly, lagosDate } from "@/server/time";

export const metadata = { title: "Booked Requests" };

export default async function Booked({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, roles } = await requireUser();
  const sp = await searchParams;
  const isReporter = roles.includes("SUPER_ADMIN") || roles.includes("REPORTING_ADMIN");
  const isInitiator = INITIATOR_ROLES.some((r) => roles.includes(r));
  if (!isReporter && !isInitiator) redirect("/forbidden");
  const showAll = isReporter && !INITIATOR_ROLES.includes(session.activeRole as never);
  const all = await bookedRequests(db, { initiatorId: showAll ? null : session.staffId });
  const q = (sp.q ?? "").toLowerCase().trim();
  const rows = all.filter(
    (r) =>
      (!q || r.ref.toLowerCase().includes(q) || String(r.customer_name ?? "").toLowerCase().includes(q) || String(r.transaction_ref).toLowerCase().includes(q)) &&
      (!sp.status || (sp.status === "CLOSED" ? r.status === "CLOSED" : r.status !== "CLOSED")) &&
      (!sp.vendor || (sp.vendor === "pending" ? !r.vendor_confirmed_at : !!r.vendor_confirmed_at)) &&
      (!sp.from || String(r.disbursed_on instanceof Date ? r.disbursed_on.toISOString() : r.disbursed_on).slice(0, 10) >= sp.from) &&
      (!sp.to || String(r.disbursed_on instanceof Date ? r.disbursed_on.toISOString() : r.disbursed_on).slice(0, 10) <= sp.to),
  );
  const totalDisbursed = rows.reduce((s, r) => s + Number(r.disbursed_kobo), 0);
  const pendingVendor = rows.filter((r) => !r.vendor_confirmed_at).length;
  const filtered = rows.length !== all.length;
  const today = lagosDate(new Date());
  const prompts = showAll ? [] : await repaymentPrompts(db, session.staffId, today, addDaysToDateString(today, 14));
  return (
    <>
      <PageHeader eyebrow={showAll ? "Reporting" : "Work"} title="Booked Requests" intro={showAll ? "All successful disbursements (reporting view)." : "Successful disbursements on requests you initiated, with repayment dates."} />
      <form className="filters" method="get" role="search" aria-label="Filter booked requests">
        <div className="field"><label htmlFor="bq">Search</label><input id="bq" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Request, customer or reference" /></div>
        <div className="field"><label htmlFor="bs">Status</label><select id="bs" name="status" defaultValue={sp.status ?? ""}><option value="">Any</option><option value="BOOKED">Booked (not closed)</option><option value="CLOSED">Closed</option></select></div>
        <div className="field"><label htmlFor="bv">Vendor confirmation</label><select id="bv" name="vendor" defaultValue={sp.vendor ?? ""}><option value="">Any</option><option value="pending">Pending</option><option value="confirmed">Confirmed</option></select></div>
        <div className="field"><label htmlFor="bf">Booked from</label><input id="bf" name="from" type="date" defaultValue={sp.from ?? ""} /></div>
        <div className="field"><label htmlFor="bt">Booked to</label><input id="bt" name="to" type="date" defaultValue={sp.to ?? ""} /></div>
        <button className="btn">Apply</button>
        {filtered && <Link className="btn btn-ghost" href="/booked">Clear</Link>}
      </form>
      <div className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric"><div className="k">Bookings{filtered ? " (filtered)" : ""}</div><div className="v">{rows.length}</div></div>
        <div className="metric"><div className="k">Disbursed</div><div className="v">{formatKobo(totalDisbursed)}</div></div>
        <div className="metric"><div className="k">Vendor confirmation pending</div><div className="v">{pendingVendor}</div></div>
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
        <table className="data responsive">
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
                  {filtered ? "No bookings match these filters." : "No disbursements yet."}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="clickable">
                <td data-label="Request ID" className="nowrap">
                  <Link className="row-link mono" href={`/requests/${r.id}`}>
                    {r.ref}
                  </Link>
                </td>
                <td data-label="Customer">{r.customer_name}</td>
                <td data-label="Owner" className="small">{r.owner_name}</td>
                <td data-label="Requested" className="num">{formatKobo(r.requested_amount_kobo)}</td>
                <td data-label="Approved" className="num">{formatKobo(r.approved_amount_kobo)}</td>
                <td className="num" data-label="Disbursed">
                  <strong>{formatKobo(r.disbursed_kobo)}</strong>
                </td>
                <td data-label="Transaction ref" className="mono small">{r.transaction_ref}</td>
                <td data-label="Booking date" className="small nowrap">{formatDateOnly(r.disbursed_on)}</td>
                <td data-label="Status">
                  <StageChip stage={r.stage as Stage} status={r.status} />
                </td>
                <td data-label="Vendor confirmation">{r.vendor_confirmed_at ? <span className="badge badge-green">Confirmed</span> : <span className="badge badge-warn">Pending</span>}</td>
                <td className="small nowrap" data-label="Payment schedule">
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
