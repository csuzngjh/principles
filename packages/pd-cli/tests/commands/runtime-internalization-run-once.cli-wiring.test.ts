/**
 * cli-7 wiring test for `--only-candidates` (PRI-1284).
 *
 * The sibling test file drives the handler directly; this file drives the
 * REAL command tree: buildPdProgram() is the actual Commander registration
 * (`pd runtime internalization run-once`), so a renamed flag or a moved
 * subcommand cannot keep this test green while breaking the real CLI.
 *
 * Both selection layers are asserted: the auto-discovery PROBE (no --runner)
 * and the kind-specific DISPATCH wake must receive a skipCandidate that
 * excludes foreign candidate chains and keeps the allowlisted ones.
 *
 * The core/host-runtime modules are PARTIALLY mocked via importOriginal —
 * only the orchestrator/runner/state seams are stubbed, so the wiring test
 * exercises the production piTaskBelongsToCandidates predicate itself.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const WS = '/fake/workspace';

const mockWakeOnce = vi.fn();
const mockRun = vi.fn();
const mockCommitNextTaskProposal = vi.fn().mockResolvedValue({ decision: 'no_successor', sourceTaskId: '', reason: '' });
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockInitialize = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue(WS),
}));

vi.mock('../../src/config-reader.js', () => ({
  readOutputLanguageFromWorkspace: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

vi.mock('@principles/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const runnerCtor = () => vi.fn().mockImplementation(function () {
    return { run: mockRun };
  });
  return {
    ...actual,
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return {
        initialize: mockInitialize,
        close: mockClose,
        getTask: vi.fn().mockResolvedValue(null),
        connection: {},
        taskStore: {},
        runStore: {},
        piArtifactStore: {
          upsertArtifact: vi.fn().mockResolvedValue({}),
          getArtifactById: vi.fn().mockResolvedValue(null),
          listBySourceTaskId: vi.fn().mockResolvedValue([]),
          listLineage: vi.fn().mockResolvedValue([]),
        },
      };
    }),
    InternalizationOrchestrator: vi.fn().mockImplementation(function () {
      return { wakeOnce: mockWakeOnce, commitNextTaskProposal: mockCommitNextTaskProposal };
    }),
    DreamerRunner: runnerCtor(),
    PhilosopherRunner: runnerCtor(),
    ScribeRunner: runnerCtor(),
    ArtificerRunner: runnerCtor(),
    EvaluatorRunner: runnerCtor(),
    RolloutReviewerRunner: runnerCtor(),
    StoreEventEmitter: vi.fn().mockImplementation(function () {
      return { emitTelemetry: vi.fn() };
    }),
    TestDoubleRuntimeAdapter: vi.fn().mockImplementation(function () {
      return {
        kind: vi.fn().mockReturnValue('test-double'),
        getCapabilities: vi.fn(),
        healthCheck: vi.fn(),
        startRun: vi.fn().mockResolvedValue({ runId: 'run-test-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
        pollRun: vi.fn().mockResolvedValue({ runId: 'run-test-001', status: 'succeeded' }),
        cancelRun: vi.fn().mockResolvedValue(undefined),
        fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-test-001', payload: {} }),
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      };
    }),
  };
});

const { mockCreateEvaluatorRuntimeContext, mockCreateRolloutGovernanceDeps, mockResolveWorkspaceHostToolSemantics } = vi.hoisted(() => {
  const registry = { resolve: vi.fn(), hostMappings: vi.fn().mockReturnValue([{ rawToolName: 'write', canonicalKind: 'write' }]) };
  return {
    mockCreateEvaluatorRuntimeContext: vi.fn().mockReturnValue({ ok: true, gateDeps: { evaluateInSandbox: vi.fn() }, registry, hostKinds: ['openclaw'] }),
    mockCreateRolloutGovernanceDeps: vi.fn().mockReturnValue({ dispatchActivation: vi.fn(), reopenRevisionTarget: vi.fn() }),
    mockResolveWorkspaceHostToolSemantics: vi.fn().mockReturnValue({ ok: true, registry, hostKinds: ['openclaw'] }),
  };
});

vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createEvaluatorRuntimeContext: mockCreateEvaluatorRuntimeContext,
    createRolloutGovernanceDeps: mockCreateRolloutGovernanceDeps,
    resolveWorkspaceHostToolSemantics: mockResolveWorkspaceHostToolSemantics,
  };
});

const VALID_DREAMER_CANDIDATES = [{ candidateIndex: 0, badDecision: 'Ignored validation', betterDecision: 'Validate inputs', rationale: 'Prevents errors', confidence: 0.9, riskLevel: 'low' as const, strategicPerspective: 'defensive-programming' }];

describe('--only-candidates Commander wiring (cli-7, real command tree)', () => {
  const OWN_CAND = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const OTHER_OWN_CAND = 'cccccccc-0000-4000-8000-00000000000c';
  const FOREIGN_CAND = 'bbbbbbbb-0000-4000-8000-00000000000b';

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  // program.js is imported lazily inside beforeAll so the vi.mock factories
  // above are fully installed before the real command tree loads.
  let program: import('commander').Command;
  beforeAll(async () => {
    const { buildPdProgram } = await import('../../src/program.js');
    program = buildPdProgram();
  });

  function runOnceCmd(): import('commander').Command {
    const runtime = program.commands.find((c) => c.name() === 'runtime');
    expect(runtime, 'runtime command must be registered').toBeDefined();
    const internalization = runtime?.commands.find((c) => c.name() === 'internalization');
    expect(internalization, 'runtime internalization must be registered').toBeDefined();
    const runOnce = internalization?.commands.find((c) => c.name() === 'run-once');
    expect(runOnce, 'internalization run-once must be registered').toBeDefined();
    return runOnce as import('commander').Command;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInitialize.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = 0;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    // The built program is a module-level singleton: Commander keeps parsed
    // option values between parseAsync calls, so reset every declared option
    // to its default to keep the tests order-independent.
    const runOnce = runOnceCmd();
    for (const opt of runOnce.options) {
      if (opt.long !== undefined) {
        runOnce.setOptionValue(
          opt.long.replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()),
          opt.defaultValue,
        );
      }
    }
  });

  it('registered run-once declares --only-candidates', () => {
    const opt = runOnceCmd().options.find((o) => o.long === '--only-candidates');
    expect(opt, '--only-candidates must be a declared option').toBeDefined();
    expect(opt?.flags).toContain('<ids>');
  });

  it('probe AND dispatch wakes receive a skipCandidate that excludes foreign chains', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: `dreamer-${OWN_CAND}-prompt`,
      taskKind: 'dreamer',
      attemptCount: 1,
    });
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: `dreamer-${OWN_CAND}-prompt`,
      runId: 'run-oc-001',
      artifactId: 'pi-art-oc-001',
      resultRef: 'dreamer://run-oc-001',
      contextHash: 'ctx-oc',
      output: { valid: true, taskId: `dreamer-${OWN_CAND}-prompt`, candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    // No --runner: the handler first PROBES each supported kind with a
    // dry-run wakeOnce, then issues the kind-specific DISPATCH wake.
    await runOnceCmd().parseAsync(
      ['--workspace', WS, '--runtime', 'test-double', '--allow-test-double', '--only-candidates', `${OWN_CAND},${OTHER_OWN_CAND}`, '--json'],
      { from: 'user' },
    );

    // The first call is the probe for 'dreamer' (would_lease → discovery
    // stops there); the second is the dispatch wake for the same kind.
    expect(mockWakeOnce.mock.calls.length).toBe(2);
    for (const [kind, options] of mockWakeOnce.mock.calls) {
      expect(kind).toBe('dreamer');
      const skipCandidate = (options as { skipCandidate?: (t: { taskId: string; correlationId?: string }) => boolean } | undefined)?.skipCandidate;
      expect(skipCandidate, 'every wakeOnce must carry the allowlist predicate').toBeTypeOf('function');
      // Foreign chain tasks (correlationId AND embedded taskId shapes) are
      // skipped; both allowlisted chains pass.
      expect(skipCandidate!({ taskId: `philosopher-${FOREIGN_CAND}-prompt` })).toBe(true);
      expect(skipCandidate!({ taskId: 'task-x', correlationId: FOREIGN_CAND })).toBe(true);
      expect(skipCandidate!({ taskId: `dreamer-${OWN_CAND}-prompt` })).toBe(false);
      expect(skipCandidate!({ taskId: 'task-y', correlationId: OTHER_OWN_CAND })).toBe(false);
    }
    expect(mockRun).toHaveBeenCalledWith(`dreamer-${OWN_CAND}-prompt`);
  });

  it('explicit --runner still carries the allowlist into the dispatch wake', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'no_ready_tasks',
      inspectedCount: 1,
      reason: 'all_skipped_by_caller',
    });

    await runOnceCmd().parseAsync(
      ['--workspace', WS, '--runner', 'dreamer', '--runtime', 'test-double', '--allow-test-double', '--only-candidates', OWN_CAND, '--json'],
      { from: 'user' },
    );

    expect(mockWakeOnce).toHaveBeenCalledTimes(1);
    const options = mockWakeOnce.mock.calls[0][1] as { skipCandidate?: (t: { taskId: string; correlationId?: string }) => boolean } | undefined;
    expect(options?.skipCandidate).toBeTypeOf('function');
    expect(options!.skipCandidate!({ taskId: `scribe-${FOREIGN_CAND}-prompt` })).toBe(true);
    expect(options!.skipCandidate!({ taskId: `scribe-${OWN_CAND}-prompt` })).toBe(false);
  });

  it('without --only-candidates no candidate filter is passed (control)', async () => {
    mockWakeOnce.mockResolvedValue({ decision: 'no_ready_tasks', inspectedCount: 0, reason: 'no_candidates' });

    await runOnceCmd().parseAsync(
      ['--workspace', WS, '--runner', 'dreamer', '--runtime', 'test-double', '--allow-test-double', '--json'],
      { from: 'user' },
    );

    expect(mockWakeOnce).toHaveBeenCalledWith('dreamer', undefined);
  });
});
