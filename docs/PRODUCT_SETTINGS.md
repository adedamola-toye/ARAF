# Product Settings

Administration → **Product settings** (`/admin/product-settings`) is where a Super Admin sets up and maintains each product's rules. It replaces the earlier "Products and rules" proposal-and-approval screen; `/admin/products` now redirects a Super Admin here.

## Why it changed

Previously, product rules could only be changed by proposing a new version that a *different* person holding `PRODUCT_CONFIG_APPROVER` had to approve. The editor appeared only when an approved version already existed and no proposal was open. The three system proposals inserted by migration 025 (CX route, 30% DSR, 12-month minimum tenor) have no proposer, so nobody could withdraw them. Without an active approver, nothing could be changed: a deadlock.

## Products and statuses

The list shows every product in the `products` table, plus Altphones, with search. Each product has one of these statuses:

| Status | Meaning |
| --- | --- |
| Not set up | No published version; new requests cannot start |
| Draft in progress | A saved, unpublished draft exists |
| Published | The version in force has no configuration gaps |
| Published, incomplete | The version in force still has gaps that block later steps |
| Scheduled | The first version has a future effective date |
| Closed to new applications | The product is switched off |

## Editing (Vendor Financing, AltDrive, AltPower and any new retail product)

The product page has six sections:

1. **General**
   - name, description, owner;
   - open or closed;
   - who can originate it;
   - effective date;
   - draft expiry.
2. **Eligibility & KYC**
   - customer profiles offered;
   - eligible customer types and eligibility conditions;
   - statement and payslip periods, and statement recency;
   - asset criteria;
   - consents.
3. **Financing & Pricing**
   - minimum and maximum amount;
   - minimum and maximum tenor;
   - contract structures with rate, rate method, insurance and contract steps;
   - DSR, income basis and income recognised;
   - equity contribution, turnover cap;
   - beneficiary register, fulfilment steps.
4. **Approval Workflow**
   - approval chain and the Head of Unit stage;
   - a link to the versioned approval workflow editor (`/admin/workflows/<code>`).
5. **Documentation**
   - documents per stage: requirement, number of files, the amount above which a conditional document applies, and guidance;
   - business photographs;
   - RM proposal.
6. **Controls & Exceptions**
   - DSR exceptions and their authority;
   - audited-accounts threshold and its authority;
   - management visit;
   - restructuring authority.

**Fixed controls** are shown with a lock and cannot be switched off:
- BVN/identity verification and KYC;
- the SeedFi credit check;
- Shariah contract steps;
- segregation of duties and no self-approval;
- the approval verification checklist;
- monthly repayment frequency;
- fees entered at credit assessment;
- alternate approvers drawn from the role pool;
- escalation through the service targets.

### Draft → Review → Publish

- **Set Up Product** (no previous version): start from the parameters supplied by the bank, or from a blank form. **Edit Configuration** starts a draft from the version in force.
- There is **one draft per product**, stored on the server (`product_config_drafts`). **Save Draft** shows *Saved* only after the server confirms. Each save carries a revision number, so a save from a stale window is refused with "Reload the latest draft".
- Fields with errors are highlighted inline, and the section shows a red marker. A completeness bar shows progress. **View Changes** compares the draft with the version in force.
- **Review Configuration** saves the draft, then runs the server's checks:
  - required values, amount and tenor ranges, and rate method;
  - DSR exception authority;
  - documents that depend on statement or payslip periods;
  - known contract types and document types;
  - origination roles within the product type;
  - any configuration gap that would block submission.
  It also warns about later steps that stay blocked and about approver roles that no active staff hold.
- **Publish Product Rules** requires a reason of at least 20 characters and an effective date (today or later). In one transaction, it:
  1. inserts the next version as `APPROVED`, with `published_via = 'DIRECT'`, the previous version, the list of changes and, for a restore, `restored_from`. Publishing with no previous version creates **version 1**;
  2. applies the General settings to `products` (name, description, owner, `origination_roles`, active);
  3. marks any open proposals `WITHDRAWN` ("Superseded by version N, published directly by a Super Admin");
  4. deletes the draft;
  5. writes the audit event `PRODUCT_RULES_PUBLISHED`, with the old and new configuration, the old and new general settings, and the changes.

  The confirmation shows the version, effective date and audit reference (`PR-<code>-v<n>-…`). A refused publication is audited as `PRODUCT_RULES_PUBLISH_REFUSED`.
- No second approver is involved. Published versions stay immutable: the existing database guard prevents changes to them.
- Requests keep the version they started under (`applications.product_config_id`). A future-dated version applies only to requests started on or after its date.

### History, compare and restore

- **Version history** lists every version with its status, who published or proposed it, the effective date, the reason and its changes.
- **Compare versions** shows the differences between any two versions.
- **Restore version N as a draft** loads an earlier version. Publishing it creates a new version, recorded as restored from N.

### Earlier proposals

Open proposals from the earlier process are listed with what they would change. For each one, you can:
- **Load into draft**, then review and publish it yourself; or
- **Dismiss** it with a reason (audited as `PRODUCT_PROPOSAL_DISMISSED`; it stays in the history).

Nothing is approved automatically.

## Origination roles

`products.origination_roles` (null means every permitted role) narrows who can originate a product, within a fixed ceiling:

| Product | Roles that can originate |
| --- | --- |
| Retail products | RM, Team Lead, Unit Head |
| WakeelBoost | RM, ANM, Merchant Officer |
| Altphones | Delight Officer and Smile Associate only (not configurable) |

The setting is enforced in three places:
- the product cards (`visibleProducts`, `availability`);
- the request pages;
- the server (`createRetailDraft` and WakeelBoost's `createDraft`).

## Minimum financing amount

`profiles.*.minAmountKobo` (optional) is checked by request readiness ("The minimum for this product is …") and shown in the affordability checks.

## WakeelBoost and Altphones

These keep their existing settings logic, laid out in the same six sections.

**WakeelBoost**
- General settings (name, description, owner, availability, origination roles) are saved directly with a reason, audited as `PRODUCT_GENERAL_SETTINGS_CHANGED`.
- Pricing: `/admin/pricing`.
- Workflow: `/admin/workflows/WAKEELBOOST`.
- Documents and controls are fixed.

**Altphones**
- Origination roles are fixed.
- Catalogue, pricing and policy: `/altphones/manage`.
- Workflow: `/admin/workflows/ALTPHONES`.

## Related changes

- **Pricing and tenor** (`/admin/pricing`) still shows the mark-ups and tenor in force, and still manages contract types and creates products. Mark-up and tenor changes are now made under Product settings.
  - A product created there appears as *Not set up*, with its copied rules as a proposal to load into a draft.
- The `PRODUCT_CONFIG_APPROVER` role can still open the old page as a read-only history. It no longer decides proposals.

## Database (migration 044)

- `product_config_drafts`: one working draft per product, with a revision number and its base version.
- `product_configs`: new columns `published_via`, `previous_version`, `changes`, `restored_from`.
- `products`: new columns `owner`, `origination_roles`.

## Tests

`tests/product-settings.test.ts` covers:
- the product list and statuses;
- first-time set-up (version 1);
- saving drafts, revision conflicts and shape errors;
- Super Admin-only access;
- validation before publication (fields, reason, effective date, contract types);
- direct publication with audit, immutability, no-change refusal and stale-base conflict;
- effective dates and versions pinned on requests;
- loading, dismissing and superseding proposals;
- restore and compare;
- origination roles on cards, pages and the server, including the role ceiling and closing a product;
- the minimum amount;
- WakeelBoost general settings.
