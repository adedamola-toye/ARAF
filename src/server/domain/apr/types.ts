/**
 * APR / DSR calculator contract.
 *
 * The bank's APR workbook was NOT available when this system was built. The production
 * calculator must be implemented against that workbook as a new versioned calculator and
 * validated with fixture tests generated from the workbook (see tests/fixtures/apr/README.md).
 * Until a calculator with `productionValidated: true` is configured, credit approval is blocked
 * when APP_ENV=production.
 */
export interface CalculatorField {
  key: string;
  label: string;
  kind: "money" | "percent" | "integer";
  help?: string;
  /** Default taken from the application, when available. */
  defaultFrom?: "assetCost" | "tenorMonths" | "requestedAmount";
}

export interface CalculatorResult {
  aprPercent: string; // fixed 4dp string
  dsrPercent: string; // fixed 4dp string
  markupKobo: number;
  costPlusMarkupKobo: number;
  /** Additional named outputs shown to every reviewer. */
  outputs: Record<string, string | number>;
}

export interface AprCalculator {
  id: string;
  version: string;
  label: string;
  productionValidated: boolean;
  fields: CalculatorField[];
  /** Pure, deterministic calculation. Money inputs are integer kobo; percent inputs are strings. */
  calculate(inputs: Record<string, string | number>): CalculatorResult;
}
