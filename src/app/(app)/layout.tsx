import { cookies } from "next/headers";
import { requireUser } from "../_lib/auth";
import { Footer, Wordmark } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IdleWatcher } from "@/components/IdleWatcher";
import { NavLink, WorkspaceSelect } from "@/components/NavLink";
import { ROLE_LABELS, isInitiatorRole, type Role } from "@/server/domain/roles";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { signOutAction, switchWorkspaceAction } from "./shell-actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, roles } = await requireUser();
  const theme = (await cookies()).get("wb-theme")?.value;
  const ws = session.activeRole as Role | null;
  const queueCount = Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1", [session.staffId])).rows[0].n);
  const isInitiatorWs = isInitiatorRole(ws);
  const isAdmin = roles.includes("SUPER_ADMIN");
  const canReport = roles.includes("SUPER_ADMIN") || roles.includes("REPORTING_ADMIN");
  const exceptions = isAdmin ? Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id IS NULL")).rows[0].n) : 0;
  return (
    <div className="shell">
      <nav className="sidenav" aria-label="Main navigation">
        <Wordmark href="/queue" />
        <div className="nav-section">
          <span className="nav-title">Work</span>
          <NavLink href="/queue" count={queueCount}>
            My Action Queue
          </NavLink>
          {isInitiatorWs && (
            <>
              <NavLink href="/requests/new" exact>
                Initiate New Request
              </NavLink>
              <NavLink href="/requests" exact>
                View Progress
              </NavLink>
              <NavLink href="/booked">Booked Requests</NavLink>
            </>
          )}
        </div>
        {canReport && (ws === "SUPER_ADMIN" || ws === "REPORTING_ADMIN") && (
          <div className="nav-section">
            <span className="nav-title">Reporting</span>
            <NavLink href="/reports">Reports &amp; exports</NavLink>
            <NavLink href="/booked">Booked Requests</NavLink>
          </div>
        )}
        {isAdmin && ws === "SUPER_ADMIN" && (
          <div className="nav-section">
            <span className="nav-title">Administration</span>
            <NavLink href="/admin/staff">Staff &amp; roles</NavLink>
            <NavLink href="/admin/exceptions" count={exceptions}>
              Assignment exceptions
            </NavLink>
            <NavLink href="/admin/groups">Recipient groups</NavLink>
            <NavLink href="/admin/templates">Offer templates</NavLink>
            <NavLink href="/admin/schedules">Scheduled emails</NavLink>
            <NavLink href="/admin/outbox">Email delivery</NavLink>
            <NavLink href="/admin/audit">System audit</NavLink>
          </div>
        )}
      </nav>
      <header className="topbar">
        <div className="topbar-left">
          <span className="mobile-brand">
            <Wordmark href="/queue" />
          </span>
          <span className="who">
            Signed in as <strong>{session.fullName}</strong>
          </span>
        </div>
        <div className="topbar-right">
          {roles.length > 1 ? (
            <WorkspaceSelect roles={roles} active={ws} labels={ROLE_LABELS} action={switchWorkspaceAction} />
          ) : (
            <span className="badge">{ws ? ROLE_LABELS[ws] : ""}</span>
          )}
          {!config.isProduction && <span className="badge badge-yellow" title="Development adapters active">DEV</span>}
          <ThemeToggle initial={theme === "dark" || theme === "light" ? theme : null} />
          <form action={signOutAction}>
            <button className="btn btn-sm">Sign out</button>
          </form>
        </div>
      </header>
      <main className="main" id="main">
        {children}
      </main>
      <Footer />
      <IdleWatcher idleSeconds={config.sessionIdleSeconds} expiresAt={session.idleExpiresAt.toISOString()} />
    </div>
  );
}
