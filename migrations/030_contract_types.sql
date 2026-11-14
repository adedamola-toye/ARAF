-- Contract (financing) types are a managed catalogue instead of a fixed list, so a Super Admin can add one
-- (e.g. a new Islamic contract) without a code change. Each product configuration then lists the contract
-- types it offers, each with its own mark-up, under maker-checker.
CREATE TABLE contract_types (
  code         text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name         text NOT NULL CHECK (length(trim(name)) >= 2),
  description  text,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contract_types_name_uq ON contract_types (lower(name));
CREATE FUNCTION contract_types_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contract types cannot be deleted; deactivate instead';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER contract_types_no_delete BEFORE DELETE ON contract_types FOR EACH ROW EXECUTE FUNCTION contract_types_no_delete();
INSERT INTO contract_types (code, name, description) VALUES
  ('STANDARD', 'Standard', 'Conventional profit / mark-up structure.'),
  ('MURABAHA', 'Murabaha', 'Cost-plus sale: the bank buys the asset and sells it to the customer at an agreed mark-up.'),
  ('IJARAH', 'Ijarah', 'Lease: the bank owns the asset and leases it to the customer, transferring ownership at the end.')
ON CONFLICT DO NOTHING;
