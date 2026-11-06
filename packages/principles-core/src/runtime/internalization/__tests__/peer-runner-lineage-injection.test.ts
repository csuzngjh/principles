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
import { injectRunnerLineageIfAbsent, reconcileLineageEcho } from '../peer-runner-contracts.js';

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

describe('reconcileLineageEcho (PRI-541 shared lineage echo gate)', () => {
  const TASK_ID = 'scribe-001';
  const ARTIFACT_ID = 'pi-art-philosopher-001-run-001';

  it('injects absent top field and does not report it as corrected', () => {
    const output: Record<string, unknown> = { principleDraft: {} };
    const corrected = reconcileLineageEcho(output, {
      topFields: [{ field: 'taskId', authoritativeValue: TASK_ID }],
    });
    expect(output.taskId).toBe(TASK_ID);
    expect(corrected).toEqual([]);
  });

  it('overwrites wrong top-field echo and reports the field name', () => {
    const output: Record<string, unknown> = {
      taskId: 'scribe-0',
      sourcePhilosopherArtifactId: 'pi-art-philosopher-001',
    };
    const corrected = reconcileLineageEcho(output, {
      topFields: [
        { field: 'taskId', authoritativeValue: TASK_ID },
        { field: 'sourcePhilosopherArtifactId', authoritativeValue: ARTIFACT_ID },
      ],
    });
    expect(output.taskId).toBe(TASK_ID);
    expect(output.sourcePhilosopherArtifactId).toBe(ARTIFACT_ID);
    expect(corrected).toEqual(['taskId', 'sourcePhilosopherArtifactId']);
  });

  it('leaves correct echoes untouched and reports nothing', () => {
    const output: Record<string, unknown> = {
      taskId: TASK_ID,
      sourcePhilosopherArtifactId: ARTIFACT_ID,
    };
    const corrected = reconcileLineageEcho(output, {
      topFields: [
        { field: 'taskId', authoritativeValue: TASK_ID },
        { field: 'sourcePhilosopherArtifactId', authoritativeValue: ARTIFACT_ID },
      ],
    });
    expect(corrected).toEqual([]);
  });

  it('overwrites wrong nested trace field and reports traceField.field', () => {
    const output: Record<string, unknown> = {
      sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-001' },
    };
    const corrected = reconcileLineageEcho(output, {
      trace: { traceField: 'sourceTrace', fields: [{ field: 'philosopherArtifactId', authoritativeValue: ARTIFACT_ID }] },
    });
    expect((output.sourceTrace as Record<string, unknown>).philosopherArtifactId).toBe(ARTIFACT_ID);
    expect(corrected).toEqual(['sourceTrace.philosopherArtifactId']);
  });

  it('injects minimal trace object when absent and reports the trace field name', () => {
    const output: Record<string, unknown> = { principleDraft: {} };
    const corrected = reconcileLineageEcho(output, {
      trace: { traceField: 'sourceTrace', fields: [{ field: 'philosopherArtifactId', authoritativeValue: ARTIFACT_ID }] },
    });
    expect(output.sourceTrace).toEqual({ philosopherArtifactId: ARTIFACT_ID });
    expect(corrected).toEqual(['sourceTrace']);
  });

  it('replaces malformed (array/null) trace with the minimal object', () => {
    const arrayWithTrace: Record<string, unknown> = { sourceTrace: ['bogus'] };
    expect(reconcileLineageEcho(arrayWithTrace, {
      trace: { traceField: 'sourceTrace', fields: [{ field: 'philosopherArtifactId', authoritativeValue: ARTIFACT_ID }] },
    })).toEqual(['sourceTrace']);
    expect(arrayWithTrace.sourceTrace).toEqual({ philosopherArtifactId: ARTIFACT_ID });

    const nullTrace: Record<string, unknown> = { sourceTrace: null };
    expect(reconcileLineageEcho(nullTrace, {
      trace: { traceField: 'sourceTrace', fields: [{ field: 'philosopherArtifactId', authoritativeValue: ARTIFACT_ID }] },
    })).toEqual(['sourceTrace']);
    expect(nullTrace.sourceTrace).toEqual({ philosopherArtifactId: ARTIFACT_ID });
  });

  it('returns [] on null / array / primitive input without throwing', () => {
    expect(reconcileLineageEcho(null, { topFields: [{ field: 'taskId', authoritativeValue: TASK_ID }] })).toEqual([]);
    expect(reconcileLineageEcho([1, 2], { topFields: [{ field: 'taskId', authoritativeValue: TASK_ID }] })).toEqual([]);
    expect(reconcileLineageEcho('hello', { topFields: [{ field: 'taskId', authoritativeValue: TASK_ID }] })).toEqual([]);
    expect(reconcileLineageEcho(42, { topFields: [{ field: 'taskId', authoritativeValue: TASK_ID }] })).toEqual([]);
  });

  it('returns [] with empty rules', () => {
    expect(reconcileLineageEcho({ taskId: 'x' }, {})).toEqual([]);
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
  ])('%s does not use truthiness check for taskId reinjection', (filename) => {
    // Read the source file and verify the old pattern is gone
    const filePath = resolve(__dirname, '..', filename);
    const source = readFileSync(filePath, 'utf8');
    // The old pattern: if (!(output as unknown as Record<string, unknown>).taskId)
    expect(source).not.toMatch(/!\(output as unknown as Record<string, unknown>\)\.taskId/);
    // PRI-541: every peer runner runs the shared lineage echo gate
    expect(source).toContain('reconcileLineageEcho');
  });

  it('peer-runner-contracts.ts keeps the absent-injection semantics (ERR-049)', () => {
    // reconcileLineageEcho delegates absent-field injection to
    // injectRunnerLineageIfAbsent — guard the dependency so the fail-loud
    // semantics (present-but-falsy untouched) cannot be silently dropped.
    const filePath = resolve(__dirname, '..', 'peer-runner-contracts.ts');
    const source = readFileSync(filePath, 'utf8');
    expect(source).toContain('injectRunnerLineageIfAbsent');
  });
});
