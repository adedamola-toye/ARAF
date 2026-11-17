import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { documentSettings } from "@/server/domain/document-settings";
import { formatKobo } from "@/server/money";
import { PageHeader } from "@/components/PageHeader";
import { DocumentSettingsForm } from "./Form";

export const metadata = { title: "Document settings" };

export default async function DocumentSettings() {
  await requireSuperAdmin();
  const d = await documentSettings(db);
  const waiting = (
    await db.query<{ ref: string; kind: string; detail: string | null; status: string }>(
      `SELECT a.ref, g.kind, g.detail, g.status FROM document_generation g JOIN applications a ON a.id = g.application_id AND a.current_version_id = g.version_id
        WHERE g.status IN ('WAITING','FAILED') ORDER BY g.updated_at DESC LIMIT 50`,
    )
  ).rows;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Document settings"
        intro="Details printed on the documents ARAF prepares after final approval: the offer letter, the GSI mandate form and the Remita direct debit set-up sheet. The Remita Retrieval Reference (RRR) and QR code are issued by Remita when the mandate is created there."
      />
      <section className="card" aria-labelledby="ds-h">
        <h2 id="ds-h">Bank and Remita beneficiary</h2>
        <DocumentSettingsForm
          customerEmail={!!d.customer_email_enabled}
          v={{
            bankName: d.bank_name ?? "",
            bankAddress: d.bank_address ?? "",
            beneficiaryName: d.remita_beneficiary_name ?? "",
            beneficiaryBank: d.remita_beneficiary_bank ?? "",
            beneficiaryAccount: d.remita_beneficiary_account ?? "",
            beneficiaryEmail: d.remita_beneficiary_email ?? "",
            beneficiaryPhone: d.remita_beneficiary_phone ?? "",
            charge: d.remita_charge_kobo === null ? "" : formatKobo(d.remita_charge_kobo, false).replace(/,/g, ""),
            vatPercent: d.remita_vat_percent === null ? "" : String(Number(d.remita_vat_percent)),
          }}
        />
      </section>
      <section className="card" aria-labelledby="ds-w" style={{ marginTop: "var(--space-5)" }}>
        <h2 id="ds-w">Documents not yet prepared</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Initiators see these as “being prepared”. ARAF retries automatically once the template or setting is in place.</p>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Document</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((w, i) => (
                <tr key={i}>
                  <td>{w.ref}</td>
                  <td>{w.kind === "OFFER" ? "Offer letter" : w.kind === "GSI" ? "GSI mandate" : "Remita set-up sheet"}</td>
                  <td>{(w.detail ?? w.status).replace(/^[A-Z_]+: /, "")}</td>
                </tr>
              ))}
              {!waiting.length && (
                <tr>
                  <td colSpan={3} className="muted">Nothing waiting.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
