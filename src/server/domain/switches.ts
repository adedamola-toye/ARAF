/** Super Admin on/off switches (feature_switches). Reads are cheap; changes are audited. */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, notFound } from "../errors";
import { holdsRole } from "./access";

export const SWITCHES = { REPAYMENT_TRACKER: "REPAYMENT_TRACKER" } as const;
export type SwitchKey = keyof typeof SWITCHES;

export async function isEnabled(q: Db, key: SwitchKey): Promise<boolean> {
  return !!(await q.query<{ enabled: boolean }>("SELECT enabled FROM feature_switches WHERE key = $1", [key])).rows[0]?.enabled;
}

export async function setSwitch(ctx: Ctx, key: SwitchKey, enabled: boolean) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can change this setting.");
    const r = await tx.query<{ enabled: boolean }>("SELECT enabled FROM feature_switches WHERE key = $1 FOR UPDATE", [key]);
    if (!r.rows[0]) throw notFound();
    await tx.query("UPDATE feature_switches SET enabled = $2, updated_by = $3, updated_at = $4 WHERE key = $1", [key, enabled, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "FEATURE_SWITCH_CHANGED", actorRole: "SUPER_ADMIN", details: { key, before: r.rows[0].enabled, after: enabled } });
  });
}
