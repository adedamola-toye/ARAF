import Link from "next/link";
import { AuthScene } from "@/components/Brand";
import { safeNext } from "@/lib/paths";
import { ClearSession } from "./ClearSession";
import { themePreference } from "../_lib/theme";

export const metadata = { title: "Session ended" };

const REASONS: Record<string, string> = {
  IDLE_TIMEOUT: "You were inactive for five minutes, so your session was closed to protect customer information.",
  ABSOLUTE_TIMEOUT: "Your session reached its maximum length.",
  STAFF_SUSPENDED: "Your access has been suspended. Contact the Super Admin.",
  NO_ACTIVE_ROLES: "You no longer have an active role assignment.",
  LOGOUT: "You have signed out.",
};

export default async function SessionExpired({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  return (
    <AuthScene theme={await themePreference()}>
      <ClearSession />
      <h1 className="auth-h1-sm">{sp.reason === "LOGOUT" ? "Signed out" : "Session ended"}</h1>
      <p className="lede" role="alert">{REASONS[sp.reason ?? "IDLE_TIMEOUT"] ?? REASONS.IDLE_TIMEOUT}</p>
      <div className="auth-form">
        <Link className="auth-continue" href={`/sign-in?next=${encodeURIComponent(next)}`} style={{ textDecoration: "none" }}>
          Sign in with a new code <span aria-hidden="true">↗</span>
        </Link>
        <p className="auth-feedback">Saved drafts remain available after you sign in again.</p>
      </div>
    </AuthScene>
  );
}
