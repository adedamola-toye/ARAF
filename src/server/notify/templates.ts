import { config } from "../config";
import { formatKobo } from "../money";
import { formatLagos } from "../time";
import { STAGE_LABELS, REQUIRED_ACTION, type Stage } from "../domain/stages";

/** Notifications never include BVN/TIN values. */
export interface AssessmentSummary {
  aprPercent: string;
  dsrPercent: string;
}

export function caseLink(applicationId: string, taskId?: string) {
  return `${config.appUrl}/requests/${applicationId}${taskId ? `?task=${taskId}` : ""}`;
}

export function assignmentEmail(p: {
  ref: string;
  applicationId: string;
  taskId: string;
  stage: Stage;
  customerName: string;
  amountKobo: number | null;
  assessment: AssessmentSummary | null;
  assignedAt: Date;
}) {
  const assessmentLines = p.assessment
    ? [`APR: ${p.assessment.aprPercent}%`, `DSR: ${p.assessment.dsrPercent}%`]
    : ["APR: assessment pending", "DSR: assessment pending"];
  return {
    subject: `WakeelBoost ${p.ref}: ${STAGE_LABELS[p.stage]} assigned to you`,
    text: [
      "WakeelBoost Work Desk",
      "",
      `A request has been assigned to you for: ${STAGE_LABELS[p.stage]}.`,
      "",
      `Request ID: ${p.ref}`,
      `Customer: ${p.customerName}`,
      `Requested amount: ${formatKobo(p.amountKobo)}`,
      ...assessmentLines,
      `Assigned: ${formatLagos(p.assignedAt)}`,
      `Required action: ${REQUIRED_ACTION[p.stage]}`,
      "",
      `Open the case (sign-in required): ${caseLink(p.applicationId, p.taskId)}`,
      "",
      "Powered by DKTA Technologies @2026",
    ].join("\n"),
  };
}

export function simpleEmail(lines: string[]) {
  return ["WakeelBoost Work Desk", "", ...lines, "", "Powered by DKTA Technologies @2026"].join("\n");
}
