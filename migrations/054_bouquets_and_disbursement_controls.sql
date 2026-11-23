-- Phase 3. Additive only: nothing existing is changed or removed.
--
-- 1. Facility Bouquet: a Divisional Head concurs with many already-approved facilities at once. A bouquet is an
--    aggregation of approval decisions, never a merger of facilities: each member keeps its own application,
--    task, approved version, decision and audit record. Switched OFF by default and inert until a Super Admin
--    also names the eligible products.
-- 2. Disbursement controls for CAD: holds with reasons, and failed / uncertain posting attempts that must be
--    resolved before a booking can be recorded (no silent retry of an uncertain payment).

INSERT INTO feature_switches (key, label, enabled, note) VALUES
  ('BOUQUET_APPROVALS', 'Facility Bouquet (Divisional Head concurrence)', false,
   'Off until the bank''s risk governance approves bouquet concurrence. When off, every facility needs its own Divisional Head decision.')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE bouquet_settings (
  id                        int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  eligible_products         text[] NOT NULL DEFAULT '{}',          -- empty: no product is eligible
  max_size                  int NOT NULL DEFAULT 30 CHECK (max_size BETWEEN 2 AND 200),
  min_inspections           int NOT NULL DEFAULT 1 CHECK (min_inspections >= 0),
  individual_review_above_kobo bigint CHECK (individual_review_above_kobo IS NULL OR individual_review_above_kobo > 0),
  max_total_kobo            bigint CHECK (max_total_kobo IS NULL OR max_total_kobo > 0),
  exclusion_default         text NOT NULL DEFAULT 'INDIVIDUAL_REVIEW' CHECK (exclusion_default IN ('INDIVIDUAL_REVIEW','RETURN_FOR_CORRECTION')),
  updated_by                uuid REFERENCES staff(id),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bouquet_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE SEQUENCE bouquet_ref_seq;
CREATE TABLE bouquets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,
  divisional_head_id uuid NOT NULL REFERENCES staff(id),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONCURRED','DISSOLVED')),
  settings_snapshot jsonb NOT NULL,
  acknowledgement  text,
  concurred_at     timestamptz,
  concurred_count  int,
  concurred_total_kobo bigint,
  dissolved_at     timestamptz,
  dissolved_reason text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
-- At most one open bouquet per Divisional Head; anything arriving after concurrence goes to a new bouquet.
CREATE UNIQUE INDEX bouquets_one_open_idx ON bouquets(divisional_head_id) WHERE status = 'OPEN';

CREATE TABLE bouquet_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bouquet_id       uuid NOT NULL REFERENCES bouquets(id),
  application_id   uuid NOT NULL REFERENCES applications(id),
  task_id          uuid NOT NULL REFERENCES tasks(id),
  version_id       uuid,                                  -- approved version frozen at aggregation
  lock_version     int NOT NULL,
  amount_kobo      bigint NOT NULL,
  product_code     text,
  status           text NOT NULL DEFAULT 'INCLUDED' CHECK (status IN ('INCLUDED','EXCLUDED','CONCURRED','LEFT')),
  inspected_at     timestamptz,
  inspected_by     uuid REFERENCES staff(id),
  inspection_note  text,
  sampled          boolean NOT NULL DEFAULT false,
  excluded_at      timestamptz,
  excluded_by      uuid REFERENCES staff(id),
  exclusion_reason text,
  exclusion_action text CHECK (exclusion_action IN ('INDIVIDUAL_REVIEW','RETURN_FOR_CORRECTION')),
  concurred_at     timestamptz,
  added_at         timestamptz NOT NULL,
  UNIQUE (bouquet_id, application_id)
);
-- A facility can be in only one live bouquet at a time.
CREATE UNIQUE INDEX bouquet_members_live_idx ON bouquet_members(task_id) WHERE status IN ('INCLUDED','CONCURRED');
CREATE INDEX bouquet_members_app_idx ON bouquet_members(application_id);

CREATE TABLE disbursement_holds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  reason           text NOT NULL,
  held_by          uuid NOT NULL REFERENCES staff(id),
  held_role        text NOT NULL,
  held_at          timestamptz NOT NULL,
  released_at      timestamptz,
  released_by      uuid REFERENCES staff(id),
  release_note     text
);
CREATE UNIQUE INDEX disbursement_holds_active_idx ON disbursement_holds(application_id) WHERE released_at IS NULL;

CREATE TABLE disbursement_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  outcome          text NOT NULL CHECK (outcome IN ('FAILED','UNCERTAIN')),
  attempted_ref    text,
  amount_kobo      bigint CHECK (amount_kobo IS NULL OR amount_kobo > 0),
  note             text NOT NULL,
  recorded_by      uuid NOT NULL REFERENCES staff(id),
  recorded_at      timestamptz NOT NULL,
  resolution       text CHECK (resolution IN ('NOT_POSTED','POSTED')),
  resolution_note  text,
  resolved_by      uuid REFERENCES staff(id),
  resolved_at      timestamptz
);
CREATE INDEX disbursement_attempts_app_idx ON disbursement_attempts(application_id, recorded_at);
