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
  const sw = async (k: string) => !!(await db.query("SELECT enabled FROM feature_switches WHERE key = $1", [k])).rows[0]?.enabled;
  const bq = (await db.query<{ eligible_products: string[]; max_size: number; min_inspections: number }>("SELECT eligible_products, max_size, min_inspections FROM bouquet_settings WHERE id = 1")).rows[0];
  const sa = (await db.query<{ version: number; deduction_rate_bps: number; eligibility_mode: string; eligibility_percent_bps: number; salary_record_max_age_days: number }>("SELECT * FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
  const registerN = await n("SELECT count(*) AS n FROM salary_register");
  const briefingOn = !!(await db.query("SELECT enabled FROM schedule_settings WHERE code = 'PERSONAL_BRIEFING'")).rows[0]?.enabled;
  const bouquetOn = await sw("BOUQUET_APPROVALS");
  const photoOn = await sw("VF_TL_PHOTO_REVIEW");
  const groups: [string, Tile[]][] = [
    [
      "Approvals, disbursement and staff financing",
      [
        { href: "/admin/bouquet-settings", title: "Facility Bouquet", body: "Divisional Head concurrence over many approved facilities: eligible products, size, inspections, thresholds.", status: `${bouquetOn ? "On" : "Off"} · ${bq?.eligible_products.length ? bq.eligible_products.join(", ") : "no eligible product"} · max ${bq?.max_size ?? "—"} · inspect ${bq?.min_inspections ?? "—"}` },
        { href: "/admin/feature-controls", title: "Business photograph requirement", body: "Vendor Financing Team Lead photograph (upload, or skip with a reason carried to the Unit Head).", status: photoOn ? "Required" : "Off" },
        { href: "/admin/staff-financing", title: "Salary advance", body: "Eligibility percentage, management fee, record validity, amounts, tenor and the Unit Head for the staff route.", status: sa ? `v${sa.version} · ${sa.eligibility_mode === "SALARY_REGISTER" ? `automatic ${sa.eligibility_percent_bps / 100}%` : "manual verification"} · fee ${sa.deduction_rate_bps / 100}% · record valid ${sa.salary_record_max_age_days} days` : undefined },
        { href: "/admin/salary-register", title: "Salary register", body: "Verified salaries and salary accounts (CSV with preview), holds and confirmed repayments.", status: `${registerN} record(s)` },
        { href: "/disbursements", title: "Disbursement controls", body: "CAD workspace: pre-disbursement checklist, holds, failed and uncertain postings. Offer acceptance: 24 hours for salary advance; no expiry configured for other products." },
        { href: "/admin/profile-editors", title: "Team profile editors", body: "Team Leads allowed to correct the name and business unit of people in their own team (never roles or access)." },
        { href: "/admin/schedules", title: "Weekly Performance Briefing", body: "Sunday reports (Africa/Lagos), personal briefings, preview and test send.", status: `Personal briefings ${briefingOn ? "on" : "off"}` },
      ],
    ],
    [
      "Products and approval",
      [
        { href: "/admin/product-settings", title: "Product settings", body: "Products, customer types, documents, pricing and workflow per product." },
        { href: "/admin/rm-routing", title: "RM classification and routing", body: "DBC or Non-DBC for each RM, RBE assignments and provisioning, DBC regional and E-commerce Unit Heads." },
        { href: "/admin/reporting-lines", title: "Reporting lines", body: "Merchant Officer → Lead → Head, and staff → Unit Head → Divisional Head, for routing and reports." },
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
