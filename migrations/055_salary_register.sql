-- Phase 4. Staff Salary Advance: confidential salary register, automatic eligibility, confirmed repayments.
-- Additive only. Existing behaviour is unchanged until a Super Admin publishes a settings version with
-- eligibility_mode = 'SALARY_REGISTER' (the current version stays 'MANUAL').

ALTER TABLE staff_financing_settings
  ADD COLUMN eligibility_mode text NOT NULL DEFAULT 'MANUAL' CHECK (eligibility_mode IN ('MANUAL','SALARY_REGISTER')),
  ADD COLUMN eligibility_percent_bps int NOT NULL DEFAULT 5000 CHECK (eligibility_percent_bps BETWEEN 1 AND 10000),
  ADD COLUMN salary_record_max_age_days int NOT NULL DEFAULT 45 CHECK (salary_record_max_age_days BETWEEN 1 AND 400);

-- One current record per member of staff. Salary amounts are confidential: only the employee (their own
-- record), register administrators and approvers of that employee's request may read them.
CREATE TABLE salary_register (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id              uuid NOT NULL UNIQUE REFERENCES staff(id),
  staff_number          text NOT NULL,
  employee_name         text NOT NULL,
  ad_identity           text NOT NULL,                      -- Active Directory sign-in (email / UPN)
  monthly_salary_kobo   bigint NOT NULL CHECK (monthly_salary_kobo > 0),
  account_number_enc    text NOT NULL,                      -- verified salary account, encrypted
  account_last4         text NOT NULL,
  account_name          text NOT NULL,
  employment_status     text NOT NULL CHECK (employment_status IN ('ACTIVE','PROBATION','ON_LEAVE','SUSPENDED','EXITED')),
  eligibility_status    text NOT NULL DEFAULT 'ELIGIBLE' CHECK (eligibility_status IN ('ELIGIBLE','HELD')),
  hold_reason           text,
  salary_as_of          date NOT NULL,                      -- the payroll period the salary was verified for
  source                text NOT NULL CHECK (source IN ('CSV','MANUAL')),
  import_id             uuid,
  updated_by            uuid NOT NULL REFERENCES staff(id),
  updated_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL
);
CREATE UNIQUE INDEX salary_register_staff_number_idx ON salary_register(lower(staff_number));

-- Every change, kept for authorised audit review (append-only).
CREATE TABLE salary_register_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id           uuid NOT NULL REFERENCES salary_register(id),
  staff_id              uuid NOT NULL REFERENCES staff(id),
  change                text NOT NULL CHECK (change IN ('CREATED','UPDATED','HELD','RELEASED')),
  before                jsonb,
  after                 jsonb NOT NULL,
  reason                text,
  source                text NOT NULL,
  import_id             uuid,
  changed_by            uuid NOT NULL REFERENCES staff(id),
  changed_at            timestamptz NOT NULL
);
CREATE INDEX salary_register_history_staff_idx ON salary_register_history(staff_id, changed_at DESC);
CREATE TRIGGER salary_register_history_append_only BEFORE UPDATE OR DELETE ON salary_register_history
  FOR EACH ROW EXECUTE FUNCTION staff_fin_append_only();

-- CSV imports: uploaded, previewed, then applied (or discarded). Preview rows are cleared once applied or discarded.
CREATE TABLE salary_register_imports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename              text NOT NULL,
  sha256                text NOT NULL,
  status                text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','APPLIED','DISCARDED')),
  total_rows            int NOT NULL,
  valid_rows            int NOT NULL,
  error_rows            int NOT NULL,
  creates               int NOT NULL DEFAULT 0,
  updates               int NOT NULL DEFAULT 0,
  unchanged             int NOT NULL DEFAULT 0,
  errors                jsonb NOT NULL DEFAULT '[]',
  preview               jsonb,                              -- validated rows awaiting confirmation (cleared after)
  uploaded_by           uuid NOT NULL REFERENCES staff(id),
  uploaded_at           timestamptz NOT NULL,
  decided_by            uuid REFERENCES staff(id),
  decided_at            timestamptz
);

-- Confirmed repayments of a disbursed salary advance. Nothing reduces an outstanding balance except a row here.
CREATE TABLE staff_advance_repayments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id            uuid NOT NULL REFERENCES staff_requests(id),
  amount_kobo           bigint NOT NULL CHECK (amount_kobo > 0),
  value_date            date NOT NULL,
  reference             text NOT NULL UNIQUE,
  source                text NOT NULL CHECK (source IN ('PAYROLL_DEDUCTION','TRANSFER','OTHER')),
  note                  text,
  recorded_by           uuid NOT NULL REFERENCES staff(id),
  recorded_at           timestamptz NOT NULL
);
CREATE INDEX staff_advance_repayments_req_idx ON staff_advance_repayments(request_id, value_date);
CREATE TRIGGER staff_advance_repayments_append_only BEFORE UPDATE OR DELETE ON staff_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION staff_fin_append_only();

-- The register figures the request was submitted against (salary, percentage, limit, exposure at that moment).
ALTER TABLE staff_requests ADD COLUMN eligibility_snapshot jsonb;
