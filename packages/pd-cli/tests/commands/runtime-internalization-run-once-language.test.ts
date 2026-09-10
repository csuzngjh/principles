/**
 * PRI-714 (review fix #3): run-once language wiring regression.
 *
 * The PR's original fault class was "the parameter exists but is not wired" —
 * builder-only tests still pass after deleting the production pass-through.
 * This regression drives the REAL `handleRuntimeInternalizationRunOnce`
 * handler against a REAL workspace directory whose `.pd/config.yaml` carries
 * `principles.outputLanguage`, through the REAL `readOutputLanguageFromWorkspace`
 * reader, and asserts the language value the handler passes into the runner
 * constructor options (the same options object the runner forwards to its
 * prompt builder — the runner→startRun message is proven message-level by
 * rulehost-pipeline-runner.test.ts and the consumer-cycle language test):
 *
 *   - explicit `principles.outputLanguage: 'en'` overrides the zh-CN default;
 *   - no config file resolves the zh-CN default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockWakeOnce = vi.fn();
const mockRun = vi.fn();
const mockCommitNextTaskProposal = vi.fn().mockResolvedValue({ decision: 'no_successor', sourceTaskId: '', reason: '' });
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockPiArtifactStore = {
  createArtifact: vi.fn().mockResolvedValue({}),
  upsertArtifact: vi.fn().mockResolvedValue({}),
  getArtifactById: vi.fn().mockResolvedValue(null),
  listBySourceTaskId: vi.fn().mockResolvedValue([]),
  listLineage: vi.fn().mockResolvedValue([]),
};

/** Captured runner constructor options — the handler → runner language seam. */
const runnerCtorOptions: Array<{ kind: string; options: Record<string, unknown> }> = [];

function recordRunnerCtor(kind: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (this: unknown, _deps: unknown, options: Record<string, unknown>) {
    runnerCtorOptions.push({ kind, options: { ...options } });
    return { run: mockRun };
  };
}

const tempDirs: string[] = [];

function makeWorkspace(outputLanguage?: 'en'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runonce-lang-'));
  tempDirs.push(dir);
  if (outputLanguage !== undefined) {
    fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
    // Full valid-config shape so validation keeps `principles` intact.
    const config = {
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
        correction_observer: { category: 'quiet', enabled: false },
        empathy_observer: { category: 'quiet', enabled: false },
      },
      runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
          dreamer: { enabled: true },
          scribe: { enabled: true },
          artificer: { enabled: true },
          philosopher: { enabled: false },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
        },
      },
      ui: { diagnostics: { mode: 'simple' } },
      principles: { outputLanguage },
    };
    // JSON is valid YAML — same trick the shared executor tests use.
    fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), JSON.stringify(config));
  }
  return dir;
}

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn(),
}));

const { mockResolveRuntimeFromPdConfig } = vi.hoisted(() => {
  const mockResolveRuntimeFromPdConfig = vi.fn().mockReturnValue({
    result: {
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      timeoutMs: 300_000,
      agentId: 'main',
    },
    legacyWarnings: [],
    configSource: '.pd/config.yaml',
    configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
  });
  return { mockResolveRuntimeFromPdConfig };
});

vi.mock('../../src/services/resolve-runtime-from-pd-config.js', () => ({
  resolveRuntimeFromPdConfig: mockResolveRuntimeFromPdConfig,
}));

vi.mock('@principles/core/runtime-v2', () => ({
  RuntimeStateManager: vi.fn().mockImplementation(function () {
    return {
      initialize: mockInitialize,
      close: mockClose,
      connection: {},
      taskStore: {},
      runStore: {},
      piArtifactStore: mockPiArtifactStore,
    };
  }),
  InternalizationOrchestrator: vi.fn().mockImplementation(function () {
    return { wakeOnce: mockWakeOnce, commitNextTaskProposal: mockCommitNextTaskProposal };
  }),
  DreamerRunner: vi.fn().mockImplementation(recordRunnerCtor('dreamer')),
  PhilosopherRunner: vi.fn().mockImplementation(recordRunnerCtor('philosopher')),
  ScribeRunner: vi.fn().mockImplementation(recordRunnerCtor('scribe')),
  ArtificerRunner: vi.fn().mockImplementation(recordRunnerCtor('artificer')),
  EvaluatorRunner: vi.fn().mockImplementation(recordRunnerCtor('evaluator')),
  RolloutReviewerRunner: vi.fn().mockImplementation(recordRunnerCtor('rollout_reviewer')),
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
  PiAiRuntimeAdapter: vi.fn().mockImplementation(function () {
    return {
      kind: vi.fn().mockReturnValue('pi-ai'),
      getCapabilities: vi.fn(),
      healthCheck: vi.fn(),
      startRun: vi.fn().mockResolvedValue({ runId: 'run-pi-001', runtimeKind: 'pi-ai', startedAt: new Date().toISOString() }),
      pollRun: vi.fn().mockResolvedValue({ runId: 'run-pi-001', status: 'succeeded' }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-pi-001', payload: {} }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    };
  }),
  OpenClawCliRuntimeAdapter: vi.fn().mockImplementation(function () {
    return {
      kind: vi.fn().mockReturnValue('openclaw-cli'),
      getCapabilities: vi.fn(),
      healthCheck: vi.fn(),
      startRun: vi.fn().mockResolvedValue({ runId: 'run-oc-001', runtimeKind: 'openclaw-cli', startedAt: new Date().toISOString() }),
      pollRun: vi.fn().mockResolvedValue({ runId: 'run-oc-001', status: 'succeeded' }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-oc-001', payload: {} }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    };
  }),
  DefaultDreamerValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultPhilosopherValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultScribeValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultArtificerValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultEvaluatorValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultRolloutReviewerValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  resolveRuntimeConfigFromPdConfig: vi.fn().mockReturnValue({ runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEST_API_KEY', timeoutMs: 300_000, agentId: 'main' }),
  resolveRuntimeConfig: vi.fn().mockReturnValue({ runtimeKind: 'pi-ai', timeoutMs: 300_000, agentId: 'main', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEST_API_KEY' }),
  validateRuntimeConfig: vi.fn(),
  isRuntimeConfigError: vi.fn().mockImplementation((result: unknown) => result != null && typeof result === 'object' && Object.hasOwn(result, 'reason') && !Object.hasOwn(result, 'runtimeKind')),
  // Minimal faithful re-implementation: the real resolver's behavior on the
  // values this test exercises ('en' explicit / undefined default).
  resolveOutputLanguage: vi.fn().mockImplementation((raw: unknown) =>
    (raw === 'en' ? { outputLanguage: 'en' as const } : { outputLanguage: 'zh-CN' as const })),
}));

// NOTE: `../../src/config-reader.js` is deliberately NOT mocked — the REAL
// readOutputLanguageFromWorkspace runs against the temp workspace, proving
// the handler consumes the actual workspace config.
vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({
    ok: true,
    effective: {},
    source: 'defaults',
    configPath: '/fake/workspace/.pd/config.yaml',
    warnings: [],
    legacyFilesDetected: [],
    legacyFileNextActions: [],
  }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue({ flags: {}, enabledChannels: [], warnings: [] }),
}));

vi.mock('@principles/host-runtime', () => ({
  createEvaluatorRuntimeContext: vi.fn().mockReturnValue({ ok: true, gateDeps: { evaluateInSandbox: vi.fn() } }),
  createRolloutGovernanceDeps: vi.fn().mockReturnValue({ dispatchActivation: vi.fn(), reopenRevisionTarget: vi.fn() }),
}));

import { handleRuntimeInternalizationRunOnce } from '../../src/commands/runtime-internalization-run-once.js';

function dreamerRunResult(taskId: string) {
  return {
    status: 'succeeded',
    taskId,
    runId: 'run-001',
    artifactId: 'pi-art-task-dreamer-001-run-001',
    resultRef: 'dreamer://run-001',
    contextHash: 'ctx-abc',
    output: {
      valid: true,
      taskId,
      candidates: [{ candidateIndex: 0, badDecision: 'Ignored validation', betterDecision: 'Validate inputs', rationale: 'Prevents errors', confidence: 0.9, riskLevel: 'low', strategicPerspective: 'defensive-programming' }],
      contextRefs: [],
      generatedAt: new Date().toISOString(),
    },
    attemptCount: 1,
  };
}

describe('handleRuntimeInternalizationRunOnce — outputLanguage wiring (PRI-714 review fix)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    runnerCtorOptions.length = 0;
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log');
    consoleErrorSpy = vi.spyOn(console, 'error');
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-001',
      taskKind: 'dreamer',
    });
    mockRun.mockImplementation(async (taskId: string) => dreamerRunResult(taskId));
  });

  afterEach(async () => {
    process.exitCode = 0;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    for (const dir of tempDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });

  it('explicit principles.outputLanguage=en reaches the runner options (overrides zh-CN default)', async () => {
    const workspace = makeWorkspace('en');
    (vi.mocked(await import('../../src/resolve-workspace.js')).resolveWorkspaceDir as ReturnType<typeof vi.fn>).mockReturnValue(workspace);

    await handleRuntimeInternalizationRunOnce({ workspace, json: true });

    expect(runnerCtorOptions.length).toBeGreaterThan(0);
    const dreamer = runnerCtorOptions.find((r) => r.kind === 'dreamer');
    expect(dreamer).toBeDefined();
    if (!dreamer) return;
    expect(dreamer.options.outputLanguage).toBe('en');
  });

  it('no config file resolves the zh-CN default into the runner options', async () => {
    const workspace = makeWorkspace();
    (vi.mocked(await import('../../src/resolve-workspace.js')).resolveWorkspaceDir as ReturnType<typeof vi.fn>).mockReturnValue(workspace);

    await handleRuntimeInternalizationRunOnce({ workspace, json: true });

    const dreamer = runnerCtorOptions.find((r) => r.kind === 'dreamer');
    expect(dreamer).toBeDefined();
    if (!dreamer) return;
    expect(dreamer.options.outputLanguage).toBe('zh-CN');
  });
});
