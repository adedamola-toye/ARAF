# AltBank Retail Asset Factory

Internal Alternative Bank platform for initiating, appraising, reviewing, approving and processing retail
financing: **Vendor Financing**, **Alt Drive** and **Alt Power**. Products are configured, not coded.
Initiation is by **Relationship Managers** and **Delight Officers**. Business review runs through the
Outlet Service Supervisor, Team Lead, Head of Retail Sales and Head of Unit, and credit runs through the
existing credit route table. The lifecycle continues through offers, booking, payment reconciliation,
fulfilment and servicing. See **[docs/RETAIL.md](docs/RETAIL.md)** for retail workflow, configuration,
outstanding business decisions and the new-client checklist.

The platform originated as the WakeelBoost Work Desk. **WakeelBoost (merchant stock financing)** remains
available as a legacy product: its cases keep their WB- references, label and workflow. It includes OTP
sign-in, case-scoped document access and an append-only audit trail.

Stack: **Next.js 15 (App Router) + TypeScript**, **PostgreSQL 16** (plain SQL migrations), private
encrypted object storage (local adapter for development, S3/SSE-KMS in production), and a durable
Postgres-backed **background worker** for email, schedules and quarantine scans. Workflow rules live in
the server-side domain module `src/server/domain/` (see [docs/WORKFLOW.md](docs/WORKFLOW.md)).

> All data in development is **synthetic**. No real customers, BVNs or staff.

## Quick start (development)

Non-developers: follow the step-by-step guide in [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

Prerequisites: Node 20.11+ and PostgreSQL 16 (a local install or a Supabase database). Create a
`wakeel_test` database for `npm test`.

```bash
cp .env.example .env          # development defaults
npm install
npm run db:reset              # migrate + seed real staff, groups and the offer template
npm run seed -- --with-demo   # add the synthetic demo staff and demo cases
# optional: SYNTHETIC retail configuration + retail demo cases (never use as bank policy)
npm run seed -- --with-demo --with-retail-demo
npm run dev:all               # Next.js on :3000 + background worker
```

To run the two processes separately, use `npm run dev` and `npm run worker`.

Open http://localhost:3000, choose a sign-in option and enter a seeded email. The one-time code is
emailed to that address through Resend. Assignment, reminder, closure and digest emails are delivered
the same way once the worker sends them.

### Real accounts

`npm run seed` creates only the real Super Admins: `tomiwa.adebanjo@altbank.ng` and
`paul.toje@altbank.ng`. Run `npm run seed -- --with-demo` to also add the synthetic demo staff below.

### Retail demo accounts (synthetic)

| Email | Roles |
|---|---|
| rm.bola / rm.ade | Relationship Manager (team RETAIL-LAGOS-1) |
| do.ife | Delight Officer (team RETAIL-LAGOS-1) |
| oss.yaba | Outlet Service Supervisor (Yaba Altbox, Ikeja Branch) |
| tl.lagos / tl.abuja | Team Lead (RETAIL-LAGOS-1 / RETAIL-ABUJA-1) |
| hrs / hou | Head of Retail Sales / Head of Unit (business approval) |
| config.approver | Product configuration approver |
| vendor.maker / vendor.checker | Vendor register officers (maker-checker) |
| collections | Collections and servicing officer |

### Demo accounts (all `@altbank.ng`, synthetic)

| Email | Roles |
|---|---|
| superadmin | Super Admin |
| reports | Reporting Admin |
| rm.ade | Relationship Manager (South) |
| anm.north / anm.south | Agent Network Manager (North / South) |
| mo.chi | Merchant Officer **and** RM (demonstrates workspace switching) |
| rbe.lagos / rbe.abuja | Regional Business Executive |
| mo.lead | Merchant Officer Lead |
| anm.lead.north / anm.lead.south | North / South ANM Lead |
| co1 / co2 / co3 | Credit Officers 1–3 |
| lead1 / lead2 | Credit Leads 1–2 |
| unit.head / div.head | Unit Head / Divisional Head |
| do1 / do2 | Disbursement Officers 1–2 |
| legal.officer / shariah.officer | Legal / Shariah closure reviewers |

The seed adds five cases at different stages, from endorsement through a fully closed booking, so every
queue has work in it. `new.officer@altbank.ng` exists only in the bank directory, so you can use it to
try provisioning.

## Commands

| Command | Purpose |
|---|---|
| `npm run migrate` | Apply pending SQL migrations (`migrations/*.sql`) |
| `npm run db:reset` | Drop, migrate and seed the dev database (refused in production) |
| `npm run seed` | Seed real staff and reference data (`--with-demo` adds synthetic staff and demo cases; `--no-cases` skips cases) |
| `npm run demo:routes` | Drive one synthetic case through each credit route end to end and print every handoff |
| `npm run demo:retail` | Reset the dev database and drive three synthetic retail journeys end to end |
| `npm run migration:report` | List records needing a migration decision or manual reconciliation |
| `npm test` | Vitest suite against `TEST_DATABASE_URL` (schema is recreated) |
| `npm run lint` / `npm run typecheck` / `npm run build` | ESLint, TypeScript, production build |
| `npm run worker` | Background worker (outbox, weekly/monthly schedules, quarantine rescans, retention) |
| `npm run mail:test -- you@example.com` | Send one test email through the configured transport |

The test suite has 240 tests, including 48 rows recalculated from the bank's APR workbook and 34 retail tests (`tests/retail.test.ts`, `tests/retail-smoke.test.ts`). It covers:

- **Retail:**
  - RM and Delight Officer routing, both shared business reviews and Head of Unit configuration
  - the document matrix by product and profile, and Vendor Financing eligibility, limit and tenor
  - AFS exceptions, photographs and RM evidence
  - exact DSR boundaries with existing obligations, Alt Drive structures, rates and insurance
  - blocked Alt Power configuration, material-change reassessment, access scope and independence
  - duplicate booking and payment retries, reconciliation and facility closure
  - the Lagos-date request wallet and backward compatibility

- **Routing:** boundary amounts, all three routes end to end, every endorsement path, random eligibility and separation of duties, and unstaffed stages with admin resolution.
- **Workflow rules:** correction and rejection routing, material-change invalidation, the three-report, APR and invoice gates, the production APR block, and the pack, insurance and CRMS gates.
- **Disbursement and closure:** duplicate-disbursement prevention, closure dedupe and retry, vendor confirmation and repayment prompts.
- **Documents and offers:** offer rendering for each entity type, APR fixtures and propagation into emails, and scoped document access with version retention.
- **Bank directory:** CSV/Excel parsing with header aliases, row validation, preview, merge vs full replace (deactivate, never delete) and admin-only, audited imports.
- **Platform:** OTP and idle expiry for every role (polling does not extend sessions), deep-link safety, report exports, audit metadata, reminders, and digest scheduling.

## Architecture

```
src/server/domain/   workflow rules (workflow.ts), routing, assignment/eligibility, access, documents,
                     assessment + apr/ (versioned calculators), offer templates, admin, views
src/server/auth/     OTP (hashed, rate limited, non-enumerating), DB sessions with 5-minute idle timeout
src/server/jobs/     outbox delivery with retries, weekly/monthly schedules, worker tick
src/server/storage/  private object store adapters + upload type sniffing + malware scanner adapters
src/app/             Next.js pages, server actions and route handlers (thin; call the domain module)
migrations/          SQL schema (append-only audit and immutable decisions enforced by triggers)
```

Key guarantees:

- **Transactions.** Each approval and the next task commit atomically. One open task per case is enforced by a unique index. Actions are guarded by idempotency keys, row locks and `lock_version`.
- **Assignment.** Random second-reviewer assignment uses a CSPRNG and is stored once, together with the eligible pool.
- **Money and time.** Money is integer kobo (BigInt where multiplied). Timestamps are UTC, displayed in Africa/Lagos.
- **Sensitive data.** BVN and TIN are AES-256-GCM encrypted and shown masked, with an audited reveal. They never appear in emails, exports or audit payloads.
- **Documents.** Uploads are validated by content, quarantined and scanned. Every view or download needs a live session and a 5-minute HMAC link bound to user and session, and access is re-checked each time. Versions are never deleted.
- **Sessions.** The 5-minute inactivity timeout is enforced server-side for every user. Background polling (`/api/session/status`) and worker jobs never extend a session. On timeout the UI is hidden and a new OTP is required.

## Production configuration

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Vercel (web) + Render (worker) + Supabase
(database and object storage) walkthrough. Do not go live directly: stand up the pre-live **staging**
environment first using [docs/STAGING.md](docs/STAGING.md) (separate Vercel project, Render worker
blueprint `render.staging.yaml`, Supabase project and keys, synthetic data only).

Set `APP_ENV=production`. Then:

- **Development adapters are refused.** The local file store, test mailbox, dev scanner and published dev encryption keys all throw at use.
- **Secrets.** Generate `FIELD_ENCRYPTION_KEY`, `APP_HMAC_KEY` and `STORAGE_ENCRYPTION_KEY` with `openssl rand -base64 32` and keep them in the bank's secret manager. Rotating the field key requires re-encryption. Values are versioned (`v1:`).
- **Storage.** Use `STORAGE_DRIVER=s3` with a private bucket (block public access), `S3_KMS_KEY_ID` for SSE-KMS, and IAM limited to the bucket. Credentials are read from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. For S3-compatible providers that reject SSE headers (Supabase Storage, Cloudflare R2, some MinIO setups) set `S3_SERVER_SIDE_ENCRYPTION=none`.
- **Serverless hosting (Vercel, Render, Railway).** The local filesystem is read-only or ephemeral, so `STORAGE_DRIVER=local` (the default) makes every upload fail with a 500. Set `STORAGE_DRIVER=s3` and a real bucket before testing uploads. Vercel also caps a function request body at 4.5 MB, so keep `MAX_UPLOAD_BYTES` at or below 4 MB there. To accept larger files on Vercel, upload directly to the bucket with presigned URLs (not implemented).
- **Scanning.** This deployment runs without ClamAV: set `SCANNER_DRIVER=none` on both the web app and the worker. Uploads are accepted and marked clean immediately; this is an explicit security tradeoff. The development `dev` (EICAR-only) adapter and the `defer` adapter remain available, but `defer` must never be used by the worker itself.
- **Email.** Use `MAIL_DRIVER=smtp` with the bank-approved relay, or `MAIL_DRIVER=resend` with `RESEND_API_KEY` and a verified sending domain in `MAIL_FROM` (Resend and Cloudflare DNS steps in [docs/EMAIL.md](docs/EMAIL.md)). Set `CLOSURE_MAX_ATTACHMENT_BYTES` to the provider's limit; larger packs go out as an authenticated link.
- **Network.** Set `TRUSTED_PROXY_HOPS` to the number of reverse proxies so the audit records the real client IP. Set `COOKIE_SECURE=true` (HTTPS only).
- **Directory.** Upload the bank's staff export at **Administration → Bank directory** (Super Admin; .xlsx or .csv with Email and Full name, optionally Department, Group mailbox, Active). Preview first, then import as *Add and update* or *Full replace* (missing people are marked inactive, never deleted). For scripted loads of a CSV, `npm run directory:import -- <file.csv> [--dry-run]` also works. Provisioning and recipient groups validate against it. Then create the first Super Admin with a one-off SQL insert; there is no public registration.
- **Processes.** Run `npm run migrate`, then `npm run build && npm start`, and at least one `npm run worker`. Several workers are safe because they use `SKIP LOCKED` and advisory locks.
- **Retention.** `RETENTION_YEARS` sets `retention_until` on closure or rejection. `RETENTION_PURGE_ENABLED=true` lets the worker purge blobs after that date (the metadata and audit stay).

## Unavailable production inputs (development adapters in use)

| Input | Status in this build | To go live |
|---|---|---|
| **DSR and facility pricing** | **Implemented** as `wakeelboost-pricing@2026.1`, the default calculator (`src/server/domain/pricing.ts`).<br>Rates depend only on the period: **1–3 months 10%, 4–6 months 15%**, capped at 6 months. Rates and maximum tenor are set by the Super Admin; the 6-month ceiling is enforced in code and in the database.<br>The principal is capped at ₦50,000,000 (single obligation limit). It may differ from the requested amount within the same credit route.<br>Repayment is monthly, or weekly at 4 instalments a month. DSR always uses the monthly equivalent.<br>**Total DSR must be within 10% of turnover.** Above that, first-review approval needs a written justification plus uploaded evidence (e.g. a second bank statement); this is recorded and shown to later approvers.<br>All arithmetic is exact, in integer kobo. The bank's acceptance case is a regression test and seeded demo. APR is disclosed separately (bank workbook formula). | None outstanding. |
| **Offer letter templates** | **Implemented** from the bank's Murabaha Individual / Enterprise / Corporate letters (9-1-24). One Word template per applicant type, with an editable .docx generated per case plus a PDF copy for preview. The sample customer data and the scanned signatures were removed (see docs/OFFER_TEMPLATES.md). Seeded as **awaiting bank approval**: production offer generation is blocked until the Super Admin approves each template. | Review a generated letter of each type, then Super Admin → Offer templates → Approve for production. The second signatory (Omoseni Ademowo, Head, Payment & Collection) is set by migration 005 and can be changed on the same page. |
| **Brand / typeface** | Golden Yellow #FFC900 and Deep Graphite #1C1D20 tokens (`src/app/globals.css`), "Wakeel" text wordmark, dark theme by default. Century Gothic is used where installed; it is a licensed font and is not bundled. | Supply a licensed Century Gothic web font (add an `@font-face` in `globals.css`) and the approved logo asset if wanted. |
| **Photograph and logos** | The approved family photograph, Alternative Bank logo and NIFI logo (`public/images/landing/`) are used on the landing and sign-in screens. Usage rights confirmed by the product owner. | None outstanding. |
| **Invoice portal, CRMS, core banking** | Staff attestations ("Logged invoice on invoice portal", "Logged CRMS") and recorded booking. **No funds are transferred.** | Integrate when the bank supplies approved APIs. |
| **Bank directory** | Seeded `bank_directory` table; Super Admin upload (Excel/CSV, preview, merge or full replace, audited) at Administration → Bank directory. | Upload the HR/AD export; a scheduled automatic import can be added when the bank supplies a feed. |
| **Email channel, malware scanning, object storage** | Resend email delivery, no malware scanner (`SCANNER_DRIVER=none`), S3-compatible object storage. | SMTP relay if required by the bank; a real scanning service before handling untrusted files. |

## Interface

The UI follows the accepted landing reference and the UI handoff. It has:
- a full-bleed merchant photograph on the sign-in, OTP, expired-session and error screens, with the exact landing copy
- a compact side navigation scoped by role, with a mobile menu and a profile menu holding the workspace switcher and sign-out
- request pages with a progress timeline and Overview / Documents / Assessment / Activity tabs, and a sticky action panel showing each gate and the exact reason an action is blocked
- uploads with progress and retry, a confirmation summary before **Disbursed**, and Disbursed → Awaiting Vendor Payment Confirmation → Closed states
- tables that become cards on phones

The RM / ANM / Merchant Officer / Staff choice is on the OTP step ("Open workspace"), so the landing page keeps the reference's single email field.

## Design decisions to confirm with the product owner

- **Business endorsers** can also return a request for correction, in addition to endorse and reject.
- **Credit Officer 3 at pack review** can return the pack to the initiator.
- **Lead final review** (Routes 2 and 3) offers Proceed and Reject only, as specified.
- **Reminders** are allowed once an assignment is older than 6 hours, and at most once per 6 hours for the same assignment.
- **Weekly digest** reports the past week's disbursements and the coming Monday–Sunday repayments. It is skipped for initiators with nothing to report.
- **Material change** requires a fresh credit review and keeps the business endorsement. The second reviewer is kept if still eligible (no re-drawing).
- **Reporting Admins** with a state on their assignment see only that state. Monthly recipients holding only ANM Lead roles get summaries for the states in their zone.
