import type { AprCalculator } from "./types";
import { devIllustrativeCalculator } from "./dev-illustrative";
import { config } from "../../config";

/** Register the bank-validated calculator here once the APR workbook is implemented. */
const CALCULATORS: AprCalculator[] = [devIllustrativeCalculator];

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
