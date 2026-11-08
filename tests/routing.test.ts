import { describe, expect, it } from "vitest";
import { routeForAmount, MIN_AMOUNT_KOBO, MAX_AMOUNT_KOBO } from "@/server/domain/routing";
import { applyBasisPoints, formatKobo, parseNairaToKobo, parsePercentToBp } from "@/server/money";
import { allowedActions } from "@/server/domain/stages";

describe("credit routing boundaries (integer kobo)", () => {
  const cases: [string, number, number | null][] = [
    ["₦0.99 rejected", 99, null],
    ["₦0 rejected", 0, null],
    ["₦1.00 → route 1", 100, 1],
    ["₦5,000,000.00 → route 1", 500_000_000, 1],
    ["₦5,000,000.01 → route 2", 500_000_001, 2],
    ["₦20,000,000.00 → route 2", 2_000_000_000, 2],
    ["₦20,000,000.01 → route 3", 2_000_000_001, 3],
    ["₦50,000,000.00 → route 3", 5_000_000_000, 3],
    ["₦50,000,000.01 rejected", 5_000_000_001, null],
    ["negative rejected", -100, null],
  ];
  for (const [name, kobo, route] of cases) {
    it(name, () => {
      if (route === null) expect(() => routeForAmount(kobo)).toThrow(/between ₦1.00 and ₦50,000,000.00/);
      else expect(routeForAmount(kobo).route).toBe(route);
    });
  }
  it("rejects non-integer kobo", () => {
    expect(() => routeForAmount(100.5)).toThrow();
    expect(() => routeForAmount(null)).toThrow();
  });
  it("route reviewers match the routing table", () => {
    expect(routeForAmount(MIN_AMOUNT_KOBO).firstReviewRoles).toEqual(["CREDIT_OFFICER_1"]);
    expect(routeForAmount(MIN_AMOUNT_KOBO).secondReviewRoles).toEqual(["CREDIT_OFFICER_2", "CREDIT_OFFICER_3"]);
    expect(routeForAmount(1_000_000_000).firstReviewRoles).toEqual(["CREDIT_OFFICER_2"]);
    expect(routeForAmount(1_000_000_000).secondReviewRoles).toEqual(["CREDIT_LEAD_1", "CREDIT_LEAD_2", "CREDIT_OFFICER_3"]);
    expect(routeForAmount(MAX_AMOUNT_KOBO).firstReviewRoles).toEqual(["CREDIT_OFFICER_3"]);
    expect(routeForAmount(MAX_AMOUNT_KOBO).secondReviewRoles).toEqual(["CREDIT_LEAD_1", "CREDIT_LEAD_2"]);
  });
  it("Route 2 and 3 second reviews are Proceed/Reject only; Route 1 can return", () => {
    expect(allowedActions("SECOND_CREDIT_REVIEW", 1)).toEqual(["APPROVE", "REJECT", "RETURN"]);
    expect(allowedActions("SECOND_CREDIT_REVIEW", 2)).toEqual(["PROCEED", "REJECT"]);
    expect(allowedActions("SECOND_CREDIT_REVIEW", 3)).toEqual(["PROCEED", "REJECT"]);
  });
});

describe("money", () => {
  it("parses naira to exact kobo", () => {
    expect(parseNairaToKobo("5,000,000")).toBe(500_000_000);
    expect(parseNairaToKobo("₦5,000,000.01")).toBe(500_000_001);
    expect(parseNairaToKobo("0.1")).toBe(10);
    expect(parseNairaToKobo("1.234")).toBeNull();
    expect(parseNairaToKobo("abc")).toBeNull();
    expect(parseNairaToKobo("-5")).toBeNull();
  });
  it("formats kobo", () => {
    expect(formatKobo(500_000_001)).toBe("₦5,000,000.01");
    expect(formatKobo(100)).toBe("₦1.00");
  });
  it("applies basis points exactly with half-up rounding", () => {
    expect(parsePercentToBp("12.5")).toBe(1250);
    expect(applyBasisPoints(500_000_000, 1250)).toBe(62_500_000);
    expect(applyBasisPoints(3, 5000)).toBe(2); // 1.5 -> 2
    // 0.1 + 0.2 style float traps do not occur
    expect(applyBasisPoints(10, 3333)).toBe(3);
  });
});
