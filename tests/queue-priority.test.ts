import { describe, expect, it } from "vitest";
import { PRIORITY_ORDER, queuePriority } from "@/server/domain/queue-priority";

const now = new Date("2026-11-23T12:00:00Z");
const row = (o: Partial<Parameters<typeof queuePriority>[0]> & { hoursAgo: number }) => ({
  stage: "FIRST_CREDIT_REVIEW" as never,
  application_id: "a1",
  suspended: false,
  photo_skipped: false,
  assigned_at: new Date(now.getTime() - o.hoursAgo * 3600_000),
  ...o,
});
const overdueAfter = (h: number) => (a: Date) => now.getTime() - a.getTime() >= h * 3600_000;

describe("Action queue priority", () => {
  it("puts every task in exactly one group, most pressing first", () => {
    const none = new Set<string>();
    expect(queuePriority(row({ hoursAgo: 5 }), now, overdueAfter(3), none)).toBe("OVERDUE");
    expect(queuePriority(row({ hoursAgo: 1, photo_skipped: true }), now, overdueAfter(3), none)).toBe("URGENT");
    expect(queuePriority(row({ hoursAgo: 1 }), now, overdueAfter(3), new Set(["a1"]))).toBe("URGENT"); // credit score exception
    expect(queuePriority(row({ hoursAgo: 1, stage: "INITIATOR_CORRECTION" as never }), now, overdueAfter(3), none)).toBe("RETURNED");
    expect(queuePriority(row({ hoursAgo: 1 }), now, overdueAfter(3), none)).toBe("NEW");
    expect(queuePriority(row({ hoursAgo: 30 }), now, () => false, none)).toBe("OTHER");
    // Overdue outranks every flag.
    expect(queuePriority(row({ hoursAgo: 5, suspended: true, stage: "INITIATOR_CORRECTION" as never }), now, overdueAfter(3), none)).toBe("OVERDUE");
    expect(PRIORITY_ORDER).toEqual(["OVERDUE", "URGENT", "RETURNED", "NEW", "OTHER"]);
  });
});
