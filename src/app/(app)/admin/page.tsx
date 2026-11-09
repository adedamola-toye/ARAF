import Link from "next/link";
import { BookUser, Percent, CalendarClock, FileText, History, Mail, Route, Users, UsersRound } from "lucide-react";
import { requireSuperAdmin } from "./guard";
import { db } from "@/server/db";
import { PageHeader } from "@/components/PageHeader";
import { formatLagos } from "@/server/time";

export const metadata = { title: "Administration" };

export default async function AdminHome() {
  await requireSuperAdmin();
  const n = async (sql: string) => Number((await db.query(sql)).rows[0].n);
  const [staff, exceptions, dead, members] = await Promise.all([
    n("SELECT count(*) AS n FROM staff WHERE status = 'ACTIVE'"),
    n("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id IS NULL"),
    n("SELECT count(*) AS n FROM notification_outbox WHERE status IN ('FAILED','DEAD')"),
    n("SELECT count(*) AS n FROM recipient_group_members"),
  ]);
  const tpl = (await db.query("SELECT name, version, production_approved FROM offer_templates WHERE status = 'ACTIVE'")).rows[0];
  const recent = (
    await db.query(
      `SELECT e.occurred_at, e.action, e.actor_email, e.details FROM audit_events e
        WHERE e.action IN ('DIRECTORY_IMPORTED','STAFF_PROVISIONED','ROLE_GRANTED','ROLE_REVOKED','STAFF_STATUS_CHANGED','GROUP_MEMBER_ADDED','GROUP_MEMBER_REMOVED','TEMPLATE_CREATED','TEMPLATE_ACTIVATED','TEMPLATE_APPROVED','PRICING_SETTINGS_CHANGED','SCHEDULE_UPDATED','TASK_REASSIGNED')
        ORDER BY e.id DESC LIMIT 12`,
    )
  ).rows;
  const cards = [
    { href: "/admin/staff", icon: Users, title: "Users & roles", body: `${staff} active staff. Provision verified @altbank.ng staff and assign roles, states and positions.` },
    { href: "/admin/directory", icon: BookUser, title: "Bank directory", body: "Upload the bank's staff list (Excel or CSV). Provisioning and recipients are checked against it." },
    { href: "/admin/exceptions", icon: Route, title: "Routing exceptions", body: exceptions ? `${exceptions} stage(s) need an eligible assignee.` : "No unassigned stages. Hand over assigned tasks here." },
    { href: "/admin/groups", icon: UsersRound, title: "Closure recipients", body: `${members} approved Legal and Shariah Compliance recipient(s).` },
    { href: "/admin/templates", icon: FileText, title: "Offer templates", body: tpl ? `Active: ${tpl.name} v${tpl.version}${tpl.production_approved ? " (bank-approved)" : " (not bank-approved)"}.` : "No active template." },
    { href: "/admin/pricing", icon: Percent, title: "Pricing settings", body: "Flat markup rates by tenor band and the maximum tenor (≤ 6 months), with change history." },
    { href: "/admin/schedules", icon: CalendarClock, title: "Scheduled emails", body: "Weekly initiator digest and monthly leads summary." },
    { href: "/admin/outbox", icon: Mail, title: "Email delivery", body: dead ? `${dead} message(s) failed or awaiting retry.` : "All recent messages delivered or queued." },
    { href: "/admin/audit", icon: History, title: "Audit trail", body: "System-wide, per-request and per-customer audit with IP and device." },
  ];
  return (
    <>
      <PageHeader eyebrow="Administration" title="Overview" intro="Admin status does not grant approval powers. Workflow roles and case assignment govern approvals." />
      <div className="grid-3" style={{ marginBottom: 24 }}>
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="card" style={{ textDecoration: "none", color: "inherit", margin: 0 }}>
            <h2 style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <c.icon className="icon" aria-hidden="true" />
              {c.title}
            </h2>
            <p className="small muted" style={{ margin: 0 }}>
              {c.body}
            </p>
          </Link>
        ))}
      </div>
      <div className="card">
        <h2>Recent administrative changes</h2>
        <div className="table-wrap">
          <table className="data responsive">
            <thead>
              <tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr>
            </thead>
            <tbody>
              {recent.length === 0 && <tr><td colSpan={4} className="empty">No changes yet.</td></tr>}
              {recent.map((r, i) => (
                <tr key={i}>
                  <td className="small nowrap" data-label="When">{formatLagos(r.occurred_at)}</td>
                  <td className="small" data-label="Who">{r.actor_email}</td>
                  <td className="small mono" data-label="What">{r.action}</td>
                  <td className="small" data-label="Details" style={{ wordBreak: "break-word" }}>{JSON.stringify(r.details).slice(0, 160)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
