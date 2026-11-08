import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { invalid, forbidden, notFound } from "../errors";
import { activeCalculator, calculatorKey } from "./apr/registry";
import { parseNairaToKobo, parsePercentE4 } from "../money";

export interface AssessmentRow {
  id: string;
  application_id: string;
  version_id: string;
  calculator_id: string;
  calculator_version: string;
  production_validated: boolean;
  inputs: Record<string, string | number>;
  outputs: Record<string, string | number>;
  apr_percent: string;
  dsr_percent: string;
  markup_kobo: string;
  cost_plus_markup_kobo: string;
  assessor_id: string;
  assessor_name?: string;
  started_at: Date;
  created_at: Date;
  superseded_at: Date | null;
}

export async function latestAssessment(q: Db, appId: string): Promise<AssessmentRow | null> {
  const r = await q.query<AssessmentRow>(
    `SELECT a.*, s.full_name AS assessor_name FROM credit_assessments a JOIN staff s ON s.id = a.assessor_id
      WHERE a.application_id = $1 AND a.superseded_at IS NULL ORDER BY a.created_at DESC LIMIT 1`,
    [appId],
  );
  return r.rows[0] ?? null;
}

/** Convert form strings into calculator inputs according to the calculator's field kinds. */
export function parseCalculatorForm(raw: Record<string, string>): Record<string, string | number> {
  const calc = activeCalculator();
  const out: Record<string, string | number> = {};
  const errors: Record<string, string> = {};
  for (const f of calc.fields) {
    const v = (raw[f.key] ?? "").trim();
    if (f.kind === "select") {
      if (!f.options?.some((o) => o.value === v)) errors[f.key] = `${f.label}: choose an option.`;
      else out[f.key] = v;
    } else if (f.kind === "money") {
      const k = v === "" ? 0 : parseNairaToKobo(v);
      if (k === null) errors[f.key] = `${f.label}: enter a naira amount.`;
      else out[f.key] = k;
    } else if (f.kind === "percent") {
      if (parsePercentE4(v) === null) errors[f.key] = `${f.label}: enter a percentage (up to 4 decimal places).`;
      else out[f.key] = v;
    } else {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n)) errors[f.key] = `${f.label}: enter a whole number.`;
      else out[f.key] = n;
    }
  }
  if (Object.keys(errors).length) throw invalid("Check the assessment inputs.", errors);
  return out;
}

/**
 * Record an APR/DSR assessment. Only the assigned first credit reviewer may assess, while the
 * case is at first credit review or credit correction. Previous assessments are superseded.
 */
export async function recordAssessment(ctx: Ctx, appId: string, inputs: Record<string, string | number>, startedAt?: Date) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx: Tx) => {
    const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    if (!app) throw notFound();
    const task = (
      await tx.query(
        `SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN' AND stage IN ('FIRST_CREDIT_REVIEW','CREDIT_CORRECTION')`,
        [appId],
      )
    ).rows[0];
    if (!task || task.assignee_id !== actor.staffId || app.first_reviewer_id !== actor.staffId) {
      throw forbidden("Only the assigned first credit reviewer can complete the APR assessment.");
    }
    const held = await tx.query("SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = $2 AND active", [actor.staffId, task.assignee_role]);
    if (!held.rowCount) throw forbidden("Your role assignment for this task is no longer active.");
    const calc = activeCalculator();
    const result = calc.calculate(inputs);
    await tx.query("UPDATE credit_assessments SET superseded_at = $2 WHERE application_id = $1 AND superseded_at IS NULL", [appId, ctx.now]);
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO credit_assessments (application_id, version_id, calculator_id, calculator_version, production_validated,
         inputs, outputs, apr_percent, dsr_percent, markup_kobo, cost_plus_markup_kobo, assessor_id, started_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        appId,
        app.current_version_id,
        calc.id,
        calc.version,
        calc.productionValidated,
        JSON.stringify(inputs),
        JSON.stringify({ ...result.outputs, aprPercent: result.aprPercent, dsrPercent: result.dsrPercent, markupKobo: result.markupKobo, costPlusMarkupKobo: result.costPlusMarkupKobo }),
        result.aprPercent,
        result.dsrPercent,
        result.markupKobo,
        result.costPlusMarkupKobo,
        actor.staffId,
        startedAt ?? ctx.now,
        ctx.now,
      ],
    );
    await audit(tx, ctx, {
      action: "ASSESSMENT_RECORDED",
      actorRole: task.assignee_role,
      applicationId: appId,
      stage: task.stage,
      details: { assessmentId: ins.rows[0].id, calculator: calculatorKey(calc), apr: result.aprPercent, dsr: result.dsrPercent, versionId: app.current_version_id },
    });
    return { id: ins.rows[0].id, ...result };
  });
}
