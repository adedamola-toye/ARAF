/**
 * Check a running ARAF deployment for technology disclosure and the expected security headers.
 *
 *   npm run check:headers -- https://www.araf.ng
 *   npm run check:headers -- http://localhost:3000
 *
 * Requests a normal page, a redirect, 404s, a 405, an unauthenticated API call and a missing static file,
 * then fails (exit 1) if any response:
 *  - carries X-Powered-By or another framework/runtime banner (X-AspNet-Version, X-Runtime, X-Generator…),
 *  - has a Server header that discloses a version (a bare platform name such as "Vercel" is reported, not failed),
 *  - has a body that leaks a stack trace, a server path or a framework version.
 * It also confirms ARAF's own security headers are present, and reports HSTS / CSP when served over HTTPS.
 * Read-only: it sends no credentials and changes nothing.
 */
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("Usage: npm run check:headers -- <base URL, e.g. https://www.araf.ng>");
  process.exit(2);
}

const CHECKS: { method: string; path: string; expect: number[] }[] = [
  { method: "GET", path: "/", expect: [200] },
  { method: "GET", path: "/sign-in", expect: [200] },
  { method: "GET", path: "/queue", expect: [302, 303, 307, 308] }, // signed-out redirect
  { method: "GET", path: "/does-not-exist-araf-check", expect: [404] },
  { method: "GET", path: "/api/does-not-exist-araf-check", expect: [404] },
  { method: "GET", path: "/api/incidents", expect: [405] },
  { method: "GET", path: "/api/altphones/resolve-account", expect: [401] },
  { method: "GET", path: "/_next/static/does-not-exist-araf-check.js", expect: [404] },
];
const BANNERS = ["x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-runtime", "x-generator", "x-drupal-cache", "x-php-version"];
const REQUIRED = ["x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"];
const LEAKS: [RegExp, string][] = [
  [/\n\s+at [\w.<>$]+ \(/, "stack trace"],
  [/(\/var\/task|\/home\/[a-z]|node_modules\/|[A-Z]:\\\\)/, "server path"],
  [/next\.js\s*v?\d|next@\d|"version":"\d+\.\d+/i, "framework version"],
  [/(nginx|apache|express|node\.js)\/?\s*v?\d/i, "server software version"],
];

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

async function main() {
  console.log(`Checking ${base}\n`);
  for (const c of CHECKS) {
    let res: Response;
    try {
      res = await fetch(base + c.path, { method: c.method, redirect: "manual", headers: { "user-agent": "araf-header-check" } });
    } catch (e) {
      fail(`${c.method} ${c.path}: request failed (${(e as Error).message})`);
      continue;
    }
    const body = await res.text().catch(() => "");
    const h = res.headers;
    console.log(`${c.method} ${c.path} → ${res.status}${c.expect.includes(res.status) ? "" : ` (expected ${c.expect.join("/")})`}`);
    for (const b of BANNERS) if (h.has(b)) fail(`${b}: ${h.get(b)}`);
    const server = h.get("server");
    if (server && /\d/.test(server)) fail(`Server header discloses a version: "${server}"`);
    else if (server) console.log(`  note Server: ${server} (platform name only, no version)`);
    for (const [re, what] of LEAKS) if (re.test(body)) fail(`body leaks a ${what}`);
    if (c.path === "/") {
      for (const r of REQUIRED) if (!h.has(r)) fail(`missing security header ${r}`);
      if (base.startsWith("https://")) {
        console.log(`  ${h.has("strict-transport-security") ? "ok  " : "note"} Strict-Transport-Security: ${h.get("strict-transport-security") ?? "absent"}`);
        console.log(`  ${h.has("content-security-policy") ? "ok  " : "note"} Content-Security-Policy: ${h.get("content-security-policy") ? "present" : "absent"}`);
      }
      const platform = [...h.keys()].filter((k) => /^x-(vercel|nextjs|nf-|render)/.test(k));
      if (platform.length) console.log(`  note platform headers (no versions): ${platform.join(", ")}`);
    }
  }
  console.log(failures ? `\n${failures} problem(s) found.` : "\nNo technology disclosure found.");
  process.exit(failures ? 1 : 0);
}
void main();
