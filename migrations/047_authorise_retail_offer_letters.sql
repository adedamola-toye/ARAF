-- The business owner authorised (17 Nov 2026) prefilled offer letters for Alt Drive (Murabaha and Ijarah), Alt Power
-- (Murabaha and Ijarah) and Vendor Financing (Murabaha), generated and sent to the customer with the other closing
-- documents on final approval. Alt Power and Vendor Financing requests configured with the "Standard" structure use the
-- Murabaha letter. Letters the bank has since edited are left as they are; missing ones are created, approved.

UPDATE offer_templates SET body_html = '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', production_approved = true, approved_at = now(), notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).'
 WHERE status = 'ACTIVE' AND product_code = 'ALT_DRIVE' AND structure = 'MURABAHA' AND body_html LIKE '%DRAFT WORDING%';
INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, approved_at, notes, activated_at)
SELECT 'ALT DRIVE MURABAHA offer', COALESCE((SELECT max(version) FROM offer_templates WHERE name = 'ALT DRIVE MURABAHA offer'), 0) + 1, 'HTML', 'ALT_DRIVE', 'MURABAHA', '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', 'ACTIVE', true, now(), 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).', now()
 WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE status = 'ACTIVE' AND product_code = 'ALT_DRIVE' AND structure = 'MURABAHA');
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND product_code = 'ALT_DRIVE' AND structure = 'MURABAHA' AND NOT production_approved;

UPDATE offer_templates SET body_html = '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Ijarah) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Ijarah (lease) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', production_approved = true, approved_at = now(), notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).'
 WHERE status = 'ACTIVE' AND product_code = 'ALT_DRIVE' AND structure = 'IJARAH' AND body_html LIKE '%DRAFT WORDING%';
INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, approved_at, notes, activated_at)
SELECT 'ALT DRIVE IJARAH offer', COALESCE((SELECT max(version) FROM offer_templates WHERE name = 'ALT DRIVE IJARAH offer'), 0) + 1, 'HTML', 'ALT_DRIVE', 'IJARAH', '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Ijarah) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Ijarah (lease) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', 'ACTIVE', true, now(), 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).', now()
 WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE status = 'ACTIVE' AND product_code = 'ALT_DRIVE' AND structure = 'IJARAH');
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND product_code = 'ALT_DRIVE' AND structure = 'IJARAH' AND NOT production_approved;

UPDATE offer_templates SET body_html = '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', production_approved = true, approved_at = now(), notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).'
 WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'MURABAHA' AND body_html LIKE '%DRAFT WORDING%';
INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, approved_at, notes, activated_at)
SELECT 'ALT POWER MURABAHA offer', COALESCE((SELECT max(version) FROM offer_templates WHERE name = 'ALT POWER MURABAHA offer'), 0) + 1, 'HTML', 'ALT_POWER', 'MURABAHA', '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', 'ACTIVE', true, now(), 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).', now()
 WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'MURABAHA');
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'MURABAHA' AND NOT production_approved;

UPDATE offer_templates SET body_html = '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Ijarah) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Ijarah (lease) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', production_approved = true, approved_at = now(), notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).'
 WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'IJARAH' AND body_html LIKE '%DRAFT WORDING%';
INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, approved_at, notes, activated_at)
SELECT 'ALT POWER IJARAH offer', COALESCE((SELECT max(version) FROM offer_templates WHERE name = 'ALT POWER IJARAH offer'), 0) + 1, 'HTML', 'ALT_POWER', 'IJARAH', '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Ijarah) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Ijarah (lease) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', 'ACTIVE', true, now(), 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).', now()
 WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'IJARAH');
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'IJARAH' AND NOT production_approved;

UPDATE offer_templates SET body_html = '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', production_approved = true, approved_at = now(), notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).'
 WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'STANDARD' AND body_html LIKE '%DRAFT WORDING%';
INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, approved_at, notes, activated_at)
SELECT 'ALT POWER STANDARD offer', COALESCE((SELECT max(version) FROM offer_templates WHERE name = 'ALT POWER STANDARD offer'), 0) + 1, 'HTML', 'ALT_POWER', 'STANDARD', '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', 'ACTIVE', true, now(), 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).', now()
 WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'STANDARD');
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND product_code = 'ALT_POWER' AND structure = 'STANDARD' AND NOT production_approved;

UPDATE offer_templates SET body_html = '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', production_approved = true, approved_at = now(), notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).'
 WHERE status = 'ACTIVE' AND product_code = 'VENDOR_FINANCING' AND structure = 'MURABAHA' AND body_html LIKE '%DRAFT WORDING%';
INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, approved_at, notes, activated_at)
SELECT 'VENDOR FINANCING MURABAHA offer', COALESCE((SELECT max(version) FROM offer_templates WHERE name = 'VENDOR FINANCING MURABAHA offer'), 0) + 1, 'HTML', 'VENDOR_FINANCING', 'MURABAHA', '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', 'ACTIVE', true, now(), 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).', now()
 WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE status = 'ACTIVE' AND product_code = 'VENDOR_FINANCING' AND structure = 'MURABAHA');
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND product_code = 'VENDOR_FINANCING' AND structure = 'MURABAHA' AND NOT production_approved;

UPDATE offer_templates SET body_html = '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', production_approved = true, approved_at = now(), notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).'
 WHERE status = 'ACTIVE' AND product_code = 'VENDOR_FINANCING' AND structure = 'STANDARD' AND body_html LIKE '%DRAFT WORDING%';
INSERT INTO offer_templates (name, version, format, product_code, structure, body_html, status, production_approved, approved_at, notes, activated_at)
SELECT 'VENDOR FINANCING STANDARD offer', COALESCE((SELECT max(version) FROM offer_templates WHERE name = 'VENDOR FINANCING STANDARD offer'), 0) + 1, 'HTML', 'VENDOR_FINANCING', 'STANDARD', '<h1>Offer of {{product}} facility</h1>
<p>Reference: {{ref}} · Date: {{offer_date}}</p>
<p>To: <strong>{{customer_name}}</strong>, {{customer_address}}</p>
<p>We are pleased to offer you a {{product}} facility (Murabaha) on the terms below, subject to the bank''s standard terms and the conditions of this letter.</p>
<table>
<tr><th>Principal</th><td>{{principal}}</td></tr>
<tr><th>Profit rate</th><td>{{rate}}</td></tr>
<tr><th>Tenor</th><td>{{tenor}} months</td></tr>
<tr><th>Total amount payable</th><td>{{total_payable}}</td></tr>
<tr><th>Monthly repayment</th><td>{{monthly_repayment}}</td></tr>
<tr><th>Insurance</th><td>{{insurance_responsibility}}</td></tr>
<tr><th>Vendor / beneficiary</th><td>{{vendor_name}}, {{beneficiary_bank}} {{beneficiary_account}} ({{beneficiary_account_name}})</td></tr>
</table>
<p>Repayment schedule: {{schedule}}</p>
<p>Assessment snapshot {{assessment_id}} (configuration v{{config_version}}).</p>
<p>By signing below, the customer accepts this offer and the terms of the Murabaha (cost-plus sale) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>', 'ACTIVE', true, now(), 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 047).', now()
 WHERE NOT EXISTS (SELECT 1 FROM offer_templates WHERE status = 'ACTIVE' AND product_code = 'VENDOR_FINANCING' AND structure = 'STANDARD');
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND product_code = 'VENDOR_FINANCING' AND structure = 'STANDARD' AND NOT production_approved;

INSERT INTO audit_events (occurred_at, actor_role, action, outcome, reason, details)
SELECT now(), 'SYSTEM', 'TEMPLATE_AUTHORISED', 'SUCCESS', 'Business owner authorised prefilled Murabaha and Ijarah offer letters (17 Nov 2026).',
       jsonb_build_object('templateId', id, 'name', name, 'version', version, 'source', 'migration 047')
  FROM offer_templates WHERE status = 'ACTIVE' AND product_code IN ('ALT_DRIVE','ALT_POWER','VENDOR_FINANCING');

-- Closing documents e-mailed to the customer (offer letter, GSI mandate, Remita set-up sheet).
ALTER TABLE document_generation ADD COLUMN customer_sent_at timestamptz;
