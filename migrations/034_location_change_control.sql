-- Location change control (PM → Unit Head): a new Altshop/Altbox carries its BPM; requests can be returned for
-- correction and resubmitted; activation and deactivation are requested and approved, never set directly.
ALTER TABLE altphones_address_requests DROP CONSTRAINT IF EXISTS altphones_address_requests_status_check;
ALTER TABLE altphones_address_requests ADD CONSTRAINT altphones_address_requests_status_check CHECK (status IN ('PENDING','RETURNED','APPROVED','REJECTED'));
ALTER TABLE altphones_address_requests
  ADD COLUMN bpm_email text CHECK (bpm_email IS NULL OR bpm_email = lower(btrim(bpm_email))),
  ADD COLUMN resubmitted_by uuid REFERENCES staff(id),
  ADD COLUMN resubmitted_at timestamptz;
DROP INDEX IF EXISTS altphones_address_requests_open;
CREATE UNIQUE INDEX altphones_address_requests_open ON altphones_address_requests (location_id) WHERE status IN ('PENDING','RETURNED');

CREATE SEQUENCE IF NOT EXISTS altphones_location_status_seq;
CREATE TABLE altphones_location_status_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,
  location_id   uuid NOT NULL REFERENCES locations(id),
  action        text NOT NULL CHECK (action IN ('DEACTIVATE','REACTIVATE')),
  note          text NOT NULL CHECK (length(btrim(note)) >= 5),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by  uuid NOT NULL REFERENCES staff(id),
  requested_at  timestamptz NOT NULL,
  decided_by    uuid REFERENCES staff(id),
  decided_at    timestamptz,
  decision_note text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX altphones_location_status_open ON altphones_location_status_requests (location_id) WHERE status = 'PENDING';
