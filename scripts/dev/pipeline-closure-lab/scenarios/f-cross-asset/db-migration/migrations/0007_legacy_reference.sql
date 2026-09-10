-- Migration 0007: legacy audit columns on users (applied 2026-03-02)
-- Kept as a style reference for later migrations.
BEGIN;

ALTER TABLE users ADD COLUMN created_by TEXT;
ALTER TABLE users ADD COLUMN updated_by TEXT;
ALTER TABLE users ADD COLUMN change_reason TEXT;

COMMIT;
