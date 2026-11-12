-- Altphones: phone sales (outright and on credit), stock and disbursement for the Delight Officer /
-- Smile Associate channel. Own records and statuses; shares staff, locations, audit, outbox and storage.

CREATE FUNCTION altphones_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- settings (versioned, append-only)
CREATE TABLE altphones_settings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version                int NOT NULL UNIQUE,
  outright_price_kobo    bigint NOT NULL CHECK (outright_price_kobo > 0),
  down_payment_kobo      bigint NOT NULL CHECK (down_payment_kobo > 0),
  tenures                int[] NOT NULL CHECK (tenures <@ ARRAY[3,6,12] AND cardinality(tenures) > 0),
  -- markup rate per tenure as percent × 10^4 (12.5% = 125000), e.g. {"3": 125000}; a missing tenure is not configured
  markup_rates           jsonb NOT NULL DEFAULT '{}',
  -- FLAT_TOTAL: the rate is the total markup for the tenure; FLAT_PER_MONTH: rate × months
  markup_basis           text CHECK (markup_basis IN ('FLAT_TOTAL','FLAT_PER_MONTH')),
  -- Seedfi score bands (approved credit policy): score >= pass_min → PASS, >= fair_min → FAIR, else FAIL
  score_pass_min         numeric(10,2),
  score_fair_min         numeric(10,2),
  -- repayment-date rules (approved policy)
  weekend_rule           text CHECK (weekend_rule IN ('NEXT_BUSINESS_DAY','PREVIOUS_BUSINESS_DAY','NO_ADJUSTMENT')),
  short_month_rule       text CHECK (short_month_rule IN ('LAST_DAY_OF_MONTH','FIRST_DAY_OF_NEXT_MONTH')),
  -- the bank-approved contract wording the customer accepts by OTP (placeholders filled per application)
  contract_template      text,
  unit_head_staff_id     uuid REFERENCES staff(id),
  team_email             text NOT NULL DEFAULT 'altbox@altbank.ng',
  reason                 text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by             uuid REFERENCES staff(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (down_payment_kobo < outright_price_kobo),
  CHECK (score_pass_min IS NULL OR score_fair_min IS NULL OR score_pass_min > score_fair_min)
);
CREATE TRIGGER altphones_settings_append_only BEFORE UPDATE OR DELETE ON altphones_settings
  FOR EACH ROW EXECUTE FUNCTION altphones_append_only();
INSERT INTO altphones_settings (version, outright_price_kobo, down_payment_kobo, tenures, reason)
VALUES (1, 14500000, 2900000, ARRAY[3,6,12],
  'Approved Altphones pricing: ₦145,000 outright, fixed ₦29,000 down payment (₦116,000 financed), 3, 6 or 12 months. Markup rates, Seedfi score bands, repayment-date rules, the contract wording and the route Unit Head are recorded from the approved policy as later versions.');

CREATE TABLE altphones_holidays (
  holiday_date date PRIMARY KEY,
  name         text NOT NULL,
  created_by   uuid REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- catalogue (Product Manager)
CREATE TABLE altphones_models (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  specifications  text NOT NULL DEFAULT '',
  image_key       text,
  image_mime      text,
  image_sha256    text,
  active          boolean NOT NULL DEFAULT true,
  sort_order      int NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES staff(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES staff(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX altphones_models_name_uq ON altphones_models (lower(name));

-- ---------------------------------------------------------------- stock (Branches and Shops only)
CREATE FUNCTION altphones_stock_location_guard() RETURNS trigger AS $$
DECLARE t text;
BEGIN
  SELECT outlet_type INTO t FROM locations WHERE id = NEW.location_id;
  IF t IS NULL OR t NOT IN ('BRANCH','ALTSHOP') THEN
    RAISE EXCEPTION 'Only Branches and Shops can hold Altphones stock (location type %)', coalesce(t, 'unknown');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE altphones_stock (
  location_id uuid NOT NULL REFERENCES locations(id),
  model_id    uuid NOT NULL REFERENCES altphones_models(id),
  physical    int NOT NULL DEFAULT 0 CHECK (physical >= 0),
  reserved    int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, model_id),
  CHECK (reserved <= physical)
);
CREATE TRIGGER altphones_stock_location_guard_trg BEFORE INSERT OR UPDATE ON altphones_stock
  FOR EACH ROW EXECUTE FUNCTION altphones_stock_location_guard();

CREATE TABLE altphones_applications (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                         text NOT NULL UNIQUE,
  kind                        text NOT NULL CHECK (kind IN ('OUTRIGHT','CREDIT')),
  channel                     text NOT NULL CHECK (channel IN ('DO','SA')),
  status                      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                                'DRAFT','AWAITING_PAYMENT','PAID','COMPLETED',
                                'CREDIT_DECLINED','AWAITING_DOWN_PAYMENT','IN_PREPARATION',
                                'UNDER_BPM_REVIEW','UNDER_PM_REVIEW','UNDER_UNIT_HEAD_REVIEW','RETURNED_FOR_CORRECTION',
                                'APPROVED','DISBURSED','REJECTED','CANCELLED')),
  lock_version                int NOT NULL DEFAULT 0,
  settings_id                 uuid NOT NULL REFERENCES altphones_settings(id),
  originator_id               uuid REFERENCES staff(id),
  originator_role             text,
  origin_location_id          uuid REFERENCES locations(id),
  supply_location_id          uuid REFERENCES locations(id),
  model_id                    uuid REFERENCES altphones_models(id),
  model_name                  text,
  -- customer
  customer_name               text,
  customer_email              text,
  customer_phone              text,
  bvn_enc                     text,
  bvn_hash                    text,
  bvn_last4                   text,
  ab_account_number           text,
  external_account_number     text,
  external_bank_name          text,
  details_confirmed_by        uuid REFERENCES staff(id),
  details_confirmed_at        timestamptz,
  -- agreed terms (fixed once the down payment is requested; never recalculated from later settings)
  price_kobo                  bigint,
  down_payment_kobo           bigint,
  financed_kobo               bigint,
  tenure_months               int CHECK (tenure_months IS NULL OR tenure_months IN (3,6,12)),
  markup_rate_e4              int,
  markup_basis                text,
  markup_kobo                 bigint,
  total_repayment_kobo        bigint,
  instalment_kobo             bigint,
  final_instalment_kobo       bigint,
  repayment_day               int CHECK (repayment_day IS NULL OR repayment_day BETWEEN 1 AND 31),
  terms_locked_at             timestamptz,
  -- Seedfi
  seedfi_status               text NOT NULL DEFAULT 'NOT_STARTED' CHECK (seedfi_status IN ('NOT_STARTED','UNAVAILABLE','COMPLETED')),
  seedfi_reference            text,
  seedfi_score                numeric(10,2),
  seedfi_outcome              text CHECK (seedfi_outcome IN ('PASS','FAIR','FAIL')),
  seedfi_bands                jsonb,
  seedfi_assessed_at          timestamptz,
  seedfi_last_error           text,
  -- stock
  reservation_status          text NOT NULL DEFAULT 'NONE' CHECK (reservation_status IN ('NONE','RESERVED','RELEASED','CONSUMED')),
  reserved_at                 timestamptz,
  device_id                   uuid,
  -- mandates
  dd_status                   text NOT NULL DEFAULT 'NOT_STARTED' CHECK (dd_status IN ('NOT_STARTED','PENDING','ACTIVE','FAILED')),
  dd_reference                text UNIQUE,
  dd_redirect_url             text,
  dd_authorization_enc        text,
  dd_account_last4            text,
  dd_bank_name                text,
  dd_initiated_at             timestamptz,
  dd_active_at                timestamptz,
  internal_mandate_confirmed_by uuid REFERENCES staff(id),
  internal_mandate_confirmed_at timestamptz,
  -- contract
  contract_id                 uuid,
  contract_accepted_at        timestamptz,
  -- approvals
  submission_count            int NOT NULL DEFAULT 0,
  submitted_at                timestamptz,
  bpm_reviewer_id             uuid REFERENCES staff(id),
  pm_reviewer_id              uuid REFERENCES staff(id),
  unit_head_id                uuid REFERENCES staff(id),
  approved_at                 timestamptz,
  -- completion
  imei                        text,
  handed_over_at              timestamptz,
  completed_by                uuid REFERENCES staff(id),
  completed_at                timestamptz,
  receipt_number              text UNIQUE,
  refund_status               text CHECK (refund_status IN ('REQUIRED','RECORDED')),
  refund_reference            text,
  closed_reason               text,
  -- historical imports
  legacy                      boolean NOT NULL DEFAULT false,
  legacy_ref                  text UNIQUE,
  legacy_import_id            uuid,
  legacy_officer              text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE altphones_ref_seq START 1;
CREATE SEQUENCE altphones_receipt_seq START 1;
CREATE INDEX altphones_app_status_idx ON altphones_applications(status);
CREATE INDEX altphones_app_originator_idx ON altphones_applications(originator_id, status);
CREATE INDEX altphones_app_bvn_idx ON altphones_applications(bvn_hash) WHERE bvn_hash IS NOT NULL;

CREATE TABLE altphones_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imei            text NOT NULL UNIQUE CHECK (imei ~ '^[0-9]{15}$'),
  model_id        uuid NOT NULL REFERENCES altphones_models(id),
  location_id     uuid REFERENCES locations(id),
  status          text NOT NULL CHECK (status IN ('IN_STOCK','RESERVED','ISSUED')),
  application_id  uuid REFERENCES altphones_applications(id),
  legacy          boolean NOT NULL DEFAULT false,
  registered_by   uuid REFERENCES staff(id),
  registered_at   timestamptz NOT NULL DEFAULT now(),
  issued_at       timestamptz,
  CHECK (status = 'IN_STOCK' OR application_id IS NOT NULL OR legacy)
);
CREATE UNIQUE INDEX altphones_devices_app_uq ON altphones_devices(application_id) WHERE application_id IS NOT NULL AND status IN ('RESERVED','ISSUED');
CREATE INDEX altphones_devices_loc_idx ON altphones_devices(location_id, model_id, status);
ALTER TABLE altphones_applications ADD CONSTRAINT altphones_app_device_fk FOREIGN KEY (device_id) REFERENCES altphones_devices(id);

CREATE TABLE altphones_replenishments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('OPENING','RECEIPT')),
  location_id     uuid NOT NULL REFERENCES locations(id),
  model_id        uuid NOT NULL REFERENCES altphones_models(id),
  quantity        int NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  imeis           text[] NOT NULL DEFAULT '{}',
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by    uuid NOT NULL REFERENCES staff(id),
  requested_at    timestamptz NOT NULL,
  decided_by      uuid REFERENCES staff(id),
  decided_at      timestamptz,
  decision_comment text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE SEQUENCE altphones_replenishment_seq START 1;

CREATE TABLE altphones_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('LOCATIONS','TRANSACTIONS','STOCK')),
  filename      text NOT NULL,
  sha256        text NOT NULL,
  status        text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','COMMITTED','DISCARDED')),
  rows          jsonb NOT NULL DEFAULT '[]',
  errors        jsonb NOT NULL DEFAULT '[]',
  summary       jsonb NOT NULL DEFAULT '{}',
  created_by    uuid NOT NULL REFERENCES staff(id),
  created_at    timestamptz NOT NULL,
  committed_by  uuid REFERENCES staff(id),
  committed_at  timestamptz
);
CREATE UNIQUE INDEX altphones_imports_file_uq ON altphones_imports(kind, sha256) WHERE status = 'COMMITTED';
ALTER TABLE altphones_applications ADD CONSTRAINT altphones_app_import_fk FOREIGN KEY (legacy_import_id) REFERENCES altphones_imports(id);

-- Every stock change is a ledger entry; altphones_stock holds the running balances in the same transaction.
CREATE TABLE altphones_stock_ledger (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid NOT NULL REFERENCES locations(id),
  model_id          uuid NOT NULL REFERENCES altphones_models(id),
  movement          text NOT NULL CHECK (movement IN ('OPENING','RECEIPT','RESERVE','RELEASE','SALE','DISBURSEMENT','LEGACY_ADJUSTMENT')),
  physical_delta    int NOT NULL,
  reserved_delta    int NOT NULL,
  application_id    uuid REFERENCES altphones_applications(id),
  device_id         uuid REFERENCES altphones_devices(id),
  replenishment_id  uuid REFERENCES altphones_replenishments(id),
  import_id         uuid REFERENCES altphones_imports(id),
  reference         text,
  legacy            boolean NOT NULL DEFAULT false,
  note              text,
  actor_id          uuid REFERENCES staff(id),
  occurred_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX altphones_ledger_app_move_uq ON altphones_stock_ledger(application_id, movement) WHERE application_id IS NOT NULL;
CREATE UNIQUE INDEX altphones_ledger_repl_uq ON altphones_stock_ledger(replenishment_id) WHERE replenishment_id IS NOT NULL;
CREATE UNIQUE INDEX altphones_ledger_import_ref_uq ON altphones_stock_ledger(reference) WHERE import_id IS NOT NULL;
CREATE INDEX altphones_ledger_loc_idx ON altphones_stock_ledger(location_id, model_id, occurred_at);
CREATE TRIGGER altphones_stock_ledger_append_only BEFORE UPDATE OR DELETE ON altphones_stock_ledger
  FOR EACH ROW EXECUTE FUNCTION altphones_append_only();

-- ---------------------------------------------------------------- payments and provider events
CREATE TABLE altphones_payments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL REFERENCES altphones_applications(id),
  purpose                 text NOT NULL CHECK (purpose IN ('DOWN_PAYMENT','OUTRIGHT')),
  provider                text NOT NULL DEFAULT 'PAYSTACK',
  reference               text NOT NULL UNIQUE,
  amount_kobo             bigint NOT NULL CHECK (amount_kobo > 0),
  status                  text NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED','SUCCESS','FAILED','ABANDONED')),
  checkout_url            text,
  provider_transaction_id text UNIQUE,
  channel                 text,
  paid_at                 timestamptz,
  verified_at             timestamptz,
  verified_via            text CHECK (verified_via IN ('WEBHOOK','VERIFY_API')),
  failure_reason          text,
  created_by              uuid REFERENCES staff(id),
  created_at              timestamptz NOT NULL
);
CREATE UNIQUE INDEX altphones_payments_success_uq ON altphones_payments(application_id, purpose) WHERE status = 'SUCCESS';

CREATE TABLE altphones_provider_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,
  event            text NOT NULL,
  body_sha256      text NOT NULL UNIQUE,
  reference        text,
  received_at      timestamptz NOT NULL,
  outcome          text NOT NULL,
  detail           text
);

-- ---------------------------------------------------------------- schedule, contract, OTP
CREATE TABLE altphones_schedule (
  application_id  uuid NOT NULL REFERENCES altphones_applications(id),
  seq             int NOT NULL,
  due_date        date NOT NULL,
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  basis           text NOT NULL CHECK (basis IN ('PROVISIONAL','FINAL')),
  generated_at    timestamptz NOT NULL,
  PRIMARY KEY (application_id, seq)
);

CREATE TABLE altphones_contracts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES altphones_applications(id),
  version          int NOT NULL,
  settings_id      uuid NOT NULL REFERENCES altphones_settings(id),
  body             text NOT NULL,
  sha256           text NOT NULL,
  terms            jsonb NOT NULL,
  generated_by     uuid REFERENCES staff(id),
  generated_at     timestamptz NOT NULL,
  UNIQUE (application_id, version)
);
CREATE TRIGGER altphones_contracts_append_only BEFORE UPDATE OR DELETE ON altphones_contracts
  FOR EACH ROW EXECUTE FUNCTION altphones_append_only();
ALTER TABLE altphones_applications ADD CONSTRAINT altphones_app_contract_fk FOREIGN KEY (contract_id) REFERENCES altphones_contracts(id);

CREATE TABLE altphones_otp_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES altphones_applications(id),
  contract_id     uuid NOT NULL REFERENCES altphones_contracts(id),
  code_hash       text NOT NULL,
  sent_to         text NOT NULL,
  expires_at      timestamptz NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL,
  consumed_at     timestamptz,
  created_by      uuid REFERENCES staff(id),
  created_at      timestamptz NOT NULL
);
CREATE INDEX altphones_otp_app_idx ON altphones_otp_challenges(application_id, created_at);

CREATE TABLE altphones_contract_acceptances (
  contract_id      uuid PRIMARY KEY REFERENCES altphones_contracts(id),
  application_id   uuid NOT NULL REFERENCES altphones_applications(id),
  challenge_id     uuid NOT NULL REFERENCES altphones_otp_challenges(id),
  contract_sha256  text NOT NULL,
  accepted_at      timestamptz NOT NULL,
  witnessed_by     uuid REFERENCES staff(id)
);
CREATE TRIGGER altphones_contract_acceptances_append_only BEFORE UPDATE OR DELETE ON altphones_contract_acceptances
  FOR EACH ROW EXECUTE FUNCTION altphones_append_only();

-- ---------------------------------------------------------------- decisions and history
CREATE TABLE altphones_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES altphones_applications(id),
  stage           text NOT NULL CHECK (stage IN ('BPM','PM','UNIT_HEAD')),
  action          text NOT NULL CHECK (action IN ('APPROVE','RETURN','REJECT')),
  comments        text,
  actor_id        uuid NOT NULL REFERENCES staff(id),
  submission_no   int NOT NULL,
  decided_at      timestamptz NOT NULL
);
CREATE INDEX altphones_reviews_app_idx ON altphones_reviews(application_id, decided_at);
CREATE TRIGGER altphones_reviews_append_only BEFORE UPDATE OR DELETE ON altphones_reviews
  FOR EACH ROW EXECUTE FUNCTION altphones_append_only();

CREATE TABLE altphones_events (
  id              bigserial PRIMARY KEY,
  application_id  uuid NOT NULL REFERENCES altphones_applications(id),
  action          text NOT NULL,
  from_status     text,
  to_status       text,
  actor_id        uuid REFERENCES staff(id),
  actor_role      text,
  comments        text,
  details         jsonb NOT NULL DEFAULT '{}',
  occurred_at     timestamptz NOT NULL
);
CREATE INDEX altphones_events_app_idx ON altphones_events(application_id, occurred_at);
CREATE TRIGGER altphones_events_append_only BEFORE UPDATE OR DELETE ON altphones_events
  FOR EACH ROW EXECUTE FUNCTION altphones_append_only();

ALTER TABLE audit_events ADD COLUMN altphones_application_id uuid REFERENCES altphones_applications(id);
CREATE INDEX audit_events_altphones_idx ON audit_events(altphones_application_id, occurred_at) WHERE altphones_application_id IS NOT NULL;
