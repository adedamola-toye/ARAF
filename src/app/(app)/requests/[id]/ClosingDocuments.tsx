import { FileDown, FileCheck2, Hourglass, PenLine } from "lucide-react";
import Link from "next/link";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { closingStatus } from "@/server/domain/closing-docs";
import { checklistStatus } from "@/server/domain/closing-checklist";
import { IC_STATUS_LABELS, icForApplication } from "@/server/domain/invoice-confirmation";
import { RepaymentAccountForm } from "./RepaymentAccountForm";

const ic = { className: "icon", "aria-hidden": true } as const;

/** Offer letter, GSI mandate and Remita set-up sheet prepared by ARAF after final approval. */
export async function ClosingDocuments({ appId, canEdit, canSign = false, link }: { appId: string; canEdit: boolean; canSign?: boolean; link: (id: string, m: "view" | "download") => string }) {
  const st = await closingStatus(db, appId);
  if (!st) return null;
  const banks = canEdit ? (await db.query<{ name: string }>("SELECT name FROM financial_institutions ORDER BY name")).rows.map((r) => r.name) : [];
  const needsAccount = st.items.some((i) => i.state === "NEEDS_ACCOUNT");
  const conf = (await icForApplication(db, appId))[0] ?? null;
  const emailOn = !!(await db.query("SELECT customer_email_enabled FROM document_settings WHERE id = 1")).rows[0]?.customer_email_enabled;
  const app = (await db.query("SELECT id, workflow, product_code, customer_profile FROM applications WHERE id = $1", [appId])).rows[0];
  const checklist = await checklistStatus(db, app);
  return (
    <section className="card" id="closing-documents" aria-labelledby="cd-h">
      <p className="eyebrow">After final approval</p>
      <h2 id="cd-h" style={{ marginBottom: 4 }}>Closing documents</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Prefilled from the approved request.{" "}
        {emailOn ? "They are also e-mailed to the customer (copied to you) once all are ready. " : "If the customer is with you, they can sign on your tablet; otherwise download, have them signed on paper and "}
        {emailOn ? "Upload the signed copies in Documents." : "upload the signed copies in Documents."}
      </p>
      <ul className="closing-list">
        {st.items.map((i) => (
          <li key={i.kind}>
            <span className="closing-ico">{i.state === "READY" ? <FileCheck2 {...ic} /> : i.state === "PREPARING" ? <Hourglass {...ic} /> : <PenLine {...ic} />}</span>
            <span className="closing-body">
              <strong>{i.label}</strong>
              {i.note && <span className="small muted">{i.note}</span>}
              {i.sentAt && <span className="small muted">E-mailed to the customer {formatLagos(i.sentAt)}</span>}
            </span>
            {i.documentId ? (
              <span className="closing-links">
                <a className="btn btn-sm" href={link(i.documentId, "view")} target="_blank" rel="noopener noreferrer">
                  View
                </a>
                <a className="btn btn-sm btn-primary" href={link(i.documentId, "download")}>
                  <FileDown {...ic} /> Download
                </a>
                {canSign && (
                  <Link className="btn btn-sm" href={`/requests/${appId}/sign/${i.documentId}`}>
                    <PenLine {...ic} /> Sign on tablet
                  </Link>
                )}
              </span>
            ) : (
              <span className={`badge ${i.state === "PREPARING" ? "" : "badge-warn"}`}>{i.state === "PREPARING" ? "Being prepared" : i.state === "NEEDS_ACCOUNT" ? "Needs account" : "Manual form"}</span>
            )}
          </li>
        ))}
      </ul>
      <h3 style={{ margin: "14px 0 6px", fontSize: 14 }}>Closing checklist</h3>
      <ul className="checklist small">
        {checklist.map((c) => (
          <li key={c.code} className={c.onFile ? "ok" : c.required ? "todo" : "opt"}>
            <span aria-hidden="true">{c.onFile ? "✓" : c.required ? "○" : "–"}</span> {c.label}
            {!c.required && <span className="muted"> (optional)</span>}
            <span className="sr-only">{c.onFile ? " — on file" : " — not yet uploaded"}</span>
          </li>
        ))}
      </ul>
      {conf && (
        <p className="small" style={{ margin: "12px 0 0" }}>
          <strong>Invoice confirmation:</strong> <span className={`badge ${conf.status === "COMPLETED" ? "badge-green" : conf.status === "RETURNED" || conf.status === "DISPATCH_FAILED" ? "badge-red" : ""}`}>{IC_STATUS_LABELS[conf.status]}</span>
          {conf.status === "RETURNED" && conf.returned_reason ? ` “${conf.returned_reason}” Upload a corrected invoice in Documents.` : ""}
        </p>
      )}
      {canEdit && (
        <details open={needsAccount} style={{ marginTop: 12 }}>
          <summary className="small">
            <strong>Customer&apos;s repayment account</strong>
            {st.account ? ` · ${st.account.bankName} ••••${st.account.accountNumber.slice(-4)}` : " · not recorded"}
          </summary>
          <div style={{ marginTop: 10 }}>
            <RepaymentAccountForm applicationId={appId} a={st.account} banks={banks} />
          </div>
        </details>
      )}
    </section>
  );
}
