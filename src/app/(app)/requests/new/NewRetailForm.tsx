"use client";
import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { createRetailDraftAction } from "../retail-actions";

export interface CatalogueProduct {
  code: string;
  name: string;
  description: string;
  configVersion: number;
  profiles: {
    code: string;
    label: string;
    eligibleTypes: string[];
    note: string | null;
    limits: string;
    structures: { code: string; label: string; rate: string; convention: string; insurance: string }[];
    blocked: string[];
    laterBlocks: string[];
  }[];
}

const TYPE_LABELS: Record<string, { t: string; d: string }> = {
  INDIVIDUAL: { t: "Individual", d: "A person (salary earner or unregistered trader). BVN required." },
  ENTERPRISE: { t: "Enterprise (business name)", d: "Registered business name: proprietor and business details, CAC." },
  LIMITED: { t: "Limited company", d: "Incorporated company with directors and their BVNs, CAC." },
};

export function NewRetailForm({ products, roles, defaultRole }: { products: CatalogueProduct[]; roles: { value: string; label: string }[]; defaultRole: string }) {
  const [product, setProduct] = useState(products[0]?.code ?? "");
  const p = products.find((x) => x.code === product);
  const [profile, setProfile] = useState(p?.profiles[0]?.code ?? "");
  const prof = p?.profiles.find((x) => x.code === profile) ?? p?.profiles[0];
  const [type, setType] = useState(prof?.eligibleTypes[0] ?? "");
  const [structure, setStructure] = useState(prof?.structures[0]?.code ?? "");
  const types = useMemo(() => prof?.eligibleTypes ?? [], [prof]);
  const choose = (code: string) => {
    setProduct(code);
    const np = products.find((x) => x.code === code);
    const f = np?.profiles[0];
    setProfile(f?.code ?? "");
    setType(f?.eligibleTypes[0] ?? "");
    setStructure(f?.structures[0]?.code ?? "");
  };
  const chooseProfile = (code: string) => {
    setProfile(code);
    const f = p?.profiles.find((x) => x.code === code);
    setType(f?.eligibleTypes[0] ?? "");
    setStructure(f?.structures[0]?.code ?? "");
  };
  return (
    <ActionForm action={createRetailDraftAction} refreshOnSuccess={false} className="stack new-request">
      <fieldset className="step">
        <legend>
          <span className="step-no">1</span> Product
        </legend>
        <div className="choice-grid">
          {products.map((x) => (
            <label key={x.code} className="type-card">
              <input type="radio" name="productCode" value={x.code} checked={product === x.code} onChange={() => choose(x.code)} />
              <span className="choice">
                <strong>{x.name}</strong>
                <span>{x.description}</span>
                <span className="small muted">Configuration v{x.configVersion}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {p && (
        <fieldset className="step">
          <legend>
            <span className="step-no">2</span> Customer profile
          </legend>
          <div className="choice-grid">
            {p.profiles.map((x) => (
              <label key={x.code} className="type-card">
                <input type="radio" name="profile" value={x.code} checked={profile === x.code} onChange={() => chooseProfile(x.code)} />
                <span className="choice">
                  <strong>{x.label}</strong>
                  {x.note && <span>{x.note}</span>}
                  <span className="small muted">{x.limits}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {prof && (
        <fieldset className="step">
          <legend>
            <span className="step-no">3</span> Customer type
          </legend>
          <div className="choice-grid">
            {types.map((t) => (
              <label key={t} className="type-card">
                <input type="radio" name="applicantType" value={t} checked={type === t} onChange={() => setType(t)} />
                <span className="choice">
                  <strong>{TYPE_LABELS[t]?.t ?? t}</strong>
                  <span>{TYPE_LABELS[t]?.d}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {prof && prof.structures.length > 0 && (
        <fieldset className="step">
          <legend>
            <span className="step-no">4</span> Financing structure
          </legend>
          <div className="choice-grid">
            {prof.structures.map((s) => (
              <label key={s.code} className="type-card">
                <input type="radio" name="structure" value={s.code} checked={structure === s.code} onChange={() => setStructure(s.code)} />
                <span className="choice">
                  <strong>
                    {s.label} · {s.rate}
                  </strong>
                  <span>{s.insurance}</span>
                  <span className="small muted">{s.convention}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {prof && prof.structures.length === 0 && <input type="hidden" name="structure" value="" />}
      {prof && prof.blocked.length > 0 && (
        <div className="alert alert-warn" role="status">
          <AlertTriangle className="icon" aria-hidden="true" />
          <span>
            <strong>Submission is blocked until the bank configures:</strong> {prof.blocked.join("; ")}. You can create and save the draft now; it stays visibly blocked until the configuration is approved.
          </span>
        </div>
      )}
      {prof && prof.laterBlocks.length > 0 && <p className="small muted" style={{ margin: 0 }}>Later steps awaiting configuration: {prof.laterBlocks.join(", ")}.</p>}
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
        <SubmitButton disabled={!product || !profile || !type}>Create draft</SubmitButton>
      </div>
    </ActionForm>
  );
}
