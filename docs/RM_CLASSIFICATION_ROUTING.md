# RM classification, Non-DBC routing and the Performance Overview

## What changed

### RM classification (Configuration centre → RM classification and routing)
- The Super Admin classifies every Relationship Manager: **Yes — DBC** (with a DBC region: South & West or North) or **No — Non-DBC** (with an assigned Regional Business Executive). A reason is mandatory; every change is audited (`RM_CLASSIFICATION_CHANGED`) with the previous and new values.
- Nothing is inferred from location. RMs not yet classified are listed under "Needs your attention" and keep the route in force before classification.
- A new RBE can be provisioned on the same page (email + name; added to the bank directory if needed; only the RBE role is granted, no product origination). Existing staff are never duplicated.
- Configured Unit Heads: DBC Unit Head — South & West, DBC Unit Head — North, E-commerce Unit Head. Each must hold the Unit Head (credit approval) role. If one is not set, a request reaching that stage waits in the assignment exception queue; no other Unit Head is substituted.
- Migration 049 maps "Seun Oladesu" and "Abubakar Musa 2" automatically **only** if exactly one active staff member with that exact name already holds the Unit Head role. Otherwise the Super Admin sets them on this page.

### Non-DBC route (confirmed)
RM → assigned RBE → CX credit review → Credit Officer for the amount (with the existing concurrence) → E-commerce Unit Head → Divisional Head → documentation.
- The RM cannot pick another RBE: the request goes to the RBE the Super Admin assigned (the WakeelBoost form shows it read-only).
- CX credit review records remarks (mandatory) and goes directly to the Credit Officer. There is no Product Manager stage.
- Credit Officer selection uses the configured credit bands (Approval workflows): CO1 up to ₦5,000,000, CO2 ₦5,000,000.01–₦20,000,000, CO3 ₦20,000,000.01–₦50,000,000, exact boundaries. Amounts outside the bands are refused at submission.
- A Non-DBC RM whose RBE is not active cannot submit.
- Applies to WakeelBoost, Vendor Financing, AltDrive and AltPower originated by Non-DBC RMs.

### DBC route
Unchanged stage order. The Unit Head approval goes to the configured DBC Unit Head for the RM's region.

### Pinning
The classification, RBE and Unit Head are pinned on each request at submission. Later changes apply to new requests; in-flight requests keep their route.

### Performance Overview (Reports → Performance reports)
- Executive summary: total requested / approved / disbursed, pending, declined, average approval turnaround, SLA breaches, pending disbursement confirmations.
- Financing trend (requested, approved, disbursed; daily, weekly or monthly by range) with hover details and a table view.
- Organisational performance with drill-down: Business line (DBC / Non-DBC / Merchant Officer line) → Unit Head or RBE → product → officer → location → facility, plus alternative orders (Unit Head, RBE, product, location, business unit, Merchant Officers).
- Officer performance table: searchable, sortable, opens the officer's facilities.
- Filters: date range with presets, business line, region, product, Unit Head / RBE, and more (business unit, officer, location, status, exceptions, invoice, SLA, disbursement). CSV export carries the same filters.
- Scope (enforced on the server): God's Eye, Super Admin, Reporting Admin — everything; Divisional Head — their Unit Heads' staff; Unit Head — staff mapped to them, plus the DBC RMs of their region if they are a configured DBC Unit Head; RBE — the RMs assigned to them; Merchant Officer Head — their Leads and officers.

## After deployment (Super Admin)
1. Configuration centre → RM classification and routing: set the two DBC Unit Heads and the E-commerce Unit Head.
2. Classify each RM (DBC + region, or Non-DBC + RBE). Provision any missing RBEs first.
3. Make sure at least one active CX Credit Reviewer exists (Staff → grant role).

## Weekly Divisional Head report (email)
- Sent every **Sunday at 18:00 Africa/Lagos** to every active staff member holding the **Divisional Head** role (plus any extra recipients the Super Admin ticks). Bank-wide.
- Covers **this week** (Monday 00:00 to the send time) and **month to date** (1st 00:00 to the send time), side by side:
  1. Financing headlines: requests submitted, final approvals, disbursed (count and ₦), declined, approval rate, average turnaround.
  2. Breakdown by business line (DBC / Non-DBC / Merchant Officer line / other) and by product.
  3. Approval efficiency: tasks completed per stage with average hours, 3-hour SLA reminders sent.
  4. Pipeline at the time of sending: open tasks per stage, how many are over 3 hours, oldest waiting.
  5. Controls: SeedFi exceptions, invoice confirmations, requests awaiting RM disbursement confirmation (and missing evidence).
  6. Top originators month to date. 7. Review and approval decisions this week by person.
  8. AltPhones and Staff Salary Advance.
  9. Every Unit Head and their direct reports: one table per Unit Head with their own work, then each person who reports to them (Reporting lines, plus the DBC RMs of a configured DBC Unit Head's region). For each person, this week and month to date: requests originated and amount, amount disbursed, AltPhones sales, decisions (approvals, endorsements, recommendations, returns, declines across all products) and all work actions recorded in the audit trail (screen views and system events excluded), and open tasks now (how many over 3 hours).
  10. Non-DBC business: the Non-DBC total, then one table per Regional Business Executive (their own approvals, then each Relationship Manager assigned to them), and a table of Relationship Managers not yet classified as DBC or Non-DBC.
  11. Merchant Officer line: one table per Merchant Officer Head (the Head, their Leads and the Leads' officers), plus any officers or Leads without a reporting line.
  12. Everyone else who did work in the month and is not already listed above (Credit Officers, CX, Credit Leads, disbursement and invoice officers, AltPhones staff, Product Managers, support roles …), named with their role.
  Sections 9–12 are number grids: for each person a Week row and an MTD row with Requests, Requested (₦), Disbursed (₦), AltPhones (when used), Decisions and Actions; each team ends with a TEAM TOTAL. On phones the amounts are shortened (₦77.0m) and headings abbreviated so every figure stays on one line; on desktop the exact amounts are shown.
  Every Relationship Manager is labelled "DBC South & West", "DBC North", "Non-DBC" or "not yet classified".
  Plus a button to the Performance Overview filtered to month to date.
- HTML email (tables that work in Outlook and on phones) with a plain-text copy. No customer identifiers.
- Administration → Scheduled emails: switch it on or off, change the Sunday time, add recipients. Every run is recorded; a recipient never gets the same week twice; a run missed while the worker was down is sent within three days.
