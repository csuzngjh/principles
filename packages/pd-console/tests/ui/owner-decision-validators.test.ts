/**
 * Codex review P2 regression: the inbox validator must reject malformed
 * entries (e.g. `[null]` from a version-skewed server) instead of letting
 * FocusPage crash on item.inbox.attention / item.principleId.
 */
import { describe, expect, it } from 'vitest';
import { validateOwnerDecisionInbox, validateOwnerDecisionsData } from '../../src/ui/utils/validators.js';

function validItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    principleId: 'prin-1',
    decisionState: 'needs_owner_decision',
    learnedPrinciple: { status: 'known', text: '主任务未完成前不得推进次要议题。', sourceTier: 'scribe' },
    inbox: { group: 'decision', attention: 'individual' },
    blockerCodes: [],
    nextAction: { code: 'review', ownerText: '有一项决定需要你审阅。', targetRefs: [] },
    ...overrides,
  };
}

describe('validateOwnerDecisionInbox — entry-level structural validation (Codex P2)', () => {
  it('accepts a well-formed inbox response', () => {
    const result = validateOwnerDecisionInbox({
      schemaVersion: '1', generatedAt: '2026-09-18T10:00:00.000Z', totalPrinciples: 1,
      groups: { decision: [validItem()], blocked: [], recovery: [] },
      historicalUnknown: { count: 0, reasonText: '' },
    });
    expect(result).not.toBeNull();
  });

  it('rejects a null entry inside a group instead of passing it to the renderer', () => {
    const result = validateOwnerDecisionInbox({
      schemaVersion: '1', generatedAt: '2026-09-18T10:00:00.000Z', totalPrinciples: 1,
      groups: { decision: [null], blocked: [], recovery: [] },
      historicalUnknown: { count: 0, reasonText: '' },
    });
    expect(result).toBeNull();
  });

  it('rejects entries missing nextAction.ownerText (renderer dereferences it)', () => {
    const item = validItem();
    delete (item as Record<string, unknown>).nextAction;
    const result = validateOwnerDecisionInbox({
      schemaVersion: '1', generatedAt: '2026-09-18T10:00:00.000Z', totalPrinciples: 1,
      groups: { decision: [item], blocked: [], recovery: [] },
      historicalUnknown: { count: 0, reasonText: '' },
    });
    expect(result).toBeNull();
  });

  it('rejects an unknown inbox group value', () => {
    const result = validateOwnerDecisionInbox({
      schemaVersion: '1', generatedAt: '2026-09-18T10:00:00.000Z', totalPrinciples: 1,
      groups: { decision: [validItem({ inbox: { group: 'anomaly', attention: 'individual' } })], blocked: [], recovery: [] },
      historicalUnknown: { count: 0, reasonText: '' },
    });
    expect(result).toBeNull();
  });
});

/**
 * 5B-E: `readIssues` was emitted by the server (#2480) but dropped by this
 * validator, so the Focus page could never render it. These assertions cover
 * the whitelist: present-and-valid is kept, absent defaults to [], and a
 * malformed entry rejects the whole payload (rc-3) instead of rendering a
 * partial list that looks complete.
 */
function validDecisionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewKey: 'rk-1',
    kind: 'rulecode_decision',
    taskId: 'task-1',
    title: '规则归属待决定',
    summary: '规则在 shadow 窗口内稳定。',
    reasonCode: 'shadow_ready',
    legacy: false,
    allowedActions: ['promote'],
    expectedRevisionEpoch: 2,
    expectedSourceRunId: 'run-1',
    expectedSourceArtifactId: 'art-1',
    expectedSourceArtifactHash: 'hash-1',
    createdAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

function decisionsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [validDecisionItem()],
    total: 1,
    generatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateOwnerDecisionsData — readIssues whitelist (5B-E)', () => {
  it('keeps a well-formed readIssues entry', () => {
    const result = validateOwnerDecisionsData(decisionsPayload({
      readIssues: [{
        scope: 'rulecode_shadow',
        reason: 'shadow_scan_unavailable',
        count: 2,
        sampleActivationIds: ['act-1', 'act-2'],
        detail: 'state.db missing',
      }],
    }));
    expect(result).not.toBeNull();
    expect(result?.readIssues).toEqual([{
      scope: 'rulecode_shadow',
      reason: 'shadow_scan_unavailable',
      count: 2,
      sampleActivationIds: ['act-1', 'act-2'],
      detail: 'state.db missing',
    }]);
  });

  it('defaults readIssues to [] when an older server omits it', () => {
    const result = validateOwnerDecisionsData(decisionsPayload());
    expect(result).not.toBeNull();
    expect(result?.readIssues).toEqual([]);
  });

  it('rejects a non-array readIssues instead of silently ignoring it', () => {
    expect(validateOwnerDecisionsData(decisionsPayload({ readIssues: {} }))).toBeNull();
  });

  it('rejects an unknown read reason', () => {
    expect(validateOwnerDecisionsData(decisionsPayload({
      readIssues: [{ scope: 'rulecode_shadow', reason: 'made_up', count: 1, sampleActivationIds: [] }],
    }))).toBeNull();
  });

  it('rejects a wrong scope, a non-positive count, or non-string sample ids', () => {
    const base = { scope: 'rulecode_shadow', reason: 'owner_review_read_failed', count: 1, sampleActivationIds: ['act-1'] };
    expect(validateOwnerDecisionsData(decisionsPayload({ readIssues: [{ ...base, scope: 'other' }] }))).toBeNull();
    expect(validateOwnerDecisionsData(decisionsPayload({ readIssues: [{ ...base, count: 0 }] }))).toBeNull();
    expect(validateOwnerDecisionsData(decisionsPayload({ readIssues: [{ ...base, count: 1.5 }] }))).toBeNull();
    expect(validateOwnerDecisionsData(decisionsPayload({ readIssues: [{ ...base, sampleActivationIds: [1] }] }))).toBeNull();
    expect(validateOwnerDecisionsData(decisionsPayload({ readIssues: [{ ...base, sampleActivationIds: 'act-1' }] }))).toBeNull();
  });

  it('rejects a non-string detail', () => {
    expect(validateOwnerDecisionsData(decisionsPayload({
      readIssues: [{ scope: 'rulecode_shadow', reason: 'readiness_not_actionable', count: 1, sampleActivationIds: [], detail: 7 }],
    }))).toBeNull();
  });
});

