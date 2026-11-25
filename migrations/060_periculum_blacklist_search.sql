-- Optional Periculum Blacklist Search (credit bureau data for a BVN, tied to an analysed statement).
-- Off unless PERICULUM_BLACKLIST_ENABLED=true. Additive. It supplements the SeedFi credit check; it never replaces it.
CREATE TABLE fi_bureau_checks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id          uuid NOT NULL REFERENCES fi_analyses(id),
  application_id       uuid NOT NULL REFERENCES applications(id),
  subject              text NOT NULL,           -- APPLICANT, or DIRECTOR_<position>
  subject_label        text NOT NULL,
  bvn_hash             text,
  bvn_last4            text,
  vendor_statement_key bigint,
  status               text NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED','SKIPPED')),
  source               text NOT NULL CHECK (source IN ('PERICULUM','FIXTURE')),
  attempts             int NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz,
  summary              jsonb,                   -- facility / delinquency counts and report metadata (no names, dates of birth or BVN)
  payload_enc          text,                    -- full response, encrypted
  error_category       text,
  error_message        text,
  created_at           timestamptz NOT NULL,
  completed_at         timestamptz,
  UNIQUE (analysis_id, subject)
);
CREATE INDEX fi_bureau_checks_due_idx ON fi_bureau_checks(next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX fi_bureau_checks_app_idx ON fi_bureau_checks(application_id, created_at DESC);
CREATE TRIGGER fi_bureau_checks_no_delete BEFORE DELETE ON fi_bureau_checks FOR EACH ROW EXECUTE FUNCTION fi_append_only();
