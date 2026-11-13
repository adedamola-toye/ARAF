import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("web server hardening (next.config.ts)", () => {
  it("never sends X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("keeps ARAF's security headers on every route", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    const h = Object.fromEntries((all?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
    expect(h["referrer-policy"]).toBe("same-origin");
    expect(h["permissions-policy"]).toMatch(/camera=\(\)/);
    // No header in our own config may announce the stack or a version.
    for (const r of rules) for (const x of r.headers) expect(x.key.toLowerCase()).not.toMatch(/^(x-powered-by|server|x-generator|x-runtime)$/);
  });
});
