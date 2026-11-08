"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { createDraftAction } from "../actions";

const TYPES = [
  { v: "INDIVIDUAL", t: "Individual", d: "A person trading in their own name. BVN required." },
  { v: "ENTERPRISE", t: "Enterprise", d: "Business name registration: proprietor legal name and registered business name." },
  { v: "LIMITED", t: "Limited", d: "Limited company: company name and every director with their BVN." },
];

export function NewRequestForm({ roles, defaultRole }: { roles: { value: string; label: string }[]; defaultRole: string }) {
  return (
    <ActionForm action={createDraftAction} refreshOnSuccess={false}>
      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 700, marginBottom: 8 }}>Applicant type</legend>
        <div className="choice-grid">
          {TYPES.map((t, i) => (
            <label key={t.v} className="type-card">
              <input type="radio" name="applicantType" value={t.v} defaultChecked={i === 0} required />
              <span className="choice">
                <strong>{t.t}</strong>
                <span>{t.d}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {roles.length > 1 ? (
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="initiatorRole">Initiate as</label>
          <select id="initiatorRole" name="initiatorRole" defaultValue={defaultRole}>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="initiatorRole" value={roles[0].value} />
      )}
      <div>
        <SubmitButton>Create draft</SubmitButton>
      </div>
    </ActionForm>
  );
}
