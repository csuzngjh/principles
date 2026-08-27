-- Anonymous Product Telemetry v1 — tri-state facts (review remediation).
-- Rebuilds product_telemetry_daily with NULLABLE milestone/reliability
-- columns: NULL = source unavailable ("unknown"), never "observed false".
-- CHECK constraints are kept — in SQLite a CHECK passes when the expression
-- is NULL, so (col IN (0,1)) still admits NULL while rejecting other values.
-- Data-preserving table rebuild (SQLite cannot drop NOT NULL in place);
-- existing 0/1 rows keep their evaluated-false/true semantics.
CREATE TABLE product_telemetry_daily_v2 (
  server_daily_id TEXT NOT NULL,
  bucket_date TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  pd_version TEXT NOT NULL,
  host_kind TEXT NOT NULL CHECK (host_kind IN ('openclaw', 'codex', 'other')),
  initialized INTEGER CHECK (initialized IN (0, 1)),
  pain_observed INTEGER CHECK (pain_observed IN (0, 1)),
  principle_observed INTEGER CHECK (principle_observed IN (0, 1)),
  activation_observed INTEGER CHECK (activation_observed IN (0, 1)),
  presence_receipt_observed INTEGER CHECK (presence_receipt_observed IN (0, 1)),
  effect_receipt_observed INTEGER CHECK (effect_receipt_observed IN (0, 1)),
  initialization_failed INTEGER CHECK (initialization_failed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_daily_id, bucket_date)
);
INSERT INTO product_telemetry_daily_v2 SELECT * FROM product_telemetry_daily;
DROP TABLE product_telemetry_daily;
ALTER TABLE product_telemetry_daily_v2 RENAME TO product_telemetry_daily;
CREATE INDEX idx_product_telemetry_daily_bucket_date_v2
  ON product_telemetry_daily (bucket_date);
