/**
 * Pain Phase 0 — retired admission/observation dead code stays removed.
 *
 * SPEC PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 §9 Phase 0 item 1:
 * admission event factories (admission-events.ts) and the unused observation
 * builders (buildLlmDetectionObservation / buildEmpathyObservation) had zero
 * production consumers and were deleted.
 *
 * This file replaces the characterization tests of the deleted modules with
 * negative regressions: the symbols must NOT come back on the module surface,
 * while every LIVE symbol keeps resolving (ERR-009 fail-loud style).
 */

import { describe, it, expect } from 'vitest';
import * as evidenceTriage from '../index.js';
import * as observationResolver from '../observation-resolver.js';

const RETIRED = [
  'createAdmissionDecisionEvent',
  'createDiagnosisTaskCreatedEvent',
  'createEvidenceOnlyRecordedEvent',
  'createSkippedRefusedEvent',
  'serializeAdmissionEvent',
  'validateEventPrivacy',
  'buildLlmDetectionObservation',
  'buildEmpathyObservation',
] as const;

const LIVE = [
  'resolveSourceKind',
  'buildToolFailureObservation',
  'buildManualPainObservation',
  'evaluateTriage',
  'evaluateTriggerController',
  'shouldCreateTask',
  'isAdmittedOutcome',
  'isSkippedOutcome',
] as const;

describe('Pain Phase 0: retired evidence-triage exports stay removed', () => {
  it.each(RETIRED)('%s is no longer exported from evidence-triage barrel', (name) => {
    expect(Object.hasOwn(evidenceTriage, name)).toBe(false);
  });

  it.each(LIVE)('%s remains exported (live consumers depend on it)', (name) => {
    expect(Object.hasOwn(evidenceTriage, name)).toBe(true);
  });

  it('observation-resolver module no longer carries the retired builders', () => {
    expect(Object.hasOwn(observationResolver, 'buildLlmDetectionObservation')).toBe(false);
    expect(Object.hasOwn(observationResolver, 'buildEmpathyObservation')).toBe(false);
    expect(Object.hasOwn(observationResolver, 'resolveSourceKind')).toBe(true);
  });
});
