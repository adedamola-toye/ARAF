-- WakeelBoost flat-markup pricing and DSR settings (append-only, effective-dated).
CREATE TABLE pricing_settings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version          int NOT NULL UNIQUE,
  max_tenor_months int NOT NULL CHECK (max_tenor_months BETWEEN 1 AND 6),
  short_rate_e4    int NOT NULL CHECK (short_rate_e4 > 0 AND short_rate_e4 <= 1000000),  -- percent × 10^4, tenor 1–2 months
  long_rate_e4     int NOT NULL CHECK (long_rate_e4 > 0 AND long_rate_e4 <= 1000000),   -- percent × 10^4, tenor 3+ months
  threshold_e4     int NOT NULL DEFAULT 100000 CHECK (threshold_e4 = 100000),            -- 10% obligation threshold
  effective_from   timestamptz NOT NULL,
  reason           text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by       uuid REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  previous_id      uuid REFERENCES pricing_settings(id)
);
CREATE INDEX pricing_settings_effective_idx ON pricing_settings(effective_from DESC, version DESC);
CREATE FUNCTION pricing_settings_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pricing_settings is append-only: add a new version instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pricing_settings_append_only BEFORE UPDATE OR DELETE ON pricing_settings
  FOR EACH ROW EXECUTE FUNCTION pricing_settings_append_only();

INSERT INTO pricing_settings (version, max_tenor_months, short_rate_e4, long_rate_e4, effective_from, reason)
VALUES (1, 6, 100000, 150000, '2020-01-01T00:00:00Z', 'Initial WakeelBoost pricing schedule: 1–2 months 10%, 3–6 months 15%');

ALTER TABLE credit_assessments ADD COLUMN threshold_result text CHECK (threshold_result IN ('WITHIN_THRESHOLD','EXCEEDS_THRESHOLD'));
ALTER TABLE credit_assessments ADD COLUMN pricing_settings_id uuid REFERENCES pricing_settings(id);
