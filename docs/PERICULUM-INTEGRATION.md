# Periculum Insights integration — Phase 1 discovery

Status: discovery complete (24 November 2026). Nothing is called live yet; the integration stays OFF in production
until credentials, testing, Information Security / Data Protection approval and the bank's go-ahead are in place.

Source: Periculum Insights API reference (`insights-periculum.readme.io`), every page read in full on 24 Nov 2026.
Only what the reference states is used below; anything it does not state is marked **not documented**.

## 1. What Periculum documents

### Hosts
| Purpose | Documented value |
|---|---|
| Token (OAuth 2.0 client credentials) | `POST https://insightsb2b.auth-periculum.app/realms/prod/protocol/openid-connect/token` |
| API (generic, in the examples) | `https://api.insights-periculum.io` |
| Bank tenancy (supplied by the bank) | `insights-sterlingbankng-api…` — **full host still to be confirmed** (see §5) |
| Sandbox | **not documented** (one example mentions `api.dev.insights-periculum.io`) |

### Authentication
- Form-encoded body: `client_id`, `client_secret`, `grant_type=client_credentials` (credentials from the Insights
  dashboard: Settings → API Settings → API Credentials).
- Response: `access_token`, `expires_in` (86400 s in the example), `token_type: "Bearer"`.
- Calls send `Authorization: Bearer <access_token>`. Expired token → `401`. Periculum recommends refreshing a few
  minutes before expiry.

### Endpoints used by ARAF
| Step | Method and path | Notes |
|---|---|---|
| Submit a PDF statement | `PUT /statements` (multipart) | `file` (required), `password`, `statementType` (`CONSUMER` default, `BUSINESS`, `MOBILE_MONEY`, `MOBILE_MONEY_BUSINESS`), `documentType` (`PDF` default or `SCANNED`). Returns the statement `key` with `processingStatus: UPLOADED`. **This is the billable step.** |
| Status and analytics | `GET /statements/{statementKey}` | Poll every 30–60 s (Periculum's advice) until `processingStatus` is `PROCESSED`. |
| Transactions | `GET /statements/{statementKey}/transactions` | `date`, `amount`, `type` (debit/credit), `description`, `balance`. |
| Attach BVN / NIN | `PATCH /statements/identification` | `statementKey`, `identificationData[{identifierName, value}]`. |
| Link statements (native consolidation) | `PUT /statements/link-multiple-pdfs` (multipart) | `files[]`, `passwords` (comma separated), `statementTypes` (comma separated), `baseStatementKey`, optional `uniqueIdentifier`, `bvn`. |
| Consolidated overview | `GET /statements/consolidatedoverview/{baseStatementKey}` | Totals per bank, salary accounts, loans, self-transfer summary. |
| Periculum affordability | `POST /affordability` | `statementKey`, `dti` (0–1), `loanTenure` (months), optional `averageMonthlyLoanRepaymentAmount`. Decision support only; ARAF's own engine stays authoritative. |
| Analysis report PDF | `/statements/{statementKey}/download?downloadAnalytics=true…` | The reference shows both GET (table) and POST (example). **To be confirmed.** |

### Processing statuses
`UPLOADED`, `PROCESSING`, `PROCESSED`, `FAILED`, `INSUFFIENT BALANCE` (sic), `NO BALANCE`, `NO TRANSACTIONS`,
`NOT ENOUGH TRANSACTIONS`, `ALTERED`.

`ALTERED` is treated as a material exception: the statement may have been tampered with, so it never feeds affordability
and is shown to the analyst.

### Analytics returned per statement (selection)
- **Account:** `bankName`, `accountName`, `accountId`, `accountType`, `accountBalance`, `startDate`, `endDate`,
  `clientFullName`, `confidenceOnParsing`, `pdfCreatedDate`, `pdfModifiedDate`.
- **`cashFlowAnalysis`:**
  - `totalCreditTurnover`, `totalDebitTurnOver`
  - `averageMonthlyCredits` / `averageMonthlyDebits`, `averageMonthlyBalance`
  - `monthlyInflow[]` / `monthlyOutflow[]` (`year`, `month_name`, `amount`)
  - `numberOfTransactingMonths`, `validCredit`
  - `firstDateInStatement` / `lastDateInStatement`, `closingBalance`
- **`incomeAnalysis`:**
  - `isSalaryEarner`, `averagePredictedSalary`, `salaryTransactions[]`
  - `expectedSalaryPaymentDay`, `numberOfSalaryPayments`, `lowestSalary`, `mostRecentSalary`
  - `hasOtherIncome`, `averageOtherIncome`, `otherIncomeTransactions[]`
- **`behavioralAnalysis`:**
  - `totalLoanAmount`, `totalLoanRepaymentAmount`, `averageMonthlyLoanRepaymentAmount`
  - `loanTransactions[]`, `loanRepaymentTransactions[]`
  - `gamblingRate`, `accountSweep`, `percentOfInflowIrregularity`
- **`transactionPatternAnalysis`:**
  - `noOfSelfTransferInflows` / `Outflows`, `selfTransferInflowAmount` / `OutflowAmount`
  - `selfTransferInflowTransactions[]` / `OutflowTransactions[]`
  - `missingTransactions`, `returnCheque`
- **`spendAnalysis`:** `averageMonthlyTotalExpenses`, `averageMonthlyRecurringExpense` and per-category spend.

### Limits, errors, webhooks
- **Limits:** 20 MB per file; 1,000 pages per file; PDF only for this endpoint (scanned PDFs need `documentType=SCANNED`).
- **Errors that matter to ARAF:**
  - password required or incorrect;
  - "Insufficient balance." (the account's credit is exhausted);
  - "A statement with the same name has already been analyzed", so ARAF must send a unique file name per submission.
- **Rate limits and idempotency keys:** not documented. ARAF therefore never blindly re-submits a statement whose
  upload outcome is unknown. It first looks for the earlier submission, and the unique file name makes a duplicate
  submission fail safely instead of being charged twice.
- **Webhooks:**
  - An HTTPS POST, with no authentication, to a URL configured with Periculum. How the URL is registered is not
    documented (dashboard or support).
  - Each body carries `metadata.hmacMessage`, an HMAC-SHA512 of the response object keyed with a 32-character secret.
  - Types: `INSIGHTS`, `AFFORDABILITY`, `CREDITSCORE`.
  - The exact serialisation used for the hash is not specified. ARAF therefore verifies the HMAC, and also re-reads the
    statement with `GET /statements/{key}` before trusting any webhook. Polling remains the fallback.

## 2. Fit with ARAF (what is reused)

| Need | Existing ARAF component |
|---|---|
| Statements stored per application | `documents` (category `BANK_STATEMENT`), encrypted object store, resumable large uploads |
| Seedfi background check | `src/server/credit/seedfi.ts`, unchanged |
| DSR, turnover cap and schedule | `src/server/domain/affordability.ts`: exact BigInt arithmetic, unrounded comparison, rules snapshot. Periculum results feed it; no second engine. |
| 30% DSR | Product configuration (maker-checker, versioned). Salary and income DSR: 30% for Vendor Financing, AltDrive and AltPower. The 10% turnover limits (WakeelBoost, AltDrive business) stay separate turnover rules. Agreed 24 Nov 2026. |
| Credit Analyst decision | `recordFinalAssessment`, the DSR exception process and existing approval actions |
| Async work | `src/server/jobs/worker.ts` loop, outbox, `withTx`, audit, notifications |
| Timeline and audit | `audit_events` (append-only, readable labels) and the case history |

## 3. Consolidation approach

- Periculum's link-multiple-pdfs consolidation reports totals per bank and a self-transfer summary.
- The reference does not say that internal transfers between the customer's accounts are removed from consolidated
  inflows, nor how overlapping periods are handled. ARAF therefore does not rely on it for affordability.
- ARAF consolidates from the per-statement transactions instead:
  - It groups transactions by verified account (bank plus account number).
  - It removes duplicate transactions across overlapping files (same account, date, amount, direction, balance and
    description).
  - It matches debits in one owned account to credits in another owned account (same amount, within a short date
    window) and excludes both as internal transfers. Periculum's own self-transfer flags are used as supporting
    evidence.
  - It keeps every exclusion as evidence.
- The native consolidated overview may be stored for comparison only.

## 4. Billing safeguards

- Uploading a statement never calls Periculum. Only the Credit Analyst's single **Automatic Statement Analysis**
  action does.
- Each file is identified by its SHA-256 hash. If a statement with that hash was already processed, the stored result
  is reused rather than submitted again.
- Viewing a saved report never calls Periculum.

## 5. Outstanding items (vendor and bank)

1. The bank's tenancy API host, in full (the brief gives `insights-sterlingbankng-api…`).
2. Credentials: `client_id` and `client_secret`, from Periculum, for test first.
3. Whether a sandbox or test tenancy exists, and whether statements processed there are charged.
4. The webhook URL registration process and the 32-character secret (optional: polling works without them).
5. Commercial pricing per statement, used for the usage and cost figures. ARAF shows "not configured" until supplied.
6. Data processing agreement, hosting and retention terms, and the Information Security / Data Protection approvals.
