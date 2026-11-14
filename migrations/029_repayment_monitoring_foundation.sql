-- Foundation for repayment monitoring: credit metric definitions that need business approval before
-- ARAF calculates them, and the status of external integrations (core banking is not connected).
CREATE TABLE credit_metric_definitions (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('AWAITING_DEFINITION','APPROVED')),
  definition    text,
  approved_by   uuid REFERENCES staff(id),
  approved_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'AWAITING_DEFINITION' OR (definition IS NOT NULL AND approved_by IS NOT NULL))
);
INSERT INTO credit_metric_definitions (code, name, status) VALUES ('PDO', 'Past Due Obligation (PDO)', 'AWAITING_DEFINITION') ON CONFLICT DO NOTHING;

CREATE TABLE integration_status (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('NOT_CONNECTED','IN_TESTING','CONNECTED','SUSPENDED')),
  last_sync_at  timestamptz,
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO integration_status (code, name, status, note) VALUES
  ('CBS', 'Core banking system', 'NOT_CONNECTED', 'No core banking connection has been built or verified. Repayments in ARAF are manual entries with evidence.')
ON CONFLICT DO NOTHING;
