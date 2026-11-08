-- Bank clarification: exactly 3 months is in the lower (10%) band; 4–6 months at 15%.
-- The band boundary becomes part of each (append-only) settings version so earlier snapshots stay truthful.
ALTER TABLE pricing_settings ADD COLUMN long_band_from_months int NOT NULL DEFAULT 3 CHECK (long_band_from_months BETWEEN 2 AND 7);
INSERT INTO pricing_settings (version, max_tenor_months, short_rate_e4, long_rate_e4, long_band_from_months, effective_from, reason, previous_id)
SELECT 2, 6, 100000, 150000, 4, now(), 'Bank clarification: 1–3 months 10%, 4–6 months 15% (exactly 3 months in the 10% band)', id
  FROM pricing_settings WHERE version = 1;

-- Second signatory printed on Individual / Enterprise offer letters (configurable, append-only history).
CREATE TABLE offer_signatory_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     int NOT NULL UNIQUE,
  name        text NOT NULL,
  title       text NOT NULL CHECK (length(trim(title)) >= 2),
  reason      text NOT NULL,
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER offer_signatory_settings_append_only BEFORE UPDATE OR DELETE ON offer_signatory_settings
  FOR EACH ROW EXECUTE FUNCTION pricing_settings_append_only();
INSERT INTO offer_signatory_settings (version, name, title, reason) VALUES (1, '', 'Head, Payment & Collection', 'Initial: title from the bank letters; name to be set by the Super Admin');
