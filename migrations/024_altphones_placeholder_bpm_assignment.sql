-- The Placeholder BPM named by the business owner: SA sales from Altshops and Altboxes not mapped to a BPM go to this
-- person, who decides the BPM stage before the Product Manager. Later changes go through the PM request / Unit Head
-- approval. The person must exist in ARAF as active staff with the Business Performance Manager role; until then such
-- sales wait unassigned and the Locations screen says so.
INSERT INTO altphones_bpm_placeholder (id, bpm_email, updated_at) VALUES (true, 'bugi.gewa@altbank.ng', now()) ON CONFLICT (id) DO NOTHING;
