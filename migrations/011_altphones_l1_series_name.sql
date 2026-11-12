-- Product name: "Altphone L1 series" (one entry per colour).
UPDATE altphones_models SET name = 'Altphone L1 Series — Black & Gold', updated_at = now() WHERE name = 'AltPhone Lesia L1 — Black & Gold';
UPDATE altphones_models SET name = 'Altphone L1 Series — Green', updated_at = now() WHERE name = 'AltPhone Lesia L1 — Green';
UPDATE altphones_models SET name = 'Altphone L1 Series — Blue', updated_at = now() WHERE name = 'AltPhone Lesia L1 — Blue';
-- Keep the name captured on applications made before the rename consistent with the catalogue.
UPDATE altphones_applications SET model_name = replace(model_name, 'AltPhone Lesia L1 — ', 'Altphone L1 Series — ') WHERE model_name LIKE 'AltPhone Lesia L1 — %';
