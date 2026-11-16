/**
 * Product Settings (Super Admin): set up, edit and publish product rules directly.
 *
 *  - One working draft per product, saved on the server (revision-checked, so two tabs cannot overwrite each other).
 *  - First set-up needs no earlier version: publishing a draft with no base creates Version 1.
 *  - "Publish Product Rules" inserts a new, immutable APPROVED version (published directly, with a reason and an
 *    effective date), updates the product's general settings in the same transaction, supersedes any open proposal
 *    from the earlier maker-checker process, and removes the draft. Requests keep the version they started under.
 *  - Mandatory controls (BVN/KYC, SeedFi credit check, Shariah contract steps, segregation of duties, the approval
 *    verification checklist) are not product settings and cannot be switched off here.
 */
import type { Db, Tx } from "../db";
import { db as pool, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { conflict, DomainError, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import { CATEGORY_LABEL } from "./documents";
import { LEGACY_INITIATOR_ROLES, RETAIL_INITIATOR_ROLES, isRole } from "./roles";
import { configGaps, getProduct, INITIAL_PRODUCT_CONFIGS, productConfigSchema, type ProductConfig, type ProductRow } from "./products";
import { applySalariedDocumentUpdate, blankProfile, DEFAULT_TYPES, diffSettings, SALARIED_DOCUMENT_UPDATE, publishChecks, type Change, type General } from "@/lib/product-settings";
import { lagosDate } from "../time";

export const ORIGINATION_CEILING: Record<string, readonly string[]> = { RETAIL: RETAIL_INITIATOR_ROLES, WAKEELBOOST: LEGACY_INITIATOR_ROLES };
export const KNOWN_DOCUMENTS = Object.keys(CATEGORY_LABEL);

export interface Draft {
  product_code: string;
  config: ProductConfig;
  general: General;
  effective_from: string | null;
  base_version: number | null;
  source: "SUPPLIED" | "BLANK" | "VERSION" | "PROPOSAL";
  source_ref: string | null;
  revision: number;
  updated_at: Date;
  updated_by_name?: string | null;
}

export interface VersionRow {
  id: string;
  version: number;
  status: string;
  config: ProductConfig;
  effective_from: Date;
  reason: string;
  proposed_by: string | null;
  proposed_by_name: string | null;
  proposed_at: Date;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  published_via: string | null;
  previous_version: number | null;
  changes: Change[] | null;
  restored_from: number | null;
}

const isUuid = (s: string) => /^[0-9a-f-]{36}$/.test(s);

async function requireAdmin(q: Db, ctx: Ctx) {
  const actor = ctx.actor;
  if (!actor || !(await holdsRole(q, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can change product settings.");
  return actor;
}

export function generalOf(p: ProductRow): General {
  return { name: p.name, description: p.description ?? "", owner: p.owner ?? "", originationRoles: p.origination_roles ?? null, active: p.active };
}

/** An empty configuration: every value left to the administrator (only safe structural defaults are set). */
export function blankConfig(): ProductConfig {
  return productConfigSchema.parse({ profiles: { BUSINESS_OWNER: blankProfile(DEFAULT_TYPES.BUSINESS_OWNER) }, businessReview: { headOfUnitStage: null } });
}

export async function versionsOf(q: Db, code: string): Promise<VersionRow[]> {
  return (
    await q.query<VersionRow>(
      `SELECT c.*, p.full_name AS proposed_by_name, d.full_name AS decided_by_name FROM product_configs c
         LEFT JOIN staff p ON p.id = c.proposed_by LEFT JOIN staff d ON d.id = c.decided_by
        WHERE c.product_code = $1 ORDER BY c.version DESC`,
      [code],
    )
  ).rows.map((v) => {
    // Older versions were stored before some fields had defaults; read them with the defaults filled in so
    // comparisons show real changes only.
    const parsed = productConfigSchema.safeParse(v.config);
    return parsed.success ? { ...v, config: parsed.data } : v;
  });
}

const latestPublished = (versions: VersionRow[]) => versions.find((v) => v.status === "APPROVED") ?? null;

export async function draftOf(q: Db, code: string): Promise<Draft | null> {
  return (
    (
      await q.query<Draft>(
        `SELECT d.*, to_char(d.effective_from, 'YYYY-MM-DD') AS effective_from, s.full_name AS updated_by_name FROM product_config_drafts d
           LEFT JOIN staff s ON s.id = d.updated_by WHERE d.product_code = $1`,
        [code],
      )
    ).rows[0] ?? null
  );
}

export type SettingsStatus = "NOT_SET_UP" | "DRAFT" | "PUBLISHED" | "INCOMPLETE" | "SCHEDULED";

/** The products whose settings can be managed, with their configuration status. */
export async function productSettingsList(q: Db, now: Date) {
  const products = (await q.query<ProductRow>("SELECT * FROM products ORDER BY sort_order, name")).rows;
  const out = [];
  for (const p of products) {
    if (p.workflow !== "RETAIL") {
      out.push({ code: p.code, name: p.name, kind: p.workflow as string, active: p.active, status: "PUBLISHED" as SettingsStatus, version: null as number | null, effective: null as Date | null, draftAt: null as Date | null, gaps: 0, proposals: 0 });
      continue;
    }
    const versions = await versionsOf(q, p.code);
    const live = versions.filter((v) => v.status === "APPROVED" && new Date(v.effective_from) <= now).sort((a, b) => +new Date(b.effective_from) - +new Date(a.effective_from) || b.version - a.version)[0];
    const upcoming = versions.find((v) => v.status === "APPROVED" && new Date(v.effective_from) > now);
    const draft = await draftOf(q, p.code);
    const gaps = live ? configGaps(live.config).length : 0;
    const status: SettingsStatus = draft ? "DRAFT" : !live ? (upcoming ? "SCHEDULED" : "NOT_SET_UP") : gaps ? "INCOMPLETE" : "PUBLISHED";
    out.push({ code: p.code, name: p.name, kind: "RETAIL", active: p.active, status, version: live?.version ?? null, effective: live ? new Date(live.effective_from) : upcoming ? new Date(upcoming.effective_from) : null, draftAt: draft?.updated_at ?? null, gaps, proposals: versions.filter((v) => v.status === "PROPOSED").length });
  }
  out.push({ code: "ALTPHONES", name: "Altphones", kind: "ALTPHONES", active: true, status: "PUBLISHED" as SettingsStatus, version: null, effective: null, draftAt: null, gaps: 0, proposals: 0 });
  return out;
}

async function retailProduct(q: Db, code: string) {
  const p = await getProduct(q, code);
  if (!p) throw notFound("Product not found.");
  if (p.workflow !== "RETAIL") throw invalid(`${p.name} rules are managed in their own settings screens.`);
  return p;
}

/** Start a draft: from the parameters supplied by the bank, a blank form, a published version, or an earlier proposal. */
export async function startDraft(ctx: Ctx, code: string, from: { kind: "SUPPLIED" | "BLANK" | "VERSION" | "PROPOSAL"; ref?: string | null; replace?: boolean; update?: string | null }) {
  return withTx(async (tx) => {
    const actor = await requireAdmin(tx, ctx);
    const p = await retailProduct(tx, code);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('product_settings:' || $1))", [code]);
    const existing = await draftOf(tx, code);
    if (existing && !from.replace) throw conflict("A draft is already in progress for this product. Continue it, or discard it first.");
    const versions = await versionsOf(tx, code);
    const latest = latestPublished(versions);
    let config: ProductConfig;
    let ref: string | null = null;
    if (from.kind === "BLANK") config = blankConfig();
    else if (from.kind === "SUPPLIED") config = INITIAL_PRODUCT_CONFIGS[code] ? productConfigSchema.parse(INITIAL_PRODUCT_CONFIGS[code]) : blankConfig();
    else {
      const v = from.kind === "VERSION" ? (from.ref ? versions.find((x) => String(x.version) === String(from.ref)) : latest) : versions.find((x) => x.id === from.ref && x.status === "PROPOSED");
      if (!v) throw notFound(from.kind === "VERSION" ? "That version does not exist." : "That proposal is no longer open.");
      config = productConfigSchema.parse(v.config);
      ref = from.kind === "VERSION" ? String(v.version) : v.id;
    }
    // An approved update (e.g. salaried documentation) is applied to the version in force, as a draft only.
    if (from.update) {
      if (from.update !== SALARIED_DOCUMENT_UPDATE.key || from.kind !== "VERSION" || !latest) throw invalid("Unknown update.");
      const updated = applySalariedDocumentUpdate(config);
      if (!updated) throw conflict("This product already has the salaried documentation, or has no salaried profile.");
      config = productConfigSchema.parse(updated);
    }
    if (existing) await tx.query("DELETE FROM product_config_drafts WHERE product_code = $1", [code]);
    await tx.query(
      `INSERT INTO product_config_drafts (product_code, config, general, effective_from, base_version, source, source_ref, revision, created_by, created_at, updated_by, updated_at)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,1,$7,$8,$7,$8)`,
      [code, JSON.stringify(config), JSON.stringify(generalOf(p)), latest?.version ?? null, from.kind, ref, actor.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "PRODUCT_DRAFT_STARTED", actorRole: "SUPER_ADMIN", details: { productCode: code, source: from.kind, sourceRef: ref, update: from.update ?? null, baseVersion: latest?.version ?? null } });
    return { revision: 1 };
  });
}

function zodFieldErrors(issues: { path: (string | number)[]; message: string }[], cfg: ProductConfig | Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const i of issues) {
    // Turn array positions back into codes so the error lands beside the right field.
    const parts: string[] = [];
    let node: unknown = cfg;
    for (const seg of i.path) {
      if (typeof seg === "number" && Array.isArray(node)) {
        const el = node[seg] as { code?: string } | undefined;
        parts.push(el?.code ?? String(seg));
        node = el;
      } else {
        parts.push(String(seg));
        node = node && typeof node === "object" ? (node as Record<string, unknown>)[seg as string] : undefined;
      }
    }
    out[parts.join(".")] ??= i.message;
  }
  return out;
}

export interface SaveInput {
  config: unknown;
  general: General;
  effectiveFrom: string | null;
  revision: number;
}

/** Save the draft. Shape errors are returned beside their fields; incomplete settings are allowed in a draft. */
export async function saveDraft(ctx: Ctx, code: string, p: SaveInput) {
  return withTx(async (tx) => {
    const actor = await requireAdmin(tx, ctx);
    await retailProduct(tx, code);
    const d = (await tx.query<{ revision: number }>("SELECT revision FROM product_config_drafts WHERE product_code = $1 FOR UPDATE", [code])).rows[0];
    if (!d) throw notFound("There is no draft to save. Start one first.");
    if (d.revision !== p.revision) throw conflict("This draft was saved from another window since you opened it. Reload to see the latest version before saving.");
    const parsed = productConfigSchema.safeParse(p.config);
    if (!parsed.success) throw invalid("Some values are not valid. Check the highlighted fields.", zodFieldErrors(parsed.error.issues, (p.config ?? {}) as Record<string, unknown>));
    const g = p.general;
    if (!g || typeof g.name !== "string") throw invalid("The general settings are missing.");
    if (g.originationRoles && g.originationRoles.some((r) => !isRole(r))) throw invalid("Unknown role.", { "general.originationRoles": "Unknown role." });
    if (p.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom)) throw invalid("Enter a valid effective date.", { effectiveFrom: "Use the date picker." });
    const general: General = { name: g.name.trim(), description: (g.description ?? "").trim(), owner: (g.owner ?? "").trim(), originationRoles: g.originationRoles ?? null, active: !!g.active };
    await tx.query("UPDATE product_config_drafts SET config = $2, general = $3, effective_from = $4, revision = revision + 1, updated_by = $5, updated_at = $6 WHERE product_code = $1", [
      code,
      JSON.stringify(parsed.data),
      JSON.stringify(general),
      p.effectiveFrom || null,
      actor.staffId,
      ctx.now,
    ]);
    return { revision: d.revision + 1, savedAt: ctx.now };
  });
}

export async function discardDraft(ctx: Ctx, code: string) {
  return withTx(async (tx) => {
    await requireAdmin(tx, ctx);
    const r = await tx.query("DELETE FROM product_config_drafts WHERE product_code = $1", [code]);
    if (!r.rowCount) throw notFound("There is no draft.");
    await audit(tx, ctx, { action: "PRODUCT_DRAFT_DISCARDED", actorRole: "SUPER_ADMIN", details: { productCode: code } });
  });
}

/** Everything that blocks publication, keyed by field, plus warnings. Shared with the Review screen. */
export async function reviewDraft(q: Db, code: string, draft: Pick<Draft, "config" | "general">, product: ProductRow) {
  const { errors, warnings } = publishChecks(draft.config, draft.general, { ceiling: ORIGINATION_CEILING[product.workflow] ?? [], knownDocuments: KNOWN_DOCUMENTS });
  const used = [...new Set(Object.values(draft.config.profiles ?? {}).flatMap((r) => (r?.enabled ? r.structures.map((s) => s.code) : [])))];
  if (used.length) {
    const known = new Set((await q.query<{ code: string }>("SELECT code FROM contract_types WHERE code = ANY($1)", [used])).rows.map((r) => r.code));
    for (const [p, r] of Object.entries(draft.config.profiles ?? {}))
      for (const s of r?.structures ?? []) if (!known.has(s.code)) errors[`profiles.${p}.structures.${s.code}.ratePercent`] = `${s.code} is not a known contract type.`;
  }
  // Any remaining configuration gap that would block an application from being submitted.
  for (const g of configGaps(draft.config)) {
    if (g.blocks === "SUBMISSION") errors[g.key] ??= `Required before applications can be submitted: ${g.label}.`;
    else warnings.push(`${g.label} is not set: ${g.blocks.replace(/_/g, " ").toLowerCase()} stays blocked until it is.`);
  }
  // Reviewers who must exist for the chosen approval chain (a warning: assignment queues it for a Super Admin otherwise).
  const needed = draft.config.approvalPolicy === "RETAIL_CX_V1" ? ["TEAM_LEAD", "CX_CREDIT_REVIEWER", "UNIT_HEAD", "DIVISIONAL_HEAD"] : ["TEAM_LEAD", "HEAD_OF_RETAIL_SALES", "CREDIT_OFFICER_1", "UNIT_HEAD", "DIVISIONAL_HEAD"];
  const held = new Set((await q.query<{ role: string }>("SELECT DISTINCT ra.role FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND s.status = 'ACTIVE' AND ra.role = ANY($1)", [needed])).rows.map((r) => r.role));
  const missing = needed.filter((r) => !held.has(r));
  if (missing.length) warnings.push(`No active staff hold: ${missing.join(", ").toLowerCase().replace(/_/g, " ")}. Requests reaching those stages will wait in the assignment exception queue.`);
  return { errors, warnings: [...new Set(warnings)] };
}

function effectiveInstant(date: string | null, now: Date): Date {
  if (!date) return now;
  const today = lagosDate(now);
  if (date <= today) return now;
  return new Date(`${date}T00:00:00+01:00`);
}

export const settingsAuditRef = (code: string, version: number, id: string) => `PR-${code}-v${version}-${id.slice(0, 8).toUpperCase()}`;

/** Review & Publish: creates the next version (Version 1 when there is none) and activates it from its effective date. */
export async function publishDraft(ctx: Ctx, code: string, p: { reason: string; revision: number; effectiveFrom?: string | null }) {
  try {
    return await withTx(async (tx) => {
      const actor = await requireAdmin(tx, ctx);
      const product = await retailProduct(tx, code);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('product_settings:' || $1))", [code]);
      const draft = (await tx.query<Draft>("SELECT *, to_char(effective_from, 'YYYY-MM-DD') AS effective_from FROM product_config_drafts WHERE product_code = $1 FOR UPDATE", [code])).rows[0];
      if (!draft) throw notFound("There is no draft to publish.");
      if (draft.revision !== p.revision) throw conflict("The draft changed since you opened the review. Review the latest draft before publishing.");
      const versions = await versionsOf(tx, code);
      const latest = latestPublished(versions);
      if ((latest?.version ?? null) !== (draft.base_version ?? null))
        throw conflict(`Version ${latest?.version} was published after this draft was started. Start a new draft from it so no change is lost.`);
      const reason = (p.reason ?? "").trim();
      const errors: Record<string, string> = {};
      if (reason.length < 20) errors.reason = "Explain why the product rules are changing (at least 20 characters), e.g. the approving memo.";
      const effDate = p.effectiveFrom ?? draft.effective_from;
      if (!effDate) errors.effectiveFrom = "Choose the date the rules take effect.";
      else if (effDate < lagosDate(ctx.now)) errors.effectiveFrom = "The effective date cannot be in the past.";
      const cfg = productConfigSchema.parse(draft.config);
      const review = await reviewDraft(tx, code, { config: cfg, general: draft.general }, product);
      Object.assign(errors, review.errors);
      if (Object.keys(errors).length) throw invalid(`The product rules cannot be published yet: ${Object.keys(errors).length} item${Object.keys(errors).length === 1 ? "" : "s"} to fix.`, errors);
      const prevGeneral = generalOf(product);
      const changes = diffSettings({ config: latest?.config ?? {}, general: prevGeneral }, { config: cfg, general: draft.general });
      if (latest && !changes.length) throw invalid("There are no changes to publish.");
      const version = (versions[0]?.version ?? 0) + 1;
      // A draft started from an earlier version (not the one in force) is a restore.
      const restoredFrom = draft.source === "VERSION" && draft.source_ref && Number(draft.source_ref) !== latest?.version ? Number(draft.source_ref) : null;
      const effective = effectiveInstant(effDate!, ctx.now);
      const row = (
        await tx.query<{ id: string }>(
          `INSERT INTO product_configs (product_code, version, status, config, effective_from, reason, proposed_by, proposed_at, decided_by, decided_at, decision_note, published_via, previous_version, changes, restored_from)
           VALUES ($1,$2,'APPROVED',$3,$4,$5,$6,$7,$6,$7,'Published directly by a Super Admin','DIRECT',$8,$9,$10) RETURNING id`,
          [code, version, JSON.stringify(cfg), effective, reason, actor.staffId, ctx.now, latest?.version ?? null, JSON.stringify(changes), restoredFrom],
        )
      ).rows[0];
      const g = draft.general;
      await tx.query("UPDATE products SET name = $2, description = $3, owner = $4, origination_roles = $5, active = $6, updated_by = $7, updated_at = $8 WHERE code = $1", [
        code,
        g.name,
        g.description || null,
        g.owner || null,
        g.originationRoles,
        g.active,
        actor.staffId,
        ctx.now,
      ]);
      const superseded = await tx.query<{ version: number }>(
        "UPDATE product_configs SET status = 'WITHDRAWN', decided_by = $2, decided_at = $3, decision_note = $4 WHERE product_code = $1 AND status = 'PROPOSED' RETURNING version",
        [code, actor.staffId, ctx.now, `Superseded by version ${version}, published directly by a Super Admin`],
      );
      await tx.query("DELETE FROM product_config_drafts WHERE product_code = $1", [code]);
      await audit(tx, ctx, {
        action: "PRODUCT_RULES_PUBLISHED",
        actorRole: "SUPER_ADMIN",
        reason,
        details: { productCode: code, version, configId: row.id, previousVersion: latest?.version ?? null, effectiveFrom: effective.toISOString(), changes, previousConfig: latest?.config ?? null, newConfig: cfg, previousGeneral: prevGeneral, newGeneral: g, supersededProposals: superseded.rows.map((r) => r.version), source: draft.source, restoredFrom, outcome: "PUBLISHED" },
      });
      return { id: row.id, version, effectiveFrom: effective, auditReference: settingsAuditRef(code, version, row.id), changes: changes.length };
    });
  } catch (e) {
    if (e instanceof DomainError) await auditOutsideTx(ctx, { action: "PRODUCT_RULES_PUBLISH_REFUSED", outcome: e.code === "FORBIDDEN" ? "DENIED" : "FAILURE", reason: e.message, details: { productCode: code, fields: e.fields ?? null } });
    throw e;
  }
}

/** Dismiss a proposal from the earlier maker-checker process (recorded with a reason; nothing is approved). */
export async function dismissProposal(ctx: Ctx, id: string, reason: string) {
  return withTx(async (tx) => {
    const actor = await requireAdmin(tx, ctx);
    if (!isUuid(id)) throw notFound();
    const why = (reason ?? "").trim();
    if (why.length < 10) throw invalid("Give a reason for dismissing the proposal.", { reason: "At least 10 characters." });
    const r = (await tx.query<{ product_code: string; version: number }>("UPDATE product_configs SET status = 'WITHDRAWN', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1 AND status = 'PROPOSED' RETURNING product_code, version", [id, actor.staffId, ctx.now, `Dismissed by a Super Admin: ${why}`])).rows[0];
    if (!r) throw conflict("This proposal is no longer open.");
    await audit(tx, ctx, { action: "PRODUCT_PROPOSAL_DISMISSED", actorRole: "SUPER_ADMIN", reason: why, details: { productCode: r.product_code, version: r.version, configId: id } });
  });
}

/** The server's review of the saved draft: blocking items, warnings and the changes against the version in force. */
export async function reviewSavedDraft(ctx: Ctx, code: string) {
  const db = pool;
  await requireAdmin(db, ctx);
  const product = await retailProduct(db, code);
  const draft = await draftOf(db, code);
  if (!draft) throw notFound("There is no draft to review.");
  const latest = latestPublished(await versionsOf(db, code));
  const cfg = productConfigSchema.parse(draft.config);
  const review = await reviewDraft(db, code, { config: cfg, general: draft.general }, product);
  const changes = diffSettings({ config: latest?.config ?? {}, general: generalOf(product) }, { config: cfg, general: draft.general });
  const stale = (latest?.version ?? null) !== (draft.base_version ?? null);
  return { ...review, changes, nextVersion: (latest?.version ?? 0) + 1, firstVersion: !latest, stale, latestVersion: latest?.version ?? null, revision: draft.revision };
}

/** General settings for products whose rules live elsewhere (WakeelBoost): applied directly with a reason. */
export async function saveGeneralDirect(ctx: Ctx, code: string, g: General, reason: string) {
  return withTx(async (tx) => {
    const actor = await requireAdmin(tx, ctx);
    const p = await getProduct(tx, code);
    if (!p) throw notFound("Product not found.");
    if (p.workflow === "RETAIL") throw invalid("Use Edit Configuration for this product.");
    if ((reason ?? "").trim().length < 20) throw invalid("Explain why the settings are changing (at least 20 characters).", { reason: "At least 20 characters." });
    const { errors } = publishChecks({ profiles: { X: { enabled: true, eligibleApplicantTypes: ["INDIVIDUAL"], maxAmountKobo: 1, maxTenorMonths: 1, structures: [{ code: "S", ratePercent: "1", rateConvention: "x", insuranceBearer: "x" }], dsr: { maxPercent: "1", denominator: "x" }, documents: [{ code: "KYC", requirement: "MANDATORY", stage: "SUBMISSION" }] } }, businessReview: { headOfUnitStage: "DISTINCT" }, servicing: { restructureApproverRole: "x" } }, g, { ceiling: ORIGINATION_CEILING[p.workflow] ?? [], knownDocuments: ["KYC"] });
    const generalErrors = Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith("general.")));
    if (Object.keys(generalErrors).length) throw invalid("Check the highlighted settings.", generalErrors);
    const changes = diffSettings({ config: {}, general: generalOf(p) }, { config: {}, general: g });
    if (!changes.length) throw invalid("There are no changes to save.");
    await tx.query("UPDATE products SET name = $2, description = $3, owner = $4, origination_roles = $5, active = $6, updated_by = $7, updated_at = $8 WHERE code = $1", [code, g.name.trim(), g.description || null, g.owner || null, g.originationRoles, g.active, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "PRODUCT_GENERAL_SETTINGS_CHANGED", actorRole: "SUPER_ADMIN", reason: reason.trim(), details: { productCode: code, changes, previous: generalOf(p), next: g } });
    return { changes: changes.length };
  });
}

export type { Tx };
