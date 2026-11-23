import { describe, expect, it } from "vitest";
import { availableKobo, computeStaffFinancing, eligibilityLimitKobo, presetAmounts } from "@/lib/staff-financing";

describe("Salary advance eligibility arithmetic", () => {
  it("worked example: ₦1,900,000 salary → ₦950,000 limit, ₦19,000 fee, ₦931,000 received, ₦950,000 repayable", () => {
    const limit = eligibilityLimitKobo(190_000_000, 5000);
    expect(limit).toBe(95_000_000);
    const f = computeStaffFinancing(limit, 200);
    expect(f.deductionKobo).toBe(1_900_000);
    expect(f.netKobo).toBe(93_100_000);
    expect(f.grossKobo).toBe(95_000_000); // repayable = the advance
  });
  it("rounds the limit down to the kobo and never returns a negative availability", () => {
    expect(eligibilityLimitKobo(33_333, 5000)).toBe(16_666);
    expect(availableKobo(95_000_000, 60_000_000, 50_000_000)).toBe(0);
    expect(availableKobo(95_000_000, 30_000_000, 0)).toBe(65_000_000);
  });
  it("offers presets up to the available amount", () => {
    expect(presetAmounts(95_000_000)).toEqual([23_700_000, 47_500_000, 71_200_000, 95_000_000]);
  });
});
