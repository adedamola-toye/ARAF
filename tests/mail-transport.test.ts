import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailTransport, setMailTransportForTests } from "@/server/notify/transport";

const message = {
  to: ["staff@altbank.ng"],
  cc: ["lead@altbank.ng"],
  subject: "Your WakeelBoost Work Desk sign-in code",
  text: "Your one-time sign-in code is: 123456",
  attachments: [{ filename: "pack.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4") }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("MAIL_DRIVER", "resend");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("RESEND_BASE_URL", "https://api.resend.test/");
  vi.stubEnv("RESEND_REPLY_TO", "support@altbank.ng");
  vi.stubEnv("MAIL_FROM", "WakeelBoost Work Desk <noreply@wakeelboost.ng>");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setMailTransportForTests(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setMailTransportForTests(null);
});

describe("Resend mail transport", () => {
  it("posts the message to the Resend API and returns its id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "abc123" }), { status: 200 }));

    const result = await mailTransport().send(message);

    expect(result).toEqual({ messageId: "resend-abc123" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.test/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "WakeelBoost Work Desk <noreply@wakeelboost.ng>",
      to: ["staff@altbank.ng"],
      cc: ["lead@altbank.ng"],
      subject: "Your WakeelBoost Work Desk sign-in code",
      text: "Your one-time sign-in code is: 123456",
      reply_to: "support@altbank.ng",
      attachments: [{ filename: "pack.pdf", content: Buffer.from("%PDF-1.4").toString("base64"), content_type: "application/pdf" }],
    });
  });

  it("refuses to send without an API key", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    setMailTransportForTests(null);

    await expect(mailTransport().send(message)).rejects.toThrow(/RESEND_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the provider error detail", async () => {
    fetchMock.mockResolvedValue(new Response("domain is not verified", { status: 403 }));

    await expect(mailTransport().send(message)).rejects.toThrow(/Resend API 403: domain is not verified/);
  });
});
