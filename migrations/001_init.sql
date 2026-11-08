-- WakeelBoost Work Desk - initial schema
-- All timestamps are stored as timestamptz (UTC). Money is stored as integer kobo (bigint).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- directory & staff
CREATE TABLE bank_directory (
  email        text PRIMARY KEY CHECK (email = lower(email)),
  full_name    text NOT NULL,
  department   text,
  is_group_mailbox boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  source       text NOT NULL DEFAULT 'manual',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name     text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  region        text,
  business_unit text,
  created_by    uuid REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  role          text NOT NULL,
  region        text,
  business_unit text,
  active        boolean NOT NULL DEFAULT true,
  granted_by    uuid REFERENCES staff(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  revoked_by    uuid REFERENCES staff(id),
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX role_assignments_active_uq ON role_assignments(staff_id, role) WHERE active;
CREATE INDEX role_assignments_role_idx ON role_assignments(role) WHERE active;

CREATE TABLE recipient_groups (
  code        text PRIMARY KEY CHECK (code IN ('LEGAL','SHARIAH')),
  name        text NOT NULL
);
CREATE TABLE recipient_group_members (
  group_code  text NOT NULL REFERENCES recipient_groups(code),
  email       text NOT NULL CHECK (email = lower(email)),
  added_by    uuid REFERENCES staff(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_code, email)
);

-- ---------------------------------------------------------------- auth
CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash   text NOT NULL,
  staff_id     uuid REFERENCES staff(id),
  code_hash    text NOT NULL,
  ip           text,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  attempts     int NOT NULL DEFAULT 0
);
CREATE INDEX otp_challenges_email_idx ON otp_challenges(email_hash, created_at DESC);

CREATE TABLE rate_limit_events (
  id         bigserial PRIMARY KEY,
  bucket     text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX rate_limit_events_idx ON rate_limit_events(bucket, created_at DESC);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text NOT NULL UNIQUE,
  staff_id         uuid NOT NULL REFERENCES staff(id),
  active_role      text,
  created_at       timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text,
  ip               text,
  user_agent       text
);
CREATE INDEX sessions_staff_idx ON sessions(staff_id);

-- ---------------------------------------------------------------- customers & applications
CREATE TABLE customers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_type  text NOT NULL CHECK (applicant_type IN ('INDIVIDUAL','ENTERPRISE','LIMITED')),
  display_name    text NOT NULL,
  identity_hash   text UNIQUE,       -- HMAC of BVN (individual/enterprise) or CAC number (limited)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE application_ref_seq START 1001;

CREATE TABLE applications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                  text NOT NULL UNIQUE,
  customer_id          uuid REFERENCES customers(id),
  applicant_type       text NOT NULL CHECK (applicant_type IN ('INDIVIDUAL','ENTERPRISE','LIMITED')),
  initiator_id         uuid NOT NULL REFERENCES staff(id),
  initiator_role       text NOT NULL CHECK (initiator_role IN ('RM','ANM','MERCHANT_OFFICER')),
  region               text,
  business_unit        text,
  status               text NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','IN_PROGRESS','BOOKED','CLOSED','REJECTED')),
  stage                text NOT NULL DEFAULT 'DRAFT',
  route                int CHECK (route IN (1,2,3)),
  current_version_id   uuid,
  requested_amount_kobo bigint,
  customer_name        text,
  selected_rbe_id      uuid REFERENCES staff(id),
  endorser_id          uuid REFERENCES staff(id),
  first_reviewer_id    uuid REFERENCES staff(id),
  second_reviewer_id   uuid REFERENCES staff(id),
  pack_co3_id          uuid REFERENCES staff(id),
  do1_id               uuid REFERENCES staff(id),
  do2_id               uuid REFERENCES staff(id),
  active_correction_id uuid,
  offer_template_id    uuid,
  lock_version         int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL,
  submitted_at         timestamptz,
  updated_at           timestamptz NOT NULL,
  disbursed_at         timestamptz,
  process_completed_at timestamptz,
  process_completed_by uuid REFERENCES staff(id),
  vendor_confirmed_at  timestamptz,
  vendor_confirmed_by  uuid REFERENCES staff(id),
  repayment_prompts_active_at timestamptz,
  closed_at            timestamptz,
  rejected_at          timestamptz,
  retention_until      date
);
CREATE INDEX applications_initiator_idx ON applications(initiator_id);
CREATE INDEX applications_stage_idx ON applications(stage);
CREATE INDEX applications_customer_idx ON applications(customer_id);

CREATE TABLE application_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  version_no       int NOT NULL,
  data             jsonb NOT NULL,            -- non-sensitive fields
  bvn_enc          text,                      -- encrypted (AES-256-GCM)
  bvn_last4        text,
  tin_enc          text,
  tin_last4        text,
  requested_amount_kobo bigint,
  material_digest  text,
  created_by       uuid NOT NULL REFERENCES staff(id),
  created_at       timestamptz NOT NULL,
  submitted_at     timestamptz,
  UNIQUE (application_id, version_no)
);
ALTER TABLE applications ADD CONSTRAINT applications_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES application_versions(id);

CREATE TABLE application_directors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id    uuid NOT NULL REFERENCES application_versions(id),
  position      int NOT NULL,
  full_name     text NOT NULL,
  bvn_enc       text NOT NULL,
  bvn_last4     text NOT NULL,
  UNIQUE (version_id, position)
);

-- ---------------------------------------------------------------- workflow
CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigserial UNIQUE,
  application_id   uuid NOT NULL REFERENCES applications(id),
  stage            text NOT NULL,
  assignee_role    text NOT NULL,
  assignee_id      uuid REFERENCES staff(id),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
  version_id       uuid REFERENCES application_versions(id),
  required_action  text NOT NULL,
  assignment_note  text,
  entered_at       timestamptz NOT NULL,
  assigned_at      timestamptz,
  completed_at     timestamptz,
  completed_by     uuid REFERENCES staff(id),
  outcome          text,
  attestation      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX tasks_one_open_per_app ON tasks(application_id) WHERE status = 'OPEN';
CREATE INDEX tasks_assignee_open_idx ON tasks(assignee_id) WHERE status = 'OPEN';
CREATE INDEX tasks_app_idx ON tasks(application_id, entered_at);

CREATE TABLE assignment_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES tasks(id),
  from_staff_id   uuid REFERENCES staff(id),
  to_staff_id     uuid REFERENCES staff(id),
  method          text NOT NULL,   -- ROUTED, RANDOM, ADMIN, UNASSIGNED_ON_REVOKE, NO_ELIGIBLE
  eligible_pool   jsonb,
  changed_by      uuid REFERENCES staff(id),
  changed_at      timestamptz NOT NULL
);

CREATE TABLE decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigserial UNIQUE,
  application_id   uuid NOT NULL REFERENCES applications(id),
  task_id          uuid NOT NULL REFERENCES tasks(id),
  version_id       uuid REFERENCES application_versions(id),
  assessment_id    uuid,
  stage            text NOT NULL,
  actor_id         uuid NOT NULL REFERENCES staff(id),
  actor_role       text NOT NULL,
  action           text NOT NULL,
  reason           text,
  reviewed_documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL,
  invalidated_at   timestamptz,
  invalidated_reason text
);
CREATE UNIQUE INDEX decisions_one_per_task ON decisions(task_id);
CREATE INDEX decisions_app_idx ON decisions(application_id, created_at);

CREATE TABLE corrections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                bigserial UNIQUE,
  application_id     uuid NOT NULL REFERENCES applications(id),
  parent_id          uuid REFERENCES corrections(id),
  from_stage         text NOT NULL,
  from_assignee_id   uuid REFERENCES staff(id),
  from_role          text NOT NULL,
  to_stage           text NOT NULL,
  reason             text NOT NULL,
  requested_by       uuid NOT NULL REFERENCES staff(id),
  baseline_version_id uuid REFERENCES application_versions(id),
  baseline_assessment_id uuid,
  baseline_reports   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL,
  resolved_at        timestamptz,
  resolution         text
);
ALTER TABLE applications ADD CONSTRAINT applications_active_correction_fk
  FOREIGN KEY (active_correction_id) REFERENCES corrections(id);

CREATE TABLE credit_assessments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  version_id       uuid NOT NULL REFERENCES application_versions(id),
  calculator_id    text NOT NULL,
  calculator_version text NOT NULL,
  production_validated boolean NOT NULL,
  inputs           jsonb NOT NULL,
  outputs          jsonb NOT NULL,
  apr_percent      numeric(12,4) NOT NULL,
  dsr_percent      numeric(12,4) NOT NULL,
  markup_kobo      bigint NOT NULL,
  cost_plus_markup_kobo bigint NOT NULL,
  assessor_id      uuid NOT NULL REFERENCES staff(id),
  started_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL,
  superseded_at    timestamptz
);
CREATE INDEX credit_assessments_app_idx ON credit_assessments(application_id, created_at DESC);

CREATE TABLE reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  task_id        uuid NOT NULL REFERENCES tasks(id),
  sent_by        uuid NOT NULL REFERENCES staff(id),
  sent_at        timestamptz NOT NULL
);

CREATE TABLE idempotency_keys (
  key            text PRIMARY KEY,
  staff_id       uuid NOT NULL REFERENCES staff(id),
  action         text NOT NULL,
  application_id uuid,
  result         jsonb,
  created_at     timestamptz NOT NULL
);

-- ---------------------------------------------------------------- documents
CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  category         text NOT NULL,
  slot             text NOT NULL,       -- logical slot; versions share a slot
  version_no       int NOT NULL,
  filename         text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       bigint NOT NULL,
  sha256           text NOT NULL,
  storage_key      text NOT NULL,
  scan_status      text NOT NULL CHECK (scan_status IN ('QUARANTINED','CLEAN','REJECTED')),
  scan_detail      text,
  generated        boolean NOT NULL DEFAULT false,
  template_id      uuid,
  template_version int,
  uploaded_by      uuid NOT NULL REFERENCES staff(id),
  uploaded_role    text,
  uploaded_at      timestamptz NOT NULL,
  stage            text,
  app_version_id   uuid REFERENCES application_versions(id),
  superseded_at    timestamptz,
  superseded_by    uuid REFERENCES documents(id),
  purged_at        timestamptz,
  UNIQUE (application_id, slot, version_no)
);
CREATE INDEX documents_app_idx ON documents(application_id, category);

-- ---------------------------------------------------------------- offer templates
CREATE TABLE offer_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  version            int NOT NULL,
  body_html          text NOT NULL,
  status             text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  production_approved boolean NOT NULL DEFAULT false,
  notes              text,
  created_by         uuid REFERENCES staff(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  activated_by       uuid REFERENCES staff(id),
  activated_at       timestamptz,
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX offer_templates_one_active ON offer_templates((true)) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------- disbursement & repayments
CREATE TABLE disbursements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL UNIQUE REFERENCES applications(id),
  amount_kobo      bigint NOT NULL CHECK (amount_kobo > 0),
  approved_amount_kobo bigint NOT NULL,
  disbursed_on     date NOT NULL,
  transaction_ref  text NOT NULL UNIQUE,
  recorded_by      uuid NOT NULL REFERENCES staff(id),
  recorded_at      timestamptz NOT NULL
);

CREATE TABLE repayment_instalments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  disbursement_id  uuid NOT NULL REFERENCES disbursements(id),
  seq              int NOT NULL,
  due_date         date NOT NULL,
  amount_kobo      bigint NOT NULL CHECK (amount_kobo > 0),
  UNIQUE (disbursement_id, seq)
);
CREATE INDEX repayment_due_idx ON repayment_instalments(due_date);

CREATE TABLE closure_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL UNIQUE REFERENCES applications(id),
  completed_by     uuid NOT NULL REFERENCES staff(id),
  completed_at     timestamptz NOT NULL,
  delivery_mode    text NOT NULL CHECK (delivery_mode IN ('ATTACHMENTS','SECURE_LINK')),
  groups           text[] NOT NULL,
  document_ids     uuid[] NOT NULL,
  outbox_id        uuid
);

-- ---------------------------------------------------------------- notifications & jobs
CREATE TABLE notification_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL,
  dedupe_key       text NOT NULL UNIQUE,
  application_id   uuid REFERENCES applications(id),
  to_addresses     text[] NOT NULL,
  cc_addresses     text[] NOT NULL DEFAULT '{}',
  subject          text NOT NULL,
  body_text        text NOT NULL,
  body_html        text,
  attachment_document_ids uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD')),
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 8,
  next_attempt_at  timestamptz NOT NULL,
  locked_at        timestamptz,
  last_error       text,
  provider_message_id text,
  created_at       timestamptz NOT NULL,
  sent_at          timestamptz
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox(next_attempt_at) WHERE status IN ('PENDING','FAILED');

CREATE TABLE dev_mailbox (
  id           bigserial PRIMARY KEY,
  outbox_id    uuid,
  to_addresses text[] NOT NULL,
  cc_addresses text[] NOT NULL,
  subject      text NOT NULL,
  body_text    text NOT NULL,
  attachments  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedule_settings (
  code          text PRIMARY KEY CHECK (code IN ('WEEKLY_DIGEST','MONTHLY_REPORT')),
  enabled       boolean NOT NULL DEFAULT true,
  day_of_month  int CHECK (day_of_month BETWEEN 1 AND 28),
  hour          int NOT NULL DEFAULT 0 CHECK (hour BETWEEN 0 AND 23),
  minute        int NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
  recipient_staff_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by    uuid REFERENCES staff(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedule_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  period_key    text NOT NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'RUNNING',
  UNIQUE (code, period_key)
);

CREATE TABLE digest_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES schedule_runs(id),
  code          text NOT NULL,
  period_key    text NOT NULL,
  recipient_id  uuid NOT NULL REFERENCES staff(id),
  outbox_id     uuid REFERENCES notification_outbox(id),
  summary       jsonb NOT NULL,
  created_at    timestamptz NOT NULL,
  UNIQUE (code, period_key, recipient_id)
);

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL,
  actor_id        uuid REFERENCES staff(id),
  actor_email     text,
  actor_role      text,
  session_id      uuid,
  action          text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','FAILURE')),
  application_id  uuid REFERENCES applications(id),
  customer_id     uuid REFERENCES customers(id),
  stage           text,
  reason          text,
  assignment_from uuid,
  assignment_to   uuid,
  document_id     uuid,
  document_version int,
  correlation_id  text,
  client_ip       text,
  user_agent      text,
  device          text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_app_idx ON audit_events(application_id, occurred_at);
CREATE INDEX audit_events_customer_idx ON audit_events(customer_id, occurred_at);
CREATE INDEX audit_events_time_idx ON audit_events(occurred_at DESC);

CREATE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

-- decisions are immutable except for invalidation markers
CREATE FUNCTION decisions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'decisions cannot be deleted'; END IF;
  IF NEW.action IS DISTINCT FROM OLD.action OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.reviewed_documents IS DISTINCT FROM OLD.reviewed_documents THEN
    RAISE EXCEPTION 'decisions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER decisions_guard_trg BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_guard();

INSERT INTO recipient_groups(code, name) VALUES ('LEGAL','Legal'), ('SHARIAH','Shariah Compliance');
INSERT INTO schedule_settings(code, enabled, day_of_month, hour, minute) VALUES
  ('WEEKLY_DIGEST', true, NULL, 0, 0),
  ('MONTHLY_REPORT', true, 1, 8, 0);
