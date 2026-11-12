import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { searchInstitutions } from "@/server/domain/vendors";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { StatusToggle, VendorRegisterForm, VerifyAccountForm } from "../admin/RetailAdminForms";

export const metadata = { title: "Vendor register" };

export default async function Vendors() {
  const { roles, session } = await requireUser();
  if (!roles.includes("VENDOR_MANAGER") && !roles.includes("SUPER_ADMIN")) redirect("/forbidden");
  const canVerify = roles.includes("VENDOR_MANAGER");
  const vendors = (await db.query("SELECT v.*, c.full_name AS created_by_name FROM vendors v LEFT JOIN staff c ON c.id = v.created_by ORDER BY v.verification_status = 'VERIFIED', v.name")).rows;
  const accounts = (
    await db.query(
      `SELECT va.*, fi.name AS bank, fi.payment_supported, c.full_name AS created_by_name, vb.full_name AS verified_by_name
         FROM vendor_accounts va JOIN financial_institutions fi ON fi.id = va.institution_id LEFT JOIN staff c ON c.id = va.created_by LEFT JOIN staff vb ON vb.id = va.verified_by ORDER BY va.created_at DESC`,
    )
  ).rows;
  const history = (await db.query("SELECT occurred_at, action, actor_email, details, reason FROM audit_events WHERE action LIKE 'VENDOR%' ORDER BY id DESC LIMIT 30")).rows;
  const institutions = (await searchInstitutions(db, "")).map((i) => ({ value: i.id, label: i.name, aliases: i.aliases, hint: i.payment_supported ? undefined : "payment route not supported" }));
  return (
    <>
      <PageHeader eyebrow="Operations" title="Approved vendor register" intro="Vendors and their beneficiary accounts. An account can be selected on an application only when it is active and verified by a different officer from the one who captured it. Changes after approval trigger revalidation and re-approval." />
      {canVerify && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Register a vendor</summary>
          <div style={{ marginTop: 10 }}><VendorRegisterForm institutions={institutions} /></div>
        </details>
      )}
      <div className="stack" style={{ marginTop: 16 }}>
        {vendors.map((v: { id: string; name: string; email: string | null; status: string; verification_status: string; created_by_name: string | null }) => (
          <section key={v.id} className="card">
            <div className="card-head">
              <h2>{v.name} <span className={`badge ${v.verification_status === "VERIFIED" ? "badge-green" : "badge-warn"}`}>{v.verification_status.toLowerCase()}</span> {v.status !== "ACTIVE" && <span className="badge">inactive</span>}</h2>
              {canVerify && <StatusToggle kind="vendor" id={v.id} active={v.status === "ACTIVE"} />}
            </div>
            <p className="small muted" style={{ marginTop: 0 }}>{v.email ?? "no email"} · captured by {v.created_by_name ?? "system"}</p>
            <div className="table-scroll">
              <table className="data small">
                <thead><tr><th>Bank · account</th><th>Account name</th><th>Status</th><th>Verification</th><th /></tr></thead>
                <tbody>
                  {accounts.filter((a: { vendor_id: string }) => a.vendor_id === v.id).map((a: { id: string; bank: string; account_number: string; account_name: string; status: string; verification_status: string; verification_note: string | null; verified_by_name: string | null; verified_at: Date | null; created_by: string; created_by_name: string | null; payment_supported: boolean }) => (
                    <tr key={a.id}>
                      <td>{a.bank} · <span className="mono">{a.account_number}</span>{a.payment_supported ? "" : <div className="muted">payment route not supported</div>}</td>
                      <td>{a.account_name}</td>
                      <td>{a.status.toLowerCase()}{canVerify && <StatusToggle kind="account" id={a.id} active={a.status === "ACTIVE"} />}</td>
                      <td>
                        <span className={`badge ${a.verification_status === "VERIFIED" ? "badge-green" : a.verification_status === "FAILED" ? "badge-red" : "badge-warn"}`}>{a.verification_status === "UNAVAILABLE" ? "pending (no name enquiry)" : a.verification_status.toLowerCase()}</span>
                        {a.verified_by_name && <div className="muted">{a.verified_by_name}, {formatLagos(a.verified_at)}: {a.verification_note}</div>}
                        <div className="muted">captured by {a.created_by_name ?? "system"}</div>
                      </td>
                      <td>{canVerify && a.verification_status !== "VERIFIED" && a.created_by !== session.staffId ? <VerifyAccountForm accountId={a.id} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Recent register history</summary>
        <ul className="small">{history.map((h: { occurred_at: Date; action: string; actor_email: string | null; reason: string | null }, i: number) => <li key={i}>{formatLagos(h.occurred_at)} · {h.action.toLowerCase().replace(/_/g, " ")} · {h.actor_email ?? "system"}{h.reason ? ` · ${h.reason}` : ""}</li>)}</ul>
      </details>
    </>
  );
}
