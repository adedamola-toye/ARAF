# Merchant Officer hierarchy, acquisition evidence, checklists, tablet signing and performance reports

This release is migration `048_merchant_hierarchy_reporting.sql`.

## Product access
| Role | Can originate |
|---|---|
| Relationship Manager | WakeelBoost, Vendor Financing, AltDrive, AltPower |
| Merchant Officer | WakeelBoost only (server-enforced: menus, direct links, draft creation and submission) |
| Merchant Officer Lead / Head | WakeelBoost, Vendor Financing, AltDrive, AltPower |
| Delight Officer / Smile Associate | AltPhones only (unchanged) |

Product access is separate from approval authority. Each product's origination roles can still be narrowed in Product settings.

## Merchant Officer approval hierarchy
- **Merchant Officer request:** their Lead (endorsement) → the Lead's Head → credit → Unit Head → Divisional Head.
- **Lead's request (any product):** the Head → credit → Unit Head → Divisional Head.
- **Head's request:** credit → Unit Head → Divisional Head.

Rules that always apply:
- Nobody reviews their own request.
- The Head is excluded from the later stages.
- Each reviewer's decision is recorded under their own name.
- 3-hour reminders apply to Leads and Heads as to every assigned reviewer.

**Reporting lines** are set by the Super Admin under Administration → Reporting lines.
- The lines are officer → Lead, Lead → Head, staff → Unit Head and Unit Head → Divisional Head.
- Each change requires a reason and is audited.
- Without a line, any holder of the role may receive the request.

**Initial set-up:**
- **Abiodun Ayinde** (abiodun.ayinde@altbank.ng): Merchant Officer Lead.
- **Alexander Olasinde** (alexander.olasinde@altbank.ng): Merchant Officer Head.
- Abiodun reports to Alexander.

These are role assignments only; no names are written into the routing.

## Acquisition evidence
- Acquisition evidence is never required at origination, approval or the disbursement readiness check.
- The step after disbursement is now the **RM Disbursement Confirmation**:
  - Retail: the former fulfilment step. WakeelBoost: the vendor payment confirmation.
- The RM must upload *Evidence of delivery / acquisition* before **Confirm Disbursement**.
  - Until then, the button is disabled and the server refuses the action.
  - The message shown is: "Please upload evidence of delivery or acquisition before confirming disbursement."
- The evidence goes into the facility archive.
- Structure-specific contracting / acquisition evidence is no longer part of the offer pack.

## Closing checklists (product and customer category)
| Product · category | Required (besides offer, signed offer, KYC, Pre-Disbursement Agreement, GSI, insurance) |
|---|---|
| Vendor Financing · business | Undated cheques, domiciliation undertaking (debit mandate optional) |
| AltPower · business | Debit (Remita) mandate, domiciliation undertaking |
| AltPower · salaried | Debit (Remita) mandate |
| AltDrive · business / salaried | Debit (Remita) mandate |
| WakeelBoost | Standard pack |

- New document types: *Promoter / business undated cheques* and *Business-proceeds domiciliation undertaking*.
- The Super Admin can edit each checklist (Administration → Closing checklists), with a reason.
- Invoice confirmation is still checked before disbursement. Staff Salary Advance has none.

## Signing
- **Sign on tablet**, from the closing documents panel, for the offer letter, GSI form and Remita sheet:
  1. The customer reads the document.
  2. The RM records the ID sighted (type and last 4 characters) and confirms the customer's identity.
  3. Each signatory (up to four: customer, director, guarantor, witness) signs with a finger or stylus.
  4. The customer gives consent.
- ARAF then saves a signed PDF containing:
  - the document;
  - a "Signed electronically" footer on every page;
  - a signature record page with signatories, signatures, time, consent, ID check, document version, document and signature hashes, and the device.
- The signed PDF counts as the signed copy in the checklist, and the signing is audited.
- **Paper:** download, sign on paper and upload, as before.

## Performance reports (Reports → Performance)
**Financing products:** drill down in any order through these levels:
- Divisional Head → Unit Head → product → customer category → originating officer;
- Merchant Officer Lead / Head → location → status → facility.

Figures shown:
- requests;
- amounts requested, approved and disbursed;
- completed, declined and pending;
- average approval turnaround;
- SLA breaches;
- invoice confirmations pending and completed;
- SeedFi exceptions;
- RM confirmations awaiting, and how many are missing evidence.

Filters: dates, credit exception, invoice, SLA and disbursement. Each facility is counted once and credited to its originator.

**Actions by person:** every decision, credited to the person who made it.

**AltPhones by person:** by DO / SA, by location at the time of sale (history is kept when people move), by phone model, and who performed each step.

**Access:**
- God's Eye, Super Admin and Reporting Admin see everything.
- Divisional Heads and Unit Heads see the staff mapped to them in Reporting lines.
- CSV exports follow the same scope and are audited.

## Location
"AltLounge Allen Lagos 2" is renamed "AltLounge Alaba Lagos". It is the same record, so its history stays linked and no duplicate is created.
