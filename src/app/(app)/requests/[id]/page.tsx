import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, Circle, Download, Eye, FileText, Mail, X } from "lucide-react";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { getCase } from "@/server/domain/views";
import { signDocumentLink, CATEGORY_LABEL, DOC_CATEGORIES, UPLOADABLE_BY_STAGE, PACK, type DocumentRow } from "@/server/domain/documents";
import { STAGE_LABELS, ACTION_LABELS, allowedActions, type Stage, type TaskAction } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { APPLICANT_TYPE_LABELS, assetCostKobo, type DraftData } from "@/server/domain/application-data";
import { getRoute } from "@/server/domain/routing";
import { activeCalculator, calculatorKey, findCalculator } from "@/server/domain/apr/registry";
import { REMINDER_MIN_AGE_MS } from "@/server/domain/workflow";
import { formatKobo, koboToNairaString } from "@/server/money";
import { formatDateOnly, formatDuration, formatLagos, lagosDate } from "@/server/time";
import { maskWithLast4 } from "@/server/mask";
import { config } from "@/server/config";
import { StageChip, OutcomeChip } from "@/components/Status";
import { activeTemplate } from "@/server/domain/offer";
import { PricingAssessment, ThresholdChip, pricingOf } from "@/components/PricingAssessment";
import { bandLabels, e4ToPercent, pricingSettingsAt } from "@/server/domain/pricing";

/** The booked schedule uses a different frequency from the monthly assessment → label as monthly equivalent. */
function monthlyEquivalent(c: { instalments: unknown[]; assessment: { inputs: unknown } | null }) {
  const tenor = Number((c.assessment?.inputs as { tenorMonths?: number } | undefined)?.tenorMonths ?? 0);
  return c.instalments.length > 0 && c.instalments.length !== tenor;
}
import { UploadPanel } from "@/components/UploadPanel";
import { AssessmentForm, BookingForm, CrmsOkay, FirstReviewApprove, GenerateOffer, ReasonButton, ReminderButton, RevealIdentifiers, TaskButton } from "./CaseClient";

type Case = Awaited<ReturnType<typeof getCase>>;
type SP = Record<string, string | undefined>;
const ic = { className: "icon", "aria-hidden": true } as const;

export const metadata = { title: "Request" };

const TABS = [
  ["overview", "Overview"],
  ["documents", "Documents"],
  ["assessment", "Assessment"],
  ["activity", "Activity"],
] as const;
const TAB_ALIASES: Record<string, string> = { summary: "overview", history: "activity", audit: "activity" };

/** Milestones for the progress timeline (presentation only; maps existing stages). */
const MILESTONES: { label: string; stages: Stage[] }[] = [
  { label: "Initiation", stages: ["DRAFT", "INITIATOR_CORRECTION"] },
  { label: "Business endorsement", stages: ["BUSINESS_ENDORSEMENT"] },
  { label: "Credit review", stages: ["FIRST_CREDIT_REVIEW", "CREDIT_CORRECTION", "SECOND_CREDIT_REVIEW"] },
  { label: "Approvals", stages: ["UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW"] },
  { label: "Offer & insurance", stages: ["OFFER_PREPARATION", "CO3_PACK_REVIEW"] },
  { label: "Disbursement", stages: ["DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION", "DISBURSEMENT_BOOKING"] },
  { label: "Closure", stages: ["COMPLETION", "VENDOR_CONFIRMATION", "CLOSED"] },
];
function milestoneIndex(stage: Stage) {
  return MILESTONES.findIndex((m) => m.stages.includes(stage));
}

const OUTPUT_LABELS: Record<string, string> = {
  facilityType: "Facility type",
  rateType: "Rate type",
  totalNumberOfPayments: "Total number of payments (N)",
  paymentsPerYear: "Payments per year (n)",
  periodicInstalmentKobo: "Periodic instalment",
  monthlyEquivalentInstalmentKobo: "Monthly-equivalent instalment (for DSR)",
  totalMarkupKobo: "Total mark-up",
  takafulKobo: "Takaful contribution",
  stampDutyKobo: "Stamp duty",
  totalFeesKobo: "Total fees and charges",
  costOfFacilityKobo: "Cost of facility (c)",
  totalPaymentKobo: "Total amount payable",
  aprPercent: "APR (%)",
  dsrPercent: "DSR (%)",
  markupKobo: "Mark-up",
  costPlusMarkupKobo: "Cost plus mark-up",
  aprFormula: "APR formula",
  dsrFormula: "DSR formula",
  amountApprovedKobo: "Amount approved (L)",
  markupRatePercent: "Mark-up / rental rate (% p.a.)",
  frequency: "Instalment frequency",
  tenorMonths: "Tenor (months)",
  takafulPercent: "Takaful (%)",
  stampDutyPercent: "Stamp duty (%)",
  adminFeePercent: "Administrative fee (%)",
  averageMonthlyInflowKobo: "Average monthly inflow",
  existingMonthlyObligationsKobo: "Existing monthly obligations",
};
const showVal = (k: string, v: unknown) => (k.endsWith("Kobo") ? formatKobo(Number(v)) : String(v));

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
        <div className="card" role="alert" style={{ maxWidth: 560 }}>
          <h1>Access denied</h1>
          <p className="muted">Request details and documents are visible only to officers authorised on this request. This attempt was recorded in the audit trail.</p>
          <Link className="btn btn-primary" href="/queue">
            My Action Queue
          </Link>
        </div>
      );
    throw e;
  }
  const app = c.app;
  const myTask = c.openTask && c.openTask.assignee_id === session.staffId && roles.includes(c.openTask.assignee_role) ? c.openTask : null;
  const rawTab = sp.tab ? TAB_ALIASES[sp.tab] ?? sp.tab : "overview";
  const tab = (TABS.find(([k]) => k === rawTab)?.[0] ?? "overview") as (typeof TABS)[number][0];
  const previewDoc = sp.doc ? c.documents.find((d) => d.id === sp.doc) ?? null : null;
  const link = (docId: string, mode: "view" | "download") => signDocumentLink(docId, session.staffId, session.sessionId, mode);
  const tabHref = (t: string, extra: SP = {}) => {
    const q = new URLSearchParams(Object.entries({ task: sp.task, tab: t, ...extra }).filter(([, v]) => v) as [string, string][]);
    return `/requests/${id}?${q.toString()}`;
  };
  const doneHref = `/requests/${id}?done=1`;
  const data: DraftData | null = c.version?.data ?? c.working?.data ?? null;
  const isInitiator = app.initiator_id === session.staffId;
  const waited = c.openTask?.assigned_at ? Date.now() - new Date(c.openTask.assigned_at).getTime() : 0;
  const staleDeepLink = sp.task && (!myTask || myTask.id !== sp.task);
  // Committed result of the officer's last action (read back from the database, not from the URL).
  const committed = sp.done
    ? (await db.query(`SELECT d.action, d.created_at, d.stage FROM decisions d WHERE d.application_id = $1 AND d.actor_id = $2 ORDER BY d.seq DESC LIMIT 1`, [id, session.staffId])).rows[0]
    : null;
  const current = milestoneIndex(app.stage as Stage);
  const rejectedAt = app.stage === "REJECTED" ? milestoneIndex((c.tasks.at(-1)?.stage ?? "BUSINESS_ENDORSEMENT") as Stage) : -1;

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs" style={{ marginBottom: 8 }}>
        <Link href="/queue">My Action Queue</Link>
        <span aria-hidden="true">/</span>
        {isInitiator && (
          <>
            <Link href="/requests">View Progress</Link>
            <span aria-hidden="true">/</span>
          </>
        )}
        <span aria-current="page">{app.ref}</span>
      </nav>
      <div className="case-head">
        <div style={{ minWidth: 0 }}>
          <div className="case-title">
            <h1>{app.ref}</h1>
            <StageChip stage={app.stage as Stage} status={app.status} />
            {app.route && <span className="badge badge-blue">Route {app.route}</span>}
          </div>
          <dl className="case-facts">
            <div>
              <dt>Customer</dt>
              <dd>{app.customer_name || "Draft"}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd className="tnum">{formatKobo(app.requested_amount_kobo)}</dd>
            </div>
            <div>
              <dt>Applicant</dt>
              <dd>{APPLICANT_TYPE_LABELS[app.applicant_type as keyof typeof APPLICANT_TYPE_LABELS]}</dd>
            </div>
            <div>
              <dt>Current owner</dt>
              <dd>
                {c.openTask ? (c.openTask.assignee_name ?? <span style={{ color: "var(--danger)" }}>No eligible assignee (escalated)</span>) : "—"}
                {c.openTask?.assigned_at && <span className="small muted"> · {formatDuration(waited)}</span>}
              </dd>
            </div>
          </dl>
        </div>
        <div className="row">
          {isInitiator && c.openTask?.assignee_id && c.openTask.assignee_id !== session.staffId && waited > REMINDER_MIN_AGE_MS && <ReminderButton applicationId={app.id} />}
          {isInitiator && (app.stage === "DRAFT" || (myTask && myTask.stage === "INITIATOR_CORRECTION")) && (
            <Link className="btn btn-primary" href={`/requests/${app.id}/edit`}>
              {app.stage === "DRAFT" ? "Continue draft" : "Edit and resubmit"}
            </Link>
          )}
        </div>
      </div>

      <ol className="progress" aria-label="Request progress">
        {MILESTONES.map((m, i) => {
          const state = app.stage === "REJECTED" ? (i < rejectedAt ? "done" : i === rejectedAt ? "stopped" : "") : app.stage === "CLOSED" ? "done" : i < current ? "done" : i === current ? "current" : "";
          return (
            <li key={m.label} className={state} aria-current={state === "current" ? "step" : undefined}>
              {m.label}
              <span className="sr-only">{state === "done" ? " (complete)" : state === "current" ? " (current)" : state === "stopped" ? " (rejected here)" : " (not started)"}</span>
            </li>
          );
        })}
      </ol>

      {committed && (
        <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>
          <CheckCircle2 {...ic} />
          <span>
            Recorded: <strong>{ACTION_LABELS[committed.action as TaskAction] ?? committed.action}</strong> at {STAGE_LABELS[committed.stage as Stage]}, {formatLagos(committed.created_at)}. The request is now <strong>{STAGE_LABELS[app.stage as Stage]}</strong>
            {c.openTask ? ` with ${c.openTask.assignee_name ?? "the Super Admin for assignment"}.` : "."}
          </span>
        </div>
      )}
      {sp.submitted && (
        <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>
          <CheckCircle2 {...ic} />
          Submitted. The request is with {c.openTask?.assignee_name ?? "the Super Admin for assignment"} for {STAGE_LABELS[app.stage as Stage].toLowerCase()}.
        </div>
      )}
      {staleDeepLink && (
        <div className="alert alert-info" role="status" style={{ marginBottom: 12 }}>
          <AlertTriangle {...ic} />
          The task in this link is no longer awaiting your action (it was actioned or reassigned). You can still view the request.
        </div>
      )}

      <div className={`split ${previewDoc ? "wide-preview" : ""}`}>
        <section aria-label="Request details" style={{ minWidth: 0 }}>
          <nav className="tabs" aria-label="Request sections">
            {TABS.map(([k, label]) => (
              <Link key={k} className="tab" href={tabHref(k)} aria-current={tab === k ? "page" : undefined}>
                {label}
                {k === "documents" ? <span className="badge">{c.documents.filter((d) => !d.superseded_at).length}</span> : null}
              </Link>
            ))}
          </nav>
          {tab === "overview" && <Overview c={c} data={data} />}
          {tab === "documents" && <Documents c={c} link={link} tabHref={tabHref} previewId={previewDoc?.id ?? null} myTask={myTask} isInitiator={isInitiator} />}
          {tab === "assessment" && <Assessment c={c} />}
          {tab === "activity" && (
            <>
              <History c={c} />
              <CaseAudit appId={app.id} />
            </>
          )}
        </section>
        <aside className="split-right" aria-label="Actions and preview">
          {myTask && <ActionPanel c={c} task={myTask} data={data} doneHref={doneHref} />}
          {!myTask && c.openTask && (
            <div className="card">
              <p className="eyebrow">Current step</p>
              <h2 style={{ marginBottom: 4 }}>{STAGE_LABELS[c.openTask.stage as Stage]}</h2>
              <p className="small" style={{ margin: 0 }}>
                {c.openTask.required_action}
              </p>
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                Owner: {c.openTask.assignee_name ?? "awaiting assignment by the Super Admin"} ({ROLE_LABELS[c.openTask.assignee_role as Role]})
                {c.openTask.assigned_at && ` · since ${formatLagos(c.openTask.assigned_at)}`}
              </p>
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                You can view this request and its documents. Actions are available only to the assigned officer.
              </p>
            </div>
          )}
          {!c.openTask && <ClosureCard c={c} compact />}
          {previewDoc && <Preview doc={previewDoc} link={link} closeHref={tabHref("documents")} />}
        </aside>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ c, data }: { c: Case; data: DraftData | null }) {
  const app = c.app;
  const route = getRoute(app.route);
  const name = (id: string | null) => (id ? c.people[id] ?? "—" : "—");
  return (
    <div className="stack">
      {c.assessment && pricingOf(c.assessment.outputs) && (() => {
        const p = pricingOf(c.assessment.outputs)!.pricing;
        return (
          <div className="metric-grid" aria-label="Credit assessment summary">
            <div className="metric"><div className="k">Turnover used / month</div><div className="v">{formatKobo(p.turnover.monthlyTurnoverUsedKobo)}</div></div>
            <div className="metric"><div className="k">Monthly repayment{monthlyEquivalent(c) ? " (equiv.)" : ""}</div><div className="v">{formatKobo(p.facility.monthlyRepaymentKobo)}</div></div>
            <div className="metric"><div className="k">Total DSR (threshold {p.capacity.thresholdPercent}%)</div><div className="v">{p.capacity.totalDsrPercent}%</div><ThresholdChip result={p.capacity.result} excessKobo={p.capacity.excessKobo} /></div>
            <div className="metric"><div className="k">Flat markup · APR</div><div className="v">{p.facility.flatMarkupRatePercent}% · {Number(c.assessment.apr_percent).toFixed(2)}%</div></div>
          </div>
        );
      })()}
      {c.assessment && !pricingOf(c.assessment.outputs) && (
        <div className="metric-grid" aria-label="Credit assessment summary">
          <div className="metric"><div className="k">APR</div><div className="v">{c.assessment.apr_percent}%</div></div>
          <div className="metric"><div className="k">DSR</div><div className="v">{c.assessment.dsr_percent}%</div></div>
          <div className="metric"><div className="k">Mark-up</div><div className="v">{formatKobo(c.assessment.markup_kobo)}</div></div>
          <div className="metric"><div className="k">Cost plus mark-up</div><div className="v">{formatKobo(c.assessment.cost_plus_markup_kobo)}</div></div>
        </div>
      )}
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
          <h2>Facility</h2>
          <table className="kv">
            <tbody>
              <tr><th>Requested amount</th><td className="tnum"><strong>{formatKobo(data.requestedAmountKobo)}</strong></td></tr>
              <tr><th>Tenor</th><td>{data.tenorMonths ? `${data.tenorMonths} months` : "—"}</td></tr>
              <tr><th>DAO code</th><td className="mono">{data.daoCode || "—"}</td></tr>
              <tr><th>POS serial number</th><td className="mono">{data.posSerial || "—"}</td></tr>
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
      {data && (
        <div className="card">
          <h2>Vendor</h2>
          <table className="kv">
            <tbody>
              <tr><th>Supplier</th><td>{data.supplierName || "—"}</td></tr>
              <tr><th>Address / phone</th><td>{[data.supplierAddress, data.supplierPhone].filter(Boolean).join(" · ") || "—"}</td></tr>
              <tr><th>Account for vendor payment</th><td className="mono">{data.supplierAccount || "—"}</td></tr>
              <tr><th>Invoice reference</th><td className="mono">{data.invoiceRef || "—"}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <h2>Routing and officers</h2>
        <table className="kv">
          <tbody>
            <tr><th>Initiator</th><td>{name(app.initiator_id)} ({ROLE_LABELS[app.initiator_role as Role]}{app.region ? `, ${app.region}` : ""})</td></tr>
            {app.selected_rbe_id && <tr><th>Selected RBE</th><td>{name(app.selected_rbe_id)}</td></tr>}
            <tr><th>Business endorsement</th><td>{name(app.endorser_id)}</td></tr>
            <tr><th>Credit route</th><td>{route ? route.label : "Set after business endorsement"}</td></tr>
            <tr><th>First credit reviewer</th><td>{name(app.first_reviewer_id)}</td></tr>
            <tr><th>Second credit reviewer</th><td>{name(app.second_reviewer_id)}</td></tr>
            <tr><th>Credit Officer 3 (pack)</th><td>{name(app.pack_co3_id)}</td></tr>
            <tr><th>Disbursement officers 1 / 2</th><td>{name(app.do1_id)} / {name(app.do2_id)}</td></tr>
          </tbody>
        </table>
      </div>
      {(c.disbursement || app.status === "CLOSED") && <ClosureCard c={c} />}
    </div>
  );
}

/** Disbursed → Awaiting Vendor Payment Confirmation → Closed, with actor, time and notification status. */
function ClosureCard({ c, compact = false }: { c: Case; compact?: boolean }) {
  const app = c.app;
  if (!c.disbursement) {
    if (app.stage === "REJECTED")
      return (
        <div className="card">
          <p className="eyebrow">Outcome</p>
          <StageChip stage="REJECTED" />
          <p className="small muted" style={{ margin: "8px 0 0" }}>Rejected {formatLagos(app.rejected_at)}. See Activity for the reason.</p>
        </div>
      );
    return null;
  }
  const name = (id: string | null) => (id ? c.people[id] ?? "—" : "—");
  const step = (done: boolean, label: string, detail: React.ReactNode) => (
    <li>
      <span className={`tick ${done ? "ok" : "no"}`} aria-hidden="true">
        {done ? <CheckCircle2 className="icon" /> : <Circle className="icon" />}
      </span>
      <span>
        <strong>{label}</strong>
        <div className="small muted">{detail}</div>
      </span>
      <span className="sr-only">{done ? "(done)" : "(pending)"}</span>
    </li>
  );
  const d = c.disbursement;
  return (
    <div className="card">
      <h2>Booking and closure</h2>
      <ul className="checklist" style={{ marginBottom: 12 }}>
        {step(true, "Disbursed", `${formatKobo(d.amount_kobo)} on ${formatDateOnly(d.disbursed_on)} · ref ${d.transaction_ref} · recorded by ${d.recorded_by_name}, ${formatLagos(d.recorded_at)}`)}
        {step(!!app.process_completed_at, "Process completed (Credit Officer 3)", app.process_completed_at ? `${name(app.process_completed_by)}, ${formatLagos(app.process_completed_at)}` : "Pending")}
        {step(!!app.vendor_confirmed_at, app.vendor_confirmed_at ? "Vendor payment confirmed" : "Awaiting Vendor Payment Confirmation", app.vendor_confirmed_at ? `${name(app.vendor_confirmed_by)}, ${formatLagos(app.vendor_confirmed_at)}` : "Initiator confirms after Credit Officer 3 completes the process")}
        {step(app.status === "CLOSED", "Closed", app.closed_at ? `${formatLagos(app.closed_at)} · repayment prompts active` : "After vendor payment confirmation")}
      </ul>
      {c.closure && (
        <p className="small" style={{ margin: "0 0 8px" }}>
          <Mail className="icon" aria-hidden="true" /> Closure pack to Legal and Shariah Compliance ({c.closure.delivery_mode === "ATTACHMENTS" ? "attachments" : "secure link"}):{" "}
          <span className={`badge ${c.closure.delivery_status === "SENT" ? "badge-green" : c.closure.delivery_status === "DEAD" || c.closure.delivery_status === "FAILED" ? "badge-red" : "badge-warn"}`}>
            {c.closure.delivery_status === "SENT" ? "Delivered" : c.closure.delivery_status === "FAILED" ? "Retrying" : c.closure.delivery_status === "DEAD" ? "Failed - admin retry needed" : "Queued"}
          </span>
          {c.closure.attempts > 0 && <span className="muted"> · {c.closure.attempts} attempt(s)</span>}
        </p>
      )}
      {!compact && (
        <table className="kv">
          <tbody>
            <tr><th>Approved / disbursed</th><td className="tnum">{formatKobo(d.approved_amount_kobo)} / <strong>{formatKobo(d.amount_kobo)}</strong></td></tr>
            <tr><th>Repayment schedule</th><td>{c.instalments.map((i: { seq: number; due_date: string; amount_kobo: string }) => <div key={i.seq} className="tnum">{formatDateOnly(i.due_date)} · {formatKobo(i.amount_kobo)}</div>)}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ documents

function docStatus(d: DocumentRow) {
  if (d.scan_status === "QUARANTINED") return <span className="badge badge-warn"><AlertTriangle className="icon" aria-hidden="true" />Quarantined</span>;
  if (d.scan_status === "REJECTED") return <span className="badge badge-red"><X className="icon" aria-hidden="true" />Rejected by scan</span>;
  if (d.superseded_at) return <span className="badge">Superseded</span>;
  return <span className="badge badge-green"><CheckCircle2 className="icon" aria-hidden="true" />Current</span>;
}

function Documents({ c, link, tabHref, previewId, myTask, isInitiator }: { c: Case; link: (id: string, m: "view" | "download") => string; tabHref: (t: string, e?: SP) => string; previewId: string | null; myTask: Case["openTask"]; isInitiator: boolean }) {
  const stage = c.app.stage as Stage;
  const uploadStage = myTask ? (myTask.stage as Stage) : isInitiator && stage === "DRAFT" ? "DRAFT" : null;
  const cats = uploadStage ? (UPLOADABLE_BY_STAGE[uploadStage] ?? []).filter((x) => !(c.app.applicant_type === "INDIVIDUAL" && x === "CAC_CERTIFICATE")) : [];
  const current = c.documents.filter((d) => !d.superseded_at && d.scan_status !== "REJECTED");
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data responsive">
          <caption className="sr-only">All documents retained on this request</caption>
          <thead>
            <tr><th>Category and file</th><th>Uploaded</th><th>Version</th><th><span className="sr-only">Open</span></th></tr>
          </thead>
          <tbody>
            {c.documents.length === 0 && <tr><td colSpan={4} className="empty"><FileText {...ic} />No documents yet.</td></tr>}
            {c.documents.map((d) => (
              <tr key={d.id} className={previewId === d.id ? "selected-row" : undefined}>
                <td className="small" data-label="Document" style={{ minWidth: 200 }}>
                  <strong>{CATEGORY_LABEL[d.category] ?? d.category}</strong>
                  <div style={{ wordBreak: "break-all" }}>{d.filename} <span className="muted">· {(Number(d.size_bytes) / 1024).toFixed(0)} KB</span></div>
                  {d.generated && <span className="badge badge-blue">Generated · template v{d.template_version}</span>}
                </td>
                <td className="small" data-label="Uploaded" style={{ minWidth: 150 }}>
                  {d.uploader_name}
                  <div className="muted">{d.uploaded_role ? ROLE_LABELS[d.uploaded_role as Role] ?? d.uploaded_role : ""}</div>
                  <div className="muted nowrap">{formatLagos(d.uploaded_at)}</div>
                </td>
                <td className="small" data-label="Version">
                  <div>v{d.version_no}</div>
                  {docStatus(d)}
                </td>
                <td className="row-actions">
                  {d.scan_status === "CLEAN" && !d.purged_at ? (
                    <div className="row">
                      <Link className="btn btn-sm" href={tabHref("documents", { doc: d.id })} aria-label={`Preview ${d.filename} version ${d.version_no}`}><Eye {...ic} />Preview</Link>
                      <a className="btn btn-sm" href={link(d.id, "download")} aria-label={`Download ${d.filename} version ${d.version_no}`}><Download {...ic} />Download</a>
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
        Every officer authorised on this request can view and download all retained versions. Links expire after 5 minutes; every view and download is audited.
      </p>
      {cats.length > 0 && (
        <UploadPanel
          applicationId={c.app.id}
          categories={cats.map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))}
          replaces={current.filter((d) => cats.includes(d.category) && DOC_CATEGORIES.find((k) => k.code === d.category)?.multiple).map((d) => ({ id: d.id, label: `${CATEGORY_LABEL[d.category]}: ${d.filename} (v${d.version_no})` }))}
        />
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
        <h2 style={{ fontSize: "0.95rem" }}>
          {CATEGORY_LABEL[doc.category]} · v{doc.version_no} {doc.superseded_at && <span className="badge">Superseded</span>}
        </h2>
        <div className="row">
          <a className="btn btn-sm" href={link(doc.id, "download")}><Download {...ic} />Download</a>
          <Link className="btn btn-sm btn-ghost" href={closeHref} aria-label="Close preview"><X {...ic} /></Link>
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
  if (!c.assessments.length)
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>The APR / DSR assessment is pending. The first credit reviewer completes it.</p>
      </div>
    );
  return (
    <div className="stack">
      {c.assessments.map((a: Case["assessments"][number]) => {
        const calc = findCalculator(`${a.calculator_id}@${a.calculator_version}`);
        const versionNo = c.versions.find((v: { id: string }) => v.id === a.version_id)?.version_no ?? "?";
        return (
          <div className="card" key={a.id}>
            <div className="card-head">
              <h2>{a.superseded_at ? "Superseded assessment" : "Current assessment"}</h2>
              <span className={`badge ${a.superseded_at ? "" : "badge-green"}`}>{a.calculator_id}@{a.calculator_version} · application v{versionNo}</span>
            </div>
            {pricingOf(a.outputs) ? (
              <PricingAssessment outputs={a.outputs} monthlyEquivalent={monthlyEquivalent(c)} />
            ) : (
            <div className="metric-grid" style={{ marginBottom: 12 }}>
              <div className="metric"><div className="k">APR</div><div className="v">{a.apr_percent}%</div></div>
              <div className="metric"><div className="k">DSR</div><div className="v">{a.dsr_percent}%</div></div>
              <div className="metric"><div className="k">Mark-up</div><div className="v">{formatKobo(a.markup_kobo)}</div></div>
              <div className="metric"><div className="k">Cost plus mark-up</div><div className="v">{formatKobo(a.cost_plus_markup_kobo)}</div></div>
            </div>
            )}
            {calc?.validationNote && (
              <p className="blocked" style={{ margin: "0 0 12px" }}>
                <AlertTriangle {...ic} />
                {calc.validationNote}
              </p>
            )}
            {!pricingOf(a.outputs) && (
            <div className="grid-2">
              <div>
                <h3>Inputs</h3>
                <table className="kv"><tbody>
                  {Object.entries(a.inputs as Record<string, string | number>).map(([k, v]) => (
                    <tr key={k}><th>{OUTPUT_LABELS[k] ?? k}</th><td className="tnum">{showVal(k, v)}</td></tr>
                  ))}
                </tbody></table>
              </div>
              <div>
                <h3>Outputs</h3>
                <table className="kv"><tbody>
                  {Object.entries(a.outputs as Record<string, string | number>).map(([k, v]) => (
                    <tr key={k}><th>{OUTPUT_LABELS[k] ?? k}</th><td className="tnum">{showVal(k, v)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            </div>
            )}
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              Assessor: {a.assessor_name} · started {formatLagos(a.started_at)} · saved {formatLagos(a.created_at)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ activity

function History({ c }: { c: Case }) {
  const decisionByTask = new Map(c.decisions.map((d: { task_id: string }) => [d.task_id, d]));
  return (
    <div className="stack" style={{ marginBottom: 16 }}>
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
                  {t.status === "OPEN" ? <span className="badge badge-yellow">Current</span> : d ? <span className={`badge ${d.action === "REJECT" ? "badge-red" : ["RETURN", "REQUEST_INITIATOR", "SEND_FOR_CORRECTION"].includes(d.action) ? "badge-warn" : "badge-green"}`}>{ACTION_LABELS[d.action as TaskAction] ?? d.action}</span> : null}
                  {d?.invalidated_at && <span className="badge badge-red" title={d.invalidated_reason}><AlertTriangle className="icon" aria-hidden="true" />Invalidated</span>}
                </div>
                <div className="small">{t.assignee_name ?? "Unassigned"} · {ROLE_LABELS[t.assignee_role as Role] ?? t.assignee_role}</div>
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
          <div className="table-wrap"><table className="data responsive"><thead><tr><th>Requested</th><th>From</th><th>To</th><th>Reason</th><th>Resolution</th></tr></thead><tbody>
            {c.corrections.map((x: Case["corrections"][number]) => (
              <tr key={x.id}><td className="small nowrap" data-label="Requested">{formatLagos(x.created_at)}<div className="muted">{x.requested_by_name}</div></td><td className="small" data-label="From">{STAGE_LABELS[x.from_stage as Stage]}</td><td className="small" data-label="To">{STAGE_LABELS[x.to_stage as Stage]}</td><td className="small" data-label="Reason">{x.reason}</td><td className="small" data-label="Resolution">{x.resolution ?? "Open"}{x.resolved_at && <div className="muted">{formatLagos(x.resolved_at)}</div>}</td></tr>
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
    <div className="card">
      <h2>Audit trail</h2>
      <div className="table-wrap">
        <table className="data responsive">
          <caption className="sr-only">Audit trail for this request</caption>
          <thead><tr><th>Time</th><th>Actor</th><th>Role</th><th>Action</th><th>Outcome</th><th>Stage</th><th>Reason</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="small nowrap" data-label="Time">{formatLagos(r.occurred_at)}</td>
                <td className="small" data-label="Actor">{r.full_name ?? "System"}</td>
                <td className="small" data-label="Role">{r.actor_role ? ROLE_LABELS[r.actor_role as Role] ?? r.actor_role : "—"}</td>
                <td className="small mono" data-label="Action">{r.action}{r.document_version ? ` (v${r.document_version})` : ""}</td>
                <td data-label="Outcome"><OutcomeChip outcome={r.outcome} /></td>
                <td className="small" data-label="Stage">{r.stage ? STAGE_LABELS[r.stage as Stage] ?? r.stage : "—"}</td>
                <td className="small" data-label="Reason">{r.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: "8px 0 0" }}>Client IP and device metadata are shown to the Super Admin in the audit trail.</p>
    </div>
  );
}

// ------------------------------------------------------------------ action panel

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li>
      <span className={`tick ${ok ? "ok" : "no"}`} aria-hidden="true">{ok ? <CheckCircle2 className="icon" /> : <Circle className="icon" />}</span>
      <span>{children}</span>
      <span className="sr-only">{ok ? "(done)" : "(outstanding)"}</span>
    </li>
  );
}
function Blocked({ children }: { children: React.ReactNode }) {
  return (
    <p className="blocked" style={{ margin: 0 }}>
      <AlertTriangle className="icon" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

async function ActionPanel({ c, task, data, doneHref }: { c: Case; task: NonNullable<Case["openTask"]>; data: DraftData | null; doneHref: string }) {
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
  const settings = await pricingSettingsAt(db, new Date());
  const usedSettings = c.assessment ? pricingOf(c.assessment.outputs)?.pricing.settings : undefined;
  const stale = calc.usesPricingSettings && usedSettings && usedSettings.id !== settings.id ? { used: usedSettings.version } : null;
  const isDo1 = stage === "DISBURSEMENT_CHECK";
  const isDo2 = stage === "DISBURSEMENT_BOOKING";

  const body: React.ReactNode[] = [];
  if (openCorrection && ["CREDIT_CORRECTION", "INITIATOR_CORRECTION", "DISBURSEMENT_CORRECTION", "OFFER_PREPARATION"].includes(stage)) {
    body.push(
      <div key="corr" className="alert alert-warn">
        <AlertTriangle className="icon" aria-hidden="true" />
        <span>
          <strong>Correction requested</strong> by {openCorrection.requested_by_name}: {openCorrection.reason}
        </span>
      </div>,
    );
  }

  switch (stage) {
    case "BUSINESS_ENDORSEMENT":
      body.push(<p key="t" className="small muted" style={{ margin: 0 }}>Business endorsement must be approved before credit routing. Review the Overview and Documents.</p>);
      body.push(<TaskButton key="e" hidden={hidden} action="ENDORSE" label="Endorse" doneHref={doneHref} />);
      break;
    case "FIRST_CREDIT_REVIEW":
    case "CREDIT_CORRECTION": {
      const vals = (k: string, defaultFrom?: string, defaultValue?: string) => {
        const prev = c.assessment && c.assessment.calculator_id === calc.id ? (c.assessment.inputs as Record<string, string | number>) : undefined;
        if (prev && prev[k] !== undefined) return k.endsWith("Kobo") ? koboToNairaString(Number(prev[k])) : String(prev[k]);
        if (defaultFrom === "assetCost" && data) return koboToNairaString(assetCostKobo(data.items));
        if (defaultFrom === "requestedAmount" && app.requested_amount_kobo) return koboToNairaString(Number(app.requested_amount_kobo));
        if (defaultFrom === "tenorMonths" && data?.tenorMonths) return String(data.tenorMonths);
        return defaultValue ?? "";
      };
      body.push(
        <ul key="cl" className="checklist">
          <Check ok={reports >= 3}>Three credit reports uploaded ({reports}/3)</Check>
          <Check ok={assessmentCurrent && !stale}>DSR and pricing assessment saved for application v{c.versions.find((v: { id: string }) => v.id === app.current_version_id)?.version_no ?? "—"}{c.assessment && assessmentCurrent && pricingOf(c.assessment.outputs) ? `: Total DSR ${pricingOf(c.assessment.outputs)!.pricing.capacity.totalDsrPercent}%` : ""}</Check>
          {stage === "FIRST_CREDIT_REVIEW" && <Check ok={false}>“Logged invoice on invoice portal” confirmed at approval</Check>}
        </ul>,
      );
      if (stale && c.assessment)
        body.push(
          <Blocked key="stale">
            Pricing settings changed since this assessment (used v{stale.used}; now v{settings.version}: {bandLabels(settings).short} {e4ToPercent(settings.shortRateE4)}%, {bandLabels(settings).long} {e4ToPercent(settings.longRateE4)}%, maximum tenor {settings.maxTenorMonths} months). Recalculate before approval.
          </Blocked>,
        );
      if (c.assessment && pricingOf(c.assessment.outputs))
        body.push(
          <details key="res" open>
            <summary className="small" style={{ fontWeight: 700, cursor: "pointer" }}>Saved assessment</summary>
            <div style={{ marginTop: 8 }}><PricingAssessment outputs={c.assessment.outputs} compact /></div>
          </details>,
        );
      body.push(
        <details key="up" open={reports < 3}>
          <summary className="small" style={{ fontWeight: 700, cursor: "pointer" }}>Credit reports ({reports}/3)</summary>
          <div style={{ marginTop: 8 }}>
            <UploadPanel compact applicationId={app.id} title="Upload credit report or DSR evidence" categories={[{ code: "CREDIT_REPORT", label: "Credit report" }, { code: "DSR_EXCEPTION_EVIDENCE", label: CATEGORY_LABEL.DSR_EXCEPTION_EVIDENCE }, { code: "SUPPORTING", label: "Other supporting document" }]} />
          </div>
        </details>,
      );
      body.push(
        <details key="calc" open={!assessmentCurrent}>
          <summary className="small" style={{ fontWeight: 700, cursor: "pointer" }}>DSR and pricing calculator · {calculatorKey(calc)}</summary>
          <div style={{ marginTop: 8 }} className="stack">
            {!calc.productionValidated && (
              <Blocked>
                {calc.validationNote ?? "This calculator is not validated for production."} {config.isProduction ? "Credit approval is blocked in production." : "Approvals are allowed in this development environment only."}
              </Blocked>
            )}
            {calc.usesPricingSettings && (
              <p className="small muted" style={{ margin: 0 }}>
                Applies pricing settings v{settings.version}: {bandLabels(settings).short} {e4ToPercent(settings.shortRateE4)}% flat, {bandLabels(settings).long} {e4ToPercent(settings.longRateE4)}% flat, applied once for the tenor; principal up to ₦50,000,000 (single obligation limit); DSR threshold {e4ToPercent(settings.thresholdE4)}%. Leave the verified monthly turnover blank to use annual ÷ 12.
              </p>
            )}
            <AssessmentForm
              applicationId={app.id}
              calculatorLabel={calc.label}
              fields={calc.fields.map((f) =>
                calc.usesPricingSettings && f.key === "tenorMonths"
                  ? { key: f.key, label: f.label, kind: "select", options: Array.from({ length: settings.maxTenorMonths }, (_, i) => ({ value: String(i + 1), label: `${i + 1} month${i ? "s" : ""} · ${i + 1 >= settings.longBandFromMonths ? e4ToPercent(settings.longRateE4) : e4ToPercent(settings.shortRateE4)}% flat` })), value: vals(f.key, f.defaultFrom, f.defaultValue) }
                  : { key: f.key, label: f.label, kind: f.kind, options: f.options, optional: f.optional, value: vals(f.key, f.defaultFrom, f.defaultValue) },
              )}
            />
          </div>
        </details>,
      );
      if (stage === "FIRST_CREDIT_REVIEW") {
        const pr = c.assessment ? pricingOf(c.assessment.outputs)?.pricing : null;
        body.push(
          <FirstReviewApprove
            key="ap"
            hidden={hidden}
            ready={reports >= 3 && assessmentCurrent && !stale}
            doneHref={doneHref}
            dsrExceeds={pr?.capacity.result === "EXCEEDS_THRESHOLD"}
            dsrEvidence={has("DSR_EXCEPTION_EVIDENCE")}
            dsrSummary={pr ? `Total DSR ${pr.capacity.totalDsrPercent}% exceeds the ${pr.capacity.thresholdPercent}% threshold by ${formatKobo(pr.capacity.excessKobo)} per month.` : undefined}
          />,
        );
      }
      else body.push(<TaskButton key="rs" hidden={hidden} action="RESUBMIT" label={`Resubmit to ${STAGE_LABELS[(openCorrection?.from_stage as Stage) ?? "UNIT_HEAD_REVIEW"]}`} doneHref={doneHref} />);
      break;
    }
    case "SECOND_CREDIT_REVIEW":
    case "UNIT_HEAD_REVIEW":
    case "DIVISIONAL_HEAD_REVIEW":
      body.push(
        c.assessment && pricingOf(c.assessment.outputs) ? (
          <div key="a" className="stack" style={{ gap: 8 }}>
            <PricingAssessment outputs={c.assessment.outputs} compact />
            <p className="small" style={{ margin: 0 }}>{pricingOf(c.assessment.outputs)!.explanation}</p>
            {(() => {
              const ex = c.decisions.filter((d: { stage: string; action: string; invalidated_at: Date | null; reason: string | null }) => d.stage === "FIRST_CREDIT_REVIEW" && d.action === "APPROVE" && !d.invalidated_at && d.reason?.startsWith("DSR exception:")).at(-1);
              return ex ? (
                <p className="blocked" style={{ margin: 0 }}>
                  <AlertTriangle className="icon" aria-hidden="true" />
                  <span>Approved at first credit review with a DSR exception by {ex.actor_name}: {String(ex.reason).replace(/^DSR exception: /, "")}. Evidence is in Documents (DSR exception evidence).</span>
                </p>
              ) : null;
            })()}
            <div className="small muted">APR (disclosure) {Number(c.assessment.apr_percent).toFixed(2)}% · {c.assessment.calculator_id}@{c.assessment.calculator_version} · assessed by {c.assessment.assessor_name} · full detail in Assessment</div>
          </div>
        ) : c.assessment ? (
          <div key="a" className="highlight small">
            APR <strong>{c.assessment.apr_percent}%</strong> · DSR <strong>{c.assessment.dsr_percent}%</strong> · Cost plus mark-up {formatKobo(c.assessment.cost_plus_markup_kobo)}
            <div className="muted">{c.assessment.calculator_id}@{c.assessment.calculator_version} · assessed by {c.assessment.assessor_name}</div>
          </div>
        ) : (
          <Blocked key="a">Assessment pending.</Blocked>
        ),
      );
      if (actions.includes("PROCEED")) body.push(<TaskButton key="p" hidden={hidden} action="PROCEED" label="Proceed" doneHref={doneHref} />);
      if (actions.includes("APPROVE")) body.push(<TaskButton key="p" hidden={hidden} action="APPROVE" label="Approve" doneHref={doneHref} />);
      if (stage === "DIVISIONAL_HEAD_REVIEW") body.push(<p key="n" className="small muted" style={{ margin: 0 }}>Approval assigns the initiator to prepare the signed offer pack.</p>);
      break;
    case "INITIATOR_CORRECTION":
      body.push(<p key="t" className="small" style={{ margin: 0 }}>Update the request or replace documents, then resubmit. Changes to underwriting fields (amount, tenor, items, identifiers) require a fresh credit review.</p>);
      body.push(<Link key="l" className="btn btn-primary" href={`/requests/${app.id}/edit`}>Edit and resubmit</Link>);
      body.push(<TaskButton key="r" hidden={hidden} action="RESUBMIT" label="Resubmit without field changes" primary={false} doneHref={doneHref} />);
      break;
    case "OFFER_PREPARATION": {
      const tpl = await activeTemplate(db, app.applicant_type);
      const generated = c.documents.filter((d) => d.category === "GENERATED_OFFER");
      const pdfs = c.documents.filter((d) => d.category === "GENERATED_OFFER_PDF");
      const signed = c.documents.filter((d) => d.category === "SIGNED_OFFER");
      const missing = ["GENERATED_OFFER", ...PACK].filter((p) => !has(p));
      body.push(
        <div key="terms" className="summary-box small">
          <p className="eyebrow">Approved terms</p>
          <table className="kv"><tbody>
            <tr><th>Facility amount (principal)</th><td className="tnum">{formatKobo(Number((c.assessment?.outputs as { amountApprovedKobo?: number } | undefined)?.amountApprovedKobo ?? app.requested_amount_kobo))}</td></tr>
            {c.assessment && <tr><th>Mark-up</th><td className="tnum">{formatKobo(c.assessment.markup_kobo)} ({(c.assessment.outputs as { flatMarkupRatePercent?: string }).flatMarkupRatePercent !== undefined ? `${(c.assessment.outputs as { flatMarkupRatePercent?: string }).flatMarkupRatePercent}% flat for the tenor` : `${String((c.assessment.inputs as Record<string, unknown>).markupRatePercent ?? "")}% p.a.`})</td></tr>}
            {c.assessment && pricingOf(c.assessment.outputs) && <tr><th>Monthly repayment · Total DSR</th><td className="tnum">{formatKobo(pricingOf(c.assessment.outputs)!.pricing.facility.monthlyRepaymentKobo)} · {pricingOf(c.assessment.outputs)!.pricing.capacity.totalDsrPercent}%</td></tr>}
            {c.assessment && <tr><th>Cost plus mark-up</th><td className="tnum">{formatKobo(c.assessment.cost_plus_markup_kobo)}</td></tr>}
            {c.assessment && <tr><th>APR</th><td className="tnum">{c.assessment.apr_percent}%</td></tr>}
            <tr><th>Tenor</th><td>{(c.assessment?.inputs as { tenorMonths?: number } | undefined)?.tenorMonths ?? data?.tenorMonths ?? "—"} months</td></tr>
          </tbody></table>
        </div>,
      );
      body.push(
        <GenerateOffer key="g" applicationId={app.id} hasOffer={has("GENERATED_OFFER")} templateLabel={tpl ? `${tpl.name} v${tpl.version} (${tpl.format === "DOCX" ? "Word" : "HTML"})${tpl.production_approved ? "" : " · awaiting bank approval"}` : "none active for this applicant type"} />,
      );
      if (generated.length || signed.length)
        body.push(
          <div key="versions" className="small">
            {generated.map((d) => <div key={d.id}>Generated offer v{d.version_no} ({d.mime_type === "text/html" ? "HTML" : "Word"}) · template v{d.template_version} · {formatLagos(d.uploaded_at)}{d.superseded_at ? " · superseded" : ""}</div>)}
            {pdfs.filter((d) => !d.superseded_at).map((d) => <div key={d.id}><Link href={`/requests/${app.id}?tab=documents&doc=${d.id}`}>Preview PDF copy v{d.version_no}</Link></div>)}
            <div className="muted">Download the Word letter from Documents to complete case-specific lines (security, Hamish Jiddiyah %) before printing. Upload the customer-signed copy as “Signed offer letter”.</div>
            {signed.map((d) => <div key={d.id}>Signed offer v{d.version_no} · {formatLagos(d.uploaded_at)}{d.superseded_at ? " · superseded" : ""}</div>)}
          </div>,
        );
      body.push(
        <ul key="cl" className="checklist">
          <Check ok={has("GENERATED_OFFER")}>Offer letter generated from the bank template</Check>
          {PACK.map((p) => <Check key={p} ok={has(p)}>{CATEGORY_LABEL[p]}</Check>)}
        </ul>,
      );
      body.push(<UploadPanel key="u" compact applicationId={app.id} title="Upload pack document" categories={[...PACK, "SUPPORTING"].map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))} />);
      if (missing.length) body.push(<Blocked key="miss">Missing before submission: {missing.map((m) => CATEGORY_LABEL[m]).join(", ")}.</Blocked>);
      body.push(<TaskButton key="s" hidden={hidden} action="SUBMIT_PACK" label="Submit pack to Credit Officer 3" disabled={missing.length > 0} doneHref={doneHref} />);
      break;
    }
    case "CO3_PACK_REVIEW": {
      const evidence = docs.some((d) => d.category === "INSURANCE_EVIDENCE" && d.uploaded_role === "CREDIT_OFFICER_3");
      body.push(
        <ul key="cl" className="checklist">
          <Check ok={has("INSURANCE_SIGNED")}>Customer-signed insurance document (from initiator)</Check>
          <Check ok={evidence}>Separate evidence of insurance (uploaded by you)</Check>
        </ul>,
      );
      body.push(<UploadPanel key="u" compact applicationId={app.id} title="Upload evidence of insurance" categories={[{ code: "INSURANCE_EVIDENCE", label: CATEGORY_LABEL.INSURANCE_EVIDENCE }, { code: "SUPPORTING", label: CATEGORY_LABEL.SUPPORTING }]} />);
      if (!evidence) body.push(<Blocked key="b">Upload evidence of insurance before forwarding.</Blocked>);
      body.push(<TaskButton key="f" hidden={hidden} action="FORWARD" label="Forward to Disbursement Officer 1" disabled={!evidence} doneHref={doneHref} />);
      break;
    }
    case "DISBURSEMENT_CHECK":
      body.push(<p key="t" className="small muted" style={{ margin: 0 }}>Check the full pack in Documents. Okay sends the request to Disbursement Officer 2. Send for Correction returns it directly to Credit Officer 3.</p>);
      body.push(<CrmsOkay key="o" hidden={hidden} doneHref={doneHref} />);
      break;
    case "DISBURSEMENT_CORRECTION":
      body.push(<UploadPanel key="u" compact applicationId={app.id} title="Upload replacement" categories={(UPLOADABLE_BY_STAGE.DISBURSEMENT_CORRECTION ?? []).map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))} />);
      body.push(<TaskButton key="r" hidden={hidden} action="RESUBMIT" label="Resubmit to Disbursement Officer 1" doneHref={doneHref} />);
      break;
    case "DISBURSEMENT_BOOKING":
      body.push(<BookingForm key="b" hidden={hidden} approved={koboToNairaString(Number(app.requested_amount_kobo))} defaultDate={lagosDate(new Date())} doneHref={doneHref} />);
      break;
    case "COMPLETION":
      body.push(<p key="t" className="small" style={{ margin: 0 }}>Queues one closure email with the full document pack and transaction summary to Legal and Shariah Compliance, copying the initiator. The initiator then confirms vendor payment separately.</p>);
      body.push(<TaskButton key="c" hidden={hidden} action="COMPLETE_PROCESS" label="Complete Process" confirm="Send the closure pack to Legal and Shariah Compliance and hand the request to the initiator for vendor payment confirmation?" doneHref={doneHref} />);
      break;
    case "VENDOR_CONFIRMATION":
      body.push(<p key="t" className="small" style={{ margin: 0 }}>Confirm the vendor has been paid. This closes the request and activates repayment prompts.</p>);
      body.push(<TaskButton key="v" hidden={hidden} action="CONFIRM_VENDOR_PAYMENT" label="Confirm vendor payment and end of process" confirm="Confirm that the vendor has been paid and close this request?" doneHref={doneHref} />);
      break;
  }

  const reasonActions: [TaskAction, string, boolean][] = [
    ["RETURN", stage === "CO3_PACK_REVIEW" ? "Return pack to initiator" : "Return for correction", false],
    ["REQUEST_INITIATOR", "Request documents from initiator", false],
    ["SEND_FOR_CORRECTION", "Send for Correction", false],
    ["REJECT", "Reject", true],
  ];
  const secondary = reasonActions.filter(([a]) => actions.includes(a));

  return (
    <div className="card action-panel">
      <p className="eyebrow">Your action</p>
      <h2>
        <span className={`role-tag ${isDo1 ? "alt" : ""}`}>{isDo1 ? "CRMS review" : isDo2 ? "Record disbursement" : ROLE_LABELS[task.assignee_role as Role]}</span>
        {STAGE_LABELS[stage]}
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
              <ReasonButton key={a} hidden={hidden} action={a} label={label} danger={danger} doneHref={doneHref} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

