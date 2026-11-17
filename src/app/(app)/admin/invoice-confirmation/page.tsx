import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { IC_STATUS_LABELS, icQueue, icSettings, OFFICER_ROLE } from "@/server/domain/invoice-confirmation";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { OfficersForm, ReassignForm } from "./Forms";

export const metadata = { title: "Invoice confirmation settings" };

export default async function IcAdmin() {
  const { session } = await requireSuperAdmin();
  const st = await icSettings(db);
  const officers = (
    await db.query<{ id: string; name: string; email: string }>(
      `SELECT s.id, s.full_name AS name, s.email FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.role = $1 AND ra.active WHERE s.status = 'ACTIVE' ORDER BY s.full_name`,
      [OFFICER_ROLE],
    )
  ).rows;
  const missing = st.officer_emails.filter((e) => !officers.some((o) => o.email === e));
  const open = await icQueue(db, session.staffId, true, ["PENDING", "DISPATCH_FAILED"]);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Invoice confirmation"
        intro="After final approval ARAF sends the current supplier or vehicle invoice to the first available officer below. Staff Salary Advance does not use invoice confirmation."
      />
      <section className="card" aria-labelledby="ic-o">
        <h2 id="ic-o">Officers</h2>
        <p className="small">
          Holders of the Invoice Confirmation Officer role: {officers.length ? officers.map((o) => `${o.name} (${o.email})`).join(", ") : "none yet — assign the role under Roles"}.
        </p>
        {missing.length > 0 && (
          <div className="alert alert-warn" role="status">
            Not yet usable (no active staff account with the role): {missing.join(", ")}. Create the account and assign the Invoice Confirmation Officer role.
          </div>
        )}
        <OfficersForm emails={st.officer_emails.join("\n")} />
      </section>
      <section className="card" aria-labelledby="ic-q" style={{ marginTop: "var(--space-5)" }}>
        <h2 id="ic-q">Open confirmations</h2>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Status</th>
                <th scope="col">Officer</th>
                <th scope="col">Since</th>
                <th scope="col">Reassign</th>
              </tr>
            </thead>
            <tbody>
              {open.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/invoice-confirmation/${r.id}`}>{r.ref}</Link>
                  </td>
                  <td>{IC_STATUS_LABELS[r.status]}</td>
                  <td>{r.officer_name ?? "—"}</td>
                  <td>{formatLagos(r.assigned_at ?? r.created_at)}</td>
                  <td>
                    <ReassignForm id={r.id} officers={officers.filter((o) => o.id !== r.initiator_id)} />
                  </td>
                </tr>
              ))}
              {!open.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    Nothing open.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
