import { describe, it, expect } from 'vitest';
import {
  mapConfidenceLabel,
  buildCardLayers,
  shouldRenderIntentTensionPanel,
  shouldRenderFollowUpActions,
  buildIntentDecisionPayload,
  type IntentDecisionContext,
  type RecordData,
} from '../../src/ui/pages/pain/pain-card-helpers.js';
import type { IntentTensionData, IntentDecisionRecordData } from '../../src/ui/utils/validators.js';

/**
 * PRI-344: Pure-function tests for the EvidenceChainCard refactoring.
 *
 * These tests validate the card's display logic without rendering React.
 * The vitest config in this package uses the `node` environment, so we test
 * pure functions only.
 *
 * Functions tested:
 * - mapConfidenceLabel: numeric confidence → 'high' | 'mid' | 'low'
 * - buildCardLayers: record → layer1/layer2/layer3 data
 */

// Functions are imported from pain-card-helpers.ts — see source for implementation.

// ── buildCardLayers (Step 2b: imported from source) ────────────────────────────
// See pain-card-helpers.ts for implementation.

// ── Test fixtures ──────────────────────────────────────────────────────────────

const FULL_RECORD: RecordData = {
  id: 'pain_abc123',
  sourceKind: 'manual',
  observedAt: '2026-06-08T15:30:00.000Z',
  state: 'candidate_generated',
  summary: '删除前未备份',
  candidateTitle: '操作前先备份',
  candidateSummary: '删除文件前应确认已有备份',
  rootCauseSummary: 'Agent 未检查备份状态',
  confidence: 0.8,
  recommendationKind: 'affirm',
  linkedTaskId: 'diagnosis_task_001',
  linkedTaskStatus: 'succeeded',
  linkedCandidateId: 'candidate_abc123',
  nextAction: '前往原则审查',
};

const MINIMAL_RECORD: RecordData = {
  id: 'pain_def456',
  sourceKind: 'tool_call',
  observedAt: '2026-06-08T16:00:00.000Z',
  state: 'pain_recorded',
  summary: '用户反馈',
};

// ── Tests ──────────────────────────────────────────────────────────────────────

// Use case 1: Full record with candidateTitle + confidence
describe('PRI-344 use case 1: full record rendering', () => {
  it('includes candidateTitle in layer2', () => {
    const { layer2 } = buildCardLayers(FULL_RECORD);
    expect(layer2.conclusion).toBe('操作前先备份');
  });

  it('includes confidence with label and raw value', () => {
    const { layer2 } = buildCardLayers(FULL_RECORD);
    expect(layer2.confidence).not.toBeNull();
    expect(layer2.confidence!.label).toBe('high');
    expect(layer2.confidence!.raw).toBe(0.8);
  });

  it('trigger summary is human-readable, not an ID', () => {
    const { layer2 } = buildCardLayers(FULL_RECORD);
    expect(layer2.triggerSummary).toBe('删除前未备份');
    expect(layer2.triggerSummary).not.toMatch(/^(pain_|diagnosis_|candidate_)/);
  });

  it('ID fields are in layer3 only, not layer2', () => {
    const { layer2, layer3 } = buildCardLayers(FULL_RECORD);
    // layer2 should not contain raw IDs
    const layer2Text = JSON.stringify(layer2);
    expect(layer2Text).not.toContain('pain_abc123');
    expect(layer2Text).not.toContain('diagnosis_task_001');
    expect(layer2Text).not.toContain('candidate_abc123');

    // layer3 should contain all IDs
    expect(layer3.id).toBe('pain_abc123');
    expect(layer3.linkedTaskId).toBe('diagnosis_task_001');
    expect(layer3.linkedCandidateId).toBe('candidate_abc123');
  });
});

// Use case 2: Minimal record without candidateTitle
describe('PRI-344 use case 2: minimal record without candidate', () => {
  it('includes trigger summary', () => {
    const { layer2 } = buildCardLayers(MINIMAL_RECORD);
    expect(layer2.triggerSummary).toBe('用户反馈');
  });

  it('does not render conclusion block', () => {
    const { layer2 } = buildCardLayers(MINIMAL_RECORD);
    expect(layer2.conclusion).toBeNull();
  });

  it('does not render confidence block', () => {
    const { layer2 } = buildCardLayers(MINIMAL_RECORD);
    expect(layer2.confidence).toBeNull();
  });
});

// Use case 3: confidence boundary values
describe('PRI-344 use case 3: confidence boundary mapping', () => {
  it('0.7 → high (boundary)', () => {
    expect(mapConfidenceLabel(0.7)).toBe('high');
  });

  it('0.69 → mid (just below high boundary)', () => {
    expect(mapConfidenceLabel(0.69)).toBe('mid');
  });

  it('0.4 → mid (boundary)', () => {
    expect(mapConfidenceLabel(0.4)).toBe('mid');
  });

  it('0.39 → low (just below mid boundary)', () => {
    expect(mapConfidenceLabel(0.39)).toBe('low');
  });

  it('1.0 → high (max)', () => {
    expect(mapConfidenceLabel(1.0)).toBe('high');
  });

  it('0.0 → low (min)', () => {
    expect(mapConfidenceLabel(0.0)).toBe('low');
  });

  it('0.55 → mid (middle of range)', () => {
    expect(mapConfidenceLabel(0.55)).toBe('mid');
  });
});

// Use case 4: ID fields are exclusively in layer3
describe('PRI-344 use case 4: ID position in layer3', () => {
  const record: RecordData = {
    id: 'pain_1',
    sourceKind: 'manual',
    observedAt: '2026-06-08T15:00:00.000Z',
    state: 'candidate_generated',
    summary: 'Some behavior',
    linkedTaskId: 'diagnosis_task_2',
    linkedCandidateId: 'candidate_3',
  };

  it('pain_1 only appears in layer3.id', () => {
    const { layer3 } = buildCardLayers(record);
    expect(layer3.id).toBe('pain_1');
  });

  it('diagnosis_task_2 only appears in layer3.linkedTaskId', () => {
    const { layer3 } = buildCardLayers(record);
    expect(layer3.linkedTaskId).toBe('diagnosis_task_2');
  });

  it('candidate_3 only appears in layer3.linkedCandidateId', () => {
    const { layer3 } = buildCardLayers(record);
    expect(layer3.linkedCandidateId).toBe('candidate_3');
  });

  it('layer2 text does not contain any ID prefixes', () => {
    const { layer2 } = buildCardLayers(record);
    const layer2Text = JSON.stringify(layer2);
    // Should not contain the ID-like strings
    expect(layer2Text).not.toContain('pain_1');
    expect(layer2Text).not.toContain('diagnosis_task_2');
    expect(layer2Text).not.toContain('candidate_3');
  });
});

// Applicability field: candidateSummary or rootCauseSummary
describe('PRI-344 applicability field', () => {
  it('uses candidateSummary when present', () => {
    const record: RecordData = {
      ...MINIMAL_RECORD,
      candidateSummary: '适用删除场景',
    };
    const { layer2 } = buildCardLayers(record);
    expect(layer2.applicability).toBe('适用删除场景');
  });

  it('falls back to rootCauseSummary when candidateSummary absent', () => {
    const record: RecordData = {
      ...MINIMAL_RECORD,
      rootCauseSummary: '根因是未检查备份',
    };
    const { layer2 } = buildCardLayers(record);
    expect(layer2.applicability).toBe('根因是未检查备份');
  });

  it('prefers candidateSummary over rootCauseSummary', () => {
    const record: RecordData = {
      ...MINIMAL_RECORD,
      candidateSummary: '候选摘要',
      rootCauseSummary: '根因摘要',
    };
    const { layer2 } = buildCardLayers(record);
    expect(layer2.applicability).toBe('候选摘要');
  });

  it('returns null when neither is present', () => {
    const { layer2 } = buildCardLayers(MINIMAL_RECORD);
    expect(layer2.applicability).toBeNull();
  });
});

// ── PRI-469: intentTension in buildCardLayers ─────────────────────────────────

function validIntentTension(overrides?: Partial<IntentTensionData>): IntentTensionData {
  return {
    source: 'action_drift',
    evidenceStrength: 'strong',
    relatedIntentFields: ['current_strategic_focus', 'non_negotiables'],
    evidence: ['e1', 'e2', 'e3'],
    explanation: 'The work optimized presentation completeness before validating the learning loop.',
    suggestedOwnerAction: 'confirm_drift',
    intentDocHash: 'sha256:abc123',
    ...overrides,
  };
}

describe('PRI-469: buildCardLayers maps intentTension to Layer 2', () => {
  it('maps intentTension to layer2.intentTension when present', () => {
    const record: RecordData = {
      ...MINIMAL_RECORD,
      intentTension: validIntentTension(),
    };
    const { layer2 } = buildCardLayers(record);
    expect(layer2.intentTension).not.toBeNull();
    expect(layer2.intentTension!.source).toBe('action_drift');
    expect(layer2.intentTension!.evidenceStrength).toBe('strong');
    expect(layer2.intentTension!.suggestedOwnerAction).toBe('confirm_drift');
  });

  it('sets layer2.intentTension to null when absent (backward compat)', () => {
    const { layer2 } = buildCardLayers(MINIMAL_RECORD);
    expect(layer2.intentTension).toBeNull();
  });

  it('does not leak intentTension into Layer 1 or Layer 3', () => {
    const record: RecordData = {
      ...MINIMAL_RECORD,
      intentTension: validIntentTension({ intentDocHash: 'leak-check-hash' }),
    };
    const { layer1, layer3 } = buildCardLayers(record);
    const layer1Text = JSON.stringify(layer1);
    const layer3Text = JSON.stringify(layer3);
    expect(layer1Text).not.toContain('intentTension');
    expect(layer1Text).not.toContain('action_drift');
    expect(layer3Text).not.toContain('intentTension');
    expect(layer3Text).not.toContain('leak-check-hash');
  });
});

// ── PRI-469: shouldRenderIntentTensionPanel (SPEC §22.1.3) ────────────────────

describe('PRI-469: shouldRenderIntentTensionPanel (SPEC §22.1.3)', () => {
  it('returns false for null tension', () => {
    expect(shouldRenderIntentTensionPanel(null)).toBe(false);
  });

  it('returns false for undefined tension', () => {
    expect(shouldRenderIntentTensionPanel(undefined)).toBe(false);
  });

  it('returns false for source=none (SPEC §22.1.3 suppression)', () => {
    const tension = validIntentTension({ source: 'none' });
    expect(shouldRenderIntentTensionPanel(tension)).toBe(false);
  });

  it('returns true for source=action_drift', () => {
    const tension = validIntentTension({ source: 'action_drift' });
    expect(shouldRenderIntentTensionPanel(tension)).toBe(true);
  });

  it('returns true for source=intent_suspect', () => {
    const tension = validIntentTension({ source: 'intent_suspect' });
    expect(shouldRenderIntentTensionPanel(tension)).toBe(true);
  });

  it('returns true for source=healthy_tension', () => {
    const tension = validIntentTension({ source: 'healthy_tension' });
    expect(shouldRenderIntentTensionPanel(tension)).toBe(true);
  });
});

// ── PRI-470: shouldRenderFollowUpActions (SPEC §22.1.4) ───────────────────────

function validDecisionRecord(overrides?: Partial<IntentDecisionRecordData>): IntentDecisionRecordData {
  return {
    id: 'decision_001',
    source: 'action_drift',
    evidenceStrength: 'strong',
    relatedIntentFields: ['current_strategic_focus'],
    ownerAction: 'confirm_drift',
    evidenceRefs: ['e1', 'e2'],
    createdAt: '2026-06-26T10:00:00.000Z',
    ...overrides,
  };
}

describe('PRI-470: shouldRenderFollowUpActions (SPEC §22.1.4)', () => {
  it('returns false for null', () => {
    expect(shouldRenderFollowUpActions(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(shouldRenderFollowUpActions(undefined)).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(shouldRenderFollowUpActions([])).toBe(false);
  });

  it('returns true for a non-empty decisions array', () => {
    expect(shouldRenderFollowUpActions([validDecisionRecord()])).toBe(true);
  });

  it('returns true for an array with multiple decisions', () => {
    expect(shouldRenderFollowUpActions([
      validDecisionRecord({ id: 'd1' }),
      validDecisionRecord({ id: 'd2' }),
    ])).toBe(true);
  });
});

// ── PRI-470: buildIntentDecisionPayload (SPEC §22.1) ──────────────────────────

describe('PRI-470: buildIntentDecisionPayload', () => {
  it('builds a full payload with all optional fields', () => {
    const tension = validIntentTension();
    const context: IntentDecisionContext = {
      id: 'decision-uuid-1',
      recordId: 'pain_abc',
      painId: 'pain_abc',
      taskId: 'task_123',
      intentDocHash: 'sha256:abc',
    };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'confirm_drift', note: 'my note' });
    // P0 fix (PRI-471): payload now uses server contract fields
    expect(payload.id).toBe('decision-uuid-1');
    expect(payload.taskId).toBe('task_123');
    expect(payload.source).toBe('action_drift');
    expect(payload.evidenceStrength).toBe('strong');
    expect(payload.relatedIntentFields).toEqual(['current_strategic_focus', 'non_negotiables']);
    expect(payload.evidenceRefs).toEqual(['e1', 'e2', 'e3']);
    expect(payload.ownerAction).toBe('confirm_drift');
    expect(payload.painId).toBe('pain_abc');
    expect(payload.intentDocHash).toBe('sha256:abc');
    expect(payload.note).toBe('my note');
    // Removed fields: explanation and suggestedAction are NOT in the payload
    // (P0 fix: server does not accept them — they are snapshot fields).
    expect((payload as Record<string, unknown>).explanation).toBeUndefined();
    expect((payload as Record<string, unknown>).suggestedAction).toBeUndefined();
  });

  it('falls back to recordId when taskId is undefined', () => {
    const tension = validIntentTension();
    const context: IntentDecisionContext = {
      id: 'decision-uuid-2',
      recordId: 'pain_abc',
    };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe' });
    expect(payload.taskId).toBe('pain_abc');
  });

  it('omits empty optional fields (empty painId, empty intentDocHash)', () => {
    const tension = validIntentTension();
    const context: IntentDecisionContext = {
      id: 'decision-uuid-3',
      recordId: 'pain_abc',
      painId: '',
      intentDocHash: '',
    };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe' });
    expect(payload.painId).toBeUndefined();
    expect(payload.intentDocHash).toBeUndefined();
  });

  it('omits painId and intentDocHash when not provided in context', () => {
    const tension = validIntentTension();
    const context: IntentDecisionContext = {
      id: 'decision-uuid-4',
      recordId: 'pain_abc',
    };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe' });
    expect(payload.painId).toBeUndefined();
    expect(payload.intentDocHash).toBeUndefined();
  });

  it('trims the note before including it', () => {
    const tension = validIntentTension();
    const context: IntentDecisionContext = { id: 'decision-uuid-5', recordId: 'pain_abc' };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe', note: '  trimmed note  ' });
    expect(payload.note).toBe('trimmed note');
  });

  it('omits note when it is empty after trimming', () => {
    const tension = validIntentTension();
    const context: IntentDecisionContext = { id: 'decision-uuid-6', recordId: 'pain_abc' };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe', note: '   ' });
    expect(payload.note).toBeUndefined();
  });

  it('omits note when note is undefined', () => {
    const tension = validIntentTension();
    const context: IntentDecisionContext = { id: 'decision-uuid-7', recordId: 'pain_abc' };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe' });
    expect(payload.note).toBeUndefined();
  });

  it('ownerAction is the Owner\'s chosen action (may differ from tension.suggestedOwnerAction)', () => {
    const tension = validIntentTension({ suggestedOwnerAction: 'confirm_drift' });
    const context: IntentDecisionContext = { id: 'decision-uuid-8', recordId: 'pain_abc' };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'revise_intent' });
    // ownerAction is the Owner's chosen action, which may differ from the tension's suggestion
    expect(payload.ownerAction).toBe('revise_intent');
    // P0 fix: suggestedAction is no longer in the payload (server doesn't accept it).
    expect((payload as Record<string, unknown>).suggestedAction).toBeUndefined();
  });

  it('evidenceRefs is NOT truncated (truncation is backend job)', () => {
    const longEvidence = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
    const tension = validIntentTension({ evidence: longEvidence });
    const context: IntentDecisionContext = { id: 'decision-uuid-9', recordId: 'pain_abc' };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe' });
    // All 7 evidence items are preserved — frontend does not truncate
    expect(payload.evidenceRefs).toHaveLength(7);
    expect(payload.evidenceRefs).toEqual(longEvidence);
  });

  it('preserves empty evidence array as-is', () => {
    const tension = validIntentTension({ evidence: [] });
    const context: IntentDecisionContext = { id: 'decision-uuid-10', recordId: 'pain_abc' };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction: 'observe' });
    expect(payload.evidenceRefs).toEqual([]);
  });
});
