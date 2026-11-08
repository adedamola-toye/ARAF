import Link from "next/link";
import { AuthFrame } from "@/components/Brand";
import { safeNext } from "@/lib/paths";
import { ClearSession } from "./ClearSession";

export const metadata = { title: "Session expired" };

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
    <AuthFrame>
      <ClearSession />
      <div className="card stack" role="alert">
        <h1>{sp.reason === "LOGOUT" ? "Signed out" : "Your session has ended"}</h1>
        <p className="muted" style={{ margin: 0 }}>{REASONS[sp.reason ?? "IDLE_TIMEOUT"] ?? REASONS.IDLE_TIMEOUT}</p>
        <p className="small muted" style={{ margin: 0 }}>Saved drafts remain available after you sign in again.</p>
        <Link className="btn btn-primary" href={`/sign-in?next=${encodeURIComponent(next)}`}>
          Sign in with a new code
        </Link>
      </div>
    </AuthFrame>
  );
}
