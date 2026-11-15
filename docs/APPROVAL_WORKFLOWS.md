# Product visibility, workspace separation and Approval Workflow Management

## New Financing Request (Relationship Managers)

**New Financing Request** (`/requests/new`) shows one card per product the user can initiate. Each card opens that product's existing journey:

| Card | Opens | Journey |
|---|---|---|
| WakeelBoost: Merchant stock financing | `/requests/new/wakeelboost` | the existing WakeelBoost draft form |
| Vendor Financing: Business vendor financing | `/requests/new/vendor-financing` | the existing retail form, product preselected |
| AltDrive: Vehicle financing | `/requests/new/alt-drive` | the existing retail form, product preselected |
| AltPower: Energy and power financing | `/requests/new/alt-power` | the existing retail form, product preselected |

- **Who sees which card.** A Relationship Manager sees all four. Each card appears only for roles that may initiate it:
  - WakeelBoost: RM, ANM, Merchant Officer.
  - Retail products: RM, Team Lead, Unit Head.
- **Unavailable products.** If a product has no approved product configuration, or is closed, its card says so. Its page explains the gap; ARAF never fills in missing rules.
- **The product list** is in `src/lib/origination-products.ts`. Availability rules are in `src/app/(app)/requests/new/catalogue.ts`.

## Workspace separation

- **Delight Officers and Smile Associates sell Altphones only.**
  - The server refuses retail and WakeelBoost drafts from them (`createRetailDraft`, `createDraft`).
  - Their workspace redirects New Financing Request to Altphones.
  - Retail requests a Delight Officer started before this change keep their Outlet Service Supervisor route.
- **Relationship Managers cannot start Altphones sales.** The server refuses a sale (`startSale`) or opening an Altphones application (`viewableApp`) unless the user is its originator, a reviewer of its stages or a Super Admin. Refusals are audited.
- **Request access is checked per record.** `getCase` / `caseAccess` refuse a DO/SA opening an RM request. Hiding a card or button is never the control.
- **Landing page.** Signed-in users see only the workspace cards for roles they hold. The `/enter/<workspace>` routes enforce the same rule. The signed-out page is unchanged.

## Approval Workflow Management (Super Admin)

Open it from **Administration → Approval workflows** (`/admin/workflows`), then pick a product (WakeelBoost, Vendor Financing, AltDrive, AltPower, Altphones). For the chosen product:

1. **See the workflow:** the current version, the stages and approver roles, the credit routes by amount and the version history.
2. **Edit it** (what can change is listed below).
3. **Preview:**
   - the changes against the published version (added, removed or moved stages; changed conditions, thresholds and approvers);
   - example routes before and after;
   - any validation problems, including routing gaps.
4. **Enter a reason** of at least 20 characters. **Publish** stays disabled until there is a change, it passes validation and the reason is filled in.
5. **Publish.** The new version applies at once to requests submitted afterwards; no second administrator is needed. A confirmation shows the product, version, effective time and audit reference (`WF-<product>-v<n>-<id>`).
6. **Restore** any earlier version. It is published again as a new version, with its own reason.

**Simulate a request** shows the expected route for any amount, originating role and policy. It can use either the published version or your unpublished changes. It uses the same routing functions as real submissions and creates nothing.

### What can be configured

| Product | Configurable | Fixed (mandatory controls) |
|---|---|---|
| Vendor Financing, AltDrive, AltPower | **Business reviews, on both the standard and the CX route:** <br>• Head of Retail Sales and Head of Unit can be added, removed or reordered, each with an optional amount condition. <br>• Head of Unit can follow the product configuration ("distinct Head of Unit stage"). <br>**Credit routes for the standard route:** boundaries, first reviewer roles and concurring reviewer roles. | • Team Lead review: first, all amounts. <br>• Outlet Service Supervisor, for requests started by Delight Officers before the channel was retired. <br>• Credit review, or CX credit review. <br>• Second credit review. <br>• Unit Head and Divisional Head. <br>• Originator-independence rules: a Team Lead's or Unit Head's own request skips their own level. |
| WakeelBoost | Credit routes (boundaries and roles) | Business endorsement (by channel), Unit Head, Divisional Head |
| Altphones | none | BPM (Smile Associate sales), Product Manager, Unit Head |

- **Stage order:** approvals run one after another. Parallel approval is not supported, and the editor says so.
- **Approval policy:** which policy a retail product uses (standard or CX) is still set in the product configuration (maker-checker). The workflow defines the stages of each policy.

### Governance checks (publication is refused)

- **No valid route:** there are no credit routes.
- **Amount coverage:** routes don't cover ₦1 – ₦50,000,000, or they overlap or leave a gap.
- **Unknown or unauthorised approvers:** a role isn't an authorised credit reviewer at that level.
- **Credit authority:** a role is given amounts above its existing authority:
  - First review: CO1 up to ₦5m, CO2 up to ₦20m, CO3 up to ₦50m.
  - Concurrence: CO2 up to ₦5m, CO3 up to ₦20m, Credit Leads up to ₦50m.
  - A more senior role is always allowed.
- **Independent concurrence:** the same role is both first reviewer and concurring reviewer.
- **Circular routing:** a business stage appears twice.
- **Unreachable stages:** a stage's amount condition is outside the product range.
- **Missing Team Lead review:** it is absent, not first, or not applied to every amount.
- **Stale edit:** another version was published since the editor opened.
- **Missing reason:** shorter than 20 characters.
- **No changes:** the definition matches the published version.

These checks run in the browser while editing and again on the server (`validateDefinition` in `src/lib/approval-workflow.ts`).

### Versioning and audit

- **Versions table.** `approval_workflows` (migration `042`) holds one row per version. Each row records:
  - product, version, definition, previous version and previous definition;
  - the computed changes and the reason;
  - administrator, role and time;
  - the version it restored, if any.
- **Append-only.** A trigger refuses updates and deletes.
- **Audit event.** Each publication writes `APPROVAL_WORKFLOW_PUBLISHED`, holding the old and new definitions, changes, versions and outcome. Refused attempts write `APPROVAL_WORKFLOW_PUBLISH_REFUSED`.
- **Version 1** of each product is created on first use from `defaultDefinition`. It is exactly the routing in force before workflows became configurable, including the original credit table (`CREDIT_ROUTES`).
- **Recorded at submission.** `applications.workflow_version_id` is set in the submission transaction, under a lock that serialises with publication.
  - A request keeps that version for its whole life, including returns and material-change resubmissions.
  - Publishing never re-routes existing requests.
  - Requests submitted before this change have no version and follow the original routing, which is identical to version 1.
- **What the version controls** for a request:
  - its business-review stages;
  - its credit route (number, first reviewer roles, concurring reviewer roles);
  - the principal check at credit assessment.
- **What stays in code, unchanged:** each stage's own checks (documents, assessments, photo review, the "Before you proceed" checklist).

### Notes

- **Action naming.** Second credit review on Route 1 offers Approve; other routes offer Proceed (unchanged). After a route split, "Route 1" is still the lowest route.
- **Staff financing** has its own approval engine and policy, and is not managed here.
