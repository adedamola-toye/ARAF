import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, Eye, FileArchive, Info, ShieldCheck } from "lucide-react";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ReasonAction } from "@/components/forms";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { formatLagos, lagosDate } from "@/server/time";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { viewableRequest, currentSettings, settingsById, routeUnitHead, routeDivisionalHead } from "@/server/staff/core";
import { requestDetail, staffDocLink } from "@/server/staff/views";
import { eligibleDisbursementOfficers, disbursementControls } from "@/server/staff/disbursement";
import { activeStaffTemplate } from "@/server/staff/offer";
import { sharePointConfigured } from "@/server/staff/sharepoint";
import {
  APPLICANT_SUPPORTING_CATEGORIES,
  bpsLabel,
  formatNairaKobo,
  STAFF_DOC_CATEGORIES,
  STAFF_NEXT_ACTION,
  STAFF_STATUS_LABELS,
  STAFF_STATUS_QUEUE,
  type StaffStatus,
} from "@/lib/staff-financing";
import { CalculatorCard, CompleteDisbursementForm, ReassignForm, Countdown, HeadDecisionForm, OriginationForm, PmReviewForm, RemoveDocButton, SignedOfferForm, SimpleAction, StaffUpload } from "../StaffForms";
import { DocumentationBadge, StaffStatusBadge, eventLabel } from "../StatusBadge";
import {
  amendAction,
  claimPmAction,
  completeReviewAction,
  confirmReceiptAction,
  releasePmAction,
  retryDocumentationAction,
  retryOfferAction,
  returnSignedOfferAction,
  reviewDocsAction,
  startDisbursementAction,
} from "../actions";

export const metadata = { title: "Staff financing request" };

const STEPS: { label: string; done: (s: StaffStatus, r: Record<string, unknown>) => boolean; current: StaffStatus[] }[] = [
  { label: "Submitted", done: (_s, r) => Number(r.submission_count) > 0, current: ["DRAFT", "RETURNED_FOR_CORRECTION"] },
  { label: "Product Manager", done: (s) => ["UNDER_UNIT_HEAD_REVIEW", "UNDER_DIVISIONAL_HEAD_REVIEW", "APPROVED", "AWAITING_SIGNED_OFFER", "ASSIGNED_FOR_DISBURSEMENT", "DISBURSEMENT_IN_PROGRESS", "COMPLETED", "OFFER_EXPIRED"].includes(s), current: ["SUBMITTED", "UNDER_PM_REVIEW"] },
  { label: "Unit Head", done: (s) => ["UNDER_DIVISIONAL_HEAD_REVIEW", "APPROVED", "AWAITING_SIGNED_OFFER", "ASSIGNED_FOR_DISBURSEMENT", "DISBURSEMENT_IN_PROGRESS", "COMPLETED", "OFFER_EXPIRED"].includes(s), current: ["UNDER_UNIT_HEAD_REVIEW"] },
  { label: "Divisional Head", done: (s) => ["APPROVED", "AWAITING_SIGNED_OFFER", "ASSIGNED_FOR_DISBURSEMENT", "DISBURSEMENT_IN_PROGRESS", "COMPLETED", "OFFER_EXPIRED"].includes(s), current: ["UNDER_DIVISIONAL_HEAD_REVIEW"] },
  { label: "Offer accepted", done: (_s, r) => !!r.signed_offer_received_at, current: ["APPROVED", "AWAITING_SIGNED_OFFER"] },
  { label: "Disbursement", done: (s) => s === "COMPLETED", current: ["ASSIGNED_FOR_DISBURSEMENT", "DISBURSEMENT_IN_PROGRESS"] },
  { label: "Legal & Shariah", done: (_s, r) => r.documentation_status === "REVIEW_COMPLETED", current: ["COMPLETED"] },
];

export default async function StaffRequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx, session } = await requireUser();
  let view;
  try {
    view = await viewableRequest(ctx, id, db);
  } catch (e) {
    if (e instanceof DomainError && e.code === "NOT_FOUND") notFound();
    if (e instanceof DomainError && e.code === "FORBIDDEN") redirect("/forbidden");
    throw e;
  }
  const { req, as } = view;
  const me = session.staffId;
  const isApplicant = as.has("APPLICANT");
  const status = req.status as StaffStatus;
  const d = await requestDetail(db, req);
  const editable = isApplicant && (status === "DRAFT" || status === "RETURNED_FOR_CORRECTION");
  const settings = editable ? await currentSettings(db) : await settingsById(db, req.settings_id);
  const link = (docId: string, mode: "view" | "download") => staffDocLink(docId, me, session.sessionId, mode);
  const reviewer = !isApplicant;
  const crumbs = isApplicant ? [{ href: "/staff-request", label: "My staff financing" }] : [{ href: "/staff-financing", label: "Staff financing queues" }];
  const net = req.net_kobo ? formatNairaKobo(req.net_kobo) : "—";
  const supporting = d.docs.filter((x) => (APPLICANT_SUPPORTING_CATEGORIES as string[]).includes(x.category));
  const pmReview = [...d.reviews].reverse().find((r) => r.stage === "PRODUCT_MANAGER" && r.submission_no === req.submission_count);

  return (
    <>
      <PageHeader
        crumbs={[...crumbs, { label: req.ref }]}
        eyebrow="Staff Personal Request"
        title={req.ref}
        intro={`${req.full_name}${req.staff_number ? ` · Staff ID ${req.staff_number}` : ""}${req.unit ? ` · ${req.unit}` : ""}`}
        actions={
          <>
            <StaffStatusBadge status={status} />
            {status === "COMPLETED" && <DocumentationBadge status={req.documentation_status} />}
          </>
        }
      />

      {sp.submitted && (
        <div className="alert alert-success" role="status" style={{ marginBottom: "var(--space-4)" }}>
          <CheckCircle2 className="icon" aria-hidden="true" />
          <span>
            <strong>Request {sp.submitted} submitted</strong> on {formatLagos(req.submitted_at)}. It is in the Product Manager queue; you will be notified at each step and can track it here.
          </span>
        </div>
      )}
      {status === "RETURNED_FOR_CORRECTION" && req.return_reason && (
        <div className="alert alert-warn" role="alert" style={{ marginBottom: "var(--space-4)" }}>
          <AlertTriangle className="icon" aria-hidden="true" />
          <span>
            <strong>Returned for correction</strong> by {d.nameOf(req.returned_by)} on {formatLagos(req.returned_at)}: {req.return_reason}
          </span>
        </div>
      )}
      {status === "DECLINED" && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: "var(--space-4)" }}>
          <AlertTriangle className="icon" aria-hidden="true" />
          <span>
            <strong>Declined</strong> on {formatLagos(req.declined_at)}: {req.decline_reason}
          </span>
        </div>
      )}
      {status === "OFFER_EXPIRED" && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: "var(--space-4)" }}>
          <AlertTriangle className="icon" aria-hidden="true" />
          <span>
            <strong>Expired — offer not accepted.</strong> The signed offer was not returned by {formatLagos(req.offer_deadline_at)}. This request cannot be disbursed.
          </span>
        </div>
      )}

      <ol className="progress staff-progress" aria-label="Request progress">
        {STEPS.map((s) => {
          const done = s.done(status, req);
          const current = !done && s.current.includes(status);
          const stopped = !done && current && (status === "DECLINED" || status === "OFFER_EXPIRED");
          return (
            <li key={s.label} className={done ? "done" : stopped ? "stopped" : current ? "current" : ""} aria-current={current ? "step" : undefined}>
              {s.label}
            </li>
          );
        })}
      </ol>

      {editable ? (
        <>
          <OriginationForm
            v={{
              id: req.id,
              lockVersion: req.lock_version,
              fullName: req.full_name,
              email: req.email,
              staffNumber: req.staff_number ?? "",
              department: req.department ?? "",
              unit: req.unit ?? "",
              phone: req.phone ?? "",
              salaryAccountNumber: req.salary_account_number ?? "",
              salaryAccountName: req.salary_account_name ?? "",
              purpose: req.purpose ?? "",
              amount: req.gross_kobo ? (Number(req.gross_kobo) / 100).toFixed(2).replace(/\.00$/, "") : "",
              tenorMonths: req.tenor_months ? String(req.tenor_months) : "",
              acknowledged: !!req.deduction_acknowledged_at,
              acknowledgedNetKobo: req.net_kobo ? Number(req.net_kobo) : null,
              declaration: !!req.declaration_accepted_at,
            }}
            rateBps={settings.deduction_rate_bps}
            tenorOptions={settings.tenor_options_months}
            minKobo={settings.min_amount_kobo ? Number(settings.min_amount_kobo) : null}
            maxKobo={settings.max_amount_kobo ? Number(settings.max_amount_kobo) : null}
            returned={status === "RETURNED_FOR_CORRECTION"}
          />
          <section className="card" style={{ marginTop: "var(--space-4)" }} aria-labelledby="docs-h">
            <div className="card-head">
              <h2 id="docs-h">Supporting documents</h2>
              <span className="small muted">
                {settings.required_document_types.length
                  ? `Required: ${settings.required_document_types.map((c) => STAFF_DOC_CATEGORIES[c as keyof typeof STAFF_DOC_CATEGORIES]).join(", ")}`
                  : "Payslips or a salary account statement help the Product Manager verify your request"}
              </span>
            </div>
            <DocList docs={supporting} link={link} removable />
            <StaffUpload requestId={req.id} categories={APPLICANT_SUPPORTING_CATEGORIES.map((c) => ({ code: c, label: STAFF_DOC_CATEGORIES[c] }))} />
          </section>
        </>
      ) : (
        <div className="split">
          <div className="stack" style={{ minWidth: 0 }}>
            <CalculatorCard grossKobo={req.gross_kobo ? Number(req.gross_kobo) : null} rateBps={req.deduction_rate_bps ?? settings.deduction_rate_bps} audience={isApplicant ? "applicant" : "reviewer"} />
            <section className="card" aria-labelledby="det-h">
              <h2 id="det-h">Staff and financing details</h2>
              <table className="kv">
                <tbody>
                  <tr><th>Staff name</th><td>{req.full_name}</td></tr>
                  <tr><th>Staff ID</th><td>{req.staff_number ?? "—"}</td></tr>
                  <tr><th>Department · unit</th><td>{req.department ?? "—"} · {req.unit ?? "—"}</td></tr>
                  <tr><th>Staff email · phone</th><td><span className="mono">{req.email}</span> · <span className="mono">{req.phone ?? "—"}</span></td></tr>
                  <tr><th>Salary account (beneficiary)</th><td><span className="mono">{req.salary_account_number ?? "—"}</span> · {req.salary_account_name ?? "—"}</td></tr>
                  <tr><th>Tenor</th><td>{req.tenor_months ? `${req.tenor_months} months` : "Not collected under current settings"}</td></tr>
                  <tr><th>Purpose</th><td>{req.purpose ?? "—"}</td></tr>
                  <tr><th>Submitted</th><td>{formatLagos(req.first_submitted_at)}{req.submission_count > 1 ? ` · resubmitted ${formatLagos(req.submitted_at)} (submission ${req.submission_count})` : ""}</td></tr>
                  <tr><th>Current stage · queue</th><td>{STAFF_STATUS_LABELS[status]} · {STAFF_STATUS_QUEUE[status]}</td></tr>
                  {req.approved_at && <tr><th>Final approval</th><td>{formatLagos(req.approved_at)} by {d.nameOf(req.approved_by)} · terms locked</td></tr>}
                  {req.disbursed_at && <tr><th>Disbursed</th><td>{formatNairaKobo(req.disbursed_amount_kobo)} · ref <span className="mono">{req.disbursement_txn_ref}</span> · value date {String(req.disbursement_value_date).slice(0, 10)}</td></tr>}
                </tbody>
              </table>
            </section>
            {reviewer && pmReview?.checklist && (
              <section className="card" aria-labelledby="pmc-h">
                <h2 id="pmc-h">Product Manager checklist (manual)</h2>
                <ul className="checklist">
                  {[["accountVerified", "Staff account has been verified"], ["salaryHistoryReviewed", "Three months of salary history have been reviewed"], ["repaymentWithinLimit", "Repayment obligation is within 50% of take-home pay"]].map(([k, l]) => (
                    <li key={k}>
                      <span className={`tick ${pmReview.checklist[k] ? "ok" : "no"}`}>{pmReview.checklist[k] ? <CheckCircle2 className="icon" aria-hidden="true" /> : "–"}</span>
                      <span>{l}: <strong>{pmReview.checklist[k] ? "confirmed" : "not confirmed"}</strong></span>
                    </li>
                  ))}
                </ul>
                <p className="small" style={{ margin: "10px 0 0" }}>
                  {pmReview.checklist.verifiedTakeHomeKobo ? `Verified take-home pay ${formatNairaKobo(pmReview.checklist.verifiedTakeHomeKobo)}. ` : ""}
                  {pmReview.checklist.monthlyRepaymentKobo ? `Monthly repayment obligation ${formatNairaKobo(pmReview.checklist.monthlyRepaymentKobo)}. ` : ""}
                  Recommendation by {pmReview.actor_name}: {pmReview.recommendation ?? "—"}
                </p>
              </section>
            )}
            <section className="card" aria-labelledby="sd-h">
              <h2 id="sd-h">Documents</h2>
              <DocList docs={d.docs} link={link} />
            </section>
            <section className="card" aria-labelledby="rh-h">
              <h2 id="rh-h">Decisions</h2>
              {d.reviews.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>No decisions yet.</p>
              ) : (
                <ul className="timeline">
                  {d.reviews.map((r) => (
                    <li key={r.id} className="done">
                      <strong>
                        {r.stage === "PRODUCT_MANAGER" ? "Product Manager" : r.stage === "UNIT_HEAD" ? "Unit Head" : r.stage === "DIVISIONAL_HEAD" ? "Divisional Head" : "Disbursement"} · {r.action.toLowerCase()}
                      </strong>
                      <div className="small muted">
                        {r.actor_name} · {formatLagos(r.created_at)} · submission {r.submission_no}
                        {r.designated_name ? ` · designated Unit Head ${r.designated_name}` : ""}
                      </div>
                      {(r.comments || (reviewer && r.recommendation)) && <div className="small">{r.comments ?? r.recommendation}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <Timeline events={d.events} />
          </div>
          <div className="split-right">
            <ActionPanel />
          </div>
        </div>
      )}
    </>
  );

  // ---------------------------------------------------------------- role-specific action panel
  async function ActionPanel() {
    const panels: React.ReactNode[] = [];
    const lockVersion = req.lock_version;

    if (isApplicant) {
      if (status === "AWAITING_SIGNED_OFFER" && !req.signed_offer_received_at) {
        const signed = d.docs.filter((x) => x.category === "SIGNED_OFFER" && new Date(x.uploaded_at) >= new Date(req.offer_issued_at));
        panels.push(
          <section key="offer" className="card action-panel stack" aria-labelledby="offer-h">
            <p className="eyebrow">Your action</p>
            <h2 id="offer-h" style={{ margin: 0 }}>Sign and return your offer</h2>
            <p className="deadline">
              Return by <strong>{formatLagos(req.offer_deadline_at)}</strong> · <Countdown deadline={new Date(req.offer_deadline_at).toISOString()} />
            </p>
            {req.offer_document_id && (
              <div className="row">
                <a className="btn" href={link(req.offer_document_id, "view")} target="_blank" rel="noreferrer">
                  <Eye className="icon" aria-hidden="true" /> View offer letter
                </a>
                <a className="btn" href={link(req.offer_document_id, "download")}>
                  <Download className="icon" aria-hidden="true" /> Download
                </a>
              </div>
            )}
            <StaffUpload requestId={req.id} categories={[{ code: "SIGNED_OFFER", label: "Signed offer letter" }]} title="Upload the signed offer" />
            <SignedOfferForm id={req.id} lockVersion={lockVersion} uploads={signed.map((x) => ({ id: x.id, label: `${x.filename} · ${formatLagos(x.uploaded_at)}`, clean: x.scan_status === "CLEAN" }))} />
            {req.return_reason && req.returned_from_status === "ASSIGNED_FOR_DISBURSEMENT" && <p className="small err">Returned by the Disbursement Officer: {req.return_reason}</p>}
          </section>,
        );
      } else {
        panels.push(
          <section key="next" className="card stack" aria-labelledby="next-h">
            <p className="eyebrow">Where your request is</p>
            <h2 id="next-h" style={{ margin: 0 }}>{STAFF_STATUS_LABELS[status]}</h2>
            <p className="small" style={{ margin: 0 }}>
              {status === "AWAITING_SIGNED_OFFER" && req.signed_offer_received_at ? "Signed offer received; a Disbursement Officer will be assigned." : STAFF_NEXT_ACTION[status]}
            </p>
            <p className="small muted" style={{ margin: 0 }}>Assigned queue: {STAFF_STATUS_QUEUE[status]}</p>
          </section>,
        );
      }
    }

    if (!isApplicant && as.has("PRODUCT_MANAGER")) {
      if (status === "SUBMITTED") {
        panels.push(
          <section key="pm-claim" className="card action-panel stack">
            <p className="eyebrow">Product Manager</p>
            <h2 style={{ margin: 0 }}>Awaiting review</h2>
            <p className="small" style={{ margin: 0 }}>Start the review to take this request. Others in the queue will see it is with you.</p>
            <SimpleAction action={claimPmAction} hidden={{ id: req.id }} label="Start review" />
          </section>,
        );
      } else if (status === "UNDER_PM_REVIEW" && req.pm_reviewer_id === me) {
        const uhPos = await routeUnitHead(db, req);
        panels.push(
          <section key="pm" className="card action-panel stack">
            <p className="eyebrow">Your action · Product Manager</p>
            <h2 style={{ margin: 0 }}>Review and decide</h2>
            <PmReviewForm id={req.id} lockVersion={lockVersion} netLabel={net} unitHead={{ name: uhPos.name, problem: uhPos.problem }} />
            <SimpleAction action={releasePmAction} hidden={{ id: req.id }} label="Release to queue" className="btn btn-ghost btn-sm" />
          </section>,
        );
      } else if (status === "UNDER_PM_REVIEW") {
        panels.push(<InfoCard key="pm-o" title="Under review" text={`Being reviewed by ${d.nameOf(req.pm_reviewer_id)} since ${formatLagos(req.pm_claimed_at)}.`} />);
      }
    }
    const uhNow = status === "UNDER_UNIT_HEAD_REVIEW" ? await routeUnitHead(db, req) : null;
    if (!isApplicant && as.has("UNIT_HEAD") && uhNow?.id === me) {
      panels.push(
        <section key="uh" className="card action-panel stack">
          <p className="eyebrow">Your action · Unit Head</p>
          <h2 style={{ margin: 0 }}>Decide on this request</h2>
          {uhNow.problem ? <p className="small err" style={{ margin: 0 }}>{uhNow.problem}</p> : <HeadDecisionForm id={req.id} lockVersion={lockVersion} level="UH" netLabel={net} />}
        </section>,
      );
    }
    const dhNow = status === "UNDER_DIVISIONAL_HEAD_REVIEW" ? await routeDivisionalHead(db, req) : null;
    if (!isApplicant && as.has("DIVISIONAL_HEAD")) {
      if (status === "UNDER_DIVISIONAL_HEAD_REVIEW") {
        panels.push(
          <section key="dh" className="card action-panel stack">
            <p className="eyebrow">Your action · Divisional Head (final approval)</p>
            <h2 style={{ margin: 0 }}>Final decision</h2>
            {dhNow?.problem ? <p className="small err" style={{ margin: 0 }}>{dhNow.problem}</p> : <HeadDecisionForm id={req.id} lockVersion={lockVersion} level="DH" netLabel={net} />}
          </section>,
        );
      } else if (["APPROVED", "AWAITING_SIGNED_OFFER", "ASSIGNED_FOR_DISBURSEMENT"].includes(status)) {
        panels.push(
          <section key="amend" className="card stack">
            <p className="eyebrow">Controlled amendment</p>
            <p className="small" style={{ margin: 0 }}>Approved terms are locked. To change them, withdraw the approval: the offer is withdrawn and the request returns to the applicant for the full review route.</p>
            <ReasonAction action={amendAction} hidden={{ id: req.id, lockVersion: String(lockVersion) }} label="Withdraw approval for amendment" danger />
          </section>,
        );
      }
    }
    if (!isApplicant && as.has("DISBURSEMENT") && req.disbursement_officer_id === me) {
      if (status === "ASSIGNED_FOR_DISBURSEMENT") {
        const fails = await disbursementControls(db, req);
        panels.push(
          <section key="do" className="card action-panel stack">
            <p className="eyebrow">Your action · Disbursement</p>
            <h2 style={{ margin: 0 }}>Pay {net}</h2>
            <p className="small" style={{ margin: 0 }}>Gross {formatNairaKobo(req.gross_kobo)} less {bpsLabel(req.deduction_rate_bps)} deduction ({formatNairaKobo(req.deduction_kobo)}) to <span className="mono">{req.salary_account_number}</span> ({req.salary_account_name}).</p>
            <Controls fails={fails} />
            {req.signed_offer_document_id && (
              <a className="btn btn-sm" href={link(req.signed_offer_document_id, "view")} target="_blank" rel="noreferrer">
                <Eye className="icon" aria-hidden="true" /> Signed offer
              </a>
            )}
            {!req.documentation_reviewed_at ? (
              <SimpleAction action={reviewDocsAction} hidden={{ id: req.id, lockVersion: String(lockVersion) }} label="Mark documentation reviewed" className="btn" />
            ) : (
              <p className="small" style={{ margin: 0 }}><CheckCircle2 className="icon" aria-hidden="true" /> Documentation reviewed {formatLagos(req.documentation_reviewed_at)}</p>
            )}
            <SimpleAction action={startDisbursementAction} hidden={{ id: req.id, lockVersion: String(lockVersion) }} label="Process disbursement">
              <div className="field">
                <label htmlFor="instr">Core banking instruction reference (optional)</label>
                <input id="instr" name="instructionRef" autoComplete="off" />
              </div>
            </SimpleAction>
            <ReasonAction action={returnSignedOfferAction} hidden={{ id: req.id, lockVersion: String(lockVersion) }} label="Return for correction" />
            <p className="small muted" style={{ margin: 0 }}>A return sends the signed offer back to the applicant; the original deadline ({formatLagos(req.offer_deadline_at)}) still applies.</p>
          </section>,
        );
      } else if (status === "DISBURSEMENT_IN_PROGRESS") {
        const ev = d.docs.filter((x) => x.category === "DISBURSEMENT_EVIDENCE" && x.uploaded_by === me);
        panels.push(
          <section key="do2" className="card action-panel stack">
            <p className="eyebrow">Your action · Disbursement in progress</p>
            <h2 style={{ margin: 0 }}>Confirm the transfer</h2>
            <p className="small" style={{ margin: 0 }}>No payment system is connected: pay {net} in core banking, then record the reference and evidence here.</p>
            <StaffUpload requestId={req.id} categories={[{ code: "DISBURSEMENT_EVIDENCE", label: "Disbursement evidence" }]} title="Upload disbursement evidence" />
            <CompleteDisbursementForm id={req.id} lockVersion={lockVersion} netKobo={Number(req.net_kobo)} evidence={ev.map((x) => ({ id: x.id, label: `${x.filename}${x.scan_status === "CLEAN" ? "" : " (scanning…)"}` }))} today={lagosDate(new Date())} />
          </section>,
        );
      }
    }
    if (!isApplicant && (as.has("LEGAL") || as.has("SHARIAH") || as.has("ADMIN")) && d.handover) {
      panels.push(
        <section key="docs" className="card action-panel stack">
          <p className="eyebrow">Documentation</p>
          <h2 style={{ margin: 0 }}>Legal and Shariah review</h2>
          <a className="btn" href={`/api/staff-requests/${req.id}/archive`}>
            <FileArchive className="icon" aria-hidden="true" /> Download {d.archive?.filename}
          </a>
          {d.groups.map((g) => {
            const mine = (g.group_code === "LEGAL" && as.has("LEGAL")) || (g.group_code === "SHARIAH" && as.has("SHARIAH"));
            return (
              <div key={g.group_code} className="summary-box stack">
                <strong>{g.group_code === "LEGAL" ? "Legal" : "Shariah Compliance"}: {g.status === "SENT" ? "sent, not yet opened" : g.status === "RECEIVED" ? `received by ${g.received_by_name}` : `reviewed by ${g.reviewed_by_name}`}</strong>
                {g.comments && <span className="small">{g.comments}</span>}
                {mine && g.status === "SENT" && <SimpleAction action={confirmReceiptAction} hidden={{ id: req.id, group: g.group_code }} label="Confirm receipt" className="btn btn-sm" />}
                {mine && g.status !== "REVIEWED" && (
                  <SimpleAction action={completeReviewAction} hidden={{ id: req.id, group: g.group_code }} label="Record review completed" className="btn btn-sm btn-primary">
                    <div className="field">
                      <label htmlFor={`rv-${g.group_code}`}>Review outcome</label>
                      <textarea id={`rv-${g.group_code}`} name="comments" rows={2} required minLength={3} />
                    </div>
                  </SimpleAction>
                )}
              </div>
            );
          })}
        </section>,
      );
    }
    if (as.has("ADMIN") && !isApplicant) {
      const ops: React.ReactNode[] = [];
      if (status === "APPROVED") {
        const tpl = await activeStaffTemplate(db);
        ops.push(
          <div key="offer" className="stack">
            <p className="small err" style={{ margin: 0 }}>{req.offer_blocked_reason ?? "Offer not yet generated."}</p>
            <p className="small muted" style={{ margin: 0 }}>Template: {tpl ? `v${tpl.version} ${tpl.production_approved ? "approved" : "not approved"}` : "none active"}. <Link href="/admin/staff-financing">Staff financing settings</Link></p>
            <SimpleAction action={retryOfferAction} hidden={{ id: req.id }} label="Generate offer now" className="btn btn-sm" />
          </div>,
        );
      }
      if ((status === "AWAITING_SIGNED_OFFER" && req.signed_offer_received_at) || status === "ASSIGNED_FOR_DISBURSEMENT" || status === "DISBURSEMENT_IN_PROGRESS") {
        const officers = (await eligibleDisbursementOfficers(db, req)).filter((o) => o.id !== req.disbursement_officer_id);
        ops.push(
          <ReassignForm key="reassign" id={req.id} current={req.disbursement_officer_id ? d.nameOf(req.disbursement_officer_id) : null} officers={officers.map((o) => ({ id: o.id, label: `${o.full_name} (${ROLE_LABELS[o.role as Role]})` }))} />,
        );
      }
      if (status === "COMPLETED") {
        ops.push(
          <div key="doc" className="stack small">
            <span>Documentation: <DocumentationBadge status={req.documentation_status} /></span>
            <span>Archive: {d.archive ? `${d.archive.filename} · SHA-256 ${String(d.archive.sha256).slice(0, 12)}…` : "not created yet"}</span>
            <span>SharePoint: {d.sharepoint ? `${d.sharepoint.status === "VERIFIED" ? "verified" : d.sharepoint.status.toLowerCase()} · ${d.sharepoint.folder_path} · ${d.sharepoint.attempts} attempt(s)` : sharePointConfigured() ? "pending" : "not configured (archive held in encrypted platform storage)"}</span>
            {req.doc_last_error && <span className="err">Last error: {req.doc_last_error}</span>}
            {req.documentation_status !== "SENT_TO_LEGAL_SHARIAH" && req.documentation_status !== "RECEIVED_BY_LEGAL_SHARIAH" && req.documentation_status !== "REVIEW_COMPLETED" && (
              <SimpleAction action={retryDocumentationAction} hidden={{ id: req.id }} label="Retry documentation now" className="btn btn-sm" />
            )}
          </div>,
        );
      }
      if (status === "UNDER_UNIT_HEAD_REVIEW" && uhNow?.problem) ops.push(<p key="uhp" className="small err" style={{ margin: 0 }}>{uhNow.problem} <Link href="/admin/staff-financing">Staff financing settings</Link></p>);
      if (status === "UNDER_DIVISIONAL_HEAD_REVIEW" && dhNow?.problem) ops.push(<p key="dhp" className="small err" style={{ margin: 0 }}>{dhNow.problem}</p>);
      if (status === "UNDER_PM_REVIEW") ops.push(<SimpleAction key="rel" action={releasePmAction} hidden={{ id: req.id }} label="Release Product Manager review" className="btn btn-sm" />);
      if (ops.length) {
        panels.push(
          <section key="ops" className="card stack">
            <p className="eyebrow"><ShieldCheck className="icon" aria-hidden="true" /> Operations (Super Admin)</p>
            {ops}
            <div className="small muted">Assignment history: {d.assignments.length ? d.assignments.map((a) => `${a.officer_name} (${a.method === "RANDOM" ? `random of ${a.eligible_count}` : `by ${a.assigned_by_name}: ${a.reason}`}${a.ended_at ? ", ended" : ""})`).join("; ") : "none"}</div>
          </section>,
        );
      }
    }
    if (!panels.length) panels.push(<InfoCard key="none" title={STAFF_STATUS_LABELS[status]} text={STAFF_NEXT_ACTION[status]} />);
    return <>{panels}</>;
  }
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <section className="card stack">
      <p className="eyebrow"><Info className="icon" aria-hidden="true" /> Status</p>
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p className="small" style={{ margin: 0 }}>{text}</p>
    </section>
  );
}

function Controls({ fails }: { fails: string[] }) {
  const items = ["Final approval exists", "Signed offer present and accepted", "Offer has not expired", "Beneficiary details complete", "Net amount matches the approved calculation", "Not already disbursed"];
  return (
    <div className="summary-box">
      <strong className="small">Financial controls</strong>
      {fails.length === 0 ? (
        <ul className="checklist" style={{ marginTop: 6 }}>
          {items.map((i) => (
            <li key={i}><span className="tick ok"><CheckCircle2 className="icon" aria-hidden="true" /></span>{i}</li>
          ))}
        </ul>
      ) : (
        <ul className="checklist" style={{ marginTop: 6 }}>
          {fails.map((f) => (
            <li key={f} className="err"><AlertTriangle className="icon" aria-hidden="true" /> {f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocList({ docs, link, removable = false }: { docs: { id: string; category: string; filename: string; uploaded_at: Date; uploaded_by_name: string | null; scan_status: string }[]; link: (id: string, m: "view" | "download") => string; removable?: boolean }) {
  if (!docs.length) return <p className="muted small" style={{ margin: "0 0 var(--space-3)" }}>No documents yet.</p>;
  return (
    <ul className="doc-rows">
      {docs.map((x) => (
        <li key={x.id}>
          <span className="doc-name">
            <strong>{STAFF_DOC_CATEGORIES[x.category as keyof typeof STAFF_DOC_CATEGORIES] ?? x.category}</strong>
            <span className="small muted">{x.filename} · {x.uploaded_by_name ?? "System"} · {formatLagos(x.uploaded_at)}</span>
          </span>
          <span className="row">
            {x.scan_status === "CLEAN" ? (
              <>
                <a className="btn btn-sm btn-ghost" href={link(x.id, "view")} target="_blank" rel="noreferrer">View</a>
                <a className="btn btn-sm btn-ghost" href={link(x.id, "download")}>Download</a>
              </>
            ) : (
              <span className={`badge ${x.scan_status === "REJECTED" ? "badge-red" : "badge-warn"}`}>{x.scan_status === "REJECTED" ? "Failed scan" : "Scanning"}</span>
            )}
            {removable && <RemoveDocButton documentId={x.id} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ events }: { events: { id: string; action: string; occurred_at: Date; actor_name: string | null; comments: string | null; to_status: string | null }[] }) {
  const shown = events.filter((e) => !["DOCUMENT_VIEWED", "DOCUMENT_DOWNLOADED", "DRAFT_SAVED", "ARCHIVE_DOWNLOADED"].includes(e.action));
  return (
    <section className="card" aria-labelledby="tl-h">
      <h2 id="tl-h">Request timeline</h2>
      <ul className="timeline">
        {shown.map((e) => (
          <li key={e.id} className="done">
            <strong>{eventLabel(e.action)}</strong>
            <div className="small muted">{e.actor_name ?? "System"} · {formatLagos(e.occurred_at)}{e.to_status ? ` · ${STAFF_STATUS_LABELS[e.to_status as StaffStatus]}` : ""}</div>
            {e.comments && <div className="small">{e.comments}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
