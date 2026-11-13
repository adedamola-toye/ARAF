import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { holdsRole } from "@/server/domain/access";
import { rateLimit } from "@/server/auth/rateLimit";
import { resolveAccount } from "@/server/altphones/banks";

/** Live account name enquiry for the originating officer (the server repeats it on save). */
export async function GET(req: NextRequest) {
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: false });
  if (r.status !== "ok") return NextResponse.json({ status: "ERROR", message: "Sign in again." }, { status: 401 });
  const me = r.session.staffId;
  if (!(await holdsRole(db, me, "DELIGHT_OFFICER")) && !(await holdsRole(db, me, "SMILE_ASSOCIATE"))) return NextResponse.json({ status: "ERROR", message: "Not allowed." }, { status: 403 });
  if (!(await rateLimit(db, `acct-lookup:${me}`, 60, 600, ctx.now))) return NextResponse.json({ status: "ERROR", message: "Too many lookups. Wait a few minutes." }, { status: 429 });
  const account = (req.nextUrl.searchParams.get("account") ?? "").replace(/\s/g, "");
  const bank = req.nextUrl.searchParams.get("bank") ?? "";
  const res = await resolveAccount(account, bank);
  return NextResponse.json(res, { headers: { "cache-control": "no-store" } });
}
