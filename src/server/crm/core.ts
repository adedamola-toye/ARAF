/**
 * CRM shared vocabulary, catalogue reads, settings and record-level access.
 *
 * Access model (enforced on the server for every read and action):
 *  - Every active ARAF user may raise complaints and sees the tickets they raised (public timeline only).
 *  - Team members (lead or officer) see their team's tickets with internal notes; officers act on tickets assigned
 *    to them; team leads assign, reassign and transfer their team's tickets.
 *  - Anyone who once handled a ticket (past team or past assignee) keeps read access to it.
 *  - The CX Head sees every ticket and may override routing; the Super Admin configures the CRM and sees every ticket.
 * CRM access never grants access to a financing request: linked requests still go through caseAccess.
 */
import type { Db } from "../db";
import { holdsRole } from "../domain/access";
import type { CrmCalendar } from "./calendar";

export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", CRITICAL: "Critical" };
export const isPriority = (v: unknown): v is Priority => typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);

export const STATUSES = ["NEW", "UNASSIGNED", "ASSIGNED", "IN_PROGRESS", "PENDING_INFO", "RESOLVED", "CLOSED", "REOPENED"] as const;
export type TicketStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<TicketStatus, string> = {
  NEW: "New",
  UNASSIGNED: "Unassigned",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In Progress",
  PENDING_INFO: "Pending Information",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};
/** Statuses in which a ticket is still being worked (not yet resolved). */
export const OPEN_STATUSES: TicketStatus[] = ["NEW", "UNASSIGNED", "ASSIGNED", "IN_PROGRESS", "PENDING_INFO", "REOPENED"];
export const FALLBACK_TEAM_ID = "00000000-0000-4000-8000-00000000c0de";

export interface CrmSettings extends CrmCalendar {
  fallback_team_id: string;
  closure_policy: "CONFIRMATION" | "TIMEOUT";
  closure_timeout_hours: number | null;
  pause_on_pending_info: boolean;
  updated_at: Date;
}

export async function crmSettings(q: Db): Promise<CrmSettings> {
  const r = (await q.query("SELECT *, to_json(holidays) AS holidays FROM crm_settings WHERE id = 1")).rows[0];
  return { ...r, holidays: (r.holidays ?? []).map(String) };
}

// ------------------------------------------------------------------ catalogue

export interface CrmProduct {
  code: string;
  name: string;
}

/** Products from the financing registry, then the CRM areas (Altphones, Staff Salary Advance, Platform). */
export async function crmProducts(q: Db, opts: { includeInactive?: boolean } = {}): Promise<CrmProduct[]> {
  const all = !!opts.includeInactive;
  return (
    await q.query<CrmProduct>(
      `SELECT code, name FROM (
         SELECT code, name, sort_order, 0 AS grp FROM products WHERE $1 OR active
         UNION ALL SELECT code, name, sort_order, 1 FROM crm_areas WHERE $1 OR active) x
        ORDER BY grp, sort_order, name`,
      [all],
    )
  ).rows;
}

export interface CrmCategory {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
}
export interface CrmSubcategory {
  id: string;
  category_id: string;
  name: string;
  product_code: string | null;
  default_priority: Priority;
  active: boolean;
  sort_order: number;
}

export async function crmCatalogue(q: Db, opts: { includeInactive?: boolean } = {}) {
  const all = !!opts.includeInactive;
  const categories = (await q.query<CrmCategory>("SELECT id, code, name, description, active, sort_order FROM crm_categories WHERE $1 OR active ORDER BY sort_order, name", [all])).rows;
  const subcategories = (
    await q.query<CrmSubcategory>(
      "SELECT id, category_id, name, product_code, default_priority, active, sort_order FROM crm_subcategories WHERE $1 OR active ORDER BY sort_order, name",
      [all],
    )
  ).rows;
  return { categories, subcategories };
}

// ------------------------------------------------------------------ principals and access

export interface CrmPrincipal {
  staffId: string;
  active: boolean;
  isAdmin: boolean;
  isCxHead: boolean;
  leadTeams: string[];
  officerTeams: string[];
}

export async function crmPrincipal(q: Db, staffId: string): Promise<CrmPrincipal> {
  const s = (await q.query<{ status: string }>("SELECT status FROM staff WHERE id = $1", [staffId])).rows[0];
  const teams = (
    await q.query<{ team_id: string; member_role: string }>(
      "SELECT m.team_id, m.member_role FROM crm_team_members m JOIN crm_teams t ON t.id = m.team_id AND t.active WHERE m.staff_id = $1 AND m.active",
      [staffId],
    )
  ).rows;
  return {
    staffId,
    active: s?.status === "ACTIVE",
    isAdmin: await holdsRole(q, staffId, "SUPER_ADMIN"),
    isCxHead: await holdsRole(q, staffId, "CX_HEAD"),
    leadTeams: teams.filter((t) => t.member_role === "LEAD").map((t) => t.team_id),
    officerTeams: teams.map((t) => t.team_id),
  };
}

/** Organisation-wide oversight (CX Head or Super Admin). */
export const isOversight = (p: CrmPrincipal) => p.isCxHead || p.isAdmin;
/** Has any operational CRM responsibility (sees the working views). */
export const isOperator = (p: CrmPrincipal) => isOversight(p) || p.officerTeams.length > 0;

export type TicketView = "FULL" | "PUBLIC" | null;

export interface TicketAccessRow {
  id: string;
  creator_id: string;
  team_id: string;
  assignee_id: string | null;
}

/** FULL = internal notes and handling detail; PUBLIC = complainant view; null = no access. */
export async function ticketView(q: Db, p: CrmPrincipal, t: TicketAccessRow): Promise<TicketView> {
  if (!p.active) return null;
  if (isOversight(p)) return "FULL";
  if (t.assignee_id === p.staffId || p.officerTeams.includes(t.team_id)) return "FULL";
  const past = await q.query(
    `SELECT 1 FROM crm_assignments a WHERE a.ticket_id = $1 AND (a.officer_id = $2 OR a.team_id IN
       (SELECT team_id FROM crm_team_members WHERE staff_id = $2 AND active)) LIMIT 1`,
    [t.id, p.staffId],
  );
  if (past.rowCount) return "FULL";
  if (t.creator_id === p.staffId) return "PUBLIC";
  return null;
}

/** May manage the ticket's queue (assign, reroute/transfer): lead of its current team, the CX Head, or a Super Admin. */
export const canManage = (p: CrmPrincipal, t: TicketAccessRow) => isOversight(p) || p.leadTeams.includes(t.team_id);
/** May work the ticket: its assignee, a lead of its current team, the CX Head, or a Super Admin. */
export const canWork = (p: CrmPrincipal, t: TicketAccessRow) => t.assignee_id === p.staffId || canManage(p, t);

/** Active staff holding a role (for CX Head / Super Admin alerts). */
export async function holdersOf(q: Db, role: string): Promise<{ id: string; email: string; full_name: string }[]> {
  return (
    await q.query<{ id: string; email: string; full_name: string }>(
      "SELECT s.id, s.email, s.full_name FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND ra.role = $1 AND s.status = 'ACTIVE' ORDER BY s.full_name",
      [role],
    )
  ).rows;
}

export async function teamLeads(q: Db, teamId: string): Promise<{ id: string; email: string; full_name: string }[]> {
  return (
    await q.query<{ id: string; email: string; full_name: string }>(
      "SELECT s.id, s.email, s.full_name FROM crm_team_members m JOIN staff s ON s.id = m.staff_id WHERE m.team_id = $1 AND m.active AND m.member_role = 'LEAD' AND s.status = 'ACTIVE' ORDER BY s.full_name",
      [teamId],
    )
  ).rows;
}

export const ticketLink = (id: string) => `/crm/tickets/${id}`;
export const formatRef = (seq: number | string) => `ARAF-CRM-${String(seq).padStart(6, "0")}`;

/** Badge counts for the navigation: my open assignments, unassigned in my teams, escalated (oversight). */
export async function crmNavCounts(q: Db, p: CrmPrincipal): Promise<{ assigned: number; unassigned: number; escalated: number }> {
  const r = (
    await q.query<{ assigned: string; unassigned: string; escalated: string }>(
      `SELECT count(*) FILTER (WHERE assignee_id = $1 AND status = ANY($3)) AS assigned,
              count(*) FILTER (WHERE status = 'UNASSIGNED' AND team_id = ANY($2::uuid[])) AS unassigned,
              count(*) FILTER (WHERE $4 AND escalated AND status = ANY($3)) AS escalated
         FROM crm_tickets WHERE status = ANY($3)`,
      [p.staffId, p.leadTeams, OPEN_STATUSES, isOversight(p)],
    )
  ).rows[0];
  return { assigned: Number(r.assigned), unassigned: Number(r.unassigned), escalated: Number(r.escalated) };
}
