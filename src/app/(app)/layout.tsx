import { BookUser, Building2, Gauge, Landmark, MapPin, PackageCheck, ShieldAlert, Timer, Wallet, Percent, BarChart3, BookCheck, ClipboardList, FilePlus2, FileText, History, Inbox, LayoutGrid, Mail, Route, ShieldCheck, Users, UsersRound, CalendarClock } from "lucide-react";
import { requireUser } from "../_lib/auth";
import { themePreference } from "../_lib/theme";
import { BankMark, Footer, Wordmark } from "@/components/Brand";
import { AppearanceOptions } from "@/components/Appearance";
import { IdleWatcher } from "@/components/IdleWatcher";
import { MobileNavToggle, NavLink, WorkspaceSelect } from "@/components/NavLink";
import { ROLE_LABELS, isInitiatorRole, type Role } from "@/server/domain/roles";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { signOutAction, switchWorkspaceAction } from "./shell-actions";
import { retailScope as retailScopeFor } from "@/server/retail-reports";

const ic = { className: "icon", "aria-hidden": true } as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, roles } = await requireUser();
  const theme = await themePreference();
  const ws = session.activeRole as Role | null;
  const queueCount = Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1", [session.staffId])).rows[0].n);
  const isInitiatorWs = isInitiatorRole(ws);
  const retailScope = await retailScopeFor(db, session.staffId);
  const pendingExceptions = Number((await db.query(`SELECT count(*) AS n FROM policy_exceptions pe JOIN applications a ON a.id = pe.application_id WHERE pe.status = 'REQUESTED' AND pe.requested_by <> $1 AND a.initiator_id <> $1 AND pe.approver_role IN (SELECT role FROM role_assignments WHERE staff_id = $1 AND active)`, [session.staffId])).rows[0].n);
  const isApprover = roles.some((r) => ["HEAD_OF_RETAIL_SALES", "HEAD_OF_UNIT", "CREDIT_LEAD_1", "CREDIT_LEAD_2", "UNIT_HEAD", "DIVISIONAL_HEAD"].includes(r)) || pendingExceptions > 0;
  const isAdmin = roles.includes("SUPER_ADMIN");
  const canReport = roles.includes("SUPER_ADMIN") || roles.includes("REPORTING_ADMIN");
  const exceptions = isAdmin ? Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id IS NULL")).rows[0].n) : 0;
  const initials = session.fullName.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="shell">
      <nav className="sidenav" id="sidenav" aria-label="Main navigation">
        <div className="brand-block desktop-only">
          <Wordmark href="/queue" />
          <BankMark />
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
          {roles.includes("RM") && (
            <NavLink href="/wallet" icon={<Wallet {...ic} />}>
              Requested Today
            </NavLink>
          )}
          {isApprover && (
            <NavLink href="/exceptions" count={pendingExceptions} icon={<ShieldAlert {...ic} />}>
              Exceptions
            </NavLink>
          )}
          {retailScope && (
            <NavLink href="/dashboard" icon={<Gauge {...ic} />}>
              Retail dashboard
            </NavLink>
          )}
          {roles.includes("VENDOR_MANAGER") && (
            <NavLink href="/vendors" icon={<Building2 {...ic} />}>
              Vendor register
            </NavLink>
          )}
          {roles.includes("PRODUCT_CONFIG_APPROVER") && !isAdmin && (
            <NavLink href="/admin/products" icon={<PackageCheck {...ic} />}>
              Product configuration
            </NavLink>
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
            <NavLink href="/admin/directory" icon={<BookUser {...ic} />}>
              Bank directory
            </NavLink>
            <NavLink href="/admin/exceptions" count={exceptions} alert icon={<Route {...ic} />}>
              Routing exceptions
            </NavLink>
            <NavLink href="/admin/products" icon={<PackageCheck {...ic} />}>
              Products and rules
            </NavLink>
            <NavLink href="/admin/locations" icon={<MapPin {...ic} />}>
              Outlet locations
            </NavLink>
            <NavLink href="/admin/institutions" icon={<Landmark {...ic} />}>
              Banks and MFBs
            </NavLink>
            <NavLink href="/vendors" icon={<Building2 {...ic} />}>
              Vendor register
            </NavLink>
            <NavLink href="/admin/service-targets" icon={<Timer {...ic} />}>
              Service targets
            </NavLink>
            <NavLink href="/admin/groups" icon={<UsersRound {...ic} />}>
              Closure recipients
            </NavLink>
            <NavLink href="/admin/pricing" icon={<Percent {...ic} />}>
              WakeelBoost pricing
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
          {ws && <span className="ws-indicator desktop-only">{ROLE_LABELS[ws]} workspace</span>}
        </div>
        <div className="topbar-right">
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
              <div className="menu-section">
                <p className="menu-caption">Appearance</p>
                <AppearanceOptions initial={theme} />
              </div>
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
