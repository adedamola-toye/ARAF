-- Affordability policy decided by the business for Vendor Financing, Alt Drive and Alt Power:
--   average monthly inflow = verified annual inflow × 100% ÷ 12; (existing obligations + new instalment) ≤ 30% of it;
--   minimum repayment period 12 months; approval chain RETAIL_CX_V1 (Team Lead → CX credit review → Unit Head → DH).
--   (WakeelBoost keeps its 10% limit and its own chain; it is configured separately.)
-- Proposed as a new configuration version built from each product's latest approved version. It takes effect only
-- when a Product Config Approver approves it (existing maker-checker). Skipped when a proposal is already open.
INSERT INTO product_configs (product_code, version, status, config, effective_from, reason, proposed_by, proposed_at)
SELECT c.product_code,
       (SELECT max(x.version) + 1 FROM product_configs x WHERE x.product_code = c.product_code),
       'PROPOSED',
       jsonb_set(
         c.config || '{"approvalPolicy":"RETAIL_CX_V1"}'::jsonb, '{profiles}',
         (SELECT jsonb_object_agg(e.k, CASE WHEN jsonb_typeof(e.v) = 'object'
                    THEN e.v || jsonb_build_object('minTenorMonths', 12,
                         'dsr', coalesce(e.v -> 'dsr', '{}'::jsonb) || '{"maxPercent":"30","denominator":"AVERAGE_MONTHLY_INFLOW_FROM_ANNUAL","inflowRecognitionPercent":"100"}'::jsonb)
                    ELSE e.v END)
            FROM jsonb_each(c.config -> 'profiles') AS e(k, v))
       ),
       now(),
       'Business decision: average monthly inflow from verified annual inflow (100% recognised), total DSR up to 30%, minimum tenor 12 months; approval chain Team Lead → CX credit review → Unit Head → Divisional Head.',
       NULL,
       now()
  FROM (SELECT DISTINCT ON (product_code) product_code, config
          FROM product_configs WHERE status = 'APPROVED' AND product_code IN ('VENDOR_FINANCING','ALT_DRIVE','ALT_POWER')
         ORDER BY product_code, effective_from DESC, version DESC) c
 WHERE NOT EXISTS (SELECT 1 FROM product_configs p WHERE p.product_code = c.product_code AND p.status = 'PROPOSED');
