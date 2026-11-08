# Offer letter templates

The bank's Murabaha offer letters (Individual / Enterprise / Corporate, 9-1-24) are used as Word
templates, one per applicant type: `templates/offers/murabaha-{individual,enterprise,limited}.docx`.
They were produced by `scripts/build-offer-templates.py` from the bank's files. The script makes three
kinds of change and leaves everything else as the bank wrote it:
- **Placeholders:** the sample customer values are replaced with placeholders.
- **Sample data removed:** the sample customer details (names, BVN, TIN, address) are gone.
- **Signatures:** the scanned officer signatures are replaced with a text signatory block. Letters are signed by hand.

Clauses, letterhead, footer, numbering and layout are unchanged.

When the initiator clicks **Generate offer letter**, the app does four things:
1. It fills the active template for the request's applicant type.
2. It stores the result as an **editable Word document**. If LibreOffice is available, it also stores a **PDF copy** for preview.
3. It records the template version on the document.
4. It freezes both as document versions. Regenerating creates a new version and keeps the old one.

## Placeholders

| Placeholder | Value |
|---|---|
| `{{offer_date}}` | Generation date, e.g. "8th November 2026" (Lagos) |
| `{{customer_name}}` | Individual: customer name. Limited: company name |
| `{{proprietor_name}}`, `{{business_name}}` | Enterprise: proprietor legal name, registered business name |
| `{{company_name}}` | Limited: company name |
| `{{customer_address}}` | Business address from the request |
| `{{facility_type}}` | Murabaha / Ijarah (from the APR assessment) |
| `{{cost_price}}`, `{{cost_price_words}}` | Cost price (a) = amount approved in the assessment, e.g. "N20,000,000.00", "Twenty Million Naira Only" |
| `{{markup_rate_tenor}}` | Mark Up rate (b) = total mark-up ÷ cost price for the tenor (36% p.a. over 6 months → 18%) |
| `{{markup_rate_annual}}`, `{{markup}}` | Annual rate entered in the assessment; total mark-up amount |
| `{{cost_plus_markup}}`, `{{cost_plus_markup_words}}` | Selling price (a+b) |
| `{{apr}}` | APR from the bank workbook calculator, 2 dp |
| `{{tenor_months}}` | Tenor in months |
| `{{financed_items}}` | Items to finance with quantities, e.g. "500 Bags of Soya Beans" |
| `{{asset_cost}}` | Sum of item lines |
| `{{instalment_frequency}}`, `{{instalment_amount}}` | From the assessment, e.g. "monthly", "N3,833,333.33" |
| `{{takaful_rate}}`, `{{stamp_duty_rate}}` | From the assessment, e.g. "0.75%", "0.125%" |
| `{{bvn}}`, `{{tin}}` | Restricted identifiers (decrypted only to render the letter) |
| `{{first_director_name}}`, `{{first_director_bvn}}` | Limited: first director |
| `{{#directors_rest}} {{director_index}}. {{director_name}} BVN: {{director_bvn}} {{/directors_rest}}` | Limited: this paragraph repeats for directors 2…n (no cap) |
| `{{signatory_1_name}}`, `{{signatory_1_title}}`, `{{signatory_2_name}}`, `{{signatory_2_title}}` | Corporate letter: initiator + business endorser. Individual/Enterprise letters: business endorser + "Head, Payment & Collection" (name left blank) |
| `{{request_ref}}`, `{{registration_number}}` | Request ID, CAC number |

## Lines left for the officer to complete in Word

- **Security:** the "Security" items (i, ii).
- **Hamish Jiddiyah:** the deposit percentage ("Receipt and lien on ……%").
- **Corporate letter:** its highlighted instructions (security documents, other conditions).
- **Takaful company:** the Takaful company selection table.

## Updating a template

Super Admin → Offer templates:
1. **Download** the active version and edit it in Word. Type each placeholder in one go, without changing formatting inside the braces.
2. **Upload** it as a new version for the applicant type.
3. **Approve for production** and **Activate** it.

The app rejects a template that:
- is missing a required placeholder
- has a placeholder split by Word formatting
- contains an unknown placeholder

In production, offers are generated only from templates marked as approved.
