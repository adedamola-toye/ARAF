import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { DomainError, forbidden, gate, invalid } from "@/server/errors";

// Server-action request context: no session cookie (a signed-out user), page /requests/new.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined), set: (k: string, v: string) => jar.set(k, v) }),
  headers: async () => new Headers({ referer: "http://localhost:3000/requests/new" }),
}));
vi.mock("server-only", () => ({}));

const { toActionError } = await import("@/app/_lib/action");
const incidents = async () => Number((await db.query("SELECT count(*) AS n FROM incidents")).rows[0].n);

beforeEach(async () => {
  await resetDb();
  jar.clear();
});

describe("action errors: business outcomes stay business outcomes", () => {
  it("validation, permission, gate and conflict errors keep their own clear message and open no incident", async () => {
    for (const e of [invalid("Enter an 11-digit BVN.", { bvn: "Must be 11 digits" }), forbidden(), gate("The credit check failed, so the request stops here."), new DomainError("CONFLICT", "Already approved.")]) {
      const s = await toActionError(e);
      expect(s.error).toBe(e.message);
      expect(s.incident).toBeUndefined();
    }
    expect(await incidents()).toBe(0);
  });

  it("Next.js redirects pass straight through", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" });
    await expect(toActionError(redirect)).rejects.toBe(redirect);
    expect(await incidents()).toBe(0);
  });

  it("a genuine technical failure becomes an incident with a stable message for the same person", async () => {
    const boom = () => Object.assign(new Error("could not serialize access"), { code: "XX000" });
    const a = await toActionError(boom());
    expect(a.ok).toBe(false);
    expect(a.incident!.ref).toMatch(/^ARAF-\d{4}-\d{4}$/);
    expect(a.incident!.retry).toBe(true);
    expect(a.error).toContain(a.incident!.ref!);
    expect(jar.get("araf_eid")).toBeTruthy(); // signed-out users get a private, random id
    const b = await toActionError(boom());
    expect([b.incident!.ref, b.incident!.messageNo]).toEqual([a.incident!.ref, a.incident!.messageNo]);
    const row = (await db.query("SELECT module, affected_users, occurrences FROM incidents")).rows[0];
    expect(row).toEqual({ module: "Customer onboarding", affected_users: 1, occurrences: 2 });
  });
});
