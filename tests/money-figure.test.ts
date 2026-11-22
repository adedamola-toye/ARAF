import { describe, expect, it } from "vitest";
import { moneyParts, moneyText } from "@/components/Money";

describe("Money figure formatting (integer kobo, no floating point)", () => {
  it("formats naira with thousands separators and two kobo digits", () => {
    expect(moneyText(239583333)).toBe("₦2,395,833.33");
    expect(moneyText("95000000")).toBe("₦950,000.00");
    expect(moneyText(0)).toBe("₦0.00");
    expect(moneyText(-100000)).toBe("-₦1,000.00");
    expect(moneyText(null)).toBe("—");
    expect(moneyText("not a number")).toBe("—");
  });
  it("keeps exact values far beyond floating-point precision", () => {
    expect(moneyText(12345678901234567890n)).toBe("₦123,456,789,012,345,678.90");
    expect(moneyParts("900719925474099312")).toEqual({ negative: false, naira: "9,007,199,254,740,993", kobo: "12" });
  });
});
