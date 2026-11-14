-- Altphones operations, phase 2: staged migration of the historical sales register.
--
-- A register workbook is uploaded as a batch. Every row is staged (personal data encrypted), classified from the
-- evidence in the register, checked for duplicates and unreadable values, and reconciled. Nothing is published until
-- the preparer (Altphones Product Manager or Super Admin) submits the batch and a Unit Head who did not prepare it
-- approves it. Publishing creates verified historical accounts; it never moves stock.

CREATE TABLE altphones_migration_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref            text NOT NULL UNIQUE,
  filename       text NOT NULL,
  sha256         text NOT NULL UNIQUE,
  as_at          date NOT NULL,
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','PUBLISHED','DISCARDED')),
  prepared_by    uuid NOT NULL REFERENCES staff(id),
  prepared_at    timestamptz NOT NULL,
  submitted_by   uuid REFERENCES staff(id),
  submitted_at   timestamptz,
  decided_by     uuid REFERENCES staff(id),
  decided_at     timestamptz,
  decision_note  text,
  returned_note  text,
  sheets         jsonb NOT NULL DEFAULT '[]',
  summary        jsonb,
  CHECK (decided_by IS NULL OR (decided_by <> prepared_by AND decided_by <> coalesce(submitted_by, prepared_by)))
);
-- One batch in progress at a time, so the same customers are never staged twice in parallel.
CREATE UNIQUE INDEX altphones_migration_one_open ON altphones_migration_batches ((true)) WHERE status IN ('DRAFT','SUBMITTED');

CREATE TABLE altphones_migration_records (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id               uuid NOT NULL REFERENCES altphones_migration_batches(id),
  sheet                  text NOT NULL,
  sheet_kind             text NOT NULL CHECK (sheet_kind IN ('INTERNAL','EXTERNAL','COMPLETED','CANCELLED')),
  row_no                 int NOT NULL,
  customer_name          text NOT NULL,
  account_enc            text,
  account_last4          text,
  phone_enc              text,
  phone_last4            text,
  bvn_enc                text,
  bvn_hash               text,
  nin_enc                text,
  address_enc            text,
  units                  int,
  down_payment_kobo      bigint,
  down_payment_date      date,
  instalment_kobo        bigint,
  start_date             date,
  end_date               date,
  tenor_months           int,
  imei                   text,
  location_label         text,
  location_id            uuid REFERENCES locations(id),
  referrer_label         text,
  officer_id             uuid REFERENCES staff(id),
  months                 jsonb NOT NULL DEFAULT '[]',   -- [{"m":"2025-11","s":"Y"|"N"}], as written in the register
  parse_issues           jsonb NOT NULL DEFAULT '[]',   -- issues found while reading the row
  -- evaluation (recomputed whenever the as-at date, mappings or decisions change)
  paid_count             int NOT NULL DEFAULT 0,
  missed_count           int NOT NULL DEFAULT 0,
  classification         text NOT NULL DEFAULT 'NEEDS_REVIEW' CHECK (classification IN ('COMPLETED','CURRENT','IN_ARREARS','NOT_STARTED','NEEDS_REVIEW','CANCELLED')),
  arrears_kobo           bigint NOT NULL DEFAULT 0,
  outstanding_kobo       bigint NOT NULL DEFAULT 0,
  issues                 jsonb NOT NULL DEFAULT '[]',   -- [{"code","level":"BLOCK"|"WARN","message"}]
  -- the preparer's decision on this record
  decision               text CHECK (decision IN ('INCLUDE','EXCLUDE')),
  override_classification text CHECK (override_classification IN ('COMPLETED','CURRENT','IN_ARREARS','NOT_STARTED','CANCELLED')),
  decision_note          text,
  decided_by             uuid REFERENCES staff(id),
  decided_at             timestamptz,
  UNIQUE (batch_id, sheet, row_no)
);
CREATE INDEX altphones_migration_records_batch_idx ON altphones_migration_records (batch_id, classification);
CREATE INDEX altphones_migration_records_bvn_idx ON altphones_migration_records (bvn_hash) WHERE bvn_hash IS NOT NULL;

-- "Referred by" names in registers → staff.
CREATE TABLE altphones_officer_aliases (
  label       text PRIMARY KEY CHECK (label = upper(btrim(label)) AND length(label) >= 2),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Verified historical accounts, created only when a Unit Head approves a batch.
CREATE SEQUENCE altphones_migration_seq;
CREATE SEQUENCE altphones_historical_seq;
CREATE TABLE altphones_historical_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                text NOT NULL UNIQUE,
  batch_id           uuid NOT NULL REFERENCES altphones_migration_batches(id),
  record_id          uuid NOT NULL UNIQUE REFERENCES altphones_migration_records(id),
  source_sheet       text NOT NULL,
  source_row         int NOT NULL,
  customer_name      text NOT NULL,
  account_enc        text,
  account_last4      text,
  phone_enc          text,
  phone_last4        text,
  bvn_enc            text,
  bvn_hash           text,
  nin_enc            text,          -- kept only while repayment is not complete
  address_enc        text,
  units              int,
  down_payment_kobo  bigint,
  down_payment_date  date,
  instalment_kobo    bigint,
  start_date         date,
  end_date           date,
  tenor_months       int,
  imei               text,
  location_id        uuid REFERENCES locations(id),
  location_label     text,
  officer_id         uuid REFERENCES staff(id),
  referrer_label     text,
  status             text NOT NULL CHECK (status IN ('COMPLETED','CURRENT','IN_ARREARS','NOT_STARTED','CANCELLED')),
  paid_count         int NOT NULL DEFAULT 0,
  missed_count       int NOT NULL DEFAULT 0,
  arrears_kobo       bigint NOT NULL DEFAULT 0,
  outstanding_kobo   bigint NOT NULL DEFAULT 0,
  as_at              date NOT NULL,
  verification       text NOT NULL DEFAULT 'VERIFIED' CHECK (verification IN ('VERIFIED')),
  decision_note      text,
  published_by       uuid NOT NULL REFERENCES staff(id),
  published_at       timestamptz NOT NULL,
  CHECK (status <> 'COMPLETED' OR nin_enc IS NULL)
);
CREATE INDEX altphones_hist_status_idx ON altphones_historical_accounts (status);
CREATE INDEX altphones_hist_bvn_idx ON altphones_historical_accounts (bvn_hash) WHERE bvn_hash IS NOT NULL;
CREATE INDEX altphones_hist_imei_idx ON altphones_historical_accounts (imei) WHERE imei IS NOT NULL;

-- Month-by-month repayment evidence from the register (phase 3 adds later months to the same table).
CREATE TABLE altphones_historical_instalments (
  account_id  uuid NOT NULL REFERENCES altphones_historical_accounts(id),
  month       date NOT NULL CHECK (extract(day FROM month) = 1),
  status      text NOT NULL CHECK (status IN ('PAID','MISSED')),
  source      text NOT NULL DEFAULT 'REGISTER',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, month)
);
