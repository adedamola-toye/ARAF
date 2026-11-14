-- Versioned approval policy, pinned on each application at first submission. Applications submitted before this
-- change keep STANDARD (their existing chain). RETAIL_CX_V1 (Vendor Financing, Alt Drive, Alt Power):
--   initiator → Team Lead certification → CX credit review → Unit Head → Divisional Head → existing post-approval.
-- Team Leads and Unit Heads may originate retail requests; they never review their own (routing rules in code,
-- every skipped or substituted stage is recorded in the audit trail with its rule and reason).
ALTER TABLE applications ADD COLUMN approval_policy text NOT NULL DEFAULT 'STANDARD' CHECK (approval_policy IN ('STANDARD','RETAIL_CX_V1'));
ALTER TABLE applications DROP CONSTRAINT applications_initiator_role_check;
ALTER TABLE applications ADD CONSTRAINT applications_initiator_role_check CHECK (initiator_role IN ('RM','ANM','MERCHANT_OFFICER','DELIGHT_OFFICER','TEAM_LEAD','UNIT_HEAD'));
