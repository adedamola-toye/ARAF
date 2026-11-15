-- First-time onboarding (per user and role) and approval verification acknowledgements.

CREATE TABLE onboarding_states (
  staff_id      uuid NOT NULL REFERENCES staff(id),
  role          text NOT NULL,
  guide_version int NOT NULL,
  first_seen_at timestamptz NOT NULL,
  started_at    timestamptz,
  completed_at  timestamptz,
  skipped_at    timestamptz,
  last_step     int,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (staff_id, role)
);

-- One row per approval-related decision, written in the same transaction as the decision.
CREATE TABLE approval_verifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind      text NOT NULL CHECK (subject_kind IN ('APPLICATION','ALTPHONES','STAFF_REQUEST')),
  subject_id        uuid NOT NULL,
  subject_ref       text,
  subject_version   int NOT NULL,           -- lock version the reviewer had open
  version_id        uuid,                   -- application version (retail / WakeelBoost)
  staff_id          uuid NOT NULL REFERENCES staff(id),
  role              text NOT NULL,
  stage             text NOT NULL,
  decision          text NOT NULL,
  checklist_id      text NOT NULL,
  checklist_version int NOT NULL,
  items             jsonb NOT NULL,         -- [{code, text}] exactly as shown and acknowledged
  acknowledged_at   timestamptz NOT NULL,
  outcome           text NOT NULL,          -- resulting stage / status
  task_id           uuid
);
CREATE INDEX approval_verifications_subject_idx ON approval_verifications(subject_kind, subject_id, acknowledged_at);
CREATE FUNCTION approval_verifications_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'approval verifications cannot be changed or deleted'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER approval_verifications_append_only BEFORE UPDATE OR DELETE ON approval_verifications FOR EACH ROW EXECUTE FUNCTION approval_verifications_append_only();
