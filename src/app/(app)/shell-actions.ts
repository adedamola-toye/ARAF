"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "../_lib/auth";
import { revokeSession, SESSION_COOKIE, switchWorkspace } from "@/server/auth/session";
import { db } from "@/server/db";

export async function switchWorkspaceAction(fd: FormData) {
  const { ctx, session } = await requireUser();
  await switchWorkspace(ctx, session.sessionId, String(fd.get("role") ?? ""));
  redirect("/queue");
}

export async function signOutAction() {
  const { ctx, session } = await requireUser({ touch: false });
  await revokeSession(db, ctx, session.sessionId, "LOGOUT", "LOGOUT");
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/session-expired?reason=LOGOUT");
}
