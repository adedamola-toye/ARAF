/**
 * Approval Workflow Management (server side). Versions are append-only; version 1 of each product is created on
 * first use from `defaultDefinition` (the routing in force before workflows became configurable). A Super Admin
 * publishes a new version directly with a mandatory reason; it applies to requests submitted afterwards. Each
 * request records its version at submission, inside the submission transaction; requests with no version keep the
 * original routing (identical to version 1).
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { conflict, DomainError, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import type { AppRow } from "./assignment";
import {
  auditReference,
  bandByRoute,
  bandFor,
  defaultDefinition,
  diffDefinitions,
  parseDefinition,
  sameDefinition,
  validateDefinition,
  workflowProduct,
  type Band,
  type Change,
  type Family,
  type WorkflowDefinition,
} from "@/lib/approval-workflow";

export interface WorkflowVersion {
  id: string;
  product_code: string;
  version: number;
  definition: WorkflowDefinition;
  previous_id: string | null;
  previous_definition: WorkflowDefinition | null;
  changes: Change[];
  reason: string;
  published_by: string | null;
  published_by_name?: string | null;
  published_role: string | null;
  published_at: Date;
  restored_from_id: string | null;
}

const V1_REASON = "Version 1: the approval routing in force before workflows became configurable.";

function familyOf(productCode: string): Family {
  const p = workflowProduct(productCode);
  if (!p) throw notFound("This product has no managed approval workflow.");
  return p.family;
}

/** Create version 1 if the product has none (idempotent; safe under concurrency). */
export async function ensureVersionOne(q: Db, productCode: string, now = new Date()) {
  const family = familyOf(productCode);
  await q.query(
    `INSERT INTO approval_workflows (product_code, version, definition, reason, published_at)
     VALUES ($1, 1, $2, $3, $4) ON CONFLICT (product_code, version) DO NOTHING`,
    [productCode, JSON.stringify(defaultDefinition(family)), V1_REASON, now],
  );
}

export async function activeWorkflow(q: Db, productCode: string): Promise<WorkflowVersion> {
  await ensureVersionOne(q, productCode);
  const r = await q.query<WorkflowVersion>(
    `SELECT w.*, s.full_name AS published_by_name FROM approval_workflows w LEFT JOIN staff s ON s.id = w.published_by
      WHERE w.product_code = $1 ORDER BY w.version DESC LIMIT 1`,
    [productCode],
  );
  return r.rows[0];
}

export async function workflowHistory(q: Db, productCode: string): Promise<WorkflowVersion[]> {
  await ensureVersionOne(q, productCode);
  return (
    await q.query<WorkflowVersion>(
      `SELECT w.*, s.full_name AS published_by_name FROM approval_workflows w LEFT JOIN staff s ON s.id = w.published_by
        WHERE w.product_code = $1 ORDER BY w.version DESC`,
      [productCode],
    )
  ).rows;
}

export async function workflowVersionById(q: Db, id: string): Promise<WorkflowVersion | null> {
  return (await q.query<WorkflowVersion>("SELECT w.*, s.full_name AS published_by_name FROM approval_workflows w LEFT JOIN staff s ON s.id = w.published_by WHERE w.id = $1", [id])).rows[0] ?? null;
}

const productCodeOf = (app: Pick<AppRow, "workflow" | "product_code">) => (app.workflow === "RETAIL" ? app.product_code! : "WAKEELBOOST");

/** Record the active workflow version on a request at submission (same transaction as the submission). */
export async function pinWorkflow(tx: Tx, app: AppRow & { workflow_version_id?: string | null }, now: Date): Promise<WorkflowVersion> {
  const code = productCodeOf(app);
  await ensureVersionOne(tx, code, now);
  // Serialise with publication for this product so a submission never sees a half-published version.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('approval_workflow:' || $1))", [code]);
  const w = (await tx.query<WorkflowVersion>("SELECT * FROM approval_workflows WHERE product_code = $1 ORDER BY version DESC LIMIT 1", [code])).rows[0];
  app.workflow_version_id = w.id;
  await tx.query("UPDATE applications SET workflow_version_id = $2 WHERE id = $1", [app.id, w.id]);
  return w;
}

/**
 * The definition that routes a request: the version recorded at submission, or (for requests submitted before
 * configurable workflows, and drafts) the original routing.
 */
export async function definitionForApp(q: Db, app: Pick<AppRow, "id" | "workflow" | "product_code"> & { workflow_version_id?: string | null }): Promise<WorkflowDefinition> {
  let id = app.workflow_version_id;
  if (id === undefined) id = (await q.query<{ workflow_version_id: string | null }>("SELECT workflow_version_id FROM applications WHERE id = $1", [app.id])).rows[0]?.workflow_version_id ?? null;
  if (id) {
    const r = (await q.query<{ definition: WorkflowDefinition }>("SELECT definition FROM approval_workflows WHERE id = $1", [id])).rows[0];
    if (r) return r.definition;
  }
  return defaultDefinition(app.workflow === "RETAIL" ? "RETAIL" : "WAKEELBOOST");
}

/** The credit route for an amount under the request's workflow (throws a validation error when none covers it). */
export async function creditBandForApp(q: Db, app: Parameters<typeof definitionForApp>[1], amountKobo: number): Promise<Band> {
  const b = bandFor(await definitionForApp(q, app), amountKobo);
  if (!b) throw invalid("No credit approval route covers this amount.", { requestedAmountKobo: "No credit approval route covers this amount." });
  return b;
}

export async function creditBandOfApp(q: Db, app: Parameters<typeof definitionForApp>[1] & { route: number | null }): Promise<Band | null> {
  return bandByRoute(await definitionForApp(q, app), app.route);
}

// ------------------------------------------------------------------ publication

export interface PublishInput {
  productCode: string;
  definition: unknown;
  reason: string;
  /** The version the administrator edited; publication is refused if another version was published since. */
  expectedVersion: number;
  restoreFromId?: string | null;
}

export interface PublishResult {
  id: string;
  productCode: string;
  productName: string;
  version: number;
  publishedAt: Date;
  auditReference: string;
  changes: Change[];
}

export async function publishWorkflow(ctx: Ctx, p: PublishInput): Promise<PublishResult> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const product = workflowProduct(p.productCode);
  try {
    if (!product) throw notFound("This product has no managed approval workflow.");
    return await withTx(async (tx) => {
      if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can publish approval workflows.");
      const reason = (p.reason ?? "").trim();
      if (reason.length < 20) throw invalid("Enter the reason for this change (at least 20 characters).", { reason: "Explain why the workflow is changing (at least 20 characters)." });
      await ensureVersionOne(tx, product.code, ctx.now);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('approval_workflow:' || $1))", [product.code]);
      const current = (await tx.query<WorkflowVersion>("SELECT * FROM approval_workflows WHERE product_code = $1 ORDER BY version DESC LIMIT 1", [product.code])).rows[0];
      if (current.version !== p.expectedVersion) throw conflict(`Version ${current.version} was published while you were editing. Reload the workflow and apply your changes again.`);
      let restoredFrom: WorkflowVersion | null = null;
      let def: WorkflowDefinition;
      if (p.restoreFromId) {
        restoredFrom = await workflowVersionById(tx, p.restoreFromId);
        if (!restoredFrom || restoredFrom.product_code !== product.code) throw notFound("That version does not belong to this product.");
        def = restoredFrom.definition;
      } else {
        try {
          def = parseDefinition(p.definition, product.family);
        } catch (e) {
          throw invalid((e as Error).message);
        }
      }
      const problems = validateDefinition(def, product.family);
      if (problems.length) throw invalid(`The workflow cannot be published: ${problems.join(" ")}`, { definition: problems.join("\n") });
      const changes = diffDefinitions(current.definition, def);
      if (sameDefinition(def, current.definition) || !changes.length) throw invalid("There are no changes to publish.");
      const row = (
        await tx.query<{ id: string; version: number }>(
          `INSERT INTO approval_workflows (product_code, version, definition, previous_id, previous_definition, changes, reason, published_by, published_role, published_at, restored_from_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SUPER_ADMIN',$9,$10) RETURNING id, version`,
          [product.code, current.version + 1, JSON.stringify(def), current.id, JSON.stringify(current.definition), JSON.stringify(changes), reason, actor.staffId, ctx.now, restoredFrom?.id ?? null],
        )
      ).rows[0];
      await audit(tx, ctx, {
        action: "APPROVAL_WORKFLOW_PUBLISHED",
        actorRole: "SUPER_ADMIN",
        reason,
        details: {
          product: product.code,
          workflowVersionId: row.id,
          version: row.version,
          previousVersion: current.version,
          previousVersionId: current.id,
          previousDefinition: current.definition,
          newDefinition: def,
          changes,
          restoredFromVersion: restoredFrom?.version ?? null,
          outcome: "PUBLISHED",
        },
      });
      return { id: row.id, productCode: product.code, productName: product.name, version: row.version, publishedAt: ctx.now, auditReference: auditReference(product.code, row.version, row.id), changes };
    });
  } catch (e) {
    if (e instanceof DomainError) {
      await auditOutsideTx(ctx, { action: "APPROVAL_WORKFLOW_PUBLISH_REFUSED", outcome: e.code === "FORBIDDEN" ? "DENIED" : "FAILURE", reason: e.message, details: { product: p.productCode, expectedVersion: p.expectedVersion, outcome: "REFUSED" } });
    }
    throw e;
  }
}
