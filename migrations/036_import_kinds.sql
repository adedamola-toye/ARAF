-- New CSV import kinds: stock reconciliation, BPM register (states) and location-to-BPM mapping.
ALTER TABLE altphones_imports DROP CONSTRAINT IF EXISTS altphones_imports_kind_check;
ALTER TABLE altphones_imports ADD CONSTRAINT altphones_imports_kind_check
  CHECK (kind IN ('LOCATIONS','OFFICERS','OPENING_STOCK','TRANSACTIONS','STOCK','STOCK_COUNT','BPM_STATES','BPM_LOCATIONS','HISTORICAL_REPAYMENTS'));
