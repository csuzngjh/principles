import { describe, it, expect } from 'vitest';
import {
  mapConfidenceLabel,
  buildCardLayers,
  type RecordData,
} from '../../src/ui/pages/pain/pain-card-helpers.js';

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
