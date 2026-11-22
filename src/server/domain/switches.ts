/** Super Admin on/off switches (feature_switches). Reads are cheap; changes are audited. */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";

export const SWITCHES = { REPAYMENT_TRACKER: "REPAYMENT_TRACKER", VF_TL_PHOTO_REVIEW: "VF_TL_PHOTO_REVIEW", BOUQUET_APPROVALS: "BOUQUET_APPROVALS" } as const;
export type SwitchKey = keyof typeof SWITCHES;

export async function isEnabled(q: Db, key: SwitchKey): Promise<boolean> {
  return !!(await q.query<{ enabled: boolean }>("SELECT enabled FROM feature_switches WHERE key = $1", [key])).rows[0]?.enabled;
}

export async function setSwitch(ctx: Ctx, key: SwitchKey, enabled: boolean, reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can change this setting.");
    const why = (reason ?? "").trim();
    if (why.length < 5) throw invalid("Give the reason for the change.", { reason: "Reason required." });
    const r = await tx.query<{ enabled: boolean }>("SELECT enabled FROM feature_switches WHERE key = $1 FOR UPDATE", [key]);
    if (!r.rows[0]) throw notFound();
    await tx.query("UPDATE feature_switches SET enabled = $2, updated_by = $3, updated_at = $4 WHERE key = $1", [key, enabled, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "FEATURE_SWITCH_CHANGED", actorRole: "SUPER_ADMIN", reason: why, details: { key, before: r.rows[0].enabled, after: enabled } });
  });
}

export async function switchState(q: Db, key: SwitchKey) {
  return (
    await q.query<{ key: string; label: string; enabled: boolean; note: string | null; updated_at: Date; updated_by_name: string | null }>(
      "SELECT f.key, f.label, f.enabled, f.note, f.updated_at, s.full_name AS updated_by_name FROM feature_switches f LEFT JOIN staff s ON s.id = f.updated_by WHERE f.key = $1",
      [key],
    )
  ).rows[0];
}

/** Change history of a switch (from the audit trail). */
export async function switchHistory(q: Db, key: SwitchKey) {
  return (
    await q.query<{ occurred_at: Date; actor: string | null; reason: string | null; before: boolean; after: boolean }>(
      `SELECT e.occurred_at, s.full_name AS actor, e.reason, (e.details->>'before')::boolean AS before, (e.details->>'after')::boolean AS after
         FROM audit_events e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.action = 'FEATURE_SWITCH_CHANGED' AND e.details->>'key' = $1 ORDER BY e.occurred_at DESC LIMIT 50`,
      [key],
    )
  ).rows;
}
