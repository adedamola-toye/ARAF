import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { rerouteOptionsForTask } from "@/server/domain/admin";
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
  const rows = await Promise.all(unassigned.map(async (t) => ({ t, eligible: await rerouteOptionsForTask(t.id) })));
  const lookupEligible = lookup ? await rerouteOptionsForTask(lookup.id) : [];
  const option = (e: { staff_id: string; full_name: string; role: Role; in_scope: boolean }) => ({
    value: e.staff_id,
    label: `${e.full_name} (${ROLE_LABELS[e.role] ?? e.role})${e.in_scope ? "" : " — other state/team"}`,
  });
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
          {eligible.length === 0 && <p className="small muted" role="status">Nobody holds the required role for this stage yet. Grant the role (state-specific or general) first.</p>}
          {eligible.some((e) => !e.in_scope) && (
            <p className="small muted" style={{ margin: 0 }}>
              Officers outside the request&apos;s state/team are also listed (they hold the required role). Choosing one overrides the state/team scope.
            </p>
          )}
          <AssignForm taskId={t.id} eligible={eligible.map(option)} />
        </div>
      ))}
      <div className="card">
        <h2>Reroute any open case</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Enter the request ID to hand an assigned or waiting case to another officer. The dropdown lists officers in the request&apos;s state/team first, then any other holder of the required role.
        </p>
        <form method="get" className="row" style={{ alignItems: "end" }}>
          <div className="field"><label htmlFor="ref">Request ID</label><input id="ref" name="ref" defaultValue={sp.ref ?? ""} placeholder="ARAF-2026-001001" /></div>
          <button className="btn">Find</button>
        </form>
        {sp.ref && !lookup && <p className="small muted">No open task found for that request.</p>}
        {lookup && (
          <div className="stack" style={{ marginTop: 12 }}>
            <p className="small" style={{ margin: 0 }}>
              <Link href={`/requests/${lookup.application_id}`}>{lookup.ref}</Link> · {STAGE_LABELS[lookup.stage as Stage]} · currently {lookup.assignee_name ?? "unassigned"}
              {" · "}
              <Link className="muted" href={`/admin/audit?ref=${lookup.ref}`}>audit trail</Link>
            </p>
            <h3 style={{ fontSize: 15, margin: 0 }}>Reroute to an officer</h3>
            <p className="small muted" style={{ margin: 0 }}>The officer must hold the role required by this stage. Officers outside the request&apos;s state/team are shown last and override the scope.</p>
            {lookupEligible.filter((e) => e.staff_id !== lookup.assignee_id).length === 0 && (
              <p className="small muted" role="status">No other holder of the required role exists. Grant the role first, or check the state/team scope.</p>
            )}
            <AssignForm taskId={lookup.id} eligible={lookupEligible.filter((e) => e.staff_id !== lookup.assignee_id).map(option)} />
          </div>
        )}
      </div>
    </>
  );
}
