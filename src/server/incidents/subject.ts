import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { lookupSession, SESSION_COOKIE } from "../auth/session";
import { config } from "../config";
import { recordFailure, type IncidentSource } from ".";
import { fallbackMessageNo, statusLabel, type IncidentView } from "@/lib/incident-messages";

const ANON_COOKIE = "araf_eid";

/**
 * Who is affected: the signed-in staff member, or (before sign-in) a random per-browser id kept in a
 * cookie and stored only as a hash. Never throws: identity problems must not hide the original failure.
 */
export async function currentSubject(opts: { setCookie: boolean }): Promise<string | null> {
  try {
    const jar = await cookies();
    const r = await lookupSession(jar.get(SESSION_COOKIE)?.value, { actor: null, now: new Date(), correlationId: randomUUID(), ip: null, userAgent: null }, { touch: false });
    if (r.status === "ok") return `staff:${r.session.staffId}`;
    let eid = jar.get(ANON_COOKIE)?.value;
    if (!eid && opts.setCookie) {
      eid = randomUUID();
      jar.set(ANON_COOKIE, eid, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/", maxAge: 60 * 60 * 24 * 30 });
    }
    return eid ? `anon:${createHash("sha256").update(eid).digest("hex").slice(0, 32)}` : null;
  } catch {
    return null;
  }
}

/** The page the request came from (server actions post to the page's own URL). */
export async function currentRoute(): Promise<string> {
  try {
    const h = await headers();
    const ref = h.get("referer");
    if (ref) return new URL(ref).pathname;
    return h.get("x-pathname") ?? "/";
  } catch {
    return "/";
  }
}

/** A view to show when the incident service itself is unavailable: coherent, but honest about it. */
export function unrecordedView(seed: string | null): IncidentView {
  return { ref: null, messageNo: fallbackMessageNo(seed ?? String(Date.now())), status: "UNRECORDED", statusLabel: statusLabel("UNRECORDED", false), routed: false };
}

/** Record a failure for the current user and return what they should see. Never throws. */
export async function reportForCurrentUser(input: { source: IncidentSource; error?: unknown; route?: string; name?: string | null; message?: string | null; digest?: string | null }): Promise<IncidentView> {
  const subject = await currentSubject({ setCookie: true });
  try {
    const { view } = await recordFailure({ ...input, route: input.route ?? (await currentRoute()), subject: subject ?? `anon:${randomUUID()}` });
    return view!;
  } catch (e) {
    console.error(JSON.stringify({ event: "araf.incident.unrecorded", source: input.source, reason: (e as { code?: string }).code ?? (e as Error).name ?? "Error", at: new Date().toISOString() }));
    return unrecordedView(subject);
  }
}
