import type { Role } from "./roles";
import { invalid } from "../errors";

export interface CreditRoute {
  route: 1 | 2 | 3;
  minKobo: number; // inclusive
  maxKobo: number; // inclusive
  firstReviewRoles: Role[];
  secondReviewRoles: Role[];
  label: string;
}

/**
 * Credit routing table. Boundaries are inclusive and expressed in integer kobo:
 *   Route 1: ₦1.00 – ₦5,000,000.00
 *   Route 2: ₦5,000,000.01 – ₦20,000,000.00
 *   Route 3: ₦20,000,000.01 – ₦50,000,000.00
 */
export const CREDIT_ROUTES: readonly CreditRoute[] = [
  {
    route: 1,
    minKobo: 100,
    maxKobo: 500_000_000,
    firstReviewRoles: ["CREDIT_OFFICER_1"],
    secondReviewRoles: ["CREDIT_OFFICER_2", "CREDIT_OFFICER_3"],
    label: "Route 1 (₦1 – ₦5m): CO1 → CO2/CO3",
  },
  {
    route: 2,
    minKobo: 500_000_001,
    maxKobo: 2_000_000_000,
    firstReviewRoles: ["CREDIT_OFFICER_2"],
    secondReviewRoles: ["CREDIT_LEAD_1", "CREDIT_LEAD_2", "CREDIT_OFFICER_3"],
    label: "Route 2 (above ₦5m – ₦20m): CO2 → Lead 1/Lead 2/CO3",
  },
  {
    route: 3,
    minKobo: 2_000_000_001,
    maxKobo: 5_000_000_000,
    firstReviewRoles: ["CREDIT_OFFICER_3"],
    secondReviewRoles: ["CREDIT_LEAD_1", "CREDIT_LEAD_2"],
    label: "Route 3 (above ₦20m – ₦50m): CO3 → Lead 1/Lead 2",
  },
];

export const MIN_AMOUNT_KOBO = CREDIT_ROUTES[0].minKobo;
export const MAX_AMOUNT_KOBO = CREDIT_ROUTES[CREDIT_ROUTES.length - 1].maxKobo;

export function routeForAmount(kobo: number | null | undefined): CreditRoute {
  if (kobo === null || kobo === undefined || !Number.isSafeInteger(kobo)) {
    throw invalid("Requested amount must be a whole number of kobo.", { requestedAmountKobo: "Invalid amount." });
  }
  const r = CREDIT_ROUTES.find((x) => kobo >= x.minKobo && kobo <= x.maxKobo);
  if (!r) {
    throw invalid("Requested amount must be between ₦1.00 and ₦50,000,000.00.", {
      requestedAmountKobo: "Amount is outside the WakeelBoost range (₦1 – ₦50,000,000).",
    });
  }
  return r;
}

export function getRoute(route: number | null): CreditRoute | null {
  return CREDIT_ROUTES.find((r) => r.route === route) ?? null;
}
