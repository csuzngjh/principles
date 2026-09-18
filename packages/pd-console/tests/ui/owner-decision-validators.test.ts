/**
 * Codex review P2 regression: the inbox validator must reject malformed
 * entries (e.g. `[null]` from a version-skewed server) instead of letting
 * FocusPage crash on item.inbox.attention / item.principleId.
 */
import { describe, expect, it } from 'vitest';
import { validateOwnerDecisionInbox } from '../../src/ui/utils/validators.js';

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
