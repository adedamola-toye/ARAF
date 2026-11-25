import type { Db } from "../db";
import type { Role } from "./roles";
import { supervision } from "./org";

export interface CaseAccess {
  canView: boolean;
  capacities: string[];
}

export async function activeRoles(q: Db, staffId: string): Promise<{ role: Role; region: string | null; business_unit: string | null }[]> {
  const r = await q.query<{ role: Role; region: string | null; business_unit: string | null }>(
    `SELECT ra.role, ra.region, ra.business_unit FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
      WHERE ra.staff_id = $1 AND ra.active AND s.status = 'ACTIVE' ORDER BY ra.granted_at`,
    [staffId],
  );
  return r.rows;
}

export async function holdsRole(q: Db, staffId: string, role: string): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
      WHERE ra.staff_id = $1 AND ra.role = $2 AND ra.active AND s.status = 'ACTIVE'`,
    [staffId, role],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Case-scoped access. A staff member may view a case (summary, history, every retained document)
 * when they are:
 *   - the initiator;
 *   - any officer who has ever been assigned a task on the case (endorsers, reviewers, approvers,
 *     disbursement officers) - handoffs never remove historical access;
 *   - a member of an approved Legal / Shariah Compliance closure group whose group received the
 *     case's closure pack (requires the LEGAL_REVIEWER / SHARIAH_REVIEWER role).
 *   - the Super Admin (every request);
 *   - a supervisor of the originator (Team Lead, Unit Head, Divisional Head, RBE, Merchant Officer Head), or a
 *     Unit Head for requests in their region or pinned to them (see supervision()).
 */
export async function caseAccess(q: Db, staffId: string, appId: string): Promise<CaseAccess> {
  const r = await q.query<{ initiator: boolean; assigned: boolean; legal: boolean; shariah: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM applications a WHERE a.id = $2 AND a.initiator_id = $1) AS initiator,
       EXISTS (SELECT 1 FROM tasks t WHERE t.application_id = $2 AND t.assignee_id = $1) AS assigned,
       EXISTS (SELECT 1 FROM closure_events c JOIN role_assignments ra ON ra.staff_id = $1 AND ra.active AND ra.role = 'LEGAL_REVIEWER'
                JOIN staff s ON s.id = $1 AND s.status = 'ACTIVE'
                JOIN recipient_group_members m ON m.group_code = 'LEGAL' AND m.email = s.email
                WHERE c.application_id = $2 AND 'LEGAL' = ANY(c.groups)) AS legal,
       EXISTS (SELECT 1 FROM closure_events c JOIN role_assignments ra ON ra.staff_id = $1 AND ra.active AND ra.role = 'SHARIAH_REVIEWER'
                JOIN staff s ON s.id = $1 AND s.status = 'ACTIVE'
                JOIN recipient_group_members m ON m.group_code = 'SHARIAH' AND m.email = s.email
                WHERE c.application_id = $2 AND 'SHARIAH' = ANY(c.groups)) AS shariah`,
    [staffId, appId],
  );
  const row = r.rows[0];
  const status = await q.query("SELECT 1 FROM staff WHERE id = $1 AND status = 'ACTIVE'", [staffId]);
  if (!status.rowCount) return { canView: false, capacities: [] };
  const capacities: string[] = [];
  if (row.initiator) capacities.push("INITIATOR");
  if (row.assigned) capacities.push("CASE_OFFICER");
  if (row.legal) capacities.push("LEGAL_RECIPIENT");
  if (row.shariah) capacities.push("SHARIAH_RECIPIENT");
  // Retail scopes: assigned RM, team, outlet, retail leadership, exception authority, collections.
  const rr = (
    await q.query<{ assigned_rm: boolean; team: boolean; outlet: boolean; leadership: boolean; exception: boolean; collections: boolean; cx_oversight: boolean }>(
      `WITH a AS (SELECT * FROM applications WHERE id = $2 AND workflow = 'RETAIL'),
            mine AS (SELECT role, team FROM role_assignments WHERE staff_id = $1 AND active)
       SELECT
         EXISTS (SELECT 1 FROM a WHERE a.assigned_rm_id = $1 AND EXISTS (SELECT 1 FROM mine WHERE role = 'RM')) AS assigned_rm,
         EXISTS (SELECT 1 FROM a JOIN mine ON mine.role = 'TEAM_LEAD' AND mine.team IS NOT NULL AND mine.team = a.team WHERE a.stage <> 'DRAFT') AS team,
         EXISTS (SELECT 1 FROM a JOIN locations l ON l.id = a.outlet_location_id WHERE l.oss_staff_id = $1 AND a.stage <> 'DRAFT' AND EXISTS (SELECT 1 FROM mine WHERE role = 'OUTLET_SERVICE_SUPERVISOR')) AS outlet,
         EXISTS (SELECT 1 FROM a WHERE a.stage <> 'DRAFT' AND EXISTS (SELECT 1 FROM mine WHERE role IN ('HEAD_OF_RETAIL_SALES','HEAD_OF_UNIT'))) AS leadership,
         EXISTS (SELECT 1 FROM policy_exceptions pe WHERE pe.application_id = $2 AND pe.approver_role IN (SELECT role FROM mine)) AS exception,
         EXISTS (SELECT 1 FROM facilities f WHERE f.application_id = $2 AND EXISTS (SELECT 1 FROM mine WHERE role = 'COLLECTIONS_OFFICER')) AS collections,
         EXISTS (SELECT 1 FROM a
                  WHERE EXISTS (SELECT 1 FROM mine WHERE role IN ('CREDIT_LEAD_1','CREDIT_LEAD_2','CX_GROUP_HEAD'))
                    AND EXISTS (SELECT 1 FROM decisions d WHERE d.application_id = a.id AND d.actor_role = 'CX_CREDIT_REVIEWER')) AS cx_oversight`,
      [staffId, appId],
    )
  ).rows[0];
  if (rr?.assigned_rm) capacities.push("ASSIGNED_RM");
  if (rr?.team) capacities.push("TEAM_SUPERVISOR");
  if (rr?.outlet) capacities.push("OUTLET_SUPERVISOR");
  if (rr?.leadership) capacities.push("RETAIL_LEADERSHIP");
  if (rr?.cx_oversight) capacities.push("CX_OVERSIGHT");
  if (rr?.exception) capacities.push("EXCEPTION_AUTHORITY");
  if (rr?.collections) capacities.push("COLLECTIONS");
  // A Unit Head notified that a Team Lead skipped the business photograph can open that request (read access).
  const notified = await q.query("SELECT 1 FROM notifications n WHERE n.recipient_id = $1 AND n.application_id = $2 AND n.kind = 'VF_PHOTO_SKIPPED' AND EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = $1 AND ra.role = 'UNIT_HEAD' AND ra.active)", [staffId, appId]);
  if (notified.rowCount) capacities.push("NOTIFIED_UNIT_HEAD");
  // The Invoice Confirmation Officer a confirmation is (or was) assigned to.
  const ico = await q.query(
    "SELECT 1 FROM invoice_confirmations ic WHERE ic.application_id = $2 AND ic.officer_id = $1 AND EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = $1 AND ra.role = 'INVOICE_CONFIRMATION_OFFICER' AND ra.active)",
    [staffId, appId],
  );
  if (ico.rowCount) capacities.push("INVOICE_CONFIRMATION");
  // Anyone who reviewed or approved the request, or was ever assigned it (even if later reassigned), and the RBE /
  // Unit Head designated as its approver, can follow it to disbursement and beyond. Nothing needs configuring.
  const approver = await q.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM decisions d WHERE d.application_id = $2 AND d.actor_id = $1)
        OR EXISTS (SELECT 1 FROM assignment_changes ac JOIN tasks t ON t.id = ac.task_id WHERE t.application_id = $2 AND (ac.to_staff_id = $1 OR ac.from_staff_id = $1))
        OR EXISTS (SELECT 1 FROM applications a WHERE a.id = $2 AND a.stage <> 'DRAFT' AND (a.routing_unit_head_id = $1 OR a.selected_rbe_id = $1))`,
    [staffId, appId],
  );
  if (approver.rowCount) capacities.push("APPROVER");
  // The Super Admin sees every request.
  if (await holdsRole(q, staffId, "SUPER_ADMIN")) capacities.push("SUPER_ADMIN");
  // Supervisors see the submitted requests of the people they oversee (RM → Team Lead → Unit Head → Divisional
  // Head; RBE; Merchant Officer Head), requests in the regions of their Unit Head role, and requests on which they
  // are the pinned Unit Head. Viewing never grants an action: actions still require the assigned task.
  if (!capacities.includes("SUPER_ADMIN")) {
    const sv = await supervision(q, staffId);
    if (sv.staffIds.length || sv.teams.length || sv.regions.length || (await holdsRole(q, staffId, "UNIT_HEAD"))) {
      const hit = await q.query(
        `SELECT 1 FROM applications a JOIN staff i ON i.id = a.initiator_id WHERE a.id = $1 AND a.stage <> 'DRAFT' AND (
            a.initiator_id = ANY($2::uuid[]) OR a.assigned_rm_id = ANY($2::uuid[]) OR a.team = ANY($3::text[])
         OR a.region = ANY($4::text[]) OR i.region = ANY($4::text[]) OR a.routing_unit_head_id = $5)`,
        [appId, sv.staffIds, sv.teams, sv.regions, staffId],
      );
      if (hit.rowCount) capacities.push("SUPERVISOR");
    }
  }
  return { canView: capacities.length > 0, capacities };
}
