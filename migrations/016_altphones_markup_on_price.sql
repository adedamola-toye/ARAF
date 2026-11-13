-- From this version, markup is charged on the full phone price (₦145,000); the ₦29,000 down payment then
-- comes off the price with markup and the balance is paid monthly. Rates unchanged. Records the change in
-- the settings history; applications whose terms are already fixed keep them.
INSERT INTO altphones_settings (version, outright_price_kobo, down_payment_kobo, tenures, markup_rates, markup_basis, score_pass_min, score_fair_min,
                                weekend_rule, short_month_rule, contract_template, unit_head_staff_id, team_email, reason, created_by, created_at)
SELECT version + 1, outright_price_kobo, down_payment_kobo, tenures, markup_rates, markup_basis, score_pass_min, score_fair_min,
       weekend_rule, short_month_rule, contract_template, unit_head_staff_id, team_email,
       'Markup charged on the full phone price, then the down payment deducted (product owner, November 2026): 3 months 8.97%, 6 months 15.1%, 12 months 23.45%.',
       NULL, now()
  FROM (SELECT * FROM altphones_settings ORDER BY version DESC LIMIT 1) s;
