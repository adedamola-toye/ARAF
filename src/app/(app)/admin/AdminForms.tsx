"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import * as A from "./actions";

type Opt = { value: string; label: string };

export function ProvisionForm({ regions, roles }: { regions: string[]; roles: Opt[] }) {
  return (
    <ActionForm action={A.provisionAction} refreshOnSuccess={false}>
      <div className="grid-2">
        <div className="field"><label htmlFor="email">Work email (@altbank.ng, must exist in bank directory)</label><input id="email" name="email" type="email" required /></div>
        <div className="field"><label htmlFor="fullName">Full name</label><input id="fullName" name="fullName" required /></div>
        <div className="field"><label htmlFor="role">Role</label><select id="role" name="role"><option value="">No role yet</option>{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
        <div className="field"><label htmlFor="region">State</label><select id="region" name="region"><option value="">None</option>{regions.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div className="field"><label htmlFor="businessUnit">Business unit</label><input id="businessUnit" name="businessUnit" /></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>ANM roles require a state. Legal and Shariah reviewers must first be added to their recipient group.</p>
      <div><SubmitButton>Provision staff</SubmitButton></div>
    </ActionForm>
  );
}

export function GrantRoleForm({ staffId, roles, regions }: { staffId: string; roles: Opt[]; regions: string[] }) {
  return (
    <ActionForm action={A.grantRoleAction} resetOnSuccess>
      <input type="hidden" name="staffId" value={staffId} />
      <div className="grid-3">
        <div className="field"><label htmlFor="role">Role</label><select id="role" name="role" required>{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
        <div className="field"><label htmlFor="gregion">State scope</label><select id="gregion" name="region"><option value="">Staff default / none</option>{regions.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div className="field"><label htmlFor="gbu">Business unit</label><input id="gbu" name="businessUnit" /></div>
      </div>
      <div><SubmitButton className="btn btn-dark">Grant role</SubmitButton></div>
    </ActionForm>
  );
}

export function RevokeRoleButton({ staffId, role }: { staffId: string; role: string }) {
  return (
    <ActionForm action={A.revokeRoleAction} className="row">
      <input type="hidden" name="staffId" value={staffId} />
      <input type="hidden" name="role" value={role} />
      <SubmitButton className="btn btn-sm btn-danger">Revoke</SubmitButton>
    </ActionForm>
  );
}

export function StatusButton({ staffId, status }: { staffId: string; status: string }) {
  const next = status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
  return (
    <ActionForm action={A.statusAction}>
      <input type="hidden" name="staffId" value={staffId} />
      <input type="hidden" name="status" value={next} />
      <div><SubmitButton className={`btn ${next === "SUSPENDED" ? "btn-danger" : "btn-primary"}`}>{next === "SUSPENDED" ? "Suspend access" : "Reactivate"}</SubmitButton></div>
    </ActionForm>
  );
}

export function GroupMemberForm({ group }: { group: string }) {
  return (
    <ActionForm action={A.addMemberAction} resetOnSuccess>
      <input type="hidden" name="group" value={group} />
      <div className="row" style={{ alignItems: "end" }}>
        <div className="field" style={{ flex: 1 }}><label htmlFor={`m-${group}`}>Add internal address</label><input id={`m-${group}`} name="email" type="email" required /></div>
        <SubmitButton className="btn btn-dark">Add</SubmitButton>
      </div>
    </ActionForm>
  );
}
export function RemoveMemberButton({ group, email }: { group: string; email: string }) {
  return (
    <ActionForm action={A.removeMemberAction} className="row" showMessages={false}>
      <input type="hidden" name="group" value={group} />
      <input type="hidden" name="email" value={email} />
      <SubmitButton className="btn btn-sm btn-ghost">Remove</SubmitButton>
    </ActionForm>
  );
}

export function AssignForm({ taskId, eligible }: { taskId: string; eligible: Opt[] }) {
  if (!eligible.length) return <p className="small err">No eligible officer exists. Provision or grant the required role first.</p>;
  return (
    <ActionForm action={A.assignTaskAction}>
      <input type="hidden" name="taskId" value={taskId} />
      <div className="grid-2">
        <div className="field"><label htmlFor={`s-${taskId}`}>Assign to (eligible only)</label><select id={`s-${taskId}`} name="staffId">{eligible.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select></div>
        <div className="field"><label htmlFor={`n-${taskId}`}>Reason</label><input id={`n-${taskId}`} name="note" required minLength={3} /></div>
      </div>
      <div><SubmitButton className="btn btn-primary btn-sm">Assign</SubmitButton></div>
    </ActionForm>
  );
}

export function TemplateForm({ defaultBody }: { defaultBody: string }) {
  return (
    <ActionForm action={A.createTemplateAction}>
      <div className="grid-2">
        <div className="field"><label htmlFor="tname">Template name</label><input id="tname" name="name" required defaultValue="WakeelBoost Offer" /></div>
        <div className="field"><label htmlFor="tnotes">Notes / approval reference</label><input id="tnotes" name="notes" /></div>
      </div>
      <div className="field"><label htmlFor="tbody">Template HTML (placeholders required)</label><textarea id="tbody" name="bodyHtml" required defaultValue={defaultBody} style={{ minHeight: 280, fontFamily: "monospace", fontSize: 13 }} /></div>
      <label className="check"><input type="checkbox" name="productionApproved" /> This is the bank-approved template (required for production offers)</label>
      <div><SubmitButton className="btn btn-dark">Save new version</SubmitButton></div>
    </ActionForm>
  );
}
export function ActivateTemplateButton({ templateId }: { templateId: string }) {
  return (
    <ActionForm action={A.activateTemplateAction} className="row">
      <input type="hidden" name="templateId" value={templateId} />
      <SubmitButton className="btn btn-sm btn-primary">Activate</SubmitButton>
    </ActionForm>
  );
}

export function ScheduleForm({ s, staff }: { s: { enabled: boolean; day_of_month: number; hour: number; minute: number; recipient_staff_ids: string[] }; staff: Opt[] }) {
  return (
    <ActionForm action={A.scheduleAction}>
      <label className="check"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> Monthly summary enabled</label>
      <div className="grid-3">
        <div className="field"><label htmlFor="dom">Day of month (1–28)</label><input id="dom" name="dayOfMonth" type="number" min={1} max={28} defaultValue={s.day_of_month} /></div>
        <div className="field"><label htmlFor="hr">Hour (Lagos, 0–23)</label><input id="hr" name="hour" type="number" min={0} max={23} defaultValue={s.hour} /></div>
        <div className="field"><label htmlFor="mn">Minute</label><input id="mn" name="minute" type="number" min={0} max={59} defaultValue={s.minute} /></div>
      </div>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12 }}>
        <legend className="small" style={{ fontWeight: 700 }}>Recipients (leave all unchecked to use the default: Credit Leads, MO Lead, ANM Leads and Unit Head)</legend>
        <div className="grid-2">
          {staff.map((x) => (
            <label key={x.value} className="check"><input type="checkbox" name="recipients" value={x.value} defaultChecked={s.recipient_staff_ids.includes(x.value)} /> {x.label}</label>
          ))}
        </div>
      </fieldset>
      <div><SubmitButton className="btn btn-dark">Save schedule</SubmitButton></div>
    </ActionForm>
  );
}

export function RetryButton({ id }: { id: string }) {
  return (
    <ActionForm action={A.retryOutboxAction} className="row" showMessages={false}>
      <input type="hidden" name="outboxId" value={id} />
      <SubmitButton className="btn btn-sm">Retry</SubmitButton>
    </ActionForm>
  );
}

export function UploadTemplateForm() {
  return (
    <ActionForm action={A.uploadTemplateAction} resetOnSuccess encType="multipart/form-data">
      <div className="grid-3">
        <div className="field">
          <label htmlFor="ut-type">Applicant type</label>
          <select id="ut-type" name="applicantType" required defaultValue="">
            <option value="" disabled>Choose…</option>
            <option value="INDIVIDUAL">Individual</option>
            <option value="ENTERPRISE">Enterprise</option>
            <option value="LIMITED">Limited (Corporate)</option>
          </select>
        </div>
        <div className="field"><label htmlFor="ut-name">Template name</label><input id="ut-name" name="name" required placeholder="Murabaha Individual Offer" /></div>
        <div className="field"><label htmlFor="ut-notes">Notes / approval reference</label><input id="ut-notes" name="notes" /></div>
      </div>
      <div className="field"><label htmlFor="ut-file">Word template (.docx with placeholders)</label><input id="ut-file" type="file" name="file" accept=".docx" required /></div>
      <label className="check"><input type="checkbox" name="productionApproved" /> This version is approved by the bank for production offers</label>
      <div><SubmitButton className="btn btn-dark">Upload new version</SubmitButton></div>
    </ActionForm>
  );
}
export function ApproveTemplateButton({ templateId }: { templateId: string }) {
  return (
    <ActionForm action={A.approveTemplateAction} className="row">
      <input type="hidden" name="templateId" value={templateId} />
      <SubmitButton className="btn btn-sm">Approve for production</SubmitButton>
    </ActionForm>
  );
}

export function PricingSettingsForm({ current }: { current: { maxTenorMonths: number; shortRatePercent: string; longRatePercent: string } }) {
  return (
    <ActionForm action={A.pricingSettingsAction}>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="ps-max">Maximum tenor (months, 1–6)</label>
          <input id="ps-max" name="maxTenorMonths" type="number" min={1} max={6} step={1} defaultValue={current.maxTenorMonths} required />
        </div>
        <div className="field">
          <label htmlFor="ps-short">1–3 months flat rate (%)</label>
          <input id="ps-short" name="shortRatePercent" defaultValue={current.shortRatePercent} inputMode="decimal" required />
        </div>
        <div className="field">
          <label htmlFor="ps-long">4 months and above flat rate (%)</label>
          <input id="ps-long" name="longRatePercent" defaultValue={current.longRatePercent} inputMode="decimal" required />
        </div>
        <div className="field">
          <label htmlFor="ps-eff">Effective from (Lagos time, blank = now)</label>
          <input id="ps-eff" name="effectiveFrom" type="datetime-local" />
        </div>
        <div className="field" style={{ gridColumn: "span 2" }}>
          <label htmlFor="ps-reason">Reason (recorded in the audit trail)</label>
          <input id="ps-reason" name="reason" required minLength={5} />
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Changes apply prospectively. Approved facilities and saved assessments keep the settings they were priced under; drafts priced under older settings are flagged for recalculation.</p>
      <div><SubmitButton className="btn btn-dark">Save new settings version</SubmitButton></div>
    </ActionForm>
  );
}

export function SignatoryForm({ current }: { current: { name: string; title: string } }) {
  return (
    <ActionForm action={A.signatoryAction}>
      <div className="grid-3">
        <div className="field"><label htmlFor="sg-name">Second signatory name</label><input id="sg-name" name="name" defaultValue={current.name} required /></div>
        <div className="field"><label htmlFor="sg-title">Title</label><input id="sg-title" name="title" defaultValue={current.title} required /></div>
        <div className="field"><label htmlFor="sg-reason">Reason</label><input id="sg-reason" name="reason" required minLength={5} /></div>
      </div>
      <div><SubmitButton className="btn btn-dark">Save signatory</SubmitButton></div>
    </ActionForm>
  );
}
