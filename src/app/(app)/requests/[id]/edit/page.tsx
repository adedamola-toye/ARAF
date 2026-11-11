import { notFound, redirect } from "next/navigation";
import { requireUser } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { getCase } from "@/server/domain/views";
import { CATEGORY_LABEL, UPLOADABLE_BY_STAGE, signDocumentLink } from "@/server/domain/documents";
import { requiredSubmissionDocuments, draftDataSchema, APPLICANT_TYPE_LABELS } from "@/server/domain/application-data";
import { maskWithLast4 } from "@/server/mask";
import { koboToNairaString } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { DraftForm } from "./DraftForm";
import { RetailEdit } from "./RetailEdit";

export const metadata = { title: "Edit request" };

export default async function EditRequest({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, session } = await requireUser();
  const { id } = await params;
  let c;
  try {
    c = await getCase(ctx, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const app = c.app;
  const myTask = c.openTask && c.openTask.assignee_id === session.staffId && c.openTask.stage === "INITIATOR_CORRECTION" ? c.openTask : null;
  if (app.workflow === "RETAIL") {
    const editable = app.stage === "DRAFT" || app.stage === "INITIATOR_CORRECTION";
    if (app.initiator_id === session.staffId && (app.stage === "DRAFT" || myTask)) return <RetailEdit c={c} staffId={session.staffId} sessionId={session.sessionId} mode="INITIATOR" />;
    if (editable && app.assigned_rm_id === session.staffId) return <RetailEdit c={c} staffId={session.staffId} sessionId={session.sessionId} mode="ASSIGNED_RM" />;
    redirect(`/requests/${id}`);
  }
  if (app.initiator_id !== session.staffId || !(app.stage === "DRAFT" || myTask)) redirect(`/requests/${id}`);
  const source = c.working ?? (c.version ? { ...c.version, directors: c.directors } : null);
  const data = draftDataSchema.parse(source?.data ?? {});
  const rbes =
    app.initiator_role === "RM"
      ? (await db.query(`SELECT s.id, s.full_name, ra.region FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.role = 'RBE' AND ra.active AND s.status = 'ACTIVE' AND s.id <> $1 ORDER BY s.full_name`, [session.staffId])).rows
      : [];
  const docs = c.documents.filter((d) => !d.superseded_at && d.scan_status !== "REJECTED");
  const required = requiredSubmissionDocuments(app.applicant_type);
  const cats = (UPLOADABLE_BY_STAGE[myTask ? "INITIATOR_CORRECTION" : "DRAFT"] ?? []).filter((x) => app.applicant_type !== "INDIVIDUAL" || x !== "CAC_CERTIFICATE");
  const openCorrection = c.corrections.filter((x: { resolved_at: Date | null }) => !x.resolved_at).at(-1);
  const typeLabel = APPLICANT_TYPE_LABELS[app.applicant_type as keyof typeof APPLICANT_TYPE_LABELS];
  return (
    <>
      <PageHeader
        crumbs={[{ href: "/requests", label: "View Progress" }, { href: `/requests/${id}`, label: app.ref }, { label: app.stage === "DRAFT" ? "Draft" : "Correction" }]}
        eyebrow={app.stage === "DRAFT" ? "New request" : "Correction"}
        title={`${typeLabel} request`}
        intro={`Saved on the server; last update ${formatLagos(app.updated_at)}. Your entries stay in place if validation fails.`}
      />
      <DraftForm
        applicationId={app.id}
        taskId={myTask?.id ?? ""}
        applicantType={app.applicant_type}
        initiatorRole={app.initiator_role}
        correction={openCorrection ? { by: openCorrection.requested_by_name, reason: openCorrection.reason, at: formatLagos(openCorrection.created_at) } : null}
        data={{
          ...data,
          amount: data.requestedAmountKobo !== null ? koboToNairaString(data.requestedAmountKobo) : "",
          tenor: data.tenorMonths ? String(data.tenorMonths) : "",
          items: data.items.map((i) => ({ description: i.description, quantity: String(i.quantity), unitCost: koboToNairaString(i.unitCostKobo) })),
        }}
        maskedBvn={source?.bvn_last4 ? maskWithLast4(source.bvn_last4) : null}
        maskedTin={source?.tin_last4 ? maskWithLast4(source.tin_last4, 10) : null}
        directors={(source?.directors ?? []).map((d: { id: string; full_name: string; bvn_last4: string }) => ({ id: d.id, fullName: d.full_name, masked: maskWithLast4(d.bvn_last4) }))}
        rbes={rbes.map((r) => ({ id: r.id, label: `${r.full_name}${r.region ? ` (${r.region})` : ""}` }))}
        isCorrection={!!myTask}
        required={required.map((r) => ({ code: r, label: CATEGORY_LABEL[r], done: docs.some((d) => d.category === r && d.scan_status === "CLEAN") }))}
        uploadCategories={cats.map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))}
        uploaded={docs.map((d) => ({ id: d.id, label: `${CATEGORY_LABEL[d.category]}: ${d.filename} (v${d.version_no})`, href: signDocumentLink(d.id, session.staffId, session.sessionId, "download"), quarantined: d.scan_status === "QUARANTINED", scanDetail: d.scan_detail }))}
      />
    </>
  );
}
