// Read-only offline verification. Trust pins are supplied separately by the
// operator, never derived from the receipt or a model's claim of independence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hashOfCanonical } from './lib/challenge-freeze.mjs';
import { validateAdaptiveDeliveryRecord } from './lib/adaptive-delivery-record.mjs';

const bindingFields = [
  'hookInvocationId', 'requestId', 'sessionId', 'artifactId', 'activationId',
];
const configFields = [
  'host', 'hostVersion', 'runtimeMode', 'pluginVersion',
  'effectiveHookSetFingerprint', 'evidenceCoverage',
];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validExpected(expected) {
  return object(expected)
    && bindingFields.every((key) => own(expected, key) && text(expected[key]))
    && sha256(expected.contentSha256)
    && configFields.every((key) => own(expected.config, key) && text(expected.config[key]))
    && ['complete', 'partial', 'unknown'].includes(expected.config.evidenceCoverage);
}

function matchesBinding(expected, capture) {
  return bindingFields.every((key) => own(capture, key) && capture[key] === expected[key])
    && configFields.every((key) => own(capture.config, key) && capture.config[key] === expected.config[key]);
}

function pinFor(trust, observation, kind) {
  if (!object(observation) || !text(observation.sourceId) || !text(observation.reference)) return null;
  const pins = trust.sources.filter((pin) => object(pin)
    && pin.sourceId === observation.sourceId && pin.kind === kind);
  if (pins.length !== 1 || !sha256(pins[0].sha256)) return null;
  return pins[0].sha256 === hashOfCanonical(observation) ? pins[0] : null;
}

/**
 * Input contains expected binding, a target-specific receipt, requestCapture
 * and optional actionCapture. Capture bytes are authenticated against the
 * operator's separate trust manifest. This checks supplied evidence; it does
 * not certify who produced the manifest or collect a real host request.
 */
export function verifyAdaptiveDelivery(input, trust) {
  const result = {
    ok: true, delivery: 'unknown', timely: 'unknown', reason: 'request_evidence_missing',
    evidenceLevel: 'unknown', fixtureMatch: false, references: [],
    behavioralImprovement: 'not_evaluated',
  };
  const invalid = (reason) => ({ ...result, ok: false, reason });
  if (!object(input) || !validExpected(input.expected)) return invalid('invalid_expected_binding');
  if (!object(trust) || !Array.isArray(trust.sources)) return invalid('invalid_trust_manifest');
  const receipt = validateAdaptiveDeliveryRecord(input.receipt);
  if (!receipt.ok) return { ...invalid('invalid_receipt'), errors: receipt.errors };
  const { expected, requestCapture: capture, actionCapture: action } = input;
  if (input.receipt.hookInvocationId !== expected.hookInvocationId
    || input.receipt.requestId !== expected.requestId) return invalid('receipt_binding_mismatch');
  if (!capture) return result;
  const requestPin = pinFor(trust, capture, 'request');
  if (!requestPin) return { ...result, reason: 'request_not_independently_pinned' };
  if (!matchesBinding(expected, capture)) return { ...result, reason: 'request_binding_mismatch' };
  if (capture.boundary !== 'final_model_request') return { ...result, reason: 'request_only_prepared' };
  if (!Array.isArray(capture.directiveBodies) || !capture.directiveBodies.every(text)) {
    return invalid('invalid_directive_bodies');
  }
  // Hash exact full bodies at the adapter's final encoding boundary. A title,
  // substring, self-report or truncated body is not a target contribution.
  const present = capture.directiveBodies.some((body) => digest(body) === expected.contentSha256);
  if (requestPin.provenance === 'fixture') {
    return { ...result, evidenceLevel: 'fixture', fixtureMatch: present, reason: 'fixture_only' };
  }
  if (requestPin.provenance !== 'independent_request_boundary') {
    return { ...result, reason: 'request_source_unqualified' };
  }
  if (!present) return { ...result, delivery: 'not_confirmed', reason: 'target_body_absent' };
  if (input.receipt.execution !== 'completed' || input.receipt.selection !== 'selected'
    || !['returned', 'confirmed'].includes(input.receipt.payload)) {
    return { ...result, reason: 'request_receipt_conflict', references: [capture.reference] };
  }
  const delivered = {
    ...result, delivery: 'confirmed', reason: 'action_evidence_missing',
    evidenceLevel: 'L1', references: [capture.reference],
    configurationCoverage: configFields.some((key) => expected.config[key] === 'unknown')
      ? 'unknown' : expected.config.evidenceCoverage,
  };
  if (!action) return delivered;
  const actionPin = pinFor(trust, action, 'action');
  if (!actionPin || actionPin.provenance !== 'independent_action_boundary') {
    return { ...delivered, reason: 'action_not_independently_pinned' };
  }
  if (!matchesBinding(expected, action) || action.boundary !== 'first_critical_action') {
    return { ...delivered, reason: 'action_binding_mismatch' };
  }
  const before = capture.order;
  const after = action.order;
  if (!object(before) || !object(after) || !text(before.domain)
    || before.domain !== after.domain || !Number.isSafeInteger(before.sequence)
    || !Number.isSafeInteger(after.sequence) || before.sequence < 0 || after.sequence < 0) {
    return { ...delivered, reason: 'action_order_unknown' };
  }
  return {
    ...delivered, timely: before.sequence < after.sequence ? 'confirmed' : 'not_confirmed',
    reason: before.sequence < after.sequence ? 'delivered_before_action' : 'delivery_not_before_action',
    references: [capture.reference, action.reference],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const flag = process.argv[i];
      if (!['--input', '--trust'].includes(flag) || !process.argv[i + 1] || Object.hasOwn(args, flag)) {
        throw new Error('invalid_arguments');
      }
      args[flag] = process.argv[i + 1];
    }
    if (!args['--input'] || !args['--trust']) throw new Error('input_and_trust_required');
    if (fs.realpathSync(args['--input']) === fs.realpathSync(args['--trust'])) {
      throw new Error('trust_must_be_separate');
    }
    const input = JSON.parse(fs.readFileSync(args['--input'], 'utf8'));
    const trust = JSON.parse(fs.readFileSync(args['--trust'], 'utf8'));
    const result = verifyAdaptiveDelivery(input, trust);
    console.log(JSON.stringify(result));
    if (!result.ok || result.timely !== 'confirmed') process.exitCode = 1;
  } catch {
    // File contents and paths may contain private task data.
    console.log(JSON.stringify({ ok: false, reason: 'verification_input_invalid' }));
    process.exitCode = 1;
  }
}
