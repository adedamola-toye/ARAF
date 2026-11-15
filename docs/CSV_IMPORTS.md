# CSV imports and exports

All new bulk imports use **CSV UTF-8** (Excel: *File → Save As → CSV UTF-8 (Comma delimited)*). Download the template from
Altphones settings → Setup uploads; the header row must match (column order does not matter, spacing and case are ignored).

## How every import works

Upload → Validate → Preview → (fix the file, or submit a partial import with a reason) → **Altphones Unit Head approves** → Commit.

- Nothing is written before approval. The approver can never be the person who uploaded or submitted the file.
- On approval every row is re-checked against the database and applied in one transaction.
- Each file gets an import ID and a SHA-256 fingerprint: the same file cannot be imported twice or be waiting twice.
- Invalid rows never crash the import or disappear: the preview lists them and **Download the error report (CSV)** gives
  `Row, Field, Error, Suggested correction` (row numbers match the file, header = row 1).
- A **partial import** (leaving the invalid rows out) needs an explicit tick and a reason; it is marked *Partial* for the approver.
- Reading: UTF-8 with or without BOM, quoted values with commas, line breaks and doubled quotes, Windows or Unix line endings,
  semicolon-separated exports are detected; a file over 10 MB, an Excel workbook renamed `.csv`, non-UTF-8 text or an unclosed
  quote is refused with the reason. Dates are `YYYY-MM-DD` (day/month/year is accepted where noted). Amounts are naira with up to
  two decimals and are stored exactly in kobo.
- Every upload, submission, approval and rejection is audited.

## Templates

| Import | Required columns | Optional | Notes |
|---|---|---|---|
| Locations | State, City, Type (Branch/Shop/BOX), Name | Source name, Source type, Aliases (`;`-separated) | No Address column (addresses come from the location master). Existing locations are skipped. |
| Opening stock | Location, Phone model, Quantity | IMEIs (spaces/commas), Note | Branches and Altshops only; IMEIs must be valid (Luhn) and unused; no more IMEIs than units. |
| Stock reconciliation | Location, Phone model, Counted quantity, Count date | Note | Posts the difference to the ledger as a count adjustment; a count below reserved units is refused. |
| BPM register | Email, States covered (`;`-separated) | Name | Maps states to an existing, verified BPM. **No staff profile is ever created.** |
| Location-to-BPM mapping | Location, BPM email | Note | Altshops and Altboxes only; verified BPMs only. |
| Historical transactions | Reference, Type, Customer name, Phone model, IMEI, Transaction date, Originating location, Supplying location | Customer email/phone, Originating officer, Tenure | Marked Legacy / Imported; no payments, approvals, emails or stock movements. |
| Historical repayments | Historical reference (HIS-…), Payment date, Amount, Payment reference | Month covered (YYYY-MM), Note | Each payment needs evidence (reference). Duplicates, months already paid, cancelled accounts and overpayments are refused. |
| Historical stock movements | Reference, Location, Phone model, Movement, Quantity, Date | Note | Legacy ledger entries; never below reserved. |

The historical Altphones register itself (INTERNAL / EXTERNAL / COMPLETED REPAYMENT / CANCELED REQUEST workbook) keeps its own
staged migration (Altphones → Historical migration), so the existing workbook does not need to be retyped.

**Removed:** the Delight Officer / Smile Associate upload. Officers are never created, provisioned or assigned to a location
from a spreadsheet; their access is managed in Users and roles.

## Exports

CSV with a BOM and CRLF, formula-injection protection (cells starting `=`, `+`, `-`, `@` are prefixed with `'` unless they are
plain numbers), exact amounts, ISO dates and status codes. Ordinary report exports never include BVN, NIN, account or phone
numbers, or KYC photographs. Every export is audited (`REPORT_EXPORTED`).
