/**
 * Server side of approval verification. `checkVerification` runs before the decision (inside its transaction)
 * and refuses a missing, outdated or incomplete acknowledgement, or one made on a version the reviewer no
 * longer has in front of them. `recordVerification` writes the append-only record in the same transaction
 * after the workflow action, so a decision can never be saved without its acknowledgement (or vice versa).
 */
import type { Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, invalid } from "../errors";
import { checklistFor, type Checklist, type VerificationInput } from "@/lib/approval-checklists";

export interface VerificationSubject {
  kind: "APPLICATION" | "ALTPHONES" | "STAFF_REQUEST";
  id: string;
  ref?: string | null;
  lockVersion: number;
  versionId?: string | null;
  stage: string;
  action: string;
  role: string;
  policy?: string | null;
  workflow?: string | null;
  taskId?: string | null;
}

export function checkVerification(s: VerificationSubject, v: VerificationInput | null | undefined): Checklist | null {
  const list = checklistFor({ kind: s.kind, stage: s.stage, action: s.action, policy: s.policy, workflow: s.workflow });
  if (!list) return null;
  if (!v) throw invalid("Complete the verification checklist before you proceed.", { verification: "Confirm every item in the checklist." });
  if (v.checklistId !== list.id || v.version !== list.version) throw conflict("The verification checklist has changed. Reload the request and confirm the current checklist.");
  if (v.viewedVersion !== s.lockVersion) throw conflict("This request changed since you opened it. Review the latest version before you proceed.");
  const want = new Set(list.items.map((i) => i.code));
  const got = new Set(v.items);
  if (got.size !== want.size || [...want].some((c) => !got.has(c))) throw invalid("Confirm every item in the checklist before you proceed.", { verification: "Every item must be confirmed." });
  return list;
}

export async function recordVerification(tx: Tx, ctx: Ctx, s: VerificationSubject, list: Checklist, outcome: string) {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO approval_verifications (subject_kind, subject_id, subject_ref, subject_version, version_id, staff_id, role, stage, decision, checklist_id, checklist_version, items, acknowledged_at, outcome, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [s.kind, s.id, s.ref ?? null, s.lockVersion, s.versionId ?? null, ctx.actor!.staffId, s.role, s.stage, s.action, list.id, list.version, JSON.stringify(list.items), ctx.now, outcome, s.taskId ?? null],
  );
  await audit(tx, ctx, {
    action: "APPROVAL_VERIFIED",
    actorRole: s.role,
    applicationId: s.kind === "APPLICATION" ? s.id : null,
    altphonesApplicationId: s.kind === "ALTPHONES" ? s.id : null,
    staffRequestId: s.kind === "STAFF_REQUEST" ? s.id : null,
    stage: s.stage,
    details: { verificationId: r.rows[0].id, checklist: list.id, checklistVersion: list.version, decision: s.action, items: list.items.map((i) => i.code), subjectVersion: s.lockVersion, versionId: s.versionId ?? null, outcome },
  } as Parameters<typeof audit>[2]);
  return r.rows[0].id;
}
