-- Approval Workflow Management: versioned, append-only workflow definitions per product, published directly by
-- a Super Admin with a mandatory reason. Each request records the version it was submitted under; requests
-- submitted before this migration have no version and keep the routing that was in force (identical to version 1).

CREATE TABLE approval_workflows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code     text NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  definition       jsonb NOT NULL,
  previous_id      uuid REFERENCES approval_workflows(id),
  previous_definition jsonb,
  changes          jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason           text NOT NULL,
  published_by     uuid REFERENCES staff(id),
  published_role   text,
  published_at     timestamptz NOT NULL,
  restored_from_id uuid REFERENCES approval_workflows(id),
  UNIQUE (product_code, version)
);
CREATE INDEX approval_workflows_latest_idx ON approval_workflows(product_code, version DESC);

CREATE FUNCTION approval_workflows_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'approval workflow versions cannot be changed or deleted'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approval_workflows_append_only BEFORE UPDATE OR DELETE ON approval_workflows FOR EACH ROW EXECUTE FUNCTION approval_workflows_append_only();

ALTER TABLE applications ADD COLUMN workflow_version_id uuid REFERENCES approval_workflows(id);
