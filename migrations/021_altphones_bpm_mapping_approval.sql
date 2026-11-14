-- BPM mapping by hand is maker-checker: the Altphones Product Manager (or a Super Admin) requests it, and a Unit Head
-- who did not request it approves before it takes effect. A mapping covers a whole state, or one location (which takes
-- precedence over its state's mapping), so locations not covered by the profiling workbook can be routed.

ALTER TABLE altphones_bpm_states ADD COLUMN approved_by uuid REFERENCES staff(id);

CREATE TABLE altphones_bpm_locations (
  location_id  uuid PRIMARY KEY REFERENCES locations(id),
  bpm_email    text NOT NULL CHECK (bpm_email = lower(btrim(bpm_email))),
  updated_by   uuid REFERENCES staff(id),
  approved_by  uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE altphones_bpm_request_seq;
CREATE TABLE altphones_bpm_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,
  scope         text NOT NULL CHECK (scope IN ('STATE','LOCATION')),
  state         text,
  location_id   uuid REFERENCES locations(id),
  bpm_email     text CHECK (bpm_email IS NULL OR bpm_email = lower(btrim(bpm_email))), -- NULL removes the mapping
  note          text,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by  uuid NOT NULL REFERENCES staff(id),
  requested_at  timestamptz NOT NULL,
  decided_by    uuid REFERENCES staff(id),
  decided_at    timestamptz,
  decision_note text,
  CHECK ((scope = 'STATE' AND state IS NOT NULL AND location_id IS NULL) OR (scope = 'LOCATION' AND location_id IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX altphones_bpm_requests_open_state ON altphones_bpm_requests (state) WHERE status = 'PENDING' AND scope = 'STATE';
CREATE UNIQUE INDEX altphones_bpm_requests_open_loc ON altphones_bpm_requests (location_id) WHERE status = 'PENDING' AND scope = 'LOCATION';
