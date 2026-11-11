import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { listServiceTargets } from "@/server/domain/sla";
import { STAGES, STAGE_LABELS, TERMINAL_STAGES } from "@/server/domain/stages";
import { PageHeader } from "@/components/PageHeader";
import { ServiceTargetForm } from "../RetailAdminForms";

export const metadata = { title: "Service targets" };

export default async function ServiceTargets() {
  await requireSuperAdmin();
  const targets = await listServiceTargets(db);
  const staff = (await db.query("SELECT id, full_name, email FROM staff WHERE status = 'ACTIVE' ORDER BY full_name")).rows.map((s: { id: string; full_name: string; email: string }) => ({ id: s.id, label: `${s.full_name} (${s.email})` }));
  const stages = STAGES.filter((s) => s !== "DRAFT" && !TERMINAL_STAGES.includes(s));
  return (
    <>
      <PageHeader eyebrow="Administration" title="Service targets and escalation" intro="Set a target (hours from entering the stage) and who is escalated to. No targets are assumed; a stage without a target is never escalated. The task owner is always copied; each overdue task is escalated once." />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Stage</th><th>Target and escalation recipients (blank hours removes the target)</th></tr></thead>
          <tbody>
            {stages.map((s) => {
              const t = targets.find((x) => x.stage === s);
              return (
                <tr key={s}>
                  <td>{STAGE_LABELS[s]}{t ? <div className="small muted">{t.target_hours} h · {t.escalation_staff_ids.length} recipient(s)</div> : <div className="small muted">no target</div>}</td>
                  <td><ServiceTargetForm stage={s} hours={t?.target_hours ?? null} recipients={t?.escalation_staff_ids ?? []} staff={staff} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
