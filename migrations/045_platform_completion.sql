-- Platform completion: WakeelBoost access, SeedFi low-score exceptions, SLA reminders, automatic closing documents
-- (offer, GSI, Remita set-up sheet), invoice confirmation, retail facility archive and Legal & Shariah records review.
-- Existing records are preserved; nothing here changes an approval, a document or a request already on file.

-- 1. WakeelBoost is offered to Relationship Managers like every other product (open, RM permitted).
UPDATE products
   SET active = true,
       description = 'Merchant stock financing.',
       origination_roles = CASE WHEN origination_roles IS NULL OR 'RM' = ANY(origination_roles) THEN origination_roles ELSE array_append(origination_roles, 'RM') END,
       updated_at = now()
 WHERE code = 'WAKEELBOOST';

-- 2. SeedFi low-score exceptions (RM retail route). The original SeedFi results are never changed.
CREATE TABLE credit_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  failed_checks    jsonb NOT NULL,                       -- [{checkId, person, score, outcome, checkedAt}]
  rm_reason        text NOT NULL CHECK (length(trim(rm_reason)) >= 20),
  raised_by        uuid NOT NULL REFERENCES staff(id),
  raised_at        timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING_REVIEW'
                   CHECK (status IN ('PENDING_REVIEW','APPROVED','DECLINED','WITHDRAWN','SUPERSEDED')),
  tl_ack_by        uuid REFERENCES staff(id),
  tl_ack_at        timestamptz,
  tl_recommendation text CHECK (tl_recommendation IN ('PROCEED','RETURN','DECLINE')),
  tl_remarks       text,
  uh_ack_by        uuid REFERENCES staff(id),
  uh_ack_at        timestamptz,
  uh_recommendation text CHECK (uh_recommendation IN ('PROCEED','RETURN','DECLINE')),
  uh_remarks       text,
  dh_ack_by        uuid REFERENCES staff(id),            -- only when neither a Team Lead nor a Unit Head reviews (Unit Head-originated CX requests)
  dh_ack_at        timestamptz,
  dh_recommendation text CHECK (dh_recommendation IN ('PROCEED','RETURN','DECLINE')),
  dh_remarks       text,
  closed_at        timestamptz
);
CREATE UNIQUE INDEX credit_exceptions_open_uq ON credit_exceptions(application_id) WHERE status = 'PENDING_REVIEW';
CREATE INDEX credit_exceptions_app_idx ON credit_exceptions(application_id);

-- 3. SLA reminders (default: three continuous hours, every actionable queue).
CREATE TABLE sla_policy (
  id              int PRIMARY KEY CHECK (id = 1),
  reminder_hours  numeric(5,2) NOT NULL DEFAULT 3 CHECK (reminder_hours > 0 AND reminder_hours <= 168),
  repeat_hours    numeric(5,2) CHECK (repeat_hours IS NULL OR (repeat_hours > 0 AND repeat_hours <= 168)),
  hour_mode       text NOT NULL DEFAULT 'CALENDAR' CHECK (hour_mode IN ('CALENDAR','WORKING')),
  working_start   smallint NOT NULL DEFAULT 8 CHECK (working_start BETWEEN 0 AND 23),
  working_end     smallint NOT NULL DEFAULT 17 CHECK (working_end BETWEEN 1 AND 24),
  working_days    smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  holidays        date[] NOT NULL DEFAULT '{}',
  excluded_queues text[] NOT NULL DEFAULT '{}',
  cc_emails       text[] NOT NULL DEFAULT '{}',
  subject_template text NOT NULL DEFAULT 'ARAF Reminder — Pending Action for 3 Hours — [Facility Reference]',
  body_template   text NOT NULL DEFAULT E'Dear [Officer Name],\n\nThis is a reminder that the following request has been awaiting your action for three hours.\n\nCustomer: [Customer Name]\nFacility Reference: [Reference]\nProduct: [Product]\nRequired Action: [Action]\nAssigned At: [Date and Time]\n\nKindly log in to ARAF to review and treat the request.\n\n[Secure Link to Request]\n\nRegards,\nARAF — Retail Asset Factory\nThe Alternative Bank',
  enabled         boolean NOT NULL DEFAULT true,
  updated_by      uuid REFERENCES staff(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sla_policy (id) VALUES (1);

CREATE TABLE sla_reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue         text NOT NULL,                 -- RETAIL_TASK, STAFF_REQUEST, INVOICE_CONFIRMATION, ALTPHONES
  task_key      text NOT NULL,                 -- task id (or request id + stage)
  assigned_at   timestamptz NOT NULL,
  threshold_no  int NOT NULL DEFAULT 1,
  officer_id    uuid REFERENCES staff(id),
  reference     text NOT NULL,
  due_at        timestamptz NOT NULL,
  sent_at       timestamptz NOT NULL,
  outbox_id     uuid,
  UNIQUE (queue, task_key, assigned_at, threshold_no)
);
CREATE INDEX sla_reminders_ref_idx ON sla_reminders(reference);

-- 4. Closing documents: bank details used on generated documents, and generation tracking (idempotent, retried).
CREATE TABLE document_settings (
  id                      int PRIMARY KEY CHECK (id = 1),
  bank_name               text NOT NULL DEFAULT 'The Alternative Bank',
  bank_address            text,
  remita_beneficiary_name text,
  remita_beneficiary_bank text,
  remita_beneficiary_account text,
  remita_beneficiary_email text,
  remita_charge_kobo      bigint CHECK (remita_charge_kobo IS NULL OR remita_charge_kobo >= 0),
  remita_vat_percent      numeric(5,2) CHECK (remita_vat_percent IS NULL OR remita_vat_percent >= 0),
  updated_by              uuid REFERENCES staff(id),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO document_settings (id) VALUES (1);

CREATE TABLE document_generation (
  application_id  uuid NOT NULL REFERENCES applications(id),
  kind            text NOT NULL CHECK (kind IN ('OFFER','GSI','REMITA_SETUP')),
  version_id      uuid NOT NULL,                 -- the approved application version the documents belong to
  status          text NOT NULL CHECK (status IN ('PENDING','GENERATED','WAITING','FAILED')),
  document_id     uuid,
  detail          text,
  attempts        int NOT NULL DEFAULT 0,
  admin_alerted_at timestamptz,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (application_id, kind, version_id)
);

-- 5. Invoice confirmation.
CREATE TABLE invoice_confirmation_settings (
  id              int PRIMARY KEY CHECK (id = 1),
  officer_emails  text[] NOT NULL DEFAULT '{olamilekan.gaji@altbank.ng}',   -- order = primary, then backups
  updated_by      uuid REFERENCES staff(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO invoice_confirmation_settings (id) VALUES (1);

CREATE TABLE invoice_confirmations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL REFERENCES applications(id),
  invoice_document_id uuid NOT NULL,
  invoice_version    int NOT NULL,
  status             text NOT NULL CHECK (status IN ('PENDING_DISPATCH','PENDING','RETURNED','COMPLETED','DISPATCH_FAILED','SUPERSEDED')),
  officer_id         uuid REFERENCES staff(id),
  dispatched_at      timestamptz,
  assigned_at        timestamptz,
  response_document_id uuid,
  remarks            text,
  returned_reason    text,
  returned_at        timestamptz,
  completed_by       uuid REFERENCES staff(id),
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL,
  lock_version       int NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX invoice_confirmations_doc_uq ON invoice_confirmations(invoice_document_id);
CREATE UNIQUE INDEX invoice_confirmations_open_uq ON invoice_confirmations(application_id) WHERE status IN ('PENDING_DISPATCH','PENDING','DISPATCH_FAILED');
CREATE INDEX invoice_confirmations_officer_idx ON invoice_confirmations(officer_id, status);

-- 6. Retail facility archive and post-completion Legal & Shariah records review.
CREATE TABLE application_archives (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  filename       text NOT NULL,
  storage_key    text NOT NULL,
  sha256         text NOT NULL,
  size_bytes     bigint NOT NULL,
  manifest       jsonb NOT NULL,
  created_at     timestamptz NOT NULL
);
CREATE INDEX application_archives_app_idx ON application_archives(application_id, created_at DESC);

CREATE TABLE application_handovers (
  application_id uuid NOT NULL REFERENCES applications(id),
  group_code     text NOT NULL CHECK (group_code IN ('LEGAL','SHARIAH')),
  status         text NOT NULL CHECK (status IN ('SENT','RECEIVED','REVIEWED')),
  sent_at        timestamptz NOT NULL,
  received_by    uuid REFERENCES staff(id),
  received_at    timestamptz,
  reviewed_by    uuid REFERENCES staff(id),
  reviewed_at    timestamptz,
  comments       text,
  PRIMARY KEY (application_id, group_code)
);
ALTER TABLE applications ADD COLUMN records_status text CHECK (records_status IN ('PREPARING_ARCHIVE','SENT_TO_LEGAL_SHARIAH','REVIEW_COMPLETED','FAILED'));

-- 7. Documents ARAF prepares itself (offer, GSI mandate, Remita set-up sheet) have no human uploader.
ALTER TABLE documents ALTER COLUMN uploaded_by DROP NOT NULL;

-- 8. The customer's repayment (debit) account, used on the GSI mandate and the Remita set-up sheet.
ALTER TABLE applications ADD COLUMN repayment_account jsonb;   -- {bankName, accountNumber, accountName, branch, townCity}
ALTER TABLE document_settings ADD COLUMN remita_beneficiary_phone text;
