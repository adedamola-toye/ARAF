import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { switchHistory, switchState, type SwitchKey } from "@/server/domain/switches";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { SwitchForm } from "./SwitchForm";

export const metadata = { title: "Feature controls" };

const EXPLAIN: Record<SwitchKey, { on: string[]; off: string[] }> = {
  VF_TL_PHOTO_REVIEW: {
    on: [
      "At RM Team Lead review of Vendor Financing, the Business Photograph Verification section is shown.",
      "The Team Lead uploads an existing photograph from the gallery or files, or skips it with a mandatory reason.",
      "A skip notifies the Unit Head (notification centre, queue, request page and email). It is never an automatic rejection.",
    ],
    off: ["No extra photograph step and no skip reason. Existing KYC, BVN and SeedFi controls are unchanged.", "Photographs and skip reasons already recorded are kept."],
  },
  BOUQUET_APPROVALS: {
    on: [
      "Divisional Heads can concur with a bouquet of facilities that every preceding officer has approved, after sampling and inspecting, with exclusions and a mandatory acknowledgement.",
      "Only products named in Bouquet settings take part; facilities with material exceptions always stay for individual review.",
      "Turn on only after the bank's risk governance has approved bouquet concurrence.",
    ],
    off: ["Every facility needs its own Divisional Head decision (current behaviour).", "Bouquets and their audit history are kept; an open bouquet cannot be concurred while this is off."],
  },
  REPAYMENT_TRACKER: {
    on: ["Leadership, credit and collections see Repayment monitoring (manual entries only while core banking is not connected)."],
    off: ["Only Super Admins see Repayment monitoring."],
  },
};

export default async function FeatureControls() {
  await requireSuperAdmin();
  const keys: SwitchKey[] = ["BOUQUET_APPROVALS", "VF_TL_PHOTO_REVIEW", "REPAYMENT_TRACKER"];
  const rows = await Promise.all(keys.map(async (k) => ({ k, s: await switchState(db, k), h: await switchHistory(db, k) })));
  return (
    <>
      <PageHeader eyebrow="Administration" title="Feature controls" intro="Switch controlled features on or off. Each change needs a reason and is recorded (previous value, new value, who and when). The server enforces each setting; a review already in progress keeps the setting it started with." />
      <div className="stack">
        {rows.map(({ k, s, h }) =>
          s ? (
            <section key={k} className="card" aria-labelledby={`h-${k}`}>
              <div className="card-head">
                <h2 id={`h-${k}`}>{s.label}</h2>
                <span className={`badge ${s.enabled ? "badge-green" : ""}`}>{s.enabled ? "ON" : "OFF"}</span>
              </div>
              <div className="grid-2">
                <div>
                  <p className="eyebrow">When ON</p>
                  <ul className="small">{EXPLAIN[k].on.map((t) => <li key={t}>{t}</li>)}</ul>
                </div>
                <div>
                  <p className="eyebrow">When OFF</p>
                  <ul className="small">{EXPLAIN[k].off.map((t) => <li key={t}>{t}</li>)}</ul>
                </div>
              </div>
              <SwitchForm k={k} enabled={s.enabled} />
              <details style={{ marginTop: "var(--space-3)" }}>
                <summary className="small">Change history ({h.length})</summary>
                {h.length ? (
                  <ul className="plain-list small">
                    {h.map((x, i) => (
                      <li key={i}>
                        {formatLagos(x.occurred_at)} · {x.actor ?? "system"} · {x.before ? "ON" : "OFF"} → {x.after ? "ON" : "OFF"}
                        {x.reason ? ` · ${x.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">Not changed since it was introduced.</p>
                )}
              </details>
            </section>
          ) : null,
        )}
      </div>
    </>
  );
}
