/**
 * Financial institution directory and the approved vendor (beneficiary) register.
 *
 * - The institution directory is loaded from an authoritative source (CBN list + the approved payment
 *   provider's routing codes) by an administrator; nothing in code claims regulatory status.
 * - Vendor accounts have active/inactive and verification status. Selecting a bank never approves an
 *   account: an account is usable only when VERIFIED and ACTIVE. Verification is by name enquiry when an
 *   approved integration exists; otherwise by a different officer with manual evidence (maker-checker).
 * - Every change is audited; applications store a beneficiary snapshot at submission.
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import { EMAIL_RE, NUBAN_RE, phoneError } from "./retail-data";

export const INSTITUTION_CATEGORIES = ["COMMERCIAL", "MERCHANT", "NON_INTEREST", "MICROFINANCE", "OTHER"] as const;

export interface InstitutionRow {
  id: string;
  code: string;
  name: string;
  aliases: string[];
  category: string;
  regulatory_status: "CONFIRMED_ACTIVE" | "UNCONFIRMED" | "REVOKED";
  routing_codes: Record<string, string>;
  payment_supported: boolean;
  active: boolean;
  source: string;
  source_reference: string | null;
}

export interface BeneficiarySnapshot {
  vendorId: string;
  vendorName: string;
  vendorEmail: string | null;
  accountId: string;
  institutionId: string;
  institutionCode: string;
  institutionName: string;
  routingCodes: Record<string, string>;
  paymentSupported: boolean;
  accountNumber: string;
  accountName: string;
  verificationStatus: string;
  verificationMethod: string | null;
  verifiedAt: string | null;
  capturedAt: string;
}

/** Name-enquiry integration. None is approved in this build: verification is manual with evidence. */
export interface NameEnquiryProvider {
  name: string;
  resolve(institutionRoutingCodes: Record<string, string>, accountNumber: string): Promise<{ status: "SUCCESS" | "FAILED"; accountName?: string; detail?: string }>;
}
export function nameEnquiryProvider(): NameEnquiryProvider | null {
  return null;
}

async function requireRole(tx: Db, staffId: string, roles: string[]) {
  for (const r of roles) if (await holdsRole(tx, staffId, r)) return r;
  throw forbidden(`This action needs one of: ${roles.join(", ")}.`);
}

// ------------------------------------------------------------------ institutions

export async function searchInstitutions(q: Db, term: string, opts: { includeInactive?: boolean } = {}) {
  const t = `%${term.trim().toLowerCase()}%`;
  return (
    await q.query<InstitutionRow>(
      `SELECT * FROM financial_institutions
        WHERE ($2 OR active) AND ($1 = '%%' OR lower(name) LIKE $1 OR lower(code) LIKE $1 OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) LIKE $1))
        ORDER BY category = 'MICROFINANCE', name LIMIT 500`,
      [t, !!opts.includeInactive],
    )
  ).rows;
}

export interface InstitutionInput {
  code: string;
  name: string;
  aliases?: string[];
  category: string;
  regulatoryStatus: string;
  routingCodes?: Record<string, string>;
  paymentSupported: boolean;
  active: boolean;
  sourceReference?: string | null;
}

function validateInstitution(i: InstitutionInput): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^[A-Za-z0-9-]{2,20}$/.test(i.code ?? "")) e.code = "Institution code: 2–20 letters, digits or dashes.";
  if ((i.name ?? "").trim().length < 2) e.name = "Institution name is required.";
  if (!(INSTITUTION_CATEGORIES as readonly string[]).includes(i.category)) e.category = "Choose a category.";
  if (!["CONFIRMED_ACTIVE", "UNCONFIRMED", "REVOKED"].includes(i.regulatoryStatus)) e.regulatoryStatus = "Choose the regulatory status.";
  for (const [k, v] of Object.entries(i.routingCodes ?? {})) if (!/^[A-Z0-9_]{2,20}$/.test(k) || !/^[0-9A-Za-z]{2,20}$/.test(v)) e.routingCodes = "Routing codes must be PROVIDER=CODE pairs.";
  return e;
}

/** Upsert institutions (single edit or bulk import). Super Admin only; audited. */
export async function upsertInstitutions(ctx: Ctx, rows: InstitutionInput[], source: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    await requireRole(tx, actor.staffId, ["SUPER_ADMIN"]);
    const errors: Record<string, string> = {};
    rows.forEach((r, idx) => {
      const e = validateInstitution(r);
      for (const [k, v] of Object.entries(e)) errors[`${idx + 1}.${k}`] = `Row ${idx + 1}: ${v}`;
    });
    if (Object.keys(errors).length) throw invalid("Some institution rows are not valid. Nothing was saved.", errors);
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      const res = await tx.query<{ inserted: boolean }>(
        `INSERT INTO financial_institutions (code, name, aliases, category, regulatory_status, routing_codes, payment_supported, active, source, source_reference, verified_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11)
         ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, aliases=EXCLUDED.aliases, category=EXCLUDED.category, regulatory_status=EXCLUDED.regulatory_status,
           routing_codes=EXCLUDED.routing_codes, payment_supported=EXCLUDED.payment_supported, active=EXCLUDED.active, source=EXCLUDED.source,
           source_reference=EXCLUDED.source_reference, verified_at=EXCLUDED.verified_at, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
         RETURNING (xmax = 0) AS inserted`,
        [r.code.trim(), r.name.trim(), (r.aliases ?? []).map((a) => a.trim()).filter(Boolean), r.category, r.regulatoryStatus, JSON.stringify(r.routingCodes ?? {}), r.paymentSupported, r.active, source, r.sourceReference ?? null, ctx.now, actor.staffId],
      );
      if (res.rows[0].inserted) inserted++;
      else updated++;
    }
    await audit(tx, ctx, { action: "INSTITUTIONS_UPSERTED", actorRole: "SUPER_ADMIN", details: { source, inserted, updated, codes: rows.map((r) => r.code).slice(0, 200) } });
    return { inserted, updated };
  });
}

/** Parse an institution CSV: code,name,category,regulatory_status,payment_supported,active,aliases(;),routing(NIP=000014;...) */
export function parseInstitutionCsv(text: string): InstitutionInput[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') {
        if (q && l[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const head = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const col = (row: string[], names: string[]) => {
    const i = head.findIndex((h) => names.includes(h));
    return i >= 0 ? (row[i] ?? "") : "";
  };
  const yes = (v: string) => ["y", "yes", "true", "1"].includes(v.toLowerCase());
  return lines.slice(1).map((l) => {
    const row = split(l);
    const routing = Object.fromEntries(
      col(row, ["routing_codes", "routing"])
        .split(";")
        .map((p) => p.split("=").map((x) => x.trim()))
        .filter((p) => p.length === 2 && p[0] && p[1]),
    );
    return {
      code: col(row, ["code", "institution_code", "cbn_code"]),
      name: col(row, ["name", "institution_name"]),
      category: col(row, ["category", "type"]).toUpperCase() || "OTHER",
      regulatoryStatus: col(row, ["regulatory_status", "status"]).toUpperCase() || "UNCONFIRMED",
      paymentSupported: yes(col(row, ["payment_supported", "nip_supported"])),
      active: col(row, ["active"]) === "" ? true : yes(col(row, ["active"])),
      aliases: col(row, ["aliases", "alias"]).split(";").map((a) => a.trim()).filter(Boolean),
      routingCodes: routing,
      sourceReference: col(row, ["source_reference", "source"]) || null,
    };
  });
}

// ------------------------------------------------------------------ vendors + accounts

export interface VendorInput {
  name: string;
  email: string;
  phone?: string;
  registrationNumber?: string;
  address?: string;
}

function validateVendor(v: VendorInput): Record<string, string> {
  const e: Record<string, string> = {};
  if ((v.name ?? "").trim().length < 2) e.vendorName = "Vendor name is required.";
  if (!EMAIL_RE.test((v.email ?? "").trim())) e.vendorEmail = "Enter the vendor's email address.";
  const pe = phoneError((v.phone ?? "").trim(), "Vendor phone");
  if (pe) e.vendorPhone = pe;
  return e;
}

export async function createVendor(tx: Tx, ctx: Ctx, v: VendorInput, viaApplication: string | null = null) {
  const e = validateVendor(v);
  if (Object.keys(e).length) throw invalid("Check the vendor details.", e);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO vendors (name, email, phone, registration_number, address, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
    [v.name.trim(), v.email.trim().toLowerCase(), (v.phone ?? "").trim() || null, (v.registrationNumber ?? "").trim() || null, (v.address ?? "").trim() || null, ctx.actor!.staffId, ctx.now],
  );
  await audit(tx, ctx, { action: "VENDOR_CREATED", applicationId: viaApplication, details: { vendorId: r.rows[0].id, name: v.name.trim(), email: v.email.trim().toLowerCase() } });
  return r.rows[0].id;
}

export interface AccountInput {
  vendorId: string;
  institutionId: string;
  accountNumber: string;
  accountName: string;
}

export async function createVendorAccount(tx: Tx, ctx: Ctx, a: AccountInput, viaApplication: string | null = null) {
  const e: Record<string, string> = {};
  const num = (a.accountNumber ?? "").replace(/\s/g, "");
  if (!NUBAN_RE.test(num)) e.accountNumber = "Account number must be exactly 10 digits.";
  if ((a.accountName ?? "").trim().length < 2) e.accountName = "Enter the account name.";
  const inst = (await tx.query<InstitutionRow>("SELECT * FROM financial_institutions WHERE id = $1", [a.institutionId])).rows[0];
  if (!inst || !inst.active) e.institutionId = "Select an active bank or microfinance bank from the directory.";
  else if (inst.regulatory_status === "REVOKED") e.institutionId = "This institution's licence is recorded as revoked.";
  if (Object.keys(e).length) throw invalid("Check the beneficiary account details.", e);
  const exists = (await tx.query<{ id: string; vendor_id: string }>("SELECT id, vendor_id FROM vendor_accounts WHERE institution_id = $1 AND account_number = $2", [a.institutionId, num])).rows[0];
  if (exists) {
    if (exists.vendor_id !== a.vendorId) throw conflict("This account is already registered to a different vendor.");
    return exists.id;
  }
  const provider = nameEnquiryProvider();
  const r = await tx.query<{ id: string }>(
    `INSERT INTO vendor_accounts (vendor_id, institution_id, account_number, account_name, verification_status, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
    [a.vendorId, a.institutionId, num, a.accountName.trim(), provider ? "PENDING" : "UNAVAILABLE", ctx.actor!.staffId, ctx.now],
  );
  await audit(tx, ctx, { action: "VENDOR_ACCOUNT_CREATED", applicationId: viaApplication, details: { vendorId: a.vendorId, accountId: r.rows[0].id, institution: inst!.code, accountLast4: num.slice(-4), nameEnquiry: provider ? "pending" : "integration unavailable" } });
  return r.rows[0].id;
}

/** Vendor register officer / Super Admin creates a vendor with its first account. */
export async function registerVendor(ctx: Ctx, v: VendorInput & Omit<AccountInput, "vendorId">) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    await requireRole(tx, actor.staffId, ["VENDOR_MANAGER", "SUPER_ADMIN"]);
    const vendorId = await createVendor(tx, ctx, v);
    const accountId = await createVendorAccount(tx, ctx, { vendorId, institutionId: v.institutionId, accountNumber: v.accountNumber, accountName: v.accountName });
    return { vendorId, accountId };
  });
}

/** An initiator proposes a new vendor beneficiary from the application form. It stays unusable until verified. */
export async function proposeBeneficiary(ctx: Ctx, appId: string, v: VendorInput & Omit<AccountInput, "vendorId"> & { vendorId?: string | null }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    if (!app) throw notFound();
    if (app.initiator_id !== actor.staffId || !["DRAFT", "INITIATOR_CORRECTION"].includes(app.stage)) throw forbidden("Only the initiator can propose a vendor account while the request is a draft or under correction.");
    let vendorId = v.vendorId ?? null;
    if (vendorId) {
      const ven = (await tx.query("SELECT * FROM vendors WHERE id = $1", [vendorId])).rows[0];
      if (!ven || ven.status !== "ACTIVE") throw invalid("Select an active vendor.", { vendorId: "Vendor not active." });
    } else vendorId = await createVendor(tx, ctx, v, appId);
    const accountId = await createVendorAccount(tx, ctx, { vendorId, institutionId: v.institutionId, accountNumber: v.accountNumber, accountName: v.accountName }, appId);
    return { vendorId, accountId };
  });
}

/**
 * Verify (or fail) a vendor account. The verifier must hold VENDOR_MANAGER and must not be the person
 * who captured the account. Manual verification records the method and a note (evidence reference).
 */
export async function verifyVendorAccount(ctx: Ctx, accountId: string, p: { outcome: "VERIFIED" | "FAILED"; note: string; resolvedAccountName?: string | null }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    await requireRole(tx, actor.staffId, ["VENDOR_MANAGER"]);
    const acc = (await tx.query("SELECT * FROM vendor_accounts WHERE id = $1 FOR UPDATE", [accountId])).rows[0];
    if (!acc) throw notFound();
    if (acc.created_by === actor.staffId) throw forbidden("The person who captured an account cannot verify it.");
    if ((p.note ?? "").trim().length < 5) throw invalid("Record how the account was verified (evidence reference).", { note: "Verification note required." });
    await tx.query(
      `UPDATE vendor_accounts SET verification_status = $2, verification_method = 'MANUAL_EVIDENCE', verification_note = $3, resolved_account_name = $4, verified_by = $5, verified_at = $6, updated_at = $6 WHERE id = $1`,
      [accountId, p.outcome, p.note.trim(), (p.resolvedAccountName ?? "").trim() || null, actor.staffId, ctx.now],
    );
    if (p.outcome === "VERIFIED") {
      await tx.query("UPDATE vendors SET verification_status = 'VERIFIED', verified_by = COALESCE(verified_by, $2), verified_at = COALESCE(verified_at, $3), updated_at = $3 WHERE id = $1", [acc.vendor_id, actor.staffId, ctx.now]);
    }
    await audit(tx, ctx, { action: p.outcome === "VERIFIED" ? "VENDOR_ACCOUNT_VERIFIED" : "VENDOR_ACCOUNT_VERIFICATION_FAILED", actorRole: "VENDOR_MANAGER", reason: p.note.trim(), details: { accountId, vendorId: acc.vendor_id, method: "MANUAL_EVIDENCE", accountLast4: String(acc.account_number).slice(-4) } });
  });
}

export async function setVendorAccountStatus(ctx: Ctx, accountId: string, status: "ACTIVE" | "INACTIVE", reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    await requireRole(tx, actor.staffId, ["VENDOR_MANAGER", "SUPER_ADMIN"]);
    if ((reason ?? "").trim().length < 3) throw invalid("Give a reason.", { reason: "Reason required." });
    const r = await tx.query("UPDATE vendor_accounts SET status = $2, updated_at = $3 WHERE id = $1 RETURNING vendor_id", [accountId, status, ctx.now]);
    if (!r.rowCount) throw notFound();
    await audit(tx, ctx, { action: status === "ACTIVE" ? "VENDOR_ACCOUNT_ACTIVATED" : "VENDOR_ACCOUNT_DEACTIVATED", reason, details: { accountId, vendorId: r.rows[0].vendor_id } });
  });
}

export async function setVendorStatus(ctx: Ctx, vendorId: string, status: "ACTIVE" | "INACTIVE", reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    await requireRole(tx, actor.staffId, ["VENDOR_MANAGER", "SUPER_ADMIN"]);
    if ((reason ?? "").trim().length < 3) throw invalid("Give a reason.", { reason: "Reason required." });
    const r = await tx.query("UPDATE vendors SET status = $2, updated_at = $3 WHERE id = $1", [vendorId, status, ctx.now]);
    if (!r.rowCount) throw notFound();
    await audit(tx, ctx, { action: status === "ACTIVE" ? "VENDOR_ACTIVATED" : "VENDOR_DEACTIVATED", reason, details: { vendorId } });
  });
}

/** Vendors with their accounts for the application dropdowns (active vendors only). */
export async function vendorOptions(q: Db) {
  return (
    await q.query<{ vendor_id: string; vendor_name: string; vendor_email: string | null; account_id: string | null; account_number: string | null; account_name: string | null; institution_name: string | null; institution_code: string | null; verification_status: string | null; account_status: string | null; payment_supported: boolean | null }>(
      `SELECT v.id AS vendor_id, v.name AS vendor_name, v.email AS vendor_email, va.id AS account_id, va.account_number, va.account_name,
              fi.name AS institution_name, fi.code AS institution_code, va.verification_status, va.status AS account_status, fi.payment_supported
         FROM vendors v LEFT JOIN vendor_accounts va ON va.vendor_id = v.id LEFT JOIN financial_institutions fi ON fi.id = va.institution_id
        WHERE v.status = 'ACTIVE' ORDER BY v.name, fi.name`,
    )
  ).rows;
}

/** Current beneficiary for an account (no status filtering). */
export async function beneficiaryFor(q: Db, accountId: string, now: Date): Promise<BeneficiarySnapshot | null> {
  const r = (
    await q.query(
      `SELECT v.id AS vendor_id, v.name AS vendor_name, v.email AS vendor_email, v.status AS vendor_status, va.*, fi.code AS fi_code, fi.name AS fi_name,
              fi.routing_codes, fi.payment_supported, fi.active AS fi_active
         FROM vendor_accounts va JOIN vendors v ON v.id = va.vendor_id JOIN financial_institutions fi ON fi.id = va.institution_id WHERE va.id = $1`,
      [accountId],
    )
  ).rows[0];
  if (!r) return null;
  return {
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    vendorEmail: r.vendor_email,
    accountId: r.id,
    institutionId: r.institution_id,
    institutionCode: r.fi_code,
    institutionName: r.fi_name,
    routingCodes: r.routing_codes ?? {},
    paymentSupported: r.payment_supported,
    accountNumber: r.account_number,
    accountName: r.account_name,
    verificationStatus: r.status === "ACTIVE" && r.vendor_status === "ACTIVE" && r.fi_active ? r.verification_status : `${r.verification_status}/INACTIVE`,
    verificationMethod: r.verification_method,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    capturedAt: now.toISOString(),
  };
}

/** Problems that stop an account from being used for payment. Empty = usable. */
export function beneficiaryProblems(b: BeneficiarySnapshot | null, expectedVendorId?: string | null): string[] {
  if (!b) return ["Select the vendor's approved bank account."];
  const out: string[] = [];
  if (expectedVendorId && b.vendorId !== expectedVendorId) out.push("The selected account does not belong to the selected vendor.");
  if (b.verificationStatus.endsWith("/INACTIVE")) out.push("The vendor, account or bank is inactive.");
  else if (b.verificationStatus !== "VERIFIED") out.push(`The vendor account is not verified (status: ${b.verificationStatus.toLowerCase()}). A vendor register officer must verify it before submission.`);
  if (!b.paymentSupported) out.push(`${b.institutionName} is not marked as supported by the payment provider; payment must be arranged outside the integrated route.`);
  return out;
}
