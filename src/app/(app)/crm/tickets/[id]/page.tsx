import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { ticketDetail } from "@/server/crm/tickets";
import { canManage, canWork, isOversight, PRIORITY_LABELS } from "@/server/crm/core";
import { signAttachmentLink } from "@/server/crm/attachments";
import { handlingBreakdown } from "@/server/crm/analytics";
import { caseAccess } from "@/server/domain/access";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { formatDuration, formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { PriorityBadge, SlaCell, StatusBadge } from "../../ui";
import { TicketActions } from "./Actions";

export const metadata = { title: "Complaint ticket" };

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Complaint created",
  ROUTED: "Routed",
  ASSIGNED: "Assigned",
  REASSIGNED: "Reassigned",
  ASSIGNMENT_NOTE: "Assignment note",
  STARTED: "Investigation started",
  UPDATE: "Update",
  NOTE: "Internal note",
  INFO_REQUESTED: "Information requested",
  INFO_PROVIDED: "Information provided",
  RESUMED: "Resumed",
  TRANSFERRED: "Transferred",
  TRANSFER_REASON: "Transfer reason",
  ESCALATED: "Escalated",
  AUTO_ESCALATED: "Escalated automatically",
  ACTION_REQUESTED: "CX Head requested action",
  RESOLVED: "Marked resolved",
  CLOSED: "Closed",
  CLOSE_REASON: "Closure reason",
  REOPENED: "Reopened",
  ATTACHMENT: "File attached",
  LINKED: "Linked",
  PARENT_SET: "Parent ticket set",
};
const END_REASON: Record<string, string> = { ASSIGNED: "Assigned", REASSIGNED: "Reassigned", TRANSFERRED: "Transferred", CX_HEAD_OVERRIDE: "CX Head override", RESOLVED: "Resolved" };

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { session } = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const d = await ticketDetail(db, session.staffId, id);
  if (!d) notFound();
  const t = d.ticket;
  const p = d.principal;
  const full = d.view === "FULL";
  const now = Date.now();
  const link = (aid: string, m: "view" | "download") => signAttachmentLink(aid, session.staffId, session.sessionId, m);
  const canOpenRequest = t.application_id ? (await caseAccess(db, session.staffId, t.application_id)).canView : false;
  const manage = canManage(p, t);
  const work = canWork(p, t);
  const officers = manage
    ? (await db.query<{ id: string; name: string; role: string }>("SELECT s.id, s.full_name AS name, m.member_role AS role FROM crm_team_members m JOIN staff s ON s.id = m.staff_id AND s.status = 'ACTIVE' WHERE m.team_id = $1 AND m.active AND s.id <> $2 ORDER BY m.member_role DESC, s.full_name", [t.team_id, t.creator_id])).rows
    : [];
  const teams = work ? (await db.query<{ id: string; name: string }>("SELECT id, name FROM crm_teams WHERE active AND id <> $1 ORDER BY name", [t.team_id])).rows : [];
  const ownerSince = d.assignments.find((a) => !a.ended_at)?.started_at ?? null;
  const breakdown = full ? handlingBreakdown(d.assignments, new Date(now)) : null;
  const elapsed = (t.closed_at ? new Date(t.closed_at) : t.resolved_at ? new Date(t.resolved_at) : new Date(now)).getTime() - new Date(t.created_at).getTime();
  return (
    <>
      <PageHeader
        eyebrow={`CRM · ${t.ref}`}
        title={t.subject}
        crumbs={[{ href: "/crm", label: "CRM" }, { href: p.staffId === t.creator_id ? "/crm/tickets" : "/crm", label: p.staffId === t.creator_id ? "My Tickets" : "Tickets" }, { label: t.ref }]}
        intro={
          <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <StatusBadge status={t.status} escalated={t.escalated} /> <PriorityBadge p={t.priority} />
            <span className="small muted">
              {t.product_name} · {t.category_name} — {t.subcategory_name}
            </span>
          </span>
        }
      />
      {sp.created === "1" && (
        <div className="alert alert-success" role="status" style={{ marginBottom: "var(--space-4)" }}>
          <div>
            <strong>Complaint received: {t.ref}</strong>
            <div className="small">
              “{t.subject}” · status {t.status === "UNASSIGNED" ? "awaiting assignment" : t.status.toLowerCase()} · with {t.team_name} · submitted {formatLagos(t.created_at)} ·{" "}
              {t.resolution_due ? `resolution target ${formatLagos(t.resolution_due)}` : "no resolution target is configured for this issue yet"}. You can follow it under My Tickets.
            </div>
          </div>
        </div>
      )}
      <div className="split">
        <section className="stack" style={{ minWidth: 0 }}>
          <div className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Ticket reference</dt>
              <dd>{t.ref}</dd>
              <dt>Raised by</dt>
              <dd>
                {t.creator_name}
                {t.creator_role ? <span className="muted small"> · {ROLE_LABELS[t.creator_role as Role] ?? t.creator_role}</span> : null}
              </dd>
              <dt>Created</dt>
              <dd>{formatLagos(t.created_at)}</dd>
              <dt>Responsible team</dt>
              <dd>{t.team_name}</dd>
              <dt>Assigned officer</dt>
              <dd>{t.assignee_name ?? <span className="muted">Awaiting assignment</span>}</dd>
              <dt>Priority</dt>
              <dd>
                {PRIORITY_LABELS[t.priority]}
                {t.complainant_urgent && <span className="small muted"> · the complainant marked this urgent</span>}
              </dd>
              <dt>Resolution target</dt>
              <dd>
                <SlaCell due={t.resolution_due} status={t.status} now={now} paused={!!t.paused_at} />
                {t.resolution_due && !["RESOLVED", "CLOSED"].includes(t.status) && <span className="small muted"> · {formatLagos(t.resolution_due)}</span>}
              </dd>
              {full && (
                <>
                  <dt>Assignment / first response targets</dt>
                  <dd className="small">
                    {t.assignment_due ? formatLagos(t.assignment_due) : "—"} / {t.first_response_due ? formatLagos(t.first_response_due) : "—"}
                    {t.first_response_at && <> · first response {formatLagos(t.first_response_at)}</>}
                  </dd>
                </>
              )}
              <dt>Time with current owner</dt>
              <dd>{ownerSince && !["RESOLVED", "CLOSED"].includes(t.status) ? formatDuration(now - new Date(ownerSince).getTime()) : "—"}</dd>
              <dt>Total elapsed</dt>
              <dd>
                {formatDuration(elapsed)}
                {(t.reassign_count > 0 || t.reopen_count > 0) && (
                  <span className="small muted">
                    {" "}
                    · {t.reassign_count} reassignment(s), {t.reopen_count} reopening(s)
                  </span>
                )}
              </dd>
              {(t.related_ref || t.application_id) && (
                <>
                  <dt>Related financing request</dt>
                  <dd>
                    {canOpenRequest && t.application_id ? <Link href={`/requests/${t.application_id}`}>{t.related_ref}</Link> : t.related_ref}
                    {full && t.application_stage && <span className="small muted"> · stage when raised: {STAGE_LABELS[t.application_stage as Stage] ?? t.application_stage}</span>}
                  </dd>
                </>
              )}
              {t.parent_ref && (
                <>
                  <dt>Parent ticket</dt>
                  <dd>{t.parent_ref}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="card">
            <h2>Description</h2>
            <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{t.description}</p>
          </div>
          {t.resolution_summary && (
            <div className="card">
              <h2>Resolution</h2>
              <p style={{ whiteSpace: "pre-wrap" }}>{t.resolution_summary}</p>
              <p className="small muted" style={{ margin: 0 }}>
                {t.resolved_by_name ? `Resolved by ${t.resolved_by_name}` : "Resolved"}
                {t.resolved_at ? ` on ${formatLagos(t.resolved_at)}` : ""}
                {t.satisfaction ? ` · complainant rating ${t.satisfaction}/5` : ""}
              </p>
            </div>
          )}
          <div className="card">
            <h2>Attachments</h2>
            {d.attachments.length ? (
              <ul className="closing-list">
                {d.attachments.map((a) => (
                  <li key={a.id}>
                    <span className="closing-body">
                      <strong>{a.filename}</strong>
                      <span className="small muted">
                        {" "}
                        {a.uploaded_by_name} · {formatLagos(a.uploaded_at)}
                        {a.internal && " · internal"}
                        {a.purpose === "RESOLUTION" && " · resolution evidence"}
                      </span>
                    </span>
                    {a.scan_status === "CLEAN" ? (
                      <span className="row" style={{ gap: 6 }}>
                        <a className="btn btn-sm" href={link(a.id, "view")} target="_blank" rel="noopener noreferrer">
                          View
                        </a>
                        <a className="btn btn-sm" href={link(a.id, "download")}>
                          Download
                        </a>
                      </span>
                    ) : (
                      <span className={`badge ${a.scan_status === "REJECTED" ? "badge-red" : ""}`}>{a.scan_status === "REJECTED" ? "Failed malware scan" : "Being scanned"}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No files attached.</p>
            )}
          </div>
          <div className="card">
            <h2>Activity</h2>
            {!full && <p className="small muted">Internal notes of the handling team are not shown here.</p>}
            <ol className="timeline">
              {d.events.map((e) => (
                <li key={e.id} className={e.kind === "RESOLVED" || e.kind === "CLOSED" ? "done" : ""}>
                  <div className="small muted">
                    {formatLagos(e.at)} · {e.actor_name ?? "ARAF (automatic)"}
                    {e.visibility === "INTERNAL" && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        Internal
                      </span>
                    )}
                  </div>
                  <div>
                    <strong>{EVENT_LABEL[e.kind] ?? e.kind}</strong>
                    {e.body && e.body.replace(/\.$/, "") !== (EVENT_LABEL[e.kind] ?? e.kind) && <span style={{ whiteSpace: "pre-wrap" }}> — {e.body}</span>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
          {full && (
            <div className="card">
              <h2>Assignment history and handling time</h2>
              <div className="table-wrap">
                <table className="data responsive">
                  <caption className="sr-only">Assignment history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Team</th>
                      <th scope="col">Officer</th>
                      <th scope="col">From</th>
                      <th scope="col">To</th>
                      <th scope="col">Time held</th>
                      <th scope="col">Ended by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.assignments.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Team">{a.team_name}</td>
                        <td data-label="Officer">{a.officer_name ?? <span className="muted">Team queue</span>}</td>
                        <td data-label="From">{formatLagos(a.started_at)}</td>
                        <td data-label="To">{a.ended_at ? formatLagos(a.ended_at) : <span className="badge badge-blue">Current</span>}</td>
                        <td data-label="Time held">{formatDuration((a.ended_at ? new Date(a.ended_at).getTime() : now) - new Date(a.started_at).getTime())}</td>
                        <td data-label="Ended by">
                          {a.end_reason ? END_REASON[a.end_reason] ?? a.end_reason : "—"}
                          {a.reason && <div className="small muted">{a.reason}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {breakdown && (
                <dl className="kv-inline">
                  {breakdown.team.map(([n, ms]) => (
                    <div key={`t-${n}`}>
                      <dt>{n}</dt>
                      <dd>{formatDuration(ms)}</dd>
                    </div>
                  ))}
                  {breakdown.officer.map(([n, ms]) => (
                    <div key={`o-${n}`}>
                      <dt>{n}</dt>
                      <dd>{formatDuration(ms)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {(d.links.length > 0 || d.children.length > 0) && (
                <>
                  <h3 style={{ fontSize: 14, marginTop: 16 }}>Related tickets</h3>
                  <ul>
                    {[...d.links, ...d.children].map((l) => (
                      <li key={l.id}>
                        <Link href={`/crm/tickets/${l.id}`}>{l.ref}</Link> — {l.subject}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>
        <aside className="split-right" aria-label="Actions">
          <TicketActions
            id={t.id}
            lockVersion={t.lock_version}
            status={t.status}
            isCreator={t.creator_id === p.staffId}
            isAssignee={t.assignee_id === p.staffId}
            canManage={manage}
            canWork={work}
            isCxHead={p.isCxHead}
            isMember={p.officerTeams.includes(t.team_id)}
            officers={officers}
            teams={teams}
            currentAssignee={t.assignee_id}
          />
          {isOversight(p) && !p.isCxHead && <p className="small muted">Super Admin: view only. Ticket actions belong to the team and the CX Head.</p>}
        </aside>
      </div>
    </>
  );
}
