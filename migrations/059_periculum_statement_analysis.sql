-- Periculum Insights statement analysis (Phase 2: integration, processing, persistence).
-- Additive only. Vendor results are stored encrypted (application field encryption) and never overwritten.

-- One analysis run per Automatic Statement Analysis action. Versioned per application; never deleted.
CREATE TABLE fi_analyses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  version          int NOT NULL,
  status           text NOT NULL CHECK (status IN ('QUEUED','PROCESSING','PARTIALLY_COMPLETED','COMPLETED','FAILED','REQUIRES_VERIFICATION','SUPERSEDED')),
  -- PERICULUM = live vendor results; FIXTURE = labelled test data (never shown as Periculum results)
  source           text NOT NULL CHECK (source IN ('PERICULUM','FIXTURE')),
  vendor_environment text NOT NULL,
  initiated_by     uuid NOT NULL REFERENCES staff(id),
  initiated_role   text NOT NULL,
  reason           text,
  statement_set_sha256 text NOT NULL,         -- hash over the sorted statement file hashes (detects changed evidence)
  result           jsonb,                     -- consolidated assessment (Phase 3/4)
  created_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  superseded_at    timestamptz,
  superseded_by    uuid REFERENCES fi_analyses(id),
  UNIQUE (application_id, version)
);
-- At most one analysis in flight per application (a second click returns the running one).
CREATE UNIQUE INDEX fi_analyses_one_active ON fi_analyses(application_id) WHERE status IN ('QUEUED','PROCESSING');
CREATE INDEX fi_analyses_app_idx ON fi_analyses(application_id, version DESC);

-- One row per statement file in an analysis.
CREATE TABLE fi_statements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id         uuid NOT NULL REFERENCES fi_analyses(id),
  document_id         uuid NOT NULL REFERENCES documents(id),
  document_sha256     text NOT NULL,
  filename            text NOT NULL,
  status              text NOT NULL CHECK (status IN ('PENDING','SUBMITTING','SUBMISSION_UNCERTAIN','UPLOADED','PROCESSING','PROCESSED','FAILED','REQUIRES_VERIFICATION','DUPLICATE','REUSED')),
  statement_type      text NOT NULL CHECK (statement_type IN ('CONSUMER','BUSINESS')),
  vendor_statement_key bigint,
  vendor_status       text,                   -- processingStatus exactly as returned
  submission_name     text,                   -- unique name sent to the vendor (duplicate names are refused by Periculum)
  password_enc        text,                   -- PDF password, encrypted; cleared once submitted
  duplicate_of        uuid REFERENCES fi_statements(id),
  reused_from         uuid REFERENCES fi_statements(id),
  attempts            int NOT NULL DEFAULT 0,
  next_action_at      timestamptz,
  error_category      text,
  error_message       text,
  submitted_at        timestamptz,
  processed_at        timestamptz,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);
CREATE INDEX fi_statements_analysis_idx ON fi_statements(analysis_id);
CREATE INDEX fi_statements_due_idx ON fi_statements(next_action_at) WHERE status IN ('PENDING','UPLOADED','PROCESSING','SUBMISSION_UNCERTAIN');
CREATE INDEX fi_statements_vendor_key_idx ON fi_statements(vendor_statement_key);
CREATE INDEX fi_statements_sha_idx ON fi_statements(document_sha256) WHERE status = 'PROCESSED';

-- Vendor payloads as received (analytics, transactions). Append-only, encrypted.
CREATE TABLE fi_vendor_results (
  id             bigserial PRIMARY KEY,
  statement_id   uuid NOT NULL REFERENCES fi_statements(id),
  kind           text NOT NULL CHECK (kind IN ('ANALYTICS','TRANSACTIONS')),
  source         text NOT NULL CHECK (source IN ('PERICULUM','FIXTURE')),
  payload_enc    text NOT NULL,
  payload_sha256 text NOT NULL,
  received_at    timestamptz NOT NULL
);
CREATE INDEX fi_vendor_results_stmt_idx ON fi_vendor_results(statement_id, kind, id DESC);

-- Every outbound call (no statement content, no credentials): usage, failures, duplicates prevented, cost basis.
CREATE TABLE fi_api_calls (
  id              bigserial PRIMARY KEY,
  analysis_id     uuid REFERENCES fi_analyses(id),
  statement_id    uuid REFERENCES fi_statements(id),
  operation       text NOT NULL,             -- TOKEN, SUBMIT, GET_STATEMENT, GET_TRANSACTIONS
  http_status     int,
  outcome         text NOT NULL CHECK (outcome IN ('SUCCESS','REJECTED','FAILED','TIMEOUT','RATE_LIMITED','AMBIGUOUS')),
  billable        boolean NOT NULL DEFAULT false,
  source          text NOT NULL CHECK (source IN ('PERICULUM','FIXTURE')),
  duration_ms     int NOT NULL,
  error_category  text,
  created_at      timestamptz NOT NULL
);
CREATE INDEX fi_api_calls_time_idx ON fi_api_calls(created_at DESC);

-- Webhook deliveries (hints only: the statement is re-read from the API before anything is trusted).
CREATE TABLE fi_webhook_events (
  id              bigserial PRIMARY KEY,
  body_sha256     text NOT NULL UNIQUE,      -- duplicate deliveries are ignored
  response_type   text,
  statement_key   bigint,
  hmac_valid      boolean,
  matched         boolean NOT NULL DEFAULT false,
  received_at     timestamptz NOT NULL
);

CREATE FUNCTION fi_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are never changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fi_vendor_results_append_only BEFORE UPDATE OR DELETE ON fi_vendor_results FOR EACH ROW EXECUTE FUNCTION fi_append_only();
CREATE TRIGGER fi_api_calls_append_only BEFORE UPDATE OR DELETE ON fi_api_calls FOR EACH ROW EXECUTE FUNCTION fi_append_only();
CREATE TRIGGER fi_analyses_no_delete BEFORE DELETE ON fi_analyses FOR EACH ROW EXECUTE FUNCTION fi_append_only();
CREATE TRIGGER fi_statements_no_delete BEFORE DELETE ON fi_statements FOR EACH ROW EXECUTE FUNCTION fi_append_only();
