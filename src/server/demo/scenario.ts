/**
 * Scenario driver used by the automated tests and `npm run demo:routes`.
 * Drives synthetic cases through the real domain functions (no shortcuts around the rules).
 */
import { randomUUID } from "node:crypto";
import { db } from "../db";
import type { Ctx } from "../context";
import { createDraft, saveDraft, submitApplication, performTaskAction, type TaskActionInput } from "../domain/workflow";
import { uploadDocument } from "../domain/documents";
import { recordAssessment } from "../domain/assessment";
import { generateOffer } from "../domain/offer";
import type { ApplicantType } from "../domain/application-data";
import { addDaysToDateString, lagosDate } from "../time";
import type { Stage } from "../domain/stages";

export function makePdf(text: string): Buffer {
  const content = `BT /F1 14 Tf 50 750 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export async function ctxFor(email: string, now = new Date(), extra: Partial<Ctx> = {}): Promise<Ctx> {
  const s = (await db.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE email = $1", [email])).rows[0];
  if (!s) throw new Error(`No staff ${email}`);
  return {
    actor: { staffId: s.id, email, name: s.full_name, sessionId: null, activeRole: null },
    now,
    correlationId: `test-${randomUUID()}`,
    ip: "10.0.0.1",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    ...extra,
  };
}

export function sampleData(type: ApplicantType, amountKobo: number, now = new Date()) {
  const today = lagosDate(now);
  return {
    customerName: type === "LIMITED" ? "" : "Halima Yusuf",
    businessName: type === "ENTERPRISE" ? "Halima Provisions" : "",
    companyName: type === "LIMITED" ? "Kano Fresh Foods Ltd" : "",
    registrationNumber: type === "INDIVIDUAL" ? "" : type === "LIMITED" ? "RC1234567" : "BN7654321",
    phone: "08030000000",
    email: "customer@example.com",
    address: "12 Market Road, Kano",
    requestedAmountKobo: amountKobo,
    daoCode: "DAO-1001",
    posSerial: "WKL-POS-778899",
    tenorMonths: 6,
    items: [
      { description: "Bags of rice (50kg)", quantity: 10, unitCostKobo: Math.floor(amountKobo / 20) },
      { description: "Cartons of noodles", quantity: 10, unitCostKobo: Math.floor(amountKobo / 20) },
    ],
    supplierName: "Synthetic Distributors Ltd",
    supplierAddress: "4 Wholesale Way, Lagos",
    supplierPhone: "08031111111",
    supplierAccount: "0000000000",
    invoiceRef: "INV-2026-0001",
    rentStart: addDaysToDateString(today, -100),
    rentEnd: addDaysToDateString(today, 265),
    statementsCover12Months: true,
  };
}

export const INITIATOR_EMAIL: Record<string, string> = {
  RM: "rm.ade@altbank.ng",
  ANM_NORTH: "anm.north@altbank.ng",
  ANM_SOUTH: "anm.south@altbank.ng",
  MERCHANT_OFFICER: "mo.chi@altbank.ng",
};

export async function openTaskOf(appId: string) {
  return (
    await db.query<{ id: string; stage: Stage; assignee_id: string | null; assignee_role: string; email: string | null; assigned_at: Date }>(
      `SELECT t.id, t.stage, t.assignee_id, t.assignee_role, s.email, t.assigned_at FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id
        WHERE t.application_id = $1 AND t.status = 'OPEN'`,
      [appId],
    )
  ).rows[0];
}
export async function appRow(appId: string) {
  return (await db.query("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
}

/** Act on the current open task as its assignee. */
export async function act(appId: string, action: TaskActionInput["action"], extra: Partial<TaskActionInput> = {}, now = new Date()) {
  const t = await openTaskOf(appId);
  if (!t?.email) throw new Error(`No assignee for open task on ${appId} (${t?.stage})`);
  const ctx = await ctxFor(t.email, now);
  return performTaskAction(ctx, { taskId: t.id, action, idempotencyKey: randomUUID(), ...extra });
}

export async function createSubmittedCase(opts: {
  initiator: keyof typeof INITIATOR_EMAIL;
  type?: ApplicantType;
  amountKobo: number;
  rbeEmail?: string;
  now?: Date;
}) {
  const now = opts.now ?? new Date();
  const email = INITIATOR_EMAIL[opts.initiator];
  const role = opts.initiator.startsWith("ANM") ? "ANM" : opts.initiator;
  const ctx = await ctxFor(email, now);
  const type = opts.type ?? "INDIVIDUAL";
  const { id } = await createDraft(ctx, { initiatorRole: role, applicantType: type });
  const rbe = role === "RM" ? (await db.query("SELECT id FROM staff WHERE email = $1", [opts.rbeEmail ?? "rbe.lagos@altbank.ng"])).rows[0].id : null;
  await saveDraft(ctx, id, {
    data: { ...sampleData(type, opts.amountKobo, now), rbeId: rbe },
    bvn: type === "LIMITED" ? null : "22212345678",
    tin: type === "INDIVIDUAL" ? null : "12345678-0001",
    directors: type === "LIMITED" ? [{ fullName: "Director One", bvn: "22200000001" }, { fullName: "Director Two", bvn: "22200000002" }, { fullName: "Director Three", bvn: "22200000003" }] : undefined,
  });
  const cats = ["BANK_STATEMENT", "SUPPLIER_INVOICE", "APPLICATION_FORM", "CONSENT_FORM", "RENT_RECEIPT", ...(type === "INDIVIDUAL" ? [] : ["CAC_CERTIFICATE"])];
  for (const c of cats) await uploadDocument(ctx, { applicationId: id, category: c, filename: `${c.toLowerCase()}.pdf`, data: makePdf(`${c} synthetic`) });
  await submitApplication(ctx, id, randomUUID());
  return id;
}

/** First reviewer: three credit reports + assessment. */
export async function prepareFirstReview(appId: string, now = new Date()) {
  const t = await openTaskOf(appId);
  const ctx = await ctxFor(t.email!, now);
  for (let i = 1; i <= 3; i++) {
    await uploadDocument(ctx, { applicationId: appId, category: "CREDIT_REPORT", filename: `credit-report-${i}.pdf`, data: makePdf(`Credit bureau report ${i}`) });
  }
  const app = await appRow(appId);
  const v = (await db.query("SELECT data FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0].data;
  return recordAssessment(ctx, appId, {
    annualTurnoverKobo: Number(app.requested_amount_kobo) * 24, // monthly turnover = 2× principal → within the 10% threshold
    principalKobo: Number(app.requested_amount_kobo),
    tenorMonths: v.tenorMonths,
    existingObligationsKobo: 0,
    facilityType: "MURABAHA",
    takafulPercent: "0",
    stampDutyPercent: "0.125",
  });
}

/** Bank acceptance case: ₦50m over 6 months, verified monthly turnover ₦77.5m (annual ₦930,238,000). */
export const ACCEPTANCE_INPUTS = {
  annualTurnoverKobo: 93_023_800_000,
  verifiedMonthlyTurnoverKobo: 7_750_000_000,
  monthlyTurnoverOverrideReason: "Statement review verified a monthly turnover of N77,500,000 (rounded basis used by Credit)",
  principalKobo: 5_000_000_000,
  tenorMonths: 6,
  existingObligationsKobo: 0,
  facilityType: "MURABAHA",
  takafulPercent: "0",
  stampDutyPercent: "0.125",
};

export async function recordAcceptanceAssessment(appId: string, now = new Date()) {
  const t = await openTaskOf(appId);
  const ctx = await ctxFor(t.email!, now);
  for (let i = 1; i <= 3; i++) {
    await uploadDocument(ctx, { applicationId: appId, category: "CREDIT_REPORT", filename: `credit-report-${i}.pdf`, data: makePdf(`Credit bureau report ${i}`) });
  }
  return recordAssessment(ctx, appId, ACCEPTANCE_INPUTS);
}

export async function approveFirstReview(appId: string, now = new Date()) {
  await prepareFirstReview(appId, now);
  return act(appId, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true }, now);
}

/** Drive from submitted to offer preparation via the route's approvals. */
export async function driveToOffer(appId: string, now = new Date()) {
  await act(appId, "ENDORSE", {}, now);
  await approveFirstReview(appId, now);
  const app = await appRow(appId);
  await act(appId, app.route === 1 ? "APPROVE" : "PROCEED", {}, now);
  await act(appId, "APPROVE", {}, now); // Unit Head
  await act(appId, "APPROVE", {}, now); // Divisional Head
}

export async function preparePack(appId: string, now = new Date()) {
  const t = await openTaskOf(appId);
  const ctx = await ctxFor(t.email!, now);
  await generateOffer(ctx, appId);
  for (const c of ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"]) {
    await uploadDocument(ctx, { applicationId: appId, category: c, filename: `${c.toLowerCase()}.pdf`, data: makePdf(c) });
  }
}

export async function driveToClosed(appId: string, now = new Date(), txRef = `TRX${Date.now()}${Math.floor(Math.random() * 1000)}`) {
  await preparePack(appId, now);
  await act(appId, "SUBMIT_PACK", {}, now);
  const t = await openTaskOf(appId);
  const co3 = await ctxFor(t.email!, now);
  await uploadDocument(co3, { applicationId: appId, category: "INSURANCE_EVIDENCE", filename: "insurance-evidence.pdf", data: makePdf("Insurance evidence") });
  await act(appId, "FORWARD", {}, now);
  await act(appId, "OKAY", { crmsLogged: true }, now);
  const app = await appRow(appId);
  const today = lagosDate(now);
  await act(appId, "DISBURSED", {
    booking: {
      amountKobo: Number(app.requested_amount_kobo),
      disbursedOn: today,
      transactionRef: txRef,
      schedule: [
        { dueDate: addDaysToDateString(today, 30), amountKobo: Math.ceil(Number(app.requested_amount_kobo) / 2) },
        { dueDate: addDaysToDateString(today, 60), amountKobo: Math.ceil(Number(app.requested_amount_kobo) / 2) },
      ],
    },
  }, now);
  await act(appId, "COMPLETE_PROCESS", {}, now);
  await act(appId, "CONFIRM_VENDOR_PAYMENT", {}, now);
}
