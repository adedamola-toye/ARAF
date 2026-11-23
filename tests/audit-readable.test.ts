import { describe, expect, it } from "vitest";
import { auditContext, auditLabel, redactDetails } from "@/lib/audit-events";

describe("Readable audit history", () => {
  it("labels known events and humanises unknown ones", () => {
    expect(auditLabel("TASK_APPROVE")).toEqual({ label: "Approved", category: "Decision" });
    expect(auditLabel("BOUQUET_CONCURRED").category).toBe("Bouquet");
    expect(auditLabel("TASK_SOMETHING_NEW")).toEqual({ label: "Something new", category: "Decision" });
  });
  it("shows previous and new state, transaction and bouquet references", () => {
    const lbl = (s: string) => s.toLowerCase();
    expect(auditContext({ from: "UNIT_HEAD_REVIEW", to: "DIVISIONAL_HEAD_REVIEW" }, lbl)).toEqual(["unit_head_review → divisional_head_review"]);
    expect(auditContext({ bouquet: { ref: "BQ-2026-00001" }, transactionRef: "FT123" }, lbl)).toEqual(["bouquet BQ-2026-00001", "ref FT123"]);
  });
  it("redacts secrets, salaries, account numbers and long identifiers", () => {
    const r = redactDetails({ token: "abc", accountNumber: "0123456789", salaryKobo: 190000000, phone: "08031234567", nested: { password: "x", ok: 1 }, signatory: "Jane" });
    expect(r).toEqual({ token: "[redacted]", accountNumber: "[redacted]", salaryKobo: "[redacted]", phone: "••••4567", nested: { password: "[redacted]", ok: 1 }, signatory: "Jane" });
  });
});
