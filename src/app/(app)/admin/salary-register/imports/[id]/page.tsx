import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "../../../../../_lib/auth";
import { db } from "@/server/db";
import { importView } from "@/server/staff/register";
import { formatLagos } from "@/server/time";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { DecideImport } from "../../Forms";

export const metadata = { title: "Salary register import" };

export default async function ImportPreview({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(["SALARY_REGISTER_ADMIN", "SUPER_ADMIN"]);
  const { id } = await params;
  const v = await importView(db, id);
  if (!v) notFound();
  const rows = v.preview ?? [];
  return (
    <>
      <PageHeader
        eyebrow="Salary register"
        title={v.filename}
        crumbs={[{ href: "/admin/salary-register", label: "Salary register" }, { label: "Import" }]}
        intro={`Uploaded ${formatLagos(v.uploaded_at)} by ${v.uploaded_by_name}. ${v.status === "PREVIEW" ? "Nothing has changed yet." : `Status: ${v.status.toLowerCase()}${v.decided_at ? ` on ${formatLagos(v.decided_at)}` : ""}.`}`}
      />
      <section className="grid-3" style={{ marginBottom: "var(--space-5)" }} aria-label="Import summary">
        <div className="fig fig-lg">
          <span className="fig-label">Valid rows</span>
          <span className="fig-value">{v.valid_rows}</span>
          <span className="fig-hint">
            {v.creates} new · {v.updates} changed · {v.unchanged} unchanged
          </span>
        </div>
        <div className="fig fig-lg">
          <span className="fig-label">Rows with errors</span>
          <span className="fig-value">{v.error_rows}</span>
          <span className="fig-hint">Never applied; fix and upload again</span>
        </div>
      </section>
      {v.status === "PREVIEW" && (
        <section className="card" style={{ marginBottom: "var(--space-5)" }}>
          <p className="small">Applying writes the valid rows to the register together and records each change in the history. Rows with errors are left out.</p>
          <DecideImport importId={v.id} valid={v.valid_rows} />
        </section>
      )}
      {v.errors.length > 0 && (
        <section aria-labelledby="h-err" style={{ marginBottom: "var(--space-5)" }}>
          <h2 id="h-err">Errors</h2>
          <div className="table-wrap">
            <table className="data responsive">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {v.errors.map((e) => (
                  <tr key={e.line}>
                    <td data-label="Line" className="tnum">
                      {e.line}
                    </td>
                    <td data-label="Problem">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {rows.length > 0 && (
        <section aria-labelledby="h-rows">
          <h2 id="h-rows">Valid rows</h2>
          <div className="table-wrap">
            <table className="data responsive">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Employee</th>
                  <th className="num">Verified salary</th>
                  <th>Account</th>
                  <th>Employment</th>
                  <th>Salary for</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line}>
                    <td data-label="Line" className="tnum">
                      {r.line}
                    </td>
                    <td data-label="Employee">
                      {r.name}
                      <div className="small muted">
                        {r.v.staffNumber} · {r.email}
                      </div>
                    </td>
                    <td className="num" data-label="Verified salary">
                      <Money size="table" as="span" kobo={r.v.salary} private />
                    </td>
                    <td data-label="Account">•••••• {r.v.accLast4}</td>
                    <td data-label="Employment">{r.v.status}</td>
                    <td data-label="Salary for">{r.v.asOf}</td>
                    <td data-label="Change">
                      <span className={`badge ${r.action === "CREATE" ? "badge-green" : r.action === "UPDATE" ? "badge-blue" : ""}`}>
                        {r.action === "CREATE" ? "New" : r.action === "UPDATE" ? "Changed" : "Unchanged"}
                      </span>
                      {r.changed.length > 0 && r.action === "UPDATE" && <div className="small muted">{r.changed.join(", ")}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p style={{ marginTop: "var(--space-5)" }}>
        <Link href="/admin/salary-register">Back to the register</Link>
      </p>
    </>
  );
}
