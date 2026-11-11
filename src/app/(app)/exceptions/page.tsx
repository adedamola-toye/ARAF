import Link from "next/link";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { pendingExceptionsFor } from "@/server/domain/retail";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import { roleLabel } from "@/server/domain/products";
import { PageHeader } from "@/components/PageHeader";
import { ExceptionDecision } from "../requests/[id]/RetailClient";

export const metadata = { title: "Exceptions awaiting decision" };

export default async function ExceptionsPage() {
  const { session } = await requireUser();
  const rows = await pendingExceptionsFor(db, session.staffId);
  const restructures = (
    await db.query(
      `SELECT sa.*, a.ref, a.customer_name, a.id AS application_id FROM servicing_actions sa JOIN facilities f ON f.id = sa.facility_id JOIN applications a ON a.id = f.application_id
        WHERE sa.status = 'REQUESTED' AND sa.approver_role IN (SELECT role FROM role_assignments WHERE staff_id = $1 AND active) AND sa.recorded_by <> $1 ORDER BY sa.recorded_at`,
      [session.staffId],
    )
  ).rows;
  return (
    <>
      <PageHeader eyebrow="Work" title="Exceptions awaiting your decision" intro="Only exceptions whose configured authority is a role you hold are listed. You cannot decide exceptions on requests you initiated or requested." />
      {rows.length === 0 && restructures.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>Nothing is awaiting your decision.</p></div>}
      <div className="stack">
        {rows.map((e: { id: string; type: string; ref: string; application_id: string; customer_name: string; product_label: string; requested_amount_kobo: string; reason: string; requested_by_name: string; requested_at: Date; approver_role: string; evidence_document_ids: string[] }) => (
          <section key={e.id} className="card">
            <div className="card-head">
              <h2>{e.type} exception · <Link href={`/requests/${e.application_id}?tab=documents`}>{e.ref}</Link></h2>
              <span className="badge badge-warn">Authority: {roleLabel(e.approver_role)}</span>
            </div>
            <p className="small" style={{ margin: 0 }}>{e.customer_name} · {e.product_label} · {formatKobo(e.requested_amount_kobo)}</p>
            <p>{e.reason}</p>
            <p className="small muted">Requested by {e.requested_by_name}, {formatLagos(e.requested_at)} · {e.evidence_document_ids.length} evidence document(s) in the request&apos;s Documents tab.</p>
            <ExceptionDecision exceptionId={e.id} />
          </section>
        ))}
        {restructures.map((r: { id: string; ref: string; application_id: string; customer_name: string; note: string }) => (
          <section key={r.id} className="card">
            <h2>Restructuring request · <Link href={`/requests/${r.application_id}`}>{r.ref}</Link></h2>
            <p>{r.customer_name}: {r.note}</p>
            <p className="small muted">Decide on the request page.</p>
          </section>
        ))}
      </div>
    </>
  );
}
