-- Anonymous Product Telemetry v1 daily storage (PRI-600).
-- One row per (server_daily_id, bucket_date). server_daily_id is the
-- server-side HMAC of the client's daily unlinkable ID — the client ID and
-- any cross-day deployment identity are NEVER stored.
-- Boolean milestones only: no counts, no content, no metadata columns.
-- Retention: 90 days (write-time sweep in telemetry-core.ts; Pages Functions
-- have no cron triggers).
CREATE TABLE IF NOT EXISTS product_telemetry_daily (
  server_daily_id TEXT NOT NULL,
  bucket_date TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  pd_version TEXT NOT NULL,
  host_kind TEXT NOT NULL CHECK (host_kind IN ('openclaw', 'codex', 'other')),
  initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
  pain_observed INTEGER NOT NULL CHECK (pain_observed IN (0, 1)),
  principle_observed INTEGER NOT NULL CHECK (principle_observed IN (0, 1)),
  activation_observed INTEGER NOT NULL CHECK (activation_observed IN (0, 1)),
  presence_receipt_observed INTEGER NOT NULL CHECK (presence_receipt_observed IN (0, 1)),
  effect_receipt_observed INTEGER NOT NULL CHECK (effect_receipt_observed IN (0, 1)),
  initialization_failed INTEGER NOT NULL CHECK (initialization_failed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_daily_id, bucket_date)
);
CREATE INDEX IF NOT EXISTS idx_product_telemetry_daily_bucket_date
  ON product_telemetry_daily (bucket_date);
