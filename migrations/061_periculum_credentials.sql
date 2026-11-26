-- Periculum API credentials entered by a Super Admin (Administration → Periculum).
-- The client secret is stored encrypted (application field encryption) and is never returned to the browser.
-- One row; every change is recorded in audit_events (without the secret).
CREATE TABLE integration_credentials (
  provider          text PRIMARY KEY CHECK (provider IN ('PERICULUM')),
  client_id         text NOT NULL,
  client_secret_enc text NOT NULL,
  base_url          text NOT NULL,
  auth_url          text NOT NULL,
  updated_by        uuid NOT NULL REFERENCES staff(id),
  updated_at        timestamptz NOT NULL,
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_message text
);
