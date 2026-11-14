# Altphones — sales, financing, inventory and disbursement

The Delight Officer channel is now **Delight Officer / Smile Associate** and shows Altphones only. The other two origination channels (Relationship Manager, Staff Personal Request) are unchanged. Signing in to the channel opens `/altphones`; retail product initiation (`/requests/new`) redirects there from this workspace. Existing in-flight Delight Officer retail cases stay reachable through the action queue.

## 1. What is implemented

| Area | Status |
|---|---|
| Catalogue of up to 3 phones (name, photo, specifications) managed by the Altphones Product Manager | Implemented — loaded from the approved AltPhone deck (migration 010): Altphone L1 Series in Black & Gold, Green and Blue, with the deck's photos and specifications; the PM can edit or replace them |
| Pricing ₦145,000 outright, fixed ₦29,000 down payment, ₦116,000 financed, 3/6/12 months | Implemented (settings version 1) |
| Markup engine on the full phone price (down payment then deducted), exact kobo arithmetic, rounding in the final instalment | Implemented — approved rates set (3 months 8.97%, 6 months 15.1%, 12 months 23.45%) |
| Terms fixed per application when the down payment is requested (later pricing changes do not apply) | Implemented |
| Outright sale: phone → location → customer → verified ₦145,000 → IMEI → handover → receipt to customer, cc altbox@altbank.ng | Implemented |
| Credit sale: BVN first (with name, date of birth, gender and phone) → SeedFi Seed Score → customer and accounts → Paystack down payment → automatic reservation → Direct Debit + internal mandate → contract by email OTP → approvals → disbursement | Implemented |
| DO route: Product Manager → Unit Head → back to the originating DO | Implemented |
| SA route: Business Performance Manager → Product Manager → Unit Head → back to the originating SA | Implemented |
| Branch / Shop / BOX locations; BOX never holds stock (database trigger) | Implemented (reuses `locations`: BRANCH, ALTSHOP, ALTBOX) |
| Stock ledger, reservations, IMEI records, replenishment (PM requests, Super Admin approves) | Implemented |
| Setup uploads: locations, Delight Officers and Smile Associates, opening stock; plus historical transactions (Legacy / Imported) and stock movements — preview, validation, commit | Implemented |
| Dashboards for DO/SA, BPM, PM, Unit Head, Super Admin; reports (sales, financing, stock, officers, turnaround, scheduled repayments) | Implemented |

## 2. Statuses

Outright: `DRAFT → AWAITING_PAYMENT → PAID (unit reserved) → COMPLETED` ("Outright Sale Completed").

Credit: `DRAFT → AWAITING_DOWN_PAYMENT → IN_PREPARATION (unit reserved; mandates; contract) → UNDER_BPM_REVIEW (SA only) → UNDER_PM_REVIEW → UNDER_UNIT_HEAD_REVIEW → APPROVED ("Approved — Ready for Disbursement") → DISBURSED`.
Exits: `CREDIT_DECLINED` (Seed Score below the Fair threshold), `RETURNED_FOR_CORRECTION` (resubmission restarts at the first stage of the route), `REJECTED`, `CANCELLED` (originator, before approval).

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
- **Colour not recorded (stock pool).** Units counted without a colour are held under one pool model, *Altphone L1 Series — colour not recorded*. It never appears in the catalogue and cannot be activated. A sale of any L1 colour reserves its own colour first and otherwise a pool unit at the same location; the application records which balance was used (`stock_model_id`), and the device issued is recorded as the colour the customer chose. Available stock shown to sellers is own colour + pool.
- **Stock counts (maker-checker).** A Product Manager or Super Admin records a physical count per location and model (Inventory → open a location → *Record a stock count*). A count cannot be below what is reserved, cannot be dated in the future, and only one count per location can be open. A different Super Admin approves or rejects it (rejection needs a reason). On approval the difference to the ledger is posted as a `COUNT_ADJUSTMENT` with the count reference, and the location shows the date of its last approved count.

## 5. Integrations (credentials required)

All are disabled until configured; dependent actions show a clear "not configured" state and nothing is treated as passed, paid or active.

| Integration | Variables | Notes |
|---|---|---|
| SeedFi Seed Score | `SEEDFI_ENABLED`, `SEEDFI_BASE_URL`, `SEEDFI_API_KEY`, `SEEDFI_ASSESS_PATH`, `SEEDFI_TIMEOUT_MS` | Implemented to the SeedFi Loan Engine API documentation v2.0 (April 2026): `POST /scoring/api/v1/seed-score/calculate` with the `X-API-Key` header. Sends customer_id (a stable hash of the BVN, never the BVN), first and last name, BVN, date of birth, phone (0XXXXXXXXXX), gender and, when known, the tenure. The decision uses `reviewed_seedfi_score` (SeedFi lowers it for adverse credit); the overall score, credit-history flag and score components are stored. Scores outside 280–800, errors (SeedFi's `detail` is shown), timeouts and malformed responses are "Integration unavailable — not assessed", never a pass. Staging: `https://stg-loan-engine.theseedfi.com` (use the documented test personas); production: `https://loanengine.theseedfi.com` after SeedFi's go-live sign-off. |
| Paystack payments | `PAYSTACK_ENABLED`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_BASE_URL`, `PAYSTACK_TEST_MODE` | Transaction initialise (bank-transfer channel) + verify. Webhook: `<APP_URL>/api/altphones/paystack/webhook` (set it in the Paystack dashboard). Signature checked (HMAC-SHA512), events de-duplicated, each event re-verified through the API; amount, currency and reference must match. |
| Paystack Direct Debit | `PAYSTACK_DIRECT_DEBIT_ENABLED` | Authorisation initialise/verify (`/customer/authorization/*`, channel `direct_debit`). The mandate is Active only when Paystack's verification says so. **Confirm Direct Debit and settlement are enabled on the bank's Paystack integration before turning this on.** Collections against the mandate are not part of this release. |
| Email | existing mail settings | Customer receipts and confirmations copy the team mailbox (default altbox@altbank.ng). The contract OTP email is sent directly and never stored; OTPs are stored only as HMACs, expire (`ALTPHONES_OTP_TTL_SECONDS`) and allow `ALTPHONES_OTP_MAX_ATTEMPTS` tries. |

SeedFi staging was verified live (12 Nov 2026) with the Alt Mall account and key `AltMall_ARAF_stg_Nov2026`: the four documented test personas returned their documented scores through ARAF's credit check (Theodore Stone 384 Fail, Nathan Smith 532 Fair, John Doe reviewed 444 / overall 544 Fail, Jane Doe 400 Fail). Staging responses carry `is_dummy_data: true`, which ARAF stores and shows as "SeedFi test data". The API key is a secret: set `SEEDFI_API_KEY` in each deployment's environment settings, never in the repository. Production needs a separate key on `https://loanengine.theseedfi.com` after SeedFi's go-live sign-off.

**Account name enquiry (Paystack).** When Paystack is configured, the officer picks the customer's other bank from Paystack's bank list and both accounts are looked up as they type (`/bank/resolve`; Alternative Bank via its NUBAN code 000304); the server repeats the lookup on save and stores the names, marked "Names verified by Paystack; officer confirmed". An account that does not exist is refused. With a test key, set `PAYSTACK_TEST_MODE=true`: test mode resolves only Paystack's Test Bank (001), which is then listed and also used for Alternative Bank lookups. Paystack test mode verified live (13 Nov 2026): bank list, name enquiry, transaction initialise/verify and Direct Debit initialise/verify. An unpaid transaction is reported by Paystack as `abandoned`; ARAF treats it as "not received yet".

Without Paystack, the officer confirms the accounts manually and they are labelled **Officer confirmed**. The internal debit mandate is likewise **Officer Confirmed**, never "API verified".

BVNs are encrypted (AES-256-GCM) with an HMAC for matching; only the last 4 digits are shown or audited. The Direct Debit authorisation code is encrypted.

## 6. Configuration required before production

1. **Markup rates** — set by migration 015 as the total markup for each tenure, charged on the full ₦145,000 phone price; the ₦29,000 down payment then comes off the price with markup and the balance is paid in monthly instalments (the Product Manager can change them in Altphones settings → Pricing; each change is a new version and agreed customer terms never change):

   | Tenure | Rate | Markup | Price with markup | Balance in instalments | Monthly | Final instalment |
   |---|---|---|---|---|---|---|
   | 3 months | 8.97% | ₦13,006.50 | ₦158,006.50 | ₦129,006.50 | ₦43,002.17 | ₦43,002.16 |
   | 6 months | 15.1% | ₦21,895.00 | ₦166,895.00 | ₦137,895.00 | ₦22,982.50 | ₦22,982.50 |
   | 12 months | 23.45% | ₦34,002.50 | ₦179,002.50 | ₦150,002.50 | ₦12,500.21 | ₦12,500.19 |

   The kobo rounding goes into the final instalment; `tests/altphones.test.ts` checks these figures.
2. **Repayment-date rules** — weekend/holiday rule and short-month rule (Pricing tab), and the public holiday list. The first instalment falls on the chosen repayment day in the calendar month after disbursement; confirm this matches policy.
3. **Contract wording** — Altphones settings → Contract (Super Admin or Altphones Product Manager). The editor starts from a plain-language draft (`src/lib/altphones-contract.ts`) written as a sale at an agreed markup with no interest; Legal and Shariah must complete the bracketed notes (missed payments, early settlement, warranty) and remove the draft line before it can be saved. The editor has click-to-insert placeholders and a preview with example figures; every save is a new audited version and contracts already accepted keep their exact text.
4. **Seed Score bands** — set from SeedFi's documented decision bands (Pass ≥ 620 = Approved, Fair 530–619 = Manual Review, Fail < 530 = Declined; migration 012). Confirm them against the bank's approved credit policy; a Super Admin can change them. Also set the **route Unit Head** (Credit policy and routing tab).
5. **Catalogue** — loaded from the AltPhone deck (Altphone L1 Series ×3 colours). Confirm the names and spec lines with the product team. The deck also mentions insurance cover, data bundles and flexible daily/weekly payment; those are not part of this workflow.
6. **Locations, officers and opening stock** — Altphones settings → Setup uploads, in that order (section 7).
7. **Roles** — Delight Officers and Smile Associates come from the setup upload; grant Business Performance Manager and Altphones Product Manager in Users & roles.
8. **Integrations** — section 5, plus the Paystack webhook URL. For production, generate a **new** Paystack live secret key in the Paystack dashboard and enter it only as `PAYSTACK_SECRET_KEY` in the production app's environment settings, with `PAYSTACK_TEST_MODE` unset or `false`. Never put keys in the repository, a chat or an email.
9. Run migration `009_altphones.sql` (`npm run migrate`).

## 7. Locations and opening dataset (Altphones operations, phase 1)

- Every Branch and Shop is listed on Inventory, including locations with no stock, with filters for state, type, stock (in stock / no stock) and a search. Each location keeps the name, state and type it was supplied under (`source_name`, `source_state`, `source_type`); where the operating value differs the screen shows *Listed as …*.
- States are normalised on import: ABUJA → FCT (ABUJA), PORT HARCOURT → RIVERS, JOS → PLATEAU, LAGOS/OGUN → OGUN; "X STATE" → X.
- **Register labels (aliases)** map free-text labels used in registers and reports (e.g. a market or team name) to a location. They are upper-case, unique, and matched by imports alongside the location name.
- The supplied opening dataset is in `data/altphones/`:
  - `opening-locations.csv` — 69 locations, as supplied. Agege Stadium is reclassified from ALTBOX to Shop (source type kept). DEI DEI was supplied twice, as an ALTSHOP and as a BRANCH, and is kept as two locations, *DEI DEI ALTSHOP* and *DEI DEI BRANCH*, both listed as "DEI DEI"; because that label matches both, a file naming only "DEI DEI" is refused rather than guessed. City holds the supplied state label.
  - `opening-stock.csv` — 44 rows with stock, 152 units, all under the colour-not-recorded pool. Zero-stock locations need no row.
- **Loading it in production (Super Admin, only once authorised):** Altphones settings → Setup uploads → *Locations* → upload `opening-locations.csv`, check, import; then *Opening stock* → upload `opening-stock.csv`, check, import. Inventory should then show 69 new locations and 152 units. The same file cannot be imported twice. From then on every sale and movement is posted to the ledger and stock counts continue from there.

## 8. Imports

Altphones settings → Setup uploads (Super Admin). CSV or Excel, with downloadable templates. A file is checked first (nothing applied), then imported only if it has no errors; it is re-validated at commit, and the same file cannot be imported twice. Every applied row is audited.

Setup, in order:

1. **Locations**: State, City, Type (Branch/Shop/BOX), Name, Address, Source name (optional, the name as originally listed when it differs), Source type (optional, the type as originally listed), Aliases (optional register labels separated by `;`). Existing locations are skipped; duplicate names and aliases already in use are refused.
2. **Delight Officers and Smile Associates**: Email, Full name, Route (Delight Officer/DO or Smile Associate/SA), State, Home location, Active (Yes/No). The route is the role they sign in with. A new email must be an active @altbank.ng address in the bank directory and gets a staff record. Changing the route removes the other route; Active = No removes both. A Delight Officer's home must be a Branch and a Smile Associate's a BOX; it is preselected when they start a sale. Suspended staff are refused.
3. **Opening stock**: Location, Phone model, Quantity, IMEIs (optional, separated by spaces or commas), Note. Branches and Shops only; one row per location and phone; IMEIs must be valid, unique and not already registered, and no more than the quantity. Posted as Opening stock movements and the IMEIs registered as in stock.

Historical records:

- **Historical transactions**: Reference, Type (Outright/Credit), customer details, Phone model, IMEI, Transaction date, Originating officer, Originating location, Supplying location, Tenure. Marked Legacy / Imported; IMEIs recorded as issued; no payments, approvals, emails or stock movements. Duplicate references and IMEIs are refused.
- **Historical stock movements**: Reference, Location, Phone model, Movement (Opening/Receipt/Sale/Disbursement/Adjustment), Quantity, Date. Posted as legacy ledger entries; BOX rows refused; a movement that would leave fewer units than reserved is refused.

Import stock *positions* separately from historical transactions so nothing is counted twice.

## 9. Code map

- `migrations/009_altphones.sql` — tables, constraints, append-only triggers, BOX stock guard.
- `migrations/018_altphones_inventory_operations.sql` — location source labels, register aliases, the stock pool, stock counts.
- `src/lib/altphones.ts` — statuses, calculator, repayment dates, validators (shared with the browser).
- `src/server/altphones/` — `core` (records, access, routing, notifications), `origination`, `approvals`, `stock`, `catalogue` (catalogue and settings), `integrations` (SeedFi, Paystack), `imports`, `views`.
- `src/app/(app)/altphones/` — home/catalogue, sales, application page, receipt, reviews, inventory, settings.
- `src/app/api/altphones/` — product images, Paystack webhook, import templates.
- `tests/altphones.test.ts`, `tests/altphones-ops.test.ts` (opening dataset, pool, stock counts); `npm run demo:altphones` seeds synthetic applications at every stage on a development database (test doubles inside the script only).
