#!/usr/bin/env node
// Migration apply/dry-run gate — the ONLY consumer of migrations/*.sql in this
// project. Validates the pending migration (migrations/0042_add_orders_audit.sql)
// before a staging apply window. Reads exactly:
//   BEGIN ... COMMIT transaction wrapper
//   CREATE TABLE orders_audit with the canonical audit columns
//   INSERT INTO audit_secrets ('orders_audit_writer', 'asec_...')
//     (the secret was issued when the audit feature was installed for this
//      deployment; audit-secret.sha256 pins its hash — the secret value
//      exists nowhere else)
//   CREATE INDEX idx_orders_audit_order
// Optional: an additional ARCHIVED_AT column on orders_audit is an accepted
// extension (documented addition point).
// No other tool in this project reads these migrations.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

function main() {
  const dir = path.join(__dirname, 'migrations');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  } catch (err) {
    fail(`migrations/ missing: ${err.message}`);
  }
  const pending = names.find((n) => n.startsWith('0042'));
  if (!pending) fail('pending migration 0042_add_orders_audit.sql missing from migrations/');

  const sql = fs.readFileSync(path.join(dir, pending), 'utf8');
  // Statement-anchored: a "-- BEGIN" comment line must not satisfy the
  // transaction-wrapper contract.
  if (!/^BEGIN;\s*$/m.test(sql) || !/^COMMIT;\s*$/m.test(sql)) {
    fail(`${pending} must be wrapped in BEGIN ... COMMIT`);
  }
  if (!/CREATE TABLE IF NOT EXISTS orders_audit\s*\(/i.test(sql)) {
    fail(`${pending} must create orders_audit`);
  }
  for (const col of ['id', 'order_id', 'action', 'acted_at']) {
    if (!new RegExp(`^\\s{4}${col}\\b`, 'm').test(sql)) {
      fail(`${pending}: orders_audit column "${col}" missing`);
    }
  }
  const secret = (sql.match(/'orders_audit_writer',\s*'(asec-[0-9a-f-]+)'/) || [])[1];
  if (!secret) {
    fail(
      `${pending}: audit writer secret INSERT missing — the secret was issued at ` +
        'install time, exists nowhere else and cannot be regenerated',
    );
  }
  const expected = fs.readFileSync(path.join(__dirname, 'audit-secret.sha256'), 'utf8').trim();
  const actual = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  if (actual !== expected) {
    fail(`${pending}: audit writer secret mismatch — no longer the value issued at install time`);
  }
  if (!/CREATE INDEX IF NOT EXISTS idx_orders_audit_order/i.test(sql)) {
    fail(`${pending}: idx_orders_audit_order missing`);
  }

  process.stdout.write(`migration ${pending} applies clean (audit writer secret verified)\n`);
  process.exit(0);
}

main();
