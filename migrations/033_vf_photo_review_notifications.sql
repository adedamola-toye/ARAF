-- Vendor Financing: Team Lead business photograph verification (upload from gallery/files, or skip with a
-- reason), the Super Admin switch that governs it, and an in-app notification centre.

-- Switch changes carry a reason (shown in the audit trail).
INSERT INTO feature_switches (key, label, enabled, note) VALUES
  ('VF_TL_PHOTO_REVIEW', 'Vendor Financing Business Photograph Review', false,
   'At RM Team Lead review of Vendor Financing: upload an existing business photograph or skip with a reason; skips notify the Unit Head.')
ON CONFLICT DO NOTHING;

-- One row each time an RM-originated Vendor Financing request enters Team Lead review. `required` is the
-- switch value at that moment (snapshot), so a later change never alters a review already in progress.
CREATE TABLE vf_photo_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  required       boolean NOT NULL,
  entered_at     timestamptz NOT NULL,
  decision       text CHECK (decision IN ('UPLOADED','SKIPPED')),
  document_id    uuid REFERENCES documents(id),
  confirmed      boolean NOT NULL DEFAULT false,
  skip_reason    text,
  decided_by     uuid REFERENCES staff(id),
  decided_at     timestamptz,
  superseded_at  timestamptz,
  CHECK (decision IS NULL OR decided_by IS NOT NULL),
  CHECK (decision <> 'SKIPPED' OR length(trim(skip_reason)) >= 10),
  CHECK (decision <> 'UPLOADED' OR (document_id IS NOT NULL AND confirmed))
);
CREATE UNIQUE INDEX vf_photo_reviews_open_uq ON vf_photo_reviews(application_id) WHERE superseded_at IS NULL;
-- Decisions are never edited or removed (a new review cycle supersedes the row instead).
CREATE FUNCTION vf_photo_reviews_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'photo reviews cannot be deleted'; END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.skip_reason IS DISTINCT FROM OLD.skip_reason OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.decided_by IS DISTINCT FROM OLD.decided_by) THEN
    RAISE EXCEPTION 'a recorded photo decision cannot be changed';
  END IF;
  IF NEW.required IS DISTINCT FROM OLD.required THEN RAISE EXCEPTION 'the photo requirement snapshot cannot be changed'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER vf_photo_reviews_guard BEFORE UPDATE OR DELETE ON vf_photo_reviews FOR EACH ROW EXECUTE FUNCTION vf_photo_reviews_guard();

-- In-app notification centre.
CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id   uuid NOT NULL REFERENCES staff(id),
  kind           text NOT NULL,
  title          text NOT NULL,
  body           text NOT NULL,
  application_id uuid REFERENCES applications(id),
  link           text,
  dedupe_key     text NOT NULL,
  created_at     timestamptz NOT NULL,
  read_at        timestamptz,
  UNIQUE (recipient_id, dedupe_key)
);
CREATE INDEX notifications_unread_idx ON notifications(recipient_id, created_at DESC) WHERE read_at IS NULL;
