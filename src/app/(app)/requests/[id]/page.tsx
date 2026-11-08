import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { getCase } from "@/server/domain/views";
import { signDocumentLink, CATEGORY_LABEL, DOC_CATEGORIES, UPLOADABLE_BY_STAGE, PACK, type DocumentRow } from "@/server/domain/documents";
import { STAGE_LABELS, ACTION_LABELS, allowedActions, type Stage, type TaskAction } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { APPLICANT_TYPE_LABELS, assetCostKobo, requiredSubmissionDocuments, type DraftData } from "@/server/domain/application-data";
import { getRoute } from "@/server/domain/routing";
import { activeCalculator, calculatorKey } from "@/server/domain/apr/registry";
import { REMINDER_MIN_AGE_MS } from "@/server/domain/workflow";
import { formatKobo, koboToNairaString } from "@/server/money";
import { formatDateOnly, formatDuration, formatLagos, lagosDate } from "@/server/time";
import { maskWithLast4 } from "@/server/mask";
import { config } from "@/server/config";
import {
  AssessmentForm,
  BookingForm,
  CrmsOkay,
  FirstReviewApprove,
  GenerateOffer,
  ReasonButton,
  ReminderButton,
  RevealIdentifiers,
  TaskButton,
  UploadForm,
} from "./CaseClient";

type Case = Awaited<ReturnType<typeof getCase>>;
type SP = Record<string, string | undefined>;

export const metadata = { title: "Request" };

const TABS = [
  ["summary", "Summary"],
  ["documents", "Documents"],
  ["assessment", "Credit assessment"],
  ["history", "History & handoffs"],
  ["audit", "Audit trail"],
] as const;

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { ctx, session, roles } = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let c: Case;
  try {
    c = await getCase(ctx, id);
  } catch (e) {
    if (e instanceof DomainError && e.code === "NOT_FOUND") notFound();
    if (e instanceof DomainError && e.code === "FORBIDDEN")
      return (
        <div className="card" role="alert">
          <h1>Access denied</h1>
          <p className="muted">Documents and details are visible only to officers authorised on this request. This attempt was recorded.</p>
          <Link className="btn btn-primary" href="/queue">
            My Action Queue
          </Link>
        </div>
      );
    throw e;
  }
  const app = c.app;
  const myTask = c.openTask && c.openTask.assignee_id === session.staffId && roles.includes(c.openTask.assignee_role) ? c.openTask : null;
  const tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? "summary") as (typeof TABS)[number][0];
  const previewDoc = sp.doc ? c.documents.find((d) => d.id === sp.doc) ?? null : null;
  const link = (docId: string, mode: "view" | "download") => signDocumentLink(docId, session.staffId, session.sessionId, mode);
  const tabHref = (t: string, extra: SP = {}) => {
    const q = new URLSearchParams(Object.entries({ task: sp.task, tab: t, ...extra }).filter(([, v]) => v) as [string, string][]);
    return `/requests/${id}?${q.toString()}`;
  };
  const data: DraftData | null = c.version?.data ?? c.working?.data ?? null;
  const isInitiator = app.initiator_id === session.staffId;
  const waited = c.openTask?.assigned_at ? Date.now() - new Date(c.openTask.assigned_at).getTime() : 0;
  const staleDeepLink = sp.task && (!myTask || myTask.id !== sp.task);

  return (
    <>
      <div className="case-head">
        <div>
          <p className="small muted" style={{ margin: 0 }}>
            <Link href="/queue">My Action Queue</Link> / Request
          </p>
          <h1 className="mono" style={{ marginBottom: 4 }}>
            {app.ref}
          </h1>
          <div className="case-meta">
            <strong>{app.customer_name || "Draft"}</strong>
            <span className="badge">{APPLICANT_TYPE_LABELS[app.applicant_type as keyof typeof APPLICANT_TYPE_LABELS]}</span>
            <span className={`badge ${app.status === "REJECTED" ? "badge-red" : app.status === "CLOSED" ? "badge-dark" : app.status === "BOOKED" ? "badge-green" : "badge-yellow"}`}>
              {STAGE_LABELS[app.stage as Stage]}
            </span>
            {app.route && <span className="badge badge-blue">Route {app.route}</span>}
            <span className="badge">{formatKobo(app.requested_amount_kobo)}</span>
          </div>
        </div>
        <div className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
          {c.openTask && (
            <span className="small muted">
              With {c.openTask.assignee_name ?? <strong style={{ color: "var(--danger)" }}>no eligible assignee (escalated to Super Admin)</strong>}
              {c.openTask.assigned_at && <> · waiting {formatDuration(waited)}</>}
            </span>
          )}
          {isInitiator && c.openTask?.assignee_id && c.openTask.assignee_id !== session.staffId && waited > REMINDER_MIN_AGE_MS && <ReminderButton applicationId={app.id} />}
          {isInitiator && (app.stage === "DRAFT" || (myTask && myTask.stage === "INITIATOR_CORRECTION")) && (
            <Link className="btn btn-primary" href={`/requests/${app.id}/edit`}>
              {app.stage === "DRAFT" ? "Continue draft" : "Edit and resubmit"}
            </Link>
          )}
        </div>
      </div>
      {sp.submitted && <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>Submitted successfully.</div>}
      {staleDeepLink && (
        <div className="alert alert-info" role="status" style={{ marginBottom: 12 }}>
          The task in this link is no longer awaiting your action (it may have been actioned or reassigned). You can still view the request.
        </div>
      )}

      <div className={`split ${previewDoc ? "wide-preview" : ""}`}>
        <section aria-label="Request details" style={{ minWidth: 0 }}>
          <nav className="tabs" aria-label="Request sections">
            {TABS.map(([k, label]) => (
              <Link key={k} className="tab" href={tabHref(k)} aria-current={tab === k ? "page" : undefined}>
                {label}
                {k === "documents" ? ` (${c.documents.filter((d) => !d.superseded_at).length})` : ""}
              </Link>
            ))}
          </nav>
          {tab === "summary" && <Summary c={c} data={data} />}
          {tab === "documents" && <Documents c={c} link={link} tabHref={tabHref} previewId={previewDoc?.id ?? null} myTask={myTask} isInitiator={isInitiator} />}
          {tab === "assessment" && <Assessment c={c} />}
          {tab === "history" && <History c={c} />}
          {tab === "audit" && <CaseAudit appId={app.id} />}
        </section>
        <aside className="split-right" aria-label="Actions and preview">
          {myTask && <ActionPanel c={c} task={myTask} data={data} />}
          {!myTask && c.openTask && (
            <div className="card">
              <h2>Current step</h2>
              <p style={{ margin: 0 }}>
                <strong>{STAGE_LABELS[c.openTask.stage as Stage]}</strong> — {c.openTask.required_action}
              </p>
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                Owner: {c.openTask.assignee_name ?? "awaiting assignment"} ({ROLE_LABELS[c.openTask.assignee_role as Role]})
              </p>
            </div>
          )}
          {previewDoc && <Preview doc={previewDoc} link={link} closeHref={tabHref("documents")} />}
        </aside>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ summary

function Summary({ c, data }: { c: Case; data: DraftData | null }) {
  const app = c.app;
  const route = getRoute(app.route);
  const name = (id: string | null) => (id ? c.people[id] ?? "—" : "—");
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Applicant</h2>
          <RevealIdentifiers applicationId={app.id} />
        </div>
        {data ? (
          <table className="kv">
            <tbody>
              {app.applicant_type === "ENTERPRISE" ? (
                <>
                  <tr><th>Proprietor legal name</th><td>{data.customerName}</td></tr>
                  <tr><th>Registered business name</th><td>{data.businessName}</td></tr>
                </>
              ) : app.applicant_type === "LIMITED" ? (
                <tr><th>Company name</th><td>{data.companyName}</td></tr>
              ) : (
                <tr><th>Customer name</th><td>{data.customerName}</td></tr>
              )}
              {app.applicant_type !== "INDIVIDUAL" && <tr><th>CAC registration number</th><td className="mono">{data.registrationNumber}</td></tr>}
              <tr><th>Phone / email</th><td>{data.phone} {data.email && `· ${data.email}`}</td></tr>
              <tr><th>Address</th><td>{data.address || "—"}</td></tr>
              {app.applicant_type !== "LIMITED" && <tr><th>BVN</th><td className="mono">{c.masked.bvn}</td></tr>}
              {app.applicant_type !== "INDIVIDUAL" && <tr><th>TIN</th><td className="mono">{c.masked.tin}</td></tr>}
              {app.applicant_type === "LIMITED" && (
                <tr>
                  <th>Directors ({c.directors.length})</th>
                  <td>
                    {c.directors.map((d: { id: string; full_name: string; bvn_last4: string }) => (
                      <div key={d.id}>
                        {d.full_name} · BVN <span className="mono">{maskWithLast4(d.bvn_last4)}</span>
                      </div>
                    ))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <p className="muted">No details yet.</p>
        )}
      </div>
      {data && (
        <div className="card">
          <h2>Financing request</h2>
          <table className="kv">
            <tbody>
              <tr><th>Requested amount</th><td><strong>{formatKobo(data.requestedAmountKobo)}</strong></td></tr>
              <tr><th>Tenor</th><td>{data.tenorMonths ? `${data.tenorMonths} months` : "—"}</td></tr>
              <tr><th>DAO code</th><td className="mono">{data.daoCode || "—"}</td></tr>
              <tr><th>POS serial number</th><td className="mono">{data.posSerial || "—"}</td></tr>
              <tr><th>Supplier</th><td>{data.supplierName}{data.supplierAddress && <div className="small muted">{data.supplierAddress} {data.supplierPhone}</div>}</td></tr>
              <tr><th>Invoice reference</th><td className="mono">{data.invoiceRef || "—"}</td></tr>
              <tr><th>Rental coverage</th><td>{data.rentStart ? `${formatDateOnly(data.rentStart)} – ${formatDateOnly(data.rentEnd)}` : "—"}</td></tr>
              <tr><th>12-month statements confirmed</th><td>{data.statementsCover12Months ? "Yes" : "No"}</td></tr>
            </tbody>
          </table>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="data">
              <thead>
                <tr><th>Item to finance</th><th className="right">Qty</th><th className="right">Unit cost</th><th className="right">Total</th></tr>
              </thead>
              <tbody>
                {data.items.map((i, idx) => (
                  <tr key={idx}>
                    <td>{i.description}</td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{formatKobo(i.unitCostKobo)}</td>
                    <td className="num">{formatKobo(i.quantity * i.unitCostKobo)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}><strong>Asset cost</strong></td>
                  <td className="num"><strong>{formatKobo(assetCostKobo(data.items))}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card">
        <h2>Routing and officers</h2>
        <table className="kv">
          <tbody>
            <tr><th>Initiator</th><td>{name(app.initiator_id)} ({ROLE_LABELS[app.initiator_role as Role]}{app.region ? `, ${app.region}` : ""})</td></tr>
            {app.selected_rbe_id && <tr><th>Selected RBE</th><td>{name(app.selected_rbe_id)}</td></tr>}
            <tr><th>Business endorsement</th><td>{name(app.endorser_id)}</td></tr>
            <tr><th>Credit route</th><td>{route ? route.label : "Determined after endorsement"}</td></tr>
            <tr><th>First credit reviewer</th><td>{name(app.first_reviewer_id)}</td></tr>
            <tr><th>Second credit reviewer</th><td>{name(app.second_reviewer_id)}</td></tr>
            <tr><th>Credit Officer 3 (pack)</th><td>{name(app.pack_co3_id)}</td></tr>
            <tr><th>Disbursement officers</th><td>{name(app.do1_id)} / {name(app.do2_id)}</td></tr>
          </tbody>
        </table>
      </div>
      {c.assessment && (
        <div className="card">
          <h2>Credit assessment</h2>
          <div className="metric-grid">
            <div className="metric"><div className="k">APR</div><div className="v">{c.assessment.apr_percent}%</div></div>
            <div className="metric"><div className="k">DSR</div><div className="v">{c.assessment.dsr_percent}%</div></div>
            <div className="metric"><div className="k">Markup</div><div className="v">{formatKobo(c.assessment.markup_kobo)}</div></div>
            <div className="metric"><div className="k">Cost plus markup</div><div className="v">{formatKobo(c.assessment.cost_plus_markup_kobo)}</div></div>
          </div>
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            {c.assessment.calculator_id}@{c.assessment.calculator_version} by {c.assessment.assessor_name}, {formatLagos(c.assessment.created_at)}
            {!c.assessment.production_validated && " · development calculator, not bank validated"}
          </p>
        </div>
      )}
      {c.disbursement && (
        <div className="card">
          <h2>Booking</h2>
          <table className="kv">
            <tbody>
              <tr><th>Approved / disbursed</th><td>{formatKobo(c.disbursement.approved_amount_kobo)} / <strong>{formatKobo(c.disbursement.amount_kobo)}</strong></td></tr>
              <tr><th>Disbursement date</th><td>{formatDateOnly(c.disbursement.disbursed_on)}</td></tr>
              <tr><th>Transaction reference</th><td className="mono">{c.disbursement.transaction_ref}</td></tr>
              <tr><th>Recorded by</th><td>{c.disbursement.recorded_by_name}, {formatLagos(c.disbursement.recorded_at)}</td></tr>
              <tr><th>Repayment schedule</th><td>{c.instalments.map((i: { seq: number; due_date: string; amount_kobo: string }) => <div key={i.seq}>{formatDateOnly(i.due_date)} · {formatKobo(i.amount_kobo)}</div>)}</td></tr>
              <tr><th>Process completed (CO3)</th><td>{app.process_completed_at ? `${name(app.process_completed_by)}, ${formatLagos(app.process_completed_at)}` : "Pending"}</td></tr>
              <tr><th>Vendor payment confirmed</th><td>{app.vendor_confirmed_at ? `${name(app.vendor_confirmed_by)}, ${formatLagos(app.vendor_confirmed_at)}` : <span className="badge badge-yellow">Pending</span>}</td></tr>
              {c.closure && <tr><th>Closure pack email</th><td>{c.closure.delivery_mode === "ATTACHMENTS" ? "Attachments" : "Secure link"} · <span className="badge">{c.closure.delivery_status}</span> {c.closure.attempts > 0 && `(${c.closure.attempts} attempt${c.closure.attempts > 1 ? "s" : ""})`}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ documents

function Documents({ c, link, tabHref, previewId, myTask, isInitiator }: { c: Case; link: (id: string, m: "view" | "download") => string; tabHref: (t: string, e?: SP) => string; previewId: string | null; myTask: Case["openTask"]; isInitiator: boolean }) {
  const stage = c.app.stage as Stage;
  const uploadStage = myTask ? (myTask.stage as Stage) : isInitiator && stage === "DRAFT" ? "DRAFT" : null;
  const cats = uploadStage ? (UPLOADABLE_BY_STAGE[uploadStage] ?? []).filter((x) => !(c.app.applicant_type === "INDIVIDUAL" && x === "CAC_CERTIFICATE")) : [];
  const current = c.documents.filter((d) => !d.superseded_at && d.scan_status !== "REJECTED");
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">All documents retained on this request</caption>
          <thead>
            <tr><th>Document</th><th>Uploaded</th><th>Version</th><th>Open</th></tr>
          </thead>
          <tbody>
            {c.documents.length === 0 && <tr><td colSpan={4} className="empty">No documents yet.</td></tr>}
            {c.documents.map((d) => (
              <tr key={d.id} className={previewId === d.id ? "selected-row" : undefined}>
                <td className="small" style={{ minWidth: 180 }}>
                  <strong>{CATEGORY_LABEL[d.category] ?? d.category}</strong>
                  <div style={{ wordBreak: "break-all" }}>{d.filename} <span className="muted">· {(Number(d.size_bytes) / 1024).toFixed(0)} KB</span></div>
                  {d.generated && <span className="badge badge-blue">Generated · template v{d.template_version}</span>}
                </td>
                <td className="small" style={{ minWidth: 150 }}>
                  {d.uploader_name}
                  <div className="muted">{d.uploaded_role ? ROLE_LABELS[d.uploaded_role as Role] ?? d.uploaded_role : ""}</div>
                  <div className="muted nowrap">{formatLagos(d.uploaded_at)}</div>
                </td>
                <td className="small">
                  <div>v{d.version_no}</div>
                  {d.scan_status === "QUARANTINED" ? <span className="badge badge-yellow">Quarantined</span> : d.scan_status === "REJECTED" ? <span className="badge badge-red">Rejected (scan)</span> : d.superseded_at ? <span className="badge">Superseded</span> : <span className="badge badge-green">Current</span>}
                </td>
                <td>
                  {d.scan_status === "CLEAN" && !d.purged_at ? (
                    <div className="stack" style={{ gap: 6 }}>
                      <Link className="btn btn-sm" href={tabHref("documents", { doc: d.id })} aria-label={`Preview ${d.filename} version ${d.version_no}`}>Preview</Link>
                      <a className="btn btn-sm" href={link(d.id, "download")} aria-label={`Download ${d.filename} version ${d.version_no}`}>Download</a>
                    </div>
                  ) : (
                    <span className="small muted">Unavailable</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Every officer authorised on this request can view and download all retained documents, including superseded versions. Links expire after 5 minutes and every view or download is audited.
      </p>
      {cats.length > 0 && (
        <div className="card">
          <h2>Upload a document</h2>
          <UploadForm
            applicationId={c.app.id}
            categories={cats.map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))}
            replaces={current.filter((d) => cats.includes(d.category) && DOC_CATEGORIES.find((k) => k.code === d.category)?.multiple).map((d) => ({ id: d.id, label: `${CATEGORY_LABEL[d.category]}: ${d.filename} (v${d.version_no})` }))}
          />
        </div>
      )}
    </div>
  );
}

function Preview({ doc, link, closeHref }: { doc: DocumentRow; link: (id: string, m: "view" | "download") => string; closeHref: string }) {
  const src = link(doc.id, "view");
  const canInline = ["application/pdf", "image/png", "image/jpeg", "text/html"].includes(doc.mime_type);
  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ fontSize: "1rem" }}>
          {CATEGORY_LABEL[doc.category]} · v{doc.version_no} {doc.superseded_at && <span className="badge">Superseded</span>}
        </h2>
        <div className="row">
          <a className="btn btn-sm" href={link(doc.id, "download")}>Download</a>
          <Link className="btn btn-sm btn-ghost" href={closeHref} aria-label="Close preview">✕</Link>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: -6 }}>{doc.filename}</p>
      {canInline ? (
        doc.mime_type.startsWith("image/") ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="preview-img" src={src} alt={`${CATEGORY_LABEL[doc.category]} preview`} />
        ) : (
          <iframe className="preview-frame" src={src} title={`Preview of ${doc.filename}`} sandbox={doc.mime_type === "text/html" ? "" : undefined} />
        )
      ) : (
        <p className="muted">This file type cannot be previewed in the browser. Use Download.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ assessment

function Assessment({ c }: { c: Case }) {
  if (!c.assessments.length) return <div className="card"><p className="muted" style={{ margin: 0 }}>The APR / DSR assessment is pending. It is completed by the first credit reviewer.</p></div>;
  return (
    <div className="stack">
      {c.assessments.map((a: Case["assessments"][number]) => (
        <div className="card" key={a.id}>
          <div className="card-head">
            <h2>{a.superseded_at ? "Superseded assessment" : "Current assessment"}</h2>
            <span className={`badge ${a.superseded_at ? "" : "badge-green"}`}>{a.calculator_id}@{a.calculator_version}</span>
          </div>
          {!a.production_validated && <div className="alert alert-warn" style={{ marginBottom: 10 }}>Development calculator: not the bank&apos;s validated APR workbook. Production credit approval is blocked until the bank calculator is configured.</div>}
          <div className="grid-2">
            <div>
              <h3>Inputs</h3>
              <table className="kv"><tbody>
                {Object.entries(a.inputs as Record<string, string | number>).map(([k, v]) => (
                  <tr key={k}><th>{k}</th><td className="mono">{k.endsWith("Kobo") ? formatKobo(Number(v)) : String(v)}</td></tr>
                ))}
              </tbody></table>
            </div>
            <div>
              <h3>Outputs</h3>
              <table className="kv"><tbody>
                {Object.entries(a.outputs as Record<string, string | number>).map(([k, v]) => (
                  <tr key={k}><th>{k}</th><td className="mono">{k.endsWith("Kobo") ? formatKobo(Number(v)) : String(v)}</td></tr>
                ))}
              </tbody></table>
            </div>
          </div>
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            Assessor: {a.assessor_name} · started {formatLagos(a.started_at)} · saved {formatLagos(a.created_at)} · application version {c.versions.find((v: { id: string }) => v.id === a.version_id)?.version_no ?? "?"}
          </p>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ history

function History({ c }: { c: Case }) {
  const decisionByTask = new Map(c.decisions.map((d: { task_id: string }) => [d.task_id, d]));
  return (
    <div className="stack">
      <div className="card">
        <h2>Handoffs and stage durations</h2>
        <ol className="timeline">
          {c.tasks.map((t: Case["tasks"][number]) => {
            const d = decisionByTask.get(t.id) as Case["decisions"][number] | undefined;
            const end = t.completed_at ? new Date(t.completed_at).getTime() : Date.now();
            return (
              <li key={t.id} className={t.status === "OPEN" ? "open" : "done"}>
                <div className="row" style={{ gap: 8 }}>
                  <strong>{STAGE_LABELS[t.stage as Stage]}</strong>
                  {t.status === "OPEN" ? <span className="badge badge-yellow">Current</span> : d ? <span className={`badge ${d.action === "REJECT" ? "badge-red" : ["RETURN", "REQUEST_INITIATOR", "SEND_FOR_CORRECTION"].includes(d.action) ? "badge-blue" : "badge-green"}`}>{ACTION_LABELS[d.action as TaskAction] ?? d.action}</span> : null}
                  {d?.invalidated_at && <span className="badge badge-red" title={d.invalidated_reason}>Invalidated</span>}
                </div>
                <div className="small">
                  {t.assignee_name ?? "Unassigned"} · {ROLE_LABELS[t.assignee_role as Role] ?? t.assignee_role}
                </div>
                <div className="small muted">
                  Entered {formatLagos(t.entered_at)} · {t.completed_at ? `exited ${formatLagos(t.completed_at)}` : "in progress"} · {formatDuration(end - new Date(t.entered_at).getTime())}
                  {t.last_reminder_at && ` · last reminder ${formatLagos(t.last_reminder_at)}`}
                </div>
                {d?.reason && <div className="small">Reason: {d.reason}</div>}
                {d && <div className="small muted">Reviewed application v{d.version_no ?? "—"} with {(d.reviewed_documents as unknown[]).length} document(s){d.invalidated_reason ? ` · ${d.invalidated_reason}` : ""}</div>}
              </li>
            );
          })}
        </ol>
      </div>
      {c.corrections.length > 0 && (
        <div className="card">
          <h2>Corrections</h2>
          <div className="table-wrap"><table className="data"><thead><tr><th>Requested</th><th>From</th><th>To</th><th>Reason</th><th>Resolution</th></tr></thead><tbody>
            {c.corrections.map((x: Case["corrections"][number]) => (
              <tr key={x.id}><td className="small nowrap">{formatLagos(x.created_at)}<div className="muted">{x.requested_by_name}</div></td><td className="small">{STAGE_LABELS[x.from_stage as Stage]}</td><td className="small">{STAGE_LABELS[x.to_stage as Stage]}</td><td className="small">{x.reason}</td><td className="small">{x.resolution ?? "Open"}{x.resolved_at && <div className="muted">{formatLagos(x.resolved_at)}</div>}</td></tr>
            ))}
          </tbody></table></div>
        </div>
      )}
      <div className="card">
        <h2>Application versions</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {c.versions.map((v: Case["versions"][number]) => (
            <li key={v.id} className="small">v{v.version_no} · created {formatLagos(v.created_at)} · {v.submitted_at ? `submitted ${formatLagos(v.submitted_at)}` : "working draft"}{v.id === c.app.current_version_id && " · current"}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

async function CaseAudit({ appId }: { appId: string }) {
  const rows = (await db.query(
    `SELECT e.occurred_at, e.action, e.outcome, e.actor_role, e.stage, e.reason, s.full_name, e.document_version
       FROM audit_events e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.application_id = $1 ORDER BY e.id DESC LIMIT 300`,
    [appId],
  )).rows;
  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="sr-only">Audit trail for this request</caption>
        <thead><tr><th>Time</th><th>Who</th><th>Role</th><th>Action</th><th>Outcome</th><th>Stage</th><th>Reason</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="small nowrap">{formatLagos(r.occurred_at)}</td>
              <td className="small">{r.full_name ?? "System"}</td>
              <td className="small">{r.actor_role ? ROLE_LABELS[r.actor_role as Role] ?? r.actor_role : "—"}</td>
              <td className="small mono">{r.action}{r.document_version ? ` (v${r.document_version})` : ""}</td>
              <td><span className={`badge ${r.outcome === "SUCCESS" ? "badge-green" : "badge-red"}`}>{r.outcome}</span></td>
              <td className="small">{r.stage ? STAGE_LABELS[r.stage as Stage] ?? r.stage : "—"}</td>
              <td className="small">{r.reason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ padding: "8px 12px", margin: 0 }}>Network address and device metadata are available to the Super Admin in System audit.</p>
    </div>
  );
}

// ------------------------------------------------------------------ action panel

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li>
      <span className={`tick ${ok ? "ok" : "no"}`} aria-hidden="true">{ok ? "✓" : "•"}</span>
      <span>{children}</span>
      <span className="sr-only">{ok ? "(done)" : "(outstanding)"}</span>
    </li>
  );
}

function ActionPanel({ c, task, data }: { c: Case; task: NonNullable<Case["openTask"]>; data: DraftData | null }) {
  const app = c.app;
  const stage = task.stage as Stage;
  const hidden = { taskId: task.id, lockVersion: String(app.lock_version) };
  const actions = allowedActions(stage, app.route);
  const docs = c.documents.filter((d) => !d.superseded_at && d.scan_status === "CLEAN");
  const has = (cat: string) => docs.some((d) => d.category === cat);
  const reports = docs.filter((d) => d.category === "CREDIT_REPORT").length;
  const assessmentCurrent = !!c.assessment && c.assessment.version_id === app.current_version_id;
  const openCorrection = c.corrections.filter((x: { resolved_at: Date | null }) => !x.resolved_at).at(-1);
  const calc = activeCalculator();

  const body: React.ReactNode[] = [];
  if (openCorrection && ["CREDIT_CORRECTION", "INITIATOR_CORRECTION", "DISBURSEMENT_CORRECTION", "OFFER_PREPARATION"].includes(stage)) {
    body.push(<div key="corr" className="alert alert-warn">Correction requested by {openCorrection.requested_by_name}: {openCorrection.reason}</div>);
  }

  switch (stage) {
    case "BUSINESS_ENDORSEMENT":
      body.push(<p key="t" className="small muted">Business endorsement is required before credit routing.</p>);
      body.push(<TaskButton key="e" hidden={hidden} action="ENDORSE" label="Endorse" />);
      break;
    case "FIRST_CREDIT_REVIEW":
    case "CREDIT_CORRECTION": {
      const vals = (k: string, defaultFrom?: string) => {
        const prev = c.assessment?.inputs as Record<string, string | number> | undefined;
        if (prev && prev[k] !== undefined) return k.endsWith("Kobo") ? koboToNairaString(Number(prev[k])) : String(prev[k]);
        if (defaultFrom === "assetCost" && data) return koboToNairaString(assetCostKobo(data.items));
        if (defaultFrom === "tenorMonths" && data?.tenorMonths) return String(data.tenorMonths);
        return "";
      };
      body.push(
        <ul key="cl" className="checklist">
          <Check ok={reports >= 3}>Three credit reports uploaded ({reports}/3)</Check>
          <Check ok={assessmentCurrent}>APR calculation with DSR completed{c.assessment ? `: APR ${c.assessment.apr_percent}%, DSR ${c.assessment.dsr_percent}%` : ""}</Check>
          <Check ok={false}>Logged invoice on invoice portal (confirm below)</Check>
        </ul>,
      );
      body.push(
        <details key="up" open={reports < 3}>
          <summary className="small" style={{ fontWeight: 700, cursor: "pointer" }}>Upload credit report</summary>
          <UploadForm applicationId={app.id} categories={[{ code: "CREDIT_REPORT", label: "Credit report" }, { code: "SUPPORTING", label: "Other supporting document" }]} />
        </details>,
      );
      body.push(
        <details key="calc" open={!assessmentCurrent}>
          <summary className="small" style={{ fontWeight: 700, cursor: "pointer" }}>APR / DSR calculator</summary>
          {!calc.productionValidated && <div className="alert alert-warn small" style={{ margin: "8px 0" }}>Development calculator ({calculatorKey(calc)}). {config.isProduction ? "Approval is blocked in production." : "Replace with the bank's APR workbook before production."}</div>}
          <AssessmentForm applicationId={app.id} calculatorLabel={calc.label} fields={calc.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, value: vals(f.key, f.defaultFrom) }))} />
        </details>,
      );
      if (stage === "FIRST_CREDIT_REVIEW") body.push(<FirstReviewApprove key="ap" hidden={hidden} ready={reports >= 3 && assessmentCurrent} />);
      else body.push(<TaskButton key="rs" hidden={hidden} action="RESUBMIT" label={`Resubmit to ${STAGE_LABELS[(openCorrection?.from_stage as Stage) ?? "UNIT_HEAD_REVIEW"]}`} />);
      break;
    }
    case "SECOND_CREDIT_REVIEW":
    case "UNIT_HEAD_REVIEW":
    case "DIVISIONAL_HEAD_REVIEW":
      body.push(
        c.assessment ? (
          <div key="a" className="highlight small">APR <strong>{c.assessment.apr_percent}%</strong> · DSR <strong>{c.assessment.dsr_percent}%</strong> · Cost plus markup {formatKobo(c.assessment.cost_plus_markup_kobo)}</div>
        ) : (
          <div key="a" className="alert alert-warn">Assessment pending.</div>
        ),
      );
      if (actions.includes("PROCEED")) body.push(<TaskButton key="p" hidden={hidden} action="PROCEED" label="Proceed" />);
      if (actions.includes("APPROVE")) body.push(<TaskButton key="p" hidden={hidden} action="APPROVE" label="Approve" />);
      if (stage === "DIVISIONAL_HEAD_REVIEW") body.push(<p key="n" className="small muted" style={{ margin: 0 }}>Approval assigns the initiator to prepare the signed offer pack.</p>);
      break;
    case "INITIATOR_CORRECTION":
      body.push(<p key="t" className="small">Update the request or replace documents, then resubmit. Changes to underwriting fields (amount, tenor, items, identifiers) require a fresh credit review.</p>);
      body.push(<Link key="l" className="btn btn-primary" href={`/requests/${app.id}/edit`}>Edit and resubmit</Link>);
      body.push(<UploadForm key="u" applicationId={app.id} categories={(UPLOADABLE_BY_STAGE.INITIATOR_CORRECTION ?? []).filter((x) => app.applicant_type !== "INDIVIDUAL" || x !== "CAC_CERTIFICATE").map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))} />);
      body.push(<TaskButton key="r" hidden={hidden} action="RESUBMIT" label="Resubmit without field changes" primary={false} />);
      break;
    case "OFFER_PREPARATION":
      body.push(
        <ul key="cl" className="checklist">
          <Check ok={has("GENERATED_OFFER")}>Offer letter generated from the bank template</Check>
          {PACK.map((p) => <Check key={p} ok={has(p)}>{CATEGORY_LABEL[p]}</Check>)}
        </ul>,
      );
      body.push(<GenerateOffer key="g" applicationId={app.id} hasOffer={has("GENERATED_OFFER")} />);
      body.push(<UploadForm key="u" applicationId={app.id} categories={[...PACK, "SUPPORTING"].map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))} />);
      body.push(<TaskButton key="s" hidden={hidden} action="SUBMIT_PACK" label="Submit pack to Credit Officer 3" />);
      break;
    case "CO3_PACK_REVIEW":
      body.push(<ul key="cl" className="checklist"><Check ok={docs.some((d) => d.category === "INSURANCE_EVIDENCE" && d.uploaded_role === "CREDIT_OFFICER_3")}>Separate evidence of insurance uploaded</Check></ul>);
      body.push(<UploadForm key="u" applicationId={app.id} categories={[{ code: "INSURANCE_EVIDENCE", label: CATEGORY_LABEL.INSURANCE_EVIDENCE }, { code: "SUPPORTING", label: CATEGORY_LABEL.SUPPORTING }]} />);
      body.push(<TaskButton key="f" hidden={hidden} action="FORWARD" label="Forward to Disbursement Officer 1" />);
      break;
    case "DISBURSEMENT_CHECK":
      body.push(<p key="t" className="small muted">Check the full pack in the Documents tab before confirming.</p>);
      body.push(<CrmsOkay key="o" hidden={hidden} />);
      break;
    case "DISBURSEMENT_CORRECTION":
      body.push(<UploadForm key="u" applicationId={app.id} categories={(UPLOADABLE_BY_STAGE.DISBURSEMENT_CORRECTION ?? []).map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))} />);
      body.push(<TaskButton key="r" hidden={hidden} action="RESUBMIT" label="Resubmit to Disbursement Officer 1" />);
      break;
    case "DISBURSEMENT_BOOKING":
      body.push(<BookingForm key="b" hidden={hidden} approved={koboToNairaString(Number(app.requested_amount_kobo))} defaultDate={lagosDate(new Date())} />);
      break;
    case "COMPLETION":
      body.push(<p key="t" className="small">Queues one closure email with the full document pack and transaction summary to Legal and Shariah Compliance, copying the initiator.</p>);
      body.push(<TaskButton key="c" hidden={hidden} action="COMPLETE_PROCESS" label="Complete Process" confirm="Complete the process and send the closure pack to Legal and Shariah Compliance?" />);
      break;
    case "VENDOR_CONFIRMATION":
      body.push(<p key="t" className="small">Confirm the vendor has been paid. This closes the request and activates repayment prompts.</p>);
      body.push(<TaskButton key="v" hidden={hidden} action="CONFIRM_VENDOR_PAYMENT" label="Confirm vendor payment and end of process" confirm="Confirm vendor payment and close this request?" />);
      break;
  }

  // Reason-required secondary actions
  const reasonActions: [TaskAction, string, boolean][] = [
    ["RETURN", stage === "CO3_PACK_REVIEW" ? "Return pack to initiator" : "Return for correction", false],
    ["REQUEST_INITIATOR", "Request documents from initiator", false],
    ["SEND_FOR_CORRECTION", "Send for Correction", false],
    ["REJECT", "Reject", true],
  ];
  const secondary = reasonActions.filter(([a]) => actions.includes(a));

  return (
    <div className="card action-panel">
      <h2>
        <span className="badge badge-dark">Your action</span> {STAGE_LABELS[stage]}
      </h2>
      <p className="small muted" style={{ marginTop: -4 }}>
        As {ROLE_LABELS[task.assignee_role as Role]} · assigned {formatLagos(task.assigned_at)}
      </p>
      <div className="stack">{body}</div>
      {secondary.length > 0 && (
        <>
          <hr />
          <div className="stack">
            {secondary.map(([a, label, danger]) => (
              <ReasonButton key={a} hidden={hidden} action={a} label={label} danger={danger} />
            ))}
          </div>
        </>
      )}
      {stage === "DRAFT" && requiredSubmissionDocuments(app.applicant_type).length > 0 && null}
    </div>
  );
}
