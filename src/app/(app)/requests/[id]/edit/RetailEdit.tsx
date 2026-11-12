import { db } from "@/server/db";
import { getCase } from "@/server/domain/views";
import { CATEGORY_LABEL, RETAIL_UPLOADABLE_BY_STAGE, ASSIGNED_RM_UPLOADS, signDocumentLink } from "@/server/domain/documents";
import { retailReadiness, PROPOSAL_FIELDS, loadRetailState } from "@/server/domain/retail";
import { INSURANCE_LABELS, RATE_CONVENTION_LABELS, STRUCTURE_LABELS, PROFILE_LABELS, DSR_DENOMINATOR_LABELS, roleLabel, type CustomerProfile } from "@/server/domain/products";
import { vendorOptions, searchInstitutions } from "@/server/domain/vendors";
import { listLocations } from "@/server/domain/locations";
import { maskWithLast4 } from "@/server/mask";
import { koboToNairaString } from "@/server/money";
import { formatLagos } from "@/server/time";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { PageHeader } from "@/components/PageHeader";
import { UploadPanel } from "@/components/UploadPanel";
import { RetailDraftForm } from "./RetailDraftForm";
import { BeneficiaryProposalForm, ExceptionRequestForm, ProposalForm } from "./RetailSideForms";

type Case = Awaited<ReturnType<typeof getCase>>;
const k2s = (k: number | null | undefined) => (k === null || k === undefined ? "" : koboToNairaString(k).replace(/\.00$/, ""));

import { CreditCheckPanel } from "@/components/CreditCheckPanel";
import { retailCreditStatus } from "@/server/domain/retail-credit";
import { retailCreditAction } from "../../retail-actions";

export async function RetailEdit({ c, staffId, sessionId, mode }: { c: Case; staffId: string; sessionId: string; mode: "INITIATOR" | "ASSIGNED_RM" }) {
  const app = c.app;
  const now = new Date();
  const readiness = await retailReadiness(db, app.id, now);
  const { data, version } = await loadRetailState(db, app.id);
  const rules = readiness.rules;
  const myTask = c.openTask && c.openTask.assignee_id === staffId && c.openTask.stage === "INITIATOR_CORRECTION" ? c.openTask : null;
  const openCorrection = c.corrections.filter((x: { resolved_at: Date | null }) => !x.resolved_at).at(-1);
  const docs = c.documents.filter((d) => !d.superseded_at && d.scan_status !== "REJECTED");
  const proposal = (await db.query("SELECT * FROM credit_proposals WHERE application_id = $1 ORDER BY version_no DESC LIMIT 1", [app.id])).rows[0];
  const responsibleRm = app.initiator_role === "DELIGHT_OFFICER" ? app.assigned_rm_id : app.initiator_id;
  const canWriteProposal = responsibleRm === staffId;
  const uploadCats = mode === "ASSIGNED_RM" ? ASSIGNED_RM_UPLOADS : (RETAIL_UPLOADABLE_BY_STAGE[myTask ? "INITIATOR_CORRECTION" : "DRAFT"] ?? []);
  const required = new Set(readiness.matrix.map((m) => m.code));
  const orderedCats = [...uploadCats].sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const header = (
    <PageHeader
      crumbs={[{ href: "/requests", label: "View Progress" }, { href: `/requests/${app.id}`, label: app.ref }, { label: app.stage === "DRAFT" ? "Draft" : "Correction" }]}
      eyebrow={`${app.product_label} · ${PROFILE_LABELS[app.customer_profile as CustomerProfile]}`}
      title={mode === "ASSIGNED_RM" ? "RM proposal and visit evidence" : app.stage === "DRAFT" ? "Application" : "Correct and resubmit"}
      intro={`${app.ref} · saved on the server; last update ${formatLagos(app.updated_at)}. Entries are kept if validation fails.`}
    />
  );
  const uploads = (
    <section className="card" aria-labelledby="h-up">
      <h2 id="h-up">Upload documents</h2>
      <UploadPanel applicationId={app.id} categories={orderedCats.map((x) => ({ code: x, label: `${CATEGORY_LABEL[x]}${required.has(x) ? " (required)" : ""}` }))} withMeta />
      {docs.length > 0 && (
        <ul className="doc-list small">
          {docs.map((d) => (
            <li key={d.id}>
              <a href={signDocumentLink(d.id, staffId, sessionId, "download")}>{CATEGORY_LABEL[d.category]}</a> · {d.filename} (v{d.version_no})
              {d.meta?.photoCategory ? ` · ${d.meta.photoCategory.replace(/_/g, " ").toLowerCase()}` : ""}
              {d.meta?.coverageFrom ? ` · ${d.meta.coverageFrom} to ${d.meta.coverageTo}` : ""}
              {d.scan_status === "QUARANTINED" && <span className="badge badge-warn">Quarantined</span>}
              {d.review_status === "REJECTED" && <span className="badge badge-red">Rejected: {d.review_reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  const proposalCard = (
    <section className="card" id="proposal" aria-labelledby="h-prop">
      <h2 id="h-prop">Credit proposal</h2>
      {readiness.proposal.required ? (
        <ProposalForm
          applicationId={app.id}
          canEdit={canWriteProposal}
          authorNote={canWriteProposal ? "Written by you as the responsible Relationship Manager." : app.initiator_role === "DELIGHT_OFFICER" ? (app.assigned_rm_id ? "Written by the assigned Relationship Manager." : "Assign a Relationship Manager to write the proposal.") : "Written by the initiating Relationship Manager."}
          fields={PROPOSAL_FIELDS.map((f) => ({ key: f.key, label: f.label, hint: f.hint, required: f.key !== "visitFindings" || !!rules?.businessPhotos.rmPhotoRequired }))}
          content={(proposal?.content as Record<string, string>) ?? {}}
        />
      ) : (
        <p className="small muted" style={{ margin: 0 }}>Not required for this product and profile.</p>
      )}
    </section>
  );
  if (mode === "ASSIGNED_RM") {
    return (
      <>
        {header}
        <div className="stack" style={{ maxWidth: 920 }}>
          <div className="alert alert-info">
            You are the assigned Relationship Manager on this Delight Officer request. Write the credit proposal and upload the business-visit evidence and the photograph of you with the business.
          </div>
          {proposalCard}
          {uploads}
        </div>
      </>
    );
  }
  const vendors = await vendorOptions(db);
  const vendorMap = new Map<string, { vendorId: string; vendorName: string; vendorEmail: string | null; accounts: { id: string; label: string; status: string; bank: string; number: string }[] }>();
  for (const v of vendors) {
    if (!vendorMap.has(v.vendor_id)) vendorMap.set(v.vendor_id, { vendorId: v.vendor_id, vendorName: v.vendor_name, vendorEmail: v.vendor_email, accounts: [] });
    if (v.account_id && v.account_status === "ACTIVE") vendorMap.get(v.vendor_id)!.accounts.push({ id: v.account_id, label: v.account_name ?? "", status: v.verification_status ?? "", bank: v.institution_name ?? "", number: v.account_number ?? "" });
  }
  const institutions = await searchInstitutions(db, "");
  const locations = await listLocations(db, { activeOnly: true });
  const rms = (await db.query(`SELECT s.id, s.full_name, ra.team FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.role = 'RM' AND ra.active AND s.status = 'ACTIVE' AND s.id <> $1 ORDER BY s.full_name`, [staffId])).rows;
  const afsApplies = !!rules?.afs?.thresholdKobo && Number(data.requestedAmountKobo ?? 0) > rules.afs.thresholdKobo;
  const evidence = docs.filter((d) => ["EXCEPTION_EVIDENCE", "AFS", "BUSINESS_OPERATIONS_EVIDENCE", "BANK_STATEMENT"].includes(d.category) && d.scan_status === "CLEAN").map((d) => ({ id: d.id, label: `${CATEGORY_LABEL[d.category]}: ${d.filename}` }));
  const pre = readiness.preliminary;
  const credit = await retailCreditStatus(db, app.id, now);
  return (
    <>
      {header}
      <RetailDraftForm
        applicationId={app.id}
        taskId={myTask?.id ?? ""}
        ref_={app.ref}
        productName={readiness.productName}
        profile={app.customer_profile}
        profileLabel={PROFILE_LABELS[app.customer_profile as CustomerProfile]}
        applicantType={app.applicant_type}
        initiatorRole={app.initiator_role}
        isCorrection={!!myTask}
        correction={openCorrection ? { by: openCorrection.requested_by_name, reason: openCorrection.reason, at: formatLagos(openCorrection.created_at), stage: STAGE_LABELS[openCorrection.from_stage as Stage] } : null}
        lockVersion={app.lock_version}
        savedAt={formatLagos(app.updated_at)}
        structure={app.financing_structure}
        structures={(rules?.structures ?? []).map((s) => ({ code: s.code, label: STRUCTURE_LABELS[s.code], rate: s.ratePercent ? `${s.ratePercent}%` : "rate not configured", insurance: s.insuranceBearer ? INSURANCE_LABELS[s.insuranceBearer] : "Insurance treatment not configured", convention: s.rateConvention ? RATE_CONVENTION_LABELS[s.rateConvention] : "Rate convention not configured (final calculation blocked)" }))}
        limits={{
          maxAmountKobo: rules?.maxAmountKobo ?? null,
          maxTenorMonths: rules?.maxTenorMonths ?? null,
          dsrMax: rules?.dsr.maxPercent ?? null,
          denominator: rules?.dsr.denominator ? DSR_DENOMINATOR_LABELS[rules.dsr.denominator].toLowerCase() : null,
          statementMonths: rules?.statementMonths ?? null,
          payslipMonths: rules?.payslipMonths ?? null,
          equityApplies: rules?.equityContribution.applies ?? null,
          equityMin: rules?.equityContribution.minPercent ?? null,
          assetCriteria: rules?.assetEligibility.criteria ?? null,
        }}
        assetProduct={!!readiness.config?.config.fulfilmentSteps.some((s) => s !== "POS_DEPLOYMENT")}
        beneficiaryRequired={!!readiness.config?.config.beneficiaryRequired}
        data={{
          text: {
            customerName: data.customerName,
            businessName: data.businessName,
            companyName: data.companyName,
            registrationNumber: data.registrationNumber,
            phone: data.phone,
            email: data.email,
            businessAddress: data.businessAddress,
            deliveryAddress: data.deliveryAddress,
            employerName: data.employerName,
            employmentConfirmationRef: data.employmentConfirmationRef,
            jobTitle: data.jobTitle,
            employmentStartDate: data.employmentStartDate,
            businessSector: data.businessSector,
            purpose: data.purpose,
            assetDescription: data.assetDescription,
            incomeBasisNote: data.incomeBasisNote,
            vendorId: data.vendorId ?? "",
            vendorAccountId: data.vendorAccountId ?? "",
            outletLocationId: data.outletLocationId ?? "",
            assignedRmId: data.assignedRmId ?? "",
          },
          money: {
            requestedAmountKobo: k2s(data.requestedAmountKobo),
            assetCostKobo: k2s(data.assetCostKobo),
            equityContributionKobo: k2s(data.equityContributionKobo),
            incomeBasisKobo: k2s(data.incomeBasisKobo),
            proposedMonthlyObligationKobo: k2s(data.proposedMonthlyObligationKobo),
            statedMonthlySalaryKobo: k2s(data.statedMonthlySalaryKobo),
            statedMonthlyTurnoverKobo: k2s(data.statedMonthlyTurnoverKobo),
            turnoverForCapKobo: k2s(data.turnoverForCapKobo),
          },
          tenor: data.tenorMonths ? String(data.tenorMonths) : "",
          yearsInOperation: data.yearsInOperation !== null ? String(data.yearsInOperation) : "",
          obligations: data.existingObligations.map((o) => ({ lender: o.lender, facilityType: o.facilityType, monthly: k2s(o.monthlyRepaymentKobo), outstanding: k2s(o.outstandingKobo) })),
          salaryHistory: data.salaryHistory.map((s) => ({ month: s.month, amount: k2s(s.amountKobo) })),
          consents: data.consents,
        }}
        maskedBvn={version?.bvn_last4 ? maskWithLast4(version.bvn_last4) : null}
        maskedTin={version?.tin_last4 ? maskWithLast4(version.tin_last4, 10) : null}
        directors={(c.working ? (await db.query("SELECT id, full_name, bvn_last4 FROM application_directors WHERE version_id = $1 ORDER BY position", [c.working.id])).rows : c.directors).map((d: { id: string; full_name: string; bvn_last4: string }) => ({ id: d.id, fullName: d.full_name, masked: maskWithLast4(d.bvn_last4) }))}
        vendors={[...vendorMap.values()]}
        locations={locations.map((l) => ({ id: l.id, state: l.state, city: l.city, outletType: l.outlet_type, name: l.name, oss: l.oss_name ?? null }))}
        rms={rms.map((x: { id: string; full_name: string; team: string | null }) => ({ id: x.id, label: `${x.full_name}${x.team ? ` (${x.team})` : ""}` }))}
        privacyConsents={readiness.config?.config.privacyConsents ?? []}
        readiness={{
          ready: readiness.ready,
          fieldErrors: readiness.fieldErrors,
          blockers: readiness.blockers,
          matrix: readiness.matrix.map((m) => ({ code: m.code, label: m.label, requirement: m.requirement, status: m.status, detail: m.detail, note: m.note, applies: m.applies })),
          photos: readiness.photos ? { distinctAngles: readiness.photos.distinctAngles, required: readiness.photos.required, rmPhotoPresent: readiness.photos.rmPhotoPresent, rmPhotoRequired: readiness.photos.rmPhotoRequired } : null,
          proposal: { required: readiness.proposal.required, present: readiness.proposal.present, missing: readiness.proposal.missing, versionNo: readiness.proposal.versionNo },
          preliminary: pre ? { result: pre.result, dsr: pre.dsr?.percent ?? null, maxPercent: pre.dsr?.maxPercent ?? rules?.dsr.maxPercent ?? null, formula: pre.formula, checks: pre.checks, source: pre.obligationSource, monthly: pre.proposedMonthlyDisplay } : null,
          beneficiary: readiness.beneficiary ? { bank: readiness.beneficiary.institutionName, number: readiness.beneficiary.accountNumber, name: readiness.beneficiary.accountName, status: readiness.beneficiary.verificationStatus, vendor: readiness.beneficiary.vendorName, paymentSupported: readiness.beneficiary.paymentSupported } : null,
        }}
      />
      <div className="form-after stack">
        <CreditCheckPanel persons={credit} action={retailCreditAction} hidden={{ applicationId: app.id }} canRun subjectNoun="the customer" />
        {proposalCard}
        {uploads}
        {readiness.config?.config.beneficiaryRequired && (
          <details className="card">
            <summary style={{ cursor: "pointer", fontWeight: 700 }}>Vendor or account not in the register?</summary>
            <div style={{ marginTop: 12 }}>
              <BeneficiaryProposalForm
                applicationId={app.id}
                vendors={[...vendorMap.values()].map((v) => ({ value: v.vendorId, label: v.vendorName }))}
                institutions={institutions.map((i) => ({ value: i.id, label: i.name, aliases: i.aliases, hint: `${i.category.toLowerCase().replace("_", " ")}${i.payment_supported ? "" : " · payment route not supported"}${i.regulatory_status === "CONFIRMED_ACTIVE" ? "" : " · licence status unconfirmed"}` }))}
              />
            </div>
          </details>
        )}
        {(afsApplies || rules?.dsr.exceptionAllowed) && (
          <section className="card" aria-labelledby="h-ex">
            <h2 id="h-ex">Exceptions</h2>
            {readiness.exceptions.length > 0 && (
              <ul className="small">
                {readiness.exceptions.map((e) => (
                  <li key={e.id}>
                    {e.type}: <span className={`badge ${e.status === "APPROVED" ? "badge-green" : e.status === "DECLINED" ? "badge-red" : "badge-warn"}`}>{e.status.toLowerCase()}</span> {e.reason}
                    {e.decision_note ? ` · decision: ${e.decision_note}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {afsApplies && (rules?.afs?.exceptionApproverRole ? <ExceptionRequestForm applicationId={app.id} type="AFS" evidence={evidence} authority={roleLabel(rules.afs.exceptionApproverRole)} /> : <p className="blocked small">AFS is required above the threshold. The AFS exception authority is not configured, so an exception cannot be requested yet.</p>)}
            {rules?.dsr.exceptionAllowed && rules.dsr.exceptionApproverRole && <ExceptionRequestForm applicationId={app.id} type="DSR" evidence={evidence} authority={roleLabel(rules.dsr.exceptionApproverRole)} />}
          </section>
        )}
      </div>
    </>
  );
}
