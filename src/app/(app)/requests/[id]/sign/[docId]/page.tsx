import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "../../../../../_lib/auth";
import { db } from "@/server/db";
import { CATEGORY_LABEL, signDocumentLink } from "@/server/domain/documents";
import { ID_TYPES, SIGNABLE, SIGNATORY_ROLES, SIGNING_STAGES } from "@/server/domain/signing";
import { PageHeader } from "@/components/PageHeader";
import { SignForm } from "./SignForm";

export const metadata = { title: "Sign document" };

export default async function SignPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { session } = await requireUser();
  const { id, docId } = await params;
  const app = (await db.query("SELECT id, ref, customer_name FROM applications WHERE id = $1", [id])).rows[0];
  const doc = (await db.query("SELECT id, category, filename, version_no, superseded_at FROM documents WHERE id = $1 AND application_id = $2", [docId, id])).rows[0];
  const task = (await db.query("SELECT stage, assignee_id FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [id])).rows[0];
  if (!app || !doc || !SIGNABLE[doc.category]) notFound();
  const allowed = task && SIGNING_STAGES.includes(task.stage) && task.assignee_id === session.staffId && !doc.superseded_at;
  return (
    <>
      <PageHeader eyebrow={`${app.ref} · ${app.customer_name ?? ""}`} title={`Sign: ${CATEGORY_LABEL[doc.category]}`} intro="Hand the tablet to the customer to read the document, then check their ID and let each signatory sign with a finger or stylus. If you are not with the customer, download the document instead, have it signed on paper and upload the signed copy." />
      <p className="small" style={{ marginTop: -8 }}>
        <Link href={`/requests/${id}#closing-documents`}>← Back to the request</Link>
      </p>
      <div className="split">
        <section style={{ minWidth: 0 }}>
          <p className="small" style={{ marginTop: 0 }}>
            <a className="btn btn-sm" href={signDocumentLink(doc.id, session.staffId, session.sessionId, "view")} target="_blank" rel="noopener noreferrer">
              Open the full document
            </a>{" "}
            <span className="muted">
              {CATEGORY_LABEL[doc.category]} · version {doc.version_no}
            </span>
          </p>
          <iframe title="Document to sign" src={signDocumentLink(doc.id, session.staffId, session.sessionId, "view")} className="sign-preview" />
        </section>
        <aside className="split-right">
          <div className="card">
            {allowed ? (
              <SignForm applicationId={id} sourceDocumentId={doc.id} customerName={app.customer_name ?? ""} idTypes={ID_TYPES} roles={SIGNATORY_ROLES} />
            ) : (
              <p className="small muted" style={{ margin: 0 }}>Only the officer preparing the offer pack can take signatures, while the pack is being prepared.</p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
