import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { applyConfig, syntheticConfig, createRetailCase, driveBusinessReview, driveCredit, approveRetailTemplates, driveToBooking, payAndReconcile, completeAll } from "@/server/demo/retail-scenario";
import { openTaskOf } from "@/server/demo/scenario";

beforeEach(async () => {
  await resetDb();
});

describe("smoke", () => {
  it("VF RM end to end", async () => {
    await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
    await approveRetailTemplates();
    const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: 1_000_000_000, tenorMonths: 12, incomeBasisKobo: 1_000_000_000, proposedMonthlyKobo: 100_000_000 });
    expect((await openTaskOf(id)).stage).toBe("TEAM_LEAD_REVIEW");
    await driveBusinessReview(id);
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
    await driveCredit(id);
    expect((await openTaskOf(id)).stage).toBe("OFFER_PREPARATION");
    await driveToBooking(id);
    expect((await openTaskOf(id)).stage).toBe("PAYMENT_RECONCILIATION");
    await payAndReconcile(id);
    await completeAll(id);
    const app = (await db.query("SELECT stage, status FROM applications WHERE id = $1", [id])).rows[0];
    expect(app).toEqual({ stage: "COMPLETED", status: "COMPLETED" });
  });
});
