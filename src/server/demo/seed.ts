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
import { seedInitialProductConfigs } from "../domain/products";

export interface DemoStaff {
  email: string;
  name: string;
  roles: { role: Role; region?: string; team?: string }[];
  region?: string;
  unit?: string;
}

/** Real (non-synthetic) staff seeded in every environment. */
export const REAL_STAFF: DemoStaff[] = [
  { email: "tomiwa.adebanjo@altbank.ng", name: "Tomiwa Adebanjo", roles: [{ role: "SUPER_ADMIN" }], unit: "IT" },
  { email: "paul.toje@altbank.ng", name: "Paul Toje", roles: [{ role: "SUPER_ADMIN" }], unit: "IT" },
];

export const DEMO_STAFF: DemoStaff[] = [
  { email: "superadmin@altbank.ng", name: "Sade Admin", roles: [{ role: "SUPER_ADMIN" }], unit: "IT" },
  { email: "reports@altbank.ng", name: "Remi Reports", roles: [{ role: "REPORTING_ADMIN" }], unit: "MIS" },
  { email: "rm.ade@altbank.ng", name: "Ade Okafor", roles: [{ role: "RM", region: "SOUTH", team: "RETAIL-LAGOS-1" }], region: "SOUTH", unit: "Commercial" },
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
  // Retail Asset Factory (synthetic)
  { email: "rm.bola@altbank.ng", name: "Bola Adisa", roles: [{ role: "RM", region: "LAGOS", team: "RETAIL-LAGOS-1" }], region: "LAGOS", unit: "Retail" },
  { email: "rm.north@altbank.ng", name: "Sani Garba", roles: [{ role: "RM", region: "FCT (ABUJA)", team: "RETAIL-ABUJA-1" }], region: "FCT (ABUJA)", unit: "Retail" },
  { email: "do.ife@altbank.ng", name: "Ife Delight", roles: [{ role: "DELIGHT_OFFICER", region: "LAGOS", team: "RETAIL-LAGOS-1" }], region: "LAGOS", unit: "Retail" },
  { email: "oss.yaba@altbank.ng", name: "Kunle Supervisor", roles: [{ role: "OUTLET_SERVICE_SUPERVISOR", region: "LAGOS" }], region: "LAGOS", unit: "Retail" },
  { email: "tl.lagos@altbank.ng", name: "Funke Team-Lead", roles: [{ role: "TEAM_LEAD", region: "LAGOS", team: "RETAIL-LAGOS-1" }], region: "LAGOS", unit: "Retail" },
  { email: "tl.abuja@altbank.ng", name: "Emeka Team-Lead", roles: [{ role: "TEAM_LEAD", region: "FCT (ABUJA)", team: "RETAIL-ABUJA-1" }], region: "FCT (ABUJA)", unit: "Retail" },
  { email: "hrs@altbank.ng", name: "Yemi Retail-Sales", roles: [{ role: "HEAD_OF_RETAIL_SALES" }], unit: "Retail" },
  { email: "hou@altbank.ng", name: "Tola Unit-Approver", roles: [{ role: "HEAD_OF_UNIT" }], unit: "Retail" },
  { email: "config.approver@altbank.ng", name: "Nneka Config-Approver", roles: [{ role: "PRODUCT_CONFIG_APPROVER" }], unit: "Risk" },
  { email: "vendor.maker@altbank.ng", name: "Gbenga Vendor-Desk", roles: [{ role: "VENDOR_MANAGER" }], unit: "Operations" },
  { email: "vendor.checker@altbank.ng", name: "Rukky Vendor-Check", roles: [{ role: "VENDOR_MANAGER" }], unit: "Operations" },
  { email: "collections@altbank.ng", name: "Dayo Collections", roles: [{ role: "COLLECTIONS_OFFICER" }], unit: "Collections" },
  // Staff Personal Financing (synthetic)
  { email: "pm.staff@altbank.ng", name: "Kemi Product-Manager", roles: [{ role: "PRODUCT_MANAGER" }], unit: "Retail Products" },
  { email: "staff.okoro@altbank.ng", name: "Adaeze Okoro", roles: [{ role: "STAFF_APPLICANT" }], unit: "Finance" },
];

/** Synthetic outlet locations, institutions and vendors for development and tests (never seeded without --with-demo). */
export const DEMO_LOCATIONS = [
  { state: "LAGOS", city: "Yaba", outletType: "ALTBOX", name: "Yaba Altbox", oss: "oss.yaba@altbank.ng", team: "RETAIL-LAGOS-1" },
  { state: "LAGOS", city: "Ikeja", outletType: "BRANCH", name: "Ikeja Branch", oss: "oss.yaba@altbank.ng", team: "RETAIL-LAGOS-1" },
  { state: "FCT (ABUJA)", city: "Wuse", outletType: "ALTSHOP", name: "Wuse Altshop", oss: null, team: "RETAIL-ABUJA-1" },
];
export const DEMO_INSTITUTIONS = [
  { code: "DEMO-001", name: "Synthetic Commercial Bank (demo only)", category: "COMMERCIAL", aliases: ["SCB demo"], payment: true },
  { code: "DEMO-002", name: "Synthetic Microfinance Bank (demo only)", category: "MICROFINANCE", aliases: ["SMB demo"], payment: false },
];
export const DEMO_VENDORS = [
  { name: "Synthetic Distributors Ltd", email: "accounts@synthetic-distributors.example", institution: "DEMO-001", account: "0123456789", accountName: "SYNTHETIC DISTRIBUTORS LTD" },
  { name: "Synthetic Motors Ltd", email: "sales@synthetic-motors.example", institution: "DEMO-001", account: "0234567891", accountName: "SYNTHETIC MOTORS LTD" },
  { name: "Synthetic Solar Ltd", email: "orders@synthetic-solar.example", institution: "DEMO-002", account: "0345678912", accountName: "SYNTHETIC SOLAR LTD" },
];

/** Group mailboxes that are always seeded (the closure workflow needs them). */
export const GROUP_MAILBOXES = [
  { email: "legal@altbank.ng", name: "Legal Department" },
  { email: "shariah@altbank.ng", name: "Shariah Compliance Desk" },
];

/** Demo-only directory entries that are not provisioned (to demonstrate provisioning). */
export const EXTRA_DIRECTORY = [
  { email: "new.officer@altbank.ng", name: "Nkechi New-Officer", group: false },
];

export async function seedReferenceData(q: Db, opts: { includeDemo?: boolean } = {}) {
  const includeDemo = opts.includeDemo ?? true;
  const staff = includeDemo ? [...REAL_STAFF, ...DEMO_STAFF] : [...REAL_STAFF];
  for (const s of staff) {
    const source = REAL_STAFF.some((r) => r.email === s.email) ? "seed" : "synthetic-seed";
    await q.query(`INSERT INTO bank_directory (email, full_name, source) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING`, [s.email, s.name, source]);
  }
  for (const d of [...GROUP_MAILBOXES.map((g) => ({ ...g, group: true })), ...(includeDemo ? EXTRA_DIRECTORY : [])]) {
    await q.query(`INSERT INTO bank_directory (email, full_name, is_group_mailbox, source) VALUES ($1,$2,$3,'synthetic-seed') ON CONFLICT (email) DO NOTHING`, [d.email, d.name, d.group]);
  }
  const ids: Record<string, string> = {};
  for (const s of staff) {
    const r = await q.query<{ id: string }>(
      `INSERT INTO staff (email, full_name, region, business_unit) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
      [s.email, s.name, s.region ?? null, s.unit ?? null],
    );
    ids[s.email] = r.rows[0].id;
    for (const ra of s.roles) {
      await q.query(
        `INSERT INTO role_assignments (staff_id, role, region, business_unit, team) SELECT $1,$2,$3,$4,$5
          WHERE NOT EXISTS (SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = $2 AND active)`,
        [r.rows[0].id, ra.role, ra.region ?? null, s.unit ?? null, ra.team ?? null],
      );
    }
  }
  for (const [g, emails] of [
    ["LEGAL", ["legal@altbank.ng", ...(includeDemo ? ["legal.officer@altbank.ng"] : [])]],
    ["SHARIAH", ["shariah@altbank.ng", ...(includeDemo ? ["shariah.officer@altbank.ng"] : [])]],
  ] as const) {
    for (const e of emails) await q.query("INSERT INTO recipient_group_members (group_code, email) VALUES ($1,$2) ON CONFLICT DO NOTHING", [g, e]);
  }
  const tpl = await q.query("SELECT 1 FROM offer_templates");
  if (!tpl.rowCount) await seedOfferTemplates(q);
  await seedInitialProductConfigs(q);
  await seedRetailOfferTemplates(q);
  await seedStaffOfferTemplate(q);
  if (includeDemo) await seedRetailDemoReference(q, ids);
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

async function seedRetailDemoReference(q: Db, ids: Record<string, string>) {
  for (const l of DEMO_LOCATIONS) {
    await q.query(
      `INSERT INTO locations (state, city, outlet_type, name, oss_staff_id, team) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (state, city, outlet_type, name) DO NOTHING`,
      [l.state, l.city, l.outletType, l.name, l.oss ? ids[l.oss] : null, l.team],
    );
  }
  for (const i of DEMO_INSTITUTIONS) {
    await q.query(
      `INSERT INTO financial_institutions (code, name, aliases, category, regulatory_status, payment_supported, source, source_reference)
       VALUES ($1,$2,$3,$4,'UNCONFIRMED',$5,'synthetic-seed','Synthetic demo data: replace with the CBN list and payment-provider routing codes') ON CONFLICT (code) DO NOTHING`,
      [i.code, i.name, i.aliases, i.category, i.payment],
    );
  }
  for (const v of DEMO_VENDORS) {
    const exists = await q.query("SELECT 1 FROM vendors WHERE name = $1", [v.name]);
    if (exists.rowCount) continue;
    const vid = (await q.query<{ id: string }>(`INSERT INTO vendors (name, email, verification_status, created_by, verified_by, verified_at) VALUES ($1,$2,'VERIFIED',$3,$4,now()) RETURNING id`, [v.name, v.email, ids["vendor.maker@altbank.ng"], ids["vendor.checker@altbank.ng"]])).rows[0].id;
    const inst = (await q.query<{ id: string }>("SELECT id FROM financial_institutions WHERE code = $1", [v.institution])).rows[0].id;
    await q.query(
      `INSERT INTO vendor_accounts (vendor_id, institution_id, account_number, account_name, verification_status, verification_method, verification_note, created_by, verified_by, verified_at)
       VALUES ($1,$2,$3,$4,'VERIFIED','MANUAL_EVIDENCE','Synthetic seed account (demo only)',$5,$6,now())`,
      [vid, inst, v.account, v.accountName, ids["vendor.maker@altbank.ng"], ids["vendor.checker@altbank.ng"]],
    );
  }
}

/**
 * Draft retail offer templates (HTML) per product and structure. Seeded ACTIVE but NOT approved:
 * retail offers can be generated only after the Super Admin approves the bank's wording.
 */
export const RETAIL_OFFER_TEMPLATE_HTML = `<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility ({{structure}}) on the terms below, subject to the bank's standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>DRAFT WORDING: replace with the bank-approved offer and contract text before approving this template.</p>`;

export const STAFF_OFFER_TEMPLATE_HTML = `<h1>Offer of Staff Personal Financing</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>Dear {{staff_name}} (Staff ID {{staff_id}}, {{department}}, {{unit}}),</p>
<table>
<tr><th>Approved financing amount</th><td>{{approved_amount}}</td></tr>
<tr><th>Deduction ({{deduction_rate}})</th><td>{{deduction_amount}}</td></tr>
<tr><th>Net amount to be disbursed</th><td>{{net_amount}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}}</td></tr>
<tr><th>Salary account</th><td>{{salary_account}} ({{salary_account_name}})</td></tr>
<tr><th>Approved on</th><td>{{approval_date}}</td></tr>
</table>
<p>Return this letter signed by {{acceptance_deadline}}. After that time the offer lapses.</p>
<p>DRAFT WORDING: replace with the bank-approved Legal and Shariah offer text before approving this template.</p>`;

/** Draft staff offer template: ACTIVE but not approved, so no offer is issued until the bank approves its wording. */
export async function seedStaffOfferTemplate(q: Db) {
  await q.query(
    `INSERT INTO offer_templates (name, version, format, applicant_type, body_html, status, production_approved, notes, activated_at)
     SELECT 'Staff personal financing offer', 1, 'HTML', 'STAFF', $1, 'ACTIVE', false, 'Draft placeholder wording: approve only after replacing with the bank-approved text.', now()
      WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE applicant_type = 'STAFF')`,
    [STAFF_OFFER_TEMPLATE_HTML],
  );
}

export async function seedRetailOfferTemplates(q: Db) {
  const combos = [
    ["VENDOR_FINANCING", "STANDARD"],
    ["ALT_DRIVE", "MURABAHA"],
    ["ALT_DRIVE", "IJARAH"],
  ];
  for (const [product, structure] of combos) {
    await q.query(
      `INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, notes, activated_at)
       SELECT $1, 1, 'HTML', $2, $3, $4, 'ACTIVE', false, 'Draft placeholder wording: approve only after replacing with the bank-approved text.', now()
        WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE product_code = $2 AND structure = $3)`,
      [`${product.replace("_", " ")} ${structure} offer`, product, structure, RETAIL_OFFER_TEMPLATE_HTML],
    );
  }
}
