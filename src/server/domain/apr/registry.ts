import type { AprCalculator } from "./types";
import { devIllustrativeCalculator } from "./dev-illustrative";
import { altbankApr2024Calculator } from "./altbank-2024";
import { config } from "../../config";

/** Registered calculators. altbank-apr-2024 implements the bank workbook; dev-illustrative is kept for history. */
const CALCULATORS: AprCalculator[] = [altbankApr2024Calculator, devIllustrativeCalculator];

export function calculatorKey(c: AprCalculator) {
  return `${c.id}@${c.version}`;
}
export function findCalculator(key: string): AprCalculator | null {
  return CALCULATORS.find((c) => calculatorKey(c) === key) ?? null;
}
export function activeCalculator(): AprCalculator {
  const c = findCalculator(config.aprCalculator);
  if (!c) throw new Error(`APR_CALCULATOR "${config.aprCalculator}" is not registered`);
  return c;
}
/** True when the configured calculator may be used to approve credit in this environment. */
export function calculatorUsableForApproval(c: AprCalculator): boolean {
  return c.productionValidated || !config.isProduction;
}
export function listCalculators() {
  return CALCULATORS;
}
