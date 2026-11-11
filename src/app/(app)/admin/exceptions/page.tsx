import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { eligibleForTask } from "@/server/domain/admin";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { formatDuration, formatLagos } from "@/server/time";
import { AssignForm } from "../AdminForms";

export const metadata = { title: "Assignment exceptions" };

export default async function Exceptions({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const unassigned = (
    await db.query(
      `SELECT t.*, a.ref, a.customer_name FROM tasks t JOIN applications a ON a.id = t.application_id WHERE t.status = 'OPEN' AND t.assignee_id IS NULL ORDER BY t.entered_at`,
    )
  ).rows;
  const lookup = sp.ref
    ? (await db.query(`SELECT t.*, a.ref, a.customer_name, s.full_name AS assignee_name FROM tasks t JOIN applications a ON a.id = t.application_id LEFT JOIN staff s ON s.id = t.assignee_id WHERE t.status = 'OPEN' AND upper(a.ref) = upper($1)`, [sp.ref])).rows[0]
    : null;
  const rows = await Promise.all(unassigned.map(async (t) => ({ t, eligible: await eligibleForTask(t.id) })));
  const lookupEligible = lookup ? await eligibleForTask(lookup.id) : [];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Assignment exceptions</h1>
          <p>Stages with no active, eligible assignee. A stage can never be skipped: provision or grant the role, then assign. Only eligible officers (role, status, separation of duties) are offered.</p>
        </div>
      </div>
      {rows.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>No unassigned stages.</p></div>}
      {rows.map(({ t, eligible }) => (
        <div className="card" key={t.id}>
          <div className="card-head">
            <h2><span className="mono">{t.ref}</span> · {t.customer_name}</h2>
            <span className="badge badge-red">Waiting {formatDuration(Date.now() - new Date(t.entered_at).getTime())}</span>
          </div>
          <p className="small">{STAGE_LABELS[t.stage as Stage]} · requires {ROLE_LABELS[t.assignee_role as Role] ?? t.assignee_role} · since {formatLagos(t.entered_at)}{t.assignment_note ? ` · ${t.assignment_note}` : ""}</p>
          <AssignForm taskId={t.id} eligible={eligible.map((e) => ({ value: e.staff_id, label: `${e.full_name} (${ROLE_LABELS[e.role]})` }))} />
        </div>
      ))}
      <div className="card">
        <h2>Hand over an assigned task</h2>
        <form method="get" className="row" style={{ alignItems: "end" }}>
          <div className="field"><label htmlFor="ref">Request ID</label><input id="ref" name="ref" defaultValue={sp.ref ?? ""} placeholder="ARAF-2026-001001" /></div>
          <button className="btn">Find</button>
        </form>
        {sp.ref && !lookup && <p className="small muted">No open task found for that request.</p>}
        {lookup && (
          <div className="stack" style={{ marginTop: 12 }}>
            <p className="small" style={{ margin: 0 }}>
              <Link href={`/admin/audit?ref=${lookup.ref}`}>{lookup.ref}</Link> · {STAGE_LABELS[lookup.stage as Stage]} · currently {lookup.assignee_name ?? "unassigned"}
            </p>
            <AssignForm taskId={lookup.id} eligible={lookupEligible.filter((e) => e.staff_id !== lookup.assignee_id).map((e) => ({ value: e.staff_id, label: `${e.full_name} (${ROLE_LABELS[e.role]})` }))} />
          </div>
        )}
      </div>
    </>
  );
}
