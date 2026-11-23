import Link from "next/link";
import { ArrowRight, CheckCircle2, FileSignature } from "lucide-react";
import { db } from "@/server/db";
import { formatLagos, lagosParts } from "@/server/time";
import { advances, eligibilityFor } from "@/server/staff/register";
import type { StaffSettings } from "@/server/staff/core";
import { myRequestRows } from "@/server/staff/views";
import { bpsLabel, computeStaffFinancing, formatNairaKobo, STAFF_NEXT_ACTION, type StaffStatus } from "@/lib/staff-financing";
import { Money } from "@/components/Money";
import { StaffStatusBadge } from "./StatusBadge";
import { Countdown } from "./StaffForms";
import { startStaffRequestAction } from "./actions";

const greeting = (now: Date) => {
  const h = lagosParts(now).hour;
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

/**
 * Personal banking home for Staff Salary Advance when eligibility comes from the salary register.
 * Every figure is from records: the register, the employee's requests and confirmed repayments.
 */
export async function RegisterHome({ staffId, fullName, settings, ineligibleNotice }: { staffId: string; fullName: string; settings: StaffSettings; ineligibleNotice: boolean }) {
  const now = new Date();
  const e = await eligibilityFor(db, staffId, now, settings);
  const rows = await myRequestRows(db, staffId);
  const all = await advances(db, staffId);
  const active = all.filter((a) => Number(a.outstanding_kobo) > 0);
  const settled = all.filter((a) => Number(a.outstanding_kobo) === 0);
  const current = active[0] ?? null;
  const inProgress = rows.filter((r) => !["COMPLETED", "DECLINED", "OFFER_EXPIRED"].includes(r.status));
  const offers = rows.filter((r) => r.status === "AWAITING_SIGNED_OFFER" && !r.signed_offer_received_at);
  const drafts = inProgress.filter((r) => r.status === "DRAFT" || r.status === "RETURNED_FOR_CORRECTION");
  const fee = e.availableKobo > 0 ? computeStaffFinancing(e.availableKobo, settings.deduction_rate_bps) : null;
  const eligible = e.state === "ELIGIBLE";
  const first = fullName.split(/\s+/)[0];
  return (
    <div className="staff-home">
      <p className="eyebrow">Staff Salary Advance</p>
      <h1>
        {greeting(now)}, {first}
      </h1>

      {ineligibleNotice && !eligible && (
        <div className="alert alert-warn" role="alert">
          {e.message}
        </div>
      )}
      {offers.map((r) => (
        <div key={r.id} className="alert alert-warn">
          <FileSignature className="icon" aria-hidden="true" />
          <span>
            <strong>Your offer letter is ready.</strong> Sign and upload it by {formatLagos(r.offer_deadline_at)} (<Countdown deadline={new Date(r.offer_deadline_at).toISOString()} />
            ). <Link href={`/staff-request/${r.id}`}>Open the offer</Link>
          </span>
        </div>
      ))}

      {current ? (
        <section className="card staff-hero" aria-labelledby="h-active">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 id="h-active" className="sr-only">
              Active advance
            </h2>
            <span className="badge badge-blue">Active advance · {current.ref}</span>
          </div>
          <Money size="hero" label="Outstanding balance" kobo={current.outstanding_kobo} private />
          <div
            className="progress-bar staff-repay"
            role="progressbar"
            aria-label="Repayment progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((Number(current.repaid_kobo) / Number(current.gross_kobo)) * 100)}
          >
            <span style={{ width: `${(Number(current.repaid_kobo) / Number(current.gross_kobo)) * 100}%` }} />
          </div>
          <p className="small muted">
            {Math.round((Number(current.repaid_kobo) / Number(current.gross_kobo)) * 100)}% repaid
            {current.last_repayment_at ? ` · last confirmed repayment ${current.last_repayment_at}` : " · no repayment confirmed yet"}
          </p>
          <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
            <Money size="md" label="Amount received" kobo={current.net_kobo} private />
            <Money size="md" label={`Management fee (${bpsLabel(settings.deduction_rate_bps)})`} kobo={current.deduction_kobo} private />
            <Money size="md" label="Amount repaid" kobo={current.repaid_kobo} private />
            <Money size="md" label="Available limit now" kobo={e.availableKobo} private />
          </div>
          <div className="row" style={{ marginTop: "var(--space-4)" }}>
            <Link className="btn" href={`/staff-request/${current.id}`}>
              Repayment details, offer letter and disbursement confirmation <ArrowRight className="icon" aria-hidden="true" />
            </Link>
            {eligible && !drafts.length && (
              <form action={startStaffRequestAction}>
                <button className="btn btn-primary">Get an advance</button>
              </form>
            )}
          </div>
        </section>
      ) : (
        <section className="card staff-hero" aria-labelledby="h-avail">
          {settled.length > 0 && (
            <p className="staff-settled" role="status">
              <CheckCircle2 className="icon" aria-hidden="true" /> All settled. Outstanding balance ₦0.00
            </p>
          )}
          <h2 id="h-avail" className="sr-only">
            Available advance
          </h2>
          <Money size="hero" label="Available advance" kobo={e.availableKobo} private />
          <p className="row small" style={{ gap: 8 }}>
            <span className={`badge ${eligible ? "badge-green" : "badge-warn"}`}>{eligible ? "Eligible" : e.state === "FULLY_USED" ? "Limit in use" : "Not available"}</span>
            {eligible ? (
              <span className="muted">
                Up to {Number(settings.eligibility_percent_bps) / 100}% of your verified monthly salary{fee ? `; on the full amount you would receive ${formatNairaKobo(fee.netKobo)}` : ""}.
              </span>
            ) : (
              <span>{e.message}</span>
            )}
          </p>
          {eligible && !drafts.length && (
            <form action={startStaffRequestAction}>
              <button className="btn btn-primary btn-lg">Get an advance</button>
            </form>
          )}
          {drafts.map((d) => (
            <Link key={d.id} className="btn btn-primary btn-lg" href={`/staff-request/${d.id}`}>
              {d.status === "DRAFT" ? "Continue your application" : "Correct and resubmit"} <ArrowRight className="icon" aria-hidden="true" />
            </Link>
          ))}
        </section>
      )}

      <section className="grid-3 staff-support" aria-label="Your salary advance">
        <Money size="md" label="Outstanding balance" kobo={active.reduce((t, a) => t + Number(a.outstanding_kobo), 0)} private />
        <div className="fig fig-md">
          <span className="fig-label">Management fee</span>
          <span className="fig-value">{bpsLabel(settings.deduction_rate_bps)}</span>
          <span className="fig-hint">Deducted upfront from the amount you request</span>
        </div>
        <div className="fig fig-md">
          <span className="fig-label">Previous advances</span>
          <span className="fig-value">{all.length}</span>
          <span className="fig-hint">{settled.length} fully repaid</span>
        </div>
      </section>

      {inProgress.filter((r) => r.status !== "DRAFT").length > 0 && (
        <section aria-labelledby="h-prog">
          <h2 id="h-prog">In progress</h2>
          <ul className="home-list">
            {inProgress
              .filter((r) => r.status !== "DRAFT")
              .map((r) => (
                <li key={r.id}>
                  <Link className="home-row" href={`/staff-request/${r.id}`}>
                    <span className="home-main">
                      <strong>{r.ref}</strong>
                      <span className="small muted">{STAFF_NEXT_ACTION[r.status as StaffStatus]}</span>
                    </span>
                    <StaffStatusBadge status={r.status} />
                    <Money size="table" as="span" kobo={r.net_kobo} private />
                    <ArrowRight className="icon" aria-hidden="true" />
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}

      {all.length > 0 && (
        <section aria-labelledby="h-prev">
          <h2 id="h-prev">Previous advances</h2>
          <ul className="home-list">
            {all.map((a) => (
              <li key={a.id}>
                <Link className="home-row" href={`/staff-request/${a.id}`}>
                  <span className="home-main">
                    <strong>{a.ref}</strong>
                    <span className="small muted">
                      Disbursed {formatLagos(a.disbursed_at)} · {Number(a.outstanding_kobo) === 0 ? "fully repaid" : `${formatNairaKobo(a.outstanding_kobo)} outstanding`}
                    </span>
                  </span>
                  <Money size="table" as="span" kobo={a.gross_kobo} private />
                  <ArrowRight className="icon" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="h-how">
        <h2 id="h-how">How it works</h2>
        <ol className="small staff-how">
          <li>Your limit is {Number(settings.eligibility_percent_bps) / 100}% of your verified monthly salary from the bank&apos;s salary register, less any advance you still owe or have pending.</li>
          <li>Choose an amount. The {bpsLabel(settings.deduction_rate_bps)} management fee is deducted upfront, so you see exactly what you will receive; you repay the full amount you requested.</li>
          <li>The Product Manager, Unit Head and Divisional Head review it. Approval is not automatic.</li>
          <li>Sign the offer letter within 24 hours, then the money is paid into your verified salary account.</li>
        </ol>
      </section>
    </div>
  );
}
