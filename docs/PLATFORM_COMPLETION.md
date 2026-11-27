# Platform completion

This release covers WakeelBoost access for RMs, SeedFi low-score exceptions, SLA reminders, automatic closing documents (offer, GSI mandate, Remita set-up sheet), invoice confirmation, closing checklists, disbursement readiness and the facility archive. Migration: `045_platform_completion.sql`.

## 1. WakeelBoost for Relationship Managers
- The migration reopens WakeelBoost (`products.active = true`). It also adds `RM` to its origination roles when a narrower list was saved.
- The "legacy" labels are removed.
- **Product settings → Access check** (Super Admin): enter a staff email to see each product they can or cannot originate, and why. The reasons covered are staff status, roles held, the product's origination roles, and whether the product is open.

## 2. SeedFi low score: Proceed with Reason
- A low score (SeedFi *Declined*, below 530) no longer closes the request.
  - The RM sees **Credit Assessment Unsuccessful** with **Proceed with Reason**.
  - A justification of at least 20 characters is required, and filler text is refused.
  - The SeedFi result itself is never changed.
- Submission records a credit score exception (`credit_exceptions`, status *Pending Review*).
- **Team Lead** and **Unit Head** each acknowledge the exception before ARAF accepts their decision.
  - Each acknowledgement records a recommendation (proceed, return or decline) and remarks.
  - When neither a Team Lead nor a Unit Head reviews the request (a Unit Head-originated CX request), the **Divisional Head** acknowledges.
  - The person who raised the exception can never acknowledge it.
- Reviewers get in-app and email alerts:
  - *CREDIT SCORE EXCEPTION — SEEDFI LOW SCORE* goes to the Team Lead.
  - *… — REQUIRES ATTENTION* goes to the Unit Head and Divisional Head.
- Outcomes are settled automatically:
  - reaching offer preparation → *Approved*;
  - rejected → *Declined*;
  - withdrawn or expired → *Withdrawn*;
  - a later passing check → *Superseded*.
- A *SeedFi unavailable* result is never bypassable.
- **Report:** Reports → Credit score exceptions.

## 3. SLA reminders
- An officer who has not acted on an assigned item within **3 hours** (configurable) gets a reminder email, sent once per assignment. Opening the item does not stop the clock; a decision does. A reassignment starts a new clock.
- Covered queues:
  - retail and WakeelBoost tasks;
  - Staff Salary Advance;
  - Altphones;
  - invoice confirmation.
- **Administration → SLA reminders**:
  - the reminder hours;
  - an optional repeat;
  - calendar or working hours (Lagos working day, working days and public holidays);
  - which queues are covered;
  - copy addresses;
  - the subject and body (placeholders such as `[Officer Name]`, `[Reference]`);
  - delivery status.
- Every change needs a reason and is audited.
- The action queue shows **SLA overdue** and **Credit score exception** badges.

## 4. Closing documents on final approval
When a request enters offer preparation, ARAF prepares these documents from the approved request:

| Document | Source |
|---|---|
| Offer letter | The bank-approved template for the product and structure (retail), or the DOCX template for the applicant type (WakeelBoost) |
| GSI mandate form (individuals) | NIBSS GSI form layout. The six declarations are verbatim. Name, mobile, email, address, bank, account, BVN and signatory are prefilled; passport-photo, signature and witness blocks are left for the customer |
| Remita direct debit set-up sheet | Beneficiary from Document settings; amount, charges, VAT on charges, total, frequency and start/end dates from the repayment schedule; payer from the request. The RRR and QR code are left for Remita |

How generation behaves:
- **Retries:** generation is idempotent per approved version, and the worker retries it.
- **Missing template:** users never see a "template missing" message.
  - If no bank-approved template exists, the document shows *being prepared*.
  - The Super Admin is alerted in-app and by email.
  - The document is prepared as soon as a template is approved.
- **Repayment account:** the initiator records the customer's repayment account on the case page. GSI and Remita are then (re)prepared, and earlier versions are kept.
- **Limited companies:** ARAF does not generate the corporate GSI form. The case marks the GSI as *Manual form* and tells the initiator to download the bank's corporate GSI mandate, have it signed and upload it as *GSI form*. No Administration configuration is needed.
- **Signing:** no tablet signing. Download the document, have the customer sign, then upload the signed copy:
  - *Signed offer letter*;
  - *GSI form*;
  - *Signed Remita mandate*.
- **Administration → Document settings:**
  - bank name and address;
  - Remita beneficiary name, bank, account, email and phone;
  - charge per debit;
  - VAT %;
  - a list of documents still waiting.

## 5. Invoice confirmation
- **Role:** `INVOICE_CONFIRMATION_OFFICER`. One queue serves all application products. Staff Salary Advance and Altphones are not included.
- **Dispatch:** after final approval, or when an invoice is uploaded or replaced afterwards, the current supplier invoice, vehicle invoice or quotation is sent automatically.
  - It goes to the first configured officer (primary, then backups) who is active, holds the role and is not the initiator.
  - The officer gets an email titled *Invoice Confirmation — [Customer Name] — [Facility Reference]* and an in-app alert.
  - If no officer is available, the confirmation is marked *not dispatched*, the Super Admin is alerted, and the worker retries.
- **Officer workflow** (Work → Invoice confirmation):
  1. Open or download the invoice.
  2. Upload the issuer's response.
  3. Mark **Confirmation Completed**. This stays disabled until a response is uploaded.
  4. Alternatively, **Return to initiator** with a reason (at least 20 characters).
- **Versions:** a newer invoice supersedes the open confirmation, and every version is kept.
- **Administration → Invoice confirmation:** officer emails (in order) and reassignment of open confirmations.

## 6. Closing checklist, readiness and records
- **Administration → Closing checklists:** per product, mark each document *required*, *optional* or *not used*.
  - The default is the standard pack, with the signed Remita mandate optional.
  - Contracting evidence is added automatically for structures with a contract sequence.
  - The signed offer letter must stay required.
- **Pack submission** (offer preparation) checks the required items.
- **Disbursement check (DO1 Okay)** checks them again, plus the latest invoice's confirmation.
- **Case page → Closing documents** shows:
  - the prepared documents;
  - the checklist status;
  - the invoice confirmation status;
  - the repayment account.
- **Facility archive:** when a facility completes, ARAF builds a ZIP of every current document with a summary and a manifest, named after the customer and reference (for example `AMINA_BELLO_ARAF-2026-001064.zip`).
  - The archive is sent to Legal and Shariah for records review.
  - Each group marks it Received, then Reviewed (comments required).
  - The records status then becomes *Records review completed*.
  - Only facilities completed after this release are archived; earlier ones already went through the closure pack.

## 7. Configuration centre
**Administration → Configuration centre** links every setting above, plus product settings, approval workflows, pricing, templates and service targets, and shows each one's current status.

## Outstanding
- **Authorised offer letters (17 Nov 2026):**
  - Migration `046` covers the Alt Drive Ijarah letter and the Staff Salary Advance (Qard) letter.
  - Migration `047` covers the Alt Drive Murabaha, Alt Power Murabaha and Ijarah, and Vendor Financing Murabaha letters. Alt Power and Vendor Financing requests on the "Standard" structure use the Murabaha letter.
  - Each letter is approved for production, carries the customer's acceptance and signature block, and is prefilled and generated automatically on final approval.
  - Letters the bank later edits are not overwritten.
- **Closing documents to the customer:**
  - **Default (off):** the offer letter, GSI form and Remita sheet are prefilled and prepared on approval. The RM gives them to the customer to sign, on paper or on the RM's tablet, and uploads the signed copies.
  - **Optional:** a Super Admin can switch on automatic e-mails (Configuration centre → Document settings → Sending to the customer).
    - When on, the three documents are e-mailed together to the customer, copied to the RM. Regenerated documents follow as an update.
    - With no customer e-mail on the request, the RM is told to hand them over.
    - Only documents prepared after the switch is turned on are e-mailed.
    - The case page shows when each document was sent.
- **Corporate GSI mandate form:** upload it when available.
- **Remita API:** not integrated. ARAF prepares the set-up sheet; the RRR and QR code come from Remita.
- **Invoice Confirmation Officer account:** create Olamilekan Gaji's account and assign the *Invoice Confirmation Officer* role. Their email is already the configured primary.
