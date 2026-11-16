-- Product Settings: drafts saved while a Super Admin edits, direct publication of product rules (with a reason and
-- an effective date), and product-level settings (owner, origination roles).
-- Published versions stay immutable (existing guard); drafts are working copies and are replaced on publication.

CREATE TABLE product_config_drafts (
  product_code    text PRIMARY KEY REFERENCES products(code),
  config          jsonb NOT NULL,
  general         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- name, description, owner, origination roles, availability
  effective_from  date,
  base_version    int,                                   -- the published version the draft started from (null: first set-up)
  source          text NOT NULL CHECK (source IN ('SUPPLIED','BLANK','VERSION','PROPOSAL')),
  source_ref      text,
  revision        int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES staff(id),
  created_at      timestamptz NOT NULL,
  updated_by      uuid NOT NULL REFERENCES staff(id),
  updated_at      timestamptz NOT NULL
);

-- How each version came about (direct publication by a Super Admin, or the earlier proposal and approval).
ALTER TABLE product_configs
  ADD COLUMN published_via    text CHECK (published_via IN ('DIRECT','APPROVAL')),
  ADD COLUMN previous_version int,
  ADD COLUMN changes          jsonb,
  ADD COLUMN restored_from    int;

ALTER TABLE products
  ADD COLUMN owner              text,
  -- Roles that may originate the product (null = every role the product type allows). Enforced server-side.
  ADD COLUMN origination_roles  text[];
