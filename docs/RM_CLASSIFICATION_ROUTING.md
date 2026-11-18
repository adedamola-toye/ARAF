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

## Weekly reports (email, every Sunday at 18:00 Africa/Lagos)

Both cover **this week** (Monday 00:00 to the send time, "Week") and **month to date** (1st 00:00 to the send time, "MTD").

### Divisional Head: totals only (bank-wide)
Sent to every active Divisional Head plus any extra recipients the Super Admin ticks. No individual rows.
1. Financing headlines: requests submitted, final approvals, disbursed (count and ₦), declined, approval rate, average turnaround.
2. Breakdown by business line (DBC / Non-DBC / Merchant Officer line / other) and by product.
3. Approval efficiency: tasks completed per stage with average hours, 3-hour SLA reminders sent.
4. Pipeline at the time of sending: open tasks per stage, how many are over 3 hours, oldest waiting.
5. Controls: SeedFi exceptions, invoice confirmations, requests awaiting RM disbursement confirmation (and missing evidence).
6. Decisions by stage: approvals, returns and declines.
7. AltPhones and Staff Salary Advance.
8. Units and teams, cumulative: one row per unit, adding up everyone in it — each Unit Head's unit (Unit Head + direct reports), each RBE's Non-DBC team, Relationship Managers not yet classified, each Merchant Officer line (Head + Leads + officers), Merchant Officers without a reporting line, and every other person who worked that month grouped by function (Credit, Operations, Retail business review, AltPhones, Agency banking, DBC RMs not in a unit, Staff Salary Advance, Management and control). Columns: Requests, Requested (₦), Disbursed (₦), AltPhones (when used), Decisions, Actions. The last row is **ALL STAFF**, each person counted once.

### Unit Heads and Team Leads: individual figures for their own team
Each Unit Head (their direct reports from Reporting lines, plus the DBC RMs of their region if they are a configured DBC Unit Head) and each Team Lead (the Relationship Managers on their team) receives a table with their own work, then one Week / MTD pair of rows per person, then a TEAM TOTAL. Each name shows the person's role, DBC / Non-DBC classification for RMs, and open tasks now (how many over 3 hours).

### Settings and delivery
- Administration → Scheduled emails: switch the Divisional Head report on or off, switch the Unit Head / Team Lead reports on or off, change the Sunday time, add recipients.
- HTML email that works in Outlook and on phones (on phones amounts are shortened, e.g. ₦77.0m, and headings abbreviated), with a plain-text copy. No customer identifiers.
- Every run is recorded; nobody receives the same week twice; a run missed while the worker was down is sent within three days.

## Who can open a request (read access)
Viewing a request never lets anyone act on it: actions still need the task to be assigned to them.
- The originator, every officer ever assigned a task on it, Legal / Shariah recipients after closure, the Invoice Confirmation Officer, and the existing retail scopes (assigned RM, Team Lead's team, outlet supervisor, retail leadership, exception authority, collections).
- **Super Admin:** every request, including drafts.
- **Supervisors** (submitted requests only), following the hierarchy RM → Team Lead → Unit Head → Divisional Head:
  - Team Lead: the requests of the RMs on their team, on every product.
  - Unit Head: the requests of everyone mapped to them in Reporting lines, of the RMs on the teams of the Team Leads mapped to them, of the DBC RMs of their region if they are a configured DBC Unit Head, of the states on their Unit Head role assignment, and of any request on which they are the pinned Unit Head.
  - Divisional Head: everything in the units of the Unit Heads mapped to them.
  - RBE: the requests of the RMs assigned to them. Merchant Officer Head: their Leads' and officers' requests.
- The Performance Overview uses the same rule, so every facility in a person's report can be opened by them.
