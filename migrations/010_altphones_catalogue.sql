-- Altphones catalogue from the approved AltPhone product deck (AltPhone Lesia, L1 series): one device in
-- three colours. Photos ship with the application (public/images/altphones); the Product Manager can edit
-- the entries or upload replacement photos, which then come from private object storage.
-- Synthetic demo models (development data only) are retired so the catalogue shows the real phones.

UPDATE altphones_models SET active = false, updated_at = now() WHERE name LIKE '%(synthetic)' AND active;

INSERT INTO altphones_models (name, specifications, image_key, image_mime, image_sha256, active, sort_order)
VALUES
  ('AltPhone Lesia L1 — Black & Gold',
   E'4GB RAM · 128GB storage\n6.745" HD+ display (720 × 1640)\nMediaTek G81 octa-core (2× A75 2.0GHz + 6× A55 1.8GHz)\n50MP AI camera\n5,000mAh battery · fast charging 0–50% in 45 min\nDual SIM 4G · fingerprint sensor · matte finish\nFree charger, pouch and screen guard',
   'static:altphones/altphone-l1-black-gold.webp', 'image/webp', '1531f9b4e545b1386a6dfebd9f1df6b345b0b4f9bb53293bd12eb652cfab8fce', true, 0),
  ('AltPhone Lesia L1 — Green',
   E'4GB RAM · 128GB storage\n6.745" HD+ display (720 × 1640)\nMediaTek G81 octa-core (2× A75 2.0GHz + 6× A55 1.8GHz)\n50MP AI camera\n5,000mAh battery · fast charging 0–50% in 45 min\nDual SIM 4G · fingerprint sensor · matte finish\nFree charger, pouch and screen guard',
   'static:altphones/altphone-l1-green.webp', 'image/webp', '2835b2084e84406ed29ee7da29d346064ccdedd2cc4c223f6a9ef5222f77cfa0', true, 1),
  ('AltPhone Lesia L1 — Blue',
   E'4GB RAM · 128GB storage\n6.745" HD+ display (720 × 1640)\nMediaTek G81 octa-core (2× A75 2.0GHz + 6× A55 1.8GHz)\n50MP AI camera\n5,000mAh battery · fast charging 0–50% in 45 min\nDual SIM 4G · fingerprint sensor · matte finish\nFree charger, pouch and screen guard',
   'static:altphones/altphone-l1-blue.webp', 'image/webp', 'c903de8cef552ebc0cb14cd7981ff68b3fd70cb18c1736e40f3dcde411e787f2', true, 2)
ON CONFLICT DO NOTHING;
