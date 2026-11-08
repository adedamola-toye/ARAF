/**
 * SYNTHETIC development data. Every person, customer and identifier here is fictitious.
 */
import type { Db } from "../db";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { objectStore } from "../storage";
import { DOCX_MIME } from "../domain/offer";
import type { Role } from "../domain/roles";

export interface DemoStaff {
  email: string;
  name: string;
  roles: { role: Role; region?: string }[];
  region?: string;
  unit?: string;
}

export const DEMO_STAFF: DemoStaff[] = [
  { email: "superadmin@altbank.ng", name: "Sade Admin", roles: [{ role: "SUPER_ADMIN" }], unit: "IT" },
  { email: "reports@altbank.ng", name: "Remi Reports", roles: [{ role: "REPORTING_ADMIN" }], unit: "MIS" },
  { email: "rm.ade@altbank.ng", name: "Ade Okafor", roles: [{ role: "RM", region: "SOUTH" }], region: "SOUTH", unit: "Commercial" },
  { email: "anm.north@altbank.ng", name: "Musa Bello", roles: [{ role: "ANM", region: "NORTH" }], region: "NORTH", unit: "Agency" },
  { email: "anm.south@altbank.ng", name: "Ngozi Eze", roles: [{ role: "ANM", region: "SOUTH" }], region: "SOUTH", unit: "Agency" },
  { email: "mo.chi@altbank.ng", name: "Chioma Nwosu", roles: [{ role: "MERCHANT_OFFICER", region: "SOUTH" }, { role: "RM", region: "SOUTH" }], region: "SOUTH", unit: "Merchant" },
  { email: "rbe.lagos@altbank.ng", name: "Tunde Adeyemi", roles: [{ role: "RBE", region: "SOUTH" }], region: "SOUTH" },
  { email: "rbe.abuja@altbank.ng", name: "Hauwa Sani", roles: [{ role: "RBE", region: "NORTH" }], region: "NORTH" },
  { email: "mo.lead@altbank.ng", name: "Kemi Ajayi", roles: [{ role: "MERCHANT_OFFICER_LEAD" }] },
  { email: "anm.lead.north@altbank.ng", name: "Ibrahim Danjuma", roles: [{ role: "ANM_LEAD_NORTH", region: "NORTH" }], region: "NORTH" },
  { email: "anm.lead.south@altbank.ng", name: "Ifeoma Obi", roles: [{ role: "ANM_LEAD_SOUTH", region: "SOUTH" }], region: "SOUTH" },
  { email: "co1@altbank.ng", name: "Bola Credit-One", roles: [{ role: "CREDIT_OFFICER_1" }], unit: "Credit" },
  { email: "co2@altbank.ng", name: "Yusuf Credit-Two", roles: [{ role: "CREDIT_OFFICER_2" }], unit: "Credit" },
  { email: "co3@altbank.ng", name: "Amaka Credit-Three", roles: [{ role: "CREDIT_OFFICER_3" }], unit: "Credit" },
  { email: "lead1@altbank.ng", name: "Femi Lead-One", roles: [{ role: "CREDIT_LEAD_1" }], unit: "Credit" },
  { email: "lead2@altbank.ng", name: "Zainab Lead-Two", roles: [{ role: "CREDIT_LEAD_2" }], unit: "Credit" },
  { email: "unit.head@altbank.ng", name: "Olu Unit-Head", roles: [{ role: "UNIT_HEAD" }], unit: "Credit" },
  { email: "div.head@altbank.ng", name: "Grace Divisional-Head", roles: [{ role: "DIVISIONAL_HEAD" }], unit: "Credit" },
  { email: "do1@altbank.ng", name: "Peter Disburse-One", roles: [{ role: "DISBURSEMENT_OFFICER_1" }], unit: "Operations" },
  { email: "do2@altbank.ng", name: "Mary Disburse-Two", roles: [{ role: "DISBURSEMENT_OFFICER_2" }], unit: "Operations" },
  { email: "legal.officer@altbank.ng", name: "Lanre Legal", roles: [{ role: "LEGAL_REVIEWER" }], unit: "Legal" },
  { email: "shariah.officer@altbank.ng", name: "Aisha Shariah", roles: [{ role: "SHARIAH_REVIEWER" }], unit: "Shariah Compliance" },
];

/** Directory entries that are not provisioned (to demonstrate provisioning) and group mailboxes. */
export const EXTRA_DIRECTORY = [
  { email: "new.officer@altbank.ng", name: "Nkechi New-Officer", group: false },
  { email: "legal@altbank.ng", name: "Legal Department", group: true },
  { email: "shariah@altbank.ng", name: "Shariah Compliance Desk", group: true },
];

export async function seedReferenceData(q: Db) {
  for (const s of DEMO_STAFF) {
    await q.query(`INSERT INTO bank_directory (email, full_name, source) VALUES ($1,$2,'synthetic-seed') ON CONFLICT (email) DO NOTHING`, [s.email, s.name]);
  }
  for (const d of EXTRA_DIRECTORY) {
    await q.query(`INSERT INTO bank_directory (email, full_name, is_group_mailbox, source) VALUES ($1,$2,$3,'synthetic-seed') ON CONFLICT (email) DO NOTHING`, [d.email, d.name, d.group]);
  }
  const ids: Record<string, string> = {};
  for (const s of DEMO_STAFF) {
    const r = await q.query<{ id: string }>(
      `INSERT INTO staff (email, full_name, region, business_unit) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
      [s.email, s.name, s.region ?? null, s.unit ?? null],
    );
    ids[s.email] = r.rows[0].id;
    for (const ra of s.roles) {
      await q.query(
        `INSERT INTO role_assignments (staff_id, role, region, business_unit) SELECT $1,$2,$3,$4
          WHERE NOT EXISTS (SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = $2 AND active)`,
        [r.rows[0].id, ra.role, ra.region ?? null, s.unit ?? null],
      );
    }
  }
  for (const [g, emails] of [
    ["LEGAL", ["legal@altbank.ng", "legal.officer@altbank.ng"]],
    ["SHARIAH", ["shariah@altbank.ng", "shariah.officer@altbank.ng"]],
  ] as const) {
    for (const e of emails) await q.query("INSERT INTO recipient_group_members (group_code, email) VALUES ($1,$2) ON CONFLICT DO NOTHING", [g, e]);
  }
  const tpl = await q.query("SELECT 1 FROM offer_templates");
  if (!tpl.rowCount) await seedOfferTemplates(q);
  return ids;
}

/**
 * The bank's Murabaha offer letters (Individual / Enterprise / Corporate, 9-1-24) converted to
 * placeholder templates by scripts/build-offer-templates.py. Seeded ACTIVE but NOT production
 * approved: the Super Admin approves each after reviewing a generated letter.
 */
export const BANK_OFFER_TEMPLATES = [
  { type: "INDIVIDUAL", file: "murabaha-individual.docx", source: "Murabaha-Individual-Offer-9-1-24.docx" },
  { type: "ENTERPRISE", file: "murabaha-enterprise.docx", source: "Murabaha-Enterprise-Offer-9-1-24.docx" },
  { type: "LIMITED", file: "murabaha-limited.docx", source: "Murabaha-Corporate-Offer-9-1-24.docx" },
] as const;

export async function seedOfferTemplates(q: Db) {
  for (const t of BANK_OFFER_TEMPLATES) {
    const data = await readFile(path.resolve(process.cwd(), "templates/offers", t.file));
    const key = `templates/offer/${randomUUID()}.docx`;
    await objectStore().put(key, data, DOCX_MIME);
    await q.query(
      `INSERT INTO offer_templates (name, version, format, applicant_type, storage_key, source_filename, status, production_approved, notes, activated_at)
       VALUES ($1, 1, 'DOCX', $2, $3, $4, 'ACTIVE', false, $5, now())`,
      [`Murabaha ${t.type === "LIMITED" ? "Corporate" : t.type.charAt(0) + t.type.slice(1).toLowerCase()} Offer`, t.type, key, t.source, "Bank letter 9-1-24 with WakeelBoost placeholders. Approve after reviewing a generated letter."],
    );
  }
}
