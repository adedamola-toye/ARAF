/**
 * CRM background jobs: configured escalation rules (each fires at most once per ticket and rule) and the
 * optional closure timeout (only when the Super Admin explicitly configured one).
 */
import { db, withTx } from "../db";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { config } from "../config";
import { notify } from "../domain/notifications";
import { formatDuration } from "../time";
import { slaMs } from "./calendar";
import { OPEN_STATUSES, crmSettings, holdersOf, teamLeads, ticketLink, PRIORITY_LABELS, type Priority } from "./core";
import { ESCALATION_TRIGGERS } from "./config";

interface OpenTicket {
  id: string;
  ref: string;
  subject: string;
  status: string;
  priority: Priority;
  team_id: string;
  assignee_id: string | null;
  application_id: string | null;
  created_at: Date;
  resolution_due: Date | null;
  paused_at: Date | null;
  sla_paused_ms: string;
  sla_business_hours: boolean | null;
  reassign_count: number;
  owner_since: Date;
}

interface Rule {
  id: string;
  trigger: string;
  threshold: number;
  notify_team_lead: boolean;
  notify_cx_head: boolean;
  mark_escalated: boolean;
}

/** Returns a description of why the rule fires for the ticket, or null. */
export function ruleFires(r: Rule, t: OpenTicket, now: Date, cal: Parameters<typeof slaMs>[3]): string | null {
  const bh = t.sla_business_hours ?? true;
  const min = 60_000;
  switch (r.trigger) {
    case "UNASSIGNED_OVER": {
      if (t.status !== "UNASSIGNED") return null;
      const w = slaMs(new Date(t.owner_since), now, bh, cal);
      return w >= r.threshold * min ? `Awaiting assignment for ${formatDuration(w)}.` : null;
    }
    case "NOT_STARTED_OVER": {
      if (!["ASSIGNED", "REOPENED"].includes(t.status)) return null;
      const w = slaMs(new Date(t.owner_since), now, bh, cal);
      return w >= r.threshold * min ? `Assigned but not started for ${formatDuration(w)}.` : null;
    }
    case "APPROACHING_BREACH": {
      if (!t.resolution_due || t.paused_at) return null;
      const paused = Number(t.sla_paused_ms);
      const total = slaMs(new Date(t.created_at), new Date(t.resolution_due), bh, cal) - paused;
      const used = slaMs(new Date(t.created_at), now, bh, cal) - paused;
      if (total <= 0 || now >= new Date(t.resolution_due)) return null;
      return used / total >= r.threshold / 100 ? `${Math.round((used / total) * 100)}% of the resolution time used.` : null;
    }
    case "RESOLUTION_BREACHED": {
      if (!t.resolution_due || t.paused_at) return null;
      const over = slaMs(new Date(t.resolution_due), now, bh, cal);
      return now > new Date(t.resolution_due) && over >= r.threshold * min ? `Resolution deadline exceeded by ${formatDuration(over)}.` : null;
    }
    case "REASSIGNED_TIMES":
      return t.reassign_count >= r.threshold ? `Reassigned or transferred ${t.reassign_count} times.` : null;
    case "CRITICAL_OPEN_OVER": {
      if (t.priority !== "CRITICAL") return null;
      const w = now.getTime() - new Date(t.created_at).getTime();
      return w >= r.threshold * min ? `Critical and unresolved for ${formatDuration(w)}.` : null;
    }
  }
  return null;
}

export async function runCrmEscalations(now = new Date()): Promise<number> {
  const rules = (await db.query<Rule>("SELECT id, trigger, threshold, notify_team_lead, notify_cx_head, mark_escalated FROM crm_escalation_rules WHERE active")).rows;
  if (!rules.length) return 0;
  const cal = await crmSettings(db);
  const tickets = (
    await db.query<OpenTicket>(
      `SELECT t.id, t.ref, t.subject, t.status, t.priority, t.team_id, t.assignee_id, t.application_id, t.created_at, t.resolution_due, t.paused_at, t.sla_paused_ms,
              t.sla_business_hours, t.reassign_count, coalesce((SELECT a.started_at FROM crm_assignments a WHERE a.ticket_id = t.id AND a.ended_at IS NULL), t.created_at) AS owner_since
         FROM crm_tickets t WHERE t.status = ANY($1) ORDER BY t.created_at LIMIT 2000`,
      [OPEN_STATUSES],
    )
  ).rows;
  const done = new Set((await db.query<{ k: string }>("SELECT ticket_id || ':' || rule_id AS k FROM crm_escalation_hits WHERE ticket_id = ANY($1::uuid[])", [tickets.map((t) => t.id)])).rows.map((r) => r.k));
  const ctx = systemCtx(now);
  let n = 0;
  for (const t of tickets) {
    for (const r of rules) {
      if (done.has(`${t.id}:${r.id}`)) continue;
      const why = ruleFires(r, t, now, cal);
      if (!why) continue;
      await withTx(async (tx) => {
        const ins = await tx.query("INSERT INTO crm_escalation_hits (ticket_id, rule_id, hit_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [t.id, r.id, now]);
        if (!ins.rowCount) return;
        n++;
        const label = `${ESCALATION_TRIGGERS[r.trigger]?.label ?? r.trigger} ${r.threshold} ${ESCALATION_TRIGGERS[r.trigger]?.unit ?? ""}`.trim();
        if (r.mark_escalated) await tx.query("UPDATE crm_tickets SET escalated = true, escalated_at = coalesce(escalated_at, $2), updated_at = $2 WHERE id = $1", [t.id, now]);
        await tx.query("INSERT INTO crm_events (ticket_id, at, actor_id, kind, visibility, body, details) VALUES ($1,$2,NULL,'AUTO_ESCALATED','INTERNAL',$3,$4)", [t.id, now, `${why} (rule: ${label})`, JSON.stringify({ ruleId: r.id, trigger: r.trigger })]);
        await audit(tx, ctx, { action: "CRM_TICKET_AUTO_ESCALATED", applicationId: t.application_id, details: { ticketId: t.id, ref: t.ref, ruleId: r.id, trigger: r.trigger, why } });
        const people = [...(r.notify_team_lead ? await teamLeads(tx, t.team_id) : []), ...(r.notify_cx_head ? await holdersOf(tx, "CX_HEAD") : [])];
        const seen = new Set<string>();
        for (const p of people) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          const title = `${r.trigger === "APPROACHING_BREACH" ? "SLA warning" : "Escalation"}: ${t.ref}`;
          const body = `${PRIORITY_LABELS[t.priority]} · “${t.subject}” — ${why}`;
          await notify(tx, now, { recipientId: p.id, kind: "CRM_ESCALATION", title, body, link: ticketLink(t.id), dedupeKey: `crm-esc:${t.id}:${r.id}:${p.id}` });
          await enqueueEmail(tx, now, { kind: "CRM_ESCALATION", dedupeKey: `crm-esc:${t.id}:${r.id}:${p.id}`, to: [p.email], subject: title, text: simpleEmail([`Dear ${p.full_name},`, "", body, "", `${config.appUrl.replace(/\/$/, "")}${ticketLink(t.id)}`]) });
        }
      });
    }
  }
  return n;
}

/** Closes resolved tickets after the configured timeout. Does nothing unless the TIMEOUT policy is set. */
export async function runCrmAutoClose(now = new Date()): Promise<number> {
  const s = await crmSettings(db);
  if (s.closure_policy !== "TIMEOUT" || !s.closure_timeout_hours) return 0;
  const ctx = systemCtx(now);
  const rows = (await db.query<{ id: string; ref: string; application_id: string | null }>("SELECT id, ref, application_id FROM crm_tickets WHERE status = 'RESOLVED' AND resolved_at + make_interval(hours => $1) < $2 LIMIT 200", [s.closure_timeout_hours, now])).rows;
  for (const t of rows) {
    await withTx(async (tx) => {
      const u = await tx.query("UPDATE crm_tickets SET status = 'CLOSED', closed_at = $2, closed_how = 'TIMEOUT', updated_at = $2, lock_version = lock_version + 1 WHERE id = $1 AND status = 'RESOLVED'", [t.id, now]);
      if (!u.rowCount) return;
      await tx.query("INSERT INTO crm_events (ticket_id, at, actor_id, kind, visibility, body) VALUES ($1,$2,NULL,'CLOSED','PUBLIC',$3)", [t.id, now, `Closed automatically ${s.closure_timeout_hours} hours after resolution without a reply (closure policy). You can still ask for it to be reopened.`]);
      await audit(tx, ctx, { action: "CRM_TICKET_CLOSED", applicationId: t.application_id, details: { ticketId: t.id, ref: t.ref, how: "TIMEOUT", hours: s.closure_timeout_hours } });
    });
  }
  return rows.length;
}
