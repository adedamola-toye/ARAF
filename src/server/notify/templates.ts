import { config } from "../config";
import { formatKobo } from "../money";
import { formatLagos } from "../time";
import { STAGE_LABELS, REQUIRED_ACTION, type Stage } from "../domain/stages";

/** Notifications never include BVN/TIN values. */
export interface AssessmentSummary {
  aprPercent: string;
  dsrPercent: string;
  pricing?: {
    turnoverUsedKobo: number;
    turnoverBasis: string;
    monthlyRepaymentKobo: number;
    totalDsrPercent: string;
    thresholdPercent: string;
    result: string;
    excessKobo: number;
    flatMarkupRatePercent: string;
    tenorMonths: number;
    explanation: string;
    repaymentFrequency?: string;
    instalmentKobo?: number;
    dsrException?: string | null;
  };
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
  const a = p.assessment;
  const assessmentLines = !a
    ? ["Assessment: pending (turnover, monthly repayment, DSR and APR will follow the first credit review)", "APR: assessment pending", "DSR: assessment pending"]
    : a.pricing
      ? [
          `Assessed monthly turnover: ${formatKobo(a.pricing.turnoverUsedKobo)} (${a.pricing.turnoverBasis === "VERIFIED_MONTHLY" ? "verified monthly figure" : "annual turnover ÷ 12"})`,
          `Proposed monthly repayment: ${formatKobo(a.pricing.monthlyRepaymentKobo)}${a.pricing.repaymentFrequency === "WEEKLY" ? ` (monthly equivalent of weekly instalments of ${formatKobo(a.pricing.instalmentKobo ?? 0)})` : ""} (flat markup ${a.pricing.flatMarkupRatePercent}% over ${a.pricing.tenorMonths} months)`,
          `DSR: ${a.pricing.totalDsrPercent}% against the ${a.pricing.thresholdPercent}% threshold - ${a.pricing.result === "EXCEEDS_THRESHOLD" ? `EXCEEDS THRESHOLD by ${formatKobo(a.pricing.excessKobo)} per month (flagged for review)` : "within threshold"}`,
          ...(a.pricing.dsrException ? [`DSR exception approved at first credit review: ${a.pricing.dsrException}`] : []),
          `APR (disclosure): ${a.aprPercent}%`,
          a.pricing.explanation,
        ]
      : [`APR: ${a.aprPercent}%`, `DSR: ${a.dsrPercent}%`];
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
