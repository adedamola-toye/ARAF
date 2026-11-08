-- Offer templates per applicant type, stored as DOCX (bank Word letters) or HTML.
ALTER TABLE offer_templates ADD COLUMN format text NOT NULL DEFAULT 'HTML' CHECK (format IN ('HTML','DOCX'));
ALTER TABLE offer_templates ADD COLUMN applicant_type text CHECK (applicant_type IN ('INDIVIDUAL','ENTERPRISE','LIMITED'));
ALTER TABLE offer_templates ADD COLUMN storage_key text;
ALTER TABLE offer_templates ADD COLUMN source_filename text;
ALTER TABLE offer_templates ADD COLUMN approved_by uuid REFERENCES staff(id);
ALTER TABLE offer_templates ADD COLUMN approved_at timestamptz;
ALTER TABLE offer_templates ALTER COLUMN body_html DROP NOT NULL;
ALTER TABLE offer_templates ADD CONSTRAINT offer_templates_body CHECK ((format = 'HTML' AND body_html IS NOT NULL) OR (format = 'DOCX' AND storage_key IS NOT NULL));
ALTER TABLE offer_templates DROP CONSTRAINT offer_templates_name_version_key;
ALTER TABLE offer_templates ADD CONSTRAINT offer_templates_name_type_version_key UNIQUE (name, applicant_type, version);
DROP INDEX offer_templates_one_active;
-- One active template per applicant type (NULL = fallback for all types).
CREATE UNIQUE INDEX offer_templates_one_active ON offer_templates ((coalesce(applicant_type, 'ALL'))) WHERE status = 'ACTIVE';
