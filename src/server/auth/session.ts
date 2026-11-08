import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx, Actor } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { hmac, randomToken } from "../crypto";
import { forbidden } from "../errors";
import { activeRoles } from "../domain/access";
import { INITIATOR_ROLES, type Role } from "../domain/roles";

export const SESSION_COOKIE = "wb_session";

export interface SessionInfo {
  sessionId: string;
  staffId: string;
  email: string;
  fullName: string;
  activeRole: Role | null;
  roles: { role: Role; region: string | null; business_unit: string | null }[];
  lastActivityAt: Date;
  idleExpiresAt: Date;
}

export type SessionLookup = { status: "ok"; session: SessionInfo } | { status: "expired"; reason: string } | { status: "none" };

const tokenHash = (t: string) => hmac(`session:${t}`);

/** Pick the workspace: the requested role if the user holds it, else an initiator role, else the first held role. */
export function pickWorkspace(held: Role[], requested: string | null): Role | null {
  if (requested && held.includes(requested as Role)) return requested as Role;
  return (held.find((r) => (INITIATOR_ROLES as readonly string[]).includes(r)) as Role | undefined) ?? held[0] ?? null;
}

export async function createSession(tx: Tx, ctx: Ctx, staffId: string, preferredRole: string | null) {
  const roles = (await activeRoles(tx, staffId)).map((r) => r.role);
  if (!roles.length) throw forbidden("No active role assignments.");
  const activeRole = pickWorkspace(roles, preferredRole);
  const token = randomToken(32);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, staff_id, active_role, created_at, last_activity_at, absolute_expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7) RETURNING id`,
    [tokenHash(token), staffId, activeRole, ctx.now, new Date(ctx.now.getTime() + config.sessionAbsoluteHours * 3600_000), ctx.ip, ctx.userAgent?.slice(0, 512) ?? null],
  );
  return { token, sessionId: r.rows[0].id, activeRole };
}

/**
 * Validate a session server-side. The five-minute inactivity timeout applies to every user.
 * `touch` is true only for user-initiated requests; background polling passes false so it never
 * extends the session. An idle session is revoked (and audited) on first observation.
 */
export async function lookupSession(token: string | undefined | null, ctx: Ctx, opts: { touch: boolean }): Promise<SessionLookup> {
  if (!token) return { status: "none" };
  const s = (
    await db.query<{
      id: string; staff_id: string; active_role: Role | null; last_activity_at: Date; absolute_expires_at: Date; revoked_at: Date | null; revoke_reason: string | null;
      email: string; full_name: string; status: string;
    }>(
      `SELECT se.*, st.email, st.full_name, st.status FROM sessions se JOIN staff st ON st.id = se.staff_id WHERE se.token_hash = $1`,
      [tokenHash(token)],
    )
  ).rows[0];
  if (!s) return { status: "none" };
  if (s.revoked_at) return { status: "expired", reason: s.revoke_reason ?? "REVOKED" };
  const idleMs = config.sessionIdleSeconds * 1000;
  const actor: Actor = { staffId: s.staff_id, email: s.email, name: s.full_name, sessionId: s.id, activeRole: s.active_role };
  let reason: string | null = null;
  if (s.status !== "ACTIVE") reason = "STAFF_SUSPENDED";
  else if (ctx.now.getTime() - new Date(s.last_activity_at).getTime() >= idleMs) reason = "IDLE_TIMEOUT";
  else if (ctx.now >= new Date(s.absolute_expires_at)) reason = "ABSOLUTE_TIMEOUT";
  if (reason) {
    await revokeSession(db, { ...ctx, actor }, s.id, reason, reason === "IDLE_TIMEOUT" ? "SESSION_TIMEOUT" : "SESSION_EXPIRED");
    return { status: "expired", reason };
  }
  const roles = await activeRoles(db, s.staff_id);
  if (!roles.length) {
    await revokeSession(db, { ...ctx, actor }, s.id, "NO_ACTIVE_ROLES", "SESSION_EXPIRED");
    return { status: "expired", reason: "NO_ACTIVE_ROLES" };
  }
  let activeRole = s.active_role;
  if (!activeRole || !roles.some((r) => r.role === activeRole)) {
    activeRole = pickWorkspace(roles.map((r) => r.role), null);
    await db.query("UPDATE sessions SET active_role = $2 WHERE id = $1", [s.id, activeRole]);
  }
  let last = new Date(s.last_activity_at);
  if (opts.touch) {
    // Guarded update so a concurrent idle revocation always wins.
    await db.query("UPDATE sessions SET last_activity_at = $2 WHERE id = $1 AND revoked_at IS NULL", [s.id, ctx.now]);
    last = ctx.now;
  }
  return {
    status: "ok",
    session: {
      sessionId: s.id,
      staffId: s.staff_id,
      email: s.email,
      fullName: s.full_name,
      activeRole,
      roles,
      lastActivityAt: last,
      idleExpiresAt: new Date(last.getTime() + idleMs),
    },
  };
}

export async function revokeSession(q: Db, ctx: Ctx, sessionId: string, reason: string, auditAction: string) {
  const r = await q.query("UPDATE sessions SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL", [sessionId, ctx.now, reason]);
  if (r.rowCount) await audit(q, ctx, { action: auditAction, reason });
}

export async function switchWorkspace(ctx: Ctx, sessionId: string, role: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const held = (await activeRoles(db, actor.staffId)).map((r) => r.role);
  if (!held.includes(role as Role)) {
    await auditOutsideTx(ctx, { action: "WORKSPACE_SWITCH", outcome: "DENIED", details: { to: role } });
    throw forbidden("You do not hold that role.");
  }
  return withTx(async (tx) => {
    await tx.query("UPDATE sessions SET active_role = $2 WHERE id = $1 AND staff_id = $3", [sessionId, role, actor.staffId]);
    await audit(tx, ctx, { action: "WORKSPACE_SWITCH", actorRole: role, details: { from: actor.activeRole ?? null, to: role } });
  });
}

/** Revoke every live session for a staff member (suspension, role changes). */
export async function revokeAllSessions(q: Db, ctx: Ctx, staffId: string, reason: string) {
  await q.query("UPDATE sessions SET revoked_at = $2, revoke_reason = $3 WHERE staff_id = $1 AND revoked_at IS NULL", [staffId, ctx.now, reason]);
}
