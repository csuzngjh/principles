import { describe, it, expect } from 'vitest';
import {
  mapConfidenceLabel,
  buildCardLayers,
  buildDebugIdSummary,
  shouldRenderIntentTensionPanel,
  shouldRenderFollowUpActions,
  buildIntentDecisionPayload,
  isAgentReportedOwnerApproved,
  resolveProvenanceBadge,
  resolveSourceDisplayLabel,
  AGENT_REPORTED_PROVENANCE_LABEL_KEY,
  AGENT_REPORTED_AUTHORIZATION_UNVERIFIED_KEY,
  MCP_AGENT_ASSISTED_SOURCE_KIND,
  MCP_AGENT_ASSISTED_SOURCE_LABEL_KEY,
  type IntentDecisionContext,
  type RecordData,
} from '../../src/ui/pages/pain/pain-card-helpers.js';
import { enumLabel } from '../../src/ui/utils/enum-labels.js';
import { validateEvidenceChain } from '../../src/ui/utils/validators.js';
import type { IntentTensionData, IntentDecisionRecordData } from '../../src/ui/utils/validators.js';
import zhCN from '../../src/ui/i18n/zh-CN.json';
import en from '../../src/ui/i18n/en.json';

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

// ── SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.6.4: three-tier source display ────

/**
 * Minimal i18next-compatible `t` for tests: walks the dot path and returns the
 * key itself when it is missing (i18next's default `returnNull` behavior), so
 * `enumLabel`'s i18n-first fallback chain is exercised for real.
 */
function makeT(dict: unknown): (key: string) => string {
  return (key: string): string => {
    let node: unknown = dict;
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null) return key;
      const next: unknown = Object.getOwnPropertyDescriptor(node, part)?.value;
      if (next === undefined) return key;
      node = next;
    }
    return typeof node === 'string' ? node : key;
  };
}

/**
 * Test-only alias for the production resolver. Keeping a single implementation
 * (instead of a mirrored copy) means this suite can never pass while the real
 * card rendering path drifts.
 */
const resolveDisplayedSourceLabel = resolveSourceDisplayLabel;

describe('pain card — three-tier provenance/source display', () => {
  const zhT = makeT(zhCN);
  const enT = makeT(en);
  const zhPain = zhCN.pages.pain;
  const enPain = en.pages.pain;

  // A record that reached PD through the MCP agent-assisted channel.
  const mcpUnverified: RecordData = { ...MINIMAL_RECORD, sourceKind: MCP_AGENT_ASSISTED_SOURCE_KIND };

  it('tier 1: agent_reported_owner_approved uses the authorized wording', () => {
    const record: RecordData = { ...mcpUnverified, provenance: 'agent_reported_owner_approved' };
    expect(resolveProvenanceBadge(record)).toEqual({
      kind: 'authorized_agent_report',
      labelKey: AGENT_REPORTED_PROVENANCE_LABEL_KEY,
    });
    expect(isAgentReportedOwnerApproved(record)).toBe(true);
    expect(resolveDisplayedSourceLabel(record, zhT)).toBe('智能体报告，拥有者已授权');
    expect(resolveDisplayedSourceLabel(record, enT)).toBe('Reported by an agent, authorized by the Owner');
  });

  it('tier 2: MCP record without provenance says the authorization cannot be verified', () => {
    expect(resolveProvenanceBadge(mcpUnverified)).toEqual({
      kind: 'unverified_agent_report',
      labelKey: AGENT_REPORTED_AUTHORIZATION_UNVERIFIED_KEY,
    });
    const zhLabel = resolveDisplayedSourceLabel(mcpUnverified, zhT);
    const enLabel = resolveDisplayedSourceLabel(mcpUnverified, enT);
    expect(zhLabel).toBe('智能体报告（授权信息不可验证）');
    expect(enLabel).toBe('Agent-reported (authorization unverified)');

    // Missing provenance must NEVER be presented as Owner authorization.
    expect(zhLabel).not.toContain('已授权');
    expect(enLabel.toLowerCase()).not.toContain('authorized by the owner');
    expect(isAgentReportedOwnerApproved(mcpUnverified)).toBe(false);
  });

  it('tier 2: an unknown provenance normalized to undefined degrades the same way', () => {
    // normalizePainProvenance() drops unknown values → the read model has no
    // provenance at all. This is the exact shape that reaches the card.
    const normalized: RecordData = { ...mcpUnverified };
    expect(normalized.provenance).toBeUndefined();
    expect(resolveProvenanceBadge(normalized).kind).toBe('unverified_agent_report');
    expect(resolveDisplayedSourceLabel(normalized, zhT)).toBe('智能体报告（授权信息不可验证）');
  });

  it('tier 2: unparseable diagnostic_json still degrades to the unverified label', () => {
    // Core marks the record `diagnosticJsonDegraded` and leaves provenance
    // undefined (see evidence-chain-provenance.test.ts). The card must still
    // degrade instead of exposing the raw source kind.
    const degraded: RecordData = {
      ...mcpUnverified,
      degradedReason: 'Diagnostic data for this record could not be parsed',
    };
    expect(resolveProvenanceBadge(degraded).kind).toBe('unverified_agent_report');
    expect(resolveDisplayedSourceLabel(degraded, enT)).toBe('Agent-reported (authorization unverified)');
  });

  it('tier 3: mcp_agent_assisted has a generic neutral source label', () => {
    // e.g. a legacy provenance that is NOT Owner authorization: the source
    // falls back to its neutral label instead of the raw enum.
    const record: RecordData = { ...mcpUnverified, provenance: 'host_context_bound' };
    expect(resolveProvenanceBadge(record).kind).toBe('source_kind');
    expect(resolveDisplayedSourceLabel(record, zhT)).toBe('智能体辅助提交');
    expect(resolveDisplayedSourceLabel(record, enT)).toBe('Agent-assisted submission');
  });

  it('legacy provenance values keep the unchanged source-kind path', () => {
    for (const provenance of ['host_context_bound', 'owner_reported_no_host_trace', 'automatic_hook'] as const) {
      const record: RecordData = { ...FULL_RECORD, provenance };
      expect(resolveProvenanceBadge(record).kind).toBe('source_kind');
      expect(isAgentReportedOwnerApproved(record)).toBe(false);
      // Same label as the pre-existing behavior (i18n has no common.enums entry
      // for `manual`, so the local map is authoritative in both locales).
      expect(resolveDisplayedSourceLabel(record, zhT)).toBe(enumLabel('sourceKind', 'manual'));
      expect(resolveDisplayedSourceLabel(record, enT)).toBe(enumLabel('sourceKind', 'manual'));
    }
  });

  it('manual / tool_call / rulehost keep their existing labels', () => {
    const expected: Record<string, string> = {
      manual: '手动触发',
      tool_call: '工具调用',
      rulehost: '规则守卫',
    };
    for (const sourceKind of ['manual', 'tool_call', 'rulehost'] as const) {
      const record: RecordData = { ...MINIMAL_RECORD, sourceKind };
      expect(resolveProvenanceBadge(record).kind).toBe('source_kind');
      expect(resolveDisplayedSourceLabel(record, zhT)).toBe(expected[sourceKind]);
    }
  });

  it('never renders the internal enum literals in either locale', () => {
    const records: RecordData[] = [
      { ...mcpUnverified, provenance: 'agent_reported_owner_approved' },
      mcpUnverified,
      { ...mcpUnverified, provenance: 'host_context_bound' },
      { ...mcpUnverified, provenance: 'owner_reported_no_host_trace' },
      { ...mcpUnverified, provenance: 'automatic_hook' },
      MINIMAL_RECORD,
    ];
    for (const t of [zhT, enT]) {
      for (const record of records) {
        const label = resolveDisplayedSourceLabel(record, t);
        expect(label).not.toContain('mcp_agent_assisted');
        expect(label).not.toContain('agent_reported_owner_approved');
        expect(label).not.toContain('host_context_bound');
        expect(label).not.toContain('owner_reported_no_host_trace');
        expect(label).not.toContain('automatic_hook');
        // Never read as the Owner's own observation.
        expect(label).not.toContain('拥有者观察');
        expect(label.toLowerCase()).not.toContain('owner observed');
      }
    }
  });

  it('keeps zh-CN / en wording and i18n keys in sync', () => {
    expect(AGENT_REPORTED_AUTHORIZATION_UNVERIFIED_KEY).toBe('pages.pain.provenanceAgentReportedAuthorizationUnverified');
    expect(MCP_AGENT_ASSISTED_SOURCE_LABEL_KEY).toBe('common.enums.sourceKind.mcp_agent_assisted');
    expect(zhPain.provenanceAgentReportedAuthorizationUnverified).toBe('智能体报告（授权信息不可验证）');
    expect(enPain.provenanceAgentReportedAuthorizationUnverified).toBe('Agent-reported (authorization unverified)');
    expect(zhCN.common.enums.sourceKind.mcp_agent_assisted).toBe('智能体辅助提交');
    expect(en.common.enums.sourceKind.mcp_agent_assisted).toBe('Agent-assisted submission');
  });
});

// ── SPEC §6.6.4: every Owner-facing surface uses the safe display value ──────

/**
 * Layer 1 (badge), Layer 3 (expanded technical details) and the copied debug
 * summary must all render the SAME safe label. This suite pins all three so a
 * future change cannot fix one surface while leaking the raw enum in another.
 */
describe('pain card — Owner-facing source label consistency', () => {
  const zhT = makeT(zhCN);
  const enT = makeT(en);

  const mcpRecord: RecordData = { ...MINIMAL_RECORD, sourceKind: MCP_AGENT_ASSISTED_SOURCE_KIND };

  const INTERNAL_ENUM_LITERALS = [
    'mcp_agent_assisted',
    'agent_reported_owner_approved',
    'host_context_bound',
    'owner_reported_no_host_trace',
    'automatic_hook',
  ];

  function expectNoInternalEnum(text: string): void {
    for (const literal of INTERNAL_ENUM_LITERALS) {
      expect(text).not.toContain(literal);
    }
  }

  /** Assert Layer 1, Layer 3 and the debug summary all carry `expected`. */
  function expectAllSurfaces(record: RecordData, expected: string, t: (key: string) => string): void {
    const layers = buildCardLayers(record, t);
    expect(layers.layer1.sourceLabel).toBe(expected);
    expect(layers.layer3.sourceLabel).toBe(expected);
    expect(buildDebugIdSummary(record, t)).toContain(`source_kind: ${expected}`);

    expectNoInternalEnum(layers.layer1.sourceLabel);
    expectNoInternalEnum(layers.layer3.sourceLabel);
    expectNoInternalEnum(buildDebugIdSummary(record, t));
  }

  it('scenario 1 — verified provenance shows the authorized wording everywhere', () => {
    const record: RecordData = { ...mcpRecord, provenance: 'agent_reported_owner_approved' };
    expectAllSurfaces(record, '智能体报告，拥有者已授权', zhT);
    expectAllSurfaces(record, 'Reported by an agent, authorized by the Owner', enT);
  });

  it('scenario 2 — missing provenance degrades to "authorization unverified" everywhere', () => {
    expect(mcpRecord.provenance).toBeUndefined();
    expectAllSurfaces(mcpRecord, '智能体报告（授权信息不可验证）', zhT);
    const enLabel = 'Agent-reported (authorization unverified)';
    expectAllSurfaces(mcpRecord, enLabel, enT);
    // Never claim authorization the data does not support.
    expect(buildCardLayers(mcpRecord, zhT).layer3.sourceLabel).not.toContain('已授权');
    expect(buildCardLayers(mcpRecord, enT).layer3.sourceLabel.toLowerCase()).not.toContain('authorized by the owner');
  });

  it('scenario 3 — invalid provenance is dropped by the trust boundary, then degrades', () => {
    // Feed the real validator, exactly as /api/evidence-chain responses do.
    const validated = validateEvidenceChain({
      records: [
        {
          id: 'pain_invalid_provenance',
          sourceKind: MCP_AGENT_ASSISTED_SOURCE_KIND,
          observedAt: '2026-06-08T16:00:00.000Z',
          state: 'recorded-only',
          summary: 'Agent reported a behavior',
          provenance: 'owner_observed_directly',
        },
      ],
      generatedAt: '2026-06-08T16:00:00.000Z',
    });
    expect(validated).not.toBeNull();
    const record = validated!.records[0];
    expect(record.provenance).toBeUndefined();
    expectAllSurfaces(record, '智能体报告（授权信息不可验证）', zhT);
  });

  it('scenario 4 — unparseable diagnostic_json degrades on every surface', () => {
    // Core leaves provenance undefined and flags the degraded reason when
    // tasks.diagnostic_json cannot be parsed.
    const record: RecordData = {
      ...mcpRecord,
      degradedReason: 'Diagnostic data for this record could not be parsed',
    };
    expectAllSurfaces(record, '智能体报告（授权信息不可验证）', zhT);
    expectAllSurfaces(record, 'Agent-reported (authorization unverified)', enT);
  });

  it('scenario 5 — expanded technical details never show the raw source kind', () => {
    const record: RecordData = { ...mcpRecord, provenance: 'agent_reported_owner_approved' };
    const { layer3 } = buildCardLayers(record, zhT);
    expect(layer3.sourceLabel).toBe('智能体报告，拥有者已授权');
    expectNoInternalEnum(layer3.sourceLabel);
    // Layer 3 still carries the technical IDs — the label change must not
    // remove the diagnostic information Owners copy for developers.
    expect(layer3.id).toBe(record.id);
  });

  it('scenario 6 — copied debug summary never shows the raw source kind', () => {
    const authorized: RecordData = { ...mcpRecord, provenance: 'agent_reported_owner_approved' };
    const authorizedSummary = buildDebugIdSummary(authorized, zhT);
    expect(authorizedSummary).toContain('source_kind: 智能体报告，拥有者已授权');
    expectNoInternalEnum(authorizedSummary);

    const unverifiedSummary = buildDebugIdSummary(mcpRecord, enT);
    expect(unverifiedSummary).toContain('source_kind: Agent-reported (authorization unverified)');
    expectNoInternalEnum(unverifiedSummary);
  });

  it('legacy sources keep their exact previous labels on all surfaces', () => {
    const expected: Record<string, string> = {
      manual: '手动触发',
      tool_call: '工具调用',
      rulehost: '规则守卫',
    };
    for (const sourceKind of ['manual', 'tool_call', 'rulehost'] as const) {
      expectAllSurfaces({ ...MINIMAL_RECORD, sourceKind }, expected[sourceKind], zhT);
      expectAllSurfaces({ ...MINIMAL_RECORD, sourceKind }, enumLabel('sourceKind', sourceKind), enT);
    }
  });
});

