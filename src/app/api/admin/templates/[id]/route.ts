import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseCtx } from "../../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { holdsRole } from "@/server/domain/access";
import { objectStore } from "@/server/storage";
import { auditOutsideTx } from "@/server/audit";
import { DOCX_MIME } from "@/server/domain/offer";

/** Super Admin download of an offer template (for review or editing). Audited. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired.", { status: 401 });
  ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
  if (!(await holdsRole(db, r.session.staffId, "SUPER_ADMIN"))) {
    await auditOutsideTx(ctx, { action: "TEMPLATE_DOWNLOAD", outcome: "DENIED", details: { templateId: id } });
    return new NextResponse("Forbidden", { status: 403 });
  }
  const t = /^[0-9a-f-]{36}$/.test(id) ? (await db.query("SELECT * FROM offer_templates WHERE id = $1", [id])).rows[0] : null;
  if (!t) return new NextResponse("Not found", { status: 404 });
  await auditOutsideTx(ctx, { action: "TEMPLATE_DOWNLOAD", details: { templateId: id, name: t.name, version: t.version } });
  const body = t.format === "DOCX" ? await objectStore().get(t.storage_key) : Buffer.from(t.body_html, "utf8");
  const name = `${t.name.replace(/[^\w-]+/g, "-")}-v${t.version}.${t.format === "DOCX" ? "docx" : "html"}`;
  return new NextResponse(new Uint8Array(body), {
    headers: { "Content-Type": t.format === "DOCX" ? DOCX_MIME : "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" },
  });
}
