/**
 * Filters for the system audit trail, shared by the audit page and its CSV export. Every value is bound as a
 * parameter; dates are validated before use.
 */
import type { Db } from "./db";
import { AUDIT_CATEGORIES, categoryActions, type AuditCategory } from "@/lib/audit-events";

export interface AuditFilters {
  ref?: string;
  customer?: string;
  actor?: string;
  action?: string;
  outcome?: string;
  category?: string;
  from?: string;
  to?: string;
}

const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function auditWhere(f: AuditFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.ref?.trim()) add("upper(a.ref) = upper(?)", f.ref.trim());
  if (f.customer?.trim()) add("e.customer_id::text = ?", f.customer.trim());
  if (f.actor?.trim()) add("lower(coalesce(e.actor_email,'')) LIKE '%' || lower(?) || '%'", f.actor.trim());
  if (f.action?.trim()) add("e.action ILIKE '%' || ? || '%'", f.action.trim());
  if (f.outcome && ["SUCCESS", "DENIED", "FAILURE"].includes(f.outcome)) add("e.outcome = ?", f.outcome);
  if (f.category && (AUDIT_CATEGORIES as string[]).includes(f.category)) add("e.action = ANY(?)", categoryActions(f.category as AuditCategory));
  if (isDate(f.from)) add("e.occurred_at >= ((?::date)::timestamp AT TIME ZONE 'Africa/Lagos')", f.from);
  if (isDate(f.to)) add("e.occurred_at < ((?::date + 1)::timestamp AT TIME ZONE 'Africa/Lagos')", f.to);
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export async function auditRows(q: Db, f: AuditFilters, limit: number, offset = 0) {
  const w = auditWhere(f);
  return (
    await q.query(
      `SELECT e.*, a.ref, c.display_name AS customer_name, s.full_name AS actor_name FROM audit_events e
         LEFT JOIN applications a ON a.id = e.application_id LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN staff s ON s.id = e.actor_id
         ${w.sql} ORDER BY e.id DESC LIMIT ${Math.min(Math.max(1, Math.floor(limit)), 20000)} OFFSET ${Math.max(0, Math.floor(offset))}`,
      w.params,
    )
  ).rows;
}
