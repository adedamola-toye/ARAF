-- The Placeholder BPM is a person: an active @altbank.ng staff member with the BPM role, set by the Product Manager and
-- approved by the Unit Head. SA sales from Altshops and Altboxes with no BPM mapped go to them (and they decide the BPM
-- stage) until a BPM is mapped to the location. Without a Placeholder BPM set, such sales wait unassigned.
CREATE TABLE altphones_bpm_placeholder (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  bpm_email    text NOT NULL CHECK (bpm_email = lower(btrim(bpm_email))),
  updated_by   uuid REFERENCES staff(id),
  approved_by  uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE altphones_bpm_requests DROP CONSTRAINT altphones_bpm_requests_scope_check;
ALTER TABLE altphones_bpm_requests ADD CONSTRAINT altphones_bpm_requests_scope_check CHECK (scope IN ('STATE','LOCATION','PLACEHOLDER'));
ALTER TABLE altphones_bpm_requests DROP CONSTRAINT altphones_bpm_requests_check;
ALTER TABLE altphones_bpm_requests ADD CONSTRAINT altphones_bpm_requests_target_check CHECK (
  (scope = 'STATE' AND state IS NOT NULL AND location_id IS NULL) OR (scope = 'LOCATION' AND location_id IS NOT NULL) OR (scope = 'PLACEHOLDER' AND state IS NULL AND location_id IS NULL));
CREATE UNIQUE INDEX altphones_bpm_requests_open_placeholder ON altphones_bpm_requests (scope) WHERE status = 'PENDING' AND scope = 'PLACEHOLDER';

-- A sale with the Placeholder BPM now names that person; routed_to_placeholder still marks it for re-routing.
ALTER TABLE altphones_applications DROP CONSTRAINT altphones_placeholder_or_bpm;
