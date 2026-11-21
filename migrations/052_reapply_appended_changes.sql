-- Repairs databases that applied migrations 045/047 before those files were extended.
-- The original runner records a file as applied by name, so statements appended to an already-applied
-- migration never run there. Every statement below is idempotent and safe on databases that already have them.

-- From migration 045 (platform completion, parts 2 and 4).
ALTER TABLE documents ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS repayment_account jsonb;
ALTER TABLE document_settings ADD COLUMN IF NOT EXISTS remita_beneficiary_phone text;
CREATE TABLE IF NOT EXISTS closing_checklists (
  product_code text PRIMARY KEY,                 -- product code, or 'WAKEELBOOST'
  items        jsonb NOT NULL,                   -- [{code, required}]
  updated_by   uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- From migration 047 (customer e-mails of closing documents, off by default).
ALTER TABLE document_generation ADD COLUMN IF NOT EXISTS customer_sent_at timestamptz;
ALTER TABLE document_settings ADD COLUMN IF NOT EXISTS customer_email_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE document_settings ADD COLUMN IF NOT EXISTS customer_email_enabled_at timestamptz;
