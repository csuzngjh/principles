/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures use validated objects with known keys */
import { describe, it, expect } from 'vitest';
import { assembleEvidenceChain } from '../types/evidence-chain-contract.js';
import type { IntentTension } from '../types/evidence-chain-contract.js';

/**
 * PRI-469: surface intentTension through EvidenceChain.
 *
 * Production architecture: DiagnosticianCommitter writes the full
 * DiagnosticianOutputV1 (rootCause + intentTension) to the `artifacts` table
 * (artifact_kind = 'diagnostician_output', column content_json), NOT to
 * tasks.diagnostic_json. These tests verify assembleEvidenceChain extracts
 * intentTension from the diagnosticArtifacts parameter with runtime validation,
 * degrading visibly on invalid data.
 *
 * The IntentTension type is defined in diag-rootcause-output.ts (PRI-468) and
 * re-exported via evidence-chain-contract.ts. SPEC §16.3 forbids a `confidence`
 * field on intentTension; the compile-time guarantee test below verifies the
 * type does not carry it.
 */

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeBaseParams(overrides: Partial<Parameters<typeof assembleEvidenceChain>[0]> = {}) {
  return {
    workspaceDir: '/workspace/test',
    painEvents: [
      {
        id: 1,
        source: 'manual',
        reason: 'Agent built heavy dashboard before validating smallest loop',
        text: 'Manual record: directional drift',
        created_at: '2026-06-26T10:00:00.000Z',
        score: 90,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_1',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-26T10:01:00.000Z',
        input_ref: 'pain_1',
      },
    ],
    candidates: [],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
    ...overrides,
  };
}

function makeValidIntentTension(): Record<string, unknown> {
  return {
    source: 'action_drift',
    evidenceStrength: 'strong',
    relatedIntentFields: ['current_strategic_focus', 'non_negotiables'],
    evidence: [
      'INTENT says current focus is validating the smallest loop.',
      'Agent designed a heavy dashboard.',
      'Owner correction says the result increased review burden.',
    ],
    explanation: 'The work optimized presentation completeness before validating the learning loop.',
    suggestedOwnerAction: 'confirm_drift',
    intentDocHash: 'sha256:abc123',
  };
}

function makeArtifact(taskId: string, output: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: taskId,
    content_json: JSON.stringify(output),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRI-469: assembleEvidenceChain intentTension extraction', () => {
  it('extracts valid intentTension from diagnosticArtifacts', () => {
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'Verifier missed runtime load.',
          intentTension: makeValidIntentTension(),
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records.length).toBe(1);
    const record = res.records[0]!;
    expect(record.intentTension).toBeDefined();
    expect(record.intentTension!.source).toBe('action_drift');
    expect(record.intentTension!.evidenceStrength).toBe('strong');
    expect(record.intentTension!.relatedIntentFields).toEqual(['current_strategic_focus', 'non_negotiables']);
    expect(record.intentTension!.evidence).toHaveLength(3);
    expect(record.intentTension!.explanation).toContain('presentation completeness');
    expect(record.intentTension!.suggestedOwnerAction).toBe('confirm_drift');
    expect(record.intentTension!.intentDocHash).toBe('sha256:abc123');
  });

  it('also extracts rootCause from artifact content_json (fixes production GAP)', () => {
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'Verifier missed runtime load path.',
          intentTension: makeValidIntentTension(),
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.rootCauseSummary).toBe('Verifier missed runtime load path.');
  });

  it('rejects intentTension.confidence (SPEC §16.3)', () => {
    const malicious = makeValidIntentTension();
    malicious.confidence = 0.92; // forbidden field
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'some root cause',
          intentTension: malicious,
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.intentTension).toBeUndefined();
  });

  it('degrades visibly when intentTension is malformed (missing required field)', () => {
    const malformed = makeValidIntentTension();
    delete malformed.source; // required field missing
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'some root cause',
          intentTension: malformed,
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    const record = res.records[0]!;
    expect(record.intentTension).toBeUndefined();
    // rootCause should still be extracted (independent of intentTension validity)
    expect(record.rootCauseSummary).toBe('some root cause');
    // degradation should be observable
    expect(record.degradedReason).toBeDefined();
  });

  it('degrades visibly when artifact content_json is not valid JSON', () => {
    const params = makeBaseParams({
      diagnosticArtifacts: [
        { task_id: 'diagnosis_manual_1', content_json: '{not valid json' },
      ],
    });

    const res = assembleEvidenceChain(params);
    const record = res.records[0]!;
    expect(record.intentTension).toBeUndefined();
    expect(record.rootCauseSummary).toBeUndefined();
    expect(record.degradedReason).toBeDefined();
  });

  it('rejects intentTension with invalid source enum', () => {
    const invalid = makeValidIntentTension();
    invalid.source = 'definitely_drift'; // not a valid enum
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'some root cause',
          intentTension: invalid,
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.intentTension).toBeUndefined();
  });

  it('rejects intentTension with invalid suggestedOwnerAction enum', () => {
    const invalid = makeValidIntentTension();
    invalid.suggestedOwnerAction = 'auto_apply'; // not a valid enum
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'some root cause',
          intentTension: invalid,
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.intentTension).toBeUndefined();
  });

  it('truncates evidence array to max 3 items', () => {
    const oversized = makeValidIntentTension();
    oversized.evidence = ['e1', 'e2', 'e3', 'e4', 'e5'];
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'some root cause',
          intentTension: oversized,
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.intentTension!.evidence).toHaveLength(3);
  });

  it('rejects intentTension.evidence when not an array', () => {
    const invalid = makeValidIntentTension();
    invalid.evidence = 'not an array';
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'some root cause',
          intentTension: invalid,
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.intentTension).toBeUndefined();
  });

  it('rejects intentTension.relatedIntentFields with invalid enum element', () => {
    const invalid = makeValidIntentTension();
    invalid.relatedIntentFields = ['why', 'invalid_field'];
    const params = makeBaseParams({
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'some root cause',
          intentTension: invalid,
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.intentTension).toBeUndefined();
  });

  it('falls back to tasks.diagnostic_json rootCause when no diagnosticArtifacts (test-fixture compat)', () => {
    const params = makeBaseParams({
      tasks: [
        {
          task_id: 'diagnosis_manual_1',
          task_kind: 'diagnostician',
          status: 'succeeded',
          created_at: '2026-06-26T10:01:00.000Z',
          input_ref: 'pain_1',
          diagnostic_json: JSON.stringify({ rootCause: 'Fixture root cause.' }),
        },
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.rootCauseSummary).toBe('Fixture root cause.');
    expect(res.records[0]!.intentTension).toBeUndefined();
  });

  it('artifact takes precedence over tasks.diagnostic_json for rootCause', () => {
    const params = makeBaseParams({
      tasks: [
        {
          task_id: 'diagnosis_manual_1',
          task_kind: 'diagnostician',
          status: 'succeeded',
          created_at: '2026-06-26T10:01:00.000Z',
          input_ref: 'pain_1',
          diagnostic_json: JSON.stringify({ rootCause: 'Stale fixture root cause.' }),
        },
      ],
      diagnosticArtifacts: [
        makeArtifact('diagnosis_manual_1', {
          rootCause: 'Authoritative artifact root cause.',
          intentTension: makeValidIntentTension(),
        }),
      ],
    });

    const res = assembleEvidenceChain(params);
    expect(res.records[0]!.rootCauseSummary).toBe('Authoritative artifact root cause.');
    expect(res.records[0]!.intentTension).toBeDefined();
  });

  it('handles missing diagnosticArtifacts param (backward compat, no breakage)', () => {
    const params = makeBaseParams();
    // diagnosticArtifacts not provided
    const res = assembleEvidenceChain(params);
    expect(res.records.length).toBe(1);
    expect(res.records[0]!.intentTension).toBeUndefined();
  });

  it('IntentTension type has no confidence field (compile-time guarantee)', () => {
    // This is a type-level test — if IntentTension accidentally includes
    // `confidence`, this assignment would compile, breaking the SPEC §16.3 guard.
    const record: IntentTension = {
      source: 'none',
      evidenceStrength: 'weak',
      relatedIntentFields: [],
      evidence: [],
      explanation: 'no tension',
      suggestedOwnerAction: 'dismiss',
    };
    // @ts-expect-error — confidence must NOT exist on IntentTension
    record.confidence = 0.5;
    expect(record.source).toBe('none');
  });
});
