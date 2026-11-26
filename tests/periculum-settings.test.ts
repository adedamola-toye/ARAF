import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { forgetPericulumConnection, normaliseBaseUrl, periculumConnection, periculumSettingsView, recordSignInTest, savePericulumCredentials } from "@/server/integrations/periculum/settings";
import { checkPericulumSignIn, explainSignIn, setPericulumFetchForTests } from "@/server/integrations/periculum/client";

const ADMIN = "superadmin@altbank.ng";
const base = { clientId: "insights-sterlingbankng-api", clientSecret: "s3cr3t+with%chars", baseUrl: "https://api.insights-periculum.io/statements", authUrl: "", reason: "Live credentials issued by Periculum" };

/** Captures what is sent to the token URL; answers like Periculum's sign-in server. */
const seen: { url: string; body: string }[] = [];
async function fakeAuth(url: string, init: RequestInit): Promise<Response> {
  const body = String(init.body ?? "");
  seen.push({ url, body });
  const p = new URLSearchParams(body);
  if (p.get("client_id") !== "insights-sterlingbankng-api") return new Response(JSON.stringify({ error: "invalid_client", error_description: "Invalid client credentials" }), { status: 400 });
  if (p.get("client_secret") !== "s3cr3t+with%chars") return new Response(JSON.stringify({ error: "unauthorized_client", error_description: "Invalid client secret" }), { status: 401 });
  return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400, token_type: "Bearer" }), { status: 200 });
}

beforeEach(async () => {
  await resetDb();
  seen.length = 0;
  forgetPericulumConnection();
  setPericulumFetchForTests(fakeAuth);
});
afterEach(() => setPericulumFetchForTests(null));

describe("Periculum connection settings (Super Admin)", () => {
  it("accepts the base URL with /statements and stores it without; the secret is encrypted and never shown", async () => {
    expect(normaliseBaseUrl("https://api.insights-periculum.io/statements/")).toBe("https://api.insights-periculum.io");
    await savePericulumCredentials(await ctxFor(ADMIN), base);
    const row = (await db.query("SELECT client_id, client_secret_enc, base_url, auth_url FROM integration_credentials")).rows[0];
    expect(row).toMatchObject({ client_id: "insights-sterlingbankng-api", base_url: "https://api.insights-periculum.io", auth_url: "https://insightsb2b.auth-periculum.app/realms/prod/protocol/openid-connect/token" });
    expect(row.client_secret_enc).not.toContain("s3cr3t");
    const view = await periculumSettingsView(db);
    expect(JSON.stringify(view)).not.toContain("s3cr3t");
    const audit = (await db.query("SELECT details FROM audit_events WHERE action = 'PERICULUM_CREDENTIALS_SAVED'")).rows[0].details;
    expect(JSON.stringify(audit)).not.toContain("s3cr3t");
    expect(audit).toMatchObject({ clientId: "insights-sterlingbankng-api", credentialsRotated: true });
  });

  it("only a Super Admin can save; only Periculum https addresses are accepted; a blank secret keeps the saved one", async () => {
    await expect(savePericulumCredentials(await ctxFor("rm.bola@altbank.ng"), base)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await ctxFor(ADMIN);
    await expect(savePericulumCredentials(admin, { ...base, baseUrl: "https://evil.example.com" })).rejects.toMatchObject({ code: "VALIDATION", fields: { baseUrl: expect.stringMatching(/Periculum address/) } });
    await expect(savePericulumCredentials(admin, { ...base, authUrl: "http://insightsb2b.auth-periculum.app/x" })).rejects.toMatchObject({ fields: { authUrl: expect.stringMatching(/https/) } });
    await expect(savePericulumCredentials(admin, { ...base, clientSecret: "" })).rejects.toMatchObject({ fields: { clientSecret: expect.any(String) } }); // nothing saved yet
    await savePericulumCredentials(admin, base);
    await savePericulumCredentials(admin, { ...base, clientSecret: "", reason: "Correcting the token URL" });
    forgetPericulumConnection();
    expect((await periculumConnection())!.clientSecret).toBe("s3cr3t+with%chars");
  });

  it("signs in with the saved credentials sent in the form body, as documented; results are explained and recorded", async () => {
    const admin = await ctxFor(ADMIN);
    await savePericulumCredentials(admin, base);
    const ok = explainSignIn(await checkPericulumSignIn());
    expect(ok).toMatchObject({ ok: true, message: expect.stringMatching(/No statement was sent/) });
    const sent = new URLSearchParams(seen[0].body);
    expect(seen[0].url).toBe("https://insightsb2b.auth-periculum.app/realms/prod/protocol/openid-connect/token");
    expect([sent.get("grant_type"), sent.get("client_id"), sent.get("client_secret")]).toEqual(["client_credentials", "insights-sterlingbankng-api", "s3cr3t+with%chars"]);
    await recordSignInTest(admin, ok.ok, ok.message);
    expect((await periculumSettingsView(db)).saved).toMatchObject({ last_test_ok: true });

    await savePericulumCredentials(admin, { ...base, clientSecret: "wrong-secret" });
    expect(explainSignIn(await checkPericulumSignIn())).toMatchObject({ ok: false, message: expect.stringMatching(/recognised the Client ID but not the Secret Key/) });
    await savePericulumCredentials(admin, { ...base, clientId: "someone-else" });
    expect(explainSignIn(await checkPericulumSignIn())).toMatchObject({ ok: false, message: expect.stringMatching(/did not recognise the Client ID/) });
  });
});
