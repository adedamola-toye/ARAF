-- Super Admin on/off switches for screens that depend on things not yet in place. Every change is audited.
CREATE TABLE feature_switches (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  note        text,
  updated_by  uuid REFERENCES staff(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- The repayment / PDO tracker reads manual entries only while core banking is not connected, so it starts hidden.
INSERT INTO feature_switches (key, label, enabled, note) VALUES
  ('REPAYMENT_TRACKER', 'Repayment and PDO tracker', false, 'Hidden until core banking is connected or the business decides to use manual repayment entries.')
ON CONFLICT DO NOTHING;
