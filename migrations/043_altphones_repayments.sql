-- Altphones repayment lifecycle for facilities sold through ARAF (credit sales after handover).
-- Repayments are append-only; a mistake is corrected with a reversal entry that names the original.
-- Instalment status, arrears and completion are derived from the final schedule and the repayments.

CREATE TABLE altphones_repayments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES altphones_applications(id),
  kind            text NOT NULL DEFAULT 'PAYMENT' CHECK (kind IN ('PAYMENT','REVERSAL')),
  paid_on         date NOT NULL,
  amount_kobo     bigint NOT NULL,
  reference       text NOT NULL CHECK (length(btrim(reference)) >= 3),
  note            text,
  reverses_id     uuid REFERENCES altphones_repayments(id),
  source          text NOT NULL CHECK (source IN ('MANUAL','CSV')),
  import_id       uuid REFERENCES altphones_imports(id),
  recorded_by     uuid NOT NULL REFERENCES staff(id),
  recorded_role   text,
  recorded_at     timestamptz NOT NULL,
  CHECK ((kind = 'PAYMENT' AND amount_kobo > 0 AND reverses_id IS NULL) OR (kind = 'REVERSAL' AND amount_kobo < 0 AND reverses_id IS NOT NULL AND note IS NOT NULL))
);
CREATE UNIQUE INDEX altphones_repayments_ref_uq ON altphones_repayments (application_id, upper(reference));
CREATE UNIQUE INDEX altphones_repayments_reversal_uq ON altphones_repayments (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX altphones_repayments_paid_idx ON altphones_repayments (paid_on);

CREATE FUNCTION altphones_repayments_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Altphones repayments are append-only; record a reversal instead'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER altphones_repayments_append_only BEFORE UPDATE OR DELETE ON altphones_repayments FOR EACH ROW EXECUTE FUNCTION altphones_repayments_append_only();

ALTER TABLE altphones_applications
  ADD COLUMN repayment_status   text CHECK (repayment_status IN ('NOT_STARTED','ACTIVE','OVERDUE','FULLY_REPAID')),
  ADD COLUMN amount_repaid_kobo bigint NOT NULL DEFAULT 0,
  ADD COLUMN fully_repaid_at    timestamptz,
  -- Other facilities found for the same customer (BVN) when the credit check ran: shown to the originator and reviewers.
  ADD COLUMN duplicate_warnings jsonb;

UPDATE altphones_applications SET repayment_status = 'NOT_STARTED' WHERE kind = 'CREDIT' AND status = 'DISBURSED' AND NOT legacy;
