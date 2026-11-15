-- Amount repaid as evidenced by the approved register at publication (kept separately from reconciled
-- repayments so nothing is counted twice).
ALTER TABLE altphones_historical_accounts ADD COLUMN register_repaid_kobo bigint NOT NULL DEFAULT 0;
UPDATE altphones_historical_accounts SET register_repaid_kobo = amount_repaid_kobo;
