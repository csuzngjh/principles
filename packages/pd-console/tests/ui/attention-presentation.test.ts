/**
 * PRI-903 — the governance card groups per-task projection entries by
 * reasonCode before rendering: singleton anomalies sort first, historical
 * groups collapse into one count-bearing line. Presentation only; the
 * projection contract is untouched.
 */
import { describe, expect, it } from 'vitest';
import { groupByReasonCode, formatGroupedReasonLine } from '../../src/ui/utils/attention-presentation.js';

function taskItem(id: string, reasonCode: string) {
  return { kind: 'recovery' as const, reasonCode, sourceRef: { type: 'task' as const, id } };
}

describe('groupByReasonCode — governance card flood guard (PRI-903)', () => {
  it('collapses repeated reasonCodes into one count-bearing group', () => {
    const groups = groupByReasonCode([
      taskItem('t1', 'revision_not_materialized'),
      taskItem('t2', 'revision_not_materialized'),
      taskItem('t3', 'revision_not_materialized'),
    ]);
    expect(groups).toEqual([{ reasonCode: 'revision_not_materialized', count: 3 }]);
  });

  it('sorts singleton anomalies above large historical groups', () => {
    const groups = groupByReasonCode([
      ...Array.from({ length: 5 }, (_, index) => taskItem(`rev-${index}`, 'revision_not_materialized')),
      taskItem('fail-1', 'task_failed'),
    ]);
    expect(groups.map(group => group.reasonCode)).toEqual(['task_failed', 'revision_not_materialized']);
  });

  it('keeps equal-count groups in first-appearance (projection) order', () => {
    const groups = groupByReasonCode([
      taskItem('v1', 'verdict_missing'),
      taskItem('f1', 'task_failed'),
    ]);
    expect(groups.map(group => group.reasonCode)).toEqual(['verdict_missing', 'task_failed']);
  });

  it('keeps distinct reasonCodes unmerged and counts each group', () => {
    const groups = groupByReasonCode([
      taskItem('r1', 'revision_not_materialized'),
      taskItem('v1', 'verdict_missing'),
      taskItem('r2', 'revision_not_materialized'),
    ]);
    expect(groups).toContainEqual({ reasonCode: 'revision_not_materialized', count: 2 });
    expect(groups).toContainEqual({ reasonCode: 'verdict_missing', count: 1 });
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(3);
  });

  it('returns an empty list for empty input', () => {
    expect(groupByReasonCode([])).toEqual([]);
  });
});

/**
 * Mirrors tests/ui/blocker-localization.test.ts (PRI-875): the grouped line is
 * the real rendering behavior, so the interpolation path gets a fake-t test —
 * the count suffix must never render for singleton groups, and `{{n}}` must
 * interpolate an integer only.
 */
describe('formatGroupedReasonLine — count suffix interpolation (PRI-903 review)', () => {
  const ATTENTION_PREFIX = 'principles.detail.governance.attention';

  /** Fake t(): mirrors i18next — resolves the template, interpolating n when provided. */
  function makeT(calls: Array<{ key: string; opts?: Record<string, unknown> }> = []) {
    return (key: string, opts?: Record<string, unknown>): string => {
      calls.push({ key, opts });
      if (key.endsWith('.revision_not_materialized')) return '请求的修订尚未物化';
      if (key === 'principles.detail.governance.sameReasonCount') {
        return opts !== undefined && 'n' in opts ? `（共 ${(opts as { n: number }).n} 条）` : '（共 {{n}} 条）';
      }
      return '';
    };
  }

  it('appends the interpolated count suffix when the reason recurs', () => {
    const calls: Array<{ key: string; opts?: Record<string, unknown> }> = [];
    const line = formatGroupedReasonLine(makeT(calls), ATTENTION_PREFIX, { reasonCode: 'revision_not_materialized', count: 41 });
    expect(line).toBe('请求的修订尚未物化（共 41 条）');
    expect(calls[1]?.opts).toMatchObject({ n: 41 });
  });

  it('renders the bare sentence for singleton groups — suffix never touched', () => {
    const calls: Array<{ key: string; opts?: Record<string, unknown> }> = [];
    const line = formatGroupedReasonLine(makeT(calls), ATTENTION_PREFIX, { reasonCode: 'revision_not_materialized', count: 1 });
    expect(line).toBe('请求的修订尚未物化');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).not.toContain('sameReasonCount');
  });

  it('falls back to the raw reasonCode when the locale template is missing', () => {
    const line = formatGroupedReasonLine((_key, opts) => String(opts?.defaultValue ?? ''), ATTENTION_PREFIX, { reasonCode: 'unknown_code', count: 1 });
    expect(line).toBe('unknown_code');
  });
});
