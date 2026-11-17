import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Configuration centre" };

interface Tile {
  href: string;
  title: string;
  body: string;
  status?: string;
}

export default async function ConfigurationCentre() {
  await requireSuperAdmin();
  const n = async (sql: string) => Number((await db.query(sql)).rows[0]?.n ?? 0);
  const waitingDocs = await n("SELECT count(*) AS n FROM document_generation g JOIN applications a ON a.id = g.application_id AND a.current_version_id = g.version_id WHERE g.status IN ('WAITING','FAILED')");
  const icFailed = await n("SELECT count(*) AS n FROM invoice_confirmations WHERE status = 'DISPATCH_FAILED'");
  const officers = await n("SELECT count(*) AS n FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND ra.role = 'INVOICE_CONFIRMATION_OFFICER' AND s.status = 'ACTIVE'");
  const sla = (await db.query("SELECT enabled, reminder_hours FROM sla_policy WHERE id = 1")).rows[0];
  const custEmail = !!(await db.query("SELECT customer_email_enabled FROM document_settings WHERE id = 1")).rows[0]?.customer_email_enabled;
  const templates = (await db.query<{ product_code: string; structure: string | null; production_approved: boolean }>("SELECT product_code, structure, production_approved FROM offer_templates WHERE status = 'ACTIVE' ORDER BY product_code")).rows;
  const groups: [string, Tile[]][] = [
    [
      "Products and approval",
      [
        { href: "/admin/product-settings", title: "Product settings", body: "Products, customer types, documents, pricing and workflow per product." },
        { href: "/admin/workflows", title: "Approval workflows", body: "Approval stages per product family. Every route includes a Team Lead or Unit Head." },
        { href: "/admin/pricing", title: "Pricing and tenor", body: "Mark-up and tenor limits." },
        { href: "/admin/feature-controls", title: "Feature controls", body: "Switch platform features on or off." },
      ],
    ],
    [
      "Documents",
      [
        { href: "/admin/templates", title: "Offer templates", body: "Bank-approved offer letters by product and structure (WakeelBoost by applicant type).", status: `${templates.filter((t) => t.production_approved).length} approved · ${templates.filter((t) => !t.production_approved).length} not approved` },
        { href: "/admin/closing-checklists", title: "Closing checklists", body: "Documents required per product before the pack is submitted and before disbursement." },
        { href: "/admin/document-settings", title: "Document settings", body: "Bank and Remita beneficiary details, charges and VAT, and whether documents are e-mailed to customers.", status: `Customer e-mails ${custEmail ? "on" : "off"} · ${waitingDocs ? `${waitingDocs} document(s) waiting` : "nothing waiting"}` },
        { href: "/admin/invoice-confirmation", title: "Invoice confirmation", body: "Invoice Confirmation Officers and open confirmations.", status: `${officers} officer(s)${icFailed ? ` · ${icFailed} not dispatched` : ""}` },
      ],
    ],
    [
      "Service levels and notifications",
      [
        { href: "/admin/sla-reminders", title: "SLA reminders", body: "Reminder emails to officers who have not acted on an assigned request.", status: sla?.enabled ? `On · after ${Number(sla.reminder_hours)} h` : "Off" },
        { href: "/admin/service-targets", title: "Service targets", body: "Escalation targets per stage." },
      ],
    ],
    [
      "Reports",
      [{ href: "/reports/credit-exceptions", title: "Credit score exceptions", body: "Requests submitted with Proceed with Reason after a low SeedFi score." }],
    ],
  ];
  return (
    <>
      <PageHeader eyebrow="Administration" title="Configuration centre" intro="Every setting that shapes how requests are originated, approved, documented and reminded, in one place. Each change asks for a reason and is recorded in the audit log." />
      {groups.map(([g, tiles]) => (
        <section key={g} aria-label={g} style={{ marginBottom: "var(--space-5)" }}>
          <h2>{g}</h2>
          <div className="config-grid">
            {tiles.map((t) => (
              <Link key={t.href} href={t.href} className="card config-tile">
                <strong>{t.title}</strong>
                <span className="small muted">{t.body}</span>
                {t.status && <span className="badge">{t.status}</span>}
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
