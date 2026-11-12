-- Staff Personal Financing: an end-to-end workflow for bank staff, kept apart from customer applications
-- (its own records, statuses and documents) and sharing the platform's audit, outbox, storage and worker.

-- ---------------------------------------------------------------- settings (versioned, append-only)
CREATE TABLE staff_financing_settings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version                  int NOT NULL UNIQUE,
  deduction_rate_bps       int NOT NULL CHECK (deduction_rate_bps BETWEEN 0 AND 10000),
  min_amount_kobo          bigint CHECK (min_amount_kobo IS NULL OR min_amount_kobo > 0),
  max_amount_kobo          bigint CHECK (max_amount_kobo IS NULL OR max_amount_kobo > 0),
  tenor_options_months     int[] NOT NULL DEFAULT '{}',       -- empty: tenor is not collected
  required_document_types  text[] NOT NULL DEFAULT '{}',      -- empty: no document is mandatory at submission
  reason                   text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by               uuid REFERENCES staff(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (min_amount_kobo IS NULL OR max_amount_kobo IS NULL OR min_amount_kobo <= max_amount_kobo)
);
CREATE FUNCTION staff_fin_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_financing_settings_append_only BEFORE UPDATE OR DELETE ON staff_financing_settings
  FOR EACH ROW EXECUTE FUNCTION staff_fin_append_only();
INSERT INTO staff_financing_settings (version, deduction_rate_bps, reason)
VALUES (1, 200, 'Initial staff personal financing settings: 2% deduction from the gross financing amount, as specified by the product owner (November 2026). Amount limits, tenor options and mandatory documents not yet supplied.');

-- ---------------------------------------------------------------- requests
CREATE SEQUENCE staff_request_ref_seq START 1;

CREATE TABLE staff_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                       text NOT NULL UNIQUE,
  applicant_id              uuid NOT NULL REFERENCES staff(id),
  status                    text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                              'DRAFT','SUBMITTED','UNDER_PM_REVIEW','RETURNED_FOR_CORRECTION','UNDER_UNIT_HEAD_REVIEW',
                              'UNDER_DIVISIONAL_HEAD_REVIEW','APPROVED','AWAITING_SIGNED_OFFER','OFFER_EXPIRED',
                              'ASSIGNED_FOR_DISBURSEMENT','DISBURSEMENT_IN_PROGRESS','COMPLETED','DECLINED')),
  lock_version              int NOT NULL DEFAULT 0,
  settings_id               uuid NOT NULL REFERENCES staff_financing_settings(id),
  -- applicant profile at submission (name/email from the staff record; the rest entered or confirmed by the applicant)
  full_name                 text NOT NULL,
  email                     text NOT NULL,
  staff_number              text,
  department                text,
  unit                      text,
  phone                     text,
  salary_account_number     text,
  salary_account_name       text,
  purpose                   text,
  -- financing calculation (recalculated on the server at every save and at submission)
  gross_kobo                bigint CHECK (gross_kobo IS NULL OR gross_kobo > 0),
  deduction_rate_bps        int,
  deduction_kobo            bigint,
  net_kobo                  bigint,
  tenor_months              int CHECK (tenor_months IS NULL OR tenor_months > 0),
  deduction_acknowledged_at timestamptz,
  declaration_accepted_at   timestamptz,
  submission_count          int NOT NULL DEFAULT 0,
  first_submitted_at        timestamptz,
  submitted_at              timestamptz,
  -- review
  pm_reviewer_id            uuid REFERENCES staff(id),
  pm_claimed_at             timestamptz,
  unit_head_id              uuid REFERENCES staff(id),
  divisional_head_id        uuid REFERENCES staff(id),
  returned_at               timestamptz,
  returned_by               uuid REFERENCES staff(id),
  returned_from_status      text,
  return_reason             text,
  declined_at               timestamptz,
  declined_by               uuid REFERENCES staff(id),
  decline_reason            text,
  -- approval: terms are frozen (see trigger) and fingerprinted
  approved_at               timestamptz,
  approved_by               uuid REFERENCES staff(id),
  approved_terms            jsonb,
  approved_terms_sha256     text,
  -- offer
  offer_template_id         uuid REFERENCES offer_templates(id),
  offer_template_version    int,
  offer_issued_at           timestamptz,
  offer_deadline_at         timestamptz,
  offer_reminder_sent_at    timestamptz,
  offer_document_id         uuid,
  offer_blocked_reason      text,
  signed_offer_document_id  uuid,
  signed_offer_received_at  timestamptz,
  expired_at                timestamptz,
  -- disbursement (one per request; the transaction reference is unique across all requests)
  disbursement_officer_id   uuid REFERENCES staff(id),
  disbursement_assigned_at  timestamptz,
  documentation_reviewed_at timestamptz,
  documentation_reviewed_by uuid REFERENCES staff(id),
  disbursement_started_at   timestamptz,
  disbursement_started_by   uuid REFERENCES staff(id),
  disbursement_instruction_ref text,
  disbursement_txn_ref      text UNIQUE,
  disbursement_value_date   date,
  disbursed_amount_kobo     bigint,
  disbursement_evidence_document_id uuid,
  disbursed_at              timestamptz,
  disbursement_confirmed_by uuid REFERENCES staff(id),
  completed_at              timestamptz,
  -- documentation lifecycle (separate from the financing status)
  documentation_status      text NOT NULL DEFAULT 'NOT_STARTED' CHECK (documentation_status IN (
                              'NOT_STARTED','PREPARING_ARCHIVE','AWAITING_SHAREPOINT','SENT_TO_LEGAL_SHARIAH',
                              'RECEIVED_BY_LEGAL_SHARIAH','REVIEW_COMPLETED')),
  doc_attempts              int NOT NULL DEFAULT 0,
  doc_next_attempt_at       timestamptz,
  doc_last_error            text,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  CHECK (gross_kobo IS NULL OR (deduction_kobo IS NOT NULL AND net_kobo IS NOT NULL AND deduction_kobo + net_kobo = gross_kobo AND net_kobo > 0)),
  CHECK (status <> 'COMPLETED' OR (disbursement_txn_ref IS NOT NULL AND disbursed_at IS NOT NULL AND disbursed_amount_kobo = net_kobo)),
  CHECK (status NOT IN ('ASSIGNED_FOR_DISBURSEMENT','DISBURSEMENT_IN_PROGRESS','COMPLETED') OR (approved_at IS NOT NULL AND signed_offer_document_id IS NOT NULL))
);
CREATE INDEX staff_requests_applicant_idx ON staff_requests(applicant_id, created_at DESC);
CREATE INDEX staff_requests_status_idx ON staff_requests(status, updated_at DESC);
CREATE INDEX staff_requests_offer_deadline_idx ON staff_requests(offer_deadline_at) WHERE status = 'AWAITING_SIGNED_OFFER';
CREATE INDEX staff_requests_doc_due_idx ON staff_requests(doc_next_attempt_at) WHERE status = 'COMPLETED' AND documentation_status IN ('NOT_STARTED','PREPARING_ARCHIVE','AWAITING_SHAREPOINT');

-- Approved financing terms cannot change while the approval stands. A controlled amendment first
-- withdraws the approval (approved_at -> NULL) without touching the terms; edits are then possible
-- and the request must be approved again.
CREATE FUNCTION staff_requests_terms_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS NOT NULL AND (
       NEW.gross_kobo IS DISTINCT FROM OLD.gross_kobo OR NEW.deduction_kobo IS DISTINCT FROM OLD.deduction_kobo
    OR NEW.net_kobo IS DISTINCT FROM OLD.net_kobo OR NEW.deduction_rate_bps IS DISTINCT FROM OLD.deduction_rate_bps
    OR NEW.tenor_months IS DISTINCT FROM OLD.tenor_months OR NEW.salary_account_number IS DISTINCT FROM OLD.salary_account_number
    OR NEW.salary_account_name IS DISTINCT FROM OLD.salary_account_name OR NEW.applicant_id IS DISTINCT FROM OLD.applicant_id
    OR NEW.approved_terms IS DISTINCT FROM OLD.approved_terms OR NEW.approved_terms_sha256 IS DISTINCT FROM OLD.approved_terms_sha256) THEN
    RAISE EXCEPTION 'Approved staff financing terms are locked; withdraw the approval through a controlled amendment first';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff_requests rows are never deleted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_requests_terms_guard_trg BEFORE UPDATE OR DELETE ON staff_requests FOR EACH ROW EXECUTE FUNCTION staff_requests_terms_guard();

-- ---------------------------------------------------------------- documents (private object storage, scanned)
CREATE TABLE staff_request_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES staff_requests(id),
  seq            int NOT NULL,
  category       text NOT NULL CHECK (category IN ('PAYSLIP','ACCOUNT_STATEMENT','STAFF_ID_CARD','OTHER_SUPPORTING',
                   'GENERATED_OFFER','SIGNED_OFFER','DISBURSEMENT_EVIDENCE')),
  filename       text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL,
  sha256         text NOT NULL,
  storage_key    text NOT NULL,
  scan_status    text NOT NULL CHECK (scan_status IN ('QUARANTINED','CLEAN','REJECTED')),
  scan_detail    text,
  generated      boolean NOT NULL DEFAULT false,
  uploaded_by    uuid REFERENCES staff(id),
  uploaded_role  text,
  uploaded_at    timestamptz NOT NULL,
  status_at_upload text NOT NULL,
  removed_at     timestamptz,
  removed_by     uuid REFERENCES staff(id),
  UNIQUE (request_id, seq)
);
CREATE INDEX staff_request_documents_req_idx ON staff_request_documents(request_id, category);

-- ---------------------------------------------------------------- decisions and status history (append-only)
CREATE TABLE staff_request_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid NOT NULL REFERENCES staff_requests(id),
  stage               text NOT NULL CHECK (stage IN ('PRODUCT_MANAGER','UNIT_HEAD','DIVISIONAL_HEAD','DISBURSEMENT')),
  action              text NOT NULL CHECK (action IN ('FORWARD','APPROVE','RETURN','DECLINE','AMEND')),
  actor_id            uuid NOT NULL REFERENCES staff(id),
  actor_role          text NOT NULL,
  submission_no       int NOT NULL,
  checklist           jsonb,
  recommendation      text,
  comments            text,
  designated_next_id  uuid REFERENCES staff(id),
  from_status         text NOT NULL,
  to_status           text NOT NULL,
  created_at          timestamptz NOT NULL
);
CREATE INDEX staff_request_reviews_req_idx ON staff_request_reviews(request_id, created_at);
CREATE TRIGGER staff_request_reviews_append_only BEFORE UPDATE OR DELETE ON staff_request_reviews
  FOR EACH ROW EXECUTE FUNCTION staff_fin_append_only();

CREATE TABLE staff_request_events (
  id             bigserial PRIMARY KEY,
  request_id     uuid NOT NULL REFERENCES staff_requests(id),
  action         text NOT NULL,
  from_status    text,
  to_status      text,
  actor_id       uuid REFERENCES staff(id),
  actor_role     text,
  queue          text,
  outcome        text,
  comments       text,
  document_ids   uuid[] NOT NULL DEFAULT '{}',
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL
);
CREATE INDEX staff_request_events_req_idx ON staff_request_events(request_id, id);
CREATE TRIGGER staff_request_events_append_only BEFORE UPDATE OR DELETE ON staff_request_events
  FOR EACH ROW EXECUTE FUNCTION staff_fin_append_only();

-- ---------------------------------------------------------------- disbursement assignment history
CREATE TABLE staff_request_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES staff_requests(id),
  officer_id     uuid NOT NULL REFERENCES staff(id),
  officer_role   text NOT NULL,
  method         text NOT NULL CHECK (method IN ('RANDOM','ADMIN_REASSIGNMENT')),
  eligible_count int NOT NULL,
  assigned_by    uuid REFERENCES staff(id),
  reason         text,
  assigned_at    timestamptz NOT NULL,
  ended_at       timestamptz
);
CREATE UNIQUE INDEX staff_request_assignments_one_active ON staff_request_assignments(request_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------- documentation package, SharePoint, Legal & Shariah
CREATE TABLE staff_request_archives (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL UNIQUE REFERENCES staff_requests(id),
  filename       text NOT NULL,
  storage_key    text NOT NULL,
  sha256         text NOT NULL,
  size_bytes     bigint NOT NULL,
  manifest       jsonb NOT NULL,
  created_at     timestamptz NOT NULL
);

CREATE TABLE staff_request_sharepoint (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL UNIQUE REFERENCES staff_requests(id),
  archive_id      uuid NOT NULL REFERENCES staff_request_archives(id),
  status          text NOT NULL CHECK (status IN ('PENDING','FAILED','VERIFIED')),
  folder_path     text NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error      text,
  drive_item_id   text,
  web_url         text,
  uploaded_at     timestamptz,
  verified_at     timestamptz,
  alerted_at      timestamptz,
  created_at      timestamptz NOT NULL
);

CREATE TABLE staff_request_handovers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         uuid NOT NULL UNIQUE REFERENCES staff_requests(id),
  archive_id         uuid NOT NULL REFERENCES staff_request_archives(id),
  sharepoint_item_id text,
  sent_at            timestamptz NOT NULL
);
CREATE TABLE staff_request_handover_groups (
  handover_id   uuid NOT NULL REFERENCES staff_request_handovers(id),
  group_code    text NOT NULL CHECK (group_code IN ('LEGAL','SHARIAH')),
  status        text NOT NULL CHECK (status IN ('SENT','RECEIVED','REVIEWED')),
  notified_count int NOT NULL DEFAULT 0,
  received_by   uuid REFERENCES staff(id),
  received_at   timestamptz,
  reviewed_by   uuid REFERENCES staff(id),
  reviewed_at   timestamptz,
  comments      text,
  PRIMARY KEY (handover_id, group_code)
);

-- ---------------------------------------------------------------- audit, roles, offer templates
ALTER TABLE audit_events ADD COLUMN staff_request_id uuid REFERENCES staff_requests(id);
CREATE INDEX audit_events_staff_request_idx ON audit_events(staff_request_id, occurred_at) WHERE staff_request_id IS NOT NULL;

ALTER TABLE notification_outbox ADD COLUMN staff_request_id uuid REFERENCES staff_requests(id);

ALTER TABLE offer_templates DROP CONSTRAINT IF EXISTS offer_templates_applicant_type_check;
ALTER TABLE offer_templates ADD CONSTRAINT offer_templates_applicant_type_check CHECK (applicant_type IN ('INDIVIDUAL','ENTERPRISE','LIMITED','STAFF'));
