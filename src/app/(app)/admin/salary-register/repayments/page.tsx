import Link from "next/link";
import { requireRole } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { openAdvances } from "@/server/staff/register";
import { formatLagos, lagosDate } from "@/server/time";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { RepaymentForm } from "../Forms";

export const metadata = { title: "Salary advance repayments" };

/** Confirmed repayments are the only thing that reduces an outstanding advance. */
export default async function Repayments() {
  await requireRole(["SALARY_REGISTER_ADMIN", "SUPER_ADMIN"]);
  const rows = await openAdvances(db);
  const today = lagosDate(new Date());
  return (
    <>
      <PageHeader
        eyebrow="Salary register"
        title="Repayments"
        crumbs={[{ href: "/admin/salary-register", label: "Salary register" }, { label: "Repayments" }]}
        intro="Record a repayment only once it is confirmed (payroll deduction file or a posted transfer), with its reference. ARAF does not deduct salaries or create repayment mandates."
      />
      {rows.length ? (
        <div className="stack">
          {rows.map((r) => (
            <section key={r.id} className="card">
              <div className="card-head">
                <h2>
                  {r.full_name} · <Link href={`/staff-request/${r.id}`}>{r.ref}</Link>
                </h2>
                <span className="small muted">Disbursed {formatLagos(r.disbursed_at)}</span>
              </div>
              <div className="grid-3" style={{ marginBottom: "var(--space-4)" }}>
                <Money size="md" label="Advance (repayable)" kobo={r.gross_kobo} private />
                <Money size="md" label="Repaid" kobo={r.repaid_kobo} private />
                <Money size="md" label="Outstanding" kobo={String(BigInt(r.gross_kobo) - BigInt(r.repaid_kobo))} private />
              </div>
              <RepaymentForm requestId={r.id} today={today} />
            </section>
          ))}
        </div>
      ) : (
        <p className="muted">No disbursed advance has an outstanding balance.</p>
      )}
    </>
  );
}
