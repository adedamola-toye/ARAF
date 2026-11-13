# SeedFi credit check (all routes)

Every origination route runs the SeedFi Seed Score before a request can be submitted, with the same bands:
**Pass** (≥ 620) and **Fair** (530–619) continue; **Fail** (< 530) stops the request. The bands are SeedFi's
documented decision bands, held in Altphones settings → Credit policy and routing (Super Admin) and applied
to every route. The decision uses SeedFi's `reviewed_seedfi_score`.

| Route | Who runs it | Whose BVN | On Fail |
|---|---|---|---|
| Delight Officer / Smile Associate (Altphones) | The officer, first step of a credit sale | Customer (entered first) | Application closed: "Credit assessment failed" |
| Relationship Manager (retail products) | The initiating RM, on the draft before submission | Applicant (individual or proprietor), or **every director** of a limited company — the BVNs saved in the draft | Request closed (stage REJECTED) |
| Staff Request | The applicant, before submission | Their own (entered in the check) | Request declined |

- The officer enters first name, last name, date of birth, gender and phone (SeedFi's required inputs) and confirms consent.
- A score is valid for 30 days and only for the BVN currently on the request; changing the BVN, or resubmitting after 30 days, needs a new check.
- "Integration unavailable — not assessed" (SeedFi down, error, timeout or malformed response) never counts as a pass.
- Results (reviewed and overall score, credit-history flag, validity, components) are stored in `credit_checks` (append-only; Altphones keeps them on the application) and shown to reviewers. Staging results are marked "SeedFi test data".
- The legacy WakeelBoost workflow (Agent Network Manager / Merchant Officer) is unchanged.

## Configuration

`SEEDFI_ENABLED=true`, `SEEDFI_BASE_URL`, `SEEDFI_API_KEY` (and optionally `SEEDFI_ASSESS_PATH`, `SEEDFI_TIMEOUT_MS`).
Staging `https://stg-loan-engine.theseedfi.com`; production `https://loanengine.theseedfi.com`. Keys belong to
the Alt Mall account (paul.toje@altbank.ng): `AltMall_ARAF_stg_Nov2026` (staging) and `AltMall_ARAF_prod_Nov2026`
(production). Store them only in each deployment's environment settings.

If the servers reach the internet through an HTTP proxy, start Node with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) so
its built-in `fetch` uses `HTTPS_PROXY`.

## Bank account validation

SeedFi does not offer account-number or account-name validation: its documented API covers authentication,
the Seed Score and bank-statement analysis/affordability only, and it publishes no other endpoints. Account
name enquiry should come from Paystack (Resolve Account Number) for accounts at other banks and from core
banking for Alternative Bank accounts.
