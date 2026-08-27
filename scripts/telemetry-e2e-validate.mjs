#!/usr/bin/env node
/**
 * Anonymous Product Telemetry v1 — collector E2E validation harness
 * (PRI-600/603, SPEC §41/§52-§57).
 *
 * Exercises the REAL deployed collector over HTTPS with a snapshot built by
 * the official @principles/core builder (drift-locked: what the client sends
 * must be accepted). Validates: accept, same-day dedup (idempotent 204),
 * strict schema rejections, oversized rejection, rate-limit-eligible path,
 * and maintainer-view access protection.
 *
 * Usage:
 *   node scripts/telemetry-e2e-validate.mjs --endpoint https://host
 *     [--signals-token <token>]
 *
 * Network calls go ONLY to --endpoint. No secrets are printed.
 * The script prints a machine-readable summary; row-count verification
 * against D1 is done separately via `wrangler d1 execute`.
 */

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    'signals-token': { type: 'string' },
  },
});

if (!values.endpoint) {
  console.error('usage: node scripts/telemetry-e2e-validate.mjs --endpoint <url> [--signals-token <token>]');
  process.exit(1);
}

const ENDPOINT = values.endpoint.replace(/\/+$/, '');
const SNAPSHOT_URL = `${ENDPOINT}/api/product-telemetry/snapshot`;
const SIGNALS_URL = `${ENDPOINT}/product-signals`;

// Resolve the official builder from the monorepo's built core.
const core = await import('@principles/core/runtime-v2');
const {
  buildProductTelemetrySnapshot,
  deriveDailyTelemetryId,
  deriveWorkspaceScopeId,
  generateTelemetrySecretHex,
  bucketDateFromTime,
} = core;

const secret = generateTelemetrySecretHex();
const today = bucketDateFromTime(Date.now());
// One simulated workspace (measurement unit = workspace; review remediation).
const scopeId = deriveWorkspaceScopeId(secret, '/e2e/validation-workspace');
const dailyId = deriveDailyTelemetryId(secret, scopeId, today);

function snapshot(overrides = {}) {
  return buildProductTelemetrySnapshot({
    dailyTelemetryId: overrides.dailyTelemetryId ?? dailyId,
    bucketDate: overrides.bucketDate ?? today,
    pdVersion: '0.0.0-e2e-validation',
    hostKind: 'other',
    milestones: {
      initialized: true,
      painObserved: false,
      principleObserved: false,
      activationObserved: false,
      presenceReceiptObserved: false,
      effectReceiptObserved: false,
    },
    reliability: { initializationFailed: false },
  });
}

const results = [];

async function post(label, body, expectStatus) {
  const response = await fetch(SNAPSHOT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await response.arrayBuffer(); // drain bounded response
  const pass = response.status === expectStatus;
  results.push({ label, expected: expectStatus, actual: response.status, pass });
  return response;
}

async function getSignals(label, token, expectStatus) {
  const response = await fetch(SIGNALS_URL, {
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  const pass = response.status === expectStatus;
  results.push({ label, expected: expectStatus, actual: response.status, pass });
  return { pass, text };
}

// 1. Health
const health = await fetch(`${ENDPOINT}/api/product-telemetry/health`);
results.push({ label: 'health 200', expected: 200, actual: health.status, pass: health.status === 200 });

// 2. Valid snapshot accepted (official builder output)
await post('valid snapshot accepted', snapshot(), 204);

// 3. Same-day duplicate accepted (idempotent; D1 upsert keeps one row)
await post('same-day duplicate idempotent', snapshot(), 204);

// 4. Different secret (different workspace) same day accepted
await post('second workspace accepted', snapshot({ dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), scopeId, today) }), 204);

// 5. Strict schema rejections
const tampered = snapshot();
tampered.extra = 'x';
await post('unknown top-level field rejected', tampered, 400);
await post('wrong schema version rejected', { ...snapshot(), schemaVersion: '2' }, 400);
await post('nested unknown field rejected', { ...snapshot(), milestones: { ...snapshot().milestones, content: 'leak' } }, 400);
await post('malformed JSON rejected', '{not-json', 400);

// 6. Oversized body rejected before validation
await post('oversized body rejected', `${JSON.stringify(snapshot())}${' '.repeat(5 * 1024)}`, 413);

// 7. Bucket-date range enforcement
await post('future bucket rejected', snapshot({ bucketDate: bucketDateFromTime(Date.now() + 3 * 24 * 60 * 60 * 1000) }), 400);
await post('stale bucket rejected', snapshot({ bucketDate: '2020-01-01' }), 400);

// 8. Maintainer view access protection
await getSignals('signals view unauthorized', undefined, 401);
await getSignals('signals view wrong token', 'wrong-token-value-0123456789abcdef', 401);
if (values['signals-token']) {
  const withToken = await getSignals('signals view authorized', values['signals-token'], 200);
  if (withToken.pass) {
    const checks = [
      ['permanent warning', withToken.text.includes('must not be interpreted as the complete PD population')],
      ['honest unit wording', withToken.text.includes('participating workspaces')],
      ['no installation/user wording', !/\b(users|installations)\b/i.test(withToken.text)],
      ['effect not improvement', withToken.text.includes('Effect receipt observed')],
      ['validation units counted', withToken.text.includes('0.0.0-e2e-validation')],
    ];
    for (const [label, pass] of checks) {
      results.push({ label: `signals content: ${label}`, expected: 'true', actual: String(pass), pass });
    }
  }
}

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}  (expected ${r.expected}, got ${r.actual})`);
}
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed against ${ENDPOINT}`);
if (failed.length > 0) {
  process.exit(1);
}
