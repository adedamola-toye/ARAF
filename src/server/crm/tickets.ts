/**
 * CRM ticket lifecycle: registration (idempotent, unique reference), automatic routing, assignment, work,
 * reassignment and transfer, escalation, resolution, complainant confirmation and reopening.
 *
 * Every change runs in one transaction with its timeline event and audit record. Every change of owner closes
 * the open assignment segment and opens a new one, so handling time is attributed to each team and officer and
 * the overall resolution clock is never reset.
 */
import { withTx, type Db, type Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { config } from "../config";
import { DomainError, conflict, forbidden, invalid, notFound } from "../errors";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { rateLimit } from "../auth/rateLimit";
import { notify } from "../domain/notifications";
import { caseAccess, activeRoles } from "../domain/access";
import { slaAdd, slaMs } from "./calendar";
import {
  OPEN_STATUSES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  canManage,
  canWork,
  crmPrincipal,
  crmProducts,
  crmSettings,
  formatRef,
  holdersOf,
  isOversight,
  teamLeads,
  ticketLink,
  ticketView,
  type CrmPrincipal,
  type CrmSettings,
  type Priority,
  type TicketStatus,
} from "./core";

export interface TicketRow {
  id: string;
  seq: string;
  ref: string;
  creator_id: string;
  creator_role: string | null;
  product_code: string;
  product_name: string;
  category_id: string;
  subcategory_id: string;
  category_name: string;
  subcategory_name: string;
  subject: string;
  description: string;
  application_id: string | null;
  related_ref: string | null;
  application_stage: string | null;
  priority: Priority;
  complainant_urgent: boolean;
  status: TicketStatus;
  escalated: boolean;
  escalated_at: Date | null;
  team_id: string;
  assignee_id: string | null;
  routing: { ruleId?: string | null; fallback?: boolean; reason?: string };
  sla_policy_id: string | null;
  sla_business_hours: boolean | null;
  assignment_due: Date | null;
  first_response_due: Date | null;
  resolution_due: Date | null;
  sla_paused_ms: string;
  paused_at: Date | null;
  routed_at: Date | null;
  first_assigned_at: Date | null;
  first_response_at: Date | null;
  started_at: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_summary: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  closed_how: string | null;
  reopen_count: number;
  reassign_count: number;
  parent_id: string | null;
  satisfaction: number | null;
  satisfaction_comment: string | null;
  lock_version: number;
  created_at: Date;
  updated_at: Date;
}

const REASON_MIN = 10;
const appUrl = () => config.appUrl.replace(/\/$/, "");

// ------------------------------------------------------------------ internal helpers

async function event(tx: Db, ticketId: string, now: Date, actorId: string | null, kind: string, visibility: "PUBLIC" | "INTERNAL", body: string | null, details: Record<string, unknown> = {}) {
  await tx.query("INSERT INTO crm_events (ticket_id, at, actor_id, kind, visibility, body, details) VALUES ($1,$2,$3,$4,$5,$6,$7)", [ticketId, now, actorId, kind, visibility, body, JSON.stringify(details)]);
}

async function crmAudit(tx: Db, ctx: Ctx, action: string, t: Pick<TicketRow, "id" | "ref" | "application_id">, extra: { reason?: string | null; from?: string | null; to?: string | null; details?: Record<string, unknown> } = {}) {
  await audit(tx, ctx, {
    action,
    applicationId: t.application_id,
    reason: extra.reason ?? null,
    assignmentFrom: extra.from ?? null,
    assignmentTo: extra.to ?? null,
    details: { ticketId: t.id, ref: t.ref, ...(extra.details ?? {}) },
  });
}

interface Recipient {
  id: string;
  email: string;
  full_name: string;
}

/** In-app notification and (optionally) an email through the outbox. Idempotent on the dedupe key. */
async function tell(tx: Db, now: Date, people: Recipient[], m: { kind: string; title: string; body: string; ticketId: string; dedupe: string; email?: boolean }) {
  const seen = new Set<string>();
  for (const p of people) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    await notify(tx, now, { recipientId: p.id, kind: m.kind, title: m.title, body: m.body, link: ticketLink(m.ticketId), dedupeKey: `${m.dedupe}:${p.id}` });
    if (m.email)
      await enqueueEmail(tx, now, { kind: m.kind, dedupeKey: `${m.dedupe}:${p.id}`, to: [p.email], subject: m.title, text: simpleEmail([`Dear ${p.full_name},`, "", m.body, "", `${appUrl()}${ticketLink(m.ticketId)}`]) });
  }
}

async function staffById(q: Db, id: string | null): Promise<Recipient | null> {
  if (!id) return null;
  return (await q.query<Recipient>("SELECT id, email, full_name FROM staff WHERE id = $1 AND status = 'ACTIVE'", [id])).rows[0] ?? null;
}

async function teamName(q: Db, id: string) {
  return (await q.query<{ name: string }>("SELECT name FROM crm_teams WHERE id = $1", [id])).rows[0]?.name ?? "the team";
}

/** People alerted when a queue has nobody to manage it: its leads, else the CX Heads and Super Admins. */
async function queueManagers(q: Db, teamId: string): Promise<Recipient[]> {
  const leads = await teamLeads(q, teamId);
  if (leads.length) return leads;
  return [...(await holdersOf(q, "CX_HEAD")), ...(await holdersOf(q, "SUPER_ADMIN"))];
}

async function endSegment(tx: Db, ticketId: string, now: Date, reason: string) {
  await tx.query("UPDATE crm_assignments SET ended_at = $2, end_reason = $3 WHERE ticket_id = $1 AND ended_at IS NULL", [ticketId, now, reason]);
}

async function openSegment(tx: Db, p: { ticketId: string; teamId: string; officerId: string | null; now: Date; by: string | null; reason: string | null }) {
  await tx.query("INSERT INTO crm_assignments (ticket_id, team_id, officer_id, started_at, assigned_by, reason) VALUES ($1,$2,$3,$4,$5,$6)", [p.ticketId, p.teamId, p.officerId, p.now, p.by, p.reason]);
}

async function lockTicket(tx: Tx, id: string, lockVersion?: number | null): Promise<TicketRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Ticket not found.");
  const t = (await tx.query<TicketRow>("SELECT * FROM crm_tickets WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!t) throw notFound("Ticket not found.");
  if (lockVersion !== undefined && lockVersion !== null && t.lock_version !== lockVersion) throw conflict("This ticket changed since you opened it. Reload to see the latest version.");
  return t;
}

async function principalFor(tx: Db, ctx: Ctx): Promise<CrmPrincipal> {
  if (!ctx.actor) throw forbidden();
  const p = await crmPrincipal(tx, ctx.actor.staffId);
  if (!p.active) throw forbidden();
  return p;
}

async function touch(tx: Db, id: string, now: Date, set: string, params: unknown[] = []) {
  // `set` is a fixed SQL fragment from this module (never user input); params are positional from $3.
  await tx.query(`UPDATE crm_tickets SET ${set ? `${set}, ` : ""}updated_at = $2, lock_version = lock_version + 1 WHERE id = $1`, [id, now, ...params]);
}

/** Resume the SLA clock after Pending Information: the paused time extends the resolution deadline. */
async function resumeClock(tx: Db, t: TicketRow, now: Date, s: CrmSettings) {
  if (!t.paused_at) return;
  const bh = t.sla_business_hours ?? true;
  const paused = slaMs(new Date(t.paused_at), now, bh, s);
  const due = t.resolution_due ? slaAdd(new Date(t.resolution_due), paused, bh, s) : null;
  await tx.query("UPDATE crm_tickets SET paused_at = NULL, sla_paused_ms = sla_paused_ms + $2, resolution_due = $3 WHERE id = $1", [t.id, paused, due]);
}

async function markFirstResponse(tx: Db, t: TicketRow, now: Date) {
  if (!t.first_response_at) await tx.query("UPDATE crm_tickets SET first_response_at = $2 WHERE id = $1 AND first_response_at IS NULL", [t.id, now]);
}

function reasonOk(r: string | undefined | null, field = "reason") {
  if (!r || r.trim().length < REASON_MIN) throw invalid(`Give a reason (at least ${REASON_MIN} characters).`, { [field]: "Give a reason." });
  return r.trim();
}

// ------------------------------------------------------------------ routing and SLA resolution

export interface RouteInput {
  productCode: string;
  categoryId: string;
  subcategoryId: string;
  stage: string | null;
}
export interface RouteResult {
  teamId: string;
  ruleId: string | null;
  priorityOverride: Priority | null;
  fallback: boolean;
}

/** Most specific active rule whose criteria all match (subcategory > category > stage > product); else the fallback queue. */
export async function resolveRoute(q: Db, i: RouteInput): Promise<RouteResult> {
  const r = (
    await q.query<{ id: string; team_id: string; priority_override: Priority | null }>(
      `SELECT r.id, r.team_id, r.priority_override FROM crm_routing_rules r JOIN crm_teams t ON t.id = r.team_id AND t.active
        WHERE r.active
          AND (r.product_code IS NULL OR r.product_code = $1)
          AND (r.category_id IS NULL OR r.category_id = $2)
          AND (r.subcategory_id IS NULL OR r.subcategory_id = $3)
          AND (r.stage IS NULL OR r.stage = $4)
        ORDER BY (CASE WHEN r.subcategory_id IS NOT NULL THEN 8 ELSE 0 END + CASE WHEN r.category_id IS NOT NULL THEN 4 ELSE 0 END
                + CASE WHEN r.stage IS NOT NULL THEN 2 ELSE 0 END + CASE WHEN r.product_code IS NOT NULL THEN 1 ELSE 0 END) DESC, r.created_at
        LIMIT 1`,
      [i.productCode, i.categoryId, i.subcategoryId, i.stage],
    )
  ).rows[0];
  if (r) return { teamId: r.team_id, ruleId: r.id, priorityOverride: r.priority_override, fallback: false };
  return { teamId: (await crmSettings(q)).fallback_team_id, ruleId: null, priorityOverride: null, fallback: true };
}

export interface SlaPolicyRow {
  id: string;
  name: string;
  assignment_minutes: number | null;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  business_hours: boolean;
}

/** Most specific active SLA policy (subcategory > category > priority > team > product). None configured = no deadline. */
export async function resolveSla(q: Db, i: RouteInput & { priority: Priority; teamId: string }): Promise<SlaPolicyRow | null> {
  return (
    (
      await q.query<SlaPolicyRow>(
        `SELECT id, name, assignment_minutes, first_response_minutes, resolution_minutes, business_hours FROM crm_sla_policies p
          WHERE p.active
            AND (p.product_code IS NULL OR p.product_code = $1) AND (p.category_id IS NULL OR p.category_id = $2)
            AND (p.subcategory_id IS NULL OR p.subcategory_id = $3) AND (p.priority IS NULL OR p.priority = $4)
            AND (p.team_id IS NULL OR p.team_id = $5)
          ORDER BY (CASE WHEN p.subcategory_id IS NOT NULL THEN 16 ELSE 0 END + CASE WHEN p.category_id IS NOT NULL THEN 8 ELSE 0 END
                  + CASE WHEN p.priority IS NOT NULL THEN 4 ELSE 0 END + CASE WHEN p.team_id IS NOT NULL THEN 2 ELSE 0 END
                  + CASE WHEN p.product_code IS NOT NULL THEN 1 ELSE 0 END) DESC, p.created_at
          LIMIT 1`,
        [i.productCode, i.categoryId, i.subcategoryId, i.priority, i.teamId],
      )
    ).rows[0] ?? null
  );
}

// ------------------------------------------------------------------ registration

export interface CreateInput {
  idempotencyKey: string;
  productCode: string;
  categoryId: string;
  subcategoryId: string;
  subject: string;
  description: string;
  /** ARAF financing request reference (e.g. WB-2026-001074), optional. */
  requestRef?: string | null;
  /** Application id when raised from a request page (prefill). */
  applicationId?: string | null;
  urgent?: boolean;
  confirmDuplicate?: boolean;
}

export interface Duplicate {
  id: string;
  ref: string;
  subject: string;
  status: TicketStatus;
  visible: boolean;
}

export class DuplicateComplaint extends DomainError {
  constructor(public duplicates: Duplicate[]) {
    super("CONFLICT", "A similar complaint is already open. Review it before raising another, or confirm that this is a different issue.");
  }
}

const uuidRe = /^[0-9a-f-]{36}$/i;

export async function createTicket(ctx: Ctx, input: CreateInput): Promise<{ id: string; ref: string; created: boolean }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const key = String(input.idempotencyKey ?? "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) throw invalid("The form expired. Reload the page and try again.");
  const subject = String(input.subject ?? "").trim().replace(/\s+/g, " ");
  const description = String(input.description ?? "").trim();
  const errs: Record<string, string> = {};
  if (!input.productCode) errs.productCode = "Choose the product or platform area.";
  if (!uuidRe.test(input.categoryId ?? "")) errs.categoryId = "Choose a category.";
  if (!uuidRe.test(input.subcategoryId ?? "")) errs.subcategoryId = "Choose the specific issue.";
  if (subject.length < 5 || subject.length > 150) errs.subject = "Give a subject of 5–150 characters.";
  if (description.length < 10 || description.length > 5000) errs.description = "Describe the complaint (10–5,000 characters).";
  if (Object.keys(errs).length) throw invalid("Check the highlighted fields.", errs);

  return withTx(async (tx) => {
    // Repeated submissions (double clicks, network retries) return the ticket already created.
    const prior = (await tx.query<{ id: string; ref: string }>("SELECT id, ref FROM crm_tickets WHERE creator_id = $1 AND idempotency_key = $2", [actor.staffId, key])).rows[0];
    if (prior) return { ...prior, created: false };
    const p = await principalFor(tx, ctx);
    if (!(await rateLimit(tx, `crm-create:${p.staffId}`, 30, 3600, ctx.now))) throw new DomainError("RATE_LIMITED", "You have raised many complaints in the last hour. Wait a little and try again.");

    const product = (await crmProducts(tx)).find((x) => x.code === input.productCode);
    if (!product) throw invalid("Choose an available product or platform area.", { productCode: "Not available." });
    const cat = (await tx.query<{ id: string; name: string }>("SELECT id, name FROM crm_categories WHERE id = $1 AND active", [input.categoryId])).rows[0];
    if (!cat) throw invalid("Choose an available category.", { categoryId: "Not available." });
    const sub = (
      await tx.query<{ id: string; name: string; default_priority: Priority }>(
        "SELECT id, name, default_priority FROM crm_subcategories WHERE id = $1 AND category_id = $2 AND active AND (product_code IS NULL OR product_code = $3)",
        [input.subcategoryId, cat.id, product.code],
      )
    ).rows[0];
    if (!sub) throw invalid("Choose an issue listed for this product and category.", { subcategoryId: "Not available." });

    // Related financing request: linked only if the user may already open it (no new access is created).
    let appId: string | null = null;
    let stage: string | null = null;
    let relatedRef: string | null = null;
    const refText = String(input.requestRef ?? "").trim().toUpperCase();
    if (input.applicationId || refText) {
      const app = input.applicationId && uuidRe.test(input.applicationId)
        ? (await tx.query<{ id: string; ref: string; stage: string }>("SELECT id, ref, stage FROM applications WHERE id = $1", [input.applicationId])).rows[0]
        : (await tx.query<{ id: string; ref: string; stage: string }>("SELECT id, ref, stage FROM applications WHERE upper(ref) = $1", [refText])).rows[0];
      if (app && (await caseAccess(tx, p.staffId, app.id)).canView) {
        appId = app.id;
        stage = app.stage;
        relatedRef = app.ref;
      } else if (input.applicationId) {
        throw invalid("You cannot link that financing request.", { requestRef: "Not available to you." });
      } else if (/^[A-Z0-9][A-Z0-9/_-]{2,39}$/.test(refText)) {
        // Altphones, salary advance or other references are recorded as text only.
        relatedRef = refText;
      } else {
        throw invalid("Enter the reference exactly as it appears in ARAF (letters, numbers and dashes).", { requestRef: "Check the reference." });
      }
    }

    if (!input.confirmDuplicate) {
      const dups = (
        await tx.query<{ id: string; ref: string; subject: string; status: TicketStatus; creator_id: string; team_id: string; assignee_id: string | null }>(
          `SELECT id, ref, subject, status, creator_id, team_id, assignee_id FROM crm_tickets
            WHERE status = ANY($1) AND subcategory_id = $2
              AND (($3::uuid IS NOT NULL AND application_id = $3) OR (creator_id = $4 AND created_at > $5::timestamptz - interval '14 days'))
            ORDER BY created_at DESC LIMIT 5`,
          [[...OPEN_STATUSES, "RESOLVED"], sub.id, appId, p.staffId, ctx.now],
        )
      ).rows;
      if (dups.length) {
        const out: Duplicate[] = [];
        for (const d of dups) out.push({ id: d.id, ref: d.ref, subject: d.subject, status: d.status, visible: !!(await ticketView(tx, p, d)) });
        throw new DuplicateComplaint(out);
      }
    }

    const route = await resolveRoute(tx, { productCode: product.code, categoryId: cat.id, subcategoryId: sub.id, stage });
    const priority: Priority = route.priorityOverride ?? sub.default_priority;
    const sla = await resolveSla(tx, { productCode: product.code, categoryId: cat.id, subcategoryId: sub.id, stage, priority, teamId: route.teamId });
    const s = await crmSettings(tx);
    const bh = sla?.business_hours ?? true;
    const due = (m: number | null | undefined) => (m ? slaAdd(ctx.now, m * 60_000, bh, s) : null);
    const seq = Number((await tx.query<{ n: string }>("SELECT nextval('crm_ticket_seq') AS n")).rows[0].n);
    const ref = formatRef(seq);
    const roleRow = ctx.actor?.activeRole ?? (await activeRoles(tx, p.staffId))[0]?.role ?? null;
    const routing = { ruleId: route.ruleId, fallback: route.fallback, reason: route.fallback ? "No routing rule matched: sent to the fallback queue." : "Matched a routing rule." };
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO crm_tickets (seq, ref, idempotency_key, creator_id, creator_role, product_code, product_name, category_id, subcategory_id, category_name, subcategory_name,
            subject, description, application_id, related_ref, application_stage, priority, complainant_urgent, status, team_id, routing,
            sla_policy_id, sla_business_hours, assignment_due, first_response_due, resolution_due, routed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'UNASSIGNED',$19,$20,$21,$22,$23,$24,$25,$26,$26,$26) RETURNING id`,
        [seq, ref, key, p.staffId, roleRow, product.code, product.name, cat.id, sub.id, cat.name, sub.name, subject, description, appId, relatedRef, stage, priority, !!input.urgent,
          route.teamId, JSON.stringify(routing), sla?.id ?? null, sla ? bh : null, due(sla?.assignment_minutes), due(sla?.first_response_minutes), due(sla?.resolution_minutes), ctx.now],
      )
    ).rows[0].id;
    const team = await teamName(tx, route.teamId);
    await openSegment(tx, { ticketId: id, teamId: route.teamId, officerId: null, now: ctx.now, by: null, reason: routing.reason });
    await event(tx, id, ctx.now, p.staffId, "CREATED", "PUBLIC", "Complaint created.", { priority, urgentRequested: !!input.urgent });
    await event(tx, id, ctx.now, null, "ROUTED", "PUBLIC", `Routed to ${team}.`, { teamId: route.teamId, ...routing, slaPolicyId: sla?.id ?? null });
    await crmAudit(tx, ctx, "CRM_TICKET_CREATED", { id, ref, application_id: appId }, { to: route.teamId, details: { product: product.code, category: cat.name, issue: sub.name, priority, fallback: route.fallback, slaPolicyId: sla?.id ?? null } });
    await tell(tx, ctx.now, await queueManagers(tx, route.teamId), {
      kind: "CRM_TICKET_QUEUED",
      title: `New complaint ${ref} in ${team}`,
      body: `${PRIORITY_LABELS[priority]} priority · ${product.name} · ${cat.name} — ${sub.name}: “${subject}”. Assign it to an officer.`,
      ticketId: id,
      dedupe: `crm-queued:${id}:${route.teamId}`,
      email: true,
    });
    return { id, ref, created: true };
  });
}

// ------------------------------------------------------------------ assignment and work

async function activeMember(q: Db, teamId: string, staffId: string) {
  const r = await q.query("SELECT 1 FROM crm_team_members m JOIN staff s ON s.id = m.staff_id AND s.status = 'ACTIVE' WHERE m.team_id = $1 AND m.staff_id = $2 AND m.active", [teamId, staffId]);
  return !!r.rowCount;
}

const CLOSED_OR_RESOLVED: TicketStatus[] = ["RESOLVED", "CLOSED"];

/** Team Lead (or CX Head) assigns or reassigns a ticket to an officer of the ticket's current team. */
export async function assignTicket(ctx: Ctx, id: string, officerId: string, reason?: string | null, lockVersion?: number | null) {
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id, lockVersion);
    // Team Lead / CX Head assign and reassign; the assigned officer may hand the ticket to a colleague in the same team.
    const handOn = !canManage(p, t) && t.assignee_id === p.staffId;
    if (!canManage(p, t) && !handOn) throw forbidden("Only the Team Lead of this ticket's team, the CX Head, a Super Admin or the assigned officer can reassign it.");
    if (CLOSED_OR_RESOLVED.includes(t.status)) throw conflict(`This ticket is ${STATUS_LABELS[t.status].toLowerCase()}.`);
    if (!uuidRe.test(officerId) || !(await activeMember(tx, t.team_id, officerId))) throw invalid("Choose an active member of this team.", { officerId: "Not a member of this team." });
    if (officerId === t.creator_id) throw invalid("A complaint cannot be assigned to the person who raised it.", { officerId: "Choose someone else." });
    if (officerId === t.assignee_id) throw conflict("The ticket is already assigned to this officer.");
    const isReassign = !!t.assignee_id;
    const why = isReassign ? reasonOk(reason) : (reason ?? "").trim() || null;
    await endSegment(tx, t.id, ctx.now, isReassign ? "REASSIGNED" : "ASSIGNED");
    await openSegment(tx, { ticketId: t.id, teamId: t.team_id, officerId, now: ctx.now, by: p.staffId, reason: why });
    const nextStatus: TicketStatus = t.status === "PENDING_INFO" ? "PENDING_INFO" : "ASSIGNED";
    await touch(tx, t.id, ctx.now, `assignee_id = $3, status = $4, first_assigned_at = coalesce(first_assigned_at, $2)${isReassign ? ", reassign_count = reassign_count + 1" : ""}`, [officerId, nextStatus]);
    const officer = await staffById(tx, officerId);
    await event(tx, t.id, ctx.now, p.staffId, isReassign ? "REASSIGNED" : "ASSIGNED", "PUBLIC", `Assigned to ${officer?.full_name ?? "an officer"}.`, { officerId, from: t.assignee_id });
    if (why) await event(tx, t.id, ctx.now, p.staffId, "ASSIGNMENT_NOTE", "INTERNAL", why, {});
    await crmAudit(tx, ctx, isReassign ? "CRM_TICKET_REASSIGNED" : "CRM_TICKET_ASSIGNED", t, { reason: why, from: t.assignee_id, to: officerId });
    if (officer) await tell(tx, ctx.now, [officer], { kind: "CRM_TICKET_ASSIGNED", title: `Complaint ${t.ref} assigned to you`, body: `${PRIORITY_LABELS[t.priority]} priority · ${t.category_name} — ${t.subcategory_name}: “${t.subject}”.`, ticketId: t.id, dedupe: `crm-assigned:${t.id}:${ctx.now.getTime()}`, email: true });
  });
}

/**
 * CX Head / Super Admin reroute: move the ticket straight to an officer in any team (no separate transfer step).
 * The previous segment is closed so handling time stays with the team that spent it.
 */
export async function rerouteTicket(ctx: Ctx, id: string, teamId: string, officerId: string, reason: string, lockVersion?: number | null) {
  const why = reasonOk(reason);
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    if (!isOversight(p)) throw forbidden("Only the CX Head or a Super Admin can reroute a ticket to another team.");
    const t = await lockTicket(tx, id, lockVersion);
    if (CLOSED_OR_RESOLVED.includes(t.status)) throw conflict(`This ticket is ${STATUS_LABELS[t.status].toLowerCase()}.`);
    if (!uuidRe.test(teamId) || !uuidRe.test(officerId)) throw invalid("Choose a team and an officer.", { target: "Choose an officer." });
    const team = (await tx.query<{ id: string; name: string }>("SELECT id, name FROM crm_teams WHERE id = $1 AND active", [teamId])).rows[0];
    if (!team) throw invalid("Choose an active team.", { target: "Not available." });
    if (!(await activeMember(tx, team.id, officerId))) throw invalid("Choose an active member of that team.", { target: "Not a member of that team." });
    if (officerId === t.creator_id) throw invalid("A complaint cannot be assigned to the person who raised it.", { target: "Choose someone else." });
    if (officerId === t.assignee_id && team.id === t.team_id) throw conflict("The ticket is already with this officer in this team.");
    const isReassign = !!t.assignee_id;
    await endSegment(tx, t.id, ctx.now, isReassign ? "REASSIGNED" : "ASSIGNED");
    await openSegment(tx, { ticketId: t.id, teamId: team.id, officerId, now: ctx.now, by: p.staffId, reason: why });
    const nextStatus: TicketStatus = t.status === "PENDING_INFO" ? "PENDING_INFO" : "ASSIGNED";
    await touch(tx, t.id, ctx.now, `team_id = $3, assignee_id = $4, status = $5, first_assigned_at = coalesce(first_assigned_at, $2)${isReassign ? ", reassign_count = reassign_count + 1" : ""}`, [team.id, officerId, nextStatus]);
    const officer = await staffById(tx, officerId);
    await event(tx, t.id, ctx.now, p.staffId, "REROUTED", "PUBLIC", `Rerouted to ${officer?.full_name ?? "an officer"} in ${team.name}.`, { fromTeam: t.team_id, toTeam: team.id, officerId, from: t.assignee_id });
    await event(tx, t.id, ctx.now, p.staffId, "TRANSFER_REASON", "INTERNAL", why, { override: true });
    await crmAudit(tx, ctx, "CRM_TICKET_REROUTED", t, { reason: why, from: t.team_id, to: team.id, details: { officerId } });
    if (officer) await tell(tx, ctx.now, [officer], { kind: "CRM_TICKET_ASSIGNED", title: `Complaint ${t.ref} assigned to you`, body: `${PRIORITY_LABELS[t.priority]} priority · ${t.category_name} — ${t.subcategory_name}: “${t.subject}”.`, ticketId: t.id, dedupe: `crm-rerouted:${t.id}:${ctx.now.getTime()}`, email: true });
  });
}

/** The assigned officer starts work: In Progress, accepted, first response recorded. */
export async function startWork(ctx: Ctx, id: string, lockVersion?: number | null) {
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id, lockVersion);
    if (t.assignee_id !== p.staffId) throw forbidden("Only the assigned officer can start work on this ticket.");
    if (!["ASSIGNED", "REOPENED"].includes(t.status)) throw conflict(`This ticket is ${STATUS_LABELS[t.status].toLowerCase()}.`);
    await tx.query("UPDATE crm_assignments SET accepted_at = coalesce(accepted_at, $2) WHERE ticket_id = $1 AND ended_at IS NULL", [t.id, ctx.now]);
    await touch(tx, t.id, ctx.now, "status = 'IN_PROGRESS', started_at = coalesce(started_at, $2)");
    await markFirstResponse(tx, t, ctx.now);
    await event(tx, t.id, ctx.now, p.staffId, "STARTED", "PUBLIC", "Investigation started.");
    await crmAudit(tx, ctx, "CRM_TICKET_STARTED", t);
  });
}

/** Add an update. Handlers may write public updates or internal notes; the complainant adds information (public). */
export async function addUpdate(ctx: Ctx, id: string, body: string, opts: { internal?: boolean } = {}) {
  const text = String(body ?? "").trim();
  if (text.length < 2 || text.length > 5000) throw invalid("Write an update (up to 5,000 characters).", { body: "Write an update." });
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id);
    const view = await ticketView(tx, p, t);
    if (!view) throw notFound("Ticket not found.");
    if (t.status === "CLOSED") throw conflict("This ticket is closed. Ask for it to be reopened if the issue persists.");
    const handler = canWork(p, t) || (view === "FULL" && (p.officerTeams.includes(t.team_id) || isOversight(p)));
    const isCreator = t.creator_id === p.staffId;
    if (!handler && !isCreator) throw forbidden("You can follow this ticket but not update it.");
    const internal = !!opts.internal && handler;
    await event(tx, t.id, ctx.now, p.staffId, internal ? "NOTE" : isCreator && !handler ? "INFO_PROVIDED" : "UPDATE", internal ? "INTERNAL" : "PUBLIC", text);
    if (handler && !internal && !isCreator) await markFirstResponse(tx, t, ctx.now);
    if (isCreator && t.status === "PENDING_INFO") {
      await resumeClock(tx, t, ctx.now, await crmSettings(tx));
      await touch(tx, t.id, ctx.now, "status = $3", [t.started_at ? "IN_PROGRESS" : t.assignee_id ? "ASSIGNED" : "UNASSIGNED"]);
      await event(tx, t.id, ctx.now, null, "RESUMED", "PUBLIC", "Information received; the ticket is back with the officer.");
      const officer = await staffById(tx, t.assignee_id);
      if (officer) await tell(tx, ctx.now, [officer], { kind: "CRM_INFO_PROVIDED", title: `${t.ref}: information provided`, body: `The complainant replied on “${t.subject}”.`, ticketId: t.id, dedupe: `crm-info:${t.id}:${ctx.now.getTime()}`, email: true });
    } else {
      await touch(tx, t.id, ctx.now, "");
      if (!internal && handler && !isCreator) {
        const creator = await staffById(tx, t.creator_id);
        if (creator) await tell(tx, ctx.now, [creator], { kind: "CRM_UPDATE", title: `Update on your complaint ${t.ref}`, body: text.slice(0, 300), ticketId: t.id, dedupe: `crm-update:${t.id}:${ctx.now.getTime()}` });
      }
    }
    await crmAudit(tx, ctx, internal ? "CRM_TICKET_NOTE" : "CRM_TICKET_UPDATE", t, { details: { length: text.length } });
  });
}

/** Ask the complainant for more information (Pending Information; pauses the SLA clock when configured). */
export async function requestInformation(ctx: Ctx, id: string, question: string, lockVersion?: number | null) {
  const text = String(question ?? "").trim();
  if (text.length < REASON_MIN) throw invalid("Say what information you need (at least 10 characters).", { question: "Say what you need." });
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id, lockVersion);
    if (!canWork(p, t)) throw forbidden();
    if (!["ASSIGNED", "IN_PROGRESS", "REOPENED"].includes(t.status)) throw conflict(`This ticket is ${STATUS_LABELS[t.status].toLowerCase()}.`);
    const s = await crmSettings(tx);
    await touch(tx, t.id, ctx.now, `status = 'PENDING_INFO'${s.pause_on_pending_info && t.resolution_due ? ", paused_at = $2" : ""}`);
    await markFirstResponse(tx, t, ctx.now);
    await event(tx, t.id, ctx.now, p.staffId, "INFO_REQUESTED", "PUBLIC", text, { slaPaused: s.pause_on_pending_info });
    await crmAudit(tx, ctx, "CRM_INFO_REQUESTED", t);
    const creator = await staffById(tx, t.creator_id);
    if (creator) await tell(tx, ctx.now, [creator], { kind: "CRM_INFO_REQUESTED", title: `${t.ref}: more information needed`, body: text.slice(0, 400), ticketId: t.id, dedupe: `crm-inforeq:${t.id}:${ctx.now.getTime()}`, email: true });
  });
}

/**
 * Transfer to another team (officer, Team Lead or CX Head override). The ticket enters the receiving team's
 * unassigned queue; the previous segment is closed, so time stays with the team that spent it.
 */
export async function transferTicket(ctx: Ctx, id: string, teamId: string, reason: string, lockVersion?: number | null) {
  const why = reasonOk(reason);
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id, lockVersion);
    if (!canWork(p, t)) throw forbidden("Only the assigned officer, the team's lead, the CX Head or a Super Admin can reroute this ticket.");
    if (CLOSED_OR_RESOLVED.includes(t.status)) throw conflict(`This ticket is ${STATUS_LABELS[t.status].toLowerCase()}.`);
    if (!uuidRe.test(teamId)) throw invalid("Choose a team.", { teamId: "Choose a team." });
    const team = (await tx.query<{ id: string; name: string }>("SELECT id, name FROM crm_teams WHERE id = $1 AND active", [teamId])).rows[0];
    if (!team) throw invalid("Choose an active team.", { teamId: "Not available." });
    if (team.id === t.team_id) throw invalid("The ticket is already with this team. Reassign it to an officer instead.", { teamId: "Same team." });
    const override = isOversight(p) && !canWork({ ...p, isCxHead: false, isAdmin: false }, t);
    await endSegment(tx, t.id, ctx.now, override ? "CX_HEAD_OVERRIDE" : "TRANSFERRED");
    await openSegment(tx, { ticketId: t.id, teamId: team.id, officerId: null, now: ctx.now, by: p.staffId, reason: why });
    await touch(tx, t.id, ctx.now, "team_id = $3, assignee_id = NULL, status = $4, reassign_count = reassign_count + 1", [team.id, t.status === "PENDING_INFO" ? "PENDING_INFO" : "UNASSIGNED"]);
    await event(tx, t.id, ctx.now, p.staffId, "TRANSFERRED", "PUBLIC", `Transferred to ${team.name}.`, { fromTeam: t.team_id, toTeam: team.id, override });
    await event(tx, t.id, ctx.now, p.staffId, "TRANSFER_REASON", "INTERNAL", why, { override });
    await crmAudit(tx, ctx, override ? "CRM_ROUTING_OVERRIDDEN" : "CRM_TICKET_TRANSFERRED", t, { reason: why, from: t.team_id, to: team.id });
    await tell(tx, ctx.now, await queueManagers(tx, team.id), { kind: "CRM_TICKET_QUEUED", title: `Complaint ${t.ref} transferred to ${team.name}`, body: `“${t.subject}” — reason: ${why}`, ticketId: t.id, dedupe: `crm-queued:${t.id}:${team.id}:${ctx.now.getTime()}`, email: true });
  });
}

/** Manual escalation: flags the ticket and alerts the team's leads and the CX Head (once per escalation). */
export async function escalateTicket(ctx: Ctx, id: string, reason: string) {
  const why = reasonOk(reason);
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id);
    if (!canWork(p, t)) throw forbidden();
    if (CLOSED_OR_RESOLVED.includes(t.status)) throw conflict(`This ticket is ${STATUS_LABELS[t.status].toLowerCase()}.`);
    await touch(tx, t.id, ctx.now, "escalated = true, escalated_at = coalesce(escalated_at, $2)");
    await event(tx, t.id, ctx.now, p.staffId, "ESCALATED", "INTERNAL", why, { manual: true });
    await crmAudit(tx, ctx, "CRM_TICKET_ESCALATED", t, { reason: why });
    await tell(tx, ctx.now, [...(await teamLeads(tx, t.team_id)), ...(await holdersOf(tx, "CX_HEAD"))].filter((r) => r.id !== p.staffId), {
      kind: "CRM_ESCALATION",
      title: `Escalated: ${t.ref}`,
      body: `${t.subject} — ${why}`,
      ticketId: t.id,
      dedupe: `crm-esc-manual:${t.id}:${ctx.now.getTime()}`,
      email: true,
    });
  });
}

/** CX Head asks a team's leads to act on a ticket (recorded on the timeline). */
export async function requestAction(ctx: Ctx, id: string, message: string) {
  const text = reasonOk(message, "message");
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    if (!isOversight(p)) throw forbidden("Only the CX Head or a Super Admin can request action from a team.");
    const t = await lockTicket(tx, id);
    await event(tx, t.id, ctx.now, p.staffId, "ACTION_REQUESTED", "INTERNAL", text);
    await touch(tx, t.id, ctx.now, "");
    await crmAudit(tx, ctx, "CRM_ACTION_REQUESTED", t, { reason: text });
    const to = [...(await teamLeads(tx, t.team_id)), ...((await staffById(tx, t.assignee_id)) ? [(await staffById(tx, t.assignee_id))!] : [])];
    await tell(tx, ctx.now, to, { kind: "CRM_ACTION_REQUESTED", title: `Oversight requests action on ${t.ref}`, body: text, ticketId: t.id, dedupe: `crm-act:${t.id}:${ctx.now.getTime()}`, email: true });
  });
}

/** Resolve with a summary of the action taken and the outcome. The complainant then confirms or reopens. */
export async function resolveTicket(ctx: Ctx, id: string, summary: string, lockVersion?: number | null) {
  const text = String(summary ?? "").trim();
  if (text.length < 20 || text.length > 5000) throw invalid("Explain the action taken and the outcome (at least 20 characters).", { summary: "Write a resolution summary." });
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id, lockVersion);
    if (!canWork(p, t)) throw forbidden("Only the assigned officer or the team's lead can resolve this ticket.");
    if (!["ASSIGNED", "IN_PROGRESS", "PENDING_INFO", "REOPENED"].includes(t.status)) throw conflict(`This ticket is ${STATUS_LABELS[t.status].toLowerCase()}.`);
    if (!t.assignee_id) throw conflict("Assign the ticket to an officer before resolving it.");
    await resumeClock(tx, t, ctx.now, await crmSettings(tx));
    await endSegment(tx, t.id, ctx.now, "RESOLVED");
    await touch(tx, t.id, ctx.now, "status = 'RESOLVED', resolved_at = $2, resolved_by = $3, resolution_summary = $4, started_at = coalesce(started_at, $2), first_response_at = coalesce(first_response_at, $2)", [p.staffId, text]);
    await event(tx, t.id, ctx.now, p.staffId, "RESOLVED", "PUBLIC", text);
    await crmAudit(tx, ctx, "CRM_TICKET_RESOLVED", t, { details: { summaryLength: text.length } });
    const creator = await staffById(tx, t.creator_id);
    if (creator) await tell(tx, ctx.now, [creator], { kind: "CRM_RESOLVED", title: `Your complaint ${t.ref} was resolved`, body: `${text.slice(0, 300)} — confirm it is resolved, or tell us the issue persists.`, ticketId: t.id, dedupe: `crm-resolved:${t.id}:${ctx.now.getTime()}`, email: true });
  });
}

/** Complainant confirms the resolution (closes the ticket), optionally rating the service. */
export async function confirmResolution(ctx: Ctx, id: string, rating?: { score?: number | null; comment?: string | null }) {
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id);
    if (t.creator_id !== p.staffId) throw forbidden("Only the person who raised the complaint can confirm it is resolved.");
    if (t.status !== "RESOLVED") throw conflict("Only a resolved ticket can be confirmed.");
    const score = rating?.score ? Number(rating.score) : null;
    if (score !== null && !(Number.isInteger(score) && score >= 1 && score <= 5)) throw invalid("Rate from 1 to 5.", { score: "1–5." });
    const comment = String(rating?.comment ?? "").trim().slice(0, 1000) || null;
    await touch(tx, t.id, ctx.now, "status = 'CLOSED', closed_at = $2, closed_by = $3, closed_how = 'CONFIRMED', satisfaction = $4, satisfaction_comment = $5", [p.staffId, score, comment]);
    await event(tx, t.id, ctx.now, p.staffId, "CLOSED", "PUBLIC", "The complainant confirmed the issue is resolved.", { satisfaction: score });
    await crmAudit(tx, ctx, "CRM_TICKET_CLOSED", t, { details: { how: "CONFIRMED", satisfaction: score } });
    const officer = await staffById(tx, t.resolved_by);
    if (officer) await tell(tx, ctx.now, [officer], { kind: "CRM_CLOSED", title: `${t.ref} closed`, body: "The complainant confirmed the resolution.", ticketId: t.id, dedupe: `crm-closed:${t.id}` });
  });
}

/** Complainant says the issue persists: the ticket reopens with the officer who resolved it (or their team's queue). */
export async function reopenTicket(ctx: Ctx, id: string, reason: string) {
  const why = reasonOk(reason);
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id);
    if (t.creator_id !== p.staffId && !isOversight(p)) throw forbidden("Only the person who raised the complaint, the CX Head or a Super Admin can reopen it.");
    if (!["RESOLVED", "CLOSED"].includes(t.status)) throw conflict("Only a resolved or closed ticket can be reopened.");
    const officerBack = t.assignee_id && (await activeMember(tx, t.team_id, t.assignee_id)) ? t.assignee_id : null;
    await openSegment(tx, { ticketId: t.id, teamId: t.team_id, officerId: officerBack, now: ctx.now, by: p.staffId, reason: `Reopened: ${why}` });
    await touch(tx, t.id, ctx.now, "status = $3, assignee_id = $4, reopen_count = reopen_count + 1, resolved_at = NULL, closed_at = NULL, closed_by = NULL, closed_how = NULL", [officerBack ? "REOPENED" : "UNASSIGNED", officerBack]);
    await event(tx, t.id, ctx.now, p.staffId, "REOPENED", "PUBLIC", why);
    await crmAudit(tx, ctx, "CRM_TICKET_REOPENED", t, { reason: why });
    const to = officerBack ? [(await staffById(tx, officerBack))!] : await queueManagers(tx, t.team_id);
    await tell(tx, ctx.now, [...to, ...(await teamLeads(tx, t.team_id))], { kind: "CRM_REOPENED", title: `Reopened: ${t.ref}`, body: `The issue persists: ${why}`, ticketId: t.id, dedupe: `crm-reopen:${t.id}:${ctx.now.getTime()}`, email: true });
  });
}

/** CX Head or Super Admin closes a ticket at any stage (e.g. duplicate, withdrawn, or the complainant has left the bank). Reason mandatory. */
export async function cxCloseTicket(ctx: Ctx, id: string, reason: string) {
  const why = reasonOk(reason);
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    if (!isOversight(p)) throw forbidden("Only the CX Head or a Super Admin can close a ticket.");
    const t = await lockTicket(tx, id);
    if (t.status === "CLOSED") throw conflict("This ticket is already closed.");
    const by = p.isCxHead ? "CX Head" : "Super Admin";
    await endSegment(tx, t.id, ctx.now, "CLOSED");
    await touch(tx, t.id, ctx.now, "status = 'CLOSED', closed_at = $2, closed_by = $3, closed_how = 'CX_HEAD'", [p.staffId]);
    await event(tx, t.id, ctx.now, p.staffId, "CLOSED", "PUBLIC", `Closed by the ${by}.`, {});
    await event(tx, t.id, ctx.now, p.staffId, "CLOSE_REASON", "INTERNAL", why);
    await crmAudit(tx, ctx, "CRM_TICKET_CLOSED", t, { reason: why, details: { how: "OVERSIGHT", by } });
  });
}

/** Link related tickets, or set a parent ticket for an incident affecting several requests or users. */
export async function linkTickets(ctx: Ctx, id: string, otherRef: string, asParent: boolean) {
  return withTx(async (tx) => {
    const p = await principalFor(tx, ctx);
    const t = await lockTicket(tx, id);
    if (!canManage(p, t) && !isOversight(p)) throw forbidden("Only the team's lead, the CX Head or a Super Admin can link tickets.");
    const other = (await tx.query<TicketRow>("SELECT * FROM crm_tickets WHERE upper(ref) = upper($1)", [String(otherRef ?? "").trim()])).rows[0];
    if (!other || !(await ticketView(tx, p, other))) throw invalid("No ticket with that reference that you can see.", { otherRef: "Not found." });
    if (other.id === t.id) throw invalid("A ticket cannot be linked to itself.", { otherRef: "Same ticket." });
    if (asParent) {
      if (other.parent_id === t.id) throw invalid("That ticket is already a child of this one.");
      await touch(tx, t.id, ctx.now, "parent_id = $3", [other.id]);
    } else {
      await tx.query("INSERT INTO crm_ticket_links (ticket_id, related_id, created_by, created_at) VALUES ($1,$2,$3,$4),($2,$1,$3,$4) ON CONFLICT DO NOTHING", [t.id, other.id, p.staffId, ctx.now]);
    }
    await event(tx, t.id, ctx.now, p.staffId, asParent ? "PARENT_SET" : "LINKED", "INTERNAL", `${asParent ? "Parent ticket" : "Related ticket"}: ${other.ref}.`, { other: other.id });
    await crmAudit(tx, ctx, "CRM_TICKET_LINKED", t, { details: { other: other.ref, asParent } });
  });
}

// ------------------------------------------------------------------ reads

export const TICKET_LIST_SELECT = `SELECT t.id, t.ref, t.subject, t.product_name, t.category_name, t.subcategory_name, t.priority, t.status, t.escalated,
    t.team_id, tm.name AS team_name, t.assignee_id, o.full_name AS assignee_name, t.creator_id, c.full_name AS creator_name,
    t.created_at, t.updated_at, t.resolution_due, t.assignment_due, t.first_response_due, t.resolved_at, t.closed_at, t.related_ref, t.application_id,
    (SELECT a.started_at FROM crm_assignments a WHERE a.ticket_id = t.id AND a.ended_at IS NULL) AS owner_since
  FROM crm_tickets t JOIN crm_teams tm ON tm.id = t.team_id LEFT JOIN staff o ON o.id = t.assignee_id JOIN staff c ON c.id = t.creator_id`;

export interface TicketListRow {
  id: string;
  ref: string;
  subject: string;
  product_name: string;
  category_name: string;
  subcategory_name: string;
  priority: Priority;
  status: TicketStatus;
  escalated: boolean;
  team_id: string;
  team_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  creator_id: string;
  creator_name: string;
  created_at: Date;
  updated_at: Date;
  resolution_due: Date | null;
  assignment_due: Date | null;
  first_response_due: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  related_ref: string | null;
  application_id: string | null;
  owner_since: Date | null;
}

export interface TicketFilter {
  q?: string;
  product?: string;
  categoryId?: string;
  status?: string;
  priority?: string;
  teamId?: string;
  assigneeId?: string;
  from?: string;
  to?: string;
  escalated?: boolean;
  overdue?: boolean;
}

/** Filtered list. `scope` limits rows to what the caller may see; filter values are always bound parameters. */
export async function listTickets(q: Db, scope: { kind: "ALL" } | { kind: "CREATOR"; staffId: string } | { kind: "ASSIGNEE"; staffId: string } | { kind: "TEAMS"; teamIds: string[] }, f: TicketFilter = {}, now = new Date(), limit = 300): Promise<TicketListRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (scope.kind === "CREATOR") add("t.creator_id = ?", scope.staffId);
  if (scope.kind === "ASSIGNEE") add("t.assignee_id = ?", scope.staffId);
  if (scope.kind === "TEAMS") add("t.team_id = ANY(?::uuid[])", scope.teamIds);
  if (f.q) add("(t.ref ILIKE ? OR t.subject ILIKE $X OR t.related_ref ILIKE $X)".replace(/\$X/g, `$${params.length + 1}`), `%${f.q.replace(/[%_]/g, "")}%`);
  if (f.product) add("t.product_code = ?", f.product);
  if (f.categoryId && uuidRe.test(f.categoryId)) add("t.category_id = ?", f.categoryId);
  if (f.status === "OPEN") add("t.status = ANY(?)", OPEN_STATUSES);
  else if (f.status) add("t.status = ?", f.status);
  if (f.priority) add("t.priority = ?", f.priority);
  if (f.teamId && uuidRe.test(f.teamId)) add("t.team_id = ?", f.teamId);
  if (f.assigneeId && uuidRe.test(f.assigneeId)) add("t.assignee_id = ?", f.assigneeId);
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) add("t.created_at >= (?::date)::timestamp AT TIME ZONE 'Africa/Lagos'", f.from);
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) add("t.created_at < ((?::date + 1)::timestamp AT TIME ZONE 'Africa/Lagos')", f.to);
  if (f.escalated) where.push("t.escalated AND t.status NOT IN ('RESOLVED','CLOSED')");
  if (f.overdue) add("t.status = ANY(?) AND t.resolution_due IS NOT NULL AND t.paused_at IS NULL AND t.resolution_due < $NOW", OPEN_STATUSES);
  let sql = `${TICKET_LIST_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, t.created_at DESC LIMIT ${Math.min(Math.max(1, limit), 1000)}`;
  if (sql.includes("$NOW")) {
    params.push(now);
    sql = sql.replace("$NOW", `$${params.length}`);
  }
  return (await q.query<TicketListRow>(sql, params)).rows;
}

export interface TicketDetail {
  ticket: TicketRow & { team_name: string; assignee_name: string | null; creator_name: string; creator_email: string; resolved_by_name: string | null; parent_ref: string | null };
  view: Exclude<import("./core").TicketView, null>;
  events: { id: string; at: Date; actor_name: string | null; kind: string; visibility: string; body: string | null; details: Record<string, unknown> }[];
  assignments: { id: string; team_name: string; officer_name: string | null; started_at: Date; accepted_at: Date | null; ended_at: Date | null; end_reason: string | null; reason: string | null; assigned_by_name: string | null }[];
  attachments: { id: string; filename: string; mime_type: string; size_bytes: string; scan_status: string; internal: boolean; purpose: string; uploaded_by_name: string; uploaded_at: Date }[];
  links: { id: string; ref: string; subject: string; status: TicketStatus }[];
  children: { id: string; ref: string; subject: string; status: TicketStatus }[];
  principal: CrmPrincipal;
}

/** Ticket for a viewer. Complainants get the public timeline only; handlers and oversight get everything. */
export async function ticketDetail(q: Db, staffId: string, id: string): Promise<TicketDetail | null> {
  if (!uuidRe.test(id)) return null;
  const p = await crmPrincipal(q, staffId);
  const t = (
    await q.query<TicketDetail["ticket"]>(
      `SELECT t.*, tm.name AS team_name, o.full_name AS assignee_name, c.full_name AS creator_name, c.email AS creator_email, rb.full_name AS resolved_by_name, par.ref AS parent_ref
         FROM crm_tickets t JOIN crm_teams tm ON tm.id = t.team_id LEFT JOIN staff o ON o.id = t.assignee_id JOIN staff c ON c.id = t.creator_id
         LEFT JOIN staff rb ON rb.id = t.resolved_by LEFT JOIN crm_tickets par ON par.id = t.parent_id WHERE t.id = $1`,
      [id],
    )
  ).rows[0];
  if (!t) return null;
  const view = await ticketView(q, p, t);
  if (!view) return null;
  const full = view === "FULL";
  const [events, assignments, attachments, links, children] = await Promise.all([
    q.query(`SELECT e.id, e.at, s.full_name AS actor_name, e.kind, e.visibility, e.body, e.details FROM crm_events e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.ticket_id = $1 ${full ? "" : "AND e.visibility = 'PUBLIC'"} ORDER BY e.id`, [id]),
    full
      ? q.query("SELECT a.id, tm.name AS team_name, o.full_name AS officer_name, a.started_at, a.accepted_at, a.ended_at, a.end_reason, a.reason, b.full_name AS assigned_by_name FROM crm_assignments a JOIN crm_teams tm ON tm.id = a.team_id LEFT JOIN staff o ON o.id = a.officer_id LEFT JOIN staff b ON b.id = a.assigned_by WHERE a.ticket_id = $1 ORDER BY a.started_at, a.id", [id])
      : Promise.resolve({ rows: [] }),
    q.query(`SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.scan_status, a.internal, a.purpose, s.full_name AS uploaded_by_name, a.uploaded_at FROM crm_attachments a JOIN staff s ON s.id = a.uploaded_by WHERE a.ticket_id = $1 ${full ? "" : "AND NOT a.internal"} ORDER BY a.uploaded_at`, [id]),
    full ? q.query("SELECT t.id, t.ref, t.subject, t.status FROM crm_ticket_links l JOIN crm_tickets t ON t.id = l.related_id WHERE l.ticket_id = $1 ORDER BY t.ref", [id]) : Promise.resolve({ rows: [] }),
    full ? q.query("SELECT id, ref, subject, status FROM crm_tickets WHERE parent_id = $1 ORDER BY ref", [id]) : Promise.resolve({ rows: [] }),
  ]);
  if (!full) {
    // Complainant view: no routing internals.
    t.routing = {};
  }
  return { ticket: t, view, events: events.rows, assignments: assignments.rows, attachments: attachments.rows, links: links.rows, children: children.rows, principal: p };
}
