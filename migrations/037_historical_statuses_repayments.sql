-- Historical Altphones accounts: application status and repayment status tracked separately, an explicit
-- Unconfirmed (pending reconciliation) status, and repayments reconciled from a CSV with evidence.
ALTER TABLE altphones_historical_accounts DROP CONSTRAINT IF EXISTS altphones_historical_accounts_status_check;
ALTER TABLE altphones_historical_accounts ADD CONSTRAINT altphones_historical_accounts_status_check CHECK (status IN ('COMPLETED','CURRENT','IN_ARREARS','NOT_STARTED','CANCELLED','UNCONFIRMED'));
ALTER TABLE altphones_migration_records DROP CONSTRAINT IF EXISTS altphones_migration_records_override_classification_check;

ALTER TABLE altphones_historical_accounts
  ADD COLUMN application_status text CHECK (application_status IN ('PENDING','APPROVED','ISSUED','COMPLETED','CANCELLED','DECLINED','UNCONFIRMED')),
  ADD COLUMN repayment_status text CHECK (repayment_status IN ('NOT_STARTED','ACTIVE','OVERDUE','FULLY_REPAID','EXCEPTION','UNCONFIRMED')),
  ADD COLUMN total_obligation_kobo bigint,
  ADD COLUMN amount_repaid_kobo bigint NOT NULL DEFAULT 0,
  ADD COLUMN repayment_evidence text NOT NULL DEFAULT 'REGISTER' CHECK (repayment_evidence IN ('REGISTER','RECONCILED','NONE')),
  ADD COLUMN reconciled_at timestamptz;

-- Backfill from the existing classification. "Fully repaid" only where the approved register evidences it.
UPDATE altphones_historical_accounts SET
  application_status = CASE status WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'UNCONFIRMED' THEN 'UNCONFIRMED' ELSE 'ISSUED' END,
  repayment_status = CASE status WHEN 'COMPLETED' THEN 'FULLY_REPAID' WHEN 'CURRENT' THEN 'ACTIVE' WHEN 'IN_ARREARS' THEN 'OVERDUE' WHEN 'NOT_STARTED' THEN 'NOT_STARTED' WHEN 'CANCELLED' THEN 'NOT_STARTED' ELSE 'UNCONFIRMED' END,
  total_obligation_kobo = CASE WHEN tenor_months IS NOT NULL AND instalment_kobo IS NOT NULL THEN tenor_months * instalment_kobo END,
  amount_repaid_kobo = coalesce(paid_count, 0) * coalesce(instalment_kobo, 0)
WHERE application_status IS NULL;

CREATE TABLE altphones_historical_repayments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES altphones_historical_accounts(id),
  paid_on       date NOT NULL,
  amount_kobo   bigint NOT NULL CHECK (amount_kobo > 0),
  reference     text NOT NULL CHECK (length(btrim(reference)) >= 3),
  month_covered date CHECK (month_covered IS NULL OR extract(day FROM month_covered) = 1),
  note          text,
  import_id     uuid NOT NULL REFERENCES altphones_imports(id),
  recorded_by   uuid NOT NULL REFERENCES staff(id),
  recorded_at   timestamptz NOT NULL,
  UNIQUE (account_id, reference)
);
CREATE FUNCTION altphones_hist_repay_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'historical repayments are append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER altphones_hist_repay_append_only BEFORE UPDATE OR DELETE ON altphones_historical_repayments FOR EACH ROW EXECUTE FUNCTION altphones_hist_repay_append_only();
