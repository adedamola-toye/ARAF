import { Percent, BarChart3, BookCheck, ClipboardList, FilePlus2, FileText, History, Inbox, LayoutGrid, Mail, Route, ShieldCheck, Users, UsersRound, CalendarClock } from "lucide-react";
import { requireUser } from "../_lib/auth";
import { currentTheme } from "../_lib/theme";
import { Footer, Wordmark } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IdleWatcher } from "@/components/IdleWatcher";
import { MobileNavToggle, NavLink, WorkspaceSelect } from "@/components/NavLink";
import { ROLE_LABELS, isInitiatorRole, type Role } from "@/server/domain/roles";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { signOutAction, switchWorkspaceAction } from "./shell-actions";

const ic = { className: "icon", "aria-hidden": true } as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, roles } = await requireUser();
  const theme = await currentTheme();
  const ws = session.activeRole as Role | null;
  const queueCount = Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1", [session.staffId])).rows[0].n);
  const isInitiatorWs = isInitiatorRole(ws);
  const isAdmin = roles.includes("SUPER_ADMIN");
  const canReport = roles.includes("SUPER_ADMIN") || roles.includes("REPORTING_ADMIN");
  const exceptions = isAdmin ? Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id IS NULL")).rows[0].n) : 0;
  const initials = session.fullName.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="shell">
      <nav className="sidenav" id="sidenav" aria-label="Main navigation">
        <div className="brand-block desktop-only">
          <Wordmark href="/queue" />
          <span className="wordmark-app">WakeelBoost Work Desk</span>
        </div>
        <div className="nav-section">
          <span className="nav-title">Work</span>
          <NavLink href="/queue" count={queueCount} icon={<Inbox {...ic} />}>
            My Action Queue
          </NavLink>
          {isInitiatorWs && (
            <>
              <NavLink href="/requests/new" exact icon={<FilePlus2 {...ic} />}>
                Initiate New Request
              </NavLink>
              <NavLink href="/requests" exact icon={<ClipboardList {...ic} />}>
                View Progress
              </NavLink>
              <NavLink href="/booked" icon={<BookCheck {...ic} />}>
                Booked Requests
              </NavLink>
            </>
          )}
        </div>
        {canReport && (ws === "SUPER_ADMIN" || ws === "REPORTING_ADMIN") && (
          <div className="nav-section">
            <span className="nav-title">Reporting</span>
            <NavLink href="/reports" icon={<BarChart3 {...ic} />}>
              Reports &amp; exports
            </NavLink>
            <NavLink href="/booked" icon={<BookCheck {...ic} />}>
              Booked Requests
            </NavLink>
          </div>
        )}
        {isAdmin && ws === "SUPER_ADMIN" && (
          <div className="nav-section">
            <span className="nav-title">Administration</span>
            <NavLink href="/admin" exact icon={<LayoutGrid {...ic} />}>
              Overview
            </NavLink>
            <NavLink href="/admin/staff" icon={<Users {...ic} />}>
              Users &amp; roles
            </NavLink>
            <NavLink href="/admin/exceptions" count={exceptions} alert icon={<Route {...ic} />}>
              Routing exceptions
            </NavLink>
            <NavLink href="/admin/groups" icon={<UsersRound {...ic} />}>
              Closure recipients
            </NavLink>
            <NavLink href="/admin/pricing" icon={<Percent {...ic} />}>
              Pricing settings
            </NavLink>
            <NavLink href="/admin/templates" icon={<FileText {...ic} />}>
              Offer templates
            </NavLink>
            <NavLink href="/admin/schedules" icon={<CalendarClock {...ic} />}>
              Scheduled emails
            </NavLink>
            <NavLink href="/admin/outbox" icon={<Mail {...ic} />}>
              Email delivery
            </NavLink>
            <NavLink href="/admin/audit" icon={<History {...ic} />}>
              Audit trail
            </NavLink>
          </div>
        )}
        <div className="nav-section" style={{ marginTop: "auto" }}>
          <span className="nav-title">
            <ShieldCheck {...ic} /> {ws ? ROLE_LABELS[ws] : ""}
          </span>
        </div>
      </nav>
      <header className="topbar">
        <div className="topbar-left">
          <MobileNavToggle />
          <span className="mobile-only">
            <Wordmark href="/queue" />
          </span>
          <span className="small muted desktop-only">{ws ? `${ROLE_LABELS[ws]} workspace` : ""}</span>
        </div>
        <div className="topbar-right">
          <ThemeToggle initial={theme} />
          <details className="menu">
            <summary aria-label={`Profile menu for ${session.fullName}`}>
              <span className="avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="small desktop-only">{session.fullName}</span>
            </summary>
            <div className="menu-panel">
              <div>
                <strong>{session.fullName}</strong>
                <div className="small muted">{session.email}</div>
              </div>
              {roles.length > 1 ? (
                <WorkspaceSelect roles={roles} active={ws} labels={ROLE_LABELS} action={switchWorkspaceAction} />
              ) : (
                <span className="badge">{ws ? ROLE_LABELS[ws] : ""}</span>
              )}
              <div className="small muted">Sessions end after 5 minutes of inactivity.</div>
              <form action={signOutAction}>
                <button className="btn btn-block">Sign out</button>
              </form>
            </div>
          </details>
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
