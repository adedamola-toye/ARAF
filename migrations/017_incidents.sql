-- Incident management for genuine technical failures. One incident per correlated failure (same
-- fingerprint within the correlation window); every affected user is assigned one of the five approved
-- messages with a balanced, shuffled allocation. No customer data is stored here: fingerprints and
-- diagnostics are built from sanitised error metadata only.
CREATE SEQUENCE incident_ref_seq;

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,                  -- ARAF-2026-0042
  fingerprint      text NOT NULL,
  category         text NOT NULL,                         -- RENDER, ACTION, API, CLIENT, NETWORK, DATABASE, INTEGRATION
  module           text NOT NULL,                         -- e.g. "Financing origination"
  severity         text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status           text NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','INVESTIGATING','RESOLVED','CLOSED')),
  message_order    smallint[] NOT NULL,                   -- per-incident shuffle of 1..5
  message_counts   integer[] NOT NULL DEFAULT '{0,0,0,0,0}',
  affected_users   integer NOT NULL DEFAULT 0,
  occurrences      integer NOT NULL DEFAULT 0,
  diagnostics      jsonb NOT NULL DEFAULT '{}',
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  routed_at        timestamptz,                           -- alert delivered to the team's queue
  alerted_severity text,                                  -- highest severity already alerted (dedupe)
  acknowledged_by  uuid REFERENCES staff(id),
  acknowledged_at  timestamptz,
  resolved_by      uuid REFERENCES staff(id),
  resolved_at      timestamptz,
  resolution_note  text,
  closed_at        timestamptz,
  CHECK (array_length(message_order, 1) = 5 AND array_length(message_counts, 1) = 5),
  CHECK (status NOT IN ('RESOLVED','CLOSED') OR resolved_at IS NOT NULL)
);
-- At most one open incident per fingerprint: correlation never splits one failure into two.
CREATE UNIQUE INDEX incidents_open_fp_idx ON incidents(fingerprint) WHERE status IN ('DETECTED','INVESTIGATING');
CREATE INDEX incidents_status_idx ON incidents(status, last_seen_at DESC);

-- One message per affected user per incident, stable across refreshes, retries and sessions.
CREATE TABLE incident_assignments (
  incident_id  uuid NOT NULL REFERENCES incidents(id),
  subject      text NOT NULL,                           -- 'staff:<uuid>' or 'anon:<hash>'
  seq          integer NOT NULL,                        -- 0-based order of assignment
  message_no   smallint NOT NULL CHECK (message_no BETWEEN 1 AND 5),
  assigned_at  timestamptz NOT NULL,
  PRIMARY KEY (incident_id, subject),
  UNIQUE (incident_id, seq)
);

-- Next.js error digests seen by the browser, mapped to the incident recorded on the server.
CREATE TABLE incident_digests (
  digest       text PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES incidents(id),
  created_at   timestamptz NOT NULL
);
CREATE INDEX incident_digests_created_idx ON incident_digests(created_at);
