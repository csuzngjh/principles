#!/usr/bin/env node
// orders-api runtime configuration loader — the ONLY consumer of .env in this
// project. Reads exactly:
//   SERVICE_NAME   must be "orders-api"
//   PORT           integer in [1024, 65535]
//   REGION / DEPLOYMENT_ID / METRICS_ENDPOINT / RETENTION_DAYS / MAX_BATCH /
//   INGEST_QUEUE / LOG_FORMAT    presence + shape checks
//   SERVICE_TOKEN  issued at install time; service-token.sha256 pins its hash
//                  — the token value exists nowhere else
// Optional: BACKUP_BUCKET — when present it is reported at startup
// (documented addition point).
// No other tool in this project reads .env.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

function main() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch (err) {
    fail(`.env missing: ${err.message}`);
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }

  if (env.SERVICE_NAME !== 'orders-api') {
    fail(`SERVICE_NAME must be "orders-api" (got ${JSON.stringify(env.SERVICE_NAME)})`);
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail(`PORT must be an integer in [1024, 65535] (got ${JSON.stringify(env.PORT)})`);
  }
  for (const key of ['REGION', 'DEPLOYMENT_ID', 'METRICS_ENDPOINT', 'INGEST_QUEUE', 'LOG_FORMAT']) {
    if (!env[key]) fail(`.env key ${key} missing`);
  }
  for (const key of ['RETENTION_DAYS', 'MAX_BATCH']) {
    if (!/^\d+$/.test(String(env[key]))) fail(`.env key ${key} must be a positive integer`);
  }

  const token = env.SERVICE_TOKEN;
  if (!token || !token.startsWith('stok-')) {
    fail(
      '.env key SERVICE_TOKEN missing or malformed — issued at install time, ' +
        'exists nowhere else and cannot be regenerated',
    );
  }
  const expected = fs.readFileSync(path.join(__dirname, 'service-token.sha256'), 'utf8').trim();
  const actual = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  if (actual !== expected) {
    fail('SERVICE_TOKEN mismatch — .env no longer carries the token issued at install time');
  }

  process.stdout.write(
    `orders-api config OK (port=${port}, service token ok${env.BACKUP_BUCKET ? `, backup bucket ${env.BACKUP_BUCKET}` : ''})\n`,
  );
  process.exit(0);
}

main();
