import { GitBranch, Smartphone, Boxes, ClipboardCheck, BadgeCent, ListChecks, Settings2, BookUser, Building2, Gauge, Landmark, MapPin, PackageCheck, ShieldAlert, Timer, Wallet, Percent, BarChart3, BookCheck, ClipboardList, FilePlus2, FileText, History, Inbox, LayoutGrid, Mail, Route, ShieldCheck, Users, UsersRound, CalendarClock, Siren, Target, Bell, ToggleRight, FileCheck2, SlidersHorizontal, MessageSquareWarning, MessageSquarePlus, Headset, Radar, BookOpen } from "lucide-react";
import { isDesignatedEditor } from "@/server/domain/team-profiles";
import { requireUser } from "../_lib/auth";
import { staffFinancingAccess } from "@/server/staff/permission";
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
import { viewsFor, staffActionCount } from "@/server/staff/views";
import { altphonesAccess, reviewQueueCount } from "@/server/altphones/views";
import { portfolioAccess } from "@/server/altphones/portfolio";
import { migrationAccess } from "@/server/altphones/migration";
import { locationAccess } from "@/server/altphones/location-master";
import { dailySummary, summaryDue, targetAccess } from "@/server/domain/performance";
import { isEnabled } from "@/server/domain/switches";
import { unreadCount } from "@/server/domain/notifications";
import { onboardingDue } from "@/server/domain/onboarding";
import { tourFor } from "@/lib/onboarding/tours";
import { OnboardingRoot } from "@/components/Onboarding";
import { executiveAccess } from "@/server/executive";
import { crmNavCounts, crmPrincipal, isOversight } from "@/server/crm/core";
import Link from "next/link";
import { PerformanceSummary } from "@/components/Performance";
import { DailySummaryDialog } from "./performance/DailySummaryDialog";
import { BottomNav, type BottomItem } from "@/components/BottomNav";
import { HideAmountsButton, NavCollapseButton, ShellPrefsInit } from "@/components/ShellPrefs";
import "./araf-theme.css";

const ic = { className: "icon", "aria-hidden": true } as const;
/** Roles that review or approve requests: they get "Requests I approved". */
const APPROVER_NAV_ROLES: readonly string[] = ["RBE", "UNIT_HEAD", "DIVISIONAL_HEAD", "TEAM_LEAD", "HEAD_OF_RETAIL_SALES", "HEAD_OF_UNIT", "OUTLET_SERVICE_SUPERVISOR", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD", "ANM_LEAD_NORTH", "ANM_LEAD_SOUTH", "CX_CREDIT_REVIEWER", "CREDIT_OFFICER_1", "CREDIT_OFFICER_2", "CREDIT_OFFICER_3", "CREDIT_LEAD_1", "CREDIT_LEAD_2", "DISBURSEMENT_OFFICER_1", "DISBURSEMENT_OFFICER_2", "INVOICE_CONFIRMATION_OFFICER"];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, roles } = await requireUser();
  const theme = await themePreference();
  const ws = session.activeRole as Role | null;
  const queueCount = Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1", [session.staffId])).rows[0].n);
  const altWs = ws === "DELIGHT_OFFICER" || ws === "SMILE_ASSOCIATE";
  // Team Leads and Unit Heads may also originate retail requests (never reviewing their own).
  const isInitiatorWs = (isInitiatorRole(ws) || ws === "TEAM_LEAD" || ws === "UNIT_HEAD" || ws === "MERCHANT_OFFICER_LEAD" || ws === "MERCHANT_OFFICER_HEAD") && !altWs;
  const alt = await altphonesAccess(db, session.staffId);
  const altPortfolio = await portfolioAccess(db, session.staffId);
  const altMigration = (await migrationAccess(db, session.staffId)).view;
  const altLocations = (await locationAccess(db, session.staffId)).view;
  const altReviewCount = alt.reviewer ? await reviewQueueCount(db, session.staffId) : 0;
  const retailScope = await retailScopeFor(db, session.staffId);
  const pendingExceptions = Number((await db.query(`SELECT count(*) AS n FROM policy_exceptions pe JOIN applications a ON a.id = pe.application_id WHERE pe.status = 'REQUESTED' AND pe.requested_by <> $1 AND a.initiator_id <> $1 AND pe.approver_role IN (SELECT role FROM role_assignments WHERE staff_id = $1 AND active)`, [session.staffId])).rows[0].n);
  const isApprover = roles.some((r) => ["HEAD_OF_RETAIL_SALES", "HEAD_OF_UNIT", "CREDIT_LEAD_1", "CREDIT_LEAD_2", "UNIT_HEAD", "DIVISIONAL_HEAD"].includes(r)) || pendingExceptions > 0;
  const isAdmin = roles.includes("SUPER_ADMIN");
  const canReport = roles.includes("SUPER_ADMIN") || roles.includes("REPORTING_ADMIN");
  const exceptions = isAdmin ? Number((await db.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id IS NULL")).rows[0].n) : 0;
  // Staff Financing appears only for profiles the backend policy authorises (e.g. never for Smile Associates).
  const staffOk = (await staffFinancingAccess(db, session.staffId)).allowed;
  const staffViews = staffOk ? viewsFor(new Set(roles)) : [];
  const staffQueueCount = staffViews.length ? await staffActionCount(db, session.staffId, new Set(roles)) : 0;
  const myOfferCount = staffOk ? Number((await db.query("SELECT count(*) AS n FROM staff_requests WHERE applicant_id = $1 AND status = 'AWAITING_SIGNED_OFFER' AND signed_offer_received_at IS NULL", [session.staffId])).rows[0].n) : 0;
  // Once a Lagos day, Relationship Managers and Team Leads see their performance summary first.
  // First time in this role's workspace: the welcome guide takes priority over the daily summary.
  const tourRole = ws ?? roles[0] ?? null;
  const welcomeDue = await onboardingDue(db, session.staffId, tourRole);
  const tours = [...new Set([tourRole, ...roles].filter(Boolean) as string[])].map((r) => ({ role: r, label: ROLE_LABELS[r as Role] ?? r, steps: tourFor(r) }));
  const summary = !welcomeDue && (await summaryDue(db, session.staffId, new Date())) ? await dailySummary(db, session.staffId, new Date()) : null;
  const perfTargets = await targetAccess(db, session.staffId);
  const showPerformance = roles.includes("RM") || roles.includes("TEAM_LEAD") || perfTargets.propose || perfTargets.approve;
  const showTracker = isAdmin || (retailScope?.kind === "ALL" && (await isEnabled(db, "REPAYMENT_TRACKER")));
  const unread = await unreadCount(db, session.staffId);
  const godsEye = await executiveAccess(db, session.staffId);
  const icOfficer = roles.includes("INVOICE_CONFIRMATION_OFFICER");
  const isDh = roles.includes("DIVISIONAL_HEAD");
  const teamEditor = roles.includes("TEAM_LEAD") && (await isDesignatedEditor(db, session.staffId));
  const isCad = roles.includes("DISBURSEMENT_OFFICER_1") || roles.includes("DISBURSEMENT_OFFICER_2");
  const icCount = icOfficer ? Number((await db.query("SELECT count(*) AS n FROM invoice_confirmations WHERE status = 'PENDING' AND officer_id = $1", [session.staffId])).rows[0].n) : 0;
  const creditExceptionsView = roles.some((r) => ["SUPER_ADMIN", "UNIT_HEAD", "TEAM_LEAD", "DIVISIONAL_HEAD", "EXECUTIVE_VIEW", "REPORTING_ADMIN"].includes(r));
  // The CRM menu must never take the app down (e.g. the web release goes live before the worker has applied migration 052).
  const crm = await crmPrincipal(db, session.staffId).catch(() => ({ staffId: session.staffId, active: true, isAdmin: false, isCxHead: false, leadTeams: [] as string[], officerTeams: [] as string[] }));
  const crmCounts = await crmNavCounts(db, crm).catch(() => ({ assigned: 0, unassigned: 0, escalated: 0 }));
  const showReports = godsEye || roles.some((r) => ["SUPER_ADMIN", "REPORTING_ADMIN", "UNIT_HEAD", "DIVISIONAL_HEAD", "EXECUTIVE_VIEW", "RBE", "MERCHANT_OFFICER_HEAD"].includes(r));
  // Mobile bottom navigation: four destinations for the person's main job, plus More (the full menu).
  const approverOnly = !isInitiatorWs && roles.some((r) => APPROVER_NAV_ROLES.includes(r));
  const bottom: BottomItem[] = [
    ...(altWs && alt.originator ? [{ href: "/altphones", label: "New sale", icon: "altphones" as const, exact: true }] : []),
    ...(!isInitiatorWs && !approverOnly && !altWs && staffOk ? [{ href: "/staff-request", label: "Advance", icon: "salary" as const, count: myOfferCount }] : []),
    { href: "/queue", label: "Queue", icon: "queue" as const, count: queueCount },
    ...(isInitiatorWs ? [{ href: "/requests/new", label: "New", icon: "new" as const }] : []),
    ...(approverOnly ? [{ href: "/requests/approved", label: "Approved", icon: "approved" as const }] : []),
    { href: "/crm", label: "CRM", icon: "crm" as const },
    { href: "/notifications", label: "Alerts", icon: "bell" as const, count: unread },
  ];
  const initials = session.fullName.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="shell">
      <nav className="sidenav" id="sidenav" aria-label="Main navigation">
        <div className="brand-block desktop-only">
          <Wordmark href="/overview" />
          <BankMark />
        </div>
        <div className="nav-section">
          <span className="nav-title">Workspace</span>
          {!(roles.length === 1 && roles[0] === "STAFF_APPLICANT") && (
            <NavLink href="/overview" icon={<LayoutGrid {...ic} />}>
              Overview
            </NavLink>
          )}
          <NavLink href="/queue" count={queueCount} icon={<Inbox {...ic} />}>
            My Action Queue
          </NavLink>
          <NavLink href="/notifications" count={unread} icon={<Bell {...ic} />}>
            Notifications
          </NavLink>
        </div>
        {(isInitiatorWs || roles.some((r) => APPROVER_NAV_ROLES.includes(r)) || roles.includes("RM")) && (
          <div className="nav-section">
            <span className="nav-title">Applications</span>
            {isInitiatorWs && (
              <>
                <NavLink href="/requests/new" icon={<FilePlus2 {...ic} />}>
                  New Financing Request
                </NavLink>
                <NavLink href="/requests" exact icon={<ClipboardList {...ic} />}>
                  View Progress
                </NavLink>
                <NavLink href="/offers" icon={<FileText {...ic} />}>
                  Offer letters
                </NavLink>
                <NavLink href="/booked" icon={<BookCheck {...ic} />}>
                  Booked Requests
                </NavLink>
              </>
            )}
            {roles.some((r) => APPROVER_NAV_ROLES.includes(r)) && (
              <NavLink href="/requests/approved" icon={<ListChecks {...ic} />}>
                Requests I approved
              </NavLink>
            )}
            {roles.includes("RM") && (
              <NavLink href="/wallet" icon={<Wallet {...ic} />}>
                Requested Today
              </NavLink>
            )}
          </div>
        )}
        {(icOfficer || isApprover || isDh || isCad || teamEditor || (showTracker && !altWs) || roles.includes("VENDOR_MANAGER")) && (
          <div className="nav-section">
            <span className="nav-title">Operations</span>
            {isDh && (
              <NavLink href="/bouquets" icon={<Landmark {...ic} />}>
                Concurrence
              </NavLink>
            )}
            {teamEditor && (
              <NavLink href="/team" icon={<UsersRound {...ic} />}>
                My team
              </NavLink>
            )}
            {isCad && (
              <NavLink href="/disbursements" icon={<BadgeCent {...ic} />}>
                Disbursements
              </NavLink>
            )}
            {icOfficer && (
              <NavLink href="/invoice-confirmation" count={icCount} icon={<FileCheck2 {...ic} />}>
                Invoice confirmation
              </NavLink>
            )}
            {isApprover && (
              <NavLink href="/exceptions" count={pendingExceptions} icon={<ShieldAlert {...ic} />}>
                Exceptions
              </NavLink>
            )}
            {showTracker && !altWs && (
              <NavLink href="/repayments" icon={<CalendarClock {...ic} />}>
                Repayment monitoring
              </NavLink>
            )}
            {roles.includes("VENDOR_MANAGER") && (
              <NavLink href="/vendors" icon={<Building2 {...ic} />}>
                Vendor register
              </NavLink>
            )}
          </div>
        )}
        {!altWs && (showReports || creditExceptionsView || showPerformance || godsEye || retailScope || (roles.includes("PRODUCT_CONFIG_APPROVER") && !isAdmin) || (canReport && (ws === "SUPER_ADMIN" || ws === "REPORTING_ADMIN"))) && (
          <div className="nav-section">
            <span className="nav-title">Performance and governance</span>
            {showPerformance && (
              <NavLink href="/performance" icon={<Target {...ic} />}>
                {roles.includes("RM") || roles.includes("TEAM_LEAD") ? "My performance" : "Performance targets"}
              </NavLink>
            )}
            {showReports && (
              <NavLink href="/reports/performance" icon={<BarChart3 {...ic} />}>
                Performance reports
              </NavLink>
            )}
            {retailScope && (
              <NavLink href="/dashboard" icon={<Gauge {...ic} />}>
                Retail dashboard
              </NavLink>
            )}
            {godsEye && (
              <NavLink href="/executive" icon={<Gauge {...ic} />}>
                God&apos;s Eye
              </NavLink>
            )}
            {creditExceptionsView && (
              <NavLink href="/reports/credit-exceptions" icon={<ShieldAlert {...ic} />}>
                Credit score exceptions
              </NavLink>
            )}
            {canReport && (ws === "SUPER_ADMIN" || ws === "REPORTING_ADMIN") && (
              <>
                <NavLink href="/reports" exact icon={<BarChart3 {...ic} />}>
                  Reports &amp; exports
                </NavLink>
                {!isInitiatorWs && (
                  <NavLink href="/booked" icon={<BookCheck {...ic} />}>
                    Booked Requests
                  </NavLink>
                )}
              </>
            )}
            {roles.includes("PRODUCT_CONFIG_APPROVER") && !isAdmin && (
              <NavLink href="/admin/products" icon={<PackageCheck {...ic} />}>
                Product configuration
              </NavLink>
            )}
          </div>
        )}
        {(alt.any || altMigration || altLocations || altPortfolio) && (
          <div className="nav-section">
            <span className="nav-title">Altphones</span>
            {alt.originator && (altWs || !isInitiatorRole(ws)) && (
              <>
                <NavLink href="/altphones" exact icon={<Smartphone {...ic} />}>
                  New sale
                </NavLink>
                <NavLink href="/altphones/sales" icon={<ClipboardList {...ic} />}>
                  My sales
                </NavLink>
              </>
            )}
            {(alt.pm || alt.admin || (alt.reviewer && roles.includes("UNIT_HEAD"))) && (
              <NavLink href="/altphones/operations" icon={<BarChart3 {...ic} />}>
                Operations
              </NavLink>
            )}
            {altPortfolio && (
              <NavLink href="/altphones/portfolio" icon={<Wallet {...ic} />}>
                Portfolio
              </NavLink>
            )}
            {(alt.reviewer || alt.pm || alt.admin) && (
              <NavLink href="/altphones/reviews" count={altReviewCount} icon={<ClipboardCheck {...ic} />}>
                Reviews and reports
              </NavLink>
            )}
            {alt.inventory && (
              <NavLink href="/altphones/inventory" icon={<Boxes {...ic} />}>
                Inventory
              </NavLink>
            )}
            {altLocations && (
              <NavLink href="/altphones/locations" icon={<MapPin {...ic} />}>
                Locations
              </NavLink>
            )}
            {altMigration && (
              <NavLink href="/altphones/migration" icon={<History {...ic} />}>
                Historical migration
              </NavLink>
            )}
            {(alt.pm || alt.admin) && (
              <NavLink href="/altphones/manage" icon={<Settings2 {...ic} />}>
                Altphones settings
              </NavLink>
            )}
          </div>
        )}
        <div className="nav-section">
          <span className="nav-title">CRM</span>
          <NavLink href="/crm" exact icon={<Headset {...ic} />}>
            CRM Home
          </NavLink>
          <NavLink href="/crm/new" icon={<MessageSquarePlus {...ic} />}>
            Raise Complaint
          </NavLink>
          <NavLink href="/crm/tickets" icon={<MessageSquareWarning {...ic} />}>
            My Tickets
          </NavLink>
          {crm.officerTeams.length > 0 && (
            <NavLink href="/crm/work" count={crmCounts.assigned} icon={<Inbox {...ic} />}>
              Assigned to Me
            </NavLink>
          )}
          {crm.leadTeams.length > 0 && (
            <NavLink href="/crm/team" count={crmCounts.unassigned} icon={<UsersRound {...ic} />}>
              Team Queue
            </NavLink>
          )}
          {isOversight(crm) && (
            <>
              <NavLink href="/crm/cx" exact icon={<Radar {...ic} />}>
                CX Command Centre
              </NavLink>
              <NavLink href="/crm/all" icon={<ClipboardList {...ic} />}>
                All Complaints
              </NavLink>
              <NavLink href="/crm/sla" icon={<Timer {...ic} />}>
                SLA Monitoring
              </NavLink>
              <NavLink href="/crm/escalations" count={crmCounts.escalated} alert icon={<Siren {...ic} />}>
                Escalations
              </NavLink>
              <NavLink href="/crm/performance" icon={<Gauge {...ic} />}>
                Team Performance
              </NavLink>
              <NavLink href="/crm/reports" icon={<BarChart3 {...ic} />}>
                CX Reports
              </NavLink>
            </>
          )}
          {(isOversight(crm) || crm.officerTeams.length > 0) && (
            <NavLink href="/crm/kb" icon={<BookOpen {...ic} />}>
              Knowledge base
            </NavLink>
          )}
          {isAdmin && (
            <NavLink href="/admin/crm" icon={<SlidersHorizontal {...ic} />}>
              CRM configuration
            </NavLink>
          )}
        </div>
        {staffOk && (
          <div className="nav-section">
            <span className="nav-title">Staff Salary Advance</span>
            <NavLink href="/staff-request" count={myOfferCount} icon={<BadgeCent {...ic} />}>
              My salary advance
            </NavLink>
            {staffViews.length > 0 && (
              <NavLink href="/staff-financing" count={staffQueueCount} icon={<ListChecks {...ic} />}>
                Salary advance queues
              </NavLink>
            )}
            {(roles.includes("SALARY_REGISTER_ADMIN") || isAdmin) && (
              <NavLink href="/admin/salary-register" icon={<BookUser {...ic} />}>
                Salary register
              </NavLink>
            )}
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
            <NavLink href="/admin/configuration" icon={<SlidersHorizontal {...ic} />}>
              Configuration centre
            </NavLink>
            <NavLink href="/admin/product-settings" icon={<PackageCheck {...ic} />}>
              Product settings
            </NavLink>
            <NavLink href="/admin/pricing" icon={<Percent {...ic} />}>
              Pricing and tenor
            </NavLink>
            <NavLink href="/admin/workflows" icon={<GitBranch {...ic} />}>
              Approval workflows
            </NavLink>
            <NavLink href="/admin/feature-controls" icon={<ToggleRight {...ic} />}>
              Feature controls
            </NavLink>
            <NavLink href="/admin/bouquet-settings" icon={<SlidersHorizontal {...ic} />}>
              Bouquet settings
            </NavLink>
            <NavLink href="/admin/profile-editors" icon={<Users {...ic} />}>
              Team profile editors
            </NavLink>
            <NavLink href="/admin/staff-financing" icon={<Settings2 {...ic} />}>
              Salary advance settings
            </NavLink>
            <NavLink href="/admin/salary-register" icon={<BookUser {...ic} />}>
              Salary register
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
            <NavLink href="/admin/incidents" icon={<Siren {...ic} />}>
              Incidents
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
          <NavCollapseButton />
          <span className="mobile-only">
            <Wordmark href="/overview" />
          </span>
          {ws && <span className="ws-indicator desktop-only">{ROLE_LABELS[ws]} workspace</span>}
        </div>
        <div className="topbar-right">
          <HideAmountsButton />
          <Link href="/notifications" className="bell" data-tour="bell" aria-label={unread ? `Notifications: ${unread} unread` : "Notifications"}>
            <Bell className="icon" aria-hidden="true" />
            {unread > 0 && <span className="bell-count">{unread > 99 ? "99+" : unread}</span>}
          </Link>
          <details className="menu" data-tour="profile-menu">
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
              <Link href="/help" className="btn btn-block btn-ghost">
                Help &amp; Guides
              </Link>
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
        <OnboardingRoot role={tourRole} roleLabel={tourRole ? (ROLE_LABELS[tourRole as Role] ?? tourRole) : ""} showWelcome={welcomeDue} tours={tours} />
        {summary && (
          <DailySummaryDialog name={session.fullName}>
            <PerformanceSummary s={summary} />
          </DailySummaryDialog>
        )}
      </main>
      <Footer />
      <BottomNav items={bottom} />
      <ShellPrefsInit />
      <IdleWatcher idleSeconds={config.sessionIdleSeconds} expiresAt={session.idleExpiresAt.toISOString()} />
    </div>
  );
}
