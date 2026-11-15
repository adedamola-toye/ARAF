# Onboarding guides and approval verification

## First-time welcome and role tours

- The first time a user opens a role's workspace, ARAF shows **"Welcome to ARAF"** with the role name and two choices: **Take a quick tour** or **Skip for now**. Closing it (Esc) counts as skipping.
- It is shown once per user and role. It is not shown again after logging out and back in, or on another device. When a user is given a new role, the welcome is offered the first time they open that role's workspace.
- Users who already had sessions before this release were backfilled (`migrations/041_onboarding_backfill.sql`) and are not shown the welcome automatically. They can open any guide from **Help & Guides**.
- While the welcome is due, the daily performance summary is not shown, so the two dialogs never stack.
- Tours (`src/lib/onboarding/tours.ts`) highlight real interface elements marked with `data-tour` attributes. Navigation items get `nav:<href>` automatically from `NavLink`. A step is left out when its element is not on the page (the feature is not available to that user), so tours follow each user's actual permissions. Tours only navigate and highlight; they never submit, approve or change anything.
- Each step shows a heading, explanation, "Step n of N" with a progress bar, and **Back / Next / Finish / Skip tour**. Esc skips. On a phone the panel is centred at the bottom of the screen.
- **Help & Guides** (profile menu → `/help`) lists the guides for every role the user holds, with their status, and lets them replay any guide.

### State tracking

`onboarding_states` stores one row per `(staff_id, role)`: `guide_version`, `first_seen_at`, `started_at`, `completed_at`, `skipped_at`, `last_step`. Events are recorded only for roles the user actually holds (`src/server/domain/onboarding.ts`).

To change tour content, edit `tours.ts`. Bump `GUIDE_VERSION` only to record the version a user saw; existing users are **not** forced through updated content.

## Approval verification ("Before you proceed")

Before a positive decision, the reviewer must tick every item of the checklist for their stage. A positive decision is approve, certify, recommend, endorse, proceed or concur. The dialog shows:

- the verification message;
- the application reference;
- the proposed action.

**Confirm** stays disabled until every item is ticked. **Cancel** leaves the form exactly as it was. Ticks are cleared each time the dialog opens, and the checklist cannot be switched off. Return and Reject need only a reason.

| Where | Stage | Checklist |
|---|---|---|
| Retail / VF / Alt Drive / Alt Power | Team Lead review | `TL_CERTIFICATION` |
| | First credit review (CX route) | `CX_REVIEW` |
| | First credit review (other routes) | `CREDIT_APPRAISAL` |
| | Second credit review (concurrence) | `CONCURRENCE` |
| | Unit Head review | `UNIT_HEAD` |
| | Divisional Head review | `DH_FINAL` |
| | Business endorsement / OSS / HRS / HOU | own lists |
| Altphones | BPM / Product Manager / Unit Head approval | `ALT_BPM`, `ALT_PM`, `ALT_UH` (replaces the old "reviewed" tick) |
| Staff financing | Unit Head / Divisional Head approval | `STAFF_UH`, `STAFF_DH` |

These stages have no checklist:

- operational stages: offer pack, disbursement, booking;
- the staff financing Product Manager forward, which keeps its existing review checks.

Checklists are defined in `src/lib/approval-checklists.ts`. Changing an item means bumping that checklist's `version`.

### Server enforcement (`src/server/domain/verification.ts`)

The server re-checks every acknowledgement inside the decision's transaction. It refuses:

- a missing or incomplete acknowledgement (VALIDATION);
- an out-of-date checklist id or version (CONFLICT);
- an acknowledgement made on a version of the record that has since changed, where `viewedVersion` ≠ `lock_version` (CONFLICT).

The acknowledgement is written to `approval_verifications` in the same transaction as the decision, together with an `APPROVAL_VERIFIED` audit event. So neither can be saved without the other. Each row records:

- staff, role, stage and decision;
- checklist id and version, and the item texts;
- subject version and time;
- outcome and task.

The table is append-only: a trigger refuses updates and deletes. Duplicate submissions are prevented by the existing idempotency keys and lock versions. Revoked roles are refused as before.

Test helpers that act as reviewers acknowledge the full checklist automatically:

- `actAs` / `withVerification` (`src/server/demo/scenario.ts`);
- `decideV` (Altphones);
- `headDecisionV` (staff financing).

Pass `verification: null` to test a missing acknowledgement.
