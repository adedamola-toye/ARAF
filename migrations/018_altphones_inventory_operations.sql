-- Altphones operations, phase 1: locations keep their source labels, register labels map to locations,
-- colour-agnostic stock (a stock pool), and approved stock counts.

-- Original labels as supplied (the operating name/state/type may be normalised or reclassified).
ALTER TABLE locations
  ADD COLUMN source_name  text,
  ADD COLUMN source_state text,
  ADD COLUMN source_type  text;

-- Free-text location labels used in registers and reports (e.g. "MARARABA", "IBRAHIM TAIWO") → a location.
CREATE TABLE altphones_location_aliases (
  label        text PRIMARY KEY CHECK (label = upper(btrim(label)) AND length(label) >= 2),
  location_id  uuid NOT NULL REFERENCES locations(id),
  created_by   uuid REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Colour-agnostic stock: units counted without a colour sit in one pool model, never sold in the catalogue
-- itself; a sale of any L1 colour takes its own colour first, then a pool unit at the same location.
ALTER TABLE altphones_models ADD COLUMN stock_pool boolean NOT NULL DEFAULT false;
ALTER TABLE altphones_models ADD CONSTRAINT altphones_pool_not_sold CHECK (NOT (stock_pool AND active));
CREATE UNIQUE INDEX altphones_models_one_pool ON altphones_models (stock_pool) WHERE stock_pool;
INSERT INTO altphones_models (name, specifications, active, sort_order, stock_pool)
VALUES ('Altphone L1 Series — colour not recorded', 'Units counted without a colour. Issued as the colour the customer chose.', false, 99, true)
ON CONFLICT DO NOTHING;

-- Which balance a reservation was taken from (the chosen colour, or the pool). NULL = the chosen model.
ALTER TABLE altphones_applications ADD COLUMN stock_model_id uuid REFERENCES altphones_models(id);

-- Approved physical counts. A count records what was found per location and model; on approval the
-- difference to the ledger is posted as a COUNT_ADJUSTMENT. The counter cannot approve their own count.
ALTER TABLE altphones_stock_ledger DROP CONSTRAINT IF EXISTS altphones_stock_ledger_movement_check;
ALTER TABLE altphones_stock_ledger ADD CONSTRAINT altphones_stock_ledger_movement_check
  CHECK (movement IN ('OPENING','RECEIPT','RESERVE','RELEASE','SALE','DISBURSEMENT','LEGACY_ADJUSTMENT','COUNT_ADJUSTMENT'));

CREATE TABLE altphones_stock_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,
  location_id   uuid NOT NULL REFERENCES locations(id),
  status        text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  counted_on    date NOT NULL,
  note          text,
  submitted_by  uuid NOT NULL REFERENCES staff(id),
  submitted_at  timestamptz NOT NULL,
  decided_by    uuid REFERENCES staff(id),
  decided_at    timestamptz,
  decision_note text,
  CHECK (decided_by IS NULL OR decided_by <> submitted_by)
);
CREATE INDEX altphones_stock_counts_status_idx ON altphones_stock_counts (status, submitted_at DESC);
CREATE UNIQUE INDEX altphones_stock_counts_open_uq ON altphones_stock_counts (location_id) WHERE status = 'SUBMITTED';

CREATE TABLE altphones_stock_count_lines (
  count_id      uuid NOT NULL REFERENCES altphones_stock_counts(id),
  model_id      uuid NOT NULL REFERENCES altphones_models(id),
  counted       int NOT NULL CHECK (counted >= 0),
  system_at_submit int NOT NULL,
  PRIMARY KEY (count_id, model_id)
);

CREATE SEQUENCE altphones_stock_count_seq;
