import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocalTransport } from './local-transport-result.mjs';

const valid = () => ({
  validationExit: 0, hostExit: 0, deadlineExceeded: false,
  requests: [{ model: 'aa-probe', userMarkerPresent: true }],
  stdout: JSON.stringify({ ok: true, status: 'ok', final: 'stub', provider: 'aa-local', model: 'aa-probe' }),
  marker: 'probe', reply: 'stub',
});

test('only a complete local transport round trip passes; it makes no principle or behavior claim', () => {
  const result = classifyLocalTransport(valid());
  assert.equal(result.ok, true);
  assert.equal(result.pdPrincipleDelivery, 'not_tested');
  assert.equal(result.behavioralImprovement, 'not_tested');
});

test('host success never masks deadline termination, failed validation or nonzero exit', () => {
  for (const changed of [{ deadlineExceeded: true }, { validationExit: 1 }, { hostExit: 1 }]) {
    const result = classifyLocalTransport({ ...valid(), ...changed });
    assert.equal(result.ok, false);
    assert.equal(result.transportConfirmed, true);
  }
});

test('missing, repeated, wrong-model or non-user requests cannot establish this probe', () => {
  for (const requests of [[], [...valid().requests, ...valid().requests],
    [{ model: 'other', userMarkerPresent: true }], [{ model: 'aa-probe', userMarkerPresent: false }]]) {
    assert.equal(classifyLocalTransport({ ...valid(), requests }).transportConfirmed, false);
  }
});

test('textual stub mentions, malformed output and a failed envelope are not a received response', () => {
  for (const stdout of ['stub', '{}', JSON.stringify({ ok: false, final: 'stub' }),
    JSON.stringify({ ...JSON.parse(valid().stdout), provider: 'external' }),
    JSON.stringify({ ...JSON.parse(valid().stdout), final: 'different' })]) {
    assert.equal(classifyLocalTransport({ ...valid(), stdout }).ok, false);
  }
});

test('a deadline records the observed phase without equating a late result with an exit hang', () => {
  const timed = { ...valid(), deadlineExceeded: true, hostExit: 1 };
  for (const [changes, expected] of [
    [{ requests: [], timings: { resultEnvelopeMs: null, nativeExitMs: null } }, 'before_request_capture'],
    [{ timings: { resultEnvelopeMs: null, nativeExitMs: 60100 } }, 'after_request_capture'],
    [{ timings: { resultEnvelopeMs: 59900, nativeExitMs: 60100 } }, 'after_result_output'],
    [{ timings: { resultEnvelopeMs: 59000, nativeExitMs: 59500, deadlineReachedMs: 60000 } }, 'waiting_for_output_pipes'],
  ]) {
    const result = classifyLocalTransport({ ...timed, ...changes });
    assert.equal(result.ok, false);
    assert.equal(result.deadlinePhase, expected);
  }
});
