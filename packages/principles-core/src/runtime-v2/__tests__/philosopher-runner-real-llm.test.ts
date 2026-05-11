import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import { DefaultDreamerValidator } from '../internalization/dreamer-output.js';
import { PhilosopherRunner } from '../internalization/philosopher-runner.js';
import { DefaultPhilosopherValidator } from '../internalization/philosopher-output.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import { PiAiRuntimeAdapter } from '../adapter/pi-ai-runtime-adapter.js';
import { StoreEventEmitter } from '../store/event-emitter.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import { getMiniMaxConfig } from './fixtures/llm-e2e-config.js';
import type { MiniMaxTestConfig } from './fixtures/llm-e2e-config.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-philosopher-${process.pid}`);
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

describe.skipIf(!hasApiKey)('PhilosopherRunner Real LLM E2E (MiniMax)', () => {
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
  let dreamerRunner = null as unknown as DreamerRunner;
  let philosopherRunner = null as unknown as PhilosopherRunner;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `philosopher-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const sm = new RuntimeStateManager({ workspaceDir: testDir });
    await sm.initialize();
    stateManager = sm;

    const as = new MemoryPIArtifactStore();
    _artifactStore = as;

    const ee = new StoreEventEmitter();
    const ra = new PiAiRuntimeAdapter(adapterConfig);

    dreamerRunner = new DreamerRunner(
      {
        stateManager: sm,
        runtimeAdapter: ra,
        eventEmitter: ee,
        validator: new DefaultDreamerValidator(),
        artifactStore: as,
      },
      {
        owner: 'e2e-philosopher-minimax',
        runtimeKind: 'pi-ai',
        pollIntervalMs: 100,
        timeoutMs: adapterConfig.timeoutMs,
      },
    );

    philosopherRunner = new PhilosopherRunner(
      {
        stateManager: sm,
        runtimeAdapter: ra,
        eventEmitter: ee,
        validator: new DefaultPhilosopherValidator(),
        artifactStore: as,
      },
      {
        owner: 'e2e-philosopher-minimax',
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

  it('should succeed with valid PhilosopherOutput from real MiniMax LLM after Dreamer', async () => {
    const dreamerTaskId = `dreamer-for-philosopher-${Date.now()}`;
    await stateManager.createTask({
      taskId: dreamerTaskId,
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

    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId);
    expect(dreamerResult.status).toBe('succeeded');
    console.log(`Dreamer succeeded: artifact=${dreamerResult.artifactId}`);

    const philosopherTaskId = `philosopher-e2e-${Date.now()}`;
    await stateManager.createTask({
      taskId: philosopherTaskId,
      taskKind: 'philosopher',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [dreamerTaskId],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId);

    console.log('PhilosopherRunner result:', JSON.stringify({
      status: philosopherResult.status,
      taskId: philosopherResult.taskId,
      errorCategory: philosopherResult.errorCategory,
      failureReason: philosopherResult.failureReason,
      attemptCount: philosopherResult.attemptCount,
    }, null, 2));

    expect(philosopherResult.status).toBe('succeeded');
    expect(philosopherResult.taskId).toBe(philosopherTaskId);
    expect(philosopherResult.artifactId).toBeDefined();
    expect(philosopherResult.resultRef).toContain('philosopher://');

    console.log(`✅ PhilosopherRunner succeeded with artifact: ${philosopherResult.artifactId}`);
  }, 240_000);

  it('should validate PhilosopherOutputV1 schema with real LLM output', async () => {
    const dreamerTaskId = `dreamer-for-schema-${Date.now()}`;
    await stateManager.createTask({
      taskId: dreamerTaskId,
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

    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId);
    expect(dreamerResult.status).toBe('succeeded');

    const philosopherTaskId = `philosopher-schema-${Date.now()}`;
    await stateManager.createTask({
      taskId: philosopherTaskId,
      taskKind: 'philosopher',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [dreamerTaskId],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId);

    expect(philosopherResult.status).toBe('succeeded');
    expect(philosopherResult.output).toBeDefined();
    expect(philosopherResult.output?.thesis).toBeDefined();
    expect(philosopherResult.output?.principleCandidate).toBeDefined();
    expect(philosopherResult.output?.principleCandidate?.title).toBeDefined();
    expect(philosopherResult.output?.principleCandidate?.rationale).toBeDefined();
    expect(typeof philosopherResult.output?.principleCandidate?.confidence).toBe('number');
    expect(Array.isArray(philosopherResult.output?.risks)).toBe(true);

    console.log(`✅ Philosopher schema validation passed: thesis="${String(philosopherResult.output?.thesis).slice(0, 50)}..."`);
  }, 240_000);
});
