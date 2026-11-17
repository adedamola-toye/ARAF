import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "../../../_lib/auth";
import { db } from "@/server/db";
import { IC_STATUS_LABELS, icDetail, icForApplication, icResponses } from "@/server/domain/invoice-confirmation";
import { CATEGORY_LABEL, signDocumentLink } from "@/server/domain/documents";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { CompleteForm, ReturnForm, UploadResponse } from "./Forms";

export const metadata = { title: "Invoice confirmation" };

export default async function InvoiceConfirmation({ params }: { params: Promise<{ id: string }> }) {
  const { session, roles } = await requireRole(["INVOICE_CONFIRMATION_OFFICER", "SUPER_ADMIN"]);
  const { id } = await params;
  const r = await icDetail(db, id);
  if (!r) notFound();
  const mine = r.officer_id === session.staffId;
  if (!mine && !roles.includes("SUPER_ADMIN")) notFound();
  const link = (docId: string, m: "view" | "download") => signDocumentLink(docId, session.staffId, session.sessionId, m);
  const responses = await icResponses(db, r);
  const history = (await icForApplication(db, r.application_id)).filter((h) => h.id !== r.id);
  const app = (await db.query("SELECT requested_amount_kobo, current_version_id FROM applications WHERE id = $1", [r.application_id])).rows[0];
  const ver = (await db.query("SELECT data FROM application_versions WHERE id = $1", [app?.current_version_id])).rows[0]?.data ?? {};
  const ben = ver.beneficiarySnapshot ?? null;
  const supplier = ben?.vendorName ?? ver.supplierName ?? "";
  const canAct = mine && r.status === "PENDING" && r.initiator_id !== session.staffId;
  const ready = responses.some((d) => d.scan_status === "CLEAN");
  return (
    <>
      <PageHeader
        eyebrow="Invoice confirmation"
        title={`${r.customer_name ?? r.ref} — ${r.ref}`}
        intro={`${r.product_label ?? "WakeelBoost"} · ${IC_STATUS_LABELS[r.status] ?? r.status}`}
      />
      <p className="small" style={{ marginTop: -8 }}>
        <Link href="/invoice-confirmation">← Back to the queue</Link>
        {" · "}
        <Link href={`/requests/${r.application_id}`}>Open the request</Link>
      </p>
      <div className="split">
        <section className="stack" style={{ minWidth: 0 }}>
          <div className="card">
            <h2>Invoice</h2>
            <dl className="kv">
              <dt>Document</dt>
              <dd>
                {CATEGORY_LABEL[r.invoice_category] ?? r.invoice_category} · version {r.invoice_version} · {r.invoice_filename}
              </dd>
              {supplier && (
                <>
                  <dt>Supplier / vendor</dt>
                  <dd>{supplier}</dd>
                </>
              )}
              {ver.supplierPhone && (
                <>
                  <dt>Supplier phone</dt>
                  <dd>{ver.supplierPhone}</dd>
                </>
              )}
              {ver.invoiceRef && (
                <>
                  <dt>Invoice reference</dt>
                  <dd>{ver.invoiceRef}</dd>
                </>
              )}
              <dt>Amount requested</dt>
              <dd>{formatKobo(app?.requested_amount_kobo)}</dd>
              <dt>Initiator</dt>
              <dd>{r.initiator_name ?? "—"}</dd>
              <dt>Sent</dt>
              <dd>{formatLagos(r.dispatched_at)}</dd>
              <dt>Officer</dt>
              <dd>{r.officer_name ?? "—"}</dd>
            </dl>
            <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <a className="btn" href={link(r.invoice_document_id, "view")} target="_blank" rel="noopener noreferrer">
                Open invoice
              </a>
              <a className="btn" href={link(r.invoice_document_id, "download")}>
                Download
              </a>
            </p>
          </div>
          <div className="card">
            <h2>Issuer&apos;s response</h2>
            {responses.length ? (
              <ul className="closing-list">
                {responses.map((d) => (
                  <li key={d.id}>
                    <span className="closing-body">
                      <strong>{d.filename}</strong>
                      <span className="small muted">{formatLagos(d.uploaded_at)}{d.scan_status !== "CLEAN" ? ` · ${d.scan_status.toLowerCase()}` : ""}</span>
                    </span>
                    {d.scan_status === "CLEAN" && (
                      <a className="btn btn-sm" href={link(d.id, "view")} target="_blank" rel="noopener noreferrer">
                        View
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No response uploaded yet.</p>
            )}
            {canAct && <UploadResponse id={r.id} />}
          </div>
          {r.status === "RETURNED" && (
            <div className="alert alert-warn">Returned {formatLagos(r.returned_at)}: “{r.returned_reason}”</div>
          )}
          {r.status === "COMPLETED" && (
            <div className="alert alert-success">
              Confirmation Completed by {r.completed_by_name} on {formatLagos(r.completed_at)}
              {r.remarks ? ` — “${r.remarks}”` : ""}
            </div>
          )}
          {history.length > 0 && (
            <div className="card">
              <h2>Earlier confirmations on this request</h2>
              <ul className="small">
                {history.map((h) => (
                  <li key={h.id}>
                    v{h.invoice_version} {h.invoice_filename} — {IC_STATUS_LABELS[h.status]}
                    {h.returned_reason ? ` (“${h.returned_reason}”)` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <aside className="split-right">
          {canAct ? (
            <>
              <div className="card">
                <h2>Confirm</h2>
                <CompleteForm id={r.id} lockVersion={r.lock_version} ready={ready} />
              </div>
              <div className="card">
                <h2>Return</h2>
                <ReturnForm id={r.id} lockVersion={r.lock_version} />
              </div>
            </>
          ) : (
            <div className="card">
              <p className="small muted" style={{ margin: 0 }}>
                {r.status === "PENDING" && mine && r.initiator_id === session.staffId ? "You initiated this request, so a Super Admin must reassign it." : `Status: ${IC_STATUS_LABELS[r.status]}.`}
              </p>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
