import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hashOfCanonical } from './lib/challenge-freeze.mjs';
import { summarizeAdaptiveStudy } from './summarize-adaptive-coverage.mjs';

function example() {
  const body = 'Check the visible acceptance criteria before declaring completion.';
  const config = { host: 'openclaw', hostVersion: 'test', runtimeMode: 'embedded',
    pluginVersion: 'test', effectiveHookSetFingerprint: 'test-source', evidenceCoverage: 'partial' };
  const expected = {
    hookInvocationId: 'h1', workspaceId: 'w1', sessionId: 's1', requestId: 'r1',
    artifactId: 'a1', activationId: 'act1', config,
    contentSha256: createHash('sha256').update(body).digest('hex'),
  };
  const requestCapture = {
    ...expected, sourceId: 'request-source', reference: 'request:1', boundary: 'final_model_request',
    directiveBodies: [body], order: { domain: 'host-run', sequence: 1 },
  };
  const actionCapture = {
    ...expected, sourceId: 'action-source', reference: 'action:1', boundary: 'first_critical_action',
    order: { domain: 'host-run', sequence: 2 },
  };
  const check = { expected, requestCapture, actionCapture, receipt: {
    hookInvocationId: 'h1', requestId: 'r1', receiptState: 'closed', execution: 'completed',
    payload: 'returned', selection: 'selected', submission: 'unknown',
  } };
  const input = {
    schemaVersion: 'aa-coverage-input.v1', windowId: 'window-1', workspaceId: 'w1',
    enumeration: 'sample', config,
    opportunities: [{
      opportunityId: 'opportunity-1', sessionId: 's1', classification: { T: true, V: true, O: true },
      classificationReferences: { T: 'review:t', V: 'signal:v', O: 'recognition:o' },
      sameText: false, checks: [check],
    }],
  };
  const trust = { sources: [
    { sourceId: requestCapture.sourceId, kind: 'request', provenance: 'independent_request_boundary', sha256: hashOfCanonical(requestCapture) },
    { sourceId: actionCapture.sourceId, kind: 'action', provenance: 'independent_action_boundary', sha256: hashOfCanonical(actionCapture) },
  ] };
  return { input, trust };
}

test('statistics consume the existing verifier with matching scope and preserve sample limitations', () => {
  const { input, trust } = example();
  const report = summarizeAdaptiveStudy(input, trust);
  assert.equal(report.counts.D.confirmed, 1);
  assert.equal(report.ratios['D/T'].value, 1);
  assert.equal(report.conclusionScope, 'sample_only');
  assert.equal(report.configurationCoverage, 'partial');
  assert.equal(report.behavioralImprovement, 'not_evaluated');
  assert.ok(!JSON.stringify(report).includes(input.opportunities[0].checks[0].requestCapture.directiveBodies[0]));
});

test('a self-reported successful verdict or fixture cannot inflate the measured coverage', () => {
  const { input, trust } = example();
  input.opportunities[0].checks[0].requestCapture.directiveBodies = ['a different request'];
  input.opportunities[0].D = true;
  input.opportunities[0].checks[0].result = { delivery: 'confirmed', timely: 'confirmed', evidenceLevel: 'L1' };
  const report = summarizeAdaptiveStudy(input, trust);
  assert.equal(report.counts.D.confirmed, 0);
  assert.equal(report.counts.D.unknown, 1);
  const fixture = example();
  fixture.trust.sources[0].provenance = 'fixture';
  assert.equal(summarizeAdaptiveStudy(fixture.input, fixture.trust).counts.D.confirmed, 0);
});

test('workspace, session and configuration mismatches refuse aggregation instead of silently dropping failures', () => {
  for (const field of ['workspaceId', 'sessionId']) {
    const { input, trust } = example();
    input.opportunities[0].checks[0].expected[field] = 'other';
    assert.throws(() => summarizeAdaptiveStudy(input, trust), /check_scope_mismatch/);
  }
  const { input, trust } = example();
  input.opportunities[0].checks[0].expected.config = { ...input.config, pluginVersion: 'changed' };
  assert.throws(() => summarizeAdaptiveStudy(input, trust), /check_scope_mismatch/);
});

test('known excluded opportunities cannot wash an actual delivery into D', () => {
  const { input, trust } = example();
  input.opportunities[0].classification = { T: false, V: false, O: false };
  const report = summarizeAdaptiveStudy(input, trust);
  assert.equal(report.counts.D.confirmed, 0);
  assert.equal(report.ratios['D/T'].status, 'not_applicable');
  assert.equal(report.diagnostics.excludedTimelyDeliveries, 1);
});

test('replaying the same opportunity does not turn callback volume into extra opportunities', () => {
  const { input, trust } = example();
  input.opportunities.push(structuredClone(input.opportunities[0]));
  const report = summarizeAdaptiveStudy(input, trust);
  assert.equal(report.counts.T.confirmed, 1);
  assert.equal(report.counts.D.confirmed, 1);
  assert.equal(report.diagnostics.duplicateRows, 1);
});

test('CLI reads separate files, reports a valid empty window and refuses malformed arguments', () => {
  const root = path.resolve('.tmp/aa-coverage-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const cli = fileURLToPath(new URL('./summarize-adaptive-coverage.mjs', import.meta.url));
  try {
    const { input, trust } = example();
    input.opportunities = [];
    fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input));
    fs.writeFileSync(path.join(dir, 'trust.json'), JSON.stringify(trust));
    const args = ['--input', path.join(dir, 'input.json'), '--trust', path.join(dir, 'trust.json')];
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ratios['D/T'].status, 'not_applicable');
    const invalid = spawnSync(process.execPath, [cli, ...args, '--invalid', 'x'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).reason, 'coverage_input_invalid');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
