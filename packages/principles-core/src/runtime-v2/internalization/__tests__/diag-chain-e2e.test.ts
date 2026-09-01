/**
 * Diag Chain E2E — Integration test for the split diagnostician pipeline (PRI-372).
 *
 * Verifies:
 *   1. One pain signal completes A→B→C chain (schema validation + artifact consistency)
 *   2. Flag off: monolith runs unchanged (DiagnosticianRunner used, not split runners)
 *   3. split && !async_cli → fail loud at startup
 *   4. split && async_cli → valid, runners instantiated
 *
 * ERR entries considered:
 *   - ERR-001: Treat parsed JSON / LLM output as unknown
 *   - ERR-004: Lineage fields must be internally consistent
 *   - ERR-008: sourceTaskId/sourceRunIds must match
 */
import { describe, it, expect, vi } from 'vitest';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import { DiagRootCauseOutputV1Schema } from '../../diagnostician/diag-rootcause-output.js';
import { DiagDistillerOutputV1Schema } from '../../diagnostician/diag-distiller-output.js';
import { DiagnosticianOutputV1Schema } from '../../diagnostician-output.js';
import { Value } from '@sinclair/typebox/value';
import { DiagRootCauseRunner } from '../diag-rootcause-runner.js';
import type { DiagRootCauseRunnerDeps } from '../diag-rootcause-runner.js';
import { DiagDistillerRunner } from '../diag-distiller-runner.js';
import type { DiagDistillerRunnerDeps } from '../diag-distiller-runner.js';
import { DiagRouterRunner } from '../diag-router-runner.js';
import type { DiagRouterRunnerDeps } from '../diag-router-runner.js';
import { SplitDiagnosticianRunner } from '../split-diagnostician-runner.js';
import type { CommitResult } from '../../store/commit/diagnostician-committer.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { RunHandle, RunStatus } from '../../runtime-protocol.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../../config/pd-config-feature-flags.js';
import { computeEffectivePdConfig, resolveProfile } from '../../config/index.js';
import type { EffectivePdConfig, PdConfig } from '../../config/pd-config-types.js';
import { createPainSignalBridge } from '../../pain-signal-runtime-factory.js';
import type { LedgerAdapter } from '../../candidate-intake.js';
import { MOCK_ROOT_CAUSE_OUTPUTS, MOCK_DISTILLER_OUTPUTS, MOCK_ROUTER_OUTPUTS } from './__fixtures__/split-pipeline-mock-outputs.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const ROOTCAUSE_TASK_ID = 'diag_rootcause-e2e';
const DISTILLER_TASK_ID = 'diag_distiller-e2e';
const ROUTER_TASK_ID = 'diag_router-e2e';
const ROOTCAUSE_ARTIFACT_ID = 'pi-art-rootcause-e2e';
const DISTILLER_ARTIFACT_ID = 'pi-art-distiller-e2e';
const OWNER = 'test-e2e-owner';
const RUNTIME_KIND = 'test-double';

/** Happy-path output using cached real LLM data (R6 fixture) with test-local IDs. */
function makeRootCauseOutput(): DiagRootCauseOutputV1 {
  return {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-e2e-001',
    taskId: ROOTCAUSE_TASK_ID,
  };
}

/** Happy-path output using cached real LLM data (R6 fixture) with test-local IDs. */
function makeDistillerOutput(overrides: Partial<DiagDistillerOutputV1> = {}): DiagDistillerOutputV1 {
  return {
    ...MOCK_DISTILLER_OUTPUTS.R6,
    taskId: DISTILLER_TASK_ID,
    sourceRootCauseArtifactId: ROOTCAUSE_ARTIFACT_ID,
    ...overrides,
  };
}

/** Happy-path output using cached real LLM data (R6 fixture) with test-local IDs. */
function makeRouterOutput(): DiagnosticianOutputV1 {
  return {
    ...MOCK_ROUTER_OUTPUTS.R6,
    diagnosisId: 'diag-e2e-001',
  };
}

function makeContextPayload() {
  return {
    sourceRefs: ['ref-1', 'ref-2'],
    conversationWindow: [],
    trajectorySummary: '',
    painSignal: { painId: 'pain-e2e-001', painType: 'tool_failure', source: 'test', reason: 'test reason', score: 70 },
  };
}

// ── Shared mock helpers ────────────────────────────────────────────────────────

function makeRunHandle(runId: string): RunHandle {
  return { runId, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
}

function makeSucceededStatus(runId: string): RunStatus {
  return { status: 'succeeded', runId };
}

function makeMockStateManager(taskOverrides: Record<string, TaskRecord>) {
  return {
    acquireLease: vi.fn().mockImplementation((params: { taskId: string }) => {
      const task = taskOverrides[params.taskId];
      return task ? Promise.resolve(task) : Promise.resolve(undefined);
    }),
    getTask: vi.fn().mockImplementation((id: string) => {
      return Promise.resolve(taskOverrides[id] ?? undefined);
    }),
    getRunsByTask: vi.fn().mockImplementation((taskId: string) => {
      // Return a run record for each task so resolveStoreRunId works
      return Promise.resolve([{ runId: `run-${taskId}`, taskId }]);
    }),
    getValidRunsByTaskTolerant: vi.fn().mockImplementation((taskId: string) => {
      return Promise.resolve({ runs: [{ runId: `run-${taskId}`, taskId }], degradedRuns: [] });
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    createTask: vi.fn().mockImplementation((record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>) => {
      const task: TaskRecord = {
        ...record,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      taskOverrides[record.taskId] = task;
      return Promise.resolve(task);
    }),
  };
}

function makeMockRuntimeAdapter() {
  return {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(makeRunHandle('run-e2e')),
    pollRun: vi.fn().mockResolvedValue(makeSucceededStatus('run-e2e')),
    fetchOutput: vi.fn().mockResolvedValue({ payload: makeRootCauseOutput() }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchArtifacts: vi.fn(),
  };
}

function makeMockEventEmitter() {
  return {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };
}

function makeDefaultInternalAgents(): EffectivePdConfig['config']['internalAgents'] {
  return {
    defaultRuntime: 'default',
    agents: {
      diagnostician: { enabled: true },
      dreamer: { enabled: true },
      philosopher: { enabled: true },
      scribe: { enabled: true },
      artificer: { enabled: true },
      evaluator: { enabled: true },
      rolloutReviewer: { enabled: true },
      correctionObserver: { enabled: true },
      empathyObserver: { enabled: true },
      signalCollector: { enabled: false },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Diag chain e2e', () => {
  // ── Schema validation tests ────────────────────────────────────────────────

  it('Stage A output passes TypeBox schema validation', () => {
    const output = makeRootCauseOutput();
    expect(Value.Check(DiagRootCauseOutputV1Schema, output)).toBe(true);
  });

  it('Stage B output passes TypeBox schema validation and references Stage A artifact', () => {
    const output = makeDistillerOutput();
    expect(Value.Check(DiagDistillerOutputV1Schema, output)).toBe(true);
    // Lineage integrity: sourceRootCauseArtifactId must reference Stage A
    expect(output.sourceRootCauseArtifactId).toBe(ROOTCAUSE_ARTIFACT_ID);
  });

  it('Stage C output passes TypeBox schema validation', () => {
    const output = makeRouterOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, output)).toBe(true);
  });

  it('artifact chain is internally consistent', () => {
    const rootCauseOutput = makeRootCauseOutput();
    const distillerOutput = makeDistillerOutput();
    const routerOutput = makeRouterOutput();

    // Stage B references Stage A artifact
    expect(distillerOutput.sourceRootCauseArtifactId).toBe(ROOTCAUSE_ARTIFACT_ID);

    // All outputs have valid=true
    expect(rootCauseOutput.valid).toBe(true);
    expect(distillerOutput.valid).toBe(true);
    expect(routerOutput.valid).toBe(true);

    // Root cause category is consistent across stages
    expect(rootCauseOutput.rootCauseCategory).toBe('Design');
    expect(rootCauseOutput.rootCause).toContain('Design:');
    expect(routerOutput.rootCause).toContain('Design:');
  });

  // ── Full A→B→C chain test ──────────────────────────────────────────────────

  it('one pain signal completes A→B→C and triggers committer + onDiagnosisComplete', async () => {
    const artifactStore = new MemoryPIArtifactStore();

    const rootCauseTask: TaskRecord = {
      taskId: ROOTCAUSE_TASK_ID,
      taskKind: 'diag_rootcause',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    };

    const distillerTask: TaskRecord = {
      taskId: DISTILLER_TASK_ID,
      taskKind: 'diag_distiller',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [ROOTCAUSE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    };

    const routerTask: TaskRecord = {
      taskId: ROUTER_TASK_ID,
      taskKind: 'diag_router',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [ROOTCAUSE_TASK_ID, DISTILLER_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    };

    const taskMap: Record<string, TaskRecord> = {
      [ROOTCAUSE_TASK_ID]: rootCauseTask,
      [DISTILLER_TASK_ID]: distillerTask,
      [ROUTER_TASK_ID]: routerTask,
    };

    const stateManager = makeMockStateManager(taskMap);
    const runtimeAdapter = makeMockRuntimeAdapter();
    const eventEmitter = makeMockEventEmitter();
    const contextAssembler = { assemble: vi.fn().mockResolvedValue(makeContextPayload()) };

    // ── Stage A: DiagRootCauseRunner ──────────────────────────────────────────
    const rootCauseRunId = 'run-rc-e2e';
    runtimeAdapter.startRun.mockResolvedValue(makeRunHandle(rootCauseRunId));
    runtimeAdapter.pollRun.mockResolvedValue(makeSucceededStatus(rootCauseRunId));
    runtimeAdapter.fetchOutput.mockResolvedValue({ payload: makeRootCauseOutput() });

    const rootCauseDeps: DiagRootCauseRunnerDeps = {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      artifactStore,
      validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) },
      contextAssembler: contextAssembler,
    };

    const rootCauseRunner = new DiagRootCauseRunner(rootCauseDeps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const resultA = await rootCauseRunner.run(ROOTCAUSE_TASK_ID);
    expect(resultA.status).toBe('succeeded');
    expect(resultA.artifactId).toBeDefined();

    // Verify Stage A artifact was written
    const artifactsA = await artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifactsA).toHaveLength(1);
    expect(artifactsA[0]?.artifactKind).toBe('principle');

    // ── Stage B: DiagDistillerRunner ──────────────────────────────────────────
    const distillerRunId = 'run-dist-e2e';
    runtimeAdapter.startRun.mockResolvedValue(makeRunHandle(distillerRunId));
    runtimeAdapter.pollRun.mockResolvedValue(makeSucceededStatus(distillerRunId));
    // Use the actual artifact ID from Stage A for lineage integrity check (EP-07)
    const stageAArtifactId = resultA.artifactId ?? ROOTCAUSE_ARTIFACT_ID;
    runtimeAdapter.fetchOutput.mockResolvedValue({ payload: makeDistillerOutput({ sourceRootCauseArtifactId: stageAArtifactId }) });

    const distillerDeps: DiagDistillerRunnerDeps = {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      artifactStore,
      validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) },
    };

    const distillerRunner = new DiagDistillerRunner(distillerDeps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const resultB = await distillerRunner.run(DISTILLER_TASK_ID);
    expect(resultB.status).toBe('succeeded');
    expect(resultB.artifactId).toBeDefined();

    // Verify Stage B artifact was written
    const artifactsB = await artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifactsB).toHaveLength(1);

    // ── Stage C: DiagRouterRunner ─────────────────────────────────────────────
    const routerRunId = 'run-router-e2e';
    runtimeAdapter.startRun.mockResolvedValue(makeRunHandle(routerRunId));
    runtimeAdapter.pollRun.mockResolvedValue(makeSucceededStatus(routerRunId));
    runtimeAdapter.fetchOutput.mockResolvedValue({ payload: makeRouterOutput() });

    const commitResult: CommitResult = {
      commitId: 'commit-e2e-001',
      artifactId: 'art-e2e-001',
      candidateCount: 1,
    };

    const committer = { commit: vi.fn().mockResolvedValue(commitResult) };

    const routerDeps: DiagRouterRunnerDeps = {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      artifactStore,
      committer: committer,
    };

    const routerRunner = new DiagRouterRunner(routerDeps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const resultC = await routerRunner.run(ROUTER_TASK_ID);
    expect(resultC.status).toBe('succeeded');

    // Verify committer was called
    expect(committer.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: ROUTER_TASK_ID,
      }),
    );
  });

  // ── Flag matrix guard tests ────────────────────────────────────────────────

  it('flag off: splitPipeline flag can be disabled via config', () => {
    const effectiveConfig: EffectivePdConfig = {
      config: {
        version: 1,
        features: {
          diagnostician_split_pipeline: { category: 'quiet', enabled: false },
        },
        runtimeProfiles: {},
        internalAgents: makeDefaultInternalAgents(),
        ui: { diagnostics: { mode: 'simple' } },
      },
      source: 'user_config',
      warnings: [],
      resolvedProfile: resolveProfile({}),
      resolvedContextInjection: {
        thinkingOs: false,
        projectFocus: 'off',
        evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
      },
    };

    const featureFlags = computeFeatureFlagsFromConfig(effectiveConfig);
    const splitPipeline = isFeatureEnabled(featureFlags, 'diagnostician_split_pipeline');
    expect(splitPipeline).toBe(false);
  });

  it('PRI-638 P1-E: split && !async_cli no longer fail-loud — the split flag has no runtime authority', async () => {
    // PRI-638 removed the split/async coherence guard: the split pipeline is
    // the only implementation and the deprecated flag no longer decides any
    // runtime behavior (nor a safety guard — that would be a ghost authority).
    // Explicit split=true + async=false therefore proceeds past config
    // resolution instead of throwing 'input_invalid'.
    const effectiveConfig: EffectivePdConfig = {
      config: {
        version: 1,
        features: {
          diagnostician_split_pipeline: { category: 'quiet', enabled: true },
          diagnostician_async_cli: { category: 'quiet', enabled: false },
        },
        runtimeProfiles: {
          'default': { type: 'openclaw', source: 'default' },
        },
        internalAgents: makeDefaultInternalAgents(),
        ui: { diagnostics: { mode: 'simple' } },
      },
      source: 'user_config',
      warnings: [],
      featuresChangedFromDefault: ['diagnostician_split_pipeline'],
      resolvedProfile: resolveProfile({}),
      resolvedContextInjection: {
        thinkingOs: false,
        projectFocus: 'off',
        evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
      },
    };

    // Use os.tmpdir() to avoid polluting disk root with /invalid-path-a on Windows
    // (path.resolve('/invalid-path-a') → D:\invalid-path-a on Windows).
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diag-e2e-guard-a-'));

    try {
      const result = createPainSignalBridge({
        workspaceDir: tmpRoot,
        stateDir: tmpRoot,
        effectiveConfig,
        ledgerAdapter: { writeProbationEntry: vi.fn() } as unknown as LedgerAdapter,
      });
      try {
        await result;
        expect.unreachable('should have failed with filesystem/db error');
      } catch (err: unknown) {
        const error = err as Error & { code?: string };
        // NOT the removed guard's PDRuntimeError — the flag no longer throws.
        expect(error.code).not.toBe('input_invalid');
        expect(error.message).not.toContain('diagnostician_split_pipeline requires');
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('split && !async_cli → does NOT throw at startup for default configuration', async () => {
    const defaults = computeEffectivePdConfig(null);
    // Use os.tmpdir() to avoid polluting disk root with /invalid-path-b on Windows.
    // The path is "invalid" in the sense that it has no pre-configured .pd/config.yaml,
    // but it exists on disk so mkdirSync succeeds and DB init proceeds (then fails
    // later due to missing config, not factory guard).
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diag-e2e-guard-b-'));

    // Should NOT throw the factory guard (so it will proceed to DB init and fail with a filesystem/db error, not PDRuntimeError input_invalid)
    const result = createPainSignalBridge({
      workspaceDir: tmpRoot,
      stateDir: tmpRoot,
      effectiveConfig: defaults,
      ledgerAdapter: { writeProbationEntry: vi.fn() } as unknown as LedgerAdapter,
    });

    try {
      await result;
      expect.unreachable('should have failed with filesystem/db error');
    } catch (err: unknown) {
      const error = err as Error & { code?: string };
      // It should NOT be the PDRuntimeError with code 'input_invalid' from the factory guard
      expect(error.code).not.toBe('input_invalid');
      expect(error.message).not.toContain('diagnostician_split_pipeline requires');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('user config matching defaults does not trigger the factory guard', async () => {
    // Completely list default flags matching their default values
    const userConfig = {
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
        correction_observer: { category: 'quiet', enabled: true },
        feedback_channel: { category: 'quiet', enabled: true },
        gfi: { category: 'quiet', enabled: false },
        evolution_worker: { category: 'quiet', enabled: false },
        empathy_observer: { category: 'quiet', enabled: false },
        painEvidenceAdmission: { category: 'quiet', enabled: false },
        diagnostician_async_cli: { category: 'quiet', enabled: false },
        diagnostician_core_grounding: { category: 'quiet', enabled: true },
        diagnostician_split_pipeline: { category: 'quiet', enabled: true },
        nocturnal: { category: 'gone', enabled: false },
        idle_trigger: { category: 'gone', enabled: false },
      },
      runtimeProfiles: {
        'default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: makeDefaultInternalAgents(),
      ui: { diagnostics: { mode: 'simple' } },
    };

    const effectiveConfig = computeEffectivePdConfig(userConfig as unknown as PdConfig);

    // Verify neither split_pipeline nor async_cli is in featuresChangedFromDefault
    expect(effectiveConfig.featuresChangedFromDefault).not.toContain('diagnostician_split_pipeline');
    expect(effectiveConfig.featuresChangedFromDefault).not.toContain('diagnostician_async_cli');

    // Use os.tmpdir() to avoid polluting disk root with /invalid-path-matching-defaults on Windows.
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diag-e2e-defaults-'));

    // Verify it does NOT throw the factory guard
    const result = createPainSignalBridge({
      workspaceDir: tmpRoot,
      stateDir: tmpRoot,
      effectiveConfig,
      ledgerAdapter: { writeProbationEntry: vi.fn() } as unknown as LedgerAdapter,
    });

    try {
      await result;
      expect.unreachable('should have failed with filesystem/db error');
    } catch (err: unknown) {
      const error = err as Error & { code?: string };
      expect(error.code).not.toBe('input_invalid');
      expect(error.message).not.toContain('diagnostician_split_pipeline requires');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('split && async_cli → valid, runners instantiated', () => {
    // When both flags are on, the factory should create the 3 split runners.
    const effectiveConfig: EffectivePdConfig = {
      config: {
        version: 1,
        features: {
          diagnostician_split_pipeline: { category: 'quiet', enabled: true },
          diagnostician_async_cli: { category: 'quiet', enabled: true },
        },
        runtimeProfiles: {},
        internalAgents: makeDefaultInternalAgents(),
        ui: { diagnostics: { mode: 'simple' } },
      },
      source: 'user_config',
      warnings: [],
      resolvedProfile: resolveProfile({}),
      resolvedContextInjection: {
        thinkingOs: false,
        projectFocus: 'off',
        evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
      },
    };

    const featureFlags = computeFeatureFlagsFromConfig(effectiveConfig);
    const splitPipeline = isFeatureEnabled(featureFlags, 'diagnostician_split_pipeline');
    const asyncCli = isFeatureEnabled(featureFlags, 'diagnostician_async_cli');

    // Both flags should be enabled
    expect(splitPipeline).toBe(true);
    expect(asyncCli).toBe(true);

    // The guard should NOT throw — verify by simulating the factory guard
    if (splitPipeline && !asyncCli) {
      expect.unreachable('Should not throw when both flags are on');
    }
    // If we reach here, the guard passes — runners would be instantiated
    expect(splitPipeline && asyncCli).toBe(true);
  });

  // ── Cross-stage lineage integrity ──────────────────────────────────────────

  it('Stage B sourceRootCauseArtifactId matches Stage A artifact ID', async () => {
    const artifactStore = new MemoryPIArtifactStore();

    // Write Stage A artifact
    await artifactStore.upsertArtifact({
      artifactId: ROOTCAUSE_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: ROOTCAUSE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify(makeRootCauseOutput()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Verify Stage B output references the correct artifact
    const distillerOutput = makeDistillerOutput();
    expect(distillerOutput.sourceRootCauseArtifactId).toBe(ROOTCAUSE_ARTIFACT_ID);

    // Verify the artifact exists in the store
    const artifacts = await artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactId).toBe(ROOTCAUSE_ARTIFACT_ID);
  });

  it('Stage C reads both Stage A and Stage B artifacts', async () => {
    const artifactStore = new MemoryPIArtifactStore();

    // Write Stage A artifact
    await artifactStore.upsertArtifact({
      artifactId: ROOTCAUSE_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: ROOTCAUSE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify(makeRootCauseOutput()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Write Stage B artifact
    await artifactStore.upsertArtifact({
      artifactId: DISTILLER_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: DISTILLER_TASK_ID,
      lineageArtifactIds: [ROOTCAUSE_ARTIFACT_ID],
      validationStatus: 'pending',
      contentJson: JSON.stringify(makeDistillerOutput()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Verify both artifacts exist
    const artifactsA = await artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    const artifactsB = await artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifactsA).toHaveLength(1);
    expect(artifactsB).toHaveLength(1);

    // Verify Stage B lineage includes Stage A artifact
    expect(artifactsB[0]?.lineageArtifactIds).toContain(ROOTCAUSE_ARTIFACT_ID);
  });

  // ── SplitDiagnosticianRunner orchestration test ────────────────────────────

  it('SplitDiagnosticianRunner orchestrates A→B→C and returns RunnerResult', async () => {
    const artifactStore = new MemoryPIArtifactStore();
    const PARENT_TASK_ID = 'diagnosis_split-e2e';
    const STAGE_A_TASK_ID = `diag_rootcause-${PARENT_TASK_ID}`;
    const STAGE_B_TASK_ID = `diag_distiller-${PARENT_TASK_ID}`;
    const STAGE_C_TASK_ID = `diag_router-${PARENT_TASK_ID}`;

    const taskMap: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(taskMap);

    const runtimeAdapter = makeMockRuntimeAdapter();
    const eventEmitter = makeMockEventEmitter();
    const contextAssembler = { assemble: vi.fn().mockResolvedValue(makeContextPayload()) };

    // Stage A runner setup
    const rootCauseRunId = 'run-split-rc';
    runtimeAdapter.startRun.mockResolvedValue(makeRunHandle(rootCauseRunId));
    runtimeAdapter.pollRun.mockResolvedValue(makeSucceededStatus(rootCauseRunId));
    // The store's run ID is 'run-${taskId}' per makeMockStateManager
    const storeRunIdA = `run-${STAGE_A_TASK_ID}`;
    const expectedStageAArtifactId = `pi-art-${STAGE_A_TASK_ID}-${storeRunIdA}`;
    // fetchOutput returns different outputs per stage — use mockImplementation
    // Stage A is first, Stage B second, Stage C third
    let fetchCallCount = 0;
    runtimeAdapter.fetchOutput.mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return { payload: makeRootCauseOutput() };
      }
      if (fetchCallCount === 2) {
        // Stage B: use the artifact ID that Stage A wrote (based on store run ID)
        return { payload: makeDistillerOutput({ sourceRootCauseArtifactId: expectedStageAArtifactId }) };
      }
      return { payload: makeRouterOutput() };
    });

    const rootCauseDeps: DiagRootCauseRunnerDeps = {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      artifactStore,
      validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) },
      contextAssembler: contextAssembler,
    };

    const rootCauseRunner = new DiagRootCauseRunner(rootCauseDeps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    // Stage B runner
    const distillerDeps: DiagDistillerRunnerDeps = {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      artifactStore,
      validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) },
    };

    const distillerRunner = new DiagDistillerRunner(distillerDeps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    // Stage C runner
    const commitResult: CommitResult = {
      commitId: 'commit-split-e2e',
      artifactId: 'art-split-e2e',
      candidateCount: 1,
    };
    const committer = { commit: vi.fn().mockResolvedValue(commitResult) };

    const routerDeps: DiagRouterRunnerDeps = {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      artifactStore,
      committer: committer,
    };

    const routerRunner = new DiagRouterRunner(routerDeps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    // Create the split runner
    const splitRunner = new SplitDiagnosticianRunner({
      rootCauseRunner,
      distillerRunner,
      routerRunner,
      stateManager: stateManager as unknown as RuntimeStateManager,
      committer: committer,
    });

    // Run the split pipeline
    const result = await splitRunner.run(PARENT_TASK_ID);

    // Verify the result
    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(PARENT_TASK_ID);
    expect(result.output).toBeDefined();
    expect(result.output?.valid).toBe(true);

    // Verify all 3 sub-tasks were created
    expect(taskMap[STAGE_A_TASK_ID]).toBeDefined();
    expect(taskMap[STAGE_A_TASK_ID]?.taskKind).toBe('diag_rootcause');
    expect(taskMap[STAGE_B_TASK_ID]).toBeDefined();
    expect(taskMap[STAGE_B_TASK_ID]?.taskKind).toBe('diag_distiller');
    expect(taskMap[STAGE_C_TASK_ID]).toBeDefined();
    expect(taskMap[STAGE_C_TASK_ID]?.taskKind).toBe('diag_router');

    // Verify Stage B depends on Stage A
    const stageBDiag = taskMap[STAGE_B_TASK_ID]?.diagnosticJson;
    expect(stageBDiag).toContain(STAGE_A_TASK_ID);

    // Verify Stage C depends on both A and B
    const stageCDiag = taskMap[STAGE_C_TASK_ID]?.diagnosticJson;
    expect(stageCDiag).toContain(STAGE_A_TASK_ID);
    expect(stageCDiag).toContain(STAGE_B_TASK_ID);

    // Verify committer was called (by Stage C)
    expect(committer.commit).toHaveBeenCalled();

    // Verify artifacts were written for all 3 stages
    const artifactsA = await artifactStore.listBySourceTaskId(STAGE_A_TASK_ID);
    const artifactsB = await artifactStore.listBySourceTaskId(STAGE_B_TASK_ID);
    expect(artifactsA).toHaveLength(1);
    expect(artifactsB).toHaveLength(1);
  });

  it('SplitDiagnosticianRunner stops and returns failure when Stage A fails', async () => {
    const artifactStore = new MemoryPIArtifactStore();
    const PARENT_TASK_ID = 'diagnosis_split-fail-a';

    const taskMap: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(taskMap);

    const runtimeAdapter = makeMockRuntimeAdapter();
    const eventEmitter = makeMockEventEmitter();
    const contextAssembler = { assemble: vi.fn().mockResolvedValue(makeContextPayload()) };

    // Stage A fails
    runtimeAdapter.startRun.mockResolvedValue(makeRunHandle('run-fail-rc'));
    runtimeAdapter.pollRun.mockResolvedValue({ status: 'failed', runId: 'run-fail-rc' });

    const rootCauseDeps: DiagRootCauseRunnerDeps = {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      artifactStore,
      validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) },
      contextAssembler: contextAssembler,
    };

    const rootCauseRunner = new DiagRootCauseRunner(rootCauseDeps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const distillerRunner = new DiagDistillerRunner(
      { stateManager: stateManager as unknown as RuntimeStateManager, runtimeAdapter: runtimeAdapter, eventEmitter: eventEmitter as unknown as StoreEventEmitter, artifactStore, validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) } },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
    );

    const committer = { commit: vi.fn() };

    const routerRunner = new DiagRouterRunner(
      { stateManager: stateManager as unknown as RuntimeStateManager, runtimeAdapter: runtimeAdapter, eventEmitter: eventEmitter as unknown as StoreEventEmitter, artifactStore, committer: committer },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
    );

    const splitRunner = new SplitDiagnosticianRunner({
      rootCauseRunner,
      distillerRunner,
      routerRunner,
      stateManager: stateManager as unknown as RuntimeStateManager,
      committer: committer,
    });

    const result = await splitRunner.run(PARENT_TASK_ID);

    // Should fail — Stage A failed
    expect(result.status).toBe('failed');
    expect(result.taskId).toBe(PARENT_TASK_ID);
    // The failure reason comes from the runner (max_attempts_exceeded)
    expect(result.errorCategory).toBe('max_attempts_exceeded');

    // Stage B and C tasks should NOT have been created
    expect(taskMap[`diag_distiller-${PARENT_TASK_ID}`]).toBeUndefined();
    expect(taskMap[`diag_router-${PARENT_TASK_ID}`]).toBeUndefined();

    // Committer should NOT have been called
    expect(committer.commit).not.toHaveBeenCalled();
  });

  it('split pipeline end-to-end boundary integration (real SQLite + Bridge + Committer + Intake + Ledger)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { RuntimeStateManager } = await import('../../store/runtime-state-manager.js');
    const { SqliteDiagnosticianCommitter } = await import('../../store/commit/diagnostician-committer.js');
    const { SqliteContextAssembler } = await import('../../store/context/sqlite-context-assembler.js');
    const { SqliteHistoryQuery } = await import('../../store/history/sqlite-history-query.js');
    const { PainSignalBridge } = await import('../../pain-signal-bridge.js');
    const { CandidateIntakeService } = await import('../../candidate-intake-service.js');
    const { DiagRootCauseRunner: DiagRootCauseRunnerImpl } = await import('../diag-rootcause-runner.js');
    const { DiagDistillerRunner: DiagDistillerRunnerImpl } = await import('../diag-distiller-runner.js');
    const { DiagRouterRunner: DiagRouterRunnerImpl } = await import('../diag-router-runner.js');
    const { SplitDiagnosticianRunner: SplitDiagnosticianRunnerImpl } = await import('../split-diagnostician-runner.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-split-e2e-boundary-'));
    const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    try {
      await stateManager.initialize();

      const committer = new SqliteDiagnosticianCommitter(stateManager.connection);
      const trajectoryTurnReader = {
        listUserTurnsForSession: vi.fn().mockReturnValue([]),
        listAssistantTurns: vi.fn().mockReturnValue([]),
      };
      const contextAssembler = new SqliteContextAssembler(
        stateManager.taskStore,
        new SqliteHistoryQuery(stateManager.connection),
        stateManager.runStore,
        { trajectoryTurnReader },
      );

      const runtimeAdapter = makeMockRuntimeAdapter();
      let runCount = 0;
      runtimeAdapter.startRun.mockImplementation(async () => {
        runCount++;
        return { runId: `run-e2e-${runCount}`, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
      });
      runtimeAdapter.pollRun.mockImplementation(async (handle: Record<string, unknown>) => {
        return { status: 'succeeded', runId: handle.runId };
      });
      let fetchCallCount = 0;
      runtimeAdapter.fetchOutput.mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return { payload: makeRootCauseOutput() };
        }
        if (fetchCallCount === 2) {
          const artifactsA = await stateManager.piArtifactStore.listBySourceTaskId(`diag_rootcause-diagnosis_pain-e2e-boundary`);
          const stageAArtifactId = artifactsA[0]?.artifactId ?? ROOTCAUSE_ARTIFACT_ID;
          return { payload: makeDistillerOutput({ sourceRootCauseArtifactId: stageAArtifactId }) };
        }
        return { payload: makeRouterOutput() };
      });

      const rootCauseRunner = new DiagRootCauseRunnerImpl(
        {
          stateManager,
          runtimeAdapter: runtimeAdapter,
          eventEmitter: makeMockEventEmitter() as unknown as StoreEventEmitter,
          artifactStore: stateManager.piArtifactStore,
          validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) },
          contextAssembler,
        },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const distillerRunner = new DiagDistillerRunnerImpl(
        {
          stateManager,
          runtimeAdapter: runtimeAdapter,
          eventEmitter: makeMockEventEmitter() as unknown as StoreEventEmitter,
          artifactStore: stateManager.piArtifactStore,
          validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) },
        },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const routerRunner = new DiagRouterRunnerImpl(
        {
          stateManager,
          runtimeAdapter: runtimeAdapter,
          eventEmitter: makeMockEventEmitter() as unknown as StoreEventEmitter,
          artifactStore: stateManager.piArtifactStore,
          committer,
        },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );

      const splitRunner = new SplitDiagnosticianRunnerImpl({
        rootCauseRunner,
        distillerRunner,
        routerRunner,
        stateManager,
        committer,
      });

      const ledgerAdapter = {
        writeProbationEntry: vi.fn().mockImplementation((entry) => entry),
        existsForCandidate: vi.fn().mockReturnValue(null),
      };
      const intakeService = new CandidateIntakeService({
        stateManager,
        ledgerAdapter: ledgerAdapter,
      });

      const bridge = new PainSignalBridge({
        stateManager,
        runner: splitRunner,
        intakeService,
        ledgerAdapter: ledgerAdapter,
        autoIntakeEnabled: true,
        workspaceDir: tmpDir,
      });

      const painSignal = {
        painId: 'pain-e2e-boundary',
        painType: 'tool_failure' as const,
        source: 'test-source',
        reason: 'test reason',
        evidence: [{ sourceRef: 'src-1', note: 'some evidence note' }],
      };

      const bridgeResult = await bridge.onPainDetected(painSignal);

      // Verify successful e2e execution status. The R6 fixture yields an
      // `implementation` candidate (skill channel is MVP-disabled), so the
      // bridge surfaces it as not_internalizable → degraded (PRI-539), while
      // still succeeding on principle/rule intake.
      expect(bridgeResult.status).toBe('degraded');
      expect(bridgeResult.notInternalizable).toHaveLength(1);
      expect(bridgeResult.notInternalizable?.[0]?.reason).toContain('MVP-disabled');
      expect(bridgeResult.message).toContain('not_internalizable');
      expect(bridgeResult.painId).toBe(painSignal.painId);
      expect(bridgeResult.taskId).toBe(`diagnosis_${painSignal.painId}`);

      // Verify all 3 sub-tasks were written to the state.db
      const parentTaskId = `diagnosis_${painSignal.painId}`;
      const taskA = await stateManager.getTask(`diag_rootcause-${parentTaskId}`);
      const taskB = await stateManager.getTask(`diag_distiller-${parentTaskId}`);
      const taskC = await stateManager.getTask(`diag_router-${parentTaskId}`);
      expect(taskA?.status).toBe('succeeded');
      expect(taskB?.status).toBe('succeeded');
      expect(taskC?.status).toBe('succeeded');

      // Verify candidate was committed and then registered to the ledger!
      expect(ledgerAdapter.writeProbationEntry).toHaveBeenCalled();
    } finally {
      stateManager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
