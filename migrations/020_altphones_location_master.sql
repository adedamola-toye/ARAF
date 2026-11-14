-- Altphones location master: registered addresses, address registration with Unit Head approval, and the BPM mapped
-- to each location. Staff select their operating location; ARAF supplies the address and the approval route.

-- Every location has a registered address, or is flagged until one is approved. The address is never typed during
-- origination; it comes from the profiling workbook or from an approved registration request.
ALTER TABLE locations
  ADD COLUMN address_status text NOT NULL DEFAULT 'MISSING' CHECK (address_status IN ('REGISTERED','MISSING','REVIEW')),
  ADD COLUMN address_source text CHECK (address_source IN ('PROFILING_WORKBOOK','REGISTRATION_REQUEST','LEGACY')),
  ADD COLUMN address_registered_at timestamptz,
  ADD COLUMN address_registered_by uuid REFERENCES staff(id);
ALTER TABLE locations ADD CONSTRAINT locations_registered_address CHECK (address_status <> 'REGISTERED' OR (address IS NOT NULL AND length(btrim(address)) >= 3));
-- Addresses already recorded before this change are kept as registered (legacy).
UPDATE locations SET address_status = 'REGISTERED', address_source = 'LEGACY' WHERE address IS NOT NULL AND length(btrim(address)) >= 3;

-- The original values from each uploaded profiling workbook, kept exactly as supplied (one row per sheet entry).
CREATE TABLE altphones_location_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref          text NOT NULL UNIQUE,
  filename     text NOT NULL,
  sha256       text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','APPLIED','DISCARDED')),
  summary      jsonb,
  created_by   uuid NOT NULL REFERENCES staff(id),
  created_at   timestamptz NOT NULL,
  applied_by   uuid REFERENCES staff(id),
  applied_at   timestamptz
);
CREATE SEQUENCE altphones_location_import_seq;

CREATE TABLE altphones_location_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       uuid NOT NULL REFERENCES altphones_location_imports(id),
  sheet           text NOT NULL,
  location_type   text NOT NULL CHECK (location_type IN ('BRANCH','ALTSHOP','ALTBOX')),
  source_state    text NOT NULL,
  source_name     text NOT NULL,
  labels          jsonb NOT NULL DEFAULT '[]', -- every original (state, name) label merged into this entry
  state           text,                      -- normalised; NULL when the state label is not recognised
  rows            int NOT NULL,              -- how many workbook rows named this location
  addresses       jsonb NOT NULL DEFAULT '[]', -- every distinct original address value, untouched
  outcome         text NOT NULL CHECK (outcome IN ('MATCHED','NEW','UNKNOWN_STATE')),
  address_outcome text NOT NULL CHECK (address_outcome IN ('REGISTERED','MISSING','CONFLICT','KEPT_EXISTING','DIFFERS_FROM_EXISTING')),
  type_conflict   text,                      -- e.g. listed as a Branch here but held as a Shop in ARAF
  location_id     uuid REFERENCES locations(id),
  UNIQUE (import_id, location_type, source_state, source_name)
);
CREATE INDEX altphones_location_sources_loc_idx ON altphones_location_sources (location_id);

-- Address registration: a proposed address (for a new location, a missing address, or a choice between conflicting
-- workbook values) needs a Unit Head who did not request it. Approval registers the address and, for a new
-- location, activates it.
CREATE SEQUENCE altphones_address_request_seq;
CREATE TABLE altphones_address_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,
  location_id   uuid NOT NULL REFERENCES locations(id),
  address       text NOT NULL CHECK (length(btrim(address)) >= 10),
  basis         text NOT NULL CHECK (basis IN ('NEW_LOCATION','MISSING_ADDRESS','CONFLICT_CHOICE','CORRECTION')),
  activate      boolean NOT NULL DEFAULT false,
  note          text,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by  uuid NOT NULL REFERENCES staff(id),
  requested_at  timestamptz NOT NULL,
  decided_by    uuid REFERENCES staff(id),
  decided_at    timestamptz,
  decision_note text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX altphones_address_requests_open ON altphones_address_requests (location_id) WHERE status = 'PENDING';

-- Business Performance Managers by state (from the profiling workbook's BPM sheet, then maintained by the PM).
-- The BPM is matched to an existing staff member by email; no staff profile is created here.
CREATE TABLE altphones_bpm_states (
  state        text PRIMARY KEY,
  bpm_email    text NOT NULL CHECK (bpm_email = lower(btrim(bpm_email))),
  source       text NOT NULL DEFAULT 'PROFILING_WORKBOOK' CHECK (source IN ('PROFILING_WORKBOOK','MANUAL')),
  updated_by   uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The BPM an SA application was routed to (from its operating location), and the address shown at origination.
ALTER TABLE altphones_applications
  ADD COLUMN routed_bpm_id uuid REFERENCES staff(id),
  ADD COLUMN origin_address text;
