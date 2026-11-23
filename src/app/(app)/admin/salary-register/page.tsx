import Link from "next/link";
import { Download } from "lucide-react";
import { requireRole } from "../../../_lib/auth";
import { db } from "@/server/db";
import { EMPLOYMENT_LABEL, importHistory, registerListing, staffWithoutRecord } from "@/server/staff/register";
import { currentSettings } from "@/server/staff/core";
import { formatLagos } from "@/server/time";
import { koboToNairaString } from "@/server/money";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { HoldForm, RecordForm, UploadForm } from "./Forms";

export const metadata = { title: "Salary register" };

const STATE_LABEL: Record<string, [string, string]> = {
  ELIGIBLE: ["Eligible", "badge-green"],
  FULLY_USED: ["Limit in use", "badge-blue"],
  OUTDATED: ["Salary record outdated", "badge-warn"],
  NOT_EMPLOYED: ["Employment status", "badge-red"],
  HELD: ["On hold", "badge-warn"],
  NO_RECORD: ["No record", "badge-red"],
};

/** Confidential: Salary Register Administrators and Super Admins only. Salaries are masked until revealed. */
export default async function SalaryRegister({ searchParams }: { searchParams: Promise<{ q?: string; edit?: string }> }) {
  await requireRole(["SALARY_REGISTER_ADMIN", "SUPER_ADMIN"]);
  const sp = await searchParams;
  const now = new Date();
  const settings = await currentSettings(db);
  const rows = await registerListing(db, now, sp.q ?? "");
  const missing = await staffWithoutRecord(db);
  const history = await importHistory(db);
  const staff = (await db.query<{ id: string; full_name: string; email: string }>("SELECT id, full_name, email FROM staff WHERE status = 'ACTIVE' ORDER BY full_name LIMIT 2000")).rows;
  const editing = sp.edit ? rows.find((r) => r.record.staff_id === sp.edit)?.record : undefined;
  return (
    <>
      <PageHeader
        eyebrow="Staff Salary Advance"
        title="Salary register"
        intro="Verified monthly salaries and salary accounts used for automatic eligibility. Confidential: never share outside this screen. Every change is recorded with who made it and why."
        actions={
          <Link className="btn" href="/admin/salary-register/repayments">
            Repayments
          </Link>
        }
      />
      <div className={`alert ${settings.eligibility_mode === "SALARY_REGISTER" ? "alert-info" : "alert-warn"}`} role="status" style={{ marginBottom: "var(--space-5)" }}>
        {settings.eligibility_mode === "SALARY_REGISTER"
          ? `Automatic eligibility is ON: limit = ${settings.eligibility_percent_bps / 100}% of the verified salary; records older than ${settings.salary_record_max_age_days} days are treated as outdated.`
          : "Automatic eligibility is OFF (current settings use manual verification). Load the register first, then a Super Admin switches it on in Salary advance settings."}
      </div>

      <section className="grid-2" style={{ marginBottom: "var(--space-6)" }}>
        <div className="card">
          <h2>Upload from payroll</h2>
          <p className="small">
            Columns: staff_id, ad_identity (sign-in email), employee_name, monthly_salary, salary_account_number, salary_account_name, employment_status, salary_as_of.{" "}
            <a href="/admin/salary-register/template">
              <Download className="icon" aria-hidden="true" /> Download the template
            </a>
          </p>
          <UploadForm />
        </div>
        <div className="card">
          <h2>{editing ? `Edit ${editing.employee_name}` : "Add or correct one record"}</h2>
          <RecordForm
            staff={staff.map((s) => ({ id: s.id, label: `${s.full_name} (${s.email})` }))}
            initial={
              editing
                ? {
                    staffId: editing.staff_id,
                    staffNumber: editing.staff_number,
                    monthlySalary: koboToNairaString(Number(editing.monthly_salary_kobo)),
                    accountName: editing.account_name,
                    employmentStatus: editing.employment_status,
                    salaryAsOf: editing.salary_as_of,
                  }
                : undefined
            }
          />
          {editing && (
            <Link className="small" href="/admin/salary-register">
              Cancel editing
            </Link>
          )}
        </div>
      </section>

      <section aria-labelledby="h-reg" style={{ marginBottom: "var(--space-6)" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
          <h2 id="h-reg">Register ({rows.length})</h2>
          <form className="row" role="search">
            <input name="q" defaultValue={sp.q ?? ""} placeholder="Name, staff ID or email" aria-label="Search the register" />
            <button className="btn btn-sm">Search</button>
          </form>
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table className="data responsive">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="num">Verified salary</th>
                  <th>Account</th>
                  <th>Employment</th>
                  <th className="num">Outstanding</th>
                  <th className="num">Reserved</th>
                  <th className="num">Available</th>
                  <th>Eligibility</th>
                  <th>Last update</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ record: r, eligibility: e }) => (
                  <tr key={r.id}>
                    <td data-label="Employee">
                      <strong>{r.employee_name}</strong>
                      <div className="small muted">
                        {r.staff_number} · {r.ad_identity}
                      </div>
                    </td>
                    <td className="num" data-label="Verified salary">
                      <Money size="table" as="span" kobo={r.monthly_salary_kobo} private />
                      <div className="small muted">for {r.salary_as_of}</div>
                    </td>
                    <td data-label="Account">
                      •••••• {r.account_last4}
                      <div className="small muted">{r.account_name}</div>
                    </td>
                    <td data-label="Employment">{EMPLOYMENT_LABEL[r.employment_status]}</td>
                    <td className="num" data-label="Outstanding">
                      <Money size="table" as="span" kobo={e.outstandingKobo} private />
                    </td>
                    <td className="num" data-label="Reserved">
                      <Money size="table" as="span" kobo={e.reservedKobo} private />
                    </td>
                    <td className="num" data-label="Available">
                      <Money size="table" as="span" kobo={e.availableKobo} private />
                    </td>
                    <td data-label="Eligibility">
                      <span className={`badge ${STATE_LABEL[e.state][1]}`}>{STATE_LABEL[e.state][0]}</span>
                      {r.hold_reason && <div className="small muted">{r.hold_reason}</div>}
                    </td>
                    <td data-label="Last update" className="small">
                      {formatLagos(r.updated_at)}
                      <div className="muted">
                        {r.source === "CSV" ? "CSV import" : "Manual"} · {r.updated_by_name}
                      </div>
                    </td>
                    <td className="row-actions">
                      <div className="row">
                        <Link className="btn btn-sm btn-ghost" href={`/admin/salary-register?edit=${r.staff_id}`}>
                          Edit
                        </Link>
                        <HoldForm staffId={r.staff_id} held={r.eligibility_status === "HELD"} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{sp.q ? "No record matches the search." : "The register is empty. Upload the payroll CSV to begin."}</p>
        )}
      </section>

      {missing.length > 0 && (
        <section aria-labelledby="h-miss" style={{ marginBottom: "var(--space-6)" }}>
          <h2 id="h-miss">Applicants without a register record</h2>
          <p className="small muted">These staff have used Staff Salary Advance but have no verified salary record, so automatic eligibility cannot be calculated for them.</p>
          <ul className="plain-list small">
            {missing.map((m) => (
              <li key={m.id}>
                {m.full_name} · {m.email}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="h-imp">
        <h2 id="h-imp">Import history</h2>
        {history.length ? (
          <ul className="plain-list small">
            {history.map((h) => (
              <li key={h.id}>
                <Link href={`/admin/salary-register/imports/${h.id}`}>{h.filename}</Link> · {formatLagos(h.uploaded_at)} · {h.uploaded_by_name} · {h.status.toLowerCase()} · {h.valid_rows} valid, {h.error_rows} with
                errors
                {h.status === "APPLIED" ? ` (${h.creates} created, ${h.updates} updated)` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No imports yet.</p>
        )}
      </section>
    </>
  );
}
