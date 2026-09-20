/**
 * PRI-875 review fixes — blocker localization must never leak the `{{n}}`
 * placeholder, and the runtime validator must reject a malformed optional
 * `count` from a version-skewed server (CodeRabbit P2 on PR #1780).
 */
import { describe, expect, it } from 'vitest';
import { localizeAggregatedBlocker, isValidAggregatedCount } from '../../src/ui/utils/blocker-localization.js';
import { isOwnerDecisionViewCore } from '../../src/ui/utils/validators.js';

const BLOCKER_KEY = 'principles.detail.ownerDecision.blocker.historical_processing_issue';
const AGGREGATED_OWNER_TEXT = '存在 3 个历史处理问题（如失败或等待重试的任务），其与当前操作的关系尚未确认。';
const OLD_CORE_OWNER_TEXT = '存在历史处理问题，其与当前操作的关系尚未确认。';

/** Fake t(): mirrors i18next — resolves the locale template, interpolating n when provided. */
function makeT(calls: Array<{ key: string; opts?: Record<string, unknown> }> = []) {
  return (key: string, opts?: Record<string, unknown>): string => {
    calls.push({ key, opts });
    if (key === BLOCKER_KEY) {
      return opts !== undefined && 'n' in opts ? `存在 ${(opts as { n: number }).n} 个历史处理问题` : '存在 {{n}} 个历史处理问题';
    }
    if (key.endsWith('lineage_not_available')) return '治理身份尚未建立，系统暂时无法判断是否需要你决定。';
    return '';
  };
}

describe('localizeAggregatedBlocker — {{n}} placeholder safety (PRI-875 P2)', () => {
  it('valid count → interpolates the locale template with n', () => {
    const calls: Array<{ key: string; opts?: Record<string, unknown> }> = [];
    const text = localizeAggregatedBlocker(
      { code: 'historical_processing_issue', ownerText: AGGREGATED_OWNER_TEXT, count: 3 },
      makeT(calls),
    );
    expect(text).toBe('存在 3 个历史处理问题');
    expect(calls[0]?.opts).toMatchObject({ n: 3 });
  });

  it('missing count (older core) → ownerText, template never touched', () => {
    const calls: Array<{ key: string; opts?: Record<string, unknown> }> = [];
    const text = localizeAggregatedBlocker(
      { code: 'historical_processing_issue', ownerText: OLD_CORE_OWNER_TEXT, count: undefined },
      makeT(calls),
    );
    expect(text).toBe(OLD_CORE_OWNER_TEXT);
    expect(calls).toHaveLength(0);
  });

  it.each([0, -2, 2.5, '3', null])('malformed count %p → ownerText, no placeholder leak', (badCount) => {
    const text = localizeAggregatedBlocker(
      { code: 'historical_processing_issue', ownerText: OLD_CORE_OWNER_TEXT, count: badCount },
      makeT(),
    );
    expect(text).toBe(OLD_CORE_OWNER_TEXT);
    expect(text).not.toContain('{{');
  });

  it('plain blocker codes keep the normal template path', () => {
    const text = localizeAggregatedBlocker(
      { code: 'lineage_not_available', ownerText: '核心 ownerText', count: undefined },
      makeT(),
    );
    expect(text).toBe('治理身份尚未建立，系统暂时无法判断是否需要你决定。');
  });

  it('unknown code with no locale entry → ownerText fallback still works', () => {
    const text = localizeAggregatedBlocker({ code: 'source_unavailable:ledger', ownerText: '数据源读取失败。' }, makeT());
    expect(text).toBe('数据源读取失败。');
  });

  it('isValidAggregatedCount accepts only integers ≥ 1', () => {
    expect(isValidAggregatedCount(1)).toBe(true);
    expect(isValidAggregatedCount(38)).toBe(true);
    expect(isValidAggregatedCount(0)).toBe(false);
    expect(isValidAggregatedCount(-1)).toBe(false);
    expect(isValidAggregatedCount(1.5)).toBe(false);
    expect(isValidAggregatedCount('3')).toBe(false);
    expect(isValidAggregatedCount(undefined)).toBe(false);
    expect(isValidAggregatedCount(null)).toBe(false);
  });
});

// ── validator: optional count is shape-checked when present ──────────────────

function validView(blockerReason: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: '1',
    principleId: 'p1',
    asOf: '2026-09-20T00:00:00.000Z',
    sourceReadStatus: 'complete',
    sourceReads: [],
    incidentSummary: {},
    learnedPrinciple: { status: 'unknown', reasonText: 'x' },
    rationale: {},
    applicability: {},
    nonApplicabilityOrUnknown: {},
    expectedBehavior: {},
    currentEnforcement: {},
    evidenceSummary: {},
    uncertainty: {},
    risk: {},
    rollback: {},
    decisionState: 'recovery_needed',
    decisionSubjects: [],
    availableActions: [],
    blockers: [{ subjectKey: 'p1', kind: 'runtime', reason: blockerReason }],
    nextAction: { code: 'inspect_recovery', ownerText: 'x' },
    inbox: { group: 'recovery', attention: 'none', reason: { code: 'c', ownerText: 'o', sourceRefs: [] } },
    technicalDetails: {},
  };
}

const baseReason = { code: 'historical_processing_issue', ownerText: 'x', sourceRefs: [{ type: 'task', id: 't1' }] };

describe('isOwnerDecisionViewCore — optional count validation (PRI-875 P2)', () => {
  it('valid integer count → view accepted', () => {
    expect(isOwnerDecisionViewCore(validView({ ...baseReason, count: 2 }))).toBe(true);
  });

  it('absent count (older core) → view still accepted', () => {
    expect(isOwnerDecisionViewCore(validView({ ...baseReason }))).toBe(true);
  });

  it.each([0, -1, 2.5, '2', null])('malformed count %p → whole view rejected', (badCount) => {
    expect(isOwnerDecisionViewCore(validView({ ...baseReason, count: badCount }))).toBe(false);
  });
});
