/**
 * Closing documents ARAF prepares automatically once a request receives final approval (it enters offer
 * preparation): the offer letter (from the bank's approved template for the product / structure or
 * applicant type), the NIBSS GSI mandate form and the Remita direct debit set-up sheet, prefilled from the
 * approved application. Generation is idempotent per approved version, retried by the worker, and never
 * shows a "template missing" message to users: when something is not available the Super Admin is alerted
 * and the case shows the document as being prepared.
 */
import { db, withTx, type Db, type Tx } from "../db";
import { systemCtx, type Ctx } from "../context";
import { audit } from "../audit";
import { decryptField } from "../crypto";
import { formatKobo } from "../money";
import { lagosDate } from "../time";
import { enqueueEmail } from "../notify/outbox";
import { notify } from "./notifications";
import { storeGeneratedDocument } from "./documents";
import { buildGsiPdf, buildRemitaSetupPdf, type GsiValues, type RemitaValues } from "./closing-pdfs";
import { renderRetailOffer, retailTemplate } from "./retail-offer";
import { activeTemplate, renderWakeelOffer } from "./offer";
import { approvedRetailAssessment } from "./retail";
import { approvedAssessment } from "./assessment";
import { config } from "../config";
import { forbidden, invalid } from "../errors";
import { holdsRole } from "./access";

export const CLOSING_KINDS = ["OFFER", "GSI", "REMITA_SETUP"] as const;
export type ClosingKind = (typeof CLOSING_KINDS)[number];
export const CLOSING_LABELS: Record<ClosingKind, string> = { OFFER: "Offer letter", GSI: "GSI mandate form", REMITA_SETUP: "Remita direct debit set-up sheet" };
/** Stages after final approval while the closing pack is being prepared or checked. */
export const CLOSING_STAGES = ["OFFER_PREPARATION", "CO3_PACK_REVIEW", "DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION"];
const MAX_ATTEMPTS = 5;

export interface RepaymentAccount {
  bankName: string;
  accountNumber: string;
  accountName: string;
  branch: string;
  townCity: string;
}

/** Something the document needs is not available yet (not an error: retried, and the admin is told when it is configuration). */
class Waiting extends Error {
  constructor(
    readonly reason: "TEMPLATE" | "REPAYMENT_ACCOUNT" | "CORPORATE_GSI" | "ASSESSMENT",
    message: string,
  ) {
    super(message);
  }
}

/** Called when a request enters offer preparation: one row per document for the approved version. */
export async function queueClosingDocuments(tx: Tx, appId: string, versionId: string | null, now: Date) {
  if (!versionId) return;
  for (const k of CLOSING_KINDS) {
    await tx.query(
      `INSERT INTO document_generation (application_id, kind, version_id, status, updated_at) VALUES ($1,$2,$3,'PENDING',$4)
       ON CONFLICT (application_id, kind, version_id) DO NOTHING`,
      [appId, k, versionId, now],
    );
  }
}

/** Generate whatever is still outstanding for one application (after the approving transaction commits). */
export async function generateClosingDocuments(appId: string, now = new Date()): Promise<number> {
  const rows = (
    await db.query<{ kind: ClosingKind }>(
      `SELECT g.kind FROM document_generation g JOIN applications a ON a.id = g.application_id AND a.current_version_id = g.version_id
        WHERE g.application_id = $1 AND g.status IN ('PENDING','FAILED','WAITING') AND g.attempts < $2 AND a.stage = ANY($3)`,
      [appId, MAX_ATTEMPTS, CLOSING_STAGES],
    )
  ).rows;
  let done = 0;
  for (const r of rows) {
    try {
      if (await withTx((tx) => generateOne(tx, appId, r.kind, now))) done++;
    } catch (e) {
      console.error("[closing-docs]", appId, r.kind, e);
    }
  }
  return done;
}

/** Worker: retry anything pending, waiting or failed. */
export async function runDocumentGeneration(now = new Date()): Promise<number> {
  const apps = (
    await db.query<{ application_id: string }>(
      `SELECT DISTINCT g.application_id FROM document_generation g JOIN applications a ON a.id = g.application_id AND a.current_version_id = g.version_id
        WHERE g.status IN ('PENDING','FAILED','WAITING') AND g.attempts < $1 AND a.stage = ANY($2) LIMIT 25`,
      [MAX_ATTEMPTS, CLOSING_STAGES],
    )
  ).rows;
  let n = 0;
  for (const a of apps) n += await generateClosingDocuments(a.application_id, now);
  return n;
}

async function generateOne(tx: Tx, appId: string, kind: ClosingKind, now: Date): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = (await tx.query<Record<string, any>>("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
  if (!app || !CLOSING_STAGES.includes(app.stage)) return false;
  const row = (
    await tx.query("SELECT * FROM document_generation WHERE application_id = $1 AND kind = $2 AND version_id = $3 FOR UPDATE SKIP LOCKED", [appId, kind, app.current_version_id])
  ).rows[0];
  if (!row || row.status === "GENERATED") return false;
  const ctx = systemCtx(now);
  await tx.query("SAVEPOINT closing_doc");
  try {
    const documentId = await produce(tx, ctx, app, kind);
    await tx.query("RELEASE SAVEPOINT closing_doc");
    await tx.query(
      "UPDATE document_generation SET status = 'GENERATED', document_id = $4, detail = NULL, attempts = attempts + 1, updated_at = $5 WHERE application_id = $1 AND kind = $2 AND version_id = $3",
      [appId, kind, app.current_version_id, documentId, now],
    );
    await audit(tx, ctx, { action: "CLOSING_DOCUMENT_GENERATED", applicationId: appId, stage: app.stage, documentId, details: { kind } });
    await notify(tx, now, {
      recipientId: app.initiator_id,
      kind: "CLOSING_DOCUMENT_READY",
      title: `${CLOSING_LABELS[kind]} ready — ${app.ref}`,
      body: `ARAF has prepared the ${CLOSING_LABELS[kind].toLowerCase()} for ${app.customer_name ?? app.ref}. Download it, have the customer sign it and upload the signed copy.`,
      applicationId: appId,
      link: `/requests/${appId}#closing-documents`,
      dedupeKey: `closing-ready:${appId}:${kind}:${app.current_version_id}`,
    });
    return true;
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT closing_doc");
    if (e instanceof Waiting) {
      await tx.query(
        "UPDATE document_generation SET status = 'WAITING', detail = $4, updated_at = $5 WHERE application_id = $1 AND kind = $2 AND version_id = $3",
        [appId, kind, app.current_version_id, `${e.reason}: ${e.message}`, now],
      );
      if (e.reason === "TEMPLATE" || e.reason === "CORPORATE_GSI") await alertAdmins(tx, ctx, app, kind, e.message, row);
      return false;
    }
    const msg = e instanceof Error ? e.message : String(e);
    const r = await tx.query<{ attempts: number }>(
      "UPDATE document_generation SET status = 'FAILED', detail = $4, attempts = attempts + 1, updated_at = $5 WHERE application_id = $1 AND kind = $2 AND version_id = $3 RETURNING attempts",
      [appId, kind, app.current_version_id, msg.slice(0, 500), now],
    );
    if (r.rows[0].attempts >= 3) await alertAdmins(tx, ctx, app, kind, `Generation failed ${r.rows[0].attempts} times: ${msg}`, row);
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function alertAdmins(tx: Tx, ctx: Ctx, app: Record<string, any>, kind: ClosingKind, message: string, row: { admin_alerted_at: Date | null }) {
  if (row.admin_alerted_at) return;
  const admins = (
    await tx.query<{ id: string; email: string }>(
      `SELECT s.id, s.email FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND ra.role = 'SUPER_ADMIN' AND s.status = 'ACTIVE'`,
    )
  ).rows;
  const title = `${CLOSING_LABELS[kind]} could not be prepared — ${app.ref}`;
  const body = `${message} The initiator sees the document as being prepared. Configure it (Administration → Offer templates / Document settings) and ARAF will prepare it automatically.`;
  for (const a of admins) {
    await notify(tx, ctx.now, { recipientId: a.id, kind: "CLOSING_DOCUMENT_ALERT", title, body, applicationId: app.id, link: `/requests/${app.id}`, dedupeKey: `closing-alert:${app.id}:${kind}:${app.current_version_id}` });
  }
  if (admins.length) {
    await enqueueEmail(tx, ctx.now, {
      kind: "CLOSING_DOCUMENT_ALERT",
      dedupeKey: `closing-alert:${app.id}:${kind}:${app.current_version_id}`,
      applicationId: app.id,
      to: admins.map((a) => a.email),
      subject: `ARAF — ${title}`,
      text: `${body}\n\nReference: ${app.ref}\nProduct: ${app.product_label ?? app.product_code ?? ""}\n`,
    });
  }
  await tx.query("UPDATE document_generation SET admin_alerted_at = $4 WHERE application_id = $1 AND kind = $2 AND version_id = $3", [app.id, kind, app.current_version_id, ctx.now]);
  await audit(tx, ctx, { action: "CLOSING_DOCUMENT_ADMIN_ALERTED", applicationId: app.id, details: { kind, message } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function produce(tx: Tx, ctx: Ctx, app: Record<string, any>, kind: ClosingKind): Promise<string> {
  if (kind === "OFFER") return produceOffer(tx, ctx, app);
  const s = await closingSource(tx, app);
  if (kind === "GSI") {
    if (s.applicantType === "LIMITED") throw new Waiting("CORPORATE_GSI", "The corporate GSI mandate form has not been added to ARAF yet; this limited company needs the corporate form.");
    if (!s.account) throw new Waiting("REPAYMENT_ACCOUNT", "Add the customer's repayment account to prepare the GSI form.");
    const pdf = await buildGsiPdf(gsiValues(s));
    return store(tx, ctx, app, "GENERATED_GSI", `GSI-Mandate-${app.ref}.pdf`, pdf);
  }
  if (!s.account) throw new Waiting("REPAYMENT_ACCOUNT", "Add the customer's repayment account to prepare the Remita set-up sheet.");
  const settings = (await tx.query("SELECT * FROM document_settings WHERE id = 1")).rows[0];
  const pdf = await buildRemitaSetupPdf(remitaValues(s, settings, ctx.now));
  return store(tx, ctx, app, "GENERATED_REMITA", `Remita-Setup-${app.ref}.pdf`, pdf);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function store(tx: Tx, ctx: Ctx, app: Record<string, any>, category: string, filename: string, data: Buffer) {
  const r = await storeGeneratedDocument(tx, ctx, { appId: app.id, category, filename, mime: "application/pdf", data, templateId: null, templateVersion: null, role: "SYSTEM", stage: app.stage, versionId: app.current_version_id });
  return r.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function produceOffer(tx: Tx, ctx: Ctx, app: Record<string, any>): Promise<string> {
  // An offer the initiator already generated for this approved version counts.
  const existing = (
    await tx.query<{ id: string }>(
      "SELECT id FROM documents WHERE application_id = $1 AND category = 'GENERATED_OFFER' AND app_version_id = $2 AND superseded_at IS NULL ORDER BY uploaded_at DESC LIMIT 1",
      [app.id, app.current_version_id],
    )
  ).rows[0];
  if (existing) return existing.id;
  if (app.workflow === "RETAIL") {
    const tpl = await retailTemplate(tx, app.product_code, app.financing_structure);
    if (!tpl || !tpl.production_approved) {
      throw new Waiting("TEMPLATE", `No bank-approved offer template is active for ${app.product_label ?? app.product_code}${app.financing_structure ? ` (${app.financing_structure})` : ""}.`);
    }
    if (!(await approvedRetailAssessment(tx, app.id))) throw new Waiting("ASSESSMENT", "No approved final assessment is on record yet.");
    return (await renderRetailOffer(tx, ctx, app, app.initiator_role)).documentId;
  }
  const tpl = await activeTemplate(tx, app.applicant_type);
  if (!tpl || (config.isProduction && !tpl.production_approved)) throw new Waiting("TEMPLATE", `No bank-approved WakeelBoost offer template is active for ${String(app.applicant_type).toLowerCase()} applicants.`);
  if (!(await approvedAssessment(tx, app.id))) throw new Waiting("ASSESSMENT", "No approved credit assessment is on record yet.");
  return (await renderWakeelOffer(tx, ctx, app, app.initiator_role)).documentId;
}

// ─────────────────────────── values ───────────────────────────

interface ClosingSource {
  ref: string;
  product: string;
  applicantType: string;
  customerName: string;
  personName: string;
  phone: string;
  email: string;
  address: string;
  bvn: string;
  account: RepaymentAccount | null;
  instalmentKobo: number | null;
  frequency: string;
  firstDue: string | null;
  lastDue: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function closingSource(q: Db, app: Record<string, any>): Promise<ClosingSource> {
  const v = (await q.query("SELECT data, bvn_enc FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
  const d = (v?.data ?? {}) as Record<string, unknown>;
  const str = (k: string) => String(d[k] ?? "").trim();
  let bvn = "";
  try {
    bvn = v?.bvn_enc ? decryptField(v.bvn_enc) : "";
  } catch {
    bvn = "";
  }
  let instalmentKobo: number | null = null;
  let frequency = "Month";
  let firstDue: string | null = null;
  let lastDue: string | null = null;
  if (app.workflow === "RETAIL") {
    const a = await approvedRetailAssessment(q, app.id);
    const sched = ((a?.outputs as { schedule?: { dueDate: string | null; amountKobo: number }[] })?.schedule ?? []) as { dueDate: string | null; amountKobo: number }[];
    if (sched.length) {
      instalmentKobo = sched[0].amountKobo;
      firstDue = sched[0].dueDate;
      lastDue = sched.at(-1)!.dueDate;
    }
  } else {
    const a = await approvedAssessment(q, app.id);
    const out = (a?.outputs ?? {}) as Record<string, unknown>;
    const inp = (a?.inputs ?? {}) as Record<string, unknown>;
    const f = String(out.frequency ?? inp.frequency ?? "Monthly");
    frequency = f === "Quarterly" ? "Quarter" : f === "Bullet" ? "Once" : "Month";
    if (out.periodicInstalmentKobo !== undefined) instalmentKobo = Number(out.periodicInstalmentKobo);
    else if (a) instalmentKobo = Math.ceil(Number(a.cost_plus_markup_kobo) / Math.max(1, Number(inp.tenorMonths ?? d.tenorMonths ?? 1)));
  }
  return {
    ref: app.ref,
    product: app.product_label ?? (app.workflow === "RETAIL" ? app.product_code : "WakeelBoost"),
    applicantType: app.applicant_type ?? "INDIVIDUAL",
    customerName: app.customer_name ?? str("customerName"),
    personName: str("customerName") || app.customer_name || "",
    phone: str("phone"),
    email: str("email"),
    address: str("address") || str("businessAddress") || str("deliveryAddress"),
    bvn,
    account: (app.repayment_account as RepaymentAccount | null) ?? null,
    instalmentKobo,
    frequency,
    firstDue,
    lastDue,
  };
}

/** "First Middle Surname" → parts (the customer corrects the printed form if their name order differs). */
export function splitName(full: string): { surname: string; firstName: string; middleName: string } {
  const t = full.trim().split(/\s+/).filter(Boolean);
  if (t.length === 0) return { surname: "", firstName: "", middleName: "" };
  if (t.length === 1) return { surname: t[0], firstName: "", middleName: "" };
  return { firstName: t[0], surname: t[t.length - 1], middleName: t.slice(1, -1).join(" ") };
}

export function gsiValues(s: ClosingSource): GsiValues {
  const n = splitName(s.personName);
  return {
    ...n,
    mobile: s.phone,
    email: s.email,
    address: s.address,
    bankName: s.account?.bankName ?? "",
    branch: s.account?.branch ?? "",
    accountName: s.account?.accountName ?? "",
    townCity: s.account?.townCity ?? "",
    accountNumber: s.account?.accountNumber ?? "",
    bvn: s.bvn,
    signatoryName: s.personName,
    reference: s.ref,
  };
}

const ngn = (k: number | null) => (k === null ? "" : `NGN ${formatKobo(k, false)}`);
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function remitaValues(s: ClosingSource, settings: Record<string, any>, now: Date): RemitaValues {
  const charge = settings?.remita_charge_kobo === null || settings?.remita_charge_kobo === undefined ? null : Number(settings.remita_charge_kobo);
  const vat = charge === null || settings.remita_vat_percent === null ? null : Math.round((charge * Number(settings.remita_vat_percent)) / 100);
  const total = s.instalmentKobo === null ? null : s.instalmentKobo + (charge ?? 0) + (vat ?? 0);
  return {
    reference: s.ref,
    generatedOn: ddmmyyyy(lagosDate(now)),
    beneficiary: {
      name: settings?.remita_beneficiary_name || settings?.bank_name || "The Alternative Bank",
      phone: settings?.remita_beneficiary_phone ?? "",
      email: settings?.remita_beneficiary_email ?? "",
      bank: String(settings?.remita_beneficiary_bank ?? "").toUpperCase(),
      account: settings?.remita_beneficiary_account ?? "",
    },
    description: `${s.product} ${s.ref}`,
    amount: ngn(s.instalmentKobo),
    charges: ngn(charge),
    vatOnCharges: ngn(vat),
    totalPayable: ngn(total),
    every: s.frequency,
    startDate: s.firstDue ?? "",
    endDate: s.lastDue ?? "",
    payer: {
      name: s.customerName.toUpperCase(),
      phone: s.phone,
      email: s.email,
      bank: (s.account?.bankName ?? "").toUpperCase(),
      account: s.account?.accountNumber ?? "",
    },
  };
}

// ─────────────────────────── repayment account + status ───────────────────────────

/** The initiator records the customer's repayment account; GSI and Remita are then (re)prepared. */
export async function saveRepaymentAccount(ctx: Ctx, appId: string, a: RepaymentAccount) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const clean: RepaymentAccount = {
    bankName: a.bankName.trim().slice(0, 120),
    accountNumber: a.accountNumber.trim(),
    accountName: a.accountName.trim().slice(0, 160),
    branch: a.branch.trim().slice(0, 120),
    townCity: a.townCity.trim().slice(0, 120),
  };
  const fields: Record<string, string> = {};
  if (!clean.bankName) fields.bankName = "Enter the customer's bank.";
  if (!/^\d{10}$/.test(clean.accountNumber)) fields.accountNumber = "Enter the 10-digit account number.";
  if (clean.accountName.length < 3) fields.accountName = "Enter the account name.";
  if (Object.keys(fields).length) throw invalid("Check the repayment account details.", fields);
  await withTx(async (tx) => {
    const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    if (!app) throw forbidden();
    const isInitiator = app.initiator_id === actor.staffId;
    if (!isInitiator && !(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the initiator can record the repayment account.");
    if (["COMPLETED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(app.stage)) throw invalid("This request is closed.");
    const before = app.repayment_account;
    await tx.query("UPDATE applications SET repayment_account = $2, updated_at = $3 WHERE id = $1", [appId, JSON.stringify(clean), ctx.now]);
    // Re-prepare GSI and Remita for the current approved version (new document versions; earlier ones are kept).
    await tx.query(
      `UPDATE document_generation SET status = 'PENDING', attempts = 0, detail = NULL, updated_at = $2
        WHERE application_id = $1 AND kind IN ('GSI','REMITA_SETUP') AND version_id = $3`,
      [appId, ctx.now, app.current_version_id],
    );
    await audit(tx, ctx, {
      action: "REPAYMENT_ACCOUNT_RECORDED",
      applicationId: appId,
      stage: app.stage,
      details: { bank: clean.bankName, accountLast4: clean.accountNumber.slice(-4), changed: !!before },
    });
  });
  await generateClosingDocuments(appId, ctx.now);
}

export interface ClosingStatus {
  kind: ClosingKind;
  label: string;
  state: "READY" | "PREPARING" | "NEEDS_ACCOUNT" | "MANUAL";
  note: string | null;
  documentId: string | null;
}

/** What the case page shows (never "template missing"). */
export async function closingStatus(q: Db, appId: string): Promise<{ items: ClosingStatus[]; account: RepaymentAccount | null } | null> {
  const app = (await q.query("SELECT id, current_version_id, repayment_account FROM applications WHERE id = $1", [appId])).rows[0];
  if (!app) return null;
  const rows = (await q.query("SELECT * FROM document_generation WHERE application_id = $1 AND version_id = $2", [appId, app.current_version_id])).rows;
  if (!rows.length) return null;
  const items = CLOSING_KINDS.map((k): ClosingStatus => {
    const r = rows.find((x: { kind: string }) => x.kind === k);
    const detail = String(r?.detail ?? "");
    if (r?.status === "GENERATED") return { kind: k, label: CLOSING_LABELS[k], state: "READY", note: null, documentId: r.document_id };
    if (detail.startsWith("REPAYMENT_ACCOUNT")) return { kind: k, label: CLOSING_LABELS[k], state: "NEEDS_ACCOUNT", note: "Add the customer's repayment account below.", documentId: null };
    if (detail.startsWith("CORPORATE_GSI")) return { kind: k, label: CLOSING_LABELS[k], state: "MANUAL", note: "Use the bank's corporate GSI mandate form for this company and upload the signed copy.", documentId: null };
    return { kind: k, label: CLOSING_LABELS[k], state: "PREPARING", note: "ARAF is preparing this document.", documentId: null };
  });
  return { items, account: app.repayment_account ?? null };
}
