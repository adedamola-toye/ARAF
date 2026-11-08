# APR / DSR calculator fixtures

Each `*.json` file holds input/expected-output cases for one registered calculator
(`calculator: "<id>@<version>"`). `tests/documents-offer-apr.test.ts` runs every case through the
server-side calculator and fails if any calculator registered in
`src/server/domain/apr/registry.ts` has no fixture file.

`dev-illustrative-0.1.json` was produced by an independent Python reference implementation of the
**development** calculator. It is **not** derived from the bank's APR workbook.

## Adding the bank calculator (production)

1. Implement the workbook's rules as a new `AprCalculator` (e.g. `bank-wakeel@1.0`) with
   `productionValidated: true`, and register it.
2. Export at least 20 representative rows from the workbook (inputs and the workbook's computed APR,
   DSR, markup and cost plus markup, including edge cases) into `bank-wakeel-1.0.json`.
3. Run `npm test`. Every row must match exactly before setting `APR_CALCULATOR=bank-wakeel@1.0`.
