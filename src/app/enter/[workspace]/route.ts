import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../_lib/auth";
import { lookupSession, switchWorkspace, SESSION_COOKIE } from "@/server/auth/session";

/**
 * Landing-page workspace entry. Never grants a permission:
 *  - not signed in → the existing OTP sign-in, with the workspace preselected (`as`) and a return path;
 *  - signed in and holding the role → switch to that workspace (audited) and open it;
 *  - signed in without the role → the existing "forbidden" page.
 * Staff Personal Request has no workspace yet; it opens the documented integration point /staff-request.
 */
const TARGETS: Record<string, { role: string | null; next: string }> = {
  "relationship-manager": { role: "RM", next: "/queue" },
  "delight-officer": { role: "DELIGHT_OFFICER", next: "/queue" },
  "staff-personal-request": { role: null, next: "/staff-request" },
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  const t = TARGETS[workspace];
  const to = (path: string) => NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
  if (!t) return to("/");
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return to(`/sign-in?as=${t.role ?? "STAFF"}&next=${encodeURIComponent(t.next)}`);
  if (!t.role) return to(t.next);
  const s = r.session;
  if (!s.roles.some((x) => x.role === t.role)) return to("/forbidden");
  if (s.activeRole !== t.role) {
    ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
    await switchWorkspace(ctx, s.sessionId, t.role);
  }
  return to(t.next);
}
