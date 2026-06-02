/**
 * Tests for injectRunnerLineageIfAbsent helper.
 *
 * Covers:
 *   - Missing taskId → injected
 *   - taskId: '' → NOT overwritten (fail loud)
 *   - taskId: 0 → NOT overwritten (fail loud)
 *   - taskId: false → NOT overwritten (fail loud)
 *   - taskId: null → NOT overwritten (fail loud)
 *   - taskId: wrong string → NOT overwritten (fail loud)
 *   - non-object input → no-op
 *   - array input → no-op
 *
 * @see ERR-049, Runtime Contract Rule 3
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { injectRunnerLineageIfAbsent } from '../peer-runner-contracts.js';

describe('injectRunnerLineageIfAbsent', () => {
  const RUNNER_TASK_ID = 'task-abc-123';

  it('injects taskId when property is absent', () => {
    const output = { candidates: [] };
    injectRunnerLineageIfAbsent(output, 'taskId', RUNNER_TASK_ID);
    expect(output).toEqual({ candidates: [], taskId: RUNNER_TASK_ID });
  });

  it('does NOT overwrite taskId: empty string', () => {
    const output: Record<string, unknown> = { taskId: '' };
    injectRunnerLineageIfAbsent(output, 'taskId', RUNNER_TASK_ID);
    expect(output.taskId).toBe('');
  });

  it('does NOT overwrite taskId: 0', () => {
    const output: Record<string, unknown> = { taskId: 0 };
    injectRunnerLineageIfAbsent(output, 'taskId', RUNNER_TASK_ID);
    expect(output.taskId).toBe(0);
  });

  it('does NOT overwrite taskId: false', () => {
    const output: Record<string, unknown> = { taskId: false };
    injectRunnerLineageIfAbsent(output, 'taskId', RUNNER_TASK_ID);
    expect(output.taskId).toBe(false);
  });

  it('does NOT overwrite taskId: null', () => {
    const output: Record<string, unknown> = { taskId: null };
    injectRunnerLineageIfAbsent(output, 'taskId', RUNNER_TASK_ID);
    expect(output.taskId).toBe(null);
  });

  it('does NOT overwrite taskId: wrong string', () => {
    const output: Record<string, unknown> = { taskId: 'wrong-task-id' };
    injectRunnerLineageIfAbsent(output, 'taskId', RUNNER_TASK_ID);
    expect(output.taskId).toBe('wrong-task-id');
  });

  it('does NOT overwrite taskId: undefined (property present but undefined)', () => {
    const output: Record<string, unknown> = { taskId: undefined };
    injectRunnerLineageIfAbsent(output, 'taskId', RUNNER_TASK_ID);
    // Object.hasOwn returns true for { taskId: undefined }
    expect(output.taskId).toBeUndefined();
  });

  it('is a no-op on null input', () => {
    expect(() => injectRunnerLineageIfAbsent(null, 'taskId', RUNNER_TASK_ID)).not.toThrow();
  });

  it('is a no-op on array input', () => {
    const arr = [1, 2, 3];
    injectRunnerLineageIfAbsent(arr, 'taskId', RUNNER_TASK_ID);
    expect(arr).toEqual([1, 2, 3]);
  });

  it('is a no-op on primitive input', () => {
    expect(() => injectRunnerLineageIfAbsent('hello', 'taskId', RUNNER_TASK_ID)).not.toThrow();
    expect(() => injectRunnerLineageIfAbsent(42, 'taskId', RUNNER_TASK_ID)).not.toThrow();
  });

  it('works with arbitrary lineage key, not just taskId', () => {
    const output = { data: 'test' };
    injectRunnerLineageIfAbsent(output, 'sourcePainId', 'pain-456');
    expect((output as Record<string, unknown>).sourcePainId).toBe('pain-456');
  });
});

describe('static regression: no truthiness pattern in runners', () => {
  it.each([
    'dreamer-runner.ts',
    'philosopher-runner.ts',
    'scribe-runner.ts',
    'artificer-runner.ts',
    'evaluator-runner.ts',
    'rollout-reviewer-runner.ts',
    'trainer-runner.ts',
  ])('%s does not use truthiness check for taskId reinjection', (filename) => {
    // Read the source file and verify the old pattern is gone
    const filePath = resolve(__dirname, '..', filename);
    const source = readFileSync(filePath, 'utf8');
    // The old pattern: if (!(output as unknown as Record<string, unknown>).taskId)
    expect(source).not.toMatch(/!\(output as unknown as Record<string, unknown>\)\.taskId/);
    // The new pattern: injectRunnerLineageIfAbsent
    expect(source).toContain('injectRunnerLineageIfAbsent');
  });
});
