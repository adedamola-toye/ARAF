-- Second signatory on Individual / Enterprise offer letters, confirmed by the bank.
INSERT INTO offer_signatory_settings (version, name, title, reason)
SELECT coalesce(max(version), 0) + 1, 'Omoseni Ademowo', 'Head, Payment & Collection', 'Confirmed by the bank as second signatory for Individual and Enterprise offer letters'
  FROM offer_signatory_settings;
