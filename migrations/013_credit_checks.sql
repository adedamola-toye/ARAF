-- SeedFi credit checks for the Relationship Manager (retail) and Staff Request routes. Altphones keeps its
-- own fields on altphones_applications. One row per person checked; append-only. The Seed Score bands in
-- the current Altphones settings apply to every route (Pass / Fair / Fail).
CREATE TABLE credit_checks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid REFERENCES applications(id),
  staff_request_id   uuid REFERENCES staff_requests(id),
  person_key         text NOT NULL,          -- 'APPLICANT' or 'DIRECTOR:<position>'
  person_label       text NOT NULL,
  bvn_hash           text NOT NULL,
  bvn_last4          text NOT NULL,
  first_name         text NOT NULL,
  last_name          text NOT NULL,
  date_of_birth      date NOT NULL,
  gender             text NOT NULL CHECK (gender IN ('male','female')),
  seedfi_customer_id text NOT NULL,
  status             text NOT NULL CHECK (status IN ('COMPLETED','UNAVAILABLE')),
  score              numeric(10,2),
  overall_score      numeric(10,2),
  has_history        boolean,
  outcome            text CHECK (outcome IN ('PASS','FAIR','FAIL')),
  bands              jsonb,
  details            jsonb NOT NULL DEFAULT '{}',
  error              text,
  requested_by       uuid REFERENCES staff(id),
  created_at         timestamptz NOT NULL,
  CHECK (num_nonnulls(application_id, staff_request_id) = 1),
  CHECK (status = 'UNAVAILABLE' OR (score IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX credit_checks_app_idx ON credit_checks(application_id, person_key, created_at) WHERE application_id IS NOT NULL;
CREATE INDEX credit_checks_staff_idx ON credit_checks(staff_request_id, created_at) WHERE staff_request_id IS NOT NULL;
CREATE TRIGGER credit_checks_append_only BEFORE UPDATE OR DELETE ON credit_checks FOR EACH ROW EXECUTE FUNCTION altphones_append_only();
