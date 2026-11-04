import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOfCanonical } from './lib/challenge-freeze.mjs';
import { verifyAdaptiveDelivery } from './verify-adaptive-delivery.mjs';

const body = 'Verify the existing acceptance evidence before claiming completion.';
function fixture() {
  const expected = {
    hookInvocationId: 'hook-1', requestId: 'request-1', workspaceId: 'workspace-1', sessionId: 'session-1',
    activationId: 'activation-1', artifactId: 'artifact-1',
    contentSha256: createHash('sha256').update(body).digest('hex'),
    config: {
      host: 'openclaw', hostVersion: 'test-version', runtimeMode: 'embedded',
      pluginVersion: 'test-plugin', effectiveHookSetFingerprint: 'config-1',
      evidenceCoverage: 'complete',
    },
  };
  return {
    expected,
    receipt: {
      hookInvocationId: 'hook-1', requestId: 'request-1', receiptState: 'closed',
      execution: 'completed', payload: 'returned', selection: 'selected', submission: 'unknown',
    },
    requestCapture: {
      ...structuredClone(expected), sourceId: 'request-observer', reference: 'evidence:request-1',
      boundary: 'final_model_request', directiveBodies: [body],
      order: { domain: 'host-run-1', sequence: 2 },
    },
    actionCapture: {
      ...structuredClone(expected), sourceId: 'action-observer', reference: 'evidence:action-1',
      boundary: 'first_critical_action', order: { domain: 'host-run-1', sequence: 3 },
    },
  };
}
function pins(input, provenance = 'independent_request_boundary') {
  return { sources: [
    { sourceId: input.requestCapture.sourceId, kind: 'request', provenance, sha256: hashOfCanonical(input.requestCapture) },
    { sourceId: input.actionCapture.sourceId, kind: 'action', provenance: 'independent_action_boundary', sha256: hashOfCanonical(input.actionCapture) },
  ] };
}

test('exact pinned request before the first action supports only delivery, never behavior quality', () => {
  const input = fixture();
  const original = structuredClone(input);
  const result = verifyAdaptiveDelivery(input, pins(input));
  assert.equal(result.delivery, 'confirmed');
  assert.equal(result.timely, 'confirmed');
  assert.equal(result.behavioralImprovement, 'not_evaluated');
  assert.deepEqual(input, original);
  assert.ok(!JSON.stringify(result).includes(body));
});

test('a returned receipt alone cannot confirm model-request delivery', () => {
  const input = fixture();
  delete input.requestCapture;
  const result = verifyAdaptiveDelivery(input, { sources: [] });
  assert.equal(result.delivery, 'unknown');
  assert.equal(result.timely, 'unknown');
});

test('an input cannot supply its own independent authority', () => {
  const input = fixture();
  input.requestCapture.independentlyVerified = true;
  assert.equal(verifyAdaptiveDelivery(input, { sources: [] }).reason, 'request_not_independently_pinned');
});

test('changing captured bytes invalidates the independently pinned observation', () => {
  const input = fixture();
  const trust = pins(input);
  input.requestCapture.directiveBodies = ['claiming the principle was followed'];
  assert.equal(verifyAdaptiveDelivery(input, trust).delivery, 'unknown');
});

test('fixture evidence remains fixture even when bytes and identities match', () => {
  const input = fixture();
  const result = verifyAdaptiveDelivery(input, pins(input, 'fixture'));
  assert.equal(result.fixtureMatch, true);
  assert.equal(result.delivery, 'unknown');
  assert.equal(result.timely, 'unknown');
  assert.equal(result.evidenceLevel, 'fixture');
});

test('prepared inputs cannot be upgraded by trusting their producer', () => {
  const input = fixture();
  input.requestCapture.boundary = 'prepared_input';
  assert.equal(verifyAdaptiveDelivery(input, pins(input)).reason, 'request_only_prepared');
});

for (const field of ['requestId', 'workspaceId', 'sessionId', 'activationId', 'artifactId', 'hookInvocationId']) {
  test('a capture from a different ' + field + ' cannot borrow this receipt', () => {
    const input = fixture();
    input.requestCapture[field] = 'other';
    assert.equal(verifyAdaptiveDelivery(input, pins(input)).reason, 'request_binding_mismatch');
  });
}

test('complete target text is required; a truncated body does not prove the intervention', () => {
  const input = fixture();
  input.requestCapture.directiveBodies = [body.slice(0, -1)];
  const result = verifyAdaptiveDelivery(input, pins(input));
  assert.equal(result.delivery, 'not_confirmed');
});

test('a changed configuration cannot inherit old confirmation', () => {
  const input = fixture();
  input.requestCapture.config.pluginVersion = 'upgraded';
  assert.equal(verifyAdaptiveDelivery(input, pins(input)).reason, 'request_binding_mismatch');
});

for (const coverage of ['partial', 'unknown']) {
  test(coverage + ' configuration evidence is preserved without a complete identity claim', () => {
    const input = fixture();
    input.expected.config.evidenceCoverage = coverage;
    input.requestCapture.config.evidenceCoverage = coverage;
    const result = verifyAdaptiveDelivery(input, pins(input));
    assert.equal(result.delivery, 'confirmed');
    assert.equal(result.configurationCoverage, coverage);
  });
}

test('duplicate trust identities fail closed rather than choosing the convenient pin', () => {
  const input = fixture();
  const trust = pins(input);
  trust.sources.push({ ...trust.sources[0] });
  assert.equal(verifyAdaptiveDelivery(input, trust).delivery, 'unknown');
});

test('a target abandoned during fallback cannot borrow a Native request success', () => {
  const input = fixture();
  input.receipt.execution = 'degraded';
  input.receipt.payload = 'none';
  assert.equal(verifyAdaptiveDelivery(input, pins(input)).reason, 'request_receipt_conflict');
});

test('a request after the action is delivered but too late', () => {
  const input = fixture();
  input.actionCapture.order.sequence = 1;
  const result = verifyAdaptiveDelivery(input, pins(input));
  assert.equal(result.delivery, 'confirmed');
  assert.equal(result.timely, 'not_confirmed');
});

test('equal sequence numbers do not establish strict precedence', () => {
  const input = fixture();
  input.actionCapture.order.sequence = 2;
  assert.equal(verifyAdaptiveDelivery(input, pins(input)).timely, 'not_confirmed');
});

test('wall-clock proximity and incomparable sequence domains cannot establish timeliness', () => {
  const input = fixture();
  input.actionCapture.order.domain = 'different-clock';
  input.actionCapture.timestamp = '2026-11-04T00:00:01Z';
  assert.equal(verifyAdaptiveDelivery(input, pins(input)).timely, 'unknown');
});

test('delivery evidence alone cannot prove the first external action', () => {
  const input = fixture();
  delete input.actionCapture;
  const trust = { sources: [{ sourceId: input.requestCapture.sourceId, kind: 'request',
    provenance: 'independent_request_boundary', sha256: hashOfCanonical(input.requestCapture) }] };
  const result = verifyAdaptiveDelivery(input, trust);
  assert.equal(result.delivery, 'confirmed');
  assert.equal(result.timely, 'unknown');
});

test('untrusted and malformed inputs return explicit failures', () => {
  for (const input of [null, [], {}, { expected: null }]) {
    assert.equal(verifyAdaptiveDelivery(input, {}).ok, false);
  }
  assert.equal(verifyAdaptiveDelivery(fixture(), {}).ok, false);
});

test('legacy input without workspace binding is refused instead of borrowing a request from another workspace', () => {
  const input = fixture();
  delete input.expected.workspaceId;
  assert.equal(verifyAdaptiveDelivery(input, pins(input)).reason, 'invalid_expected_binding');
});

test('CLI reads separate trust and input files and emits one redacted JSON result', () => {
  const tempRoot = path.resolve('.tmp/aa-verifier-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  const cli = fileURLToPath(new URL('./verify-adaptive-delivery.mjs', import.meta.url));
  try {
    const input = fixture();
    fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input));
    fs.writeFileSync(path.join(dir, 'trust.json'), JSON.stringify(pins(input)));
    const args = ['--input', path.join(dir, 'input.json'), '--trust', path.join(dir, 'trust.json')];
    const child = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).timely, 'confirmed');
    assert.ok(!child.stdout.includes(body));
    const invalid = spawnSync(process.execPath, [cli, ...args, '--trust', args[3]], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).reason, 'verification_input_invalid');
    const missing = spawnSync(process.execPath, [cli, '--input', path.join(dir, 'input.json')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    const selfTrusted = spawnSync(process.execPath, [cli, '--input', path.join(dir, 'input.json'),
      '--trust', path.join(dir, 'input.json')], { encoding: 'utf8' });
    assert.equal(selfTrusted.status, 1);
    fs.writeFileSync(path.join(dir, 'trust.json'), JSON.stringify(pins(input, 'fixture')));
    const fixtureOnly = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(fixtureOnly.status, 1);
    assert.equal(JSON.parse(fixtureOnly.stdout).delivery, 'unknown');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
