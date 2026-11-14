"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { contractTypeAction, createProductAction, markupAction, tenorAction } from "./actions";

type Opt = { value: string; label: string };
const err = (f: Record<string, string> | undefined, k: string) => f?.[k] && <p className="err">{f[k]}</p>;

function Common({ fields, today }: { fields?: Record<string, string>; today: string }) {
  return (
    <div className="grid-2">
      <div className="field">
        <label htmlFor="effectiveFrom">Effective from</label>
        <input type="date" name="effectiveFrom" defaultValue={today} min={today} />
        {err(fields, "effectiveFrom")}
      </div>
      <div className="field">
        <label>Reason or policy reference</label>
        <input name="reason" placeholder="e.g. ALCO pricing review, Nov 2026" aria-invalid={!!fields?.reason} />
        {err(fields, "reason")}
      </div>
    </div>
  );
}

export function MarkupForm({ products, contractTypes, profiles, conventions, today }: { products: Opt[]; contractTypes: Opt[]; profiles: Opt[]; conventions: Opt[]; today: string }) {
  const [action, setAction] = useState<"SET" | "REMOVE">("SET");
  return (
    <ActionForm action={markupAction}>
      {(st) => (
        <>
          <div className="grid-4">
            <div className="field">
              <label htmlFor="mk-product">Product</label>
              <select id="mk-product" name="productCode" defaultValue="">
                <option value="">Choose…</option>
                {products.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mk-ct">Contract type</label>
              <select id="mk-ct" name="contractType" defaultValue="" aria-invalid={!!st.fields?.contractType}>
                <option value="">Choose…</option>
                {contractTypes.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              {err(st.fields, "contractType")}
            </div>
            <div className="field">
              <label htmlFor="mk-profile">Customer profile</label>
              <select id="mk-profile" name="profile" defaultValue="ALL">
                <option value="ALL">All profiles the product serves</option>
                {profiles.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              {err(st.fields, "profile")}
            </div>
            <div className="field">
              <label htmlFor="mk-action">Change</label>
              <select id="mk-action" name="action" value={action} onChange={(e) => setAction(e.target.value as "SET" | "REMOVE")}>
                <option value="SET">Set mark-up (adds the contract type if new)</option>
                <option value="REMOVE">Stop offering this contract type</option>
              </select>
            </div>
          </div>
          {action === "SET" && (
            <div className="grid-2">
              <div className="field">
                <label htmlFor="mk-pct">Mark-up (%)</label>
                <input id="mk-pct" name="markupPercent" inputMode="decimal" placeholder="e.g. 34 or 39.5" aria-invalid={!!st.fields?.markupPercent} />
                {err(st.fields, "markupPercent")}
              </div>
              <div className="field">
                <label htmlFor="mk-conv">How the mark-up relates to the tenor</label>
                <select id="mk-conv" name="rateConvention" defaultValue="">
                  <option value="">Keep the current setting</option>
                  {conventions.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
            </div>
          )}
          <Common fields={st.fields} today={today} />
          <div><SubmitButton>{action === "SET" ? "Propose mark-up" : "Propose removal"}</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}

export function TenorForm({ products, profiles, today }: { products: Opt[]; profiles: Opt[]; today: string }) {
  return (
    <ActionForm action={tenorAction}>
      {(st) => (
        <>
          <div className="grid-4">
            <div className="field">
              <label htmlFor="tn-product">Product</label>
              <select id="tn-product" name="productCode" defaultValue="">
                <option value="">Choose…</option>
                {products.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tn-profile">Customer profile</label>
              <select id="tn-profile" name="profile" defaultValue="ALL">
                <option value="ALL">All profiles the product serves</option>
                {profiles.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              {err(st.fields, "profile")}
            </div>
            <div className="field">
              <label htmlFor="tn-min">Minimum (months)</label>
              <input id="tn-min" name="minMonths" inputMode="numeric" placeholder="Empty = no minimum" aria-invalid={!!st.fields?.minMonths} />
              {err(st.fields, "minMonths")}
            </div>
            <div className="field">
              <label htmlFor="tn-max">Maximum (months)</label>
              <input id="tn-max" name="maxMonths" inputMode="numeric" aria-invalid={!!st.fields?.maxMonths} />
              {err(st.fields, "maxMonths")}
            </div>
          </div>
          <Common fields={st.fields} today={today} />
          <div><SubmitButton>Propose tenor</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}

export function ContractTypeForm({ value }: { value?: { code: string; name: string; description: string | null; active: boolean } }) {
  const isNew = !value;
  return (
    <ActionForm action={contractTypeAction} resetOnSuccess={isNew}>
      {(st) => (
        <>
          <input type="hidden" name="isNew" value={isNew ? "1" : "0"} />
          {!isNew && <input type="hidden" name="code" value={value.code} />}
          <div className="grid-3">
            <div className="field">
              <label>Name</label>
              <input name="name" defaultValue={value?.name ?? ""} placeholder="e.g. Musharakah" aria-invalid={!!st.fields?.name} />
              {err(st.fields, "name")}
            </div>
            {isNew && (
              <div className="field">
                <label>Code (optional)</label>
                <input name="code" placeholder="Derived from the name" aria-invalid={!!st.fields?.code} />
                {err(st.fields, "code")}
              </div>
            )}
            <div className="field">
              <label>Description</label>
              <input name="description" defaultValue={value?.description ?? ""} />
            </div>
            {!isNew && (
              <div className="field">
                <label>Status</label>
                <select name="active" defaultValue={value.active ? "true" : "false"}>
                  <option value="true">Active</option>
                  <option value="false">Inactive (no new mark-ups)</option>
                </select>
              </div>
            )}
          </div>
          <div><SubmitButton className={isNew ? "btn btn-primary" : "btn btn-sm"}>{isNew ? "Add contract type" : "Save"}</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}

export function NewProductForm({ products }: { products: Opt[] }) {
  return (
    <ActionForm action={createProductAction} resetOnSuccess>
      {(st) => (
        <>
          <div className="grid-3">
            <div className="field">
              <label>Product name</label>
              <input name="name" placeholder="e.g. Alt Solar" aria-invalid={!!st.fields?.name} />
              {err(st.fields, "name")}
            </div>
            <div className="field">
              <label>Code (optional)</label>
              <input name="code" placeholder="Derived from the name" aria-invalid={!!st.fields?.code} />
              {err(st.fields, "code")}
            </div>
            <div className="field">
              <label>Start from the rules of</label>
              <select name="copyFrom" defaultValue="" aria-invalid={!!st.fields?.copyFrom}>
                <option value="">Choose…</option>
                {products.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              {err(st.fields, "copyFrom")}
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label>Description</label>
              <input name="description" />
            </div>
            <div className="field">
              <label>Reason or policy reference</label>
              <input name="reason" aria-invalid={!!st.fields?.reason} />
              {err(st.fields, "reason")}
            </div>
          </div>
          <div><SubmitButton>Create product</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}
