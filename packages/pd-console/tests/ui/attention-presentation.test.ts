/**
 * PRI-903 — the governance card groups per-task projection entries by
 * reasonCode before rendering: singleton anomalies sort first, historical
 * groups collapse into one count-bearing line. Presentation only; the
 * projection contract is untouched.
 */
import { describe, expect, it } from 'vitest';
import { groupByReasonCode } from '../../src/ui/utils/attention-presentation.js';

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
    expect(groups).toHaveLength(1);
    expect(groups[0]?.reasonCode).toBe('revision_not_materialized');
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.items.map(item => item.sourceRef.id)).toEqual(['t1', 't2', 't3']);
  });

  it('sorts singleton anomalies above large historical groups', () => {
    const groups = groupByReasonCode([
      ...Array.from({ length: 5 }, (_, index) => taskItem(`rev-${index}`, 'revision_not_materialized')),
      taskItem('fail-1', 'task_failed'),
    ]);
    expect(groups.map(group => group.reasonCode)).toEqual(['task_failed', 'revision_not_materialized']);
  });

  it('breaks count ties deterministically by reasonCode', () => {
    const groups = groupByReasonCode([
      taskItem('v1', 'verdict_missing'),
      taskItem('f1', 'task_failed'),
    ]);
    expect(groups.map(group => group.reasonCode)).toEqual(['task_failed', 'verdict_missing']);
  });

  it('keeps distinct reasonCodes unmerged and preserves their entries in order', () => {
    const groups = groupByReasonCode([
      taskItem('r1', 'revision_not_materialized'),
      taskItem('v1', 'verdict_missing'),
      taskItem('r2', 'revision_not_materialized'),
    ]);
    expect(groups).toHaveLength(2);
    const revision = groups.find(group => group.reasonCode === 'revision_not_materialized');
    expect(revision?.count).toBe(2);
    expect(revision?.items.map(item => item.sourceRef.id)).toEqual(['r1', 'r2']);
  });

  it('returns an empty list for empty input', () => {
    expect(groupByReasonCode([])).toEqual([]);
  });
});
