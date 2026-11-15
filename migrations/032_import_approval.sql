-- Altphones setup imports: Upload → Validate → Preview → Submit → Unit Head approves (commit) or rejects.
-- Officer (DO / SA) uploads are retired: the kind stays allowed only so historical rows remain valid.
ALTER TABLE altphones_imports DROP CONSTRAINT IF EXISTS altphones_imports_status_check;
ALTER TABLE altphones_imports ADD CONSTRAINT altphones_imports_status_check CHECK (status IN ('PREVIEW','SUBMITTED','COMMITTED','REJECTED','DISCARDED'));
ALTER TABLE altphones_imports
  ADD COLUMN submitted_by uuid REFERENCES staff(id),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN partial boolean NOT NULL DEFAULT false,
  ADD COLUMN submit_note text,
  ADD COLUMN decided_by uuid REFERENCES staff(id),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_note text,
  ADD COLUMN skipped_invalid int NOT NULL DEFAULT 0;
-- At most one import of the same file can be waiting for approval.
CREATE UNIQUE INDEX altphones_imports_submitted_uq ON altphones_imports(kind, sha256) WHERE status = 'SUBMITTED';
