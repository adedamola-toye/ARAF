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
| Smile Associate | **new** `SMILE_ASSOCIATE` | Sell from the Altshop or Altbox they operate from today (State → Type → Location); choose the supplying Shop or Branch (nearest first); disburse their own |
| Business Performance Manager | **new** `BUSINESS_PERFORMANCE_MANAGER` | First review of SA credit applications — only those routed to them by the state of the selling location |
| Altphones Product Manager | **new** `ALTPHONES_PRODUCT_MANAGER` | Product review; catalogue; pricing, repayment rules and contract wording; stock requests |
| Unit Head | existing `UNIT_HEAD` | Final approval — only the one Unit Head configured for the Altphones route |
| Super Admin | existing | Credit score bands, route Unit Head, team mailbox; approves stock; imports; records refunds |

Approval routes: **SA** — the BPM mapped to the selling location's state → Product Manager → Unit Head; **DO** — Product Manager → Unit Head. Separation of duties: the originator never reviews; one person never acts at two stages; a Super Admin cannot approve their own stock request.

## 4. Stock rules

- Balances (`altphones_stock`) change only together with an append-only ledger entry (`altphones_stock_ledger`), under a row lock. Available = physical − reserved; `reserved ≤ physical` is a database constraint, so a unit can never be sold twice.
- Verified payment (down payment, or outright payment) → `RESERVE` (reserved +1). If nothing is available at that moment the payment is still recorded, no reservation is made, and Super Admins are alerted (retry once stock is added, or cancel and refund).
- Handover → `SALE` / `DISBURSEMENT` (physical −1 and reserved −1 in one entry; available is not deducted twice). One ledger entry per application and movement (unique index), so retries cannot double-count.
- Rejection or cancellation → `RELEASE`; a paid application is flagged **Refund required**. Refunds follow the bank's refund process and are recorded by a Super Admin; ARAF does not initiate refunds. Reservations are never released just because an approval is slow.
- **IMEI format.** Every IMEI entered or imported (stock receipts, opening stock, handover, historical transactions, the historical register) is checked: 15 digits, not a placeholder (all zeros, repeated digits), and the 15th digit must be the correct check digit (Luhn). The message says what is wrong (missing check digit, extra digits, a mistyped digit). Wrong IMEIs are refused when staff enter them, and flagged on historical register rows ("IMEI format wrong") with the reason; only valid IMEIs are registered as issued devices when a migration is published.
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

## 8. Location master and registered addresses

Altphones → Locations (Product Manager and Super Admin manage; the Altphones Unit Head approves addresses).

**Rule:** staff select their operating location; ARAF supplies the address and the approval route. Nobody types an address during origination, in the admin location form, or in a location upload (a locations file with an Address column is refused).

- **Location master.** Every Branch, Altshop and Altbox with its registered address and status: *Registered*, *No address* or *Conflicting addresses*. Only active locations with a registered address can be selected in a sale; the server enforces this whatever the browser sends, and the database refuses a registered status without an address.
- **Origination.** Dependent dropdowns: State → Location type → Location (Delight Officers: State → Branch). The registered address is shown read-only and stored on the application. Smile Associates choose the Altshop or Altbox they operate from today, even after moving; an Altshop can supply itself.
- **Profiling workbook import.** Upload the profiling workbook (sheets: Delight Officers = Branches, Altbox SAs, Altshop SAs, BPMs). Only each location's name, state and address are read, and the BPM sheet's email and mapped states; **no DO, SA or BPM profile is created**. Rows naming the same place (including different state labels such as "FCT" and "FCT SALES AGENT") are merged. State labels are normalised (JOS → Plateau, PORT HARCOURT → Rivers, CALABAR → Cross River, MINNA → Niger, ZARIA → Kaduna, UYO → Akwa Ibom, NASSARAWA → Nasarawa, ABUJA/FCT → FCT (Abuja)).
  - The upload is previewed and reconciled first: matched to an existing location (same state and type; similar names are matched only when unique and flagged "check it is the same place"), new, address registered, no address, conflicting addresses, or differs from an already registered address. A similar name under another type is never merged automatically: it is created as new and flagged. The PM can link any entry to an existing location by hand before applying.
  - Applying registers single addresses, creates new locations (inactive when the address is missing or conflicting), keeps every original label as a register label, and records the BPM by state. The original values (every distinct address as written, every label, row counts) are kept per import.
- **Address registration.** A missing address, the choice between conflicting addresses recorded in the workbook, a correction, or a **new location** goes through an address request. A Unit Head who did not request it approves or rejects (with a reason). Approval registers the address; a new location stays inactive until then.
- **Production order (once authorised):** load `opening-locations.csv` and `opening-stock.csv` (section 7) first, then import the profiling workbook so its addresses are registered on the stock-holding locations; review the entries flagged *check* and link any opening location the workbook names differently; then resolve flagged addresses through address requests and request a BPM mapping (Unit Head approval) for every state or location with Altshops or Altboxes not covered by the workbook.
- **BPM mapping.** SA sales go to the BPM mapped to the selling location — a mapping for that location if there is one, otherwise the mapping for its state (both matched to an existing staff member with the BPM role by email). Only that BPM sees the application in their queue and can decide it. State mappings from the profiling workbook are recorded when the import is applied. **Any other mapping — a state the workbook does not cover, a single location, a change or a removal — is requested by the Product Manager (or a Super Admin) with a reason and takes effect only when a Unit Head who did not request it approves it** (Locations → BPM mapping, then Approvals). **Placeholder BPM:** a person (active @altbank.ng staff with the BPM role) who reviews SA sales from Altshops and Altboxes with no BPM mapped — location, then state, then the Placeholder BPM. They approve, return or reject like any BPM, and approved sales go to the Product Manager, then the Unit Head. The Placeholder BPM is set to **bugi.gewa@altbank.ng** (migration 024); changing it is a PM request approved by the Unit Head (Locations → BPM mapping). If the Placeholder BPM is not set up in ARAF with the BPM role, such sales wait unassigned and the PM is emailed. When a BPM is mapped to the location, sales still at the BPM stage move to that BPM automatically.

## 9. Historical migration (Altphones operations, phase 2)

Altphones → Historical migration. The register the team kept before ARAF (one workbook with INTERNAL, EXTERNAL, COMPLETED REPAYMENT and CANCELED REQUEST sheets) is brought in as a staged batch, checked, reconciled and approved before anything is published.

**Who does what.** The Altphones Product Manager (or a Super Admin) uploads and prepares a batch; the Altphones Unit Head approves or returns it. The approver can never be the person who prepared or submitted it. One batch is open at a time and the same workbook cannot be uploaded twice.

**How rows are classified** (from the register's evidence, up to the batch's as-at date; nothing is assumed complete):

| Sheet / evidence | Status |
|---|---|
| COMPLETED REPAYMENT | Completed (the team's register is the evidence) |
| CANCELED REQUEST | Cancelled |
| Every instalment marked *yes* | Completed |
| Any month marked *no* (a missed repayment) | In arrears — arrears = missed months × monthly repayment |
| Only *yes* marks, instalments still to come | Current |
| No marks, repayment starts after the as-at date | Not yet started |
| No marks, repayment should have started | Needs review — the preparer sets the status from the team's records, with a reason, or excludes the record |

Outstanding = (tenor − months paid) × monthly repayment. Month marks after the as-at date are shown but not counted.

**Checks.** Records with these need a decision before the batch can be submitted: no repayment marks; values in the wrong columns; unreadable number of phones, repayment amount or tenor; the same IMEI on another row; an IMEI already in ARAF; the same customer (BVN) on another sheet. Everything else is reported for information (amounts or tenors Excel had turned into dates and that were converted back, unusual tenors, missing/invalid IMEI, BVN or account number, blank months between marks, unlinked labels, repeat customers). A decision is *include* (optionally with the status from the team's records) or *exclude*, always with a reason when it overrides the register or resolves a check; *Decide all … matching this filter* applies one decision to every undecided record in a filtered list.

**Labels.** Location labels are linked to a Branch, Shop or BOX (saved as register labels, so later files match automatically); "Referred by" names that match a staff member exactly are linked automatically and the rest can be linked by hand. Labels that are not a place or a person may stay unlinked; the text is kept.

**Reconciliation** (shown to the preparer and the Unit Head): rows read vs staged per sheet; records read = included + excluded; records, phones, outstanding and arrears by status; down payments and amounts collected per the register; label link coverage; NIN kept/left out.

**Publishing** (Unit Head approval) re-checks the batch against the database, then creates one verified historical account per included record with its month-by-month evidence (paid/missed), registers each valid IMEI as an issued legacy device so it can never be sold or migrated again, and clears the staging copies of personal data. **It never moves stock.** Account number, phone, BVN, NIN and address are encrypted; screens show only the last four digits. The NIN is kept while repayment is not complete and left out for completed accounts. Returning a batch sends it back to the preparer with the Unit Head's reason; discarding one clears its staged personal data.

**Production run (once authorised):** the Product Manager uploads the register with the as-at date (31 October 2026 for the current workbook), links location labels and "Referred by" names, decides the blocked records, and submits; the Unit Head reviews the reconciliation and approves.

## 10. Imports

Altphones settings → Setup uploads (Super Admin). CSV or Excel, with downloadable templates. A file is checked first (nothing applied), then imported only if it has no errors; it is re-validated at commit, and the same file cannot be imported twice. Every applied row is audited.

Setup, in order:

1. **Locations**: State, City, Type (Branch/Shop/BOX), Name, Source name (optional, the name as originally listed when it differs), Source type (optional, the type as originally listed), Aliases (optional register labels separated by `;`). Existing locations are skipped; duplicate names and aliases already in use are refused.
2. **Delight Officers and Smile Associates**: Email, Full name, Route (Delight Officer/DO or Smile Associate/SA), State, Home location, Active (Yes/No). The route is the role they sign in with. A new email must be an active @altbank.ng address in the bank directory and gets a staff record. Changing the route removes the other route; Active = No removes both. A Delight Officer's home must be a Branch and a Smile Associate's a BOX; it is preselected when they start a sale. Suspended staff are refused.
3. **Opening stock**: Location, Phone model, Quantity, IMEIs (optional, separated by spaces or commas), Note. Branches and Shops only; one row per location and phone; IMEIs must be valid, unique and not already registered, and no more than the quantity. Posted as Opening stock movements and the IMEIs registered as in stock.

Historical records:

- **Historical transactions**: Reference, Type (Outright/Credit), customer details, Phone model, IMEI, Transaction date, Originating officer, Originating location, Supplying location, Tenure. Marked Legacy / Imported; IMEIs recorded as issued; no payments, approvals, emails or stock movements. Duplicate references and IMEIs are refused.
- **Historical stock movements**: Reference, Location, Phone model, Movement (Opening/Receipt/Sale/Disbursement/Adjustment), Quantity, Date. Posted as legacy ledger entries; BOX rows refused; a movement that would leave fewer units than reserved is refused.

Import stock *positions* separately from historical transactions so nothing is counted twice.

## 11. Code map

- `migrations/009_altphones.sql` — tables, constraints, append-only triggers, BOX stock guard.
- `migrations/018_altphones_inventory_operations.sql` — location source labels, register aliases, the stock pool, stock counts.
- `migrations/023_altphones_placeholder_bpm_person.sql`, `024_altphones_placeholder_bpm_assignment.sql` — the Placeholder BPM person (set to bugi.gewa@altbank.ng).
- `migrations/022_altphones_placeholder_bpm.sql` — Placeholder BPM routing flag on applications.
- `migrations/021_altphones_bpm_mapping_approval.sql` — BPM mapping requests (PM requests, Unit Head approves), location-level BPM mappings.
- `migrations/020_altphones_location_master.sql` — registered addresses, profiling imports and their original values, address requests, BPM by state, routed BPM.
- `migrations/019_altphones_historical_migration.sql` — migration batches and staged records, officer labels, verified historical accounts and their monthly evidence.
- `src/lib/altphones.ts` — statuses, calculator, repayment dates, validators (shared with the browser).
- `src/server/altphones/` — `core` (records, access, routing, notifications), `origination`, `approvals`, `stock`, `catalogue` (catalogue and settings), `integrations` (SeedFi, Paystack), `imports`, `views`, `register` (reads the historical register workbook), `location-master` (profiling import, address registration, BPM routing), `migration` (staging, checks, classification, reconciliation, approval, publishing).
- `src/app/(app)/altphones/` — home/catalogue, sales, application page, receipt, reviews, inventory, settings.
- `src/app/api/altphones/` — product images, Paystack webhook, import templates.
- `tests/altphones.test.ts`, `tests/altphones-ops.test.ts` (opening dataset, pool, stock counts), `tests/altphones-migration.test.ts` (register reading, classification, checks, maker-checker publishing), `tests/altphones-locations.test.ts` (profiling import, address approval, origination and BPM routing); `npm run demo:altphones` seeds synthetic applications at every stage on a development database (test doubles inside the script only).
