import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { listTargets, targetAccess, TARGET_METRIC_LABELS } from "@/server/domain/performance";
import { formatKobo } from "@/server/money";
import { formatLagos, lagosDate } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { DecideTargetForm, ProposeTargetForm } from "./TargetForms";

export const metadata = { title: "Performance targets" };

const STATUS_BADGE: Record<string, string> = { APPROVED: "badge badge-green", PROPOSED: "badge badge-warn", REJECTED: "badge badge-red", WITHDRAWN: "badge", SUPERSEDED: "badge" };

export default async function TargetsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, ctx } = await requireUser();
  const DECIDED: Record<string, string> = { approved: "Target approved. It now applies.", replaced: "Target approved. It replaces the previous target, which stays in the history.", rejected: "Proposal rejected.", withdrawn: "Proposal withdrawn." };
  const decided = DECIDED[(await searchParams).decided ?? ""] ?? null;
  const access = await targetAccess(db, session.staffId);
  if (!access.propose && !access.approve) redirect("/forbidden");
  const targets = await listTargets(db);
  const people = (await db.query("SELECT DISTINCT s.id, s.full_name, ra.role, ra.team FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND s.status = 'ACTIVE' AND ra.role IN ('RM','TEAM_LEAD') ORDER BY s.full_name")).rows as { id: string; full_name: string; role: string; team: string | null }[];
  const teams = (await db.query("SELECT DISTINCT team FROM role_assignments WHERE active AND team IS NOT NULL ORDER BY team")).rows.map((r: { team: string }) => r.team);
  const thisMonth = lagosDate(ctx.now).slice(0, 7);
  const fmt = (t: (typeof targets)[number]) => (t.metric === "DISBURSED_VALUE" ? formatKobo(Number(t.target_value)) : Number(t.target_value).toLocaleString("en-NG"));
  return (
    <>
      <PageHeader eyebrow="Performance" title="Performance targets" intro="Monthly targets for Relationship Managers, Team Leads and teams. A target applies only after a different approver approves it; replacing a target keeps the earlier one in the history." />
      {decided && (
        <div className="alert alert-success" role="status">
          {decided}
        </div>
      )}
      {access.propose && (
        <section className="card" aria-labelledby="h-prop">
          <h2 id="h-prop">Propose a target</h2>
          <ProposeTargetForm month={thisMonth} people={people.map((p) => ({ id: p.id, label: `${p.full_name} · ${p.role === "RM" ? "Relationship Manager" : "Team Lead"}${p.team ? ` (${p.team})` : ""}` }))} teams={teams} />
        </section>
      )}
      <section className="card" aria-labelledby="h-list">
        <h2 id="h-list">Targets and history</h2>
        {targets.length === 0 ? (
          <p className="muted">No targets have been proposed yet. Until one is approved, summaries show &ldquo;Target not configured&rdquo;.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">For</th>
                  <th scope="col">Measure</th>
                  <th scope="col" className="num">Target</th>
                  <th scope="col">Status</th>
                  <th scope="col">Proposed</th>
                  <th scope="col">Decided</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td>{t.period_month.slice(0, 7)}</td>
                    <td>{t.scope_type === "STAFF" ? t.staff_name : `Team ${t.team}`}</td>
                    <td>{TARGET_METRIC_LABELS[t.metric]}</td>
                    <td className="num">{fmt(t)}</td>
                    <td>
                      <span className={STATUS_BADGE[t.status]}>{t.status.toLowerCase()}</span>
                    </td>
                    <td className="small">
                      {t.proposed_by_name}, {formatLagos(t.proposed_at)}
                      <div className="muted">{t.reason}</div>
                    </td>
                    <td className="small">
                      {t.decided_by_name ? `${t.decided_by_name}, ${formatLagos(t.decided_at)}` : "—"}
                      {t.decision_note && <div className="muted">{t.decision_note}</div>}
                    </td>
                    <td>
                      {t.status === "PROPOSED" && ((access.approve && t.proposed_by !== session.staffId && t.staff_id !== session.staffId) || t.proposed_by === session.staffId) ? (
                        <DecideTargetForm id={t.id} canDecide={access.approve && t.proposed_by !== session.staffId && t.staff_id !== session.staffId} canWithdraw={t.proposed_by === session.staffId} />
                      ) : (
                        <span className="small muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
