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

## 8. Phase 3 as delivered
- **Facility Bouquet** (`src/server/domain/bouquet.ts`, `/bouquets`, `/admin/bouquet-settings`, migration 054).
  - Feature switch `BOUQUET_APPROVALS` is **OFF** by default. Even when on, nothing aggregates until a Super Admin names the eligible products.
  - Facilities with material exceptions are always kept for individual review: credit score exception, DSR exception, policy exception, skipped business photograph, suspension, open correction, or an amount above the configured threshold.
  - Random sampling uses `crypto.randomInt` and prefers facilities not yet inspected. Inspections, exclusions (with reason), restores and samples are all audited.
  - Concurrence is all-or-nothing in one transaction. Every facility is re-locked and re-checked: same task, same approved version, unchanged, still eligible. Each facility then gets its own Divisional Head decision, task completion, stage move to offer preparation, audit record and originator notification.
  - Re-running a concurrence returns the recorded outcome. Concurrence never disburses.
- **CAD workspace** (`src/server/domain/cad.ts`, `/disbursements`, `/disbursements/[id]`, panel on the request page).
  - Read-only pre-disbursement checklist computed from records.
  - Holds with reasons block the DO1 check and the booking.
  - Failed and uncertain posting attempts. An uncertain attempt blocks booking until someone verifies in core banking whether it posted; a verified posting pins the booking to that reference.
  - The completion screen exists only for a recorded disbursement. The existing maker-checker (DO1 checks, DO2 books) and the duplicate-reference guard are unchanged.
- **Offer letters** (`/offers`): status (being generated, awaiting signed acceptance, accepted), how long acceptance has been outstanding, and an in-app preview.
  - Offers are still generated only from approved terms.
  - No acceptance period is configured for WakeelBoost or retail products, so nothing expires. The staff 24-hour offer window is unchanged.
- **Legal and Shariah:** reviewed, no change needed.
  - WakeelBoost shows "Delivered" only after the email outbox has sent the pack.
  - The retail archive is marked sent only after the ZIP is stored.
  - Staff Salary Advance is marked sent only after the hand-off has completed.
- **Not yet done:** Team Lead, Credit Officer and Unit Head workspace redesigns (the request page already shows the split document view, exceptions and skipped-photo notices). These are carried into later phases.

## 9. Phase 4 as delivered (Staff Salary Advance)
- **Off until switched on.** A Super Admin publishes a settings version with *Automatic from the salary register* (Administration → Salary advance settings). Until then the current manual route, including the SeedFi check, is unchanged.
- **Salary register** (`src/server/staff/register.ts`, `/admin/salary-register`, migration 055), maintained by the new **Salary Register Administrator** role (and Super Admins).
  - CSV upload with a full preview, validation (format, duplicate staff ID or sign-in, unknown staff, name mismatch, account digits, employment status, dates), apply or discard, and import history.
  - Individual edits and eligibility holds, each with a reason and an append-only history.
  - Account numbers are encrypted. The audit trail records which fields changed, never salary values.
- **Eligibility, computed server-side:**
  - limit = verified monthly salary × configured % (default 50%);
  - available = limit − outstanding advances − amounts reserved by requests in progress.
  - Worked example: ₦1,900,000 → ₦950,000 limit; on ₦950,000 the fee is ₦19,000 and the employee receives ₦931,000; total repayable ₦950,000.
  - A missing, outdated (older than the configured number of days, default 45), held, or non-active record is an exception with a clear message, never a silent approval.
  - Submission locks the employee's register record, re-checks availability and stores a snapshot, so two requests cannot use the same limit.
- **Credit bureau check:** removed on the register route for this product only. Other products are unchanged.
- **Approvals unchanged:** Product Manager → Unit Head → Divisional Head, then the 24-hour offer and disbursement. On the register route the Product Manager no longer repeats the account, salary and limit checks; the snapshot shows them.
- **Confidentiality:** salary figures are shown only to the employee, the approvers of that request, and register administrators.
- **Repayments:** recorded only as confirmed events (payroll deduction file or posted transfer) with a unique reference. They are the only thing that reduces an outstanding balance. ARAF creates no salary deduction or mandate.
- **Personal home** (`/staff-request` on the register route):
  - greeting and Available advance with an eligibility badge and **Get an advance**;
  - while an advance is active: Outstanding balance, repayment progress, amount received, fee, repaid, and available limit;
  - "All settled" when fully repaid;
  - previous advances and how it works.
- **Application:** slider, presets and manual entry, capped at the available amount. "You will receive" is the dominant figure, with the fee and total repayable shown separately. The verified account is shown read-only.
- **Still open:** who confirms repayments, and from what source (payroll file or manual posting). For now the Salary Register Administrator records them.

## 10. Phase 5 as delivered (governance and reporting)
- **ARAF Weekly Performance Briefing** (`src/server/jobs/briefing.ts`):
  - Subject: `ARAF | Weekly Performance Briefing | Week Ending …`.
  - "Your week in review" leads with successful disbursements (recorded postings) and compares them with the previous week. It then shows: applications received (drafts never counted), final approvals (never counted as disbursements), median turnaround, applications exceeding the service level, performance by product, month-to-date disbursements, progress against the approved monthly target, bouquets concurred (Divisional Head), and attention items.
  - The Divisional Head report now opens with this bank-wide block.
  - **Personal briefings** for originating officers (RM, ANM, Merchant Officer line, Team Lead) are **switched off** until a Super Admin turns them on in Scheduled emails. Preview and test send (to the Super Admin only) are available.
  - Once per person per week, with delivery logging and catch-up (existing schedule machinery).
  - The email has a white card, restrained yellow accent, Outlook-safe tables, an Open ARAF button and a confidential footer. It contains no customer identifiers or salaries.
- **Readable audit history** (`src/lib/audit-events.ts`):
  - Each request's Activity tab shows what happened, who did it and in what role, previous → new state, bouquet and transaction references, and comments.
  - Views, scans and saves are hidden unless asked for.
  - The system audit has a "What happened" category filter, readable descriptions and a CSV export with the same filters.
  - Secrets, salaries, account numbers and long identifiers are redacted. Audit records remain append-only (database triggers).
- **Configuration centre:** one place for the bouquet, business photograph requirement, salary advance (eligibility %, fee, record validity), salary register, disbursement controls and offer acceptance (24 hours for salary advance; none configured for other products), team profile editors and the weekly briefing, each with its live status.
- **Team Lead profile editing:**
  - Only Team Leads a Super Admin designates (Administration → Team profile editors).
  - Only people in their own team, and only full name and business unit. Never roles, status, region or access.
  - Audited with before and after values.
- **Reassignment:** stays Super Admin only, with a reason, the previous and new assignee, and an audit record. The previous assignee is now also notified.
- **Migrations:** 056 adds the personal briefing schedule (off); 057 adds `team_lead_profile_editors`.

## 11. Phase 6 as delivered (quality pass)
- **Skeleton loading** for every signed-in page (`src/app/(app)/loading.tsx`). Navigation and the header stay in place while the content area shows the page's shape. The pulse stops when reduced motion is requested.
- **Interaction feedback** of about 150–180 ms: row hover, a button press, tile hover and alerts easing in. Nothing loops and nothing delays an action. Everything respects `prefers-reduced-motion`.
- **Touch targets on phones:** buttons, tabs and form fields at least 44 px (small buttons 40 px); report table sort buttons 36 px; larger checkboxes.
- **Responsive sweep:** 23 key screens across six roles (RM, Unit Head, Divisional Head, Disbursement Officer, staff applicant, Super Admin), at 360 (light), 390 (dark), 768, 1024 and 1440 px. That is 115 checks for page overflow, off-screen elements, clipped money figures, small touch targets, unlabelled controls and page errors. The first run found 10 issues: clipped hero figures in three-column rows, a configuration badge overflowing, and small sort buttons. All were fixed; the re-run found 0.
- **Keyboard:** tabbing through seven key screens. Every focused control shows a visible focus indicator; table rows show it on the whole row.
- **Landing and sign-in:** compared with the Phase 1 baseline (desktop, tablet, mobile; light and dark), all 12 are pixel-identical. The only differing pixels were the development-mode Next.js badge, which does not exist in production.

## 7. Rollback
Each phase is one merge commit on `main`. To roll back, revert that merge commit and push. Vercel and Render redeploy the previous code automatically. All migrations are additive, so the previous code keeps working with the new columns and tables present. Feature switches (for example bouquets) can also be turned off from Administration without a deploy.
