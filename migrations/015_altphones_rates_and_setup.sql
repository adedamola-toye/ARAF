-- Approved Altphones markup on the ₦116,000 financed amount, total for each tenure:
-- 3 months 8.97%, 6 months 15.1%, 12 months 23.45% (percent × 10^4).
INSERT INTO altphones_settings (version, outright_price_kobo, down_payment_kobo, tenures, markup_rates, markup_basis, score_pass_min, score_fair_min,
                                weekend_rule, short_month_rule, contract_template, unit_head_staff_id, team_email, reason, created_by, created_at)
SELECT version + 1, outright_price_kobo, down_payment_kobo, tenures, '{"3": 89700, "6": 151000, "12": 234500}'::jsonb, 'FLAT_TOTAL', score_pass_min, score_fair_min,
       weekend_rule, short_month_rule, contract_template, unit_head_staff_id, team_email,
       'Approved markup rates on the financed amount, total for each tenure: 3 months 8.97%, 6 months 15.1%, 12 months 23.45% (product owner, November 2026).',
       NULL, now()
  FROM (SELECT * FROM altphones_settings ORDER BY version DESC LIMIT 1) s
 WHERE NOT (s.markup_rates = '{"3": 89700, "6": 151000, "12": 234500}'::jsonb AND s.markup_basis = 'FLAT_TOTAL');

-- Setup uploads: officers (Delight Officers and Smile Associates) and opening stock.
ALTER TABLE altphones_imports DROP CONSTRAINT IF EXISTS altphones_imports_kind_check;
ALTER TABLE altphones_imports ADD CONSTRAINT altphones_imports_kind_check CHECK (kind IN ('LOCATIONS','OFFICERS','OPENING_STOCK','TRANSACTIONS','STOCK'));

-- An officer's home location: a Delight Officer's Branch or a Smile Associate's BOX, preselected on new sales.
CREATE TABLE altphones_officer_homes (
  staff_id     uuid PRIMARY KEY REFERENCES staff(id),
  location_id  uuid NOT NULL REFERENCES locations(id),
  updated_by   uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
