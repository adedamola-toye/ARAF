-- Performance targets (maker-checker, never edited in place) and the once-a-day performance summary.
CREATE TABLE performance_targets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type     text NOT NULL CHECK (scope_type IN ('STAFF','TEAM')),
  staff_id       uuid REFERENCES staff(id),
  team           text,
  metric         text NOT NULL CHECK (metric IN ('DISBURSED_VALUE','DISBURSED_COUNT')),
  period_month   date NOT NULL CHECK (extract(day FROM period_month) = 1),
  target_value   bigint NOT NULL CHECK (target_value > 0),   -- kobo for DISBURSED_VALUE, a count otherwise
  status         text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','WITHDRAWN','SUPERSEDED')),
  reason         text NOT NULL CHECK (length(trim(reason)) >= 3),
  proposed_by    uuid NOT NULL REFERENCES staff(id),
  proposed_at    timestamptz NOT NULL,
  decided_by     uuid REFERENCES staff(id),
  decided_at     timestamptz,
  decision_note  text,
  superseded_by  uuid REFERENCES performance_targets(id),
  CHECK ((scope_type = 'STAFF' AND staff_id IS NOT NULL AND team IS NULL) OR (scope_type = 'TEAM' AND team IS NOT NULL AND staff_id IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
CREATE INDEX performance_targets_lookup ON performance_targets(period_month, metric, scope_type) WHERE status = 'APPROVED';
-- At most one approved target per scope, metric and month (an approved replacement supersedes the previous one).
CREATE UNIQUE INDEX performance_targets_one_approved ON performance_targets(scope_type, coalesce(staff_id::text, team), metric, period_month) WHERE status = 'APPROVED';

CREATE FUNCTION performance_targets_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'performance_targets cannot be deleted'; END IF;
  IF NEW.scope_type IS DISTINCT FROM OLD.scope_type OR NEW.staff_id IS DISTINCT FROM OLD.staff_id OR NEW.team IS DISTINCT FROM OLD.team
     OR NEW.metric IS DISTINCT FROM OLD.metric OR NEW.period_month IS DISTINCT FROM OLD.period_month OR NEW.target_value IS DISTINCT FROM OLD.target_value
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
    RAISE EXCEPTION 'a target proposal cannot be edited; propose a replacement';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER performance_targets_guard BEFORE UPDATE OR DELETE ON performance_targets FOR EACH ROW EXECUTE FUNCTION performance_targets_guard();

-- One row per person per Lagos day once they have seen (and closed) the daily performance summary.
CREATE TABLE performance_summary_views (
  staff_id     uuid NOT NULL REFERENCES staff(id),
  lagos_day    date NOT NULL,
  seen_at      timestamptz NOT NULL,
  PRIMARY KEY (staff_id, lagos_day)
);
