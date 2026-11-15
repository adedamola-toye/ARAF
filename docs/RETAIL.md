# AltBank Retail Asset Factory: retail products

This guide covers retail financing: **Vendor Financing**, **Alt Drive** and **Alt Power**. It explains how they run on the shared workflow engine, which rules are configured and which decisions are still outstanding. The legacy WakeelBoost workflow is unchanged (see [WORKFLOW.md](WORKFLOW.md)).

## 1. Lifecycle and routing

```
DRAFT ─submit─▶ [OSS_REVIEW]* ─▶ TEAM_LEAD_REVIEW ─▶ HRS_REVIEW ─▶ [HEAD_OF_UNIT_APPROVAL]**
      ─▶ FIRST_CREDIT_REVIEW (credit appraisal + final assessment) ─▶ SECOND_CREDIT_REVIEW (independent)
      ─▶ UNIT_HEAD_REVIEW ─▶ DIVISIONAL_HEAD_REVIEW                   (existing credit route table, by amount)
      ─▶ OFFER_PREPARATION (approved template + contract sequence) ─▶ CO3_PACK_REVIEW
      ─▶ DISBURSEMENT_CHECK (CRMS evidence + attestation, beneficiary revalidation)
      ─▶ DISBURSEMENT_BOOKING (facility booked; no payment implied)
      ─▶ PAYMENT_RECONCILIATION (payment events with evidence; reconciled by a different disbursement officer)
      ─▶ COMPLETION (closure pack) ─▶ FULFILMENT (POS deployment / delivery / installation / handover) ─▶ COMPLETED

*  Delight Officer route only: the Outlet Service Supervisor mapped to the originating outlet.
** Head of Unit stage while the product's configuration says DISTINCT (the default).
Any review stage: Return (to the initiator, with reason and recipient) or Decline.
Withdrawal (initiator, before booking), suspension (Super Admin or Head of Retail Sales), draft expiry (configured days).
```

| Stage | Who (routing scope) | Decision meaning |
|---|---|---|
| OSS_REVIEW | Outlet Service Supervisor mapped to the outlet | Business review |
| TEAM_LEAD_REVIEW | Team Lead whose team matches the request's team | Business review |
| HRS_REVIEW | Any Head of Retail Sales (organisation) | Business review |
| HEAD_OF_UNIT_APPROVAL | Head of Unit who has not decided earlier on the case | Business approval (not credit) |
| FIRST/SECOND credit, Unit Head, Divisional Head | Existing credit roles, excluding everyone involved in business review | Credit |
| PAYMENT_RECONCILIATION | Disbursement Officer 1 (never the officer who booked) | Operational |

When no eligible reviewer is in scope, the task opens unassigned and appears under **Administration → Routing exceptions**, with the reason (for example "No Outlet Service Supervisor is mapped to the originating outlet"). Reassignment is limited to staff within the same scope and is audited.

**Separate states.**
- **Application**: `applications.status`/`stage`.
- **Facility**: `facilities.status`, one of BOOKED, ACTIVE, IN_ARREARS, RESTRUCTURED, SETTLED, CLOSED.
- **Payment**: `facilities.payment_status` plus the append-only `payment_events`.
- **Fulfilment**: `fulfilment_tasks` and `facilities.fulfilment_status`.

A COMPLETED application keeps its facility ACTIVE until repayments settle it and a Collections officer closes it.

**Material changes** reset the review. These are principal, tenor, structure, profile, repayment capacity, asset, vendor, beneficiary and customer identity. A resubmission with any of them changed:
- invalidates every business and credit approval;
- supersedes assessments, generated and signed offers, and exceptions;
- records a new preliminary assessment;
- restarts at the first business review stage.

Non-material corrections go back to the stage (and person) that asked.

### CX approval policy (`RETAIL_CX_V1`)

Each product configuration version names its **approval chain** (*Approval chain* in Products and rules). The chain is pinned on a request at first submission; requests already submitted keep theirs. Migration 025 proposes `RETAIL_CX_V1` for Vendor Financing, Alt Drive and Alt Power (with the affordability policy); it applies once a Product Config Approver approves those versions.

```
Initiator (RM, Delight Officer, Team Lead or Unit Head) ─submit─▶ TEAM_LEAD_REVIEW ("Team Lead certification")
  ─certify─▶ FIRST_CREDIT_REVIEW ("CX credit review", role CX_CREDIT_REVIEWER, final assessment, no amount routes)
  ─approve─▶ UNIT_HEAD_REVIEW ─approve─▶ DIVISIONAL_HEAD_REVIEW ─approve─▶ OFFER_PREPARATION … (existing post-approval)
Any stage: Return (with reason) or Reject (with reason).
```

The Head of Retail Sales, Head of Unit, Outlet Service Supervisor and second credit review stages are not used under this policy. The CX Credit Reviewer role is granted by a Super Admin like any role; holding Super Admin never confers it.

**Originators who hold an approval role.** Team Leads and Unit Heads can initiate requests on CX-policy products (Initiate New Request); they write their own credit proposal (first-level analysis). Routing rules, applied on the server and recorded as `ROUTING_RULE_APPLIED` with the rule and reason:

| Rule | When | Effect |
|---|---|---|
| `TL_ORIGINATOR_CERTIFICATION` | A Team Lead originates | Team Lead certification is skipped; the request goes to CX credit review |
| `UH_ORIGINATOR_CERTIFICATION` | A Unit Head originates | Team Lead certification is skipped; the request goes to CX credit review |
| `UH_ORIGINATOR_UNIT_HEAD_STAGE` | A Unit Head originates and no other Unit Head is eligible | The Unit Head stage is skipped; the request goes to the Divisional Head |

CX credit review and the Divisional Head are never skipped. Everyone who acted earlier on a request (including its originator) is excluded from later stages; when nobody is eligible the task opens unassigned in the assignment exception queue. Team Leads and Unit Heads cannot submit products still on the standard chain.

## 2. Configuration (Administration → Products and rules)

Each product has versioned rules (`product_configs`).
- **Maker-checker:** a Super Admin proposes a version. A different person holding `PRODUCT_CONFIG_APPROVER` approves it.
- **Effective date:** each version takes effect from its effective date.
- **Pinning:** an application keeps the version in force when it was submitted. The final credit assessment records the version it used.
- **Visible blocking:** every parameter the bank has not supplied is `null` and appears in **Configuration required** with the action it blocks. Nothing is inherited from another product.

Version 1 of each product holds only the supplied parameters:

| Product / profile | Supplied | Not supplied (blocks) |
|---|---|---|
| Vendor Financing, registered businesses | ₦50m max, 12-month tenor, DSR 30%, 23% flat, CAC, vendor confirmation email, formal request letter (replaces consent form), 4 photographs + RM photo, RM proposal, AFS above ₦20m, POS deployment after disbursement | DSR denominator, statement period (submission); rate convention (final calculation, offer); insurance treatment (offer); AFS exception authority; visit requirement (Team Lead review); contract sequence |
| Alt Drive salary earners | Employment/salary confirmation, credit report, 3 payslips, 6 months' statements, DSR 33%, vehicle invoice, Murabaha 34% (customer insures), Ijarah 39.5% (bank insures) | Max amount, tenor, DSR denominator, equity rule, vehicle eligibility (submission); rate conventions; visit requirement; contract sequences |
| Alt Drive business owners | CAC, 12 months' statements, DSR 10% (a DSR threshold, **not** a turnover cap), credit report at appraisal, vehicle invoice, RM proposal, structures and rates as above | As for salary earners |
| Alt Power salary earners | Employment confirmation, credit report, income evidence, statements, DSR 33%, supplier quotation | Structure, rate, insurance, max amount, tenor, statement and payslip periods, DSR denominator |
| Alt Power business owners | CAC, business statements, credit report, operations evidence, supplier quotation, RM proposal | DSR threshold, pricing, structure, max amount, tenor, statement period, DSR denominator |

Rate conventions supported:
- **Flat per annum:** profit = P × r × n/12.
- **Flat for the tenor:** profit = P × r.
- **Flat per month:** profit = P × r × n.

The convention is chosen per structure; nothing is assumed. Reducing-balance pricing is not implemented (see limitations).

## 3. Affordability (versioned engine `retail-affordability@2`)

DSR = (existing monthly obligations + proposed monthly obligation) ÷ configured monthly denominator × 100.
- **Preliminary (at submission):** uses the proposed obligation calculated from the terms when the convention is configured. Otherwise it uses the initiator's estimate, flagged as such.
- **Final (credit appraisal):** recorded by the first credit reviewer from verified inputs. It is blocked until the rate and convention are configured.
- **Arithmetic:** exact BigInt rationals. Thresholds compare unrounded values; display rounds to 4 decimal places.
- **Separate rules:** the principal-to-turnover cap is its own optional rule.
- **Snapshots:** every assessment stores its rules, inputs, outputs and formula lines. Assessments are immutable (enforced by database trigger).

**Retail affordability policy (business decision, engine `retail-affordability@2`).** For Vendor Financing, Alt Drive and Alt Power:
- **Average monthly inflow** = verified annual inflow × inflow recognised ÷ 12. The recognition factor is configurable per profile (*Inflow recognised for affordability*, default **100%**); a conservative 70–80% can be set later through a configuration version.
- **Allowable monthly obligations** = average monthly inflow × the maximum DSR (**30%**). DSR = (existing monthly obligations + proposed instalment) ÷ average monthly inflow.
- **Minimum repayment period: 12 months** (*Minimum repayment period* per profile). WakeelBoost keeps its 10% limit and its own minimum.
- These values were added by migration 025 as a **proposed** configuration version for each product; they apply once a Product Config Approver approves them (Administration → Products and rules).
- **At origination** the initiator enters the verified annual inflow; a live panel shows annual inflow, recognised share, average monthly inflow, existing obligations, requested amount, tenor, pricing, proposed repayment, allowable obligations, DSR, threshold and the outcome (*within approved threshold*, *exceeds approved threshold*, *incomplete assessment*). The saved preliminary assessment (server-side, exact) is the record.
- **Credit review:** the reviewer's final assessment may change inputs only with a reason; each change (previous value, revised value, reason, reviewer, time, evidence documents) is recorded as `CREDIT_ASSESSMENT_ADJUSTED`, and earlier assessments are kept.

DSR failures block submission and approval. A DSR exception is possible only when the configuration permits it and names the approving role.

## 4. Documents, photographs, proposals and exceptions

- **Matrix:** the document matrix is keyed by product, profile, structure, amount band and stage. Each item shows mandatory, conditional or optional, and its status: received, missing, rejected (scan or reviewer), expired (coverage), exception-approved or not applicable.
- **Coverage:** statements and payslips carry coverage dates. The required months come from configuration.
- **Photographs:** each one carries an angle. At least N distinct angles (distinct files) are required. The "RM with the business" photograph must be uploaded by the responsible RM, and the Team Lead confirms its content. **No automatic image verification is claimed.**
- **Credit proposal:** structured and versioned (`credit_proposals`). For Delight Officer cases it is written by the explicitly assigned RM.
- **AFS exceptions:** apply to Vendor Financing above ₦20m. They need the configured authority, a reason of at least 10 characters and evidence. The requester, initiator and assigned RM cannot approve.

## 5. Beneficiaries and institutions

- **Institution directory (Administration → Banks and MFBs):** load the current CBN list and the payment provider's routing codes by CSV (sample: `docs/financial-institutions.sample.csv`). Regulatory status is recorded as supplied, never asserted by the platform.
- **Vendor register (Vendor register):** accounts are usable only when ACTIVE and VERIFIED by a different officer. No name-enquiry integration is connected, so verification is manual with an evidence note. Status shows pending, verified, failed or unavailable.
- **Snapshot and revalidation:** the beneficiary snapshot is stored on the submitted version. It is revalidated at credit approval, pre-disbursement, booking and reconciliation. Any register change after approval blocks progress until the initiator updates it, which triggers re-approval.

## 6. Request wallet

`request_ledger` has one immutable row per application, written in the first submission transaction. It records the submitted amount and the Lagos date. The daily balance and monthly summary (`/wallet`) read only the RM's own rows. Monthly totals equal the sum of the daily totals. Declined and withdrawn requests stay in the totals with their current status. Approved, booked and disbursed amounts are reported separately.

## 7. New-client setup checklist

1. `npm run migrate`, then `npm run seed` (creates product configuration version 1 and draft retail offer templates).
2. Provision staff and roles. RMs and Team Leads need a **team**. Grant `PRODUCT_CONFIG_APPROVER`, `VENDOR_MANAGER` (at least two people) and `COLLECTIONS_OFFICER`.
3. Load outlets (Administration → Outlet locations) with their Outlet Service Supervisor and team.
4. Import the institution directory.
5. Register and verify vendors.
6. Propose and approve product configuration for the gaps listed on the Products page.
7. Replace and approve the retail offer templates (Administration → Offer templates).
8. Optionally set service targets and escalation recipients.
9. Run `npm run migration:report` and resolve what it lists.

Synthetic demo: `npm run seed -- --with-demo --with-retail-demo` applies a **synthetic** configuration that is clearly labelled and is not bank policy. `npm run demo:retail` drives three full journeys on a fresh database.

## 8. Outstanding business decisions

| Decision | What it blocks until decided |
|---|---|
| Head of Unit vs Head of Retail Sales: same authority or distinct? Kept **distinct** (default). The current holder is configured by granting the `HEAD_OF_UNIT` role; no name is in code. | Nothing (distinct stage runs); changing it needs a configuration version |
| DSR denominators (all products/profiles) | Submission |
| Rate conventions for 23%, 34% and 39.5% | Final calculation, offer generation |
| Alt Drive max amount, tenor, equity contribution and vehicle eligibility | Submission |
| Alt Power structures, pricing, limits, tenors, statement periods; business-owner DSR | Submission |
| Statement period for Vendor Financing; payslip period for Alt Power | Submission |
| Insurance treatment for Vendor Financing and Alt Power | Offer generation |
| AFS exception authority (Vendor Financing) | AFS exceptions |
| Whether a management visit is required, per product and profile | Team Lead review |
| Contract sequences per structure (e.g. Murabaha purchase-then-sale) | Offer pack submission |
| Credit approval authority for retail amounts: currently the existing credit route table (₦1–₦50m). Amounts above ₦50m have no route. | Submission above ₦50m |
| Restructuring approval authority | Restructuring |
| Bank-approved retail offer and contract wording | Offer generation (templates seeded as unapproved drafts) |
| Service targets and escalation recipients | Escalations (none sent until set) |

## 9. Integrations

| Interface | State in this build |
|---|---|
| Staff identity | Bank directory upload (existing) |
| BVN verification | Format check only; labelled "not verified" |
| Account name enquiry | Not connected; manual verification with evidence (`nameEnquiryProvider()` adapter point) |
| Credit bureau, statements | Uploaded documents |
| CRMS | Officer attestation backed by uploaded CRMS evidence |
| Core banking booking | Facility reference recorded by Disbursement Officer 2 |
| Payments | Manual payment events with evidence (source `MANUAL_EVIDENCE`). `recordPaymentEvent(..., "INTEGRATION")` is ready for a provider callback. Duplicates are idempotent; uncertain outcomes must be resolved before a retry. |
| Repayments | Manual entries with evidence by Collections officers; `recordRepayment(..., "INTEGRATION")` adapter point |
| Notifications | Existing outbox (dedupe, delivery status, controlled retries) |

## 10. Landing page and workspace entry

`/` is the public landing page (approved design V39, "PIGGYVEST 1", kept unchanged in
`docs/design/retail_asset_factory_v39_piggyvest_theme_fixed.html`), implemented in `src/app/page.tsx`; its
stylesheet `src/app/landing.module.css` is generated from the reference (see `docs/DESIGN.md`). Images are in
`public/images/landing/`.
Usage rights for the family photograph and the NIFI logo were confirmed by the product owner (November 2026).
Its three cards link to `/enter/<workspace>` (`src/app/enter/[workspace]/route.ts`), which reuses the existing
OTP sign-in and never grants a permission:

| Card | Signed out | Signed in |
|---|---|---|
| Relationship Manager | `/sign-in?as=RM&next=/queue` | switch to the RM workspace if held (audited), else "Access denied" |
| Delight Officer | `/sign-in?as=DELIGHT_OFFICER&next=/queue` | same, for the Delight Officer role |
| Staff Personal Request | `/sign-in?as=STAFF&next=/staff-request` | `/staff-request` |

**Integration point:** no Staff Personal Request workflow exists yet. `/staff-request` is a signed-in placeholder
that says so; replace it (or repoint `/enter/staff-personal-request`) when the product, eligibility and approval
route are defined.

## 11. CX approval chain, locations, performance and repayment monitoring

**CX approval chain (`RETAIL_CX_V1`).** Set per product in the product configuration (maker-checker).
The chain is Initiator → Team Lead certification → CX credit review (`CX_CREDIT_REVIEWER`) → Unit Head →
Divisional Head → offer and disbursement. Migration 025 proposes it for Vendor Financing, Alt Drive and
Alt Power. It applies only after a Product Config Approver approves those proposals. WakeelBoost stays
on the standard chain.

**Self-review rules.** Team Leads and Unit Heads may originate on CX products, but never review their
own request:
- A Team Lead's request skips Team Lead certification.
- A Unit Head's request goes to another Unit Head, or to the Divisional Head if there is none.
- Each of these rules is audited as `ROUTING_RULE_APPLIED`.

**Origination locations (migration 027).** Migration 027 adds the AltLounge outlet type and seeds six
locations, all selectable by RMs:
- AltLounge Allen Lagos 1 and 2
- AltLounge Jericho Ibadan
- AltLounge Tanke Ilorin
- Altbank Kano
- Altbank Abuja

Rules:
- RMs must choose an active, RM-selectable location. Team Leads and Unit Heads may choose one.
- The location is stored as `applications.origination_location_id` and is used only for reporting. It
  does not change routing.
- Super Admins manage locations at `/admin/locations`, which shows the requests, RMs and audited change
  history for each location.
- Locations are deactivated, never deleted.

**Performance (migration 028).**
- **Targets** (`/performance/targets`) are monthly, per person or team. They are measured as disbursed
  value or disbursed count. A Super Admin, Head of Retail Sales or Unit Head proposes a target, and a
  *different* Unit Head, Divisional Head or Head of Retail Sales approves it. Nobody decides their own
  target. Proposals cannot be changed: approving a replacement supersedes the previous target.
- **Daily summary.** RMs and Team Leads see it once per Lagos day, on their first page, and at
  `/performance` at any time.
- **Data source.** Figures come only from recorded disbursements (`disbursed_on`). Run rate uses working
  days: weekends and the holiday calendar are excluded.
- **Missing targets.** With no approved target, the summary says "Target not configured".
- **Team Leads** see their own originations and their team total side by side. The two are never added
  together.

**Dashboards.** The retail dashboard breaks results down by location, state, product, team or RM, with
data-freshness stamps. CX Credit Reviewers get the organisation-wide scope.

**Repayment monitoring (`/repayments`, migrations 029 and 031).** A Super Admin on/off switch controls it; it is **off by default** while core banking is not connected, and only Super Admins see it while off.
- **What it compares.** The expected schedule against repayments recorded in ARAF, as manual entries with
  evidence. Results are bucketed by days past due and broken down by product and location.
- **Core banking.** Core banking is **not connected**, and the page says so. `src/server/integrations/cbs.ts`
  defines the adapter interface only; no adapter exists.
- **PDO** is seeded as *awaiting definition* and is not calculated until Credit approves a definition.
- **WakeelBoost** repayment actuals are not recorded in ARAF, so WakeelBoost is not shown.

**Pricing and tenor (`/admin/pricing`, Super Admin; migration 030).** Mark-ups are set per product, customer
profile and contract type (for example Alt Drive: Murabaha 34%, Ijarah 39.5%). The repayment period
(minimum and maximum months) is set per product and profile. Contract types are a catalogue: a Super
Admin can add new ones (never deleted, only deactivated). New retail products start closed, copying
another product's rules. Every change is a configuration proposal that a different Product
Configuration Approver must approve under Products and rules. Requests keep the terms they were
submitted under.

**Originator routing (CX chain).** A request always moves forward from the originator's position on the
chain:
- A Team Lead's own request goes to CX credit review.
- A Unit Head's own request goes to CX credit review and then to the Divisional Head. It never goes to
  another Unit Head or back down to a Team Lead.

## 12. Vendor Financing — Team Lead business photograph verification

Applies to RM-originated Vendor Financing at Team Lead review while the Super Admin switch **Vendor Financing Business Photograph
Review** (Administration → Feature controls) is ON. It is **OFF by default**. The setting in force when the request reaches the
Team Lead is snapshotted, so changing the switch never alters a review in progress.

- The Team Lead sees a KYC summary (customer, BVN and SeedFi result, business address, sector, vendor, RM and request) and
  chooses either **Upload** an existing photograph from the gallery or files (images only; the camera is never opened; preview;
  confirm it shows the RM's business) or **Skip** with a mandatory reason (at least 10 characters; whitespace is not accepted).
- The server refuses the Team Lead's recommend / return / decline until one is recorded. Either choice lets the existing
  approval continue; skipping is never a rejection. Decisions are immutable and audited.
- A skip notifies every active Unit Head: the in-app notification centre (bell), a *Business photo not uploaded* badge in their
  queue, a highlighted panel on the request with the exact reason, an email, and the audit trail. A notified Unit Head can open
  the request.
- Turning the switch OFF removes the step for new reviews and keeps every photo and reason already recorded. Changing it needs
  a reason; the previous value, new value, who and when are recorded.
- Existing KYC, BVN identity, SeedFi and credit-policy controls are unchanged; a good score never overrides an identity mismatch.

## 13. God's Eye (executive view)

Role **Executive View (God's Eye, read-only)**, also available to Super Admins and the Divisional Head: institution-wide requests,
approvals, bookings, disbursements, repayments, outstanding facilities, approval queues, staff productivity, BPM and location
performance, stock utilisation, migration progress and Vendor Financing KYC exceptions, with CSV exports. It grants no
approval, editing, or case/document access.
