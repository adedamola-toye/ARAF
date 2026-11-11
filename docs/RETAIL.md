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

## 3. Affordability (versioned engine `retail-affordability@1`)

DSR = (existing monthly obligations + proposed monthly obligation) ÷ configured monthly denominator × 100.
- **Preliminary (at submission):** uses the proposed obligation calculated from the terms when the convention is configured. Otherwise it uses the initiator's estimate, flagged as such.
- **Final (credit appraisal):** recorded by the first credit reviewer from verified inputs. It is blocked until the rate and convention are configured.
- **Arithmetic:** exact BigInt rationals. Thresholds compare unrounded values; display rounds to 4 decimal places.
- **Separate rules:** the principal-to-turnover cap is its own optional rule.
- **Snapshots:** every assessment stores its rules, inputs, outputs and formula lines. Assessments are immutable (enforced by database trigger).

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

`/` is the public landing page (approved design `retail_asset_factory_fixed` / responsive v25), implemented in
`src/app/page.tsx` with styles scoped in `src/app/landing.module.css`; images in `public/images/landing/`.
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
