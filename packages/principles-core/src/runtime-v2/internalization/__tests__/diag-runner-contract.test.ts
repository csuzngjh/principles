/**
 * Diag runner shared-template contract suite (Test Diet Phase 2.2-B2, PRI-888 lineage).
 *
 * Consolidates the 18 copy-pasted test bodies across the three V-slice suites
 * (diag-router-runner / diag-rootcause-runner / diag-distiller-runner) into
 * four parameterized template groups. Executed coverage is unchanged — every
 * consolidated it re-expands once per role with the original assertions.
 *
 * What is deliberately NOT flattened (per
 * docs/testing/internalization-test-value-audit.md §Diag Runner Recommendation):
 *   - validation-failure LAYER: all three roles now run the real schema on the
 *     default path (router: TypeBox pipeline baked into the class; A/B since
 *     B3-A: spy-backed Default validators in the harness). Failure injection
 *     differs per role — router sends a malformed fetchOutput payload through
 *     its real pipeline, A/B override the validator seam result. Encoded
 *     per-case as `injectValidationFailure`.
 *   - error-category asymmetry: the EP-01 cases assert `input_invalid`
 *     (permanent category, fail-fast); the distiller EP-07 lineage case
 *     (max_attempts_exceeded) stays pinned in the distiller stage file.
 *   - PRI-pinned regressions stay in their stage files: PRI-667 dual-write
 *     (router), PRI-442 Bug-B-005 agentId (rootcause), EP-07 lineage
 *     telemetry (distiller).
 *
 * The artifact-write-failure template covers the A/B storage-layer injection
 * only; the router's write failure lives at the committer layer and remains
 * in the router stage file.
 */
import { describe, it, expect, vi } from 'vitest';
import { RunnerPhase } from '../../runner/runner-phase.js';
import {
  createDiagRunnerHarness,
  makeFailingArtifactStore,
  makePredecessorStore,
  DISTILLER_ROOTCAUSE_ARTIFACT_ID,
  type AnyDiagRunnerHarness,
  type DiagDistillerHarness,
  type DiagRootCauseHarness,
  type DiagRouterHarness,
  type DiagRunnerRole,
} from './__fixtures__/diag-runner-harness.js';

type MockFn = ReturnType<typeof vi.fn>;

// ── Shared lifecycle contract (3 roles × 3 templates) ─────────────────────────

interface LifecycleCase {
  role: DiagRunnerRole;
  create: () => AnyDiagRunnerHarness;
  /**
   * Role-specific validation-failure injection. NOT a uniform mock:
   * router exercises the real TypeBox pipeline, A/B exercise the validator seam.
   */
  injectValidationFailure: (h: AnyDiagRunnerHarness) => void;
  /** Names the validation layer in test titles so layer drift stays visible. */
  validationLayer: string;
}

const LIFECYCLE_CASES: LifecycleCase[] = [
  {
    role: 'router',
    create: () => createDiagRunnerHarness('router'),
    injectValidationFailure: (h) => {
      const router = h as DiagRouterHarness;
      // Real TypeBox path: the runner's baked-in Value.Check rejects this payload.
      (router.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({
        payload: { invalid: true },
      });
    },
    validationLayer: 'real TypeBox pipeline',
  },
  {
    role: 'rootcause',
    create: () => createDiagRunnerHarness('rootcause'),
    injectValidationFailure: (h) => {
      const rootcause = h as DiagRootCauseHarness;
      (rootcause.deps._validator.validate).mockResolvedValue({
        valid: false,
        errors: ['taskId mismatch'],
        errorCategory: 'output_invalid',
      });
    },
    validationLayer: 'validator seam mock',
  },
  {
    role: 'distiller',
    create: () => createDiagRunnerHarness('distiller'),
    injectValidationFailure: (h) => {
      const distiller = h as DiagDistillerHarness;
      (distiller.deps._validator.validate).mockResolvedValue({
        valid: false,
        errors: ['taskId mismatch'],
        errorCategory: 'output_invalid',
      });
    },
    validationLayer: 'validator seam mock',
  },
];

describe.each(LIFECYCLE_CASES)('Diag $role runner lifecycle [$validationLayer]', (c) => {
  it('currentPhase is Completed after successful run', async () => {
    const h = c.create();
    const result = await h.runner.run(h.taskId);

    expect(result.status).toBe('succeeded');
    expect(h.runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  it('currentPhase is Failed after validation failure', async () => {
    const h = c.create();
    c.injectValidationFailure(h);
    const result = await h.runner.run(h.taskId);

    expect(result.status).toBe('failed');
    expect(h.runner.currentPhase).toBe(RunnerPhase.Failed);
  });

  it('wrong taskKind fails closed', async () => {
    const h = c.create();
    const wrongKindTask = h.makeTask({ taskKind: 'dreamer' });
    (h.deps._stateManager.acquireLease as MockFn).mockResolvedValue(wrongKindTask);

    const result = await h.runner.run(h.taskId);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });
});

// ── Real schema rejection contract (rootcause + distiller, B3-A) ──────────────
//
// Proves the RUNNER wiring: a malformed fetchOutput payload on the DEFAULT
// (unmodified validator) path must be rejected by the real Default validator
// and must not produce a committed artifact. The validator's own rules are
// tested in diagnostician/__tests__/diag-*-output.test.ts — not re-tested here.

const REAL_SCHEMA_REJECT_CASES = [
  { role: 'rootcause', create: () => createDiagRunnerHarness('rootcause') },
  { role: 'distiller', create: () => createDiagRunnerHarness('distiller') },
] satisfies { role: 'rootcause' | 'distiller'; create: () => AnyDiagRunnerHarness }[];

describe.each(REAL_SCHEMA_REJECT_CASES)('Diag $role real schema rejection [default validator]', (c) => {
  it('malformed output → real validator rejects → failed, no artifact committed', async () => {
    const h = c.create();
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({ payload: { invalid: true } });

    const result = await h.runner.run(h.taskId);

    // Validation really ran through the seam on the DEFAULT (un-overridden)
    // validator, and the real schema rejected the payload — the always-valid
    // pre-B3-A stub would have committed it. output_invalid is retryable, so
    // the runner fails after exhausting its repair attempts.
    expect(h.deps._validator.validate).toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(h.runner.currentPhase).toBe(RunnerPhase.Failed);
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(h.taskId);
    expect(artifacts).toHaveLength(0);
  });
});

// ── taskId integrity contract (rootcause + distiller × 2 templates) ───────────

interface TaskIdCase {
  role: 'rootcause' | 'distiller';
  /** Default harness: spy-backed real validator since B3-A — taskId IS checked. */
  create: () => AnyDiagRunnerHarness;
}

const TASK_ID_CASES: TaskIdCase[] = [
  {
    role: 'rootcause',
    create: () => createDiagRunnerHarness('rootcause'),
  },
  {
    role: 'distiller',
    create: () => createDiagRunnerHarness('distiller'),
  },
];

describe.each(TASK_ID_CASES)('Diag $role taskId integrity', (c) => {
  it('missing taskId re-injected by postFetchTransform', async () => {
    const h = c.create();
    const outputWithoutTaskId = h.makeOutput();
    delete outputWithoutTaskId.taskId;

    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({ payload: outputWithoutTaskId });

    const result = await h.runner.run(h.taskId);

    // taskId is re-injected, so validation should pass
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();
    // Pin the injected VALUE, not just the survived flow: the real schema
    // validator rejects a payload whose taskId stayed absent, so "succeeded"
    // alone proves re-injection happened but not what was injected — assert
    // the persisted artifact carries the leased taskId.
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(h.taskId);
    expect(artifacts).toHaveLength(1);
    const contentJson = artifacts[0]?.contentJson;
    if (contentJson) {
      expect((JSON.parse(contentJson) as Record<string, unknown>).taskId).toBe(h.taskId);
    } else {
      throw new Error('artifact content missing');
    }
  });

  it('present-but-empty taskId NOT overwritten by postFetchTransform', async () => {
    const h = c.create();
    const emptyTaskIdOutput = h.makeOutput();
    emptyTaskIdOutput.taskId = '';

    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({ payload: emptyTaskIdOutput });

    const result = await h.runner.run(h.taskId);

    // Validation should fail because taskId is empty (mismatch with leased taskId)
    expect(result.status).toBe('failed');
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(h.taskId);
    expect(artifacts).toHaveLength(0);
  });
});

// ── Storage-layer write failure contract (rootcause + distiller) ──────────────

const STORAGE_WRITE_FAIL_CASES = [
  { role: 'rootcause', create: () => createDiagRunnerHarness('rootcause', { artifactStore: makeFailingArtifactStore() }) },
  {
    role: 'distiller',
    // Reads must still resolve the rootcause predecessor, otherwise the run
    // fails early with input_invalid and never reaches the failing write.
    create: () => createDiagRunnerHarness('distiller', {
      artifactStore: makeFailingArtifactStore(
        { rootcause: 'valid' },
        { rootCauseArtifactId: DISTILLER_ROOTCAUSE_ARTIFACT_ID },
      ),
    }),
  },
] satisfies { role: 'rootcause' | 'distiller'; create: () => AnyDiagRunnerHarness }[];

describe.each(STORAGE_WRITE_FAIL_CASES)('Diag $role artifact persistence', (c) => {
  it('artifact write failure → retryOrFail, not markTaskSucceeded', async () => {
    const h = c.create();
    const result = await h.runner.run(h.taskId);

    expect(result.status).toBe('failed');
    // Prove the run reached the storage-layer write (not an earlier failure).
    expect(vi.mocked(h.deps.artifactStore.upsertArtifact)).toHaveBeenCalled();
    expect((h.deps._stateManager.markTaskSucceeded as MockFn)).not.toHaveBeenCalled();
  });
});

// ── EP-01: corrupted predecessor artifact content (real TypeBox in buildContext) ─

interface CorruptedPredecessorCase {
  label: string;
  create: () => AnyDiagRunnerHarness;
}

const CORRUPTED_PREDECESSOR_CASES: CorruptedPredecessorCase[] = [
  {
    label: 'router: corrupted rootcause artifact content fails schema validation (EP-01)',
    create: () =>
      createDiagRunnerHarness('router', {
        artifactStore: makePredecessorStore({ rootcause: 'corrupt', distiller: 'valid' }),
      }),
  },
  {
    label: 'router: corrupted distiller artifact content fails schema validation (EP-01)',
    create: () =>
      createDiagRunnerHarness('router', {
        artifactStore: makePredecessorStore({ rootcause: 'valid', distiller: 'corrupt' }),
      }),
  },
  {
    label: 'distiller: corrupted predecessor artifact content fails schema validation (EP-01)',
    create: () =>
      createDiagRunnerHarness('distiller', {
        artifactStore: makePredecessorStore(
          { rootcause: 'corrupt' },
          { rootCauseArtifactId: DISTILLER_ROOTCAUSE_ARTIFACT_ID },
        ),
      }),
  },
];

describe.each(CORRUPTED_PREDECESSOR_CASES)('$label', (c) => {
  it('fails closed with input_invalid before any LLM run', async () => {
    const h = c.create();

    const result = await h.runner.run(h.taskId);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });
});
