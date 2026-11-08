# APR / DSR calculator fixtures

Each `*.json` file holds cases for one registered calculator (`calculator: "<id>@<version>"`).
`tests/documents-offer-apr.test.ts` runs every case through the server-side calculator and fails if
a registered calculator has no fixture file.

- `altbank-apr-2024-1.0.json` (`format: "workbook"`): 48 rows produced by **recalculating the bank's
  workbook "APR Model - ALTBANK v.1 2024"** in LibreOffice with different inputs
  (`scripts/apr-workbook-fixtures.py`). Amounts from ₦1.00 to ₦50,000,000.00, route boundaries, Murabaha
  and Ijarah, fixed and reducing rates, every instalment frequency, Takaful and stamp duty. The server
  must match the workbook's APR to 4 decimal places of a percent and every naira value to the kobo.
- `dev-illustrative-0.1.json`: the earlier development placeholder (kept for history; not the default).

## Changing the workbook

When the bank issues a new workbook version, implement it as a new calculator version, regenerate rows
with the script, add the fixture file, and set `APR_CALCULATOR`. Previous assessments keep their
calculator id/version and input/output snapshots.
