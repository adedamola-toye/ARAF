-- Inventory movements beyond sales: transfers between locations, returns into stock, damaged write-offs and
-- approved adjustments. Each is requested by the Product Manager (or a Super Admin) and posted to the ledger
-- only when the Altphones Unit Head (a different person) approves it.
ALTER TABLE altphones_stock_ledger DROP CONSTRAINT IF EXISTS altphones_stock_ledger_movement_check;
ALTER TABLE altphones_stock_ledger ADD CONSTRAINT altphones_stock_ledger_movement_check
  CHECK (movement IN ('OPENING','RECEIPT','RESERVE','RELEASE','SALE','DISBURSEMENT','LEGACY_ADJUSTMENT','COUNT_ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN','RETURN','DAMAGED','ADJUSTMENT'));
ALTER TABLE altphones_devices DROP CONSTRAINT IF EXISTS altphones_devices_status_check;
ALTER TABLE altphones_devices ADD CONSTRAINT altphones_devices_status_check CHECK (status IN ('IN_STOCK','RESERVED','ISSUED','DAMAGED'));

CREATE SEQUENCE IF NOT EXISTS altphones_stock_movement_seq;
CREATE TABLE altphones_stock_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('TRANSFER','RETURN','DAMAGED','ADJUSTMENT')),
  location_id      uuid NOT NULL REFERENCES locations(id),
  to_location_id   uuid REFERENCES locations(id),
  model_id         uuid NOT NULL REFERENCES altphones_models(id),
  quantity         int NOT NULL CHECK (quantity <> 0 AND abs(quantity) <= 10000),
  imeis            text[] NOT NULL DEFAULT '{}',
  note             text NOT NULL CHECK (length(btrim(note)) >= 5),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by     uuid NOT NULL REFERENCES staff(id),
  requested_at     timestamptz NOT NULL,
  decided_by       uuid REFERENCES staff(id),
  decided_at       timestamptz,
  decision_note    text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((kind = 'TRANSFER') = (to_location_id IS NOT NULL)),
  CHECK (kind = 'ADJUSTMENT' OR quantity > 0),
  CHECK (to_location_id IS NULL OR to_location_id <> location_id)
);
CREATE INDEX altphones_stock_movements_pending ON altphones_stock_movements(status, requested_at);
