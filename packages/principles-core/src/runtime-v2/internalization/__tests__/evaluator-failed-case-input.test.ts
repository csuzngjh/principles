/**
 * PD v2 Phase 1 review round (2026-10-11) — failed-case `caseInput` budget
 * regressions.
 *
 * Independent review reproduced the gap with a LEGAL input:
 *   params = { path: "src/module.ts", content: "x".repeat(350) }
 * The old producer serialized the whole params object first and truncated
 * the whole summary at 400 chars, so the context/facts segment (tool,
 * history status, priorReadOfTarget, readCount) fell outside the cut; the
 * resolver then truncated again at 300. The repair round received a summary
 * with NO context evidence at all. The new regressions first reproduced the
 * failure on the old code (3 producer assertions red), then locked the fix.
 *
 * Contract pinned here, end to end:
 *   - producer: params get their OWN bounded digest; context/facts facts are
 *     written FIRST and always survive; big values are summarized with a
 *     VISIBLE truncation marker; unserializable params degrade per-key while
 *     keeping the context segment; total length ≤ the shared
 *     MAX_FAILED_CASE_INPUT_LENGTH bound.
 *   - resolver: caseInput is bounded at the SAME shared bound (no second,
 *     tighter silent cut); over-long legacy entries truncate visibly; legacy
 *     artifacts without caseInput keep reading without the field.
 *
 * The producer-level cases call the real mapFailedCases through the runner
 * prototype (same technique as the PRI-634 evidence probes) because that is
 * the production write path for durable failed-case evidence. The cast is
 * test-side only — production callers reach the method through the runner.
 */
import { describe, it, expect } from 'vitest';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { resolveRepairReplayContext, type ReplayFailureEvidence } from '../repair-replay-resolver.js';
import { MAX_FAILED_CASE_INPUT_LENGTH, type AdversarialCase, type AdversarialFailedCase } from '../evaluator-output.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import type { TaskRecord } from '../../task-status.js';
import type { PIArtifactRecord } from '../pi-artifact.js';

type MapFailedCasesFn = (
  this: EvaluatorRunner,
  gateResult: {
    readonly sandboxResult: {
      readonly failedCases: readonly {
        readonly caseId: string;
        readonly errorType: string;
        readonly message: string;
        readonly expectedDecision?: string;
        readonly actualDecision?: string;
      }[];
      readonly forbiddenPatternViolations: readonly string[];
    };
  },
  adversarialCases: readonly AdversarialCase[],
) => AdversarialFailedCase[];

function mapViaRealRunner(
  adversarialCases: readonly AdversarialCase[],
  sandboxOnlyCaseIds: readonly string[] = [],
): AdversarialFailedCase[] {
  const probe = Object.create(EvaluatorRunner.prototype) as EvaluatorRunner;
  const writer = (probe as unknown as { mapFailedCases: MapFailedCasesFn }).mapFailedCases;
  const gateResult = {
    sandboxResult: {
      failedCases: [...adversarialCases.map((c) => c.caseId), ...sandboxOnlyCaseIds].map((caseId) => ({
        caseId,
        errorType: 'validation_failed',
        message: 'Expected block but got allow',
        expectedDecision: 'block',
        actualDecision: 'allow',
      })),
      forbiddenPatternViolations: [],
    },
  };
  return writer.call(probe, gateResult, adversarialCases);
}

function firstOf<T>(failures: readonly T[]): T {
  const [first] = failures;
  if (first === undefined) throw new Error('expected at least one entry');
  return first;
}

function boundaryCase(params: Record<string, unknown>, overrides: Partial<AdversarialCase> = {}): AdversarialCase {
  return {
    caseId: 'v2-path-boundary',
    attackType: 'boundary',
    toolName: 'write',
    params,
    expectedDecision: 'block',
    rationale: 'targetPath.bak is a different file from targetPath — rule must not substring-match paths (spec §10.1 row on boundary probes); the sentinel write must be blocked because the owner confirmation gate has not run for that exact path',
    ruleContext: {
      version: 2,
      history: { status: 'available', truncated: false, calls: [] },
      facts: { priorReadOfTarget: 'no', readCount: 1, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
    },
    ...overrides,
  };
}

describe('caseInput producer budget (real mapFailedCases path)', () => {
  it('LONG param value: context facts survive and the big value is visibly digested', () => {
    const failure = firstOf(mapViaRealRunner([
      boundaryCase({ path: 'src/module.ts', content: 'x'.repeat(350) }),
    ]));
    expect(failure.caseInput).toBeDefined();
    const input = String(failure.caseInput);
    // Context/facts facts come first and survive the budget.
    expect(input.indexOf('context:')).toBeLessThan(200);
    expect(input).toContain('tool=write');
    expect(input).toContain('priorReadOfTarget=no');
    expect(input).toContain('readCount=1');
    expect(input).toContain('history available');
    // The big value is digested with a visible truncation marker, not inlined.
    expect(input).toMatch(/…\(\+\d+ chars\)/);
    expect(input).not.toContain('x'.repeat(60));
    expect(input.length).toBeLessThanOrEqual(MAX_FAILED_CASE_INPUT_LENGTH);
  });

  it('SHORT params stay complete and readable', () => {
    const failure = firstOf(mapViaRealRunner([
      boundaryCase({ path: 'worklog.md.bak' }),
    ]));
    const input = String(failure.caseInput);
    expect(input).toContain('target="worklog.md.bak"');
    expect(input).toContain('priorReadOfTarget=no');
    expect(input).not.toContain('…(+');
  });

  it('MULTI-field params keep every key; long path and long rationale are each visibly bounded', () => {
    const failure = firstOf(mapViaRealRunner([
      boundaryCase(
        { path: `${'deep/'.repeat(12)}target/file.txt`, mode: 'overwrite', encoding: 'utf-8' },
        { rationale: 'r'.repeat(500) },
      ),
    ]));
    const input = String(failure.caseInput);
    expect(input).toContain('target="deep/deep/'); // long target kept inside its own budget
    expect(input).toContain('mode=');
    expect(input).toContain('encoding=');
    // The 60-char target fits its budget (complete); the 500-char rationale
    // is visibly cut. Every segment ends inside the shared bound.
    expect(input).toContain('target/file.txt"');
    expect(input.trim().endsWith('…') || input.includes('…')).toBe(true);
    expect(input).toContain('priorReadOfTarget=no');
    expect(input.length).toBeLessThanOrEqual(MAX_FAILED_CASE_INPUT_LENGTH);
  });

  it('history unavailable and truncated are both stated', () => {
    const unavailable = String(firstOf(mapViaRealRunner([
      boundaryCase({ path: 'a.txt' }, {
        ruleContext: { version: 2, history: { status: 'unavailable', truncated: false, calls: [] }, facts: { priorReadOfTarget: 'unknown', readCount: null, writeCount: null, uniqueWritePathCount: null, sameActionBlockCount: null } },
      }),
    ])).caseInput ?? '');
    expect(unavailable).toContain('history unavailable');

    const truncated = String(firstOf(mapViaRealRunner([
      boundaryCase({ path: 'a.txt' }, {
        ruleContext: { version: 2, history: { status: 'available', truncated: true, calls: [] }, facts: { priorReadOfTarget: 'unknown', readCount: null, writeCount: null, uniqueWritePathCount: null, sameActionBlockCount: null } },
      }),
    ])).caseInput ?? '');
    expect(truncated).toContain('truncated');
  });

  it('unserializable params degrade EXPLICITLY per key while the context segment survives', () => {
    const circular: Record<string, unknown> = { path: 'a.txt' };
    circular.self = circular;
    const failure = firstOf(mapViaRealRunner([boundaryCase(circular)]));
    const input = String(failure.caseInput);
    // Per-key degradation keeps the readable keys and marks only the
    // unserializable one — strictly better than dropping the whole segment.
    expect(input).toContain('self=(unserializable)');
    expect(input).toContain('target="a.txt"');
    expect(input).toContain('priorReadOfTarget=no');
    expect(input).toContain('readCount=1');
    expect(input.length).toBeLessThanOrEqual(MAX_FAILED_CASE_INPUT_LENGTH);
  });

  // Review round 2 (2026-10-11): a legal edit request whose LONG content
  // fields precede the target path used to evict the target from the digest
  // entirely — `protected/config.json` survived only as `path="pro…`, so the
  // repair round could not see the protected/ prefix. The target must have
  // its OWN budget, resolved via the existing path/file_path contract, ahead
  // of the content fields.
  it('LONG content fields do not evict the target path (edit oldText/newText before path)', () => {
    const failure = firstOf(mapViaRealRunner([
      boundaryCase({
        oldText: 'a'.repeat(350),
        newText: 'b'.repeat(350),
        path: 'protected/config.json',
      }),
    ]));
    const input = String(failure.caseInput);
    expect(input).toContain('target="protected/config.json"');
    expect(input).toContain('priorReadOfTarget=no');
    expect(input.length).toBeLessThanOrEqual(MAX_FAILED_CASE_INPUT_LENGTH);
  });

  it('file_path resolves as the target when path is absent (after a long content field)', () => {
    const failure = firstOf(mapViaRealRunner([
      boundaryCase({
        content: 'c'.repeat(400),
        file_path: 'workspace/notes.txt',
      }),
    ]));
    const input = String(failure.caseInput);
    expect(input).toContain('target="workspace/notes.txt"');
    expect(input).toContain('priorReadOfTarget=no');
  });

  it('key ORDER does not change target preservation', () => {
    const pathFirst = String(firstOf(mapViaRealRunner([
      boundaryCase({ path: 'protected/config.json', oldText: 'a'.repeat(350), newText: 'b'.repeat(350) }),
    ])).caseInput);
    const pathLast = String(firstOf(mapViaRealRunner([
      boundaryCase({ oldText: 'a'.repeat(350), newText: 'b'.repeat(350), path: 'protected/config.json' }),
    ])).caseInput);
    expect(pathLast).toContain('target="protected/config.json"');
    // The target segment is identical regardless of key order.
    expect(pathFirst).toContain('target="protected/config.json"');
  });

  it('LONG target path truncates VISIBLY inside its own budget', () => {
    const longTarget = `${'deep/'.repeat(40)}final.txt`;
    const failure = firstOf(mapViaRealRunner([
      boundaryCase({ path: longTarget }),
    ]));
    const input = String(failure.caseInput);
    expect(input).toMatch(/target="deep\/deep\/[^"]*…\(\+\d+ chars\)"/);
    expect(input).toContain('priorReadOfTarget=no');
    expect(input.length).toBeLessThanOrEqual(MAX_FAILED_CASE_INPUT_LENGTH);
  });

  it('NO derivable target is stated explicitly, never guessed', () => {
    const failure = firstOf(mapViaRealRunner([
      boundaryCase({ oldText: 'a'.repeat(200), force: true }),
    ]));
    const input = String(failure.caseInput);
    expect(input).toContain('target=');
    expect(input).toMatch(/target=[^|]*none/i);
    expect(input).not.toContain('target="');
    expect(input).toContain('priorReadOfTarget=no');
  });

  it('sandbox-only cases (not in the adversarial list) keep the legacy no-input shape', () => {
    const failure = firstOf(mapViaRealRunner([], ['owner:case-negative-5']));
    expect(failure.caseInput).toBeUndefined();
    expect(failure.rationale).toContain('non-adversarial case');
  });
});

describe('caseInput resolver bound (same shared limit, visible truncation)', () => {
  function mkTask(diagnosticJson: string): TaskRecord {
    const base = JSON.parse(createPITaskDiagnosticJson({
      dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
    })) as Record<string, unknown>;
    const envelopeKey = Object.keys(base).find((k) => k !== 'version');
    if (envelopeKey === undefined) throw new Error('unexpected diagnosticJson shape');
    const meta = base[envelopeKey] as Record<string, unknown>;
    meta.completionIntent = { decision: 'needs_revision', sourceRunId: 'run-1', revisionEpoch: 0, status: 'applied' };
    return {
      taskId: 'eval-t1', taskKind: 'evaluator', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as unknown as TaskRecord;
  }

  function evaluatorArtifact(failedCases: unknown): PIArtifactRecord {
    return {
      artifactId: 'pi-art-eval-t1-run-1', artifactKind: 'principle', sourceTaskId: 'eval-t1',
      lineageArtifactIds: [], validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: 'eval-t1',
        evaluation: { decision: 'needs_revision', summary: 's', score: 0.5, strengths: [], concerns: [], requiredChanges: ['x'] },
        adversarialResult: { passed: false, failedCases },
      }),
      createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
    };
  }

  async function resolve(failedCases: unknown): Promise<ReplayFailureEvidence[]> {
    const artifact = evaluatorArtifact(failedCases);
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: {
        artifactStore: {
          getArtifactById: async (id: string) => (id === artifact.artifactId ? artifact : null),
          listBySourceTaskId: async () => [artifact],
        },
        getTask: async () => mkTask(createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] })),
      },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return [];
    return [...resolution.context.systemFailures, ...resolution.context.traceFailures];
  }

  it('current-shape entry: context facts survive the resolver at the SHARED bound', async () => {
    // Exactly what the FIXED producer emits: ≤400 chars with context first.
    const producerShape = 'tool=write | context: history available, priorReadOfTarget=no, readCount=1 | params={content="x…(+350 chars)"} | case rationale: targetPath.bak …';
    const failures = await resolve([
      { caseId: 'v2-path-boundary', attackType: 'boundary', expectedDecision: 'block', actualDecision: 'allow', errorType: 'validation_failed', message: 'Expected block but got allow', caseInput: producerShape },
    ]);
    const failure = firstOf(failures);
    expect(failure.caseInput).toBeDefined();
    const carried = String(failure.caseInput);
    expect(carried).toBe(producerShape); // within the shared bound → passed through uncut
    expect(carried.length).toBeLessThanOrEqual(MAX_FAILED_CASE_INPUT_LENGTH);
    expect(carried).toContain('priorReadOfTarget=no');
  });

  it('over-long LEGACY entry: truncated VISIBLY at the shared bound, never silently', async () => {
    const oversized = 'x'.repeat(MAX_FAILED_CASE_INPUT_LENGTH + 200);
    const failure = firstOf(await resolve([
      { caseId: 'v2-path-boundary', attackType: 'boundary', expectedDecision: 'block', errorType: 'validation_failed', caseInput: oversized },
    ]));
    expect(failure.caseInput).toBeDefined();
    const bounded = String(failure.caseInput);
    expect(bounded.length).toBeLessThanOrEqual(MAX_FAILED_CASE_INPUT_LENGTH);
    expect(bounded.endsWith('…')).toBe(true);
  });

  it('legacy artifact WITHOUT caseInput keeps reading without the field', async () => {
    const failure = firstOf(await resolve([
      { caseId: 'v2-unavailable', attackType: 'boundary', expectedDecision: 'allow', errorType: 'runtime_error', message: 'boom' },
    ]));
    expect(failure.caseInput).toBeUndefined();
    expect(failure.errorType).toBe('runtime_error');
  });
});
