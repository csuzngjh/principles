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
import type { MiniMaxTestConfig } from './fixtures/llm-e2e-config.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-dreamer-${process.pid}`);
const hasApiKey = !!process.env.MINIMAX_CN_API_KEY;

async function runWithRetry<T extends { status: string }>(
  runner: { run(id: string): Promise<T> },
  taskId: string,
  maxRetries = 3,
): Promise<T> {
  let result = await runner.run(taskId);
  for (let retry = 0; retry < maxRetries && result.status === 'retried'; retry++) {
    await new Promise(r => setTimeout(r, 3000));
    result = await runner.run(taskId);
  }
  return result;
}

describe.skipIf(!hasApiKey)('DreamerRunner Real LLM E2E (MiniMax)', () => {
  const config = getMiniMaxConfig() as MiniMaxTestConfig;
  const adapterConfig = {
    provider: config.provider,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
  };

  let testDir = '';
  let stateManager = null as unknown as RuntimeStateManager;
  let _artifactStore = null as unknown as PIArtifactStore;
  let runner = null as unknown as DreamerRunner;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `dreamer-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const sm = new RuntimeStateManager({ workspaceDir: testDir });
    await sm.initialize();
    stateManager = sm;

    const as = new MemoryPIArtifactStore();
    _artifactStore = as;

    const ee = new StoreEventEmitter();
    const ra = new PiAiRuntimeAdapter(adapterConfig);

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
    stateManager.close();
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should succeed with valid DreamerOutput from real MiniMax LLM', async () => {
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

    const result = await runWithRetry(runner, taskId);

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

    const artifacts = await _artifactStore.listBySourceTaskId(taskId);
    expect(artifacts.length).toBeGreaterThan(0);
    const [firstArtifact] = artifacts;
    expect(firstArtifact?.artifactKind).toBe('principle');

    const updatedTask = await stateManager.getTask(taskId);
    expect(updatedTask?.status).toBe('succeeded');

    console.log(`✅ DreamerRunner succeeded with artifact: ${result.artifactId}`);
  }, 120_000);

  it('should handle real LLM output and validate DreamerOutputV1 schema', async () => {
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

    const result = await runWithRetry(runner, taskId);

    expect(result.status).toBe('succeeded');
    expect(result.output).toBeDefined();
    expect(result.output?.valid).toBe(true);
    expect(result.output?.candidates).toBeDefined();
    expect(Array.isArray(result.output?.candidates)).toBe(true);

    if (result.output?.candidates && result.output.candidates.length > 0) {
      const [candidate] = result.output.candidates;
      if (candidate) {
        expect(candidate.badDecision).toBeDefined();
        expect(candidate.betterDecision).toBeDefined();
        expect(candidate.rationale).toBeDefined();
        expect(typeof candidate.confidence).toBe('number');
        expect(candidate.riskLevel).toMatch(/^(low|medium|high)$/);
      }
    }

    console.log(`✅ Schema validation passed: ${result.output?.candidates?.length} candidates`);
  }, 120_000);

  it('should correctly transition task state through the pipeline', async () => {
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

    await runWithRetry(runner, taskId);

    const succeededTask = await stateManager.getTask(taskId);
    expect(succeededTask?.status).toBe('succeeded');
    expect(succeededTask?.resultRef).toContain('dreamer://');
    expect(succeededTask?.attemptCount).toBe(1);

    console.log(`✅ State transition: pending → leased → succeeded`);
  }, 120_000);
});
