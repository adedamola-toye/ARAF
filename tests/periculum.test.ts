import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, makePdf, openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, driveBusinessReview, INITIATORS, passRetailCreditChecks, syntheticConfig } from "@/server/demo/retail-scenario";
import { uploadDocument } from "@/server/domain/documents";
import { submitApplication } from "@/server/domain/workflow";
import { config } from "@/server/config";
import { setPericulumFetchForTests, checkPericulumSignIn } from "@/server/integrations/periculum/client";
import { fixtureFetch, resetFixtureVendor } from "@/server/integrations/periculum/fixtures";
import { analysisStatements, currentAnalysis, handlePericulumWebhook, processStatementAnalysis, retryStatements, startStatementAnalysis, statementPayload } from "@/server/domain/statement-analysis";
import { addDaysToDateString, lagosDate } from "@/server/time";
import { bureauChecksFor, processBureauChecks } from "@/server/domain/bureau-check";

const N = (n: number) => n * 100;
const ENV = ["PERICULUM_ENABLED", "PERICULUM_MODE", "PERICULUM_WEBHOOK_SECRET", "PERICULUM_MAX_CONCURRENT", "PERICULUM_MAX_ATTEMPTS", "PERICULUM_BLACKLIST_ENABLED"];
const saved: Record<string, string | undefined> = {};

/** A programmable fake network in front of the labelled fixture vendor. */
const net = {
  calls: [] as { method: string; path: string }[],
  putFault: [] as ("timeout-landed" | "timeout-lost" | "429" | "500-landed")[],
  getFault: [] as ("401" | "timeout")[],
  blacklistFault: [] as "timeout"[],
};
async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  const method = (init.method ?? "GET").toUpperCase();
  net.calls.push({ method, path: u.pathname });
  const abort = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  if (method === "PUT" && u.pathname === "/statements" && net.putFault.length) {
    const f = net.putFault.shift()!;
    if (f === "429") return new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 });
    if (f === "timeout-lost") throw abort();
    await fixtureFetch(url, init); // the vendor accepts it…
    if (f === "500-landed") return new Response("", { status: 502 });
    throw abort(); // …but the reply never arrives
  }
  if (method === "POST" && u.pathname === "/statements/blacklistsearch" && net.blacklistFault.length) {
    net.blacklistFault.shift();
    throw abort();
  }
  if (method === "GET" && u.pathname.startsWith("/statements/") && net.getFault.length) {
    const f = net.getFault.shift()!;
    if (f === "401") return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    throw abort();
  }
  return fixtureFetch(url, init);
}

beforeEach(async () => {
  await resetDb();
  for (const k of ENV) saved[k] = process.env[k];
  process.env.PERICULUM_ENABLED = "true";
  resetFixtureVendor();
  net.calls = [];
  net.putFault = [];
  net.getFault = [];
  net.blacklistFault = [];
  setPericulumFetchForTests(fakeFetch);
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});
afterEach(() => {
  setPericulumFetchForTests(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const vendorCalls = (method: string, path = "/statements") => net.calls.filter((c) => c.method === method && c.path === path).length;
const apiCalls = async (operation?: string) => Number((await db.query(`SELECT count(*) AS n FROM fi_api_calls ${operation ? "WHERE operation = $1" : ""}`, operation ? [operation] : [])).rows[0].n);

/** A Vendor Financing case at first credit review, with the given statements (directive texts) attached. */
async function caseAtCreditReview(statements: string[], type: "ENTERPRISE" | "LIMITED" = "ENTERPRISE") {
  const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", type, amountKobo: N(2_000_000), tenorMonths: 12, submit: false, skipDocs: ["BANK_STATEMENT"] });
  const ctx = await ctxFor(INITIATORS.RM);
  const today = lagosDate(new Date());
  for (const [i, s] of statements.entries())
    await uploadDocument(ctx, {
      applicationId: id,
      category: "BANK_STATEMENT",
      filename: `statement-${i}.pdf`,
      data: makePdf(s),
      meta: { coverageFrom: addDaysToDateString(today, -400), coverageTo: addDaysToDateString(today, -1) },
    });
  await passRetailCreditChecks(ctx, id);
  await submitApplication(ctx, id, randomUUID());
  await driveBusinessReview(id);
  const t = await openTaskOf(id);
  expect(t.stage).toBe("FIRST_CREDIT_REVIEW");
  return { id, analyst: await ctxFor(t.email!) };
}

/** Run worker ticks, moving the clock past each poll interval, until nothing is in flight (or the limit). */
async function runWorker(start = new Date(), ticks = 12) {
  let t = start.getTime();
  for (let i = 0; i < ticks; i++) {
    t += config.periculum.pollIntervalMs + 1000;
    await processStatementAnalysis(new Date(t));
    await processBureauChecks(new Date(t));
    const busy =
      Number((await db.query("SELECT count(*) AS n FROM fi_statements WHERE status IN ('PENDING','SUBMITTING','SUBMISSION_UNCERTAIN','UPLOADED','PROCESSING')")).rows[0].n) +
      Number((await db.query("SELECT count(*) AS n FROM fi_bureau_checks WHERE status = 'PENDING'")).rows[0].n);
    if (!busy) break;
  }
  return new Date(t);
}

const SALARY = (account: string, extra = "") => `PERICULUM-FIXTURE bank=Sterling Bank;account=${account};name=AMINA BELLO;kind=BUSINESS;turnover=2000000;months=6;start=2026-05${extra}`;

describe("Periculum configuration and sign-in", () => {
  it("uses the documented hosts; analysis is refused while the integration is switched off", async () => {
    expect(config.periculum.baseUrl).toBe("https://api.insights-periculum.io");
    expect(config.periculum.authUrl).toBe("https://insightsb2b.auth-periculum.app/realms/prod/protocol/openid-connect/token");
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    process.env.PERICULUM_ENABLED = "false";
    await expect(startStatementAnalysis(analyst, id)).rejects.toMatchObject({ code: "GATE", message: expect.stringMatching(/not enabled/) });
    expect(await apiCalls()).toBe(0);
  });

  it("signs in with client credentials; the token is reused, and refreshed once on a 401", async () => {
    const r = await checkPericulumSignIn();
    expect(r).toMatchObject({ ok: true });
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    await startStatementAnalysis(analyst, id);
    net.getFault.push("401");
    await runWorker();
    expect((await currentAnalysis(db, id))!.status).toBe("COMPLETED");
    // one sign-in for the check (then reused by the pipeline), one forced refresh after the 401
    expect(await apiCalls("TOKEN")).toBe(2);
  });
});

describe("Automatic Statement Analysis — one action, the whole pipeline", () => {
  it("uploading statements never calls Periculum; only the assigned credit reviewer can start the analysis", async () => {
    const { id } = await caseAtCreditReview([SALARY("0123456789")]);
    expect(await apiCalls()).toBe(0);
    expect(net.calls.length).toBe(0);
    await expect(startStatementAnalysis(await ctxFor(INITIATORS.RM), id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("analyses every statement once (duplicates detected), stores the results encrypted and completes", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789"), SALARY("0123456789"), SALARY("2233445566", ";bank=Access Bank")]);
    const r = await startStatementAnalysis(analyst, id);
    expect(r).toMatchObject({ version: 1, status: "QUEUED", reused: false });
    // A second click while it runs returns the same analysis.
    expect(await startStatementAnalysis(analyst, id)).toMatchObject({ id: r.id, alreadyRunning: true });
    const st = await analysisStatements(db, r.id);
    expect(st.map((s) => s.status).sort()).toEqual(["DUPLICATE", "PENDING", "PENDING"]);
    await runWorker();
    const a = (await currentAnalysis(db, id))!;
    expect(a).toMatchObject({ status: "COMPLETED", source: "FIXTURE" });
    expect(vendorCalls("PUT")).toBe(2); // the duplicate file was not sent (or charged) twice
    expect(await apiCalls("SUBMIT")).toBe(2);
    const processed = (await analysisStatements(db, r.id)).filter((s) => s.status === "PROCESSED");
    expect(processed).toHaveLength(2);
    const raw = (await db.query("SELECT payload_enc FROM fi_vendor_results WHERE statement_id = $1 AND kind = 'ANALYTICS'", [processed[0].id])).rows[0].payload_enc;
    expect(raw).not.toMatch(/Sterling|Access/); // encrypted at rest
    const analytics = await statementPayload<{ bankName: string; _fixture: string; cashFlowAnalysis: { numberOfTransactingMonths: number } }>(db, processed[0].id, "ANALYTICS");
    expect(analytics!._fixture).toMatch(/not a Periculum result/);
    expect(analytics!.cashFlowAnalysis.numberOfTransactingMonths).toBe(6);
    expect((await statementPayload<unknown[]>(db, processed[0].id, "TRANSACTIONS"))!.length).toBeGreaterThan(10);
    const events = (await db.query("SELECT action FROM audit_events WHERE application_id = $1 AND action LIKE 'STATEMENT_ANALYSIS%' ORDER BY id", [id])).rows.map((x) => x.action);
    expect(events).toEqual(["STATEMENT_ANALYSIS_INITIATED", "STATEMENT_ANALYSIS_COMPLETED"]);
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'STATEMENT_ANALYSIS' AND recipient_id = $1", [analyst.actor!.staffId])).rows[0].n).toBe(1);
  });

  it("an unchanged statement set returns the saved analysis; a re-run needs a reason and reuses processed statements", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    const first = await startStatementAnalysis(analyst, id);
    await runWorker();
    const puts = vendorCalls("PUT");
    expect(await startStatementAnalysis(analyst, id)).toMatchObject({ id: first.id, reused: true, alreadyRunning: false });
    await expect(startStatementAnalysis(analyst, id, { reason: "short" })).rejects.toMatchObject({ code: "VALIDATION" });
    const second = await startStatementAnalysis(analyst, id, { reason: "Re-run requested by Credit Lead for file review" });
    expect(second).toMatchObject({ version: 2, status: "COMPLETED" }); // reused, nothing to submit
    expect(vendorCalls("PUT")).toBe(puts);
    const v1 = (await db.query("SELECT superseded_at, superseded_by, status FROM fi_analyses WHERE id = $1", [first.id])).rows[0];
    expect(v1).toMatchObject({ superseded_by: second.id, status: "COMPLETED" });
    expect((await analysisStatements(db, second.id))[0]).toMatchObject({ status: "REUSED" });
    expect(await statementPayload(db, (await analysisStatements(db, second.id))[0].id, "ANALYTICS")).not.toBeNull();
  });

  it("keeps successful results when one statement fails; altered statements need verification; only failures are retried", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789"), SALARY("1111111111", ";status=NOT ENOUGH TRANSACTIONS"), SALARY("2222222222", ";status=ALTERED")]);
    const r = await startStatementAnalysis(analyst, id);
    await runWorker();
    const st = await analysisStatements(db, r.id);
    const by = (acc: string) => st.find((s) => s.filename === `statement-${["0123456789", "1111111111", "2222222222"].indexOf(acc)}.pdf`)!;
    expect(by("0123456789").status).toBe("PROCESSED");
    expect(by("1111111111")).toMatchObject({ status: "FAILED", error_category: "NOT_ENOUGH_TRANSACTIONS" });
    expect(by("2222222222")).toMatchObject({ status: "REQUIRES_VERIFICATION", error_category: "ALTERED" });
    expect((await currentAnalysis(db, id))!.status).toBe("REQUIRES_VERIFICATION");
    const puts = vendorCalls("PUT");
    await expect(retryStatements(analyst, r.id, { reason: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await retryStatements(analyst, r.id, { reason: "Retry after vendor check" })).toEqual({ retried: 1 }); // not the altered one
    await runWorker();
    expect(vendorCalls("PUT")).toBe(puts + 1);
  });

  it("a password-protected statement waits for the password, then completes", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789", ";password=4321")]);
    const r = await startStatementAnalysis(analyst, id);
    await runWorker();
    const s = (await analysisStatements(db, r.id))[0];
    expect(s).toMatchObject({ status: "REQUIRES_VERIFICATION", error_category: "PASSWORD_REQUIRED" });
    await retryStatements(analyst, r.id, { reason: "Customer supplied the password", passwords: { [s.document_id]: "4321" } });
    await runWorker();
    expect((await currentAnalysis(db, id))!.status).toBe("COMPLETED");
    expect((await analysisStatements(db, r.id))[0].password_enc).toBeNull(); // cleared once submitted
  });

  it("respects the concurrency limit", async () => {
    process.env.PERICULUM_MAX_CONCURRENT = "2";
    const { id, analyst } = await caseAtCreditReview([SALARY("1"), SALARY("2"), SALARY("3")]);
    await startStatementAnalysis(analyst, id);
    await processStatementAnalysis(new Date(Date.now() + 60_000));
    expect(vendorCalls("PUT")).toBe(2);
    await runWorker(new Date(Date.now() + 60_000));
    expect(vendorCalls("PUT")).toBe(3);
  });
});

describe("reliability: no blind retries, no double charges", () => {
  it("an ambiguous submission that reached Periculum is not submitted twice", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    const r = await startStatementAnalysis(analyst, id);
    net.putFault.push("timeout-landed");
    const t = new Date(Date.now() + 60_000);
    await processStatementAnalysis(t);
    expect((await analysisStatements(db, r.id))[0]).toMatchObject({ status: "SUBMISSION_UNCERTAIN" });
    await runWorker(t);
    const s = (await analysisStatements(db, r.id))[0];
    expect(s).toMatchObject({ status: "REQUIRES_VERIFICATION", error_category: "SUBMITTED_KEY_UNKNOWN" });
    expect((await db.query("SELECT outcome FROM fi_api_calls WHERE operation = 'SUBMIT' ORDER BY id", [])).rows.map((x) => x.outcome)).toEqual(["AMBIGUOUS", "REJECTED"]);
  });

  it("an ambiguous submission that never arrived is completed by the reconciling resubmission", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    await startStatementAnalysis(analyst, id);
    net.putFault.push("timeout-lost");
    await runWorker();
    expect((await currentAnalysis(db, id))!.status).toBe("COMPLETED");
  });

  it("a rate limit is waited out, not counted as a failure", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    await startStatementAnalysis(analyst, id);
    net.putFault.push("429");
    await runWorker();
    expect((await currentAnalysis(db, id))!.status).toBe("COMPLETED");
    expect(await apiCalls()).toBeGreaterThan(0);
    expect((await db.query("SELECT count(*)::int AS n FROM fi_api_calls WHERE outcome = 'RATE_LIMITED'")).rows[0].n).toBe(1);
  });
});

describe("webhook", () => {
  it("verifies the signature, ignores duplicates and only brings the next status check forward", async () => {
    process.env.PERICULUM_WEBHOOK_SECRET = "0123456789abcdef0123456789abcdef";
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    const r = await startStatementAnalysis(analyst, id);
    await processStatementAnalysis(new Date(Date.now() + 60_000));
    const s = (await analysisStatements(db, r.id))[0];
    expect(s.status).toBe("UPLOADED");
    const insights = { Key: Number(s.vendor_statement_key), ProcessingStatus: "PROCESSED" };
    const hmac = createHmac("sha512", process.env.PERICULUM_WEBHOOK_SECRET).update(JSON.stringify(insights)).digest("hex");
    const body = JSON.stringify({ metadata: { responseType: "INSIGHTS", hmacMessage: hmac }, statementKey: Number(s.vendor_statement_key), insightsResponse: insights });
    const now = new Date(Date.now() + 61_000);
    expect(await handlePericulumWebhook(body, now)).toMatchObject({ accepted: true, duplicate: false, matched: true });
    expect(await handlePericulumWebhook(body, now)).toMatchObject({ accepted: true, duplicate: true });
    expect((await db.query("SELECT hmac_valid FROM fi_webhook_events ORDER BY id LIMIT 1")).rows[0].hmac_valid).toBe(true);
    expect(new Date((await analysisStatements(db, r.id))[0].next_action_at!).getTime()).toBe(now.getTime());
    // The webhook stored nothing itself: results arrive only through the API re-read.
    expect(Number((await db.query("SELECT count(*) AS n FROM fi_vendor_results")).rows[0].n)).toBe(0);
    const forged = JSON.stringify({ metadata: { responseType: "INSIGHTS", hmacMessage: "00" }, statementKey: Number(s.vendor_statement_key), insightsResponse: { Key: 1 } });
    await handlePericulumWebhook(forged, now);
    expect((await db.query("SELECT hmac_valid FROM fi_webhook_events ORDER BY id DESC LIMIT 1")).rows[0].hmac_valid).toBe(false);
    expect(await handlePericulumWebhook("not json", now)).toMatchObject({ accepted: false });
  });
});

describe("optional Blacklist Search (supplements SeedFi)", () => {
  it("is off by default: no BVN is sent to Periculum", async () => {
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    const r = await startStatementAnalysis(analyst, id);
    await runWorker();
    expect(await bureauChecksFor(db, r.id)).toEqual([]);
    expect(vendorCalls("POST", "/statements/blacklistsearch")).toBe(0);
  });

  it("when enabled, searches the applicant's BVN once per analysis and keeps only a non-personal summary readable", async () => {
    process.env.PERICULUM_BLACKLIST_ENABLED = "true";
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    const r = await startStatementAnalysis(analyst, id);
    await runWorker();
    const [c] = await bureauChecksFor(db, r.id);
    expect(c).toMatchObject({ subject: "APPLICANT", status: "COMPLETED", source: "FIXTURE", bvn_last4: "7890" });
    expect(c.summary).toMatchObject({ microfinance: { hasFacilities: "NO", delinquent: 0 }, totalDelinquent: 0, providerSource: "Blacklist" });
    expect(JSON.stringify(c.summary)).not.toMatch(/TEST|CUSTOMER|1990/); // no names or date of birth in the readable summary
    const raw = (await db.query("SELECT payload_enc FROM fi_bureau_checks WHERE id = $1", [c.id])).rows[0].payload_enc;
    expect(raw).not.toMatch(/CUSTOMER/); // encrypted at rest
    expect(vendorCalls("POST", "/statements/blacklistsearch")).toBe(1);
    await runWorker();
    expect(vendorCalls("POST", "/statements/blacklistsearch")).toBe(1); // not repeated
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE application_id = $1 AND action = 'PERICULUM_BUREAU_CHECK_COMPLETED'", [id])).rows[0].n).toBe(1);
  });

  it("a search with an unknown outcome is not resent (it may already have been charged)", async () => {
    process.env.PERICULUM_BLACKLIST_ENABLED = "true";
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")]);
    const r = await startStatementAnalysis(analyst, id);
    net.blacklistFault.push("timeout");
    await runWorker();
    const [c] = await bureauChecksFor(db, r.id);
    expect(c).toMatchObject({ status: "FAILED", error_category: "OUTCOME_UNKNOWN" });
    expect(vendorCalls("POST", "/statements/blacklistsearch")).toBe(1);
  });

  it("for a limited company, each director's BVN is searched", async () => {
    process.env.PERICULUM_BLACKLIST_ENABLED = "true";
    const { id, analyst } = await caseAtCreditReview([SALARY("0123456789")], "LIMITED");
    const r = await startStatementAnalysis(analyst, id);
    await runWorker();
    const checks = await bureauChecksFor(db, r.id);
    expect(checks.map((c) => [c.subject, c.status])).toEqual([["DIRECTOR_1", "COMPLETED"]]);
    expect(checks[0].summary!.totalDelinquent).toBe(1); // test BVN not ending in 0: one delinquent facility
  });
});
