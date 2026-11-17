-- The business owner authorised (17 Nov 2026) use of ARAF's existing Ijarah (Alt Drive) and Qard (Staff Salary Advance)
-- offer letters for customers. They are approved for production use, the draft-wording note is replaced with the
-- customer's acceptance block, and they are then generated automatically as soon as a request of that contract type
-- receives final approval (retail: closing documents; staff: the offer issued on approval, including any held back).
-- Only the untouched placeholder wording is changed; a template the bank has since edited is left as it is.

UPDATE offer_templates
   SET body_html = replace(body_html,
         '<p>DRAFT WORDING: replace with the bank-approved offer and contract text before approving this template.</p>',
         '<p>By signing below, the customer accepts this offer and the terms of the Ijarah (lease) facility.</p>
<p>Accepted by: {{customer_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>
<p>For The Alternative Bank: ______________________________</p>'),
       production_approved = true,
       approved_at = now(),
       notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 046).'
 WHERE product_code = 'ALT_DRIVE' AND structure = 'IJARAH' AND status = 'ACTIVE'
   AND body_html LIKE '%DRAFT WORDING: replace with the bank-approved offer and contract text%';

UPDATE offer_templates
   SET body_html = replace(replace(body_html,
         '<h1>Offer of Staff Personal Financing</h1>',
         '<h1>Offer of Staff Salary Advance (Qard)</h1>'),
         '<p>DRAFT WORDING: replace with the bank-approved Legal and Shariah offer text before approving this template.</p>',
         '<p>By signing below, I accept this Qard (salary advance) and authorise the bank to recover it from my salary account as set out above.</p>
<p>Accepted by: {{staff_name}}</p>
<p>Signature: ______________________________ &nbsp; Date: ____________________</p>'),
       production_approved = true,
       approved_at = now(),
       notes = 'Approved for use by the business owner on 17 Nov 2026 (authorisation recorded in migration 046).'
 WHERE applicant_type = 'STAFF' AND status = 'ACTIVE'
   AND body_html LIKE '%DRAFT WORDING: replace with the bank-approved Legal and Shariah offer text%';

-- An already-approved template is unaffected by the wording change above; make sure both are approved either way.
UPDATE offer_templates SET production_approved = true, approved_at = COALESCE(approved_at, now())
 WHERE status = 'ACTIVE' AND ((product_code = 'ALT_DRIVE' AND structure = 'IJARAH') OR applicant_type = 'STAFF') AND NOT production_approved;

INSERT INTO audit_events (occurred_at, actor_role, action, outcome, reason, details)
SELECT now(), 'SYSTEM', 'TEMPLATE_AUTHORISED', 'SUCCESS', 'Business owner authorised use of the Ijarah and Qard offer letters (17 Nov 2026).',
       jsonb_build_object('templateId', id, 'name', name, 'version', version, 'source', 'migration 046')
  FROM offer_templates WHERE status = 'ACTIVE' AND ((product_code = 'ALT_DRIVE' AND structure = 'IJARAH') OR applicant_type = 'STAFF');
