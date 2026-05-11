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

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-philosopher-${process.pid}`);

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

describe('PhilosopherRunner Real LLM E2E (MiniMax)', () => {
  let testDir = '';
  let stateManager: RuntimeStateManager | null = null;
  let artifactStore: PIArtifactStore | null = null;
  let _eventEmitter: StoreEventEmitter | null = null;
  let _runtimeAdapter: PiAiRuntimeAdapter | null = null;
  let dreamerRunner: DreamerRunner | null = null;
  let philosopherRunner: PhilosopherRunner | null = null;

  beforeEach(async () => {
    const adapterConfig = makeAdapterConfig();
    if (!adapterConfig) {
      return;
    }

    testDir = path.join(TMP_ROOT, `philosopher-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
    if (stateManager) {
      stateManager.close();
    }
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should succeed with valid PhilosopherOutput from real MiniMax LLM after Dreamer', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !artifactStore || !dreamerRunner || !philosopherRunner) {
      expect(true).toBe(true);
      return;
    }

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

    let dreamerResult = await dreamerRunner.run(dreamerTaskId);
    if (dreamerResult.status === 'retried') {
      const retriedTask = await stateManager.getTask(dreamerTaskId);
      console.log(`Dreamer retried (attempt ${retriedTask?.attemptCount}), waiting and retrying...`);
      await new Promise(r => setTimeout(r, 2000));
      dreamerResult = await dreamerRunner.run(dreamerTaskId);
    }
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

    let philosopherResult = await philosopherRunner.run(philosopherTaskId);
    if (philosopherResult.status === 'retried') {
      await new Promise(r => setTimeout(r, 2000));
      philosopherResult = await philosopherRunner.run(philosopherTaskId);
    }

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
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !artifactStore || !dreamerRunner || !philosopherRunner) {
      expect(true).toBe(true);
      return;
    }

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

    let dreamerResult = await dreamerRunner.run(dreamerTaskId);
    if (dreamerResult.status === 'retried') {
      await new Promise(r => setTimeout(r, 2000));
      dreamerResult = await dreamerRunner.run(dreamerTaskId);
    }
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

    let philosopherResult = await philosopherRunner.run(philosopherTaskId);
    if (philosopherResult.status === 'retried') {
      await new Promise(r => setTimeout(r, 2000));
      philosopherResult = await philosopherRunner.run(philosopherTaskId);
    }

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

describe('PhilosopherRunner Real LLM E2E — Skip without API Key', () => {
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
