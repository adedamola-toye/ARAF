import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { DomainError, forbidden, invalid } from "../errors";
import { holdsRole } from "./access";

/** Second signatory printed on Individual / Enterprise offer letters (e.g. Head, Payment & Collection). */
export async function currentSecondSignatory(q: Db): Promise<{ id: string; version: number; name: string; title: string }> {
  const r = (await q.query("SELECT * FROM offer_signatory_settings ORDER BY version DESC LIMIT 1")).rows[0];
  return r ?? { id: "", version: 0, name: "", title: "Head, Payment & Collection" };
}

export async function signatoryHistory(q: Db) {
  return (await q.query("SELECT o.*, s.full_name AS created_by_name FROM offer_signatory_settings o LEFT JOIN staff s ON s.id = o.created_by ORDER BY version DESC")).rows;
}

/** Super Admin sets the second signatory. Applies to letters generated afterwards; generated letters are frozen. */
export async function updateSecondSignatory(ctx: Ctx, p: { name: string; title: string; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  try {
    return await withTx(async (tx) => {
      if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the Super Admin can change the offer letter signatory.");
      const name = p.name.trim();
      const title = p.title.trim();
      const errors: Record<string, string> = {};
      if (name.length < 3 || name.length > 120) errors.name = "Enter the signatory's full name.";
      if (title.length < 2 || title.length > 120) errors.title = "Enter the signatory's title.";
      if (p.reason.trim().length < 5) errors.reason = "Give a reason for the change.";
      if (Object.keys(errors).length) throw invalid("Check the signatory details.", errors);
      const prev = await currentSecondSignatory(tx);
      const r = await tx.query(
        "INSERT INTO offer_signatory_settings (version, name, title, reason, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [prev.version + 1, name, title, p.reason.trim(), actor.staffId, ctx.now],
      );
      await audit(tx, ctx, {
        action: "OFFER_SIGNATORY_CHANGED",
        actorRole: "SUPER_ADMIN",
        reason: p.reason.trim(),
        details: { old: { version: prev.version, name: prev.name, title: prev.title }, new: { version: prev.version + 1, name, title } },
      });
      return r.rows[0];
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action: "OFFER_SIGNATORY_CHANGED", outcome: "DENIED", reason: e.message });
    throw e;
  }
}
