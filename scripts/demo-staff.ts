import { loadEnv } from "./load-env";
loadEnv();
import { db, closePool } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedReferenceData } from "../src/server/demo/seed";
import { ctxFor } from "../src/server/demo/scenario";
import { STAFF, approveStaffTemplate, submittedStaffRequest, pmForward, unitHeadApprove, divisionalApprove, returnSignedOffer, disburse, reqRow } from "../src/server/demo/staff-scenario";
import { createStaffDraft, claimPmReview, pmDecision } from "../src/server/staff/requests";
import { expireStaffOffers } from "../src/server/staff/offer";
import { confirmHandoverReceipt } from "../src/server/staff/pipeline";

/**
 * Synthetic Staff Personal Financing requests at every stage, on the development database (no reset).
 * The staff offer template is approved here ONLY for the synthetic demo; in production the bank loads
 * and approves its own Legal and Shariah wording first.
 */
async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Refusing to run in production.");
  await migrate(process.env.DATABASE_URL!);
  await seedReferenceData(db);
  await approveStaffTemplate();
  const H = 3600_000;
  const now = Date.now();
  const at = (h: number) => new Date(now + h * H);
  const out: [string, string][] = [];
  const log = async (label: string, id: string) => out.push([label, `${(await reqRow(id)).ref} ${(await reqRow(id)).status}`]);

  await log("Draft", (await createStaffDraft(await ctxFor(STAFF.applicant))).id);
  await log("Submitted", await submittedStaffRequest({ amount: "750,000" }));
  const pm = await submittedStaffRequest({ amount: "1,200,000", email: "co1@altbank.ng" });
  await claimPmReview(await ctxFor(STAFF.pm), pm);
  await log("Under PM review", pm);
  const uh = await submittedStaffRequest({ amount: "2,000,000", email: "mo.lead@altbank.ng" });
  await pmForward(uh);
  await log("Under Unit Head review", uh);
  const dh = await submittedStaffRequest({ amount: "3,500,000", email: "rbe.lagos@altbank.ng" });
  await pmForward(dh);
  await unitHeadApprove(dh);
  await log("Under Divisional Head review", dh);
  const offer = await submittedStaffRequest({ amount: "1,000,000" });
  await pmForward(offer);
  await unitHeadApprove(offer);
  await divisionalApprove(offer, at(-3));
  await log("Awaiting signed offer", offer);
  const assigned = await submittedStaffRequest({ amount: "1,800,000", email: "rm.bola@altbank.ng" });
  await pmForward(assigned);
  await unitHeadApprove(assigned);
  await divisionalApprove(assigned);
  await returnSignedOffer(assigned, new Date(), "rm.bola@altbank.ng");
  await log("Assigned for disbursement", assigned);
  const done = await submittedStaffRequest({ amount: "2,500,000", email: "anm.south@altbank.ng" });
  await pmForward(done);
  await unitHeadApprove(done);
  await divisionalApprove(done);
  const { submitSignedOffer } = await import("../src/server/staff/offer");
  const { uploadStaffDocument } = await import("../src/server/staff/documents");
  const { makePdf } = await import("../src/server/demo/scenario");
  const anm = await ctxFor("anm.south@altbank.ng");
  const { id: sdoc } = await uploadStaffDocument(anm, { requestId: done, category: "SIGNED_OFFER", filename: "signed-offer.pdf", data: makePdf("Signed") });
  await submitSignedOffer(anm, done, { documentId: sdoc, confirmed: true, lockVersion: (await reqRow(done)).lock_version });
  await disburse(done);
  await confirmHandoverReceipt(await ctxFor(STAFF.legal), done, "LEGAL");
  await log("Completed (documentation with Legal and Shariah)", done);
  const expired = await submittedStaffRequest({ amount: "500,000", email: "anm.north@altbank.ng" });
  await pmForward(expired);
  await unitHeadApprove(expired);
  await divisionalApprove(expired, at(-30));
  await expireStaffOffers(new Date());
  await log("Expired offer", expired);
  const declined = await submittedStaffRequest({ amount: "9,000,000", email: "tl.lagos@altbank.ng" });
  const pmc = await ctxFor(STAFF.pm);
  await claimPmReview(pmc, declined);
  await pmDecision(pmc, declined, { action: "DECLINE", checklist: { accountVerified: true, salaryHistoryReviewed: true, repaymentWithinLimit: false }, comments: "Repayment would exceed 50% of take-home pay.", lockVersion: (await reqRow(declined)).lock_version });
  await log("Declined", declined);
  const returned = await submittedStaffRequest({ amount: "650,000", email: "tl.abuja@altbank.ng" });
  await claimPmReview(pmc, returned);
  await pmDecision(pmc, returned, { action: "RETURN", checklist: { accountVerified: true, salaryHistoryReviewed: false, repaymentWithinLimit: false }, comments: "Upload payslips for the last three months.", lockVersion: (await reqRow(returned)).lock_version });
  await log("Returned for correction", returned);
  console.table(out);
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
