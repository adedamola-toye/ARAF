import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "../../guard";
import { db } from "@/server/db";
import { canTransition, type IncidentRow } from "@/server/incidents";
import { config } from "@/server/config";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { statusLabel } from "@/lib/incident-messages";
import { incidentAction } from "../actions";
import { Distribution, SeverityBadge, StatusBadge } from "../ui";

export const metadata = { title: "Incident" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = (
    await db.query<IncidentRow & { ack_name: string | null; res_name: string | null }>(
      `SELECT i.*, a.full_name AS ack_name, s.full_name AS res_name FROM incidents i
         LEFT JOIN staff a ON a.id = i.acknowledged_by LEFT JOIN staff s ON s.id = i.resolved_by WHERE i.id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) notFound();
  const d = r.diagnostics as { source?: string; route?: string; errorName?: string; code?: string | null; message?: string; frames?: string[] };
  const step = (name: string, label: string, cls = "btn", note?: { label: string; required: boolean }) => (
    <ActionForm action={incidentAction} className="stack">
      <input type="hidden" name="id" value={r.id} />
      <input type="hidden" name="step" value={name} />
      {note && (
        <div className="field">
          <label htmlFor={`note-${name}`}>{note.label}</label>
          <textarea id={`note-${name}`} name="note" rows={2} required={note.required} minLength={note.required ? 3 : undefined} />
        </div>
      )}
      <div>
        <SubmitButton className={cls}>{label}</SubmitButton>
      </div>
    </ActionForm>
  );
  return (
    <>
      <PageHeader
        eyebrow="Incidents"
        title={r.ref}
        intro={`${r.module} · first seen ${formatLagos(r.first_seen_at)}`}
        actions={
          <Link className="btn btn-ghost" href="/admin/incidents">
            All incidents
          </Link>
        }
      />
      <div className="grid-2">
        <div className="stack">
          <section className="card" aria-labelledby="h-state">
            <h2 id="h-state">Status</h2>
            <p style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <StatusBadge s={r.status} /> <SeverityBadge s={r.severity} />
            </p>
            <p className="small muted">
              Affected users currently see: <em>{statusLabel(r.status, !!r.routed_at)}</em>
            </p>
            <dl className="inc-kv">
              <dt>Affected users</dt>
              <dd>{r.affected_users.toLocaleString()}</dd>
              <dt>Occurrences</dt>
              <dd>{r.occurrences.toLocaleString()}</dd>
              <dt>Last seen</dt>
              <dd>{formatLagos(r.last_seen_at)}</dd>
              <dt>Alert</dt>
              <dd>{r.routed_at ? `Sent ${formatLagos(r.routed_at)} (${r.alerted_severity?.toLowerCase()})` : config.incidentAlertEmails.length ? "Not sent (throttled)" : "Not routed — set INCIDENT_ALERT_EMAILS"}</dd>
              <dt>Acknowledged</dt>
              <dd>{r.acknowledged_at ? `${formatLagos(r.acknowledged_at)} · ${r.ack_name ?? ""}` : "—"}</dd>
              <dt>Resolved</dt>
              <dd>{r.resolved_at ? `${formatLagos(r.resolved_at)}${r.res_name ? ` · ${r.res_name}` : ""}` : "—"}</dd>
              {r.resolution_note && (
                <>
                  <dt>Resolution</dt>
                  <dd>{r.resolution_note}</dd>
                </>
              )}
              {r.closed_at && (
                <>
                  <dt>Closed</dt>
                  <dd>{formatLagos(r.closed_at)}</dd>
                </>
              )}
            </dl>
          </section>
          <section className="card" aria-labelledby="h-act">
            <h2 id="h-act">Actions</h2>
            <div className="stack">
              {canTransition(r.status, "INVESTIGATING") && r.status === "DETECTED" && step("acknowledge", "Acknowledge — we're investigating", "btn btn-primary")}
              {canTransition(r.status, "RESOLVED") && step("resolve", "Mark resolved", "btn", { label: "What fixed it", required: true })}
              {canTransition(r.status, "CLOSED") && step("close", "Close incident", "btn")}
              {r.status === "RESOLVED" && step("reopen", "Reopen", "btn btn-ghost")}
              {r.status === "CLOSED" && <p className="small muted">Closed incidents are final. If the failure returns, a new incident opens automatically.</p>}
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="card" aria-labelledby="h-dist">
            <h2 id="h-dist">Message allocation</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              Each affected user keeps one message; the counts never differ by more than one.
            </p>
            <Distribution counts={r.message_counts} />
          </section>
          <section className="card" aria-labelledby="h-diag">
            <h2 id="h-diag">Diagnostics</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              Sanitised: identifiers, numbers, emails, keys and server paths are removed before anything is stored.
            </p>
            <dl className="inc-kv">
              <dt>Category</dt>
              <dd>{r.category}</dd>
              <dt>Source</dt>
              <dd>{d.source ?? "—"}</dd>
              <dt>Route</dt>
              <dd className="mono">{d.route ?? "—"}</dd>
              <dt>Error</dt>
              <dd className="mono">
                {d.errorName ?? "Error"}
                {d.code ? ` (${d.code})` : ""}
              </dd>
              <dt>Message</dt>
              <dd className="mono small">{d.message || "—"}</dd>
              <dt>Fingerprint</dt>
              <dd className="mono small">{r.fingerprint}</dd>
            </dl>
            {d.frames && d.frames.length > 0 && <pre className="inc-frames">{d.frames.join("\n")}</pre>}
          </section>
        </div>
      </div>
    </>
  );
}
