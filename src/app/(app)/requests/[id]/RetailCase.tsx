import { CreditSummary } from "@/components/CreditCheckPanel";
import type { CreditCheckRow } from "@/server/credit/seedfi";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import { db } from "@/server/db";
import type { getCase } from "@/server/domain/views";
import { CATEGORY_LABEL, PACK } from "@/server/domain/documents";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { configById, configGaps, effectiveConfig, gapsBlocking, profileRules, structureRules, PROFILE_LABELS, STRUCTURE_LABELS, INSURANCE_LABELS, DSR_DENOMINATOR_LABELS, FULFILMENT_LABELS, roleLabel, type CustomerProfile, type StructureCode, type FulfilmentKind } from "@/server/domain/products";
import { retailDataSchema } from "@/server/domain/retail-data";
import { PROPOSAL_FIELDS, preliminaryOk } from "@/server/domain/retail";
import { retailTemplate } from "@/server/domain/retail-offer";
import { facilityPosition, paymentPosition, beneficiaryRevalidation, type FacilityRow } from "@/server/domain/retail-ops";
import { checkPhotos } from "@/server/domain/doc-matrix";
import type { AffordabilityOutput, AffordabilityInput } from "@/server/domain/affordability";
import type { BeneficiarySnapshot } from "@/server/domain/vendors";
import type { AppRow } from "@/server/domain/assignment";
import { formatKobo, koboToNairaString } from "@/server/money";
import { formatLagos, lagosDate, addDaysToDateString } from "@/server/time";
import { maskWithLast4 } from "@/server/mask";
import { UploadPanel } from "@/components/UploadPanel";
import { CrmsOkay, GenerateOffer, ReasonButton, RevealIdentifiers, TaskButton } from "./CaseClient";
import { ContractSubmit, BookFacilityForm, BusinessDecisionForm, DocReview, ExceptionDecision, FinalAssessmentForm, FulfilmentForm, PaymentEventForm, ReasonForm, ServicingForms } from "./RetailClient";

type Case = Awaited<ReturnType<typeof getCase>>;
const k2s = (k: number | string | null | undefined) => (k === null || k === undefined || k === "" ? "" : koboToNairaString(Number(k)).replace(/\.00$/, ""));

export const RETAIL_MILESTONES: { label: string; stages: Stage[] }[] = [
  { label: "Initiation", stages: ["DRAFT", "INITIATOR_CORRECTION"] },
  { label: "Business review", stages: ["OSS_REVIEW", "TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL"] },
  { label: "Credit", stages: ["FIRST_CREDIT_REVIEW", "CREDIT_CORRECTION", "SECOND_CREDIT_REVIEW", "UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW"] },
  { label: "Offer & contract", stages: ["OFFER_PREPARATION", "CO3_PACK_REVIEW"] },
  { label: "Pre-disbursement & booking", stages: ["DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION", "DISBURSEMENT_BOOKING"] },
  { label: "Payment", stages: ["PAYMENT_RECONCILIATION", "COMPLETION"] },
  { label: "Fulfilment", stages: ["FULFILMENT", "COMPLETED"] },
];

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

async function retailBits(c: Case) {
  const app = c.app as AppRow & { lock_version: number };
  const versionData = c.version?.data ?? c.working?.data ?? {};
  const data = retailDataSchema.parse(versionData);
  const ben = (versionData as { beneficiarySnapshot?: BeneficiarySnapshot | null }).beneficiarySnapshot ?? null;
  const cfg = app.product_config_id ? await configById(db, app.product_config_id) : await effectiveConfig(db, app.product_code!, new Date());
  const rules = cfg ? profileRules(cfg.config, app.customer_profile) : null;
  const st = structureRules(rules, app.financing_structure);
  const assessments = (await db.query("SELECT ra.*, s.full_name AS assessor_name FROM retail_assessments ra JOIN staff s ON s.id = ra.assessor_id WHERE application_id = $1 ORDER BY created_at DESC", [app.id])).rows;
  const prelim = assessments.find((a: { kind: string; superseded_at: Date | null }) => a.kind === "PRELIMINARY" && !a.superseded_at) ?? null;
  const final = assessments.find((a: { kind: string; superseded_at: Date | null }) => a.kind === "FINAL" && !a.superseded_at) ?? null;
  const proposal = (await db.query("SELECT p.*, s.full_name AS author_name FROM credit_proposals p JOIN staff s ON s.id = p.author_id WHERE application_id = $1 ORDER BY version_no DESC LIMIT 1", [app.id])).rows[0] ?? null;
  const exceptions = (await db.query("SELECT pe.*, r.full_name AS requested_by_name, d.full_name AS decided_by_name FROM policy_exceptions pe JOIN staff r ON r.id = pe.requested_by LEFT JOIN staff d ON d.id = pe.decided_by WHERE application_id = $1 ORDER BY requested_at", [app.id])).rows;
  const facility = (await db.query<FacilityRow>("SELECT * FROM facilities WHERE application_id = $1", [app.id])).rows[0] ?? null;
  const fulfilment = (await db.query("SELECT f.*, s.full_name AS completed_by_name FROM fulfilment_tasks f LEFT JOIN staff s ON s.id = f.completed_by WHERE application_id = $1 ORDER BY created_at", [app.id])).rows;
  return { app, data, ben, cfg, rules, st, prelim, final, assessments, proposal, exceptions, facility, fulfilment };
}

function AssessmentSummary({ out, title, meta }: { out: AffordabilityOutput; title: string; meta: string }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className={`badge ${out.result === "PASS" ? "badge-green" : out.result === "FAIL" ? "badge-red" : "badge-warn"}`}>{out.result}</span>
      </div>
      <div className="metric-grid">
        <div className="metric"><div className="k">DSR (threshold {out.dsr?.maxPercent ?? "—"}%)</div><div className="v">{out.dsr ? `${out.dsr.percent}%` : "—"}</div></div>
        <div className="metric"><div className="k">Proposed monthly obligation</div><div className="v">{out.proposedMonthlyDisplay ?? "—"}</div><div className="small muted">{out.obligationSource === "INITIATOR_ESTIMATE" ? "initiator estimate" : out.obligationSource === "CALCULATED_FROM_TERMS" ? "calculated from terms" : ""}</div></div>
        <div className="metric"><div className="k">Existing obligations / month</div><div className="v">{formatKobo(out.existingMonthlyKobo)}</div></div>
        <div className="metric"><div className="k">Total payable</div><div className="v">{out.totalPayableKobo !== null ? formatKobo(out.totalPayableKobo) : "—"}</div></div>
      </div>
      <table className="kv" style={{ marginTop: 12 }}>
        <tbody>
          <tr><th>Structure · rate</th><td>{out.structureLabel ?? "—"} · {out.rateLabel ?? "—"}</td></tr>
          <tr><th>Insurance</th><td>{out.insurance ?? "not configured"}</td></tr>
          {out.dsr && <tr><th>DSR denominator</th><td>{out.dsr.denominatorLabel}: {formatKobo(out.dsr.denominatorKobo)}</td></tr>}
          {out.cap?.applies && <tr><th>Principal-to-turnover cap (separate rule)</th><td>{out.cap.percent}% of maximum {out.cap.maxPercent}%</td></tr>}
          {out.chargesKobo > 0 && <tr><th>Applicable charges</th><td>{formatKobo(out.chargesKobo)}</td></tr>}
        </tbody>
      </table>
      <h3 style={{ marginTop: 12 }}>Formula and inputs</h3>
      <ol className="small formula">{out.formula.map((f) => <li key={f}>{f}</li>)}</ol>
      <ul className="checklist">{out.checks.map((c) => <Check key={c.rule} ok={c.pass}>{c.rule}: {c.detail}</Check>)}</ul>
      {out.blockedReasons.length > 0 && <Blocked>{out.blockedReasons.join(" ")}</Blocked>}
      {out.schedule.length > 0 && <p className="small muted">Schedule: {out.schedule.length} instalments of {formatKobo(out.schedule[0].amountKobo)}{out.schedule.at(-1)!.amountKobo !== out.schedule[0].amountKobo ? ` (final ${formatKobo(out.schedule.at(-1)!.amountKobo)})` : ""}.</p>}
      <p className="small muted" style={{ margin: 0 }}>{meta}</p>
    </div>
  );
}

export async function RetailOverview({ c }: { c: Case }) {
  const b = await retailBits(c);
  const { app, data, ben, rules, st } = b;
  const name = (id: string | null) => (id ? c.people[id] ?? "—" : "—");
  const ppl = (await db.query("SELECT id, full_name FROM staff WHERE id = ANY($1::uuid[])", [[app.assigned_rm_id, app.oss_reviewer_id, app.team_lead_id, app.hrs_id, app.hou_id].filter(Boolean)])).rows;
  const nm = (id: string | null) => (id ? ppl.find((p: { id: string }) => p.id === id)?.full_name ?? name(id) : "—");
  const loc = app.location_snapshot as { outletName?: string; outletType?: string; city?: string; state?: string } | null;
  const out = b.prelim?.outputs as AffordabilityOutput | undefined;
  return (
    <div className="stack">
      {app.suspended_at && <div className="alert alert-warn"><AlertTriangle className="icon" aria-hidden="true" /> Suspended: {app.suspension_reason}</div>}
      <div className="metric-grid">
        <div className="metric"><div className="k">Requested (submitted)</div><div className="v">{formatKobo(app.requested_amount_kobo)}</div></div>
        <div className="metric"><div className="k">Structure · rate</div><div className="v v-text">{st ? `${STRUCTURE_LABELS[st.code]} ${st.ratePercent ?? "—"}%` : "—"}</div></div>
        <div className="metric"><div className="k">Preliminary DSR</div><div className="v">{out?.dsr ? `${out.dsr.percent}%` : "—"}</div><div className="small muted">threshold {rules?.dsr.maxPercent ?? "—"}%</div></div>
        <div className="metric"><div className="k">Insurance</div><div className="v v-text">{st?.insuranceBearer ? INSURANCE_LABELS[st.insuranceBearer] : "Not configured"}</div></div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Customer</h2>
          <RevealIdentifiers applicationId={app.id} />
        </div>
        <table className="kv">
          <tbody>
            <tr><th>Product · profile</th><td>{app.product_label} · {PROFILE_LABELS[app.customer_profile as CustomerProfile]} · {app.applicant_type.toLowerCase()}</td></tr>
            <tr><th>Customer</th><td>{app.customer_name}</td></tr>
            {app.applicant_type !== "INDIVIDUAL" && <tr><th>CAC registration</th><td className="mono">{data.registrationNumber}</td></tr>}
            <tr><th>Phone · email</th><td className="mono">{data.phone}{data.email ? ` · ${data.email}` : ""}</td></tr>
            <tr><th>{app.customer_profile === "SALARY_EARNER" ? "Customer address" : "Business address"}</th><td>{data.businessAddress || "—"}</td></tr>
            {app.applicant_type !== "LIMITED" && <tr><th>BVN</th><td className="mono">{c.masked.bvn} <span className="small muted">(format checked; not verified)</span></td></tr>}
            {app.applicant_type === "LIMITED" && <tr><th>Directors</th><td>{c.directors.map((d: { id: string; full_name: string; bvn_last4: string }) => <div key={d.id}>{d.full_name} · <span className="mono">{maskWithLast4(d.bvn_last4)}</span></div>)}</td></tr>}
            {app.customer_profile === "SALARY_EARNER" ? (
              <tr><th>Employment</th><td>{data.employerName}{data.jobTitle ? `, ${data.jobTitle}` : ""} · salary {formatKobo(data.statedMonthlySalaryKobo)} · {data.salaryHistory.length} months recorded</td></tr>
            ) : (
              <tr><th>Business</th><td>{data.businessSector}{data.yearsInOperation !== null ? ` · ${data.yearsInOperation} years` : ""} · turnover {formatKobo(data.statedMonthlyTurnoverKobo)} / month</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Facility and beneficiary</h2>
        <table className="kv">
          <tbody>
            <tr><th>Requested amount · tenor</th><td className="tnum"><strong>{formatKobo(data.requestedAmountKobo)}</strong> · {data.tenorMonths} months</td></tr>
            <tr><th>Purpose</th><td>{data.purpose || "—"}</td></tr>
            {data.assetDescription && <tr><th>Asset</th><td>{data.assetDescription} · {formatKobo(data.assetCostKobo)}</td></tr>}
            {data.deliveryAddress && <tr><th>Delivery / installation address</th><td>{data.deliveryAddress}</td></tr>}
            <tr><th>Existing obligations</th><td>{data.existingObligations.length ? data.existingObligations.map((o) => `${o.lender} ${formatKobo(o.monthlyRepaymentKobo)}`).join("; ") : "None declared"}</td></tr>
            <tr>
              <th>Vendor and beneficiary</th>
              <td>
                {ben ? (
                  <>
                    <strong>{ben.vendorName}</strong>{ben.vendorEmail ? ` · ${ben.vendorEmail}` : ""}
                    <div><span className="mono">{ben.institutionName} · {ben.accountNumber}</span> · {ben.accountName}</div>
                    <div className="small muted">Snapshot at submission ({formatLagos(ben.capturedAt)}); verification: {ben.verificationStatus.toLowerCase()} ({ben.verificationMethod?.toLowerCase().replace("_", " ") ?? "—"}){ben.paymentSupported ? "" : " · payment route not supported by provider"}</div>
                  </>
                ) : (
                  "Captured at submission"
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Ownership and review route</h2>
        <table className="kv">
          <tbody>
            <tr><th>Initiator</th><td>{name(app.initiator_id)} ({ROLE_LABELS[app.initiator_role as Role]}{app.team ? `, team ${app.team}` : ""})</td></tr>
            {app.initiator_role === "DELIGHT_OFFICER" && <tr><th>Assigned RM</th><td>{nm(app.assigned_rm_id)}</td></tr>}
            {loc?.outletName && <tr><th>Originating outlet</th><td>{loc.outletName} ({loc.outletType?.toLowerCase()}), {loc.city}, {loc.state}</td></tr>}
            {app.initiator_role === "DELIGHT_OFFICER" && <tr><th>Outlet Service Supervisor</th><td>{nm(app.oss_reviewer_id)}</td></tr>}
            <tr><th>Team Lead</th><td>{nm(app.team_lead_id)}</td></tr>
            <tr><th>Head of Retail Sales</th><td>{nm(app.hrs_id)}</td></tr>
            <tr><th>Head of Unit</th><td>{b.cfg?.config.businessReview.headOfUnitStage === "DISTINCT" ? nm(app.hou_id) : "Not required by configuration"}</td></tr>
            <tr><th>Credit route · reviewers</th><td>{app.route ? `Route ${app.route}` : "after business approval"} · {name(app.first_reviewer_id)} / {name(app.second_reviewer_id)}</td></tr>
            <tr><th>Configuration</th><td>Version {b.cfg?.version ?? "—"} (pinned at submission)</td></tr>
          </tbody>
        </table>
      </div>
      {b.proposal && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Credit proposal v{b.proposal.version_no} · {b.proposal.author_name} · {formatLagos(b.proposal.created_at)}</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            {PROPOSAL_FIELDS.map((f) => (
              <div key={f.key}>
                <strong className="small">{f.label}</strong>
                <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{(b.proposal.content as Record<string, string>)[f.key] || "—"}</p>
              </div>
            ))}
          </div>
        </details>
      )}
      {b.exceptions.length > 0 && (
        <div className="card">
          <h2>Exceptions</h2>
          <ul className="small">
            {b.exceptions.map((e: { id: string; type: string; status: string; reason: string; requested_by_name: string; decided_by_name: string | null; decision_note: string | null; approver_role: string }) => (
              <li key={e.id}>
                <strong>{e.type}</strong> <span className="badge">{e.status.toLowerCase()}</span> · requested by {e.requested_by_name}: {e.reason}. Authority: {roleLabel(e.approver_role)}.{e.decided_by_name ? ` Decided by ${e.decided_by_name}: ${e.decision_note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {b.facility && <FacilityCard facility={b.facility} fulfilment={b.fulfilment} />}
    </div>
  );
}

async function FacilityCard({ facility, fulfilment }: { facility: FacilityRow; fulfilment: { kind: FulfilmentKind; status: string; completed_by_name: string | null; completed_at: Date | null; note: string | null }[] }) {
  const pos = await facilityPosition(db, facility.id, lagosDate(new Date()));
  const pay = await paymentPosition(db, facility.id, Number(facility.principal_kobo));
  return (
    <div className="card">
      <h2>Facility, payment and fulfilment</h2>
      <div className="state-row">
        <span>Facility <span className="badge badge-blue">{facility.status.toLowerCase().replace("_", " ")}</span></span>
        <span>Payment <span className="badge">{facility.payment_status.toLowerCase()}</span></span>
        <span>Fulfilment <span className="badge">{facility.fulfilment_status.toLowerCase().replace("_", " ")}</span></span>
      </div>
      <table className="kv">
        <tbody>
          <tr><th>Facility reference</th><td className="mono">{facility.booking_ref} · booked {formatLagos(facility.booked_at)}</td></tr>
          <tr><th>Principal · total payable</th><td className="tnum">{formatKobo(facility.principal_kobo)} · {formatKobo(facility.total_payable_kobo)}</td></tr>
          <tr><th>Payments confirmed (net)</th><td className="tnum">{formatKobo(pay.netKobo)}{pay.pendingRefs.length ? ` · uncertain: ${pay.pendingRefs.join(", ")}` : ""}</td></tr>
          <tr><th>Repaid · outstanding</th><td className="tnum">{formatKobo(pos.paidKobo)} · {formatKobo(pos.outstandingKobo)}</td></tr>
          <tr><th>Overdue</th><td className="tnum">{pos.overdueKobo ? `${formatKobo(pos.overdueKobo)} (${pos.daysPastDue} days past due)` : "None"}</td></tr>
          <tr><th>Next due</th><td>{pos.nextDue ? `${pos.nextDue.dueDate} · ${formatKobo(pos.nextDue.amountKobo)}` : "—"}</td></tr>
        </tbody>
      </table>
      {fulfilment.length > 0 && (
        <ul className="checklist">
          {fulfilment.map((f) => (
            <Check key={f.kind} ok={f.status === "DONE"}>
              {FULFILMENT_LABELS[f.kind]}{f.status === "DONE" ? ` · ${f.completed_by_name}, ${formatLagos(f.completed_at)}: ${f.note}` : " · open"}
            </Check>
          ))}
        </ul>
      )}
    </div>
  );
}

export async function RetailAssessmentTab({ c }: { c: Case }) {
  const b = await retailBits(c);
  return (
    <div className="stack">
      {b.final ? <AssessmentSummary out={b.final.outputs} title="Final credit assessment" meta={`${b.final.engine_version} · configuration v${b.final.rules.configVersion} · ${b.final.assessor_name} · ${formatLagos(b.final.created_at)}`} /> : <div className="card"><p className="muted" style={{ margin: 0 }}>The final assessment is recorded by the first credit reviewer.</p></div>}
      {b.prelim && <AssessmentSummary out={b.prelim.outputs} title="Preliminary assessment (at submission)" meta={`${b.prelim.engine_version} · configuration v${b.prelim.rules.configVersion} · ${b.prelim.assessor_name} · ${formatLagos(b.prelim.created_at)}`} />}
      {b.assessments.filter((a: { superseded_at: Date | null }) => a.superseded_at).length > 0 && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Superseded assessments (kept for audit)</summary>
          <ul className="small">
            {b.assessments.filter((a: { superseded_at: Date | null }) => a.superseded_at).map((a: { id: string; kind: string; result: string; created_at: Date; superseded_at: Date; outputs: AffordabilityOutput }) => (
              <li key={a.id}>{a.kind.toLowerCase()} · {a.result} · DSR {a.outputs.dsr?.percent ?? "—"}% · {formatLagos(a.created_at)} (superseded {formatLagos(a.superseded_at)})</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function retailDocReviewable(stage: string) {
  return ["OSS_REVIEW", "TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW", "SECOND_CREDIT_REVIEW", "CO3_PACK_REVIEW", "DISBURSEMENT_CHECK"].includes(stage);
}
export { DocReview };

/** Retail action panel. Returns null for stages handled by the shared panel (CO3 pack review, disbursement correction, completion). */
export async function RetailActionPanel({ c, task, doneHref }: { c: Case; task: NonNullable<Case["openTask"]>; doneHref: string }) {
  const stage = task.stage as Stage;
  if (["CO3_PACK_REVIEW", "DISBURSEMENT_CORRECTION", "COMPLETION"].includes(stage)) return null;
  const b = await retailBits(c);
  const { app, rules } = b;
  const hidden = { taskId: task.id, lockVersion: String(app.lock_version) };
  const docs = c.documents.filter((d) => !d.superseded_at && d.scan_status === "CLEAN");
  const has = (cat: string) => docs.some((d) => d.category === cat);
  const body: React.ReactNode[] = [];
  const secondary: [string, string, boolean][] = [];
  const openCorrection = c.corrections.filter((x: { resolved_at: Date | null }) => !x.resolved_at).at(-1);
  const now = new Date();
  const effective = app.product_code ? await effectiveConfig(db, app.product_code, now) : null;
  const gapsNow = effective ? configGaps(effective.config, { profile: app.customer_profile as CustomerProfile, structure: app.financing_structure }) : [];
  if (app.suspended_at) body.push(<Blocked key="susp">Suspended: {app.suspension_reason}. Actions are paused.</Blocked>);
  if (openCorrection && ["CREDIT_CORRECTION", "INITIATOR_CORRECTION", "OFFER_PREPARATION"].includes(stage)) {
    body.push(<div key="corr" className="alert alert-warn"><AlertTriangle className="icon" aria-hidden="true" /><span><strong>Correction requested</strong> by {openCorrection.requested_by_name}: {openCorrection.reason}</span></div>);
  }
  const prelimOut = b.prelim?.outputs as AffordabilityOutput | undefined;
  const finalOut = b.final?.outputs as AffordabilityOutput | undefined;
  switch (stage) {
    case "OSS_REVIEW":
    case "TEAM_LEAD_REVIEW":
    case "HRS_REVIEW":
    case "HEAD_OF_UNIT_APPROVAL": {
      const pre = await preliminaryOk(db, app);
      const photos = rules ? checkPhotos(c.documents, rules, app.initiator_role === "DELIGHT_OFFICER" ? app.assigned_rm_id : app.initiator_id) : null;
      const tlBlocked = stage === "TEAM_LEAD_REVIEW" ? gapsBlocking(gapsNow, "TEAM_LEAD_REVIEW") : [];
      const priorDecisions = c.decisions.filter((d: { decision_kind: string | null; invalidated_at: Date | null }) => d.decision_kind === "BUSINESS_REVIEW" && !d.invalidated_at);
      body.push(
        <ul key="cl" className="checklist">
          <Check ok={pre.ok}>Preliminary DSR {prelimOut?.dsr ? `${prelimOut.dsr.percent}% (≤ ${prelimOut.dsr.maxPercent}%)` : "—"}{pre.ok ? "" : `: ${pre.message}`}</Check>
          {stage === "OSS_REVIEW" && <Check ok={!!app.location_snapshot}>Originating outlet: {(app.location_snapshot as { outletName?: string } | null)?.outletName ?? "—"}</Check>}
          {photos && rules?.businessPhotos.minDistinct ? <Check ok={photos.distinctAngles >= photos.required}>{photos.distinctAngles} of {photos.required} distinct business photographs</Check> : null}
          {photos && rules?.businessPhotos.rmPhotoRequired ? <Check ok={photos.rmPhotoPresent}>Photograph categorised as RM with the business (reviewer confirms content)</Check> : null}
          {rules?.rmProposalRequired && <Check ok={!!b.proposal}>RM credit proposal{b.proposal ? ` v${b.proposal.version_no} by ${b.proposal.author_name}` : " missing"}</Check>}
        </ul>,
      );
      if (priorDecisions.length)
        body.push(
          <div key="prior" className="summary-box small">
            <p className="eyebrow">Prior recommendations</p>
            {priorDecisions.map((d: { id: string; stage: string; actor_name: string; action: string; reason: string | null }) => <p key={d.id} style={{ margin: "0 0 6px" }}><strong>{STAGE_LABELS[d.stage as Stage]}</strong> · {d.actor_name}: {d.reason}</p>)}
          </div>,
        );
      if (tlBlocked.length) body.push(<Blocked key="tlb">Blocked until configured: {tlBlocked.map((g) => g.label).join("; ")}.</Blocked>);
      const actionMap: Record<string, [string, string, string]> = {
        OSS_REVIEW: ["RECOMMEND", "Recommend to Team Lead", "Completeness, outlet and state details, Altbox/Altshop location and evidence."],
        TEAM_LEAD_REVIEW: ["RECOMMEND", "Recommend to Head of Retail Sales", "Your independent view of the appraisal, proposal, financial evidence, DSR and commercial viability."],
        HRS_REVIEW: ["ENDORSE", b.cfg?.config.businessReview.headOfUnitStage === "DISTINCT" ? "Endorse to Head of Unit" : "Endorse for credit", "Prior recommendations, product compliance, commercial viability and the proposed terms."],
        HEAD_OF_UNIT_APPROVAL: ["APPROVE", "Grant business approval", "Final business approval before credit processing. This is not a credit approval."],
      };
      const [act, label, hint] = actionMap[stage];
      if (!tlBlocked.length && pre.ok) body.push(<BusinessDecisionForm key="f" hidden={hidden} action={act} label={label} hint={hint} visitRequired={stage === "TEAM_LEAD_REVIEW" && !!rules?.visitRequired} rmPhotoRequired={stage === "TEAM_LEAD_REVIEW" && !!rules?.businessPhotos.rmPhotoRequired} doneHref={doneHref} />);
      secondary.push(["RETURN", "Return to initiator for correction", false], ["REJECT", "Decline", true]);
      break;
    }
    case "FIRST_CREDIT_REVIEW":
    case "CREDIT_CORRECTION": {
      const finalBlocked = gapsBlocking(gapsNow, "FINAL_ASSESSMENT");
      const current = b.final && b.final.version_id === app.current_version_id;
      const credit = rules?.documents.filter((d) => d.stage === "CREDIT" && d.requirement !== "OPTIONAL") ?? [];
      const dsrEx = b.exceptions.find((e: { type: string; status: string }) => e.type === "DSR" && e.status === "APPROVED");
      const benProblems = await beneficiaryRevalidation(db, app, now);
      body.push(
        <ul key="cl" className="checklist">
          <Check ok={!!current && b.final.result === "PASS"}>Final assessment for the current version{finalOut ? `: ${finalOut.result}${finalOut.dsr ? `, DSR ${finalOut.dsr.percent}%` : ""}` : ""}{dsrEx ? " (approved DSR exception on file)" : ""}</Check>
          {credit.map((d) => <Check key={d.code} ok={has(d.code)}>{CATEGORY_LABEL[d.code]}</Check>)}
          <Check ok={!benProblems.length}>Beneficiary unchanged and verified{benProblems.length ? `: ${benProblems.join(" ")}` : ""}</Check>
        </ul>,
      );
      if (finalBlocked.length) body.push(<Blocked key="fb">Final calculation is blocked until configured: {finalBlocked.map((g) => g.label).join("; ")}.</Blocked>);
      const inputs = b.final?.inputs as AffordabilityInput | undefined;
      body.push(
        <details key="fa" open={!current}>
          <summary className="small" style={{ fontWeight: 700, cursor: "pointer" }}>Final assessment ({rules?.dsr.denominator ? DSR_DENOMINATOR_LABELS[rules.dsr.denominator] : "denominator not configured"})</summary>
          <div style={{ marginTop: 8 }}>
            <FinalAssessmentForm
              applicationId={app.id}
              defaults={{
                incomeBasis: k2s(inputs?.incomeBasisKobo ?? b.data.incomeBasisKobo),
                principal: k2s(inputs?.principalKobo ?? b.data.requestedAmountKobo),
                tenor: String(inputs?.tenorMonths ?? b.data.tenorMonths ?? ""),
                statementFrom: inputs?.statementFrom ?? "",
                statementTo: inputs?.statementTo ?? "",
                obligations: (inputs?.existingObligations ?? b.data.existingObligations).map((o) => ({ lender: o.lender, monthly: k2s(o.monthlyRepaymentKobo) })),
                denominatorLabel: rules?.dsr.denominator ? DSR_DENOMINATOR_LABELS[rules.dsr.denominator].toLowerCase() : "income basis",
                capApplies: !!rules?.principalTurnoverCap.applies,
              }}
            />
          </div>
        </details>,
      );
      body.push(<UploadPanel key="up" compact applicationId={app.id} title="Upload credit report or evidence" categories={["CREDIT_REPORT", "EXCEPTION_EVIDENCE", "SUPPORTING"].map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))} />);
      if (stage === "FIRST_CREDIT_REVIEW") {
        body.push(<TaskButton key="ap" hidden={hidden} action="APPROVE" label="Approve credit appraisal" doneHref={doneHref} disabled={!current} />);
        secondary.push(["RETURN", "Return to initiator for correction", false], ["REJECT", "Decline", true]);
      } else {
        body.push(<TaskButton key="rs" hidden={hidden} action="RESUBMIT" label={`Resubmit to ${STAGE_LABELS[(openCorrection?.from_stage as Stage) ?? "SECOND_CREDIT_REVIEW"]}`} doneHref={doneHref} />);
        secondary.push(["REQUEST_INITIATOR", "Request changes from the initiator", false]);
      }
      break;
    }
    case "SECOND_CREDIT_REVIEW":
    case "UNIT_HEAD_REVIEW":
    case "DIVISIONAL_HEAD_REVIEW": {
      if (finalOut) body.push(<AssessmentSummary key="a" out={finalOut} title="Approved assessment snapshot" meta={`Configuration v${b.final.rules.configVersion} · ${b.final.assessor_name}`} />);
      else body.push(<Blocked key="a">No final assessment on record.</Blocked>);
      const route = app.route;
      if (stage === "SECOND_CREDIT_REVIEW" && route !== 1) body.push(<TaskButton key="p" hidden={hidden} action="PROCEED" label="Proceed (independent credit review)" doneHref={doneHref} />);
      else body.push(<TaskButton key="p" hidden={hidden} action="APPROVE" label="Approve (credit)" doneHref={doneHref} />);
      if (stage !== "SECOND_CREDIT_REVIEW" || route === 1) secondary.push(["RETURN", "Return to the first credit reviewer", false]);
      secondary.push(["REJECT", "Decline", true]);
      break;
    }
    case "INITIATOR_CORRECTION":
      body.push(<p key="t" className="small" style={{ margin: 0 }}>Correct the application and resubmit. Changes to principal, tenor, structure, repayment capacity, vendor or beneficiary invalidate earlier approvals and restart the business review.</p>);
      body.push(<Link key="l" className="btn btn-primary" href={`/requests/${app.id}/edit`}>Edit and resubmit</Link>);
      break;
    case "OFFER_PREPARATION": {
      const tpl = app.product_code ? await retailTemplate(db as never, app.product_code, app.financing_structure) : null;
      const offerBlocked = [...gapsBlocking(gapsNow, "OFFER"), ...gapsBlocking(gapsNow, "FINAL_ASSESSMENT")];
      const contracting = gapsBlocking(gapsNow, "CONTRACTING");
      const seq = structureRules(effective ? profileRules(effective.config, app.customer_profile) : null, app.financing_structure)?.contractSequence ?? [];
      const missing = ["GENERATED_OFFER", ...PACK].filter((p) => !has(p));
      if (seq.length && !has("CONTRACT_EVIDENCE")) missing.push("CONTRACT_EVIDENCE");
      if (finalOut) body.push(<div key="terms" className="summary-box small"><p className="eyebrow">Approved terms</p>{finalOut.structureLabel} · {finalOut.rateLabel}<br />Principal {formatKobo((b.final.inputs as AffordabilityInput).principalKobo)} · total payable {formatKobo(finalOut.totalPayableKobo)} · monthly {finalOut.proposedMonthlyDisplay}<br /><strong>{finalOut.insurance}</strong></div>);
      if (offerBlocked.length) body.push(<Blocked key="ob">Offer generation blocked until configured: {offerBlocked.map((g) => g.label).join("; ")}.</Blocked>);
      else if (!tpl) body.push(<Blocked key="nt">No active offer template for this product and structure.</Blocked>);
      else if (!tpl.production_approved) body.push(<Blocked key="na">The offer template “{tpl.name}” v{tpl.version} has not been approved by the bank. Offers are generated only from approved templates (Administration → Offer templates).</Blocked>);
      else body.push(<GenerateOffer key="g" applicationId={app.id} hasOffer={has("GENERATED_OFFER")} templateLabel={`${tpl.name} v${tpl.version}`} />);
      if (contracting.length) body.push(<Blocked key="cs">Contractual sequence not configured: {contracting.map((g) => g.label).join("; ")}.</Blocked>);
      else if (seq.length) body.push(<div key="seq" className="small"><strong>Contract sequence ({STRUCTURE_LABELS[app.financing_structure as StructureCode]}):</strong><ol>{seq.map((s) => <li key={s}>{s}</li>)}</ol></div>);
      body.push(<ul key="cl" className="checklist"><Check ok={has("GENERATED_OFFER")}>Offer generated from the approved template</Check>{PACK.map((p) => <Check key={p} ok={has(p)}>{CATEGORY_LABEL[p]}</Check>)}{seq.length > 0 && <Check ok={has("CONTRACT_EVIDENCE")}>{CATEGORY_LABEL.CONTRACT_EVIDENCE}</Check>}</ul>);
      body.push(<UploadPanel key="u" compact applicationId={app.id} title="Upload pack or contract document" categories={[...PACK, "CONTRACT_EVIDENCE", "SUPPORTING"].map((x) => ({ code: x, label: CATEGORY_LABEL[x] }))} />);
      if (missing.length) body.push(<Blocked key="miss">Missing: {missing.map((m) => CATEGORY_LABEL[m]).join(", ")}.</Blocked>);
      body.push(<SubmitPack key="sp" hidden={hidden} doneHref={doneHref} disabled={missing.length > 0 || contracting.length > 0} sequence={seq} />);
      break;
    }
    case "DISBURSEMENT_CHECK": {
      const benProblems = await beneficiaryRevalidation(db, app, now);
      body.push(<ul key="cl" className="checklist"><Check ok={has("CRMS_EVIDENCE")}>CRMS evidence uploaded</Check><Check ok={!benProblems.length}>Beneficiary still verified and unchanged{benProblems.length ? `: ${benProblems.join(" ")}` : ""}</Check></ul>);
      body.push(<p key="n" className="small muted" style={{ margin: 0 }}>“Logged CRMS” is an officer attestation backed by the uploaded evidence (no CRMS integration is connected).</p>);
      body.push(<UploadPanel key="u" compact applicationId={app.id} title="Upload CRMS evidence" categories={[{ code: "CRMS_EVIDENCE", label: CATEGORY_LABEL.CRMS_EVIDENCE }, { code: "SUPPORTING", label: CATEGORY_LABEL.SUPPORTING }]} />);
      if (benProblems.length) body.push(<Blocked key="b">Return the request to the initiator to update the beneficiary; this triggers re-approval.</Blocked>);
      else body.push(<CrmsOkay key="o" hidden={hidden} doneHref={doneHref} />);
      secondary.push(["SEND_FOR_CORRECTION", "Send pack for correction (Credit Officer 3)", false], ["RETURN", "Return to initiator (beneficiary revalidation)", false]);
      break;
    }
    case "DISBURSEMENT_BOOKING": {
      const principal = b.final ? k2s((b.final.inputs as AffordabilityInput).principalKobo) : "";
      body.push(<BookFacilityForm key="bk" hidden={hidden} principal={principal} defaultDue={addDaysToDateString(lagosDate(now), 30)} doneHref={doneHref} />);
      break;
    }
    case "PAYMENT_RECONCILIATION": {
      const fac = b.facility!;
      const pay = await paymentPosition(db, fac.id, Number(fac.principal_kobo));
      const events = (await db.query("SELECT e.*, s.full_name AS recorded_by_name FROM payment_events e LEFT JOIN staff s ON s.id = e.recorded_by WHERE facility_id = $1 ORDER BY recorded_at", [fac.id])).rows;
      const evidence = docs.filter((d) => d.category === "PAYMENT_EVIDENCE").map((d) => ({ id: d.id, label: `${d.filename} (v${d.version_no})` }));
      body.push(<p key="t" className="small" style={{ margin: 0 }}>Facility {fac.booking_ref}: {formatKobo(fac.principal_kobo)} to {b.ben?.vendorName} ({b.ben?.institutionName} · {b.ben?.accountNumber}). Record each payment outcome with evidence; a payment is successful only when confirmed amounts (net of reversals) equal the principal.</p>);
      body.push(
        <div key="pos" className="state-row">
          <span>Status <span className={`badge ${pay.status === "CONFIRMED" ? "badge-green" : pay.status === "PENDING" ? "badge-warn" : ""}`}>{pay.status.toLowerCase()}</span></span>
          <span className="tnum">Confirmed net {formatKobo(pay.netKobo)}</span>
        </div>,
      );
      if (events.length)
        body.push(
          <table key="ev" className="data small">
            <thead><tr><th>Ref</th><th>Event</th><th className="right">Amount</th><th>Recorded</th></tr></thead>
            <tbody>{events.map((e: { id: string; payment_ref: string; event_type: string; amount_kobo: string; recorded_by_name: string | null; recorded_at: Date; source: string }) => <tr key={e.id}><td className="mono">{e.payment_ref}</td><td>{e.event_type.toLowerCase()} ({e.source === "INTEGRATION" ? "integration" : "manual with evidence"})</td><td className="num">{formatKobo(e.amount_kobo)}</td><td>{e.recorded_by_name ?? "system"} · {formatLagos(e.recorded_at)}</td></tr>)}</tbody>
          </table>,
        );
      body.push(<UploadPanel key="u" compact applicationId={app.id} title="Upload payment evidence" categories={[{ code: "PAYMENT_EVIDENCE", label: CATEGORY_LABEL.PAYMENT_EVIDENCE }]} />);
      body.push(<details key="pe" open><summary className="small" style={{ fontWeight: 700, cursor: "pointer" }}>Record payment outcome</summary><div style={{ marginTop: 8 }}><PaymentEventForm applicationId={app.id} evidence={evidence} principal={k2s(fac.principal_kobo)} /></div></details>);
      body.push(<TaskButton key="rc" hidden={hidden} action="RECONCILE_PAYMENT" label="Confirm payment reconciled" disabled={pay.status !== "CONFIRMED"} confirm="Confirm that the payment is reconciled against the evidence? The facility becomes active and post-disbursement tasks are created." doneHref={doneHref} />);
      break;
    }
    case "FULFILMENT": {
      const evidence = docs.filter((d) => d.category === "FULFILMENT_EVIDENCE").map((d) => ({ id: d.id, label: `${d.filename} (v${d.version_no})` }));
      body.push(<UploadPanel key="u" compact applicationId={app.id} title="Upload fulfilment evidence" categories={[{ code: "FULFILMENT_EVIDENCE", label: CATEGORY_LABEL.FULFILMENT_EVIDENCE }]} />);
      for (const f of b.fulfilment) {
        if (f.status === "DONE") body.push(<p key={f.kind} className="small" style={{ margin: 0 }}>✓ {FULFILMENT_LABELS[f.kind as FulfilmentKind]}: {f.note}</p>);
        else body.push(<FulfilmentForm key={f.kind} applicationId={app.id} kind={f.kind} label={FULFILMENT_LABELS[f.kind as FulfilmentKind]} evidence={evidence} />);
      }
      const open = b.fulfilment.filter((f: { status: string }) => f.status !== "DONE").length;
      body.push(<TaskButton key="cf" hidden={hidden} action="COMPLETE_FULFILMENT" label="Complete application" disabled={open > 0} doneHref={doneHref} />);
      body.push(<p key="n" className="small muted" style={{ margin: 0 }}>Completing the application does not close the facility; it stays active until fully settled.</p>);
      break;
    }
    default:
      return null;
  }
  return (
    <div className="card action-panel">
      <p className="eyebrow">Your action</p>
      <h2>
        <span className="role-tag">{ROLE_LABELS[task.assignee_role as Role]}</span>
        {STAGE_LABELS[stage]}
      </h2>
      <p className="small muted" style={{ marginTop: -4 }}>Assigned {formatLagos(task.assigned_at)}</p>
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

function SubmitPack({ hidden, doneHref, disabled, sequence }: { hidden: Record<string, string>; doneHref: string; disabled: boolean; sequence: string[] }) {
  return sequence.length ? <ContractSubmit hidden={hidden} doneHref={doneHref} disabled={disabled} /> : <TaskButton hidden={hidden} action="SUBMIT_PACK" label="Submit pack to Credit Officer 3" disabled={disabled} doneHref={doneHref} />;
}

/** Side tools: withdraw (initiator), suspend/resume (Super Admin / HRS), exception decisions, facility servicing. */
export async function RetailCaseTools({ c, staffId, roles }: { c: Case; staffId: string; roles: string[] }) {
  const app = c.app;
  const out: React.ReactNode[] = [];
  const closed = ["COMPLETED", "CLOSED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(app.stage);
  const fac = (await db.query<FacilityRow>("SELECT * FROM facilities WHERE application_id = $1", [app.id])).rows[0] ?? null;
  const checks = (await db.query<CreditCheckRow>("SELECT DISTINCT ON (person_key) * FROM credit_checks WHERE application_id = $1 ORDER BY person_key, created_at DESC", [app.id])).rows;
  if (checks.length && app.stage !== "DRAFT") out.push(<CreditSummary key="credit" checks={checks} />);
  if (app.initiator_id === staffId && !closed && !fac) out.push(<ReasonForm key="w" kind="withdraw" hidden={{ applicationId: app.id }} label="Withdraw request" danger />);
  if ((roles.includes("SUPER_ADMIN") || roles.includes("HEAD_OF_RETAIL_SALES")) && !closed) out.push(<ReasonForm key="s" kind={app.suspended_at ? "resume" : "suspend"} hidden={{ applicationId: app.id }} label={app.suspended_at ? "Resume request" : "Suspend request"} />);
  const pending = (await db.query("SELECT * FROM policy_exceptions WHERE application_id = $1 AND status = 'REQUESTED'", [app.id])).rows.filter((e: { approver_role: string; requested_by: string }) => roles.includes(e.approver_role) && e.requested_by !== staffId && app.initiator_id !== staffId);
  for (const e of pending) out.push(<div key={e.id} className="summary-box small"><strong>{e.type} exception requested:</strong> {e.reason}<ExceptionDecision exceptionId={e.id} /></div>);
  if (fac && roles.includes("COLLECTIONS_OFFICER") && ["ACTIVE", "IN_ARREARS", "RESTRUCTURED", "SETTLED"].includes(fac.status)) {
    const pos = await facilityPosition(db, fac.id, lagosDate(new Date()));
    const evidence = c.documents.filter((d) => d.category === "REPAYMENT_EVIDENCE" && !d.superseded_at && d.scan_status === "CLEAN").map((d) => ({ id: d.id, label: d.filename }));
    const restr = (await db.query("SELECT * FROM servicing_actions WHERE facility_id = $1 AND kind = 'RESTRUCTURE_REQUEST' AND status = 'REQUESTED'", [fac.id])).rows;
    out.push(
      <div key="svc" className="card">
        <p className="eyebrow">Servicing</p>
        <h2>Repayments and recovery</h2>
        <p className="small muted">Outstanding {formatKobo(pos.outstandingKobo)}; overdue {formatKobo(pos.overdueKobo)}. No repayment feed is integrated: record repayments with evidence.</p>
        <UploadPanel compact applicationId={app.id} title="Upload repayment evidence" categories={[{ code: "REPAYMENT_EVIDENCE", label: CATEGORY_LABEL.REPAYMENT_EVIDENCE }]} />
        <ServicingForms facilityId={fac.id} evidence={evidence} canClose={pos.outstandingKobo === 0 && fac.status !== "CLOSED"} restructurePending={restr.map((r: { id: string; note: string; approver_role: string; recorded_by: string }) => ({ id: r.id, note: r.note, canDecide: roles.includes(r.approver_role) && r.recorded_by !== staffId }))} />
      </div>,
    );
  } else if (fac) {
    const restr = (await db.query("SELECT * FROM servicing_actions WHERE facility_id = $1 AND kind = 'RESTRUCTURE_REQUEST' AND status = 'REQUESTED'", [fac.id])).rows.filter((r: { approver_role: string; recorded_by: string }) => roles.includes(r.approver_role) && r.recorded_by !== staffId);
    if (restr.length) out.push(<div key="rs" className="card"><h2>Restructuring decision</h2><ServicingForms decisionOnly facilityId={fac.id} evidence={[]} canClose={false} restructurePending={restr.map((r: { id: string; note: string }) => ({ id: r.id, note: r.note, canDecide: true }))} /></div>);
  }
  if (!out.length) return null;
  return <div className="stack">{out}</div>;
}
