/**
 * Layer 0 writer-side property tests (design §6.1, tasks 3.12–3.20).
 *
 * These exercise the *wiring* layer (`BasePeerRunner.buildArtifactContentJson`,
 * which calls `attachSummaryEnvelope`), not the pure derivation functions
 * (those are covered by `artifact-summary.property.test.ts`). The wiring layer
 * is where the feature flag, the predecessor-contentHash injection, the
 * degradation telemetry, and the "summary failure must not affect task success"
 * contract (F11) all live.
 *
 * CP-04: derivation failure does not affect task success / failure
 * CP-05: predecessor summary adds zero extra store reads & is same-source
 * CP-06: envelope depth is always exactly one (no nested predecessorSummary)
 * CP-11: stale summary content never enters the written contentJson
 * CP-32: contentJson key-level compatibility (flag on vs off, byte-identical
 *        aside from summary/predecessorSummary)
 * CP-35: direct-predecessor uniqueness (evaluator loads artificer+scribe,
 *        diag_router loads rootcause+distiller — only the edge predecessor
 *        lands in predecessorSummary)
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.1, §16
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirements 1.8, 2, 3.6, 11.5–11.9
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fc from 'fast-check';

import { BasePeerRunner } from '../../runner/base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PIArtifactStore } from '../pi-artifact.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';
import type {
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../../runner/peer-runner-types.js';
import type { EffectivePdConfig, PdConfig } from '../../config/pd-config-types.js';
import { getDefaultPdConfig } from '../../config/pd-config-defaults.js';
import { computeEffectivePdConfig } from '../../config/pd-config-effective.js';
import type {
  SummaryRunnerKind,
  ArtifactSummary,
} from '../artifact-summary.js';
import type { LoadedPredecessorArtifact } from '../attach-summary-envelope.js';
import { computeContentHash } from '../artifact-content-hash.js';

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

// ── Test fixtures ────────────────────────────────────────────────────────────

interface TestContext {
  contextHash: string;
}

interface TestOutput {
  data: string;
}

const TASK_ID = 'task-layer0-writer-001';

/**
 * Build an EffectivePdConfig with the Layer 0 flag on or off. Uses the real
 * production config-merge path (`computeEffectivePdConfig`) rather than
 * hand-rolling the EffectivePdConfig shape — this is the same path the
 * production loader uses (ERR-024: test the real wiring).
 */
function makeEffectiveConfig(opts: { summaryEnabled?: boolean }): EffectivePdConfig {
  if (!opts.summaryEnabled) {
    return computeEffectivePdConfig(null);
  }
  const base = getDefaultPdConfig();
  const userConfig: PdConfig = {
    ...base,
    features: {
      ...base.features,
      artifact_summary_redundancy: { category: 'quiet', enabled: true },
    },
  };
  return computeEffectivePdConfig(userConfig);
}

/**
 * Test runner exposing the protected `buildArtifactContentJson` directly.
 * Mirrors the DegradationTestRunner pattern from
 * base-peer-runner-rate-limit-degradation.test.ts.
 */
class Layer0TestRunner extends BasePeerRunner<TestContext, TestOutput> {
  constructor(deps: PeerRunnerDeps, effectiveConfig?: EffectivePdConfig) {
    super(
      deps,
      { owner: 'test', runtimeKind: 'test-double' },
      {
        runnerName: 'test',
        expectedTaskKind: 'dreamer',
        defaultAgentId: 'test',
        resultRefPrefix: 'test',
        effectiveConfig,
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['input_invalid', 'output_invalid']);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(): Promise<TestContext> {
    return { contextHash: 'test-hash' };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(): Promise<RunHandle> {
    return { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validateOutput(): Promise<PeerRunnerValidationResult> {
    return { valid: true, errors: [] };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/max-params
  async succeedTask(taskId: string, runId: string, _output: TestOutput, task: TaskRecord): Promise<PeerRunnerResult<TestOutput>> {
    return { status: 'succeeded', taskId, runId, attemptCount: task.attemptCount };
  }

  // eslint-disable-next-line @typescript-eslint/max-params -- mirrors the protected method under test 1:1.
  callBuildArtifactContentJson(
    taskId: string,
    runnerKind: SummaryRunnerKind,
    output: unknown,
    loadedPredecessor: LoadedPredecessorArtifact | null,
  ): string {
    return this.buildArtifactContentJson(taskId, runnerKind, output, loadedPredecessor);
  }

  /** Expose the flag check for direct assertion. */
  callIsArtifactSummaryEnabled(): boolean {
    return this.isArtifactSummaryEnabled();
  }
}

function createMockDeps(overrides?: Partial<PeerRunnerDeps>): PeerRunnerDeps {
  return {
    stateManager: {
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: vi.fn().mockReturnValue(false) }),
      markTaskFailed: vi.fn().mockResolvedValue({}),
      markTaskSucceeded: vi.fn().mockResolvedValue({}),
      updateRunOutput: vi.fn().mockResolvedValue({}),
    } as unknown as RuntimeStateManager,
    runtimeAdapter: {} as unknown as PDRuntimeAdapter,
    eventEmitter: {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter,
    artifactStore: {
      // Counting stub: CP-05 proves zero extra reads. Every method the writer
      // path could reach is a spy that throws if called unexpectedly.
      getArtifactById: vi.fn(),
      listBySourceTaskId: vi.fn(),
    } as unknown as PIArtifactStore,
    contentHashFn: sha256,
    ...overrides,
  };
}

type TelemetryCallsArg = { eventType: string; payload?: Record<string, unknown> };
function telemetryCalls(mock: ReturnType<typeof vi.fn>): TelemetryCallsArg[] {
  return (mock.mock.calls as unknown[][]).map((call) => call[0] as TelemetryCallsArg);
}

/**
 * `emitEvent` prefixes eventType with the runner name (e.g. `test_...`).
 * This helper matches on the suffix so tests stay runner-name agnostic.
 */
function telemetryWithSuffix(mock: ReturnType<typeof vi.fn>, suffix: string): TelemetryCallsArg[] {
  return telemetryCalls(mock).filter((c) => c.eventType.endsWith(`_${suffix}`));
}

/** A legal dreamer-shaped output for the wiring tests. */
const DREAMER_OUTPUT = {
  candidates: [{
    badDecision: 'renamed without checking callers',
    betterDecision: 'audit file tree and grep imports before rename',
    rationale: 'cross-package callers break compilation',
    riskLevel: 'high',
    strategicPerspective: 'caller-side lens',
  }],
} as const;

function makePredecessor(runnerKind: SummaryRunnerKind, content: Record<string, unknown>): LoadedPredecessorArtifact {
  return {
    artifactId: `pred-${runnerKind}`,
    runnerKind,
    contentJson: content,
  };
}

// ── CP-32: contentJson key-level compatibility ───────────────────────────────

describe('Layer 0 — CP-32 contentJson key-level compatibility', () => {
  it('flag OFF → contentJson is byte-identical to JSON.stringify(output)', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps); // no effectiveConfig → flag off
    expect(runner.callIsArtifactSummaryEnabled()).toBe(false);

    const result = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, null);
    expect(result).toBe(JSON.stringify(DREAMER_OUTPUT));
    // And the same when a predecessor is provided: flag off = no envelope at all.
    const resultWithPred = runner.callBuildArtifactContentJson(
      TASK_ID,
      'dreamer',
      DREAMER_OUTPUT,
      makePredecessor('diag_router', { summary: 'router output' }),
    );
    expect(resultWithPred).toBe(JSON.stringify(DREAMER_OUTPUT));
  });

  it('flag ON → every original output key is preserved (only summary/predecessorSummary added)', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    expect(runner.callIsArtifactSummaryEnabled()).toBe(true);

    const result = runner.callBuildArtifactContentJson(
      TASK_ID,
      'dreamer',
      DREAMER_OUTPUT,
      makePredecessor('diag_router', { summary: 'router output' }),
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    // Every original key from DREAMER_OUTPUT is present and unchanged.
    const original = DREAMER_OUTPUT as unknown as Record<string, unknown>;
    for (const key of Object.keys(original)) {
      expect(parsed[key]).toEqual(original[key]);
    }
    // The two additive envelope keys are present.
    expect(Object.hasOwn(parsed, 'summary')).toBe(true);
    expect(Object.hasOwn(parsed, 'predecessorSummary')).toBe(true);
  });

  it('flag ON with no predecessor → only `summary` added, no `predecessorSummary` key', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    const result = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, null);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'summary')).toBe(true);
    expect(Object.hasOwn(parsed, 'predecessorSummary')).toBe(false);
  });

  it('P1 regression: output already declaring a top-level `summary` field (diag_rootcause / diag_router) is NOT overwritten', () => {
    // CodeRabbit PR #1273: DiagRootCauseOutputV1 and DiagnosticianOutputV1 both
    // declare a top-level `summary` string field. The Layer 0 envelope must not
    // clobber it. On collision, the envelope `summary` key is skipped, a
    // structured degradation is emitted, and predecessorSummary is still
    // attached (it does not collide).
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    const emitMock = deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>;

    // diag_router-shaped output carries a legitimate top-level `summary` field.
    const routerOutput = {
      summary: 'route to internalization: principle guard', // legitimate output field
      rootCause: 'rename without enumeration',
      violatedPrinciples: [],
      recommendations: [{ kind: 'principle', description: 'guard', triggerPattern: 'x', action: 'y' }],
    };
    const result = runner.callBuildArtifactContentJson(
      TASK_ID,
      'diag_router',
      routerOutput,
      makePredecessor('diag_distiller', { abstractedPrinciple: 'p', rationale: 'r', scope: 'general' }),
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;

    // The legitimate output.summary is preserved verbatim (NOT overwritten by
    // the ArtifactSummary envelope object).
    expect(parsed.summary).toBe('route to internalization: principle guard');
    expect(typeof parsed.summary).toBe('string');

    // predecessorSummary is still attached (no collision).
    expect(Object.hasOwn(parsed, 'predecessorSummary')).toBe(true);
    expect((parsed.predecessorSummary as Record<string, unknown>).runnerKind).toBe('diag_distiller');

    // A structured degradation was emitted for the collision (rc-9).
    const skipped = telemetryWithSuffix(emitMock, 'artifact_summary_skipped');
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.payload?.reason).toBe('output_summary_key_collision');
  });
});

// ── CP-04: derivation failure does not affect task success ───────────────────

describe('Layer 0 — CP-04 derivation failure does not affect task success', () => {
  it('returns a valid contentJson (no throw) and emits artifact_summary_skipped when output has no derivable field', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    const emitMock = deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>;

    // An object with none of the fields any resolver looks for → no_derivable_field.
    const bare = { unrelated: 'value' };
    const result = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', bare, null);

    // No throw, valid JSON, and falls back to the bare output (no summary key).
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'summary')).toBe(false);

    // Exactly one artifact_summary_skipped degradation event emitted (rc-9).
    const skipped = telemetryWithSuffix(emitMock, 'artifact_summary_skipped');
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.payload?.reason).toBe('no_derivable_field');
  });

  it('output_not_object (e.g. a string) → no summary, no throw', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    const result = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', 'not-an-object', null);
    // Falls back to JSON.stringify of the input; no summary.
    expect(result).toBe(JSON.stringify('not-an-object'));
  });
});

// ── CP-06: envelope depth is always exactly one ──────────────────────────────

describe('Layer 0 — CP-06 envelope depth is always exactly one', () => {
  it('predecessorSummary never carries its own predecessorSummary key', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));

    // Even when the predecessor's own contentJson already contains a nested
    // predecessorSummary (as if it were itself a mid-chain node), the freshly
    // attached predecessorSummary must NOT propagate that nested ref — depth is
    // capped at one (design §4.6 修正六).
    const pred = makePredecessor('diag_router', {
      summary: 'router output',
      predecessorSummary: { artifactId: 'should-not-propagate', runnerKind: 'diag_distiller' },
    });

    const result = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, pred);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const predSummary = parsed.predecessorSummary as Record<string, unknown>;
    expect(predSummary).toBeDefined();
    // The only keys on predecessorSummary are artifactId/runnerKind/contentHash/summary.
    const allowed = new Set(['artifactId', 'runnerKind', 'contentHash', 'summary']);
    for (const key of Object.keys(predSummary)) {
      expect(allowed.has(key)).toBe(true);
    }
    // And critically: no nested predecessorSummary.predecessorSummary.
    const nested = predSummary.summary as ArtifactSummary;
    expect(Object.hasOwn(nested, 'predecessorSummary')).toBe(false);
  });

  it('a synthetic 1..6-hop chain never produces nested predecessorSummary at any hop', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (hops) => {
        const deps = createMockDeps();
        const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));

        // Build hops sequentially, feeding each hop's written contentJson as
        // the next hop's predecessor content.
        const kinds: SummaryRunnerKind[] = ['diag_rootcause', 'diag_distiller', 'diag_router', 'dreamer', 'philosopher', 'scribe'];
        let prevContent: Record<string, unknown> = { rootCause: 'seed root cause' };
        let prevKind: SummaryRunnerKind = 'diag_rootcause';

        for (let i = 0; i < hops; i++) {
          const kind = kinds[Math.min(i, kinds.length - 1)] ?? 'scribe';
          const predecessor: LoadedPredecessorArtifact | null = i === 0
            ? null
            : { artifactId: `art-${i}`, runnerKind: prevKind, contentJson: prevContent };
          const out = { candidates: [{ betterDecision: 'hop action', riskLevel: 'low' }] };
          const written = runner.callBuildArtifactContentJson(`task-${i}`, kind, out, predecessor);
          const parsed = JSON.parse(written) as Record<string, unknown>;
          // Check this hop's predecessorSummary (if present) has no nesting.
          const pred = parsed.predecessorSummary as Record<string, unknown> | undefined;
          if (pred) {
            const allowed = new Set(['artifactId', 'runnerKind', 'contentHash', 'summary']);
            for (const key of Object.keys(pred)) expect(allowed.has(key)).toBe(true);
            const inner = pred.summary as ArtifactSummary;
            expect(Object.hasOwn(inner, 'predecessorSummary')).toBe(false);
          }
          prevContent = parsed;
          prevKind = kind;
        }
      }),
      { numRuns: 12 },
    );
  });
});

// ── CP-05: predecessor summary adds zero extra store reads & is same-source ──

describe('Layer 0 — CP-05 predecessor summary zero extra reads & same-source', () => {
  it('flag ON with predecessor → no artifactStore.getArtifactById/listBySourceTaskId calls', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    const getMock = deps.artifactStore.getArtifactById as ReturnType<typeof vi.fn>;
    const listMock = deps.artifactStore.listBySourceTaskId as ReturnType<typeof vi.fn>;

    runner.callBuildArtifactContentJson(
      TASK_ID,
      'dreamer',
      DREAMER_OUTPUT,
      makePredecessor('diag_router', { summary: 'router output' }),
    );

    expect(getMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('predecessorSummary artifactId / runnerKind / contentHash are all same-source (rc-6)', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    const predContent = { summary: 'router output', rootCause: 'rc' };
    const pred: LoadedPredecessorArtifact = {
      artifactId: 'pred-art-999',
      runnerKind: 'diag_router',
      contentJson: predContent,
    };

    const result = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, pred);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const predSummary = parsed.predecessorSummary as Record<string, unknown>;

    // All three fields come from the same predecessor object.
    expect(predSummary.artifactId).toBe('pred-art-999');
    expect(predSummary.runnerKind).toBe('diag_router');
    // contentHash is the canonical (key-sorted) serialization of the predecessor content.
    expect(predSummary.contentHash).toBe(computeContentHash(predContent, sha256));
  });

  it('null predecessor → artifact_summary_predecessor_absent emitted, self summary still written', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));
    const emitMock = deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>;

    const result = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, null);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'summary')).toBe(true);
    expect(Object.hasOwn(parsed, 'predecessorSummary')).toBe(false);

    const absent = telemetryWithSuffix(emitMock, 'artifact_summary_predecessor_absent');
    expect(absent.length).toBe(1);
    expect(absent[0]?.payload?.reason).toBe('no_predecessor_in_context');
  });
});

// ── CP-11: stale summary content never enters the written contentJson ────────
//
// Note: CP-11's core invariant (stale predecessorSummary content is excluded
// from the injected context) is enforced by the READ-side freshness check
// (`checkPredecessorSummaryFreshness`, covered by summary-freshness.property
// .test.ts CP-09). The WRITE side tested here guarantees the contentHash is
// computed correctly so the read side can detect staleness. This test verifies
// the contentHash is stable for a given content, so a content change is always
// detectable.

describe('Layer 0 — CP-11 stale summary detectability (contentHash stability on write)', () => {
  it('contentHash changes iff predecessor content changes (so stale refs are always detectable)', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));

    const contentA = { summary: 'router output v1' };
    const contentB = { summary: 'router output v2' };

    const r1 = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, makePredecessor('diag_router', contentA));
    const r2 = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, makePredecessor('diag_router', contentA));
    const r3 = runner.callBuildArtifactContentJson(TASK_ID, 'dreamer', DREAMER_OUTPUT, makePredecessor('diag_router', contentB));

    const hashOf = (s: string): string => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      const pred = parsed.predecessorSummary as Record<string, unknown>;
      return pred.contentHash as string;
    };
    // Same content → same hash (deterministic).
    expect(hashOf(r1)).toBe(hashOf(r2));
    // Different content → different hash (staleness is detectable).
    expect(hashOf(r1)).not.toBe(hashOf(r3));
  });
});

// ── CP-35: direct-predecessor uniqueness ──────────────────────────────────────
//
// F17: some runners load TWO artifacts in the same context (evaluator loads
// artificer+scribe; diag_router loads rootcause+distiller). Only the EDGE
// predecessor may land in predecessorSummary. The wiring helper
// (attachSummaryEnvelope) only ever receives ONE predecessor object — the
// caller (runner) is responsible for passing the edge one. This test proves the
// single-predecessor contract holds regardless of what else is in memory.

describe('Layer 0 — CP-35 direct-predecessor uniqueness (single predecessor per write)', () => {
  it('each call writes at most one predecessorSummary — the object the caller passed', () => {
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));

    // Simulate evaluator's multi-artifact context: it loaded BOTH artificer
    // (edge predecessor) AND scribe (non-edge). Only artificer may go into
    // predecessorSummary. The wiring contract: the runner passes ONLY the edge
    // predecessor; scribe flows through its separate path.
    const artificerContent = { affectedTools: ['t1'], implementationSummary: 'impl', sourceTrace: { scribeArtifactId: 'scribe-art-1' } };
    const scribeContent = { principleDraft: { statement: 'principle' } };

    // Evaluator passes ONLY artificer as loadedPredecessor (edge predecessor).
    const result = runner.callBuildArtifactContentJson(
      TASK_ID,
      'evaluator',
      { evaluation: { decision: 'approved', concerns: [] }, codeReview: { intentConsistency: { aligned: true } } },
      makePredecessor('artificer', artificerContent),
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const predSummary = parsed.predecessorSummary as Record<string, unknown>;

    // Exactly one predecessorSummary, and it's the artificer (edge).
    expect(predSummary).toBeDefined();
    expect(predSummary.runnerKind).toBe('artificer');
    expect(predSummary.artifactId).toBe('pred-artificer');

    // The scribe content (a sentinel string) must NOT appear anywhere in the
    // written contentJson — it was never passed in.
    expect(result).not.toContain(JSON.stringify(scribeContent.principleDraft));
  });

  it('passing the non-edge predecessor (scribe) is the caller\'s contract violation, but the helper still writes exactly one', () => {
    // This documents the contract boundary: attachSummaryEnvelope trusts the
    // caller to pass the edge predecessor. If a caller passes the wrong one,
    // the helper still writes exactly ONE predecessorSummary — it never
    // merges multiple. This is the invariant CP-35 guards.
    const deps = createMockDeps();
    const runner = new Layer0TestRunner(deps, makeEffectiveConfig({ summaryEnabled: true }));

    const result = runner.callBuildArtifactContentJson(
      TASK_ID,
      'evaluator',
      { evaluation: { decision: 'approved', concerns: [] } },
      makePredecessor('scribe', { principleDraft: { statement: 'p' } }),
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const predSummary = parsed.predecessorSummary as Record<string, unknown>;
    expect(predSummary).toBeDefined();
    // Exactly one — no array, no merge.
    expect(typeof predSummary).toBe('object');
    expect(Array.isArray(predSummary)).toBe(false);
  });
});
