-- Account name enquiry for Altphones credit customers (Paystack Resolve Account Number).
ALTER TABLE altphones_applications
  ADD COLUMN external_bank_code     text,
  ADD COLUMN external_account_name  text,
  ADD COLUMN ab_account_name        text,
  ADD COLUMN accounts_verified_via  text CHECK (accounts_verified_via IN ('PAYSTACK','OFFICER'));
