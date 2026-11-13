import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/server/db";
import { rateLimit } from "@/server/auth/rateLimit";
import { clientIpFromHeaders } from "@/server/context";
import { viewForDigest } from "@/server/incidents";
import { currentSubject, reportForCurrentUser, unrecordedView } from "@/server/incidents/subject";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The browser reports a failure it is showing (a crashed page, a lost response) and gets back the shared
 * incident reference and this user's assigned message. Server-side failures arrive with the error digest
 * the server hook already recorded; browser-only failures are recorded here. Open to signed-out users
 * (sign-in can fail too) and rate limited.
 */
export async function POST(req: NextRequest) {
  let body: { digest?: unknown; route?: unknown; name?: unknown; message?: unknown; kind?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
  const digest = str(body.digest, 64);
  const kind = body.kind === "network" ? "network" : "client";
  const subject = await currentSubject({ setCookie: true });
  try {
    const ip = clientIpFromHeaders((n) => req.headers.get(n)) ?? "unknown";
    if (!(await rateLimit(db, `incident:${subject ?? ip}`, 30, 600, new Date()))) return NextResponse.json({ incident: unrecordedView(subject) }, { status: 429 });
    if (digest && subject) {
      // The server hook records the failure as it happens; give it a moment if the browser got here first.
      for (let i = 0; i < 6; i++) {
        const v = await viewForDigest(digest, subject);
        if (v) return NextResponse.json({ incident: v }, { headers: { "cache-control": "no-store" } });
        await wait(250);
      }
    }
    const v = await reportForCurrentUser({ source: kind, route: str(body.route, 300) ?? "/", name: str(body.name, 80), message: str(body.message, 500), digest });
    return NextResponse.json({ incident: v }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ incident: unrecordedView(subject ?? digest) }, { status: 503 });
  }
}
