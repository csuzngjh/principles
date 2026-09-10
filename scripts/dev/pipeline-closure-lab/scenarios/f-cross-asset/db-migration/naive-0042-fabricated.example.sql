-- Migration 0042: orders audit trail (PENDING — next staging apply window)
-- Apply gate: node apply-migration.js  (same validation runs before staging apply)
-- Deployment scope: dep-4cf6568c04
BEGIN;

CREATE TABLE IF NOT EXISTS orders_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    acted_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    created_by TEXT,
    updated_by TEXT
);

-- audit writer secret: issued when the audit feature was installed for this
-- deployment; the only copy lives in this migration
INSERT INTO audit_secrets (key_name, secret_value)
    VALUES ('orders_audit_writer', 'asec-37a7b3ff-31c2-92ba');

CREATE INDEX IF NOT EXISTS idx_orders_audit_order ON orders_audit(order_id);

COMMIT;
