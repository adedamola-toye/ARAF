import { ShieldCheck } from "lucide-react";
import { ActionForm, SubmitButton } from "./forms";
import { formatLagos } from "@/server/time";
import type { FormState } from "./forms";
import type { CreditCheckRow } from "@/server/credit/seedfi";

export interface PanelPerson {
  key: string;
  label: string;
  bvnLast4: string | null;
  latest: CreditCheckRow | undefined;
  current: boolean;
}

const OUTCOME = { PASS: ["Pass", "badge-green"], FAIR: ["Fair", "badge-warn"], FAIL: ["Fail", "badge-red"] } as const;

function Result({ c }: { c: CreditCheckRow }) {
  if (c.status === "UNAVAILABLE")
    return (
      <div className="small">
        <span className="badge badge-warn">Integration unavailable — not assessed</span> <span className="muted">{c.error}</span>
      </div>
    );
  const [label, tone] = OUTCOME[c.outcome!];
  return (
    <div className="small">
      <span className={`badge ${tone}`}>{label}</span> Seed Score {Number(c.score)}
      {c.overall_score !== null && Number(c.overall_score) !== Number(c.score) && <> (overall {Number(c.overall_score)})</>}
      {c.has_history === false && <span className="muted"> · no credit history</span>}
      {c.details?.isDummyData && <> <span className="badge badge-warn">SeedFi test data</span></>}
      <span className="muted">
        {" "}
        · {formatLagos(c.created_at)}
        {c.details?.validUntil ? ` · valid until ${c.details.validUntil}` : ""}
      </span>
    </div>
  );
}

/**
 * SeedFi credit check panel (Pass and Fair continue; Fail closes the request). Used by the Relationship Manager
 * retail route (BVN from the saved draft) and Staff Request (the applicant enters their BVN).
 */
export function CreditCheckPanel({
  persons,
  action,
  hidden,
  canRun,
  askBvn = false,
  subjectNoun = "the customer",
}: {
  persons: PanelPerson[];
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  canRun: boolean;
  askBvn?: boolean;
  subjectNoun?: string;
}) {
  const done = persons.length > 0 && persons.every((p) => p.current);
  return (
    <section className="card action-panel stack" aria-labelledby="h-credit" id="credit-check">
      <div className="card-head">
        <h2 id="h-credit">
          <ShieldCheck className="icon" aria-hidden="true" /> SeedFi credit check
        </h2>
        <span className={`badge ${done ? "badge-green" : "badge-warn"}`}>{done ? "Done" : "Required before submission"}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Pass or Fair lets the request continue; Fail closes it. A Seed Score is valid for 30 days.
      </p>
      {persons.length === 0 && <p className="small">Save the BVN in the request first.</p>}
      {persons.map((p) => (
        <div key={p.key} className="credit-person">
          <div className="credit-person-head">
            <strong>{p.label}</strong>
            {p.bvnLast4 && <span className="small muted mono">BVN •••••••{p.bvnLast4}</span>}
          </div>
          {p.latest && <Result c={p.latest} />}
          {canRun && !p.current && p.latest?.outcome !== "FAIL" && (
            <ActionForm action={action} className="stack credit-form">
              {Object.entries({ ...hidden, personKey: p.key }).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <div className="grid-2">
                {askBvn && (
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label htmlFor={`bvn-${p.key}`}>BVN</label>
                    <input id={`bvn-${p.key}`} name="bvn" inputMode="numeric" pattern="[0-9]{11}" maxLength={11} required autoComplete="off" className="mono alt-bvn" />
                  </div>
                )}
                <div className="field">
                  <label htmlFor={`fn-${p.key}`}>First name (as on the BVN)</label>
                  <input id={`fn-${p.key}`} name="firstName" required autoComplete="off" defaultValue={p.latest?.first_name ?? ""} />
                </div>
                <div className="field">
                  <label htmlFor={`ln-${p.key}`}>Last name</label>
                  <input id={`ln-${p.key}`} name="lastName" required autoComplete="off" defaultValue={p.latest?.last_name ?? ""} />
                </div>
                <div className="field">
                  <label htmlFor={`dob-${p.key}`}>Date of birth</label>
                  <input id={`dob-${p.key}`} name="dateOfBirth" type="date" required />
                </div>
                <div className="field">
                  <label htmlFor={`g-${p.key}`}>Gender</label>
                  <select id={`g-${p.key}`} name="gender" required defaultValue="">
                    <option value="">As on the BVN record</option>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`ph-${p.key}`}>Phone number</label>
                  <input id={`ph-${p.key}`} name="phone" type="tel" required autoComplete="off" placeholder="0803 123 4567" />
                </div>
              </div>
              <label className="check">
                <input type="checkbox" name="consent" required /> {subjectNoun === "you" ? "I consent to a credit check with SeedFi." : `${subjectNoun.charAt(0).toUpperCase()}${subjectNoun.slice(1)} consents to a credit check with SeedFi.`}
              </label>
              <div className="action-bar">
                <SubmitButton>Run credit check</SubmitButton>
              </div>
            </ActionForm>
          )}
        </div>
      ))}
    </section>
  );
}

/** Read-only SeedFi result for reviewers. */
export function CreditSummary({ checks }: { checks: CreditCheckRow[] }) {
  if (!checks.length) return null;
  return (
    <section className="card stack" aria-labelledby="h-credit-sum">
      <h2 id="h-credit-sum" style={{ margin: 0 }}>
        <ShieldCheck className="icon" aria-hidden="true" /> SeedFi credit check
      </h2>
      {checks.map((c) => (
        <div key={c.id} className="credit-person">
          <div className="credit-person-head">
            <strong>{c.person_label}</strong>
            <span className="small muted mono">BVN •••••••{c.bvn_last4}</span>
          </div>
          <Result c={c} />
        </div>
      ))}
    </section>
  );
}
