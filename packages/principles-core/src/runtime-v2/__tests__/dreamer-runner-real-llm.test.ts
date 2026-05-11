import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import { DefaultDreamerValidator } from '../internalization/dreamer-output.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import { PiAiRuntimeAdapter } from '../adapter/pi-ai-runtime-adapter.js';
import { StoreEventEmitter } from '../store/event-emitter.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import { getMiniMaxConfig } from './fixtures/llm-e2e-config.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-dreamer-${process.pid}`);

function makeAdapterConfig() {
  const config = getMiniMaxConfig();
  if (!config) return null;
  return {
    provider: config.provider,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
  };
}

describe('DreamerRunner Real LLM E2E (MiniMax)', () => {
  let testDir = '';
  let stateManager: RuntimeStateManager | null = null;
  let artifactStore: PIArtifactStore | null = null;
  let _eventEmitter: StoreEventEmitter | null = null;
  let _runtimeAdapter: PiAiRuntimeAdapter | null = null;
  let runner: DreamerRunner | null = null;

  beforeEach(async () => {
    const adapterConfig = makeAdapterConfig();
    if (!adapterConfig) {
      return;
    }

    testDir = path.join(TMP_ROOT, `dreamer-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const sm = new RuntimeStateManager({ workspaceDir: testDir });
    await sm.initialize();
    stateManager = sm;

    const as = new MemoryPIArtifactStore();
    artifactStore = as;

    const ee = new StoreEventEmitter();
    _eventEmitter = ee;

    const ra = new PiAiRuntimeAdapter(adapterConfig);
    _runtimeAdapter = ra;

    runner = new DreamerRunner(
      {
        stateManager: sm,
        runtimeAdapter: ra,
        eventEmitter: ee,
        validator: new DefaultDreamerValidator(),
        artifactStore: as,
      },
      {
        owner: 'e2e-dreamer-minimax',
        runtimeKind: 'pi-ai',
        pollIntervalMs: 100,
        timeoutMs: adapterConfig.timeoutMs,
      },
    );
  });

  afterEach(async () => {
    if (stateManager) {
      stateManager.close();
    }
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should succeed with valid DreamerOutput from real MiniMax LLM', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !artifactStore || !runner) {
      expect(true).toBe(true);
      return;
    }

    const taskId = `dreamer-e2e-${Date.now()}`;
    await stateManager.createTask({
      taskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const result = await runner.run(taskId);

    console.log('DreamerRunner result:', JSON.stringify({
      status: result.status,
      taskId: result.taskId,
      errorCategory: result.errorCategory,
      failureReason: result.failureReason,
      attemptCount: result.attemptCount,
    }, null, 2));

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(taskId);
    expect(result.artifactId).toBeDefined();
    expect(result.resultRef).toContain('dreamer://');

    const artifacts = await artifactStore.listBySourceTaskId(taskId);
    expect(artifacts.length).toBeGreaterThan(0);
    const [firstArtifact] = artifacts;
    expect(firstArtifact?.artifactKind).toBe('principle');

    const updatedTask = await stateManager.getTask(taskId);
    expect(updatedTask?.status).toBe('succeeded');

    console.log(`✅ DreamerRunner succeeded with artifact: ${result.artifactId}`);
  }, 120_000);

  it('should handle real LLM output and validate DreamerOutputV1 schema', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !runner) {
      expect(true).toBe(true);
      return;
    }

    const taskId = `dreamer-schema-${Date.now()}`;
    await stateManager.createTask({
      taskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const result = await runner.run(taskId);

    expect(result.status).toBe('succeeded');
    expect(result.output).toBeDefined();
    expect(result.output?.valid).toBe(true);
    expect(result.output?.candidates).toBeDefined();
    expect(Array.isArray(result.output?.candidates)).toBe(true);

    if (result.output?.candidates && result.output.candidates.length > 0) {
      const [candidate] = result.output.candidates;
      expect(candidate.badDecision).toBeDefined();
      expect(candidate.betterDecision).toBeDefined();
      expect(candidate.rationale).toBeDefined();
      expect(typeof candidate.confidence).toBe('number');
      expect(candidate.riskLevel).toMatch(/^(low|medium|high)$/);
    }

    console.log(`✅ Schema validation passed: ${result.output?.candidates?.length} candidates`);
  }, 120_000);

  it('should correctly transition task state through the pipeline', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !runner) {
      expect(true).toBe(true);
      return;
    }

    const taskId = `dreamer-state-${Date.now()}`;
    await stateManager.createTask({
      taskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const pendingTask = await stateManager.getTask(taskId);
    expect(pendingTask?.status).toBe('pending');

    await runner.run(taskId);

    const succeededTask = await stateManager.getTask(taskId);
    expect(succeededTask?.status).toBe('succeeded');
    expect(succeededTask?.resultRef).toContain('dreamer://');
    expect(succeededTask?.attemptCount).toBe(1);

    console.log(`✅ State transition: pending → leased → succeeded`);
  }, 120_000);
});

describe('DreamerRunner Real LLM E2E — Skip without API Key', () => {
  it('should skip when MINIMAX_CN_API_KEY is not set', () => {
    const originalApiKey = process.env.MINIMAX_CN_API_KEY;
    delete process.env.MINIMAX_CN_API_KEY;

    const config = getMiniMaxConfig();
    expect(config).toBeNull();

    if (originalApiKey) {
      process.env.MINIMAX_CN_API_KEY = originalApiKey;
    }
  });
});
