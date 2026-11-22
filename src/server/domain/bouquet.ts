/**
 * Facility Bouquet — Divisional Head concurrence over many facilities that every preceding officer has already
 * approved. A bouquet aggregates approval DECISIONS; it never merges facilities. Each member keeps its own
 * application, task, approved version, decision, stage move and audit record.
 *
 * Governance:
 *  - Feature switch BOUQUET_APPROVALS is OFF by default, and even when ON no product is eligible until a Super Admin
 *    names the eligible products. When off, every facility needs its own Divisional Head decision (unchanged).
 *  - A facility with a material exception or an individual-review requirement is never silently included: it is
 *    listed separately with the reasons and stays in the Divisional Head's individual queue.
 *  - Concurrence is all-or-nothing in one transaction: each included facility is locked and re-checked (task still
 *    open and assigned, same approved version, unchanged since it was added, still eligible). If any check fails,
 *    nothing is concurred and the facilities concerned are named.
 *  - Concurrence moves each facility to offer preparation. It never marks anything as disbursed.
 */
import { randomInt } from "node:crypto";
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate, invalid, notFound } from "../errors";
import { formatKobo } from "../money";
import { holdsRole } from "./access";
import { isEnabled } from "./switches";
import { photoSkips } from "./photo-review";
import { openCreditException } from "./credit-exception";
import { notify } from "./notifications";
import type { AppRow } from "./assignment";
import { type TaskRow, concurAsDivisionalHead, creditCorrection, lockApp, persistApp } from "./workflow";

export type ExclusionAction = "INDIVIDUAL_REVIEW" | "RETURN_FOR_CORRECTION";
export const EXCLUSION_ACTION_LABEL: Record<ExclusionAction, string> = {
  INDIVIDUAL_REVIEW: "Hold for my individual review",
  RETURN_FOR_CORRECTION: "Return for credit correction",
};

export interface BouquetSettings {
  eligible_products: string[];
  max_size: number;
  min_inspections: number;
  individual_review_above_kobo: string | null;
  max_total_kobo: string | null;
  exclusion_default: ExclusionAction;
  updated_at: Date;
  updated_by_name?: string | null;
}

export async function bouquetSettings(q: Db): Promise<BouquetSettings> {
  return (
    await q.query<BouquetSettings>(
      `SELECT b.eligible_products, b.max_size, b.min_inspections, b.individual_review_above_kobo::text, b.max_total_kobo::text, b.exclusion_default, b.updated_at, s.full_name AS updated_by_name
         FROM bouquet_settings b LEFT JOIN staff s ON s.id = b.updated_by WHERE b.id = 1`,
    )
  ).rows[0];
}

export interface BouquetSettingsInput {
  eligibleProducts: string[];
  maxSize: number;
  minInspections: number;
  individualReviewAboveKobo: number | null;
  maxTotalKobo: number | null;
  exclusionDefault: ExclusionAction;
}

export async function saveBouquetSettings(ctx: Ctx, input: BouquetSettingsInput, reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const why = (reason ?? "").trim();
  const errors: Record<string, string> = {};
  if (why.length < 10) errors.reason = "Give the reason for the change (at least 10 characters).";
  if (!Number.isInteger(input.maxSize) || input.maxSize < 2 || input.maxSize > 200) errors.maxSize = "Between 2 and 200 facilities.";
  if (!Number.isInteger(input.minInspections) || input.minInspections < 0 || input.minInspections > input.maxSize) errors.minInspections = "Zero or more, and not above the maximum size.";
  for (const [k, v] of [["individualReviewAboveKobo", input.individualReviewAboveKobo], ["maxTotalKobo", input.maxTotalKobo]] as const) {
    if (v !== null && (!Number.isSafeInteger(v) || v <= 0)) errors[k] = "Leave blank for no limit, or enter an amount above zero.";
  }
  if (!["INDIVIDUAL_REVIEW", "RETURN_FOR_CORRECTION"].includes(input.exclusionDefault)) errors.exclusionDefault = "Choose what happens to an excluded facility.";
  if (Object.keys(errors).length) throw invalid("Check the bouquet settings.", errors);
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can change bouquet settings.");
    const known = new Set((await tx.query<{ code: string }>("SELECT code FROM products")).rows.map((r) => r.code));
    const products = [...new Set(input.eligibleProducts)].filter((p) => known.has(p)).sort();
    const before = await bouquetSettings(tx);
    await tx.query(
      `UPDATE bouquet_settings SET eligible_products=$1, max_size=$2, min_inspections=$3, individual_review_above_kobo=$4, max_total_kobo=$5, exclusion_default=$6, updated_by=$7, updated_at=$8 WHERE id = 1`,
      [products, input.maxSize, input.minInspections, input.individualReviewAboveKobo, input.maxTotalKobo, input.exclusionDefault, actor.staffId, ctx.now],
    );
    await audit(tx, ctx, {
      action: "BOUQUET_SETTINGS_CHANGED",
      actorRole: "SUPER_ADMIN",
      reason: why,
      details: { before: { ...before, updated_by_name: undefined, updated_at: undefined }, after: { ...input, eligibleProducts: products } },
    });
  });
}

/** Feature on AND at least one eligible product. */
export async function bouquetsActive(q: Db): Promise<boolean> {
  if (!(await isEnabled(q, "BOUQUET_APPROVALS"))) return false;
  return (await bouquetSettings(q)).eligible_products.length > 0;
}

// ------------------------------------------------------------------ eligibility

export interface Candidate {
  application_id: string;
  task_id: string;
  version_id: string | null;
  lock_version: number;
  ref: string;
  customer_name: string | null;
  product_code: string | null;
  product_label: string | null;
  amount_kobo: string;
  assigned_at: Date;
  submitted_at: Date | null;
  workflow: string;
}

/** Why a facility must be reviewed individually (empty: eligible for a bouquet). */
export async function individualReviewReasons(q: Db, c: Candidate, s: BouquetSettings): Promise<string[]> {
  const out: string[] = [];
  if (!c.product_code || !s.eligible_products.includes(c.product_code)) out.push("Product is not eligible for bouquet concurrence");
  if (s.individual_review_above_kobo && BigInt(c.amount_kobo) > BigInt(s.individual_review_above_kobo)) out.push(`Amount above the individual-review threshold (${formatKobo(Number(s.individual_review_above_kobo))})`);
  const a = (await q.query<{ suspended_at: Date | null; active_correction_id: string | null }>("SELECT suspended_at, active_correction_id FROM applications WHERE id = $1", [c.application_id])).rows[0];
  if (a?.suspended_at) out.push("Request is suspended");
  if (a?.active_correction_id) out.push("An unresolved correction is open");
  if (await openCreditException(q, c.application_id)) out.push("Credit score exception (Proceed with Reason)");
  const dsr = await q.query("SELECT 1 FROM decisions WHERE application_id = $1 AND invalidated_at IS NULL AND reason LIKE 'DSR exception:%' LIMIT 1", [c.application_id]);
  if (dsr.rowCount) out.push("DSR above the configured limit, approved as an exception");
  const pol = await q.query<{ type: string }>("SELECT DISTINCT type FROM policy_exceptions WHERE application_id = $1 AND status IN ('REQUESTED','APPROVED')", [c.application_id]);
  for (const p of pol.rows) out.push(`Policy exception (${p.type})`);
  if ((await photoSkips(q, c.application_id)).length) out.push("Business photograph skipped by the Team Lead");
  return out;
}

async function openDhTasks(q: Db, dhId: string): Promise<Candidate[]> {
  return (
    await q.query<Candidate>(
      `SELECT a.id AS application_id, t.id AS task_id, t.version_id, a.lock_version, a.ref, a.customer_name, a.product_code, a.product_label,
              coalesce(a.requested_amount_kobo, 0)::text AS amount_kobo, t.assigned_at, a.submitted_at, a.workflow
         FROM tasks t JOIN applications a ON a.id = t.application_id
        WHERE t.status = 'OPEN' AND t.stage = 'DIVISIONAL_HEAD_REVIEW' AND t.assignee_id = $1
        ORDER BY t.assigned_at ASC`,
      [dhId],
    )
  ).rows;
}

/** The Divisional Head's open concurrence tasks split into bouquet-eligible and individual-review. */
export async function candidates(q: Db, dhId: string) {
  const s = await bouquetSettings(q);
  const live = new Set((await q.query<{ task_id: string }>("SELECT task_id FROM bouquet_members WHERE status = 'INCLUDED'")).rows.map((r) => r.task_id));
  const eligible: Candidate[] = [];
  const individual: (Candidate & { reasons: string[] })[] = [];
  const held = new Set(
    (
      await q.query<{ task_id: string }>(
        "SELECT m.task_id FROM bouquet_members m JOIN bouquets b ON b.id = m.bouquet_id WHERE m.status = 'EXCLUDED' AND b.divisional_head_id = $1",
        [dhId],
      )
    ).rows.map((r) => r.task_id),
  );
  for (const c of await openDhTasks(q, dhId)) {
    if (live.has(c.task_id)) continue;
    const reasons = await individualReviewReasons(q, c, s);
    if (held.has(c.task_id)) reasons.push("Excluded from a bouquet for individual review");
    if (reasons.length) individual.push({ ...c, reasons });
    else eligible.push(c);
  }
  return { settings: s, eligible, individual };
}

// ------------------------------------------------------------------ bouquet lifecycle

async function requireDh(tx: Tx, ctx: Ctx) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await holdsRole(tx, actor.staffId, "DIVISIONAL_HEAD"))) throw forbidden("Only a Divisional Head can work with facility bouquets.");
  if (!(await isEnabled(tx, "BOUQUET_APPROVALS"))) throw gate("Facility Bouquet is switched off. Each facility needs its own Divisional Head decision.");
  return actor.staffId;
}

async function lockOwnBouquet(tx: Tx, staffId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Bouquet not found.");
  const b = (await tx.query<{ id: string; ref: string; status: string; divisional_head_id: string }>("SELECT * FROM bouquets WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!b) throw notFound("Bouquet not found.");
  if (b.divisional_head_id !== staffId) throw forbidden("This bouquet belongs to another Divisional Head.");
  return b;
}

/**
 * Build (or top up) the Divisional Head's open bouquet from their eligible concurrence tasks, up to the maximum size.
 * Members whose task has left the Divisional Head stage are marked LEFT. Members changed since they were added are
 * re-snapshotted and their inspection cleared, so the Divisional Head sees them afresh.
 */
export async function assembleBouquet(ctx: Ctx): Promise<{ id: string; ref: string; added: number; refreshed: number; left: number }> {
  return withTx(async (tx) => {
    const dh = await requireDh(tx, ctx);
    const s = await bouquetSettings(tx);
    if (!s.eligible_products.length) throw gate("No product is eligible for bouquet concurrence yet. A Super Admin sets the eligible products in Administration.");
    let b = (await tx.query<{ id: string; ref: string }>("SELECT id, ref FROM bouquets WHERE divisional_head_id = $1 AND status = 'OPEN' FOR UPDATE", [dh])).rows[0];
    if (!b) {
      const n = (await tx.query<{ n: string }>("SELECT nextval('bouquet_ref_seq')::text AS n")).rows[0].n;
      const ref = `BQ-${ctx.now.getUTCFullYear()}-${n.padStart(5, "0")}`;
      b = (
        await tx.query<{ id: string; ref: string }>(
          "INSERT INTO bouquets (ref, divisional_head_id, settings_snapshot, created_at, updated_at) VALUES ($1,$2,$3,$4,$4) RETURNING id, ref",
          [ref, dh, JSON.stringify(s), ctx.now],
        )
      ).rows[0];
      await audit(tx, ctx, { action: "BOUQUET_CREATED", actorRole: "DIVISIONAL_HEAD", details: { bouquetId: b.id, ref: b.ref, settings: s } });
    }
    // Existing members: drop those that left the stage, refresh those that changed.
    const members = (
      await tx.query<{ id: string; task_id: string; application_id: string; version_id: string | null; lock_version: number; status: string }>(
        "SELECT id, task_id, application_id, version_id, lock_version, status FROM bouquet_members WHERE bouquet_id = $1 AND status = 'INCLUDED'",
        [b.id],
      )
    ).rows;
    const open = new Map((await openDhTasks(tx, dh)).map((c) => [c.task_id, c]));
    let left = 0;
    let refreshed = 0;
    for (const m of members) {
      const c = open.get(m.task_id);
      const reasons = c ? await individualReviewReasons(tx, c, s) : ["no longer awaiting concurrence"];
      if (!c || reasons.length) {
        await tx.query("UPDATE bouquet_members SET status = 'LEFT' WHERE id = $1", [m.id]);
        await audit(tx, ctx, { action: "BOUQUET_MEMBER_LEFT", actorRole: "DIVISIONAL_HEAD", applicationId: m.application_id, details: { bouquetId: b.id, ref: b.ref, why: reasons } });
        left++;
      } else if (c.lock_version !== m.lock_version || c.version_id !== m.version_id) {
        await tx.query(
          "UPDATE bouquet_members SET lock_version = $2, version_id = $3, amount_kobo = $4, inspected_at = NULL, inspected_by = NULL, inspection_note = NULL WHERE id = $1",
          [m.id, c.lock_version, c.version_id, c.amount_kobo],
        );
        await audit(tx, ctx, { action: "BOUQUET_MEMBER_REFRESHED", actorRole: "DIVISIONAL_HEAD", applicationId: m.application_id, details: { bouquetId: b.id, ref: b.ref, from: m.lock_version, to: c.lock_version } });
        refreshed++;
      }
    }
    const count = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM bouquet_members WHERE bouquet_id = $1 AND status = 'INCLUDED'", [b.id])).rows[0].n;
    const { eligible } = await candidates(tx, dh);
    const room = Math.max(0, s.max_size - count);
    const add = eligible.slice(0, room);
    for (const c of add) {
      await tx.query(
        `INSERT INTO bouquet_members (bouquet_id, application_id, task_id, version_id, lock_version, amount_kobo, product_code, added_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (bouquet_id, application_id) DO UPDATE SET status = 'INCLUDED', task_id = EXCLUDED.task_id, version_id = EXCLUDED.version_id, lock_version = EXCLUDED.lock_version,
           amount_kobo = EXCLUDED.amount_kobo, inspected_at = NULL, inspected_by = NULL, inspection_note = NULL, excluded_at = NULL, excluded_by = NULL, exclusion_reason = NULL, exclusion_action = NULL, added_at = EXCLUDED.added_at`,
        [b.id, c.application_id, c.task_id, c.version_id, c.lock_version, c.amount_kobo, c.product_code, ctx.now],
      );
      await audit(tx, ctx, { action: "BOUQUET_MEMBER_ADDED", actorRole: "DIVISIONAL_HEAD", applicationId: c.application_id, details: { bouquetId: b.id, ref: b.ref, taskId: c.task_id, versionId: c.version_id, amountKobo: c.amount_kobo } });
    }
    await tx.query("UPDATE bouquets SET updated_at = $2 WHERE id = $1", [b.id, ctx.now]);
    return { id: b.id, ref: b.ref, added: add.length, refreshed, left };
  });
}

export interface MemberRow {
  id: string;
  application_id: string;
  task_id: string;
  ref: string;
  customer_name: string | null;
  product_code: string | null;
  product_label: string | null;
  amount_kobo: string;
  status: "INCLUDED" | "EXCLUDED" | "CONCURRED" | "LEFT";
  inspected_at: Date | null;
  inspected_by_name: string | null;
  inspection_note: string | null;
  sampled: boolean;
  excluded_at: Date | null;
  exclusion_reason: string | null;
  exclusion_action: ExclusionAction | null;
  excluded_by_name: string | null;
  submitted_at: Date | null;
  assigned_at: Date | null;
  changed: boolean;
  uh_name: string | null;
  uh_at: Date | null;
}

export async function bouquetDetail(q: Db, id: string, viewerId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const b = (
    await q.query<{ id: string; ref: string; status: string; divisional_head_id: string; dh_name: string; created_at: Date; concurred_at: Date | null; concurred_count: number | null; concurred_total_kobo: string | null; acknowledgement: string | null; settings_snapshot: BouquetSettings }>(
      "SELECT b.*, b.concurred_total_kobo::text, s.full_name AS dh_name FROM bouquets b JOIN staff s ON s.id = b.divisional_head_id WHERE b.id = $1",
      [id],
    )
  ).rows[0];
  if (!b) return null;
  if (b.divisional_head_id !== viewerId && !(await holdsRole(q, viewerId, "SUPER_ADMIN"))) return null;
  const members = (
    await q.query<MemberRow>(
      `SELECT m.id, m.application_id, m.task_id, a.ref, a.customer_name, a.product_code, a.product_label, m.amount_kobo::text, m.status, m.inspected_at, si.full_name AS inspected_by_name,
              m.inspection_note, m.sampled, m.excluded_at, m.exclusion_reason, m.exclusion_action, se.full_name AS excluded_by_name, a.submitted_at, t.assigned_at,
              (m.status = 'INCLUDED' AND (a.lock_version <> m.lock_version OR t.status <> 'OPEN')) AS changed,
              (SELECT s2.full_name FROM decisions d JOIN staff s2 ON s2.id = d.actor_id WHERE d.application_id = a.id AND d.stage = 'UNIT_HEAD_REVIEW' AND d.action IN ('APPROVE','PROCEED') AND d.invalidated_at IS NULL ORDER BY d.created_at DESC LIMIT 1) AS uh_name,
              (SELECT d.created_at FROM decisions d WHERE d.application_id = a.id AND d.stage = 'UNIT_HEAD_REVIEW' AND d.action IN ('APPROVE','PROCEED') AND d.invalidated_at IS NULL ORDER BY d.created_at DESC LIMIT 1) AS uh_at
         FROM bouquet_members m JOIN applications a ON a.id = m.application_id JOIN tasks t ON t.id = m.task_id
         LEFT JOIN staff si ON si.id = m.inspected_by LEFT JOIN staff se ON se.id = m.excluded_by
        WHERE m.bouquet_id = $1 ORDER BY m.added_at, a.ref`,
      [id],
    )
  ).rows;
  const included = members.filter((m) => m.status === "INCLUDED" || m.status === "CONCURRED");
  const total = included.reduce((s, m) => s + BigInt(m.amount_kobo), 0n);
  const byProduct = new Map<string, { label: string; count: number; kobo: bigint }>();
  for (const m of included) {
    const k = m.product_code ?? "—";
    const e = byProduct.get(k) ?? { label: m.product_label ?? k, count: 0, kobo: 0n };
    e.count++;
    e.kobo += BigInt(m.amount_kobo);
    byProduct.set(k, e);
  }
  const oldest = included.reduce<Date | null>((o, m) => (m.assigned_at && (!o || m.assigned_at < o) ? m.assigned_at : o), null);
  return {
    bouquet: b,
    members,
    included,
    excluded: members.filter((m) => m.status === "EXCLUDED"),
    totalKobo: total.toString(),
    inspected: members.filter((m) => m.inspected_at && m.status !== "LEFT").length,
    products: [...byProduct.values()].map((p) => ({ ...p, kobo: p.kobo.toString() })),
    oldest,
    changed: included.filter((m) => m.changed),
  };
}

export async function myBouquets(q: Db, dhId: string) {
  return (
    await q.query<{ id: string; ref: string; status: string; created_at: Date; concurred_at: Date | null; included: number; total_kobo: string }>(
      `SELECT b.id, b.ref, b.status, b.created_at, b.concurred_at,
              count(m.*) FILTER (WHERE m.status IN ('INCLUDED','CONCURRED'))::int AS included,
              coalesce(sum(m.amount_kobo) FILTER (WHERE m.status IN ('INCLUDED','CONCURRED')), 0)::text AS total_kobo
         FROM bouquets b LEFT JOIN bouquet_members m ON m.bouquet_id = b.id
        WHERE b.divisional_head_id = $1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 30`,
      [dhId],
    )
  ).rows;
}

async function lockMember(tx: Tx, ctx: Ctx, memberId: string) {
  const dh = await requireDh(tx, ctx);
  if (!/^[0-9a-f-]{36}$/i.test(memberId)) throw notFound("Facility not found in this bouquet.");
  const m = (await tx.query<{ id: string; bouquet_id: string; application_id: string; task_id: string; status: string; inspected_at: Date | null }>("SELECT * FROM bouquet_members WHERE id = $1", [memberId])).rows[0];
  if (!m) throw notFound("Facility not found in this bouquet.");
  const b = await lockOwnBouquet(tx, dh, m.bouquet_id);
  if (b.status !== "OPEN") throw conflict("This bouquet has already been concurred and can no longer change.");
  const locked = (await tx.query<typeof m & { lock_version: number; version_id: string | null }>("SELECT * FROM bouquet_members WHERE id = $1 FOR UPDATE", [memberId])).rows[0];
  return { dh, b, m: locked };
}

/** Random sample: a genuinely random included facility, preferring ones not yet inspected. */
export async function sampleMember(ctx: Ctx, bouquetId: string): Promise<{ memberId: string; applicationId: string; ref: string }> {
  return withTx(async (tx) => {
    const dh = await requireDh(tx, ctx);
    const b = await lockOwnBouquet(tx, dh, bouquetId);
    if (b.status !== "OPEN") throw conflict("This bouquet has already been concurred.");
    const rows = (await tx.query<{ id: string; application_id: string; inspected_at: Date | null }>("SELECT id, application_id, inspected_at FROM bouquet_members WHERE bouquet_id = $1 AND status = 'INCLUDED'", [bouquetId])).rows;
    if (!rows.length) throw gate("There are no included facilities to sample.");
    const pool = rows.filter((r) => !r.inspected_at);
    const from = pool.length ? pool : rows;
    const pick = from[randomInt(from.length)];
    await tx.query("UPDATE bouquet_members SET sampled = true WHERE id = $1", [pick.id]);
    const ref = (await tx.query<{ ref: string }>("SELECT ref FROM applications WHERE id = $1", [pick.application_id])).rows[0].ref;
    await audit(tx, ctx, { action: "BOUQUET_SAMPLED", actorRole: "DIVISIONAL_HEAD", applicationId: pick.application_id, details: { bouquetId, ref: b.ref, poolSize: from.length, uninspectedPool: pool.length > 0 } });
    return { memberId: pick.id, applicationId: pick.application_id, ref };
  });
}

export async function markInspected(ctx: Ctx, memberId: string, note: string) {
  return withTx(async (tx) => {
    const { b, m } = await lockMember(tx, ctx, memberId);
    if (m.status !== "INCLUDED" && m.status !== "EXCLUDED") throw conflict("This facility is no longer in the bouquet.");
    const text = (note ?? "").trim().slice(0, 1000) || null;
    await tx.query("UPDATE bouquet_members SET inspected_at = $2, inspected_by = $3, inspection_note = $4 WHERE id = $1", [memberId, ctx.now, ctx.actor!.staffId, text]);
    await audit(tx, ctx, { action: "BOUQUET_MEMBER_INSPECTED", actorRole: "DIVISIONAL_HEAD", applicationId: m.application_id, reason: text, details: { bouquetId: b.id, ref: b.ref, memberId } });
  });
}

/** Exclude a facility (mandatory reason). It never inherits the bouquet's concurrence. */
export async function excludeMember(ctx: Ctx, memberId: string, reason: string, action: ExclusionAction) {
  const why = (reason ?? "").trim();
  if (why.length < 10) throw invalid("Give the reason for excluding this facility (at least 10 characters).", { reason: "Reason required." });
  if (!["INDIVIDUAL_REVIEW", "RETURN_FOR_CORRECTION"].includes(action)) throw invalid("Choose what happens to the excluded facility.");
  return withTx(async (tx) => {
    const { b, m } = await lockMember(tx, ctx, memberId);
    if (m.status !== "INCLUDED") throw conflict("Only an included facility can be excluded.");
    await tx.query("UPDATE bouquet_members SET status = 'EXCLUDED', excluded_at = $2, excluded_by = $3, exclusion_reason = $4, exclusion_action = $5 WHERE id = $1", [memberId, ctx.now, ctx.actor!.staffId, why, action]);
    let outcome = "Held for individual Divisional Head review.";
    if (action === "RETURN_FOR_CORRECTION") {
      const app = await lockApp(tx, m.application_id);
      const task = (await tx.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [m.task_id])).rows[0];
      if (!task || task.status !== "OPEN" || task.assignee_id !== ctx.actor!.staffId || task.stage !== "DIVISIONAL_HEAD_REVIEW") throw conflict(`${app.ref} is no longer awaiting your concurrence.`);
      const actor = ctx.actor!;
      ctx.actor = { ...actor, activeRole: "DIVISIONAL_HEAD" };
      try {
        outcome = await creditCorrection(tx, ctx, app as AppRow, task, `Excluded from bouquet ${b.ref}: ${why}`);
        await persistApp(tx, app, ctx.now);
      } finally {
        ctx.actor = actor;
      }
    }
    await audit(tx, ctx, { action: "BOUQUET_MEMBER_EXCLUDED", actorRole: "DIVISIONAL_HEAD", applicationId: m.application_id, reason: why, details: { bouquetId: b.id, ref: b.ref, memberId, exclusionAction: action } });
    return { outcome };
  });
}

/** Restore an excluded facility held for individual review, before concurrence, if it is unchanged and still eligible. */
export async function restoreMember(ctx: Ctx, memberId: string) {
  return withTx(async (tx) => {
    const { dh, b, m } = await lockMember(tx, ctx, memberId);
    if (m.status !== "EXCLUDED") throw conflict("Only an excluded facility can be restored.");
    const row = (await tx.query<{ exclusion_action: string }>("SELECT exclusion_action FROM bouquet_members WHERE id = $1", [memberId])).rows[0];
    if (row.exclusion_action !== "INDIVIDUAL_REVIEW") throw conflict("A facility returned for correction cannot be restored; it will come back through the normal route.");
    const c = (await openDhTasks(tx, dh)).find((x) => x.task_id === m.task_id);
    if (!c) throw conflict("This facility is no longer awaiting your concurrence.");
    const reasons = await individualReviewReasons(tx, c, await bouquetSettings(tx));
    if (reasons.length) throw gate(`This facility now needs individual review: ${reasons.join("; ")}.`);
    await tx.query(
      "UPDATE bouquet_members SET status = 'INCLUDED', excluded_at = NULL, excluded_by = NULL, exclusion_reason = NULL, exclusion_action = NULL, lock_version = $2, version_id = $3, amount_kobo = $4 WHERE id = $1",
      [memberId, c.lock_version, c.version_id, c.amount_kobo],
    );
    await audit(tx, ctx, { action: "BOUQUET_MEMBER_RESTORED", actorRole: "DIVISIONAL_HEAD", applicationId: m.application_id, details: { bouquetId: b.id, ref: b.ref, memberId } });
  });
}

export const CONCURRENCE_ACK =
  "I concur with every facility included in this bouquet, including those I have not individually inspected. Each facility keeps its own approval record and still needs offer acceptance and disbursement controls.";

export interface ConcurInput {
  bouquetId: string;
  acknowledged: boolean;
  expectedCount: number;
  expectedTotalKobo: string;
}

/**
 * Concur with the whole bouquet: all-or-nothing. Re-running after success returns the recorded outcome (idempotent).
 */
export async function concurBouquet(ctx: Ctx, input: ConcurInput): Promise<{ ref: string; count: number; totalKobo: string; applicationIds: string[]; replayed?: boolean }> {
  if (!input.acknowledged) throw invalid("Confirm the acknowledgement before concurring.", { acknowledged: "Required." });
  const result = await withTx(async (tx) => {
    const dh = await requireDh(tx, ctx);
    const b = await lockOwnBouquet(tx, dh, input.bouquetId);
    if (b.status === "CONCURRED") {
      const r = (await tx.query<{ concurred_count: number; concurred_total_kobo: string }>("SELECT concurred_count, concurred_total_kobo::text FROM bouquets WHERE id = $1", [b.id])).rows[0];
      const ids = (await tx.query<{ application_id: string }>("SELECT application_id FROM bouquet_members WHERE bouquet_id = $1 AND status = 'CONCURRED'", [b.id])).rows.map((x) => x.application_id);
      return { ref: b.ref, count: r.concurred_count, totalKobo: r.concurred_total_kobo, applicationIds: ids, replayed: true };
    }
    if (b.status !== "OPEN") throw conflict("This bouquet is closed.");
    const s = await bouquetSettings(tx);
    if (!s.eligible_products.length) throw gate("No product is currently eligible for bouquet concurrence.");
    const members = (
      await tx.query<{ id: string; application_id: string; task_id: string; version_id: string | null; lock_version: number; amount_kobo: string; inspected_at: Date | null }>(
        "SELECT id, application_id, task_id, version_id, lock_version, amount_kobo::text, inspected_at FROM bouquet_members WHERE bouquet_id = $1 AND status = 'INCLUDED' ORDER BY application_id FOR UPDATE",
        [b.id],
      )
    ).rows;
    if (!members.length) throw gate("There are no included facilities to concur with.");
    const total = members.reduce((t, m) => t + BigInt(m.amount_kobo), 0n);
    if (members.length !== input.expectedCount || total.toString() !== input.expectedTotalKobo) {
      throw conflict("The bouquet changed since you opened it. Review the updated totals before concurring.");
    }
    const inspected = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM bouquet_members WHERE bouquet_id = $1 AND inspected_at IS NOT NULL AND status IN ('INCLUDED','EXCLUDED')", [b.id])).rows[0].n;
    if (inspected < s.min_inspections) throw gate(`Inspect at least ${s.min_inspections} facilit${s.min_inspections === 1 ? "y" : "ies"} before concurring (inspected so far: ${inspected}). Use Random sample.`);
    if (s.max_total_kobo && total > BigInt(s.max_total_kobo)) throw gate(`The bouquet total ${formatKobo(Number(total))} is above the configured aggregate limit of ${formatKobo(Number(s.max_total_kobo))}. Exclude facilities or concur individually.`);
    if (members.length > s.max_size) throw gate(`The bouquet holds more than the maximum ${s.max_size} facilities.`);

    // Lock and re-check every facility before changing any of them.
    const problems: string[] = [];
    const locked: { m: (typeof members)[number]; app: AppRow; task: TaskRow }[] = [];
    for (const m of members) {
      const app = await lockApp(tx, m.application_id);
      const task = (await tx.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [m.task_id])).rows[0];
      const label = app.ref;
      if (!task || task.status !== "OPEN" || task.stage !== "DIVISIONAL_HEAD_REVIEW") problems.push(`${label}: no longer awaiting concurrence`);
      else if (task.assignee_id !== dh) problems.push(`${label}: assigned to someone else`);
      else if (app.lock_version !== m.lock_version || task.version_id !== m.version_id) problems.push(`${label}: changed since it was added (refresh the bouquet and review it)`);
      else {
        const reasons = await individualReviewReasons(tx, { ...m, ref: app.ref, customer_name: app.customer_name, product_code: app.product_code, product_label: app.product_label, assigned_at: task.assigned_at ?? task.entered_at, submitted_at: app.submitted_at, workflow: app.workflow }, s);
        if (reasons.length) problems.push(`${label}: now needs individual review (${reasons.join("; ")})`);
      }
      locked.push({ m, app, task });
    }
    if (problems.length) throw conflict(`Nothing was concurred. ${problems.join(". ")}.`);

    const ids: string[] = [];
    for (const { m, app, task } of locked) {
      await concurAsDivisionalHead(tx, ctx, app, task, `Concurred in facility bouquet ${b.ref}`, { bouquetId: b.id, ref: b.ref, inspected: !!m.inspected_at, members: members.length, totalKobo: total.toString() });
      await tx.query("UPDATE bouquet_members SET status = 'CONCURRED', concurred_at = $2 WHERE id = $1", [m.id, ctx.now]);
      ids.push(app.id);
      if (app.initiator_id) {
        await notify(tx, ctx.now, {
          recipientId: app.initiator_id,
          kind: "BOUQUET_CONCURRED",
          title: `${app.ref} approved by the Divisional Head`,
          body: `Concurred in bouquet ${b.ref}. Prepare the offer letter for ${app.customer_name ?? app.ref}.`,
          applicationId: app.id,
          link: `/requests/${app.id}`,
          dedupeKey: `bouquet-concurred:${app.id}:${b.id}`,
        });
      }
    }
    await tx.query("UPDATE bouquets SET status = 'CONCURRED', concurred_at = $2, concurred_count = $3, concurred_total_kobo = $4, acknowledgement = $5, updated_at = $2 WHERE id = $1", [b.id, ctx.now, ids.length, total.toString(), CONCURRENCE_ACK]);
    const excluded = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM bouquet_members WHERE bouquet_id = $1 AND status = 'EXCLUDED'", [b.id])).rows[0].n;
    await audit(tx, ctx, {
      action: "BOUQUET_CONCURRED",
      actorRole: "DIVISIONAL_HEAD",
      reason: CONCURRENCE_ACK,
      details: { bouquetId: b.id, ref: b.ref, count: ids.length, totalKobo: total.toString(), inspected, excluded, applicationIds: ids },
    });
    return { ref: b.ref, count: ids.length, totalKobo: total.toString(), applicationIds: ids };
  });
  // Closing documents are prepared after the commit (the worker retries), as for an individual approval.
  if (!result.replayed && process.env.APP_ENV !== "test") {
    const { generateClosingDocuments } = await import("./closing-docs");
    for (const id of result.applicationIds) void generateClosingDocuments(id, ctx.now).catch((e) => console.error("[closing-docs]", e));
    void import("./invoice-confirmation").then(async (m) => {
      for (const id of result.applicationIds) await m.dispatchForApplication(id, ctx.now).catch((e) => console.error("[invoice-confirmation]", e));
    });
  }
  return result;
}

/** Divisional Head dashboard figures (records only). */
export async function dhFigures(q: Db, dhId: string) {
  const r = (
    await q.query<{ n: number; kobo: string; oldest: Date | null }>(
      `SELECT count(*)::int AS n, coalesce(sum(a.requested_amount_kobo), 0)::text AS kobo, min(t.assigned_at) AS oldest
         FROM tasks t JOIN applications a ON a.id = t.application_id
        WHERE t.status = 'OPEN' AND t.stage = 'DIVISIONAL_HEAD_REVIEW' AND t.assignee_id = $1`,
      [dhId],
    )
  ).rows[0];
  const open = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM bouquets WHERE divisional_head_id = $1 AND status = 'OPEN'", [dhId])).rows[0].n;
  const recent = (
    await q.query<{ ref: string; concurred_at: Date; concurred_count: number; concurred_total_kobo: string; id: string }>(
      "SELECT id, ref, concurred_at, concurred_count, concurred_total_kobo::text FROM bouquets WHERE divisional_head_id = $1 AND status = 'CONCURRED' ORDER BY concurred_at DESC LIMIT 5",
      [dhId],
    )
  ).rows;
  return { awaiting: r.n, awaitingKobo: r.kobo, oldest: r.oldest, openBouquets: open, recent };
}
