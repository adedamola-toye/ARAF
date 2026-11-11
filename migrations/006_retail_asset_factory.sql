-- AltBank Retail Asset Factory: product catalogue, versioned product configuration, retail business review routing,
-- outlets, beneficiary register, document matrix metadata, versioned affordability assessments, policy exceptions,
-- request ledger (daily wallet), facility / payment / fulfilment states, servicing and service targets.
-- Incremental and additive: existing WakeelBoost records keep their data, decisions and labels.

-- ---------------------------------------------------------------- product catalogue + configuration
CREATE TABLE products (
  code         text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  name         text NOT NULL,
  description  text,
  workflow     text NOT NULL DEFAULT 'RETAIL' CHECK (workflow IN ('WAKEELBOOST','RETAIL')),
  active       boolean NOT NULL DEFAULT true,
  sort_order   int NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO products (code, name, description, workflow, active, sort_order) VALUES
  ('VENDOR_FINANCING', 'Vendor Financing', 'Financing for registered businesses to pay approved vendors.', 'RETAIL', true, 10),
  ('ALT_DRIVE', 'Alt Drive', 'Vehicle financing for salary earners and business owners (Murabaha or Ijarah).', 'RETAIL', true, 20),
  ('ALT_POWER', 'Alt Power', 'Power and alternative-energy financing for salary earners and business owners.', 'RETAIL', true, 30),
  ('WAKEELBOOST', 'WakeelBoost', 'Legacy merchant stock financing (historical product; existing records keep this label).', 'WAKEELBOOST', true, 90);

-- Product rules are versioned, effective-dated and approved by a second person (maker-checker).
CREATE TABLE product_configs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code   text NOT NULL REFERENCES products(code),
  version        int NOT NULL,
  status         text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','WITHDRAWN')),
  config         jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  reason         text NOT NULL CHECK (length(trim(reason)) >= 3),
  proposed_by    uuid REFERENCES staff(id),
  proposed_at    timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES staff(id),
  decided_at     timestamptz,
  decision_note  text,
  UNIQUE (product_code, version),
  CHECK (status = 'PROPOSED' OR decided_at IS NOT NULL OR proposed_by IS NULL)
);
CREATE INDEX product_configs_effective_idx ON product_configs(product_code, effective_from DESC, version DESC) WHERE status = 'APPROVED';
-- The configuration body is immutable; only the decision columns may change, and only once.
CREATE FUNCTION product_configs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'product_configs cannot be deleted'; END IF;
  IF NEW.config IS DISTINCT FROM OLD.config OR NEW.version IS DISTINCT FROM OLD.version OR NEW.product_code IS DISTINCT FROM OLD.product_code
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by THEN
    RAISE EXCEPTION 'product configuration versions are immutable: propose a new version';
  END IF;
  IF OLD.status <> 'PROPOSED' THEN RAISE EXCEPTION 'product configuration decision already recorded'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_configs_guard_trg BEFORE UPDATE OR DELETE ON product_configs FOR EACH ROW EXECUTE FUNCTION product_configs_guard();

-- ---------------------------------------------------------------- organisation: teams + outlet locations
ALTER TABLE role_assignments ADD COLUMN team text;
CREATE INDEX role_assignments_team_idx ON role_assignments(role, team) WHERE active;

CREATE TABLE locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state         text NOT NULL,
  city          text NOT NULL CHECK (length(trim(city)) >= 2),
  outlet_type   text NOT NULL CHECK (outlet_type IN ('BRANCH','ALTBOX','ALTSHOP')),
  name          text NOT NULL CHECK (length(trim(name)) >= 2),
  address       text,
  oss_staff_id  uuid REFERENCES staff(id),
  team          text,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES staff(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state, city, outlet_type, name)
);

-- ---------------------------------------------------------------- financial institutions + beneficiary register
CREATE TABLE financial_institutions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,              -- stable institution identifier (e.g. CBN institution code)
  name             text NOT NULL,
  aliases          text[] NOT NULL DEFAULT '{}',
  category         text NOT NULL CHECK (category IN ('COMMERCIAL','MERCHANT','NON_INTEREST','MICROFINANCE','OTHER')),
  regulatory_status text NOT NULL DEFAULT 'UNCONFIRMED' CHECK (regulatory_status IN ('CONFIRMED_ACTIVE','UNCONFIRMED','REVOKED')),
  routing_codes    jsonb NOT NULL DEFAULT '{}'::jsonb, -- provider routing codes, e.g. {"NIP": "000014"}
  payment_supported boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  source           text NOT NULL DEFAULT 'manual',
  source_reference text,
  verified_at      timestamptz,
  updated_by       uuid REFERENCES staff(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(trim(name)) >= 2),
  email               text CHECK (email IS NULL OR email = lower(email)),
  phone               text,
  registration_number text,
  address             text,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  verification_status text NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED')),
  created_by          uuid REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  verified_by         uuid REFERENCES staff(id),
  verified_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id),
  institution_id      uuid NOT NULL REFERENCES financial_institutions(id),
  account_number      text NOT NULL CHECK (account_number ~ '^[0-9]{10}$'),
  account_name        text NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  verification_status text NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','FAILED','UNAVAILABLE')),
  verification_method text CHECK (verification_method IN ('NAME_ENQUIRY','MANUAL_EVIDENCE')),
  verification_note   text,
  resolved_account_name text,
  created_by          uuid REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  verified_by         uuid REFERENCES staff(id),
  verified_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, account_number)
);

-- ---------------------------------------------------------------- applications: retail columns
ALTER TABLE applications DROP CONSTRAINT applications_initiator_role_check;
ALTER TABLE applications ADD CONSTRAINT applications_initiator_role_check CHECK (initiator_role IN ('RM','ANM','MERCHANT_OFFICER','DELIGHT_OFFICER'));
ALTER TABLE applications DROP CONSTRAINT applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
  CHECK (status IN ('DRAFT','IN_PROGRESS','BOOKED','CLOSED','REJECTED','WITHDRAWN','EXPIRED','COMPLETED'));

ALTER TABLE applications ADD COLUMN workflow text NOT NULL DEFAULT 'WAKEELBOOST' CHECK (workflow IN ('WAKEELBOOST','RETAIL'));
ALTER TABLE applications ADD COLUMN product_code text REFERENCES products(code);
ALTER TABLE applications ADD COLUMN product_label text;            -- label at creation; never relabelled
ALTER TABLE applications ADD COLUMN product_config_id uuid REFERENCES product_configs(id);
ALTER TABLE applications ADD COLUMN customer_profile text CHECK (customer_profile IN ('SALARY_EARNER','BUSINESS_OWNER'));
ALTER TABLE applications ADD COLUMN financing_structure text;
ALTER TABLE applications ADD COLUMN team text;
ALTER TABLE applications ADD COLUMN outlet_location_id uuid REFERENCES locations(id);
ALTER TABLE applications ADD COLUMN location_snapshot jsonb;
ALTER TABLE applications ADD COLUMN assigned_rm_id uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN oss_reviewer_id uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN team_lead_id uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN hrs_id uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN hou_id uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN business_approved_at timestamptz;
ALTER TABLE applications ADD COLUMN suspended_at timestamptz;
ALTER TABLE applications ADD COLUMN suspended_by uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN suspension_reason text;
ALTER TABLE applications ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE applications ADD COLUMN expired_at timestamptz;
ALTER TABLE applications ADD COLUMN completed_at timestamptz;
ALTER TABLE applications ADD COLUMN migration_note text;
CREATE INDEX applications_product_idx ON applications(product_code, stage);
CREATE INDEX applications_team_idx ON applications(team) WHERE team IS NOT NULL;
CREATE INDEX applications_outlet_idx ON applications(outlet_location_id) WHERE outlet_location_id IS NOT NULL;

-- Existing records are WakeelBoost cases: label them as such (never as a retail product).
UPDATE applications SET product_code = 'WAKEELBOOST', product_label = 'WakeelBoost' WHERE product_code IS NULL;

-- Decisions carry an explicit meaning so business endorsement and credit approval are never confused.
ALTER TABLE decisions ADD COLUMN decision_kind text CHECK (decision_kind IN ('BUSINESS_REVIEW','CREDIT','OPERATIONAL','CORRECTION','DECLINE','INITIATOR'));
ALTER TABLE decisions ADD COLUMN product_config_id uuid REFERENCES product_configs(id);
UPDATE decisions SET decision_kind = CASE
  WHEN action IN ('REJECT') THEN 'DECLINE'
  WHEN action IN ('RETURN','REQUEST_INITIATOR','SEND_FOR_CORRECTION') THEN 'CORRECTION'
  WHEN stage = 'BUSINESS_ENDORSEMENT' THEN 'BUSINESS_REVIEW'
  WHEN stage IN ('FIRST_CREDIT_REVIEW','SECOND_CREDIT_REVIEW','UNIT_HEAD_REVIEW','DIVISIONAL_HEAD_REVIEW','CREDIT_CORRECTION') THEN 'CREDIT'
  WHEN stage IN ('INITIATOR_CORRECTION','OFFER_PREPARATION','VENDOR_CONFIRMATION') THEN 'INITIATOR'
  ELSE 'OPERATIONAL' END
 WHERE decision_kind IS NULL;

-- Every return names its responsible recipient.
ALTER TABLE corrections ADD COLUMN recipient_id uuid REFERENCES staff(id);

-- Document matrix metadata: photo category, statement coverage, reviewer rejection.
ALTER TABLE documents ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE documents ADD COLUMN review_status text CHECK (review_status IN ('ACCEPTED','REJECTED'));
ALTER TABLE documents ADD COLUMN review_reason text;
ALTER TABLE documents ADD COLUMN reviewed_by uuid REFERENCES staff(id);
ALTER TABLE documents ADD COLUMN reviewed_at timestamptz;

-- Offer templates keyed by product and structure for retail products.
ALTER TABLE offer_templates ADD COLUMN product_code text REFERENCES products(code);
ALTER TABLE offer_templates ADD COLUMN structure text;
DROP INDEX offer_templates_one_active;
CREATE UNIQUE INDEX offer_templates_one_active ON offer_templates ((coalesce(product_code, 'WAKEELBOOST')), (coalesce(structure, 'ALL')), (coalesce(applicant_type, 'ALL'))) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------- credit proposals (structured, versioned)
CREATE TABLE credit_proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  version_no     int NOT NULL,
  content        jsonb NOT NULL,
  author_id      uuid NOT NULL REFERENCES staff(id),
  author_role    text NOT NULL,
  created_at     timestamptz NOT NULL,
  UNIQUE (application_id, version_no)
);
CREATE TRIGGER credit_proposals_append_only BEFORE UPDATE OR DELETE ON credit_proposals FOR EACH ROW EXECUTE FUNCTION pricing_settings_append_only();

-- ---------------------------------------------------------------- versioned affordability assessments
CREATE TABLE retail_assessments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id),
  version_id        uuid NOT NULL REFERENCES application_versions(id),
  kind              text NOT NULL CHECK (kind IN ('PRELIMINARY','FINAL')),
  engine_version    text NOT NULL,
  product_config_id uuid NOT NULL REFERENCES product_configs(id),
  rules             jsonb NOT NULL,
  inputs            jsonb NOT NULL,
  outputs           jsonb NOT NULL,
  result            text NOT NULL CHECK (result IN ('PASS','FAIL','BLOCKED')),
  assessor_id       uuid NOT NULL REFERENCES staff(id),
  assessor_role     text NOT NULL,
  created_at        timestamptz NOT NULL,
  superseded_at     timestamptz
);
CREATE INDEX retail_assessments_app_idx ON retail_assessments(application_id, kind, created_at DESC);
CREATE FUNCTION retail_assessments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'assessments cannot be deleted'; END IF;
  IF NEW.inputs IS DISTINCT FROM OLD.inputs OR NEW.outputs IS DISTINCT FROM OLD.outputs OR NEW.rules IS DISTINCT FROM OLD.rules
     OR NEW.result IS DISTINCT FROM OLD.result OR NEW.version_id IS DISTINCT FROM OLD.version_id THEN
    RAISE EXCEPTION 'assessment snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER retail_assessments_guard_trg BEFORE UPDATE OR DELETE ON retail_assessments FOR EACH ROW EXECUTE FUNCTION retail_assessments_guard();
ALTER TABLE decisions ADD COLUMN retail_assessment_id uuid REFERENCES retail_assessments(id);

-- ---------------------------------------------------------------- policy exceptions (AFS, DSR, documents)
CREATE TABLE policy_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  type             text NOT NULL CHECK (type IN ('AFS','DSR','DOCUMENT')),
  subject          text,                       -- e.g. the document code for DOCUMENT exceptions
  version_id       uuid REFERENCES application_versions(id),
  approver_role    text NOT NULL,
  reason           text NOT NULL CHECK (length(trim(reason)) >= 10),
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','DECLINED','SUPERSEDED')),
  requested_by     uuid NOT NULL REFERENCES staff(id),
  requested_at     timestamptz NOT NULL,
  decided_by       uuid REFERENCES staff(id),
  decided_at       timestamptz,
  decision_note    text,
  product_config_id uuid REFERENCES product_configs(id)
);
CREATE INDEX policy_exceptions_app_idx ON policy_exceptions(application_id, type, status);
CREATE UNIQUE INDEX policy_exceptions_one_open ON policy_exceptions(application_id, type, coalesce(subject, '')) WHERE status = 'REQUESTED';

-- ---------------------------------------------------------------- request ledger (RM daily wallet)
CREATE TABLE request_ledger (
  application_id         uuid PRIMARY KEY REFERENCES applications(id),
  initiator_id           uuid NOT NULL REFERENCES staff(id),
  initiator_role         text NOT NULL,
  submitted_at           timestamptz NOT NULL,
  lagos_date             date NOT NULL,
  requested_amount_kobo  bigint NOT NULL CHECK (requested_amount_kobo > 0),
  product_code           text,
  product_label          text,
  customer_name          text,
  latest_requested_amount_kobo bigint
);
CREATE INDEX request_ledger_initiator_day_idx ON request_ledger(initiator_id, lagos_date);
CREATE FUNCTION request_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'request_ledger rows cannot be deleted'; END IF;
  IF NEW.requested_amount_kobo IS DISTINCT FROM OLD.requested_amount_kobo OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.lagos_date IS DISTINCT FROM OLD.lagos_date OR NEW.initiator_id IS DISTINCT FROM OLD.initiator_id THEN
    RAISE EXCEPTION 'submitted request amounts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER request_ledger_guard_trg BEFORE UPDATE OR DELETE ON request_ledger FOR EACH ROW EXECUTE FUNCTION request_ledger_guard();
-- Existing submitted cases enter the ledger once, on their original submission date.
INSERT INTO request_ledger (application_id, initiator_id, initiator_role, submitted_at, lagos_date, requested_amount_kobo, product_code, product_label, customer_name, latest_requested_amount_kobo)
SELECT a.id, a.initiator_id, a.initiator_role, a.submitted_at, (a.submitted_at AT TIME ZONE 'Africa/Lagos')::date,
       coalesce(v1.requested_amount_kobo, a.requested_amount_kobo), a.product_code, a.product_label, a.customer_name, a.requested_amount_kobo
  FROM applications a
  LEFT JOIN LATERAL (SELECT requested_amount_kobo FROM application_versions v WHERE v.application_id = a.id AND v.submitted_at IS NOT NULL ORDER BY v.version_no LIMIT 1) v1 ON true
 WHERE a.submitted_at IS NOT NULL AND coalesce(v1.requested_amount_kobo, a.requested_amount_kobo) > 0;

-- ---------------------------------------------------------------- facility, payment and fulfilment states
CREATE TABLE facilities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL UNIQUE REFERENCES applications(id),
  booking_ref        text NOT NULL UNIQUE,
  principal_kobo     bigint NOT NULL CHECK (principal_kobo > 0),
  total_payable_kobo bigint NOT NULL CHECK (total_payable_kobo >= principal_kobo),
  tenor_months       int NOT NULL CHECK (tenor_months > 0),
  status             text NOT NULL CHECK (status IN ('BOOKED','ACTIVE','IN_ARREARS','RESTRUCTURED','SETTLED','CLOSED','CANCELLED')),
  payment_status     text NOT NULL DEFAULT 'NOT_STARTED' CHECK (payment_status IN ('NOT_STARTED','PENDING','PARTIAL','CONFIRMED','FAILED','REVERSED','RECONCILED')),
  fulfilment_status  text NOT NULL DEFAULT 'NOT_STARTED' CHECK (fulfilment_status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED','NOT_APPLICABLE')),
  retail_assessment_id uuid REFERENCES retail_assessments(id),
  booked_by          uuid NOT NULL REFERENCES staff(id),
  booked_at          timestamptz NOT NULL,
  reconciled_by      uuid REFERENCES staff(id),
  reconciled_at      timestamptz,
  settled_at         timestamptz,
  closed_by          uuid REFERENCES staff(id),
  closed_at          timestamptz
);

ALTER TABLE repayment_instalments ALTER COLUMN disbursement_id DROP NOT NULL;
ALTER TABLE repayment_instalments ADD COLUMN facility_id uuid REFERENCES facilities(id);
ALTER TABLE repayment_instalments ADD CONSTRAINT repayment_instalments_owner CHECK (disbursement_id IS NOT NULL OR facility_id IS NOT NULL);
CREATE UNIQUE INDEX repayment_instalments_facility_seq ON repayment_instalments(facility_id, seq) WHERE facility_id IS NOT NULL;

CREATE TABLE payment_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  application_id   uuid NOT NULL REFERENCES applications(id),
  event_type       text NOT NULL CHECK (event_type IN ('INITIATED','CONFIRMED','FAILED','REVERSED')),
  amount_kobo      bigint NOT NULL CHECK (amount_kobo >= 0),
  payment_ref      text NOT NULL,
  value_date       date,
  source           text NOT NULL CHECK (source IN ('INTEGRATION','MANUAL_EVIDENCE')),
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  beneficiary_snapshot jsonb NOT NULL,
  note             text,
  recorded_by      uuid REFERENCES staff(id),
  recorded_at      timestamptz NOT NULL,
  UNIQUE (payment_ref, event_type)
);
CREATE INDEX payment_events_facility_idx ON payment_events(facility_id, recorded_at);
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION pricing_settings_append_only();

CREATE TABLE fulfilment_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  kind             text NOT NULL CHECK (kind IN ('POS_DEPLOYMENT','ASSET_DELIVERY','ASSET_HANDOVER','INSTALLATION')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CANCELLED')),
  created_at       timestamptz NOT NULL,
  created_reason   text NOT NULL,
  completed_by     uuid REFERENCES staff(id),
  completed_at     timestamptz,
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  note             text,
  UNIQUE (application_id, kind)
);

CREATE TABLE repayment_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  event_type       text NOT NULL CHECK (event_type IN ('RECEIVED','REVERSED')),
  amount_kobo      bigint NOT NULL CHECK (amount_kobo > 0),
  value_date       date NOT NULL,
  reference        text NOT NULL,
  source           text NOT NULL CHECK (source IN ('INTEGRATION','MANUAL_EVIDENCE')),
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  recorded_by      uuid REFERENCES staff(id),
  recorded_at      timestamptz NOT NULL,
  UNIQUE (facility_id, reference, event_type)
);
CREATE TRIGGER repayment_events_append_only BEFORE UPDATE OR DELETE ON repayment_events FOR EACH ROW EXECUTE FUNCTION pricing_settings_append_only();

CREATE TABLE servicing_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  kind             text NOT NULL CHECK (kind IN ('ARREARS_FOLLOW_UP','RECOVERY_NOTE','RESTRUCTURE_REQUEST')),
  note             text NOT NULL CHECK (length(trim(note)) >= 3),
  proposal         jsonb,
  status           text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','REQUESTED','APPROVED','DECLINED')),
  approver_role    text,
  recorded_by      uuid NOT NULL REFERENCES staff(id),
  recorded_at      timestamptz NOT NULL,
  decided_by       uuid REFERENCES staff(id),
  decided_at       timestamptz,
  decision_note    text
);

-- ---------------------------------------------------------------- service targets + escalation
CREATE TABLE service_targets (
  stage                text PRIMARY KEY,
  target_hours         int NOT NULL CHECK (target_hours BETWEEN 1 AND 2160),
  escalation_staff_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by           uuid REFERENCES staff(id),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
