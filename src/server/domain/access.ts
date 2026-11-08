import type { Db } from "../db";
import type { Role } from "./roles";

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
 * Admin status alone does not grant case or document access.
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
  return { canView: capacities.length > 0, capacities };
}
