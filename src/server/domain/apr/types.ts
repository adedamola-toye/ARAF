/**
 * APR / DSR calculator contract.
 *
 * Calculators are versioned and validated with fixture rows generated from the bank's workbook
 * (see tests/fixtures/apr/README.md). Credit approval is blocked when APP_ENV=production unless
 * the configured calculator has `productionValidated: true`.
 */
export interface CalculatorField {
  key: string;
  label: string;
  kind: "money" | "percent" | "integer" | "select";
  help?: string;
  /** For kind "select". */
  options?: { value: string; label: string }[];
  /** Default when nothing is taken from the application. */
  defaultValue?: string;
  /** Optional fields may be left blank (money defaults to 0). */
  optional?: boolean;
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
  /** Shown to reviewers next to the calculator name (e.g. what still needs bank confirmation). */
  validationNote?: string;
  fields: CalculatorField[];
  /** Pure, deterministic calculation. Money inputs are integer kobo; percent inputs are strings. */
  calculate(inputs: Record<string, string | number>): CalculatorResult;
}
