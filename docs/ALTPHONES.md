# Altphones — sales, financing, inventory and disbursement

The Delight Officer channel is now **Delight Officer / Smile Associate** and shows Altphones only. The other two origination channels (Relationship Manager, Staff Personal Request) are unchanged. Signing in to the channel opens `/altphones`; retail product initiation (`/requests/new`) redirects there from this workspace. Existing in-flight Delight Officer retail cases stay reachable through the action queue.

## 1. What is implemented

| Area | Status |
|---|---|
| Catalogue of up to 3 phones (name, photo, specifications) managed by the Altphones Product Manager | Implemented — loaded from the approved AltPhone deck (migration 010): AltPhone Lesia L1 in Black & Gold, Green and Blue, with the deck's photos and specifications; the PM can edit or replace them |
| Pricing ₦145,000 outright, fixed ₦29,000 down payment, ₦116,000 financed, 3/6/12 months | Implemented (settings version 1) |
| Markup engine on the financed amount, exact kobo arithmetic, rounding in the final instalment | Implemented — **rates not yet configured** (see 6) |
| Terms fixed per application when the down payment is requested (later pricing changes do not apply) | Implemented |
| Outright sale: phone → location → customer → verified ₦145,000 → IMEI → handover → receipt to customer, cc altbox@altbank.ng | Implemented |
| Credit sale: BVN first → Seedfi → customer and accounts → Paystack down payment → automatic reservation → Direct Debit + internal mandate → contract by email OTP → approvals → disbursement | Implemented |
| DO route: Product Manager → Unit Head → back to the originating DO | Implemented |
| SA route: Business Performance Manager → Product Manager → Unit Head → back to the originating SA | Implemented |
| Branch / Shop / BOX locations; BOX never holds stock (database trigger) | Implemented (reuses `locations`: BRANCH, ALTSHOP, ALTBOX) |
| Stock ledger, reservations, IMEI records, replenishment (PM requests, Super Admin approves) | Implemented |
| Imports: locations, historical transactions (Legacy / Imported), historical stock movements — preview, validation, commit | Implemented |
| Dashboards for DO/SA, BPM, PM, Unit Head, Super Admin; reports (sales, financing, stock, officers, turnaround, scheduled repayments) | Implemented |

## 2. Statuses

Outright: `DRAFT → AWAITING_PAYMENT → PAID (unit reserved) → COMPLETED` ("Outright Sale Completed").

Credit: `DRAFT → AWAITING_DOWN_PAYMENT → IN_PREPARATION (unit reserved; mandates; contract) → UNDER_BPM_REVIEW (SA only) → UNDER_PM_REVIEW → UNDER_UNIT_HEAD_REVIEW → APPROVED ("Approved — Ready for Disbursement") → DISBURSED`.
Exits: `CREDIT_DECLINED` (Seedfi FAIL), `RETURNED_FOR_CORRECTION` (resubmission restarts at the first stage of the route), `REJECTED`, `CANCELLED` (originator, before approval).

Every change is an audited event (`altphones_events`, `audit_events.altphones_application_id`); decisions are append-only (`altphones_reviews`).

## 3. Roles

| Role | New? | Can do |
|---|---|---|
| Delight Officer | existing | Sell from their Branch (supply = that Branch); disburse their own approved applications |
| Smile Associate | **new** `SMILE_ASSOCIATE` | Sell from a BOX; choose the supplying Shop or Branch (nearest first); disburse their own |
| Business Performance Manager | **new** `BUSINESS_PERFORMANCE_MANAGER` | First review of SA credit applications |
| Altphones Product Manager | **new** `ALTPHONES_PRODUCT_MANAGER` | Product review; catalogue; pricing, repayment rules and contract wording; stock requests |
| Unit Head | existing `UNIT_HEAD` | Final approval — only the one Unit Head configured for the Altphones route |
| Super Admin | existing | Credit score bands, route Unit Head, team mailbox; approves stock; imports; records refunds |

Separation of duties: the originator never reviews; one person never acts at two stages; a Super Admin cannot approve their own stock request.

## 4. Stock rules

- Balances (`altphones_stock`) change only together with an append-only ledger entry (`altphones_stock_ledger`), under a row lock. Available = physical − reserved; `reserved ≤ physical` is a database constraint, so a unit can never be sold twice.
- Verified payment (down payment, or outright payment) → `RESERVE` (reserved +1). If nothing is available at that moment the payment is still recorded, no reservation is made, and Super Admins are alerted (retry once stock is added, or cancel and refund).
- Handover → `SALE` / `DISBURSEMENT` (physical −1 and reserved −1 in one entry; available is not deducted twice). One ledger entry per application and movement (unique index), so retries cannot double-count.
- Rejection or cancellation → `RELEASE`; a paid application is flagged **Refund required**. Refunds follow the bank's refund process and are recorded by a Super Admin; ARAF does not initiate refunds. Reservations are never released just because an approval is slow.
- IMEIs registered at stock receipt are earmarked at reservation; an unregistered unit's IMEI can be captured at handover (within the physical count).

## 5. Integrations (credentials required)

All are disabled until configured; dependent actions show a clear "not configured" state and nothing is treated as passed, paid or active.

| Integration | Variables | Notes |
|---|---|---|
| Seedfi credit assessment | `SEEDFI_ENABLED`, `SEEDFI_BASE_URL`, `SEEDFI_API_KEY`, `SEEDFI_ASSESS_PATH`, `SEEDFI_TIMEOUT_MS` | POST `{bvn, reference}` with a bearer key; the response must contain a reference and a numeric score (top level or under `data`). **Confirm the contract with Seedfi** and adjust `src/server/altphones/integrations.ts` if it differs. Unavailable, timeout or invalid response → "Integration unavailable — not assessed". |
| Paystack payments | `PAYSTACK_ENABLED`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_BASE_URL` | Transaction initialise (bank-transfer channel) + verify. Webhook: `<APP_URL>/api/altphones/paystack/webhook` (set it in the Paystack dashboard). Signature checked (HMAC-SHA512), events de-duplicated, each event re-verified through the API; amount, currency and reference must match. |
| Paystack Direct Debit | `PAYSTACK_DIRECT_DEBIT_ENABLED` | Authorisation initialise/verify (`/customer/authorization/*`, channel `direct_debit`). The mandate is Active only when Paystack's verification says so. **Confirm Direct Debit and settlement are enabled on the bank's Paystack integration before turning this on.** Collections against the mandate are not part of this release. |
| Email | existing mail settings | Customer receipts and confirmations copy the team mailbox (default altbox@altbank.ng). The contract OTP email is sent directly and never stored; OTPs are stored only as HMACs, expire (`ALTPHONES_OTP_TTL_SECONDS`) and allow `ALTPHONES_OTP_MAX_ATTEMPTS` tries. |

Alternative Bank account verification has no API: the officer confirms it manually and it is labelled **Officer confirmed**. The internal debit mandate is likewise **Officer Confirmed**, never "API verified".

BVNs are encrypted (AES-256-GCM) with an HMAC for matching; only the last 4 digits are shown or audited. The Direct Debit authorisation code is encrypted.

## 6. Configuration required before production

1. **Markup rates and basis** — Altphones settings → Pricing. The rate table and formula images in the specification were not received, so no rates are set and credit sales are unavailable. Enter each tenure's rate and choose whether the rate is the total for the tenure or per month; the "Current calculation" table must match the approved Excel figures. Add those figures to the pending test in `tests/altphones.test.ts` ("matches the approved Excel figures").
2. **Repayment-date rules** — weekend/holiday rule and short-month rule (Pricing tab), and the public holiday list. The first instalment falls on the chosen repayment day in the calendar month after disbursement; confirm this matches policy.
3. **Approved contract wording** (Pricing tab), using the listed `{{placeholders}}`.
4. **Seedfi score bands** (Pass and Fair thresholds) and the **route Unit Head** — Super Admin, Credit policy and routing tab.
5. **Catalogue** — loaded from the AltPhone deck (AltPhone Lesia L1 ×3 colours). Confirm the names and spec lines with the product team. The deck also mentions insurance cover, data bundles and flexible daily/weekly payment; those are not part of this workflow.
6. **Locations** — import Branches, Shops and BOXes (Imports tab), then opening stock via stock requests approved by a Super Admin (or a historical stock import).
7. **Roles** — grant Smile Associate, Business Performance Manager and Altphones Product Manager in Users & roles.
8. **Integrations** — section 5, plus the Paystack webhook URL.
9. Run migration `009_altphones.sql` (`npm run migrate`).

## 7. Imports

Altphones settings → Imports (Super Admin). CSV or Excel, with downloadable templates. A file is checked first (nothing applied), then imported only if it has no errors; it is re-validated at commit, and the same file cannot be imported twice.

- **Locations**: State, City, Type (Branch/Shop/BOX), Name, Address. Existing locations are skipped; duplicate names are refused.
- **Historical transactions**: Reference, Type (Outright/Credit), customer details, Phone model, IMEI, Transaction date, Originating officer, Originating location, Supplying location, Tenure. Marked Legacy / Imported; IMEIs recorded as issued; no payments, approvals, emails or stock movements. Duplicate references and IMEIs are refused.
- **Historical stock movements**: Reference, Location, Phone model, Movement (Opening/Receipt/Sale/Disbursement/Adjustment), Quantity, Date. Posted as legacy ledger entries; BOX rows refused; a movement that would leave fewer units than reserved is refused.

Import stock *positions* separately from historical transactions so nothing is counted twice.

## 8. Code map

- `migrations/009_altphones.sql` — tables, constraints, append-only triggers, BOX stock guard.
- `src/lib/altphones.ts` — statuses, calculator, repayment dates, validators (shared with the browser).
- `src/server/altphones/` — `core` (records, access, routing, notifications), `origination`, `approvals`, `stock`, `catalogue` (catalogue and settings), `integrations` (Seedfi, Paystack), `imports`, `views`.
- `src/app/(app)/altphones/` — home/catalogue, sales, application page, receipt, reviews, inventory, settings.
- `src/app/api/altphones/` — product images, Paystack webhook, import templates.
- `tests/altphones.test.ts`; `npm run demo:altphones` seeds synthetic applications at every stage on a development database (test doubles inside the script only).
