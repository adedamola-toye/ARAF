import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { onboardingStates } from "@/server/domain/onboarding";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { tourFor } from "@/lib/onboarding/tours";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { StartTourButton } from "@/components/Onboarding";

export const metadata = { title: "Help & Guides" };

export default async function HelpPage() {
  const { session, roles } = await requireUser();
  const states = await onboardingStates(db, session.staffId);
  const ws = session.activeRole;
  const ordered = [...new Set([ws, ...roles].filter(Boolean) as string[])];
  return (
    <>
      <PageHeader eyebrow="Help" title="Help & Guides" intro="Short walkthroughs of your workspace, built from what each of your roles can actually do. They only show you around; they never submit or approve anything." />
      <section className="card" aria-labelledby="h-guides">
        <h2 id="h-guides">Your guides</h2>
        <ul className="plain-list">
          {ordered.map((r) => {
            const st = states.find((x) => x.role === r);
            const steps = tourFor(r).length;
            const status = st?.completed_at ? `Completed ${formatLagos(st.completed_at)}` : st?.skipped_at ? `Skipped ${formatLagos(st.skipped_at)}` : st?.started_at ? "Started" : "Not taken yet";
            return (
              <li key={r} className="summary-box row" style={{ justifyContent: "space-between" }}>
                <span>
                  <strong>{ROLE_LABELS[r as Role] ?? r}</strong>
                  {r === ws && <span className="badge" style={{ marginLeft: 6 }}>Current workspace</span>}
                  <div className="small muted">
                    About {steps} steps · {status}
                  </div>
                </span>
                {r === ws ? <StartTourButton role={r} label={st?.completed_at ? "Replay tour" : "Take the tour"} /> : <span className="small muted">Switch to this workspace to take its tour</span>}
              </li>
            );
          })}
        </ul>
      </section>
      <section className="card" aria-labelledby="h-approve">
        <h2 id="h-approve">Approval verification</h2>
        <p style={{ marginTop: 0 }}>
          Before every approval, certification, recommendation or concurrence, ARAF shows a short checklist for your role. Tick each item to confirm you reviewed it; your decision and acknowledgement are recorded against your profile. Returning or rejecting needs only your reason. Ticking a box does not replace the actual review: every existing document, separation-of-duty and credit-policy check still applies.
        </p>
      </section>
    </>
  );
}
