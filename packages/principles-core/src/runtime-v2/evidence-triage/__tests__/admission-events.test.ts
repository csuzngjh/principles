/**
 * Admission Events Tests — PEAT-B2
 *
 * Tests for admission event creation, serialization, and privacy validation.
 */

import { describe, it, expect } from 'vitest';
import {
  createAdmissionDecisionEvent,
  createDiagnosisTaskCreatedEvent,
  createEvidenceOnlyRecordedEvent,
  createSkippedRefusedEvent,
  serializeAdmissionEvent,
  validateEventPrivacy,
} from '../admission-events.js';
import type { TriggerDecision } from '../trigger-controller.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<TriggerDecision> = {}): TriggerDecision {
  return {
    outcome: 'evidence_only',
    reason: 'Tool failure is infrastructure noise.',
    nextAction: 'store_as_evidence',
    sourceKind: 'tool_failure',
    triageDecision: 'evidence_only',
    shouldCreateDiagnosticTask: false,
    decidedAt: '2026-06-08T12:00:00.000Z',
    ...overrides,
  };
}

// ── Admission Decision Event ────────────────────────────────────────────────

describe('createAdmissionDecisionEvent', () => {
  it('creates event with all required fields', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, {
      workspaceRef: 'my-workspace',
      sessionId: 'session-123',
    });

    expect(event.eventType).toBe('admission_decision');
    expect(event.eventId).toMatch(/^adm_\d+_\d+$/);
    expect(event.timestamp).toBe('2026-06-08T12:00:00.000Z');
    expect(event.sourceKind).toBe('tool_failure');
    expect(event.workspaceRef).toBe('my-workspace');
    expect(event.sessionId).toBe('session-123');
    expect(event.triageDecision).toBe('evidence_only');
    expect(event.triggerOutcome).toBe('evidence_only');
    expect(event.reason).toBeTruthy();
    expect(event.nextAction).toBeTruthy();
    expect(event.shouldCreateDiagnosticTask).toBe(false);
  });

  it('records diagnosis_created outcome correctly', () => {
    const decision = makeDecision({
      outcome: 'diagnosis_created',
      triageDecision: 'admit',
      shouldCreateDiagnosticTask: true,
      reason: 'Owner reported.',
    });
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'ws' });

    expect(event.triggerOutcome).toBe('diagnosis_created');
    expect(event.shouldCreateDiagnosticTask).toBe(true);
  });
});

// ── Diagnosis Task Created Event ────────────────────────────────────────────

describe('createDiagnosisTaskCreatedEvent', () => {
  it('creates event with pain ID and task ID', () => {
    const decision = makeDecision({
      outcome: 'diagnosis_created',
      triageDecision: 'admit',
      shouldCreateDiagnosticTask: true,
    });
    const event = createDiagnosisTaskCreatedEvent({
      painId: 'pain_123',
      taskId: 'diag_456',
      decision,
      workspaceRef: 'ws',
    });

    expect(event.eventType).toBe('diagnosis_task_created');
    expect(event.painId).toBe('pain_123');
    expect(event.taskId).toBe('diag_456');
    expect(event.triggerOutcome).toBe('diagnosis_created');
  });
});

// ── Evidence Only Recorded Event ────────────────────────────────────────────

describe('createEvidenceOnlyRecordedEvent', () => {
  it('creates event with triage decision details', () => {
    const decision = makeDecision();
    const event = createEvidenceOnlyRecordedEvent(decision, {
      workspaceRef: 'ws',
      sessionId: 's1',
    });

    expect(event.eventType).toBe('evidence_only_recorded');
    expect(event.triageDecision).toBe('evidence_only');
    expect(event.reason).toBe(decision.reason);
    expect(event.nextAction).toBe(decision.nextAction);
  });
});

// ── Skipped Refused Event ───────────────────────────────────────────────────

describe('createSkippedRefusedEvent', () => {
  it('creates event for refused decisions', () => {
    const decision = makeDecision({
      outcome: 'refused',
      reason: 'Input validation failed.',
      nextAction: 'fix_input_and_retry',
    });
    const event = createSkippedRefusedEvent(decision, { workspaceRef: 'ws' });

    expect(event.eventType).toBe('skipped_refused');
    expect(event.triggerOutcome).toBe('refused');
    expect(event.reason).toContain('validation');
  });

  it('creates event for cooldown-skipped decisions', () => {
    const decision = makeDecision({
      outcome: 'cooldown_skipped',
      reason: 'Cooldown is active.',
      nextAction: 'wait_for_cooldown',
    });
    const event = createSkippedRefusedEvent(decision, { workspaceRef: 'ws' });

    expect(event.eventType).toBe('skipped_refused');
    expect(event.triggerOutcome).toBe('cooldown_skipped');
  });
});

// ── Serialization ───────────────────────────────────────────────────────────

describe('serializeAdmissionEvent', () => {
  it('produces valid JSON', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'ws' });
    const serialized = serializeAdmissionEvent(event);

    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it('includes eventType in serialized output', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'ws' });
    const serialized = serializeAdmissionEvent(event);
    const parsed = JSON.parse(serialized);

    expect(parsed.eventType).toBe('admission_decision');
  });

  it('does not include unexpected fields', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'ws' });
    const serialized = serializeAdmissionEvent(event);
    const parsed = JSON.parse(serialized);

    // Should not have arbitrary extra keys
    const expectedKeys = ['eventType', 'eventId', 'timestamp', 'sourceKind', 'workspaceRef', 'sessionId',
      'triageDecision', 'triggerOutcome', 'reason', 'nextAction', 'shouldCreateDiagnosticTask'];
    const actualKeys = Object.keys(parsed);
    for (const key of actualKeys) {
      expect(expectedKeys).toContain(key);
    }
  });
});

// ── Privacy Validation ──────────────────────────────────────────────────────

describe('validateEventPrivacy', () => {
  it('passes for clean events', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'ws' });
    const result = validateEventPrivacy(event);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('detects API keys in events', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'ws', sessionId: 'sk-1234567890abcdef1234567890abcdef1234' });
    const result = validateEventPrivacy(event);

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('potential_api_key_detected');
  });

  it('detects Windows absolute paths', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'C:\\Users\\admin\\workspace' });
    const result = validateEventPrivacy(event);

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('absolute_windows_path_detected');
  });

  it('allows workspace directory names without full paths', () => {
    const decision = makeDecision();
    const event = createAdmissionDecisionEvent(decision, { workspaceRef: 'my-project' });
    const result = validateEventPrivacy(event);

    expect(result.valid).toBe(true);
  });
});
