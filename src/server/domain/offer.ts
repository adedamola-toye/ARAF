import type { Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { config } from "../config";
import { decryptField } from "../crypto";
import { forbidden, gate, notFound, invalid } from "../errors";
import { formatKobo } from "../money";
import { formatDateOnly, lagosDate } from "../time";
import { latestAssessment } from "./assessment";
import { storeGeneratedDocument } from "./documents";
import { holdsRole } from "./access";
import { assetCostKobo, type ApplicantType, type DraftData } from "./application-data";

/**
 * Offer template placeholders. Templates are bank-owned HTML with these tokens:
 *   {{customer_name}} {{markup}} {{markup_rate}} {{financed_items}} {{asset_cost}} {{bvn}}
 *   {{cost_plus_markup}} {{tin}} {{request_ref}} {{offer_date}} {{tenor_months}} {{registration_number}}
 *   {{#directors}} ... {{director_name}} ... {{director_bvn}} ... {{/directors}}   (Limited only; repeats per director)
 *   {{#if_bvn}} ... {{/if_bvn}}  {{#if_tin}} ... {{/if_tin}}  (rendered only when the value applies)
 */
export const PLACEHOLDERS = [
  "customer_name",
  "markup",
  "markup_rate",
  "financed_items",
  "asset_cost",
  "bvn",
  "cost_plus_markup",
  "tin",
  "request_ref",
  "offer_date",
  "tenor_months",
  "registration_number",
  "director_name",
  "director_bvn",
] as const;

export interface OfferContext {
  applicantType: ApplicantType;
  data: DraftData;
  bvn: string | null;
  tin: string | null;
  directors: { fullName: string; bvn: string }[];
  markupKobo: number;
  markupRate: string;
  costPlusMarkupKobo: number;
  assetCostKobo: number;
  ref: string;
  offerDate: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Legal name used on the offer: Individual name / "Name trading as Business" / company name. */
export function offerCustomerName(type: ApplicantType, d: DraftData): string {
  if (type === "ENTERPRISE") return `${d.customerName} trading as ${d.businessName}`;
  if (type === "LIMITED") return d.companyName;
  return d.customerName;
}

export function renderOffer(templateHtml: string, c: OfferContext): string {
  const itemsRows = c.data.items
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.description)}</td><td style="text-align:right">${i.quantity}</td><td style="text-align:right">${formatKobo(i.unitCostKobo)}</td><td style="text-align:right">${formatKobo(i.quantity * i.unitCostKobo)}</td></tr>`,
    )
    .join("");
  const itemsTable = `<table class="items" style="border-collapse:collapse;width:100%" border="1" cellpadding="6"><thead><tr><th>Item</th><th>Qty</th><th>Unit cost</th><th>Total</th></tr></thead><tbody>${itemsRows}</tbody></table>`;

  const values: Record<string, string> = {
    customer_name: escapeHtml(offerCustomerName(c.applicantType, c.data)),
    markup: formatKobo(c.markupKobo),
    markup_rate: escapeHtml(c.markupRate),
    financed_items: itemsTable,
    asset_cost: formatKobo(c.assetCostKobo),
    bvn: escapeHtml(c.bvn ?? ""),
    cost_plus_markup: formatKobo(c.costPlusMarkupKobo),
    tin: escapeHtml(c.tin ?? ""),
    request_ref: escapeHtml(c.ref),
    offer_date: escapeHtml(c.offerDate),
    tenor_months: String(c.data.tenorMonths ?? ""),
    registration_number: escapeHtml(c.data.registrationNumber),
  };

  let html = templateHtml;
  // Repeating director section
  html = html.replace(/\{\{#directors\}\}([\s\S]*?)\{\{\/directors\}\}/g, (_m, inner: string) =>
    c.applicantType === "LIMITED"
      ? c.directors
          .map((d) => inner.replace(/\{\{director_name\}\}/g, escapeHtml(d.fullName)).replace(/\{\{director_bvn\}\}/g, escapeHtml(d.bvn)))
          .join("")
      : "",
  );
  html = html.replace(/\{\{#if_bvn\}\}([\s\S]*?)\{\{\/if_bvn\}\}/g, (_m, inner) => (c.bvn ? inner : ""));
  html = html.replace(/\{\{#if_tin\}\}([\s\S]*?)\{\{\/if_tin\}\}/g, (_m, inner) => (c.tin ? inner : ""));
  html = html.replace(/\{\{([a-z_]+)\}\}/g, (m, key: string) => (key in values ? values[key] : m));
  return html;
}

/** Validate a template before it can be saved: every required placeholder must be present. */
export function validateTemplate(html: string): string[] {
  const required = ["customer_name", "markup", "financed_items", "asset_cost", "bvn", "cost_plus_markup", "tin"];
  const missing = required.filter((p) => !html.includes(`{{${p}}}`));
  const errors = missing.map((m) => `Missing placeholder {{${m}}}`);
  if (!/\{\{#directors\}\}[\s\S]*\{\{director_name\}\}[\s\S]*\{\{director_bvn\}\}[\s\S]*\{\{\/directors\}\}/.test(html)) {
    errors.push("Missing repeating director section {{#directors}} … {{director_name}} … {{director_bvn}} … {{/directors}}");
  }
  if (/<script/i.test(html)) errors.push("Templates must not contain scripts.");
  return errors;
}

export async function activeTemplate(tx: Tx) {
  return (await tx.query("SELECT * FROM offer_templates WHERE status = 'ACTIVE'")).rows[0] ?? null;
}

/** Generate a frozen offer letter copy from the active versioned template (initiator at offer preparation). */
export async function generateOffer(ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    if (!app) throw notFound();
    const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [appId])).rows[0];
    if (!task || task.stage !== "OFFER_PREPARATION" || task.assignee_id !== actor.staffId || !(await holdsRole(tx, actor.staffId, task.assignee_role))) {
      throw forbidden("The offer can only be generated by the initiator at offer preparation.");
    }
    const tpl = await activeTemplate(tx);
    if (!tpl) throw gate("No active offer template is configured. Ask the Super Admin to activate the bank's approved template.");
    if (config.isProduction && !tpl.production_approved) throw gate("The active offer template is not approved for production use.");
    const version = (await tx.query("SELECT * FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
    const directors = (await tx.query("SELECT * FROM application_directors WHERE version_id = $1 ORDER BY position", [version.id])).rows;
    const assessment = await latestAssessment(tx, appId);
    if (!assessment) throw gate("No valid credit assessment exists for this request.");
    const data = version.data as DraftData;
    const html = renderOffer(tpl.body_html, {
      applicantType: app.applicant_type,
      data,
      bvn: version.bvn_enc ? decryptField(version.bvn_enc) : null,
      tin: version.tin_enc ? decryptField(version.tin_enc) : null,
      directors: directors.map((d: { full_name: string; bvn_enc: string }) => ({ fullName: d.full_name, bvn: decryptField(d.bvn_enc) })),
      markupKobo: Number(assessment.markup_kobo),
      markupRate: String((assessment.inputs as Record<string, unknown>).markupRatePercent ?? ""),
      costPlusMarkupKobo: Number(assessment.cost_plus_markup_kobo),
      assetCostKobo: Number((assessment.inputs as Record<string, unknown>).assetCostKobo ?? assetCostKobo(data.items)),
      ref: app.ref,
      offerDate: formatDateOnly(lagosDate(ctx.now)),
    });
    if (!html.trim()) throw invalid("Rendered offer is empty.");
    const doc = await storeGeneratedDocument(tx, ctx, {
      appId,
      category: "GENERATED_OFFER",
      filename: `Offer-${app.ref}-t${tpl.version}.html`,
      mime: "text/html",
      data: Buffer.from(wrapOfferDocument(html, app.ref), "utf8"),
      templateId: tpl.id,
      templateVersion: tpl.version,
      role: task.assignee_role,
      stage: app.stage,
      versionId: app.current_version_id,
    });
    await tx.query("UPDATE applications SET offer_template_id = $2, updated_at = $3 WHERE id = $1", [appId, tpl.id, ctx.now]);
    await audit(tx, ctx, {
      action: "OFFER_GENERATED",
      actorRole: task.assignee_role,
      applicationId: appId,
      stage: app.stage,
      documentId: doc.id,
      documentVersion: doc.version,
      details: { templateId: tpl.id, templateName: tpl.name, templateVersion: tpl.version, assessmentId: assessment.id },
    });
    return { documentId: doc.id, templateVersion: tpl.version as number };
  });
}

function wrapOfferDocument(body: string, ref: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Offer ${escapeHtml(ref)}</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111;line-height:1.5}
table{border-collapse:collapse}th{background:#f3f3f3}@media print{.noprint{display:none}}</style></head>
<body>${body}</body></html>`;
}

export const DEV_OFFER_TEMPLATE = `<div style="border-bottom:4px solid #FFC20E;padding-bottom:8px;margin-bottom:16px">
  <strong style="font-size:20px">WakeelBoost</strong> &middot; Alternative Bank
  <div style="color:#b00;font-weight:bold">DEVELOPMENT SAMPLE TEMPLATE &ndash; NOT BANK APPROVED &ndash; DO NOT ISSUE</div>
</div>
<p>Date: {{offer_date}}<br>Reference: {{request_ref}}</p>
<p>Dear <strong>{{customer_name}}</strong>,</p>
<h2>Offer of Murabaha Stock Financing (WakeelBoost)</h2>
<p>We are pleased to offer you stock financing on the following terms.</p>
<h3>Financed items</h3>
{{financed_items}}
<table cellpadding="6" style="margin-top:12px">
  <tr><td>Asset cost</td><td><strong>{{asset_cost}}</strong></td></tr>
  <tr><td>Markup ({{markup_rate}}% for the tenor)</td><td><strong>{{markup}}</strong></td></tr>
  <tr><td>Cost plus markup (sale price)</td><td><strong>{{cost_plus_markup}}</strong></td></tr>
  <tr><td>Tenor</td><td>{{tenor_months}} months</td></tr>
</table>
<h3>Customer identifiers</h3>
<p>{{#if_bvn}}BVN: {{bvn}}<br>{{/if_bvn}}{{#if_tin}}TIN: {{tin}}<br>{{/if_tin}}Registration number: {{registration_number}}</p>
{{#directors}}<p class="director">Director: {{director_name}} &mdash; BVN: {{director_bvn}}</p>{{/directors}}
<p style="margin-top:32px">Accepted by: ______________________ &nbsp; Date: __________</p>
<p>For: Alternative Bank &nbsp; ______________________</p>`;
