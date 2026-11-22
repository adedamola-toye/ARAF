# ARAF premium enhancement: audit and phased plan

The aim is to raise ARAF to a premium standard without rebuilding it. The public landing page, sign-in, OTP, records, integrations, banking controls and the CRM module are preserved. Each phase ships on its own branch, is tested, and reaches production only when the business says "merge to main" (main deploys automatically).

## Decisions taken (21–22 Nov 2026)
| Topic | Decision |
|---|---|
| Colours for the signed-in app | Charcoal #1C1D20 ink on white with neutral grey surfaces. Yellow #FFC928 is used only for primary actions and the active navigation item. Landing, sign-in and OTP are unchanged. |
| Typography | Manrope (page titles, financial figures) and Inter (everything else), self-hosted. Manrope has no ₦ glyph, so ₦ falls back to Inter by design. |
| Divisional Head bouquet approvals | Fully built behind a Super Admin switch that stays **off** until bank risk governance approves. Individual Divisional Head approval continues meanwhile. |
| Verified salaries (Staff Salary Advance) | A salary register in ARAF, maintained through validated CSV upload and individual edits by authorised staff, audited and confidential. |
| Delivery | Phase by phase, each reviewed before release. |

## 1. Repository and architecture audit
- **Framework:** Next.js App Router (React server components and server actions), TypeScript and PostgreSQL through `pg` with plain SQL. Migrations are numbered SQL files in `/migrations`, applied by `npm run migrate`.
- **Deployment:** the web app on Vercel; the background worker (`npm run worker`) on Render, which applies migrations before each deploy. Both auto-deploy from `main`.
- **Authentication:** email OTP, server-side sessions (`sessions` table) with a 5-minute idle timeout, and a role-based "workspace" selection. Roles are stored in `role_assignments`. CRM access is separate (team membership plus the CX_HEAD role).
- **Authorisation:** every server action and route checks roles and case access on the server (`caseAccess`, `holdsRole`, staff-financing policy, Altphones policies). Maker-checker and self-review guards are built into the workflow engine.
- **Products:**
  - WakeelBoost, Vendor Financing, AltDrive and AltPower: product registry, versioned product configuration, and a configurable approval workflow engine.
  - Altphones: its own module, with inventory, reservations, locations, Paystack and mandates.
  - Staff Salary Advance: its own module, with Product Manager → Unit Head → Divisional Head approval, a 24-hour offer, disbursement officers and a Legal/Shariah handover.
- **Routing:**
  - RM classification (DBC / Non-DBC), RBE.
  - CX Credit Review → Credit Officer bands → Unit Head → Divisional Head.
  - Merchant Officer hierarchy.
  - Outlet Service Supervisor role (exists).
- **Financing calculations:**
  - Server-side in `src/server/domain/apr/*`, `affordability.ts` and `retail-credit.ts`, using integer kobo and BigInt formatting.
  - DSR = (existing monthly obligations + proposed monthly instalment) ÷ approved monthly denominator, with configurable limits per product.
- **Documents:**
  - Private object storage (S3-compatible in production) with magic-byte type checks, malware scanning, quarantine, versions and signed short-lived links.
  - Every read is audited.
  - Closing documents (offer, GSI, Remita) are generated automatically.
- **Uploads:**
  - Sent through Next.js server actions or API routes on Vercel. The configured limit is 15 MB (`MAX_UPLOAD_BYTES`) and server actions allow 25 MB, **but Vercel serverless functions reject request bodies above ~4.5 MB.**
  - This is the most likely cause of large bank statements failing. The fix is in Phase 2: direct-to-storage uploads (presigned, multipart for large files), then server-side finalisation (type check, scan, record).
- **Notifications:**
  - In-app (`notifications`) and a transactional email outbox (`notification_outbox`, sent by Resend through the worker).
  - SLA reminders every 3 hours, service-target escalations and invoice-confirmation dispatch.
- **Reporting:**
  - Performance Overview with drill-down and CSV, retail dashboards, God's Eye (read-only), "Requests I approved", CRM analytics.
  - Weekly Sunday 18:00 (Lagos) emails: the Divisional Head report and Unit Head / Team Lead team reports.
- **Audit:** an append-only `audit_events` table (actor, role, IP, device, correlation id, details sanitised), plus per-module event tables.
- **Theme:** light, dark and system, persisted in a cookie and localStorage with no flash on load. The landing page uses its own CSS module.
- **Jobs (worker):**
  - Email outbox, weekly and monthly reports, the Divisional Head weekly report, SLA reminders and escalations.
  - Closing documents, invoice dispatch, facility archives, stale-draft expiry, arrears refresh.
  - Staff offers (expiry and reminders), staff documentation and Legal/Shariah handover.
  - CRM escalations and reports, rescans.

## 2. Inventory: retain, enhance, introduce
| Area | Exists today | Plan |
|---|---|---|
| Design system | Nunito Sans / DM Sans, navy tokens, shared CSS components | **Phase 1:** scoped Manrope/Inter and charcoal/yellow tokens; `Money` figure component; privacy masking; collapsible sidebar; mobile bottom navigation; regrouped navigation |
| RM dashboard | Action queue, Requested Today, My performance | **Phase 2:** a role-aware home (financing initiated today, week, month and year; drafts; actions) built from real records only |
| New application | Customer type → product filtered by permissions and configuration; retail draft form with server-side calculator | **Phase 2:** staged origination, a live server-calculated summary, comma-formatted amounts, and BVN and phone validation (11 digits) |
| Drafts | Drafts saved; stale drafts expire automatically | **Phase 2:** visible autosave state, resume, progress, and delete with confirmation (drafts only) |
| Action queue | List with filters | **Phase 2:** prioritised inbox (overdue, urgent, new, returned), split-pane on desktop, "next case" after completion |
| Documents | Upload, versions, scan, preview via signed link | **Phase 2:** checklist UI, direct-to-storage large uploads with progress and retry, an in-app PDF viewer, split-screen review, per-document correction requests |
| Location selection | Location master and dependent pickers | **Phase 2:** reproduce and fix the reported submission failure (details needed, see section 6) |
| DSR | Server-side, per application | **Phase 2:** audit. The code adds only the existing obligations entered on the application, not other drafts. Evidence of the reported aggregation is needed to reproduce it. Show the configured limit next to the result. |
| Team Lead | Verification; business photograph with skip reason and Super Admin switch (exists) | **Phase 3:** focused workspace; carry the skip reason prominently to later approvers |
| Credit Officer, Unit Head | Assessment, approvals | **Phase 3:** assessment workspace with document split view; consolidated Unit Head decision view with exceptions shown by default |
| Divisional Head | Individual final approval | **Phase 3:** Facility Bouquet (aggregation, genuine random sampling, inspection records, exclusions with reasons, transactional concurrence, idempotent), **switched off by default** |
| Offer letters | Generated from approved terms; 24-hour staff offer; signed upload | **Phase 3:** in-app preview, expiry tracking, acceptance status |
| Disbursement (CAD) | Disbursement Officer 1 / 2 maker-checker; confirmation with transaction reference and evidence | **Phase 3:** CAD workspace, pre-disbursement checklist, duplicate protection, held / failed / uncertain states, a completion screen. ARAF has **no payment-posting integration**, so success is the officer-confirmed posting reference, never a button click. |
| Legal and Shariah | ZIP archive plus SharePoint handover, status only after confirmed delivery (exists for salary advance and retail) | **Phase 3:** checks and consistency across products |
| Staff Salary Advance | Employee-entered request; Product Manager verifies salary; SeedFi check on the staff route; 2% fee; 50% limit | **Phase 4:** confidential salary register (CSV and individual edits), automatic eligibility (configurable %), the SeedFi check removed **for this product only**, a personal-banking home (available advance, slider, "You will receive"), active and repaid states from confirmed records |
| Product configuration | Versioned settings, direct publish by Super Admin, history | **Phase 5:** add bouquet participation, salary-advance %, fee, photo requirement and offer expiry in one place |
| Users and permissions | Super Admin edits staff (recently extended); reassignment by Super Admin only | **Phase 5:** Team Lead profile editing limited to their scope and permitted fields |
| Sunday emails | Divisional Head report, Unit Head / Team Lead team reports | **Phase 5:** "Weekly Performance Briefing" for every role's own scope, with previous-period comparison, preview and test send |
| Audit trail | Raw events with filters | **Phase 5:** readable per-application history and exports |
| CRM | Complete (separate track) | **Not touched** beyond inheriting the new visual tokens |

## 3. Database migrations (planned, additive only)
No existing data is changed or deleted. Every migration only adds tables or columns, or adds settings with defaults that keep today's behaviour.
- **Phase 2:** `upload_sessions` (direct-to-storage uploads: object key, size, parts, status, expiry); `document_corrections` (flagged document, reason, requester, resolution).
- **Phase 3:**
  - `bouquets`, `bouquet_members`, `bouquet_inspections`, `bouquet_exclusions`.
  - Bouquet settings: off by default.
  - Disbursement attempt records: idempotency key, status, reference, outcome.
- **Phase 4:** `salary_register`, `salary_register_imports` (history), salary advance eligibility settings (percentage and fee, defaults 50% and 2%).
- **Phase 5:** report snapshots; Team Lead profile-edit scope.

## 4. Security implications
- Salary data is confidential:
  - It is only readable by the employee (their own record), authorised register administrators and the approvers of that employee's request.
  - It never appears in general emails or exports.
- Direct-to-storage uploads use short-lived presigned URLs bound to an upload session and the uploader. Nothing is served until the server has checked the type, size and malware scan.
- Bouquet concurrence:
  - Membership is frozen and every member's approved version re-checked inside one transaction.
  - The decision is idempotent.
  - Each facility gets its own concurrence and audit record.
  - Excluded facilities never inherit the decision.
- Payments: no automatic retry of an uncertain outcome; duplicate-disbursement guard by facility and idempotency key.

## 5. Regression risks and testing
- **Landing page:** pixel comparison against baselines (desktop, tablet, mobile; light and dark) on every phase. Phase 1 result: 12 of 12 identical.
- **Workflows:** the full automated suite (51 files, about 583 tests) must pass in every phase, plus new tests per feature.
- **Calculations:** worked examples become tests, for example salary ₦1,900,000 → limit ₦950,000, fee ₦19,000, net ₦931,000, repayable ₦950,000.
- **Screens:** screenshots of each new screen on desktop and mobile, in light and dark, with checks for horizontal overflow.

## 6. Open business-policy questions (not assumed)
1. **Location selection failure:** please share the product, the location chosen and the error shown (or a screenshot) so it can be reproduced.
2. **DSR aggregating drafts:** the current code does not add other applications or drafts into DSR. Please share an application where the DSR looked wrong.
3. **Bouquet policy:**
   - Eligible products.
   - Maximum bouquet size.
   - Aggregation timing (daily? on demand?).
   - Required number of sampled facilities.
   - Whether an excluded facility returns to individual Divisional Head review or to the originator.
4. **Salary advance repayment:** what counts as a confirmed repayment event (payroll deduction file? manual posting?) and who records it.
5. **CAD:** whether a payment-system integration is planned. Until then, an officer-confirmed posting reference with maker-checker is the authoritative mechanism.

## 7. Rollback
Each phase is one merge commit on `main`. To roll back, revert that merge commit and push. Vercel and Render redeploy the previous code automatically. All migrations are additive, so the previous code keeps working with the new columns and tables present. Feature switches (for example bouquets) can also be turned off from Administration without a deploy.
