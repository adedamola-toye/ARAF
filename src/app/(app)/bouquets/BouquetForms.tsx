"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Shuffle, RefreshCw, Layers } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Money } from "@/components/Money";
import { assembleAction, concurAction, excludeAction, inspectAction, refreshAction, restoreAction, sampleAction } from "./actions";

export function BuildBouquet({ disabled }: { disabled: boolean }) {
  return (
    <ActionForm action={assembleAction} className="row">
      <SubmitButton disabled={disabled}>
        <Layers className="icon" aria-hidden="true" /> Build bouquet
      </SubmitButton>
    </ActionForm>
  );
}

export function RefreshBouquet() {
  return (
    <ActionForm action={refreshAction} className="row">
      <SubmitButton className="btn">
        <RefreshCw className="icon" aria-hidden="true" /> Refresh
      </SubmitButton>
    </ActionForm>
  );
}

export function SampleButton({ bouquetId }: { bouquetId: string }) {
  return (
    <ActionForm action={sampleAction} className="row">
      <input type="hidden" name="bouquetId" value={bouquetId} />
      <SubmitButton className="btn">
        <Shuffle className="icon" aria-hidden="true" /> Random sample
      </SubmitButton>
    </ActionForm>
  );
}

export interface MemberView {
  id: string;
  applicationId: string;
  ref: string;
  customer: string;
  product: string;
  amountKobo: string;
  status: "INCLUDED" | "EXCLUDED" | "CONCURRED" | "LEFT";
  inspected: string | null;
  sampled: boolean;
  exclusion: string | null;
  exclusionAction: string | null;
  changed: boolean;
  approvedBy: string | null;
}

const STATUS: Record<MemberView["status"], [string, string]> = {
  INCLUDED: ["Included", "badge-blue"],
  EXCLUDED: ["Excluded", "badge-warn"],
  CONCURRED: ["Concurred", "badge-green"],
  LEFT: ["Left the bouquet", ""],
};

export function MemberTable({ bouquetId, members, open, defaultExclusion }: { bouquetId: string; members: MemberView[]; open: boolean; defaultExclusion: string }) {
  const [q, setQ] = useState("");
  const [excluding, setExcluding] = useState<string | null>(null);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? members.filter((m) => `${m.ref} ${m.customer} ${m.product}`.toLowerCase().includes(t)) : members;
  }, [q, members]);
  return (
    <>
      <div className="field" style={{ maxWidth: 360 }}>
        <label htmlFor="bq-search">Search facilities</label>
        <input id="bq-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, reference or product" />
      </div>
      <div className="table-wrap">
        <table className="data responsive">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Product</th>
              <th className="num">Amount</th>
              <th>Approval</th>
              <th>Status</th>
              {open && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id}>
                <td data-label="Customer">
                  <Link href={`/requests/${m.applicationId}?bouquet=${bouquetId}&member=${m.id}`}>
                    <strong>{m.customer}</strong>
                  </Link>
                  <div className="small muted">{m.ref}</div>
                </td>
                <td data-label="Product">{m.product}</td>
                <td className="num" data-label="Amount">
                  <Money size="table" as="span" kobo={m.amountKobo} />
                </td>
                <td data-label="Approval" className="small">
                  {m.approvedBy ? `Unit Head: ${m.approvedBy}` : "Preceding approvals complete"}
                </td>
                <td data-label="Status">
                  <span className={`badge ${STATUS[m.status][1]}`}>{STATUS[m.status][0]}</span> {m.inspected && <span className="badge badge-green">Inspected</span>}{" "}
                  {m.sampled && !m.inspected && <span className="badge">Sampled</span>} {m.changed && <span className="badge badge-red">Changed: refresh</span>}
                  {m.exclusion && (
                    <div className="small muted">
                      {m.exclusion}
                      {m.exclusionAction ? ` · ${m.exclusionAction}` : ""}
                    </div>
                  )}
                </td>
                {open && (
                  <td>
                    {m.status === "INCLUDED" &&
                      (excluding === m.id ? (
                        <ActionForm action={excludeAction} className="stack">
                          <input type="hidden" name="memberId" value={m.id} />
                          <div className="field">
                            <label htmlFor={`ex-${m.id}`}>Reason for excluding</label>
                            <textarea id={`ex-${m.id}`} name="reason" rows={2} required minLength={10} />
                          </div>
                          <div className="field">
                            <label htmlFor={`exa-${m.id}`}>Then</label>
                            <select id={`exa-${m.id}`} name="exclusionAction" defaultValue={defaultExclusion}>
                              <option value="INDIVIDUAL_REVIEW">Hold for my individual review</option>
                              <option value="RETURN_FOR_CORRECTION">Return for credit correction</option>
                            </select>
                          </div>
                          <div className="row">
                            <SubmitButton className="btn btn-sm btn-danger">Exclude</SubmitButton>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExcluding(null)}>
                              Cancel
                            </button>
                          </div>
                        </ActionForm>
                      ) : (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExcluding(m.id)}>
                          Exclude
                        </button>
                      ))}
                    {m.status === "EXCLUDED" && m.exclusionAction === "Hold for my individual review" && (
                      <ActionForm action={restoreAction} className="row">
                        <input type="hidden" name="memberId" value={m.id} />
                        <SubmitButton className="btn btn-sm btn-ghost">Restore</SubmitButton>
                      </ActionForm>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={open ? 6 : 5} className="muted">
                  No facility matches “{q}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ConcurPanel({
  bouquetId,
  count,
  totalKobo,
  inspected,
  excluded,
  minInspections,
  ack,
}: {
  bouquetId: string;
  count: number;
  totalKobo: string;
  inspected: number;
  excluded: number;
  minInspections: number;
  ack: string;
}) {
  const [asking, setAsking] = useState(false);
  const short = inspected < minInspections;
  if (!asking)
    return (
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!count || short} onClick={() => setAsking(true)}>
          Concur with {count} facilit{count === 1 ? "y" : "ies"}
        </button>
        {short && (
          <span className="small muted">
            Inspect at least {minInspections} first (inspected: {inspected}).
          </span>
        )}
      </div>
    );
  return (
    <ActionForm action={concurAction} className="stack">
      <input type="hidden" name="bouquetId" value={bouquetId} />
      <input type="hidden" name="expectedCount" value={count} />
      <input type="hidden" name="expectedTotalKobo" value={totalKobo} />
      <div className="grid-2">
        <Money size="lg" label="Total included value" kobo={totalKobo} />
        <div className="stack small">
          <span>
            <strong>{count}</strong> included
          </span>
          <span>
            <strong>{inspected}</strong> individually inspected
          </span>
          <span>
            <strong>{excluded}</strong> excluded (they do not inherit this concurrence)
          </span>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" name="acknowledged" required /> {ack}
      </label>
      <div className="row">
        <SubmitButton>Confirm concurrence</SubmitButton>
        <button type="button" className="btn btn-ghost" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

/** Shown on the request page when opened from a bouquet. */
export function InspectForm({ bouquetId, memberId, inspected }: { bouquetId: string; memberId: string; inspected: boolean }) {
  return (
    <ActionForm action={inspectAction} className="stack">
      <input type="hidden" name="bouquetId" value={bouquetId} />
      <input type="hidden" name="memberId" value={memberId} />
      <div className="field">
        <label htmlFor="insp-note">Inspection note (optional)</label>
        <input id="insp-note" name="note" placeholder="e.g. Documents, assessment and approvals consistent" />
      </div>
      <div className="row">
        <SubmitButton>{inspected ? "Update inspection and return" : "Mark inspected and return to bouquet"}</SubmitButton>
        <Link className="btn btn-ghost" href={`/bouquets/${bouquetId}`}>
          Back to bouquet
        </Link>
      </div>
    </ActionForm>
  );
}
