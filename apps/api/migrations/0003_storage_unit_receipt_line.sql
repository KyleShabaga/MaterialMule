-- TRP-T09: position of each storage unit within its receipt (1 = first unit submitted).
-- Lets a retried confirmation (same idempotency key) return the same clientRowId → storage unit
-- mapping as the original response, whatever the unit types. Nullable so units created before
-- this column (none in production) stay valid; every receipt confirmation sets it.

ALTER TABLE storage_unit
  ADD COLUMN receipt_line integer CHECK (receipt_line BETWEEN 1 AND 50),
  ADD CONSTRAINT storage_unit_receipt_line_key UNIQUE (receipt_id, receipt_line);
