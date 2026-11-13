-- SeedFi Loan Engine integration (API documentation v2.0, April 2026): Seed Score inputs and results.
ALTER TABLE altphones_applications
  ADD COLUMN customer_first_name   text,
  ADD COLUMN customer_last_name    text,
  ADD COLUMN customer_dob          date,
  ADD COLUMN customer_gender       text CHECK (customer_gender IN ('male','female')),
  ADD COLUMN seedfi_customer_id    text,
  ADD COLUMN seedfi_overall_score  numeric(10,2),
  ADD COLUMN seedfi_has_history    boolean,
  ADD COLUMN seedfi_details        jsonb;

-- SeedFi's documented decision bands: Approved 620–800 (Pass), Manual Review 530–619 (Fair), Declined below 530 (Fail).
-- Recorded only where no bands are configured yet; a Super Admin can change them as a new settings version.
INSERT INTO altphones_settings (version, outright_price_kobo, down_payment_kobo, tenures, markup_rates, markup_basis, score_pass_min, score_fair_min,
                                weekend_rule, short_month_rule, contract_template, unit_head_staff_id, team_email, reason, created_by, created_at)
SELECT version + 1, outright_price_kobo, down_payment_kobo, tenures, markup_rates, markup_basis, 620, 530,
       weekend_rule, short_month_rule, contract_template, unit_head_staff_id, team_email,
       'Seed Score decision bands from the SeedFi Loan Engine API documentation v2.0 (April 2026): Approved 620–800 = Pass, Manual Review 530–619 = Fair, Declined below 530 = Fail. Confirm against the approved credit policy.',
       NULL, now()
  FROM (SELECT * FROM altphones_settings ORDER BY version DESC LIMIT 1) s
 WHERE s.score_pass_min IS NULL AND s.score_fair_min IS NULL;
