/**
 * Role-based walkthroughs. Each step points at a real element of the workspace (`data-tour`), usually a
 * navigation item the user can see only when they hold the permission. Steps whose element is not on the page
 * (feature not available to this user, or not built) are skipped automatically, never shown broken. Tours only
 * navigate and highlight: they never submit, approve or change anything.
 *
 * Bump GUIDE_VERSION when the content changes materially; existing users are not forced through it again
 * (they can replay it from Help & Guides).
 */

export const GUIDE_VERSION = 1;

export interface TourStep {
  title: string;
  body: string;
  /** `data-tour` value of the element to highlight; null = a general step (centred). */
  target: string | null;
  /** Page to open first (only pages the role can access). */
  href?: string;
}

const nav = (href: string) => `nav:${href}`;
const queue: TourStep = { title: "My Action Queue", body: "Everything waiting for you is here, oldest first, with how long it has waited. Open an item to review it and record your decision.", target: nav("/queue"), href: "/queue" };
const bell: TourStep = { title: "Notifications", body: "Alerts that need your attention (for example a skipped business photograph) appear here. The number shows unread items.", target: "bell" };
const help: TourStep = { title: "Help & Guides", body: "Replay this tour, or the guide for another of your roles, any time from your profile menu.", target: "profile-menu" };
const verify: TourStep = {
  title: "Before you proceed",
  body: "When you approve, certify, recommend or concur, ARAF asks you to confirm a short checklist for your role. Your decision and acknowledgement are recorded against your profile. Returning or rejecting only needs a reason.",
  target: null,
};

const RM: TourStep[] = [
  { title: "Start a financing application", body: "Begin a new request here. Choose one of four products: WakeelBoost, Vendor Financing, AltDrive or AltPower.", target: nav("/requests/new"), href: "/requests/new" },
  { title: "Choose the product", body: "Each card opens that product's own application, with its customer details, documents and checks. A product awaiting configuration says so on its card.", target: "new-request" },
  { title: "Customer, credit check and affordability", body: "In the request you enter the customer and business details, your location, run the SeedFi credit check, and see the live DSR / affordability result as you type.", target: nav("/requests/new") },
  { title: "Documents and submission", body: "Upload the required documents (the checklist shows what is missing), then submit. Submission goes to your Team Lead.", target: nav("/requests/new") },
  { title: "Track progress", body: "See every request you started, its current stage and who holds it.", target: nav("/requests"), href: "/requests" },
  { title: "Your performance", body: "Month-to-date disbursements against your approved target, your run rate and what is needed per remaining working day.", target: nav("/performance") },
  queue,
  bell,
  help,
];

const TL: TourStep[] = [
  { ...queue, body: "Requests awaiting your certification, and anything returned to you, are here." },
  { title: "Review the officer's assessment", body: "Open a request to see the customer, credit-check results, the RM's analysis and proposal, the DSR / affordability calculation and the documents. Verify the figures against the evidence.", target: nav("/queue") },
  { title: "Certify or return", body: "Certify when the analysis holds up, or return it to the officer with a reason. For Vendor Financing you may also need to upload or skip the business photograph.", target: nav("/queue") },
  verify,
  { title: "Team performance", body: "Your own originations and your team's total, side by side.", target: nav("/performance"), href: "/performance" },
  { title: "Team pipeline", body: "Where every team request sits, how long it has waited and what is outstanding.", target: nav("/dashboard") },
  { title: "Start your own application", body: "Where you are authorised, you can originate a request yourself; it then skips your own certification and goes to independent review.", target: nav("/requests/new") },
  bell,
  help,
];

const CX: TourStep[] = [
  { ...queue, body: "Your CX credit review queue: requests certified by the Team Lead and waiting for you." },
  { title: "Check the customer and application", body: "Confirm the customer information is consistent across the form, the credit check and the documents.", target: nav("/queue") },
  { title: "Verify documents and prior recommendations", body: "Review the supporting documents and the Team Lead's certification, record your final assessment and your observations.", target: nav("/queue") },
  { title: "Forward or return", body: "Approve to forward to the Unit Head, or return with a reason.", target: nav("/queue") },
  verify,
  bell,
  help,
];

const CREDIT: TourStep[] = [
  { ...queue, body: "Credit reviews and concurrence items assigned to you." },
  { title: "Review the complete application", body: "Inspect the officer's analysis, the business endorsement or Team Lead certification, the first credit review findings and any exceptions.", target: nav("/queue") },
  { title: "Record concurrence or return", body: "Concur (approve or proceed) when the assessment and risks are acceptable and within your authority, or return it with a reason.", target: nav("/queue") },
  verify,
  { title: "Exceptions", body: "Policy exceptions waiting for your authority appear here.", target: nav("/exceptions") },
  bell,
  help,
];

const DH: TourStep[] = [
  { ...queue, body: "Your final approval queue." },
  { title: "Review the approval history", body: "Each request shows every preceding decision, who made it and the comments, plus the approved assessment snapshot.", target: nav("/queue") },
  { title: "Assessment, risks and exceptions", body: "Check the financing assessment, conditions and any exceptions before you decide.", target: nav("/exceptions") },
  { title: "Approve, return or reject", body: "Your decision is final for the credit route.", target: nav("/queue") },
  verify,
  { title: "Management dashboards", body: "Institution-wide figures and breakdowns by location, product, team and RM.", target: nav("/dashboard") },
  { title: "God's Eye", body: "The read-only executive view across all products.", target: nav("/executive") },
  bell,
  help,
];

const UH: TourStep[] = [
  { title: "Unit pipeline", body: "Your unit's requests by stage, owner and waiting time, with breakdowns by location, product, team and RM.", target: nav("/dashboard"), href: "/dashboard" },
  { title: "Performance", body: "Targets and month-to-date performance (targets are proposed and approved here).", target: nav("/performance") },
  { ...queue, body: "Decisions assigned to you (for example the Unit Head approval on Vendor Financing, Alt Drive and Alt Power)." },
  verify,
  { title: "Start an application", body: "Where authorised you can originate a request; it never comes back to you for approval.", target: nav("/requests/new") },
  { title: "Altphones operations", body: "Pending location, BPM, import and stock approvals and data exceptions.", target: nav("/altphones/operations") },
  { title: "Approvals", body: "Location, BPM mapping, import and stock movement approvals for Altphones.", target: nav("/altphones/locations") },
  bell,
  help,
];

const SUPER_ADMIN: TourStep[] = [
  { title: "Users and role assignments", body: "Add staff from the bank directory and assign or remove roles. Changes are audited.", target: nav("/admin/staff"), href: "/admin/staff" },
  { title: "Locations", body: "Branches, AltLounges, Altshops and Altboxes. Altshops and Altboxes are activated through the Product Manager → Unit Head workflow.", target: nav("/admin/locations") },
  { title: "Products, pricing and tenor", body: "Product rules, mark-ups per contract type and repayment periods. Every change is approved by a second person.", target: nav("/admin/pricing") },
  { title: "Approval workflows", body: "View, change, simulate and publish each product's approval route. Publishing needs a reason, is recorded, and applies only to requests submitted afterwards.", target: nav("/admin/workflows") },
  { title: "Feature controls", body: "Switch controlled features on or off, with a reason. Every change is recorded.", target: nav("/admin/feature-controls") },
  { title: "Routing exceptions", body: "Requests that could not be assigned to an eligible reviewer.", target: nav("/admin/exceptions") },
  { title: "Audit records", body: "Every action, decision and administrative change, searchable and exportable.", target: nav("/admin/audit") },
  bell,
  help,
];

const DO_SA: TourStep[] = [
  { title: "New sale", body: "Start an Altphones sale: choose the phone, your location (State → Type → Location; the address fills in automatically), then the customer.", target: nav("/altphones"), href: "/altphones" },
  { title: "My sales", body: "Track your sales, approvals and handovers.", target: nav("/altphones/sales") },
  queue,
  bell,
  help,
];

const BPM: TourStep[] = [
  { title: "Reviews", body: "Smile Associate sales from the locations mapped to you wait here for your review.", target: nav("/altphones/reviews"), href: "/altphones/reviews" },
  verify,
  bell,
  help,
];

const ALT_PM: TourStep[] = [
  { title: "Reviews and reports", body: "Altphones applications waiting for product review, and reports.", target: nav("/altphones/reviews"), href: "/altphones/reviews" },
  { title: "Operations", body: "Pending approvals, turnaround, data exceptions and stock by location.", target: nav("/altphones/operations") },
  { title: "Locations and BPMs", body: "Propose locations, register addresses and request BPM mappings for Unit Head approval.", target: nav("/altphones/locations") },
  { title: "Inventory", body: "Stock by location, counts, transfers, returns and damaged stock.", target: nav("/altphones/inventory") },
  { title: "Portfolio and collections", body: "Facilities by repayment status and arrears, monthly collections, performance by location, officer and channel, and stock against the opening count. Open a facility to record a repayment.", target: nav("/altphones/portfolio") },
  { title: "Historical migration", body: "Stage and reconcile the register kept before ARAF.", target: nav("/altphones/migration") },
  verify,
  help,
];

const GENERIC: TourStep[] = [queue, bell, help];
const REPORTING: TourStep[] = [
  { title: "Reports and exports", body: "Reports for your scope, with CSV exports that never include customer identifiers.", target: nav("/reports"), href: "/reports" },
  { title: "Dashboards", body: "Pipeline, amounts and breakdowns.", target: nav("/dashboard") },
  { title: "God's Eye", body: "Institution-wide, read-only executive view.", target: nav("/executive") },
  help,
];
const STAFF: TourStep[] = [
  { title: "My staff financing", body: "Apply for staff financing, upload your documents and follow your request.", target: nav("/staff-request"), href: "/staff-request" },
  help,
];

const VENDOR: TourStep[] = [{ title: "Vendor register", body: "Register vendors and verify their bank accounts before they can be paid.", target: nav("/vendors"), href: "/vendors" }, queue, help];
const CONFIG: TourStep[] = [{ title: "Product configuration", body: "Approve or reject proposed product rule, pricing and tenor changes. You cannot approve a change you proposed.", target: nav("/admin/products"), href: "/admin/products" }, help];
const STAFF_PM: TourStep[] = [{ title: "Staff financing queues", body: "Staff financing requests waiting for your review, with the checks to complete.", target: nav("/staff-financing"), href: "/staff-financing" }, queue, help];
const COLLECTIONS: TourStep[] = [queue, { title: "Portfolio and collections", body: "Facilities by repayment status and arrears, monthly collections, performance by location, officer and channel, and stock against the opening count. Open a facility to record a repayment.", target: nav("/altphones/portfolio") }, { title: "Repayment monitoring", body: "Expected schedules against recorded repayments (when the tracker is switched on).", target: nav("/repayments") }, help];

/** The walkthrough for a role (every role defined in ARAF has one; unknown roles get the general guide). */
export function tourFor(role: string): TourStep[] {
  switch (role) {
    case "RM":
    case "ANM":
    case "MERCHANT_OFFICER":
      return RM;
    case "TEAM_LEAD":
    case "OUTLET_SERVICE_SUPERVISOR":
    case "RBE":
    case "MERCHANT_OFFICER_LEAD":
    case "ANM_LEAD_NORTH":
    case "ANM_LEAD_SOUTH":
      return TL;
    case "CX_CREDIT_REVIEWER":
      return CX;
    case "CREDIT_OFFICER_1":
    case "CREDIT_OFFICER_2":
    case "CREDIT_OFFICER_3":
    case "CREDIT_LEAD_1":
    case "CREDIT_LEAD_2":
    case "HEAD_OF_RETAIL_SALES":
    case "HEAD_OF_UNIT":
      return CREDIT;
    case "DIVISIONAL_HEAD":
      return DH;
    case "UNIT_HEAD":
      return UH;
    case "SUPER_ADMIN":
      return SUPER_ADMIN;
    case "DELIGHT_OFFICER":
    case "SMILE_ASSOCIATE":
      return DO_SA;
    case "BUSINESS_PERFORMANCE_MANAGER":
      return BPM;
    case "ALTPHONES_PRODUCT_MANAGER":
      return ALT_PM;
    case "REPORTING_ADMIN":
    case "EXECUTIVE_VIEW":
      return REPORTING;
    case "STAFF_APPLICANT":
      return STAFF;
    case "VENDOR_MANAGER":
      return VENDOR;
    case "PRODUCT_CONFIG_APPROVER":
      return CONFIG;
    case "PRODUCT_MANAGER":
      return STAFF_PM;
    case "COLLECTIONS_OFFICER":
      return COLLECTIONS;
    default:
      return GENERIC;
  }
}
