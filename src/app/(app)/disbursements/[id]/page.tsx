import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { getCase } from "@/server/domain/views";
import { completionRecord } from "@/server/domain/cad";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { formatDateOnly, formatLagos } from "@/server/time";
import { Money } from "@/components/Money";

export const metadata = { title: "Disbursement confirmation" };

/** Completion screen: only from a recorded disbursement with its core-banking reference. */
export default async function Completion({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireUser();
  const { id } = await params;
  try {
    await getCase(ctx, id); // same access rules as the request itself
  } catch (e) {
    if (e instanceof DomainError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) notFound();
    throw e;
  }
  const r = await completionRecord(db, id);
  if (!r) notFound();
  return (
    <div style={{ maxWidth: 720 }}>
      <p className="eyebrow">Disbursement confirmation</p>
      <h1 className="row" style={{ alignItems: "center" }}>
        <CheckCircle2 className="icon" aria-hidden="true" style={{ color: "var(--success)", width: 28, height: 28 }} /> Disbursed
      </h1>
      <p className="muted">
        Recorded by {r.recorded_by_name} on {formatLagos(r.recorded_at)} with the core-banking transaction reference below.
      </p>
      <section className="card" style={{ marginTop: "var(--space-5)" }} aria-label="Disbursement details">
        <Money size="hero" label="Disbursed amount" kobo={r.amount_kobo} hint={r.amount_kobo !== r.approved_amount_kobo ? "Approved amount differs; see below" : "Equal to the approved amount"} />
        <table className="kv" style={{ marginTop: "var(--space-5)" }}>
          <tbody>
            <tr>
              <th scope="row">Transaction reference</th>
              <td className="tnum">{r.transaction_ref}</td>
            </tr>
            <tr>
              <th scope="row">Value date</th>
              <td>{formatDateOnly(r.disbursed_on)}</td>
            </tr>
            <tr>
              <th scope="row">Customer</th>
              <td>{r.customer_name ?? "—"}</td>
            </tr>
            <tr>
              <th scope="row">Facility</th>
              <td>
                {r.ref} · {r.product_label ?? "WakeelBoost"}
              </td>
            </tr>
            <tr>
              <th scope="row">Approved amount</th>
              <td>
                <Money size="table" as="span" kobo={r.approved_amount_kobo} />
              </td>
            </tr>
            {r.beneficiary && (
              <>
                <tr>
                  <th scope="row">Beneficiary</th>
                  <td>{[r.beneficiary.name, r.beneficiary.bank, r.beneficiary.account].filter(Boolean).join(" · ")}</td>
                </tr>
              </>
            )}
            <tr>
              <th scope="row">Repayment</th>
              <td>
                {r.instalments} instalment{r.instalments === 1 ? "" : "s"}
                {r.first_due ? `, first due ${formatDateOnly(r.first_due)}` : ""}
                {r.instalment_kobo ? (
                  <>
                    {" "}
                    of <Money size="table" as="span" kobo={r.instalment_kobo} />
                  </>
                ) : null}
              </td>
            </tr>
            <tr>
              <th scope="row">Status now</th>
              <td>{STAGE_LABELS[r.stage as Stage] ?? r.stage}</td>
            </tr>
          </tbody>
        </table>
      </section>
      <div className="row" style={{ marginTop: "var(--space-5)" }}>
        <Link className="btn btn-primary" href={`/requests/${r.application_id}`}>
          Open the request
        </Link>
        <Link className="btn btn-ghost" href="/disbursements">
          Disbursements
        </Link>
      </div>
    </div>
  );
}
