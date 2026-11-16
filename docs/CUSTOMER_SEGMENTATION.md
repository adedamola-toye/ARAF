# RM customer segmentation and Staff Salary Advance

## A. Staff Salary Advance (rename only)

The third landing card, "Staff Personal Request", is now **Staff Salary Advance**. It keeps its position, design, icon and destination (`/enter/staff-personal-request` → `/staff-request`).

### What changed

User-facing text only:

- page titles and headings;
- navigation: "Staff Salary Advance", "My salary advance", "Salary advance queues", "Salary advance settings";
- breadcrumbs;
- notifications and status messages;
- the role labels "Staff member (salary advance)" and "Product Manager (salary advance)";
- the heading of newly generated application summaries.

### What did not change

- Routes, role and status codes, database tables, audit actions and the SharePoint folder.
- The versioned approval checklists.
- The offer template's name and wording (Legal and Shariah text), and any existing offer letter.

### The workflow is unchanged

- 2% deduction, with a live gross / deduction / net calculator.
- Product Manager's manual checks:
  - account verified;
  - three months of salary history reviewed;
  - repayment obligation within 50% of take-home pay.
- Unit Head, then Divisional Head.
- Offer letter with a 24-hour signing window.
- A Disbursement Officer assigned at random, then disbursement.
- Legal and Shariah handover.

> **Policy note.** The 50% rule is implemented as the Product Manager's manual check on repayment. It is not a hard cap of the amount at 50% of salary, as was confirmed when this change was approved. Adding a hard cap would require capturing salary on the staff form, and is a separate policy change.

## B. Customer type before product

### Who sees the step

**Relationship Managers, Team Leads and Unit Heads** (the retail originators) start a new request by choosing the customer type:

| Customer type | Products shown |
|---|---|
| Business Owner | WakeelBoost, Vendor Financing, AltDrive, AltPower |
| Salaried Individual | AltDrive, AltPower |

- **ANMs and Merchant Officers** only originate WakeelBoost, so they skip the step (business owner).
- **Delight Officers and Smile Associates** are unchanged and stay in Altphones.

### Where the products come from

- **Retail products:** a product appears under a customer type when its published rules offer that customer profile (Product settings → Eligibility & KYC → Customer profiles offered).
- **WakeelBoost:** business-only by definition.
- **No published rules yet:** the supplied rules decide where the product is listed, and its card explains that it is awaiting configuration.

### Stored values

The category is stored in the existing `applications.customer_profile` column:

| Shown as | Stored as |
|---|---|
| Business owner | `BUSINESS_OWNER` |
| Salaried individual | `SALARY_EARNER` (the existing value, so history keeps its meaning) |

New WakeelBoost drafts record `BUSINESS_OWNER`. Existing records are not reclassified.

### Journey

1. **Customer type:** two cards and a Continue button. The step works with the keyboard and is responsive.
2. **Products** for that type. "Change" returns to step 1 with the choice kept.
3. **Product page:** the customer profile is fixed to the chosen type, so the RM only chooses the legal form and the structure. Nothing is saved until "Create draft", so no data from another customer type can be carried over.
   - Opening a retail product without a customer type returns to step 1.
   - Opening a product that does not serve the type (for example `wakeelboost?customer=salaried`) explains that it is not offered.

### Server enforcement

- `createRetailDraft` refuses a profile that the product's published rules do not offer (for example, Vendor Financing for a salaried individual).
- WakeelBoost `createDraft` refuses any category other than `BUSINESS_OWNER`.
- `DRAFT_CREATED` audit events record `customerCategory`.

### Salaried details

The form shows the employment and salary section and no business fields:

- employer;
- job title;
- **employment status** and **salary paid** (frequency), both new and optional;
- employed since;
- monthly net salary;
- salary history.

No new mandatory fields were added.

### Salaried documents

There are two new document types:

| Type | Files | Message when missing |
|---|---|---|
| **Salary evidence (last three months)** | One combined file or one file per month | "Upload salary evidence covering the last three months." |
| **Employment or appointment letter** | One file | "Upload the customer's employment letter." |

- Both use the existing secure upload: private storage, type and size checks, malware scan and audit.
- They show as **"Submitted — pending review"** until a reviewer accepts them. Their contents are never treated as verified automatically.

### Live rules: the update is staged, not applied

The live rules change only when a Super Admin publishes. In Product settings, AltDrive and AltPower show **"Approved update ready: Salaried documentation"**.

- **Load into draft** builds a draft from the version in force. For salaried individuals, salary evidence and the employment letter replace "Payslip" and "Employment and salary confirmation". Every other document and setting is unchanged.
- The Super Admin reviews the draft and publishes it with a reason. It becomes a new version, audited as `PRODUCT_RULES_PUBLISHED`, and supersedes any open proposals.
- Requests already started keep the version they started under.

### Affordability

Salaried requests are assessed on salary (DSR income basis `VERIFIED_MONTHLY_NET_SALARY`), never on business turnover. Where the salaried DSR basis or threshold is not yet configured (as in the supplied AltDrive and AltPower rules), ARAF shows it as a configuration gap and blocks the affected step. Nothing is invented.

### Reviewers

- The case page shows a **Customer category** badge, the employment details and the documents with their review status.
- Approval routing, checklists, returns, separation of duties and the ban on self-approval are unchanged.

## Tests

`tests/customer-segmentation.test.ts` covers:

- the landing card and the staff wording;
- the staff deduction and calculator;
- product access for each customer type;
- API refusals for WakeelBoost and Vendor Financing;
- category persistence and audit;
- the DO/SA guard;
- missing-document messages and blocked submission for AltDrive and AltPower;
- documents available to reviewers;
- the salary-based assessment;
- the staged Product settings update (draft, publish, audit, Super Admin only);
- historical records.

The existing staff, retail, routing and Product settings suites still pass.
