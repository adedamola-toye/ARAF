import { FileDown, FileCheck2, Hourglass, PenLine } from "lucide-react";
import { db } from "@/server/db";
import { closingStatus } from "@/server/domain/closing-docs";
import { RepaymentAccountForm } from "./RepaymentAccountForm";

const ic = { className: "icon", "aria-hidden": true } as const;

/** Offer letter, GSI mandate and Remita set-up sheet prepared by ARAF after final approval. */
export async function ClosingDocuments({ appId, canEdit, link }: { appId: string; canEdit: boolean; link: (id: string, m: "view" | "download") => string }) {
  const st = await closingStatus(db, appId);
  if (!st) return null;
  const banks = canEdit ? (await db.query<{ name: string }>("SELECT name FROM financial_institutions ORDER BY name")).rows.map((r) => r.name) : [];
  const needsAccount = st.items.some((i) => i.state === "NEEDS_ACCOUNT");
  return (
    <section className="card" id="closing-documents" aria-labelledby="cd-h">
      <p className="eyebrow">After final approval</p>
      <h2 id="cd-h" style={{ marginBottom: 4 }}>Closing documents</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Prefilled from the approved request. If the customer is with you, have them sign; otherwise download, take it to the customer, then upload the signed copy in Documents.
      </p>
      <ul className="closing-list">
        {st.items.map((i) => (
          <li key={i.kind}>
            <span className="closing-ico">{i.state === "READY" ? <FileCheck2 {...ic} /> : i.state === "PREPARING" ? <Hourglass {...ic} /> : <PenLine {...ic} />}</span>
            <span className="closing-body">
              <strong>{i.label}</strong>
              {i.note && <span className="small muted">{i.note}</span>}
            </span>
            {i.documentId ? (
              <span className="closing-links">
                <a className="btn btn-sm" href={link(i.documentId, "view")} target="_blank" rel="noopener noreferrer">
                  View
                </a>
                <a className="btn btn-sm btn-primary" href={link(i.documentId, "download")}>
                  <FileDown {...ic} /> Download
                </a>
              </span>
            ) : (
              <span className={`badge ${i.state === "PREPARING" ? "" : "badge-warn"}`}>{i.state === "PREPARING" ? "Being prepared" : i.state === "NEEDS_ACCOUNT" ? "Needs account" : "Manual form"}</span>
            )}
          </li>
        ))}
      </ul>
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
