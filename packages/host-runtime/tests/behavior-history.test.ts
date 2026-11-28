import { describe, expect, it } from 'vitest';
import { buildToolSemanticRegistry } from '@principles/core/runtime/internalization/tool-semantic-registry';
import { computeBehaviorFacts, validateRuleContextV2 } from '@principles/core/runtime';
import type { RuleHostContextRow } from '@principles/core/trajectory-types';
import { assembleBehaviorHistory } from '../src/behavior-history.js';

function makeRow(params: Record<string, unknown>, overrides: Partial<RuleHostContextRow> = {}): RuleHostContextRow {
  return {
    id: 1,
    toolName: 'Bash',
    outcome: 'success',
    paramsJson: JSON.stringify(params),
    ...overrides,
  };
}

const registryResult = buildToolSemanticRegistry([{ rawToolName: 'Bash', canonicalKind: 'execute' }]);
if (!registryResult.ok) throw new Error(registryResult.errors.join('; '));

const options = {
  projectDir: '/work/project',
  toolSemantics: registryResult.registry,
};

describe('assembleBehaviorHistory', () => {
  it('preserves opaque shell commands instead of normalizing them as file paths', () => {
    const command = 'echo docs/../secrets.json';
    const history = assembleBehaviorHistory([makeRow({ command })], false, options);

    expect(history).toMatchObject({
      status: 'available',
      calls: [{ toolName: 'Bash', normalizedPath: command }],
    });
  });

  it.each(['success', 'failure', 'blocked'] as const)('accepts the current RuleToolOutcome contract value %s', (outcome) => {
    // `blocked` is characterized only as part of the current RuleContextV2
    // type contract; this test is not evidence that a production host writer
    // currently emits it.
    const history = assembleBehaviorHistory([makeRow({ command: 'probe' }, { id: 11, outcome })], false, options);

    expect(history).toMatchObject({
      status: 'available',
      calls: [{ sequenceId: 11, outcome }],
    });
  });

  it.each([
    ['at the beginning', [11, 10, 12]],
    ['in the middle', [10, 11, 12]],
    ['at the end', [10, 12, 11]],
  ] as const)('makes the whole window unavailable when an exact production-writer unknown outcome is %s', (_label, ids) => {
    const rows = ids.map((id) => makeRow(
      { command: `probe-${id}` },
      { id, outcome: id === 11 ? 'unknown' : id === 12 ? 'failure' : 'success' },
    ));
    const history = assembleBehaviorHistory(rows, false, options);

    expect(history.status).toBe('unavailable');
    expect(history.calls).toEqual([]);
    expect(history.truncated).toBe(false);
    expect(history.unavailableReason).toBe('row id=11: outcome "unknown" is not a valid RuleToolOutcome');
  });

  it('drops truncation metadata when an invalid outcome makes the window unavailable', () => {
    const history = assembleBehaviorHistory([
      makeRow({ command: 'before' }, { id: 10, outcome: 'success' }),
      makeRow({ command: 'unknown-result' }, { id: 11, outcome: 'unknown' }),
    ], true, options);

    expect(history.status).toBe('unavailable');
    expect(history.calls).toEqual([]);
    expect(history.truncated).toBe(false);
    expect(history.unavailableReason).toBe('row id=11: outcome "unknown" is not a valid RuleToolOutcome');
  });

  it('copies database row identity into sequenceId without turning it into causal ordering evidence', () => {
    // The assembler preserves the row order supplied by its caller and copies
    // row.id verbatim. These ids are SQLite insertion-row identities only;
    // nothing in the returned record establishes action occurrence order.
    const history = assembleBehaviorHistory([
      makeRow({ command: 'first-visible-row' }, { id: 42 }),
      makeRow({ command: 'second-visible-row' }, { id: 7 }),
    ], false, options);

    expect(history.status).toBe('available');
    expect(history.calls.map((call) => call.sequenceId)).toEqual([42, 7]);
    expect(history.calls.every((call) => !Object.hasOwn(call, 'occurredAt'))).toBe(true);
  });

  it('keeps unavailable facts unknown/null instead of converting missing history to negative evidence', () => {
    const history = assembleBehaviorHistory([
      makeRow({ command: 'before' }, { id: 10, outcome: 'success' }),
      makeRow({ command: 'unknown-result' }, { id: 11, outcome: 'unknown' }),
      makeRow({ command: 'after' }, { id: 12, outcome: 'failure' }),
    ], false, options);
    const facts = computeBehaviorFacts(history, 'target.txt', 2);
    const context = { version: 2 as const, history, facts };

    expect(facts).toEqual({
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    });
    expect(validateRuleContextV2(context).valid).toBe(true);
  });
});
