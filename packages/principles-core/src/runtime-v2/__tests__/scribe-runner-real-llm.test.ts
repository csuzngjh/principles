import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import { DefaultDreamerValidator } from '../internalization/dreamer-output.js';
import { PhilosopherRunner } from '../internalization/philosopher-runner.js';
import { DefaultPhilosopherValidator } from '../internalization/philosopher-output.js';
import { ScribeRunner } from '../internalization/scribe-runner.js';
import { DefaultScribeValidator } from '../internalization/scribe-output.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import { PiAiRuntimeAdapter } from '../adapter/pi-ai-runtime-adapter.js';
import { StoreEventEmitter } from '../store/event-emitter.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import { getMiniMaxConfig } from './fixtures/llm-e2e-config.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-scribe-${process.pid}`);

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

describe('ScribeRunner Real LLM E2E (MiniMax)', () => {
  let testDir = '';
  let stateManager: RuntimeStateManager | null = null;
  let _artifactStore: PIArtifactStore | null = null;
  let _eventEmitter: StoreEventEmitter | null = null;
  let _runtimeAdapter: PiAiRuntimeAdapter | null = null;
  let dreamerRunner: DreamerRunner | null = null;
  let philosopherRunner: PhilosopherRunner | null = null;
  let scribeRunner: ScribeRunner | null = null;

  beforeEach(async () => {
    const adapterConfig = makeAdapterConfig();
    if (!adapterConfig) {
      return;
    }

    testDir = path.join(TMP_ROOT, `scribe-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const sm = new RuntimeStateManager({ workspaceDir: testDir });
    await sm.initialize();
    stateManager = sm;

    const as = new MemoryPIArtifactStore();
    _artifactStore = as;

    const ee = new StoreEventEmitter();
    _eventEmitter = ee;

    const ra = new PiAiRuntimeAdapter(adapterConfig);
    _runtimeAdapter = ra;

    dreamerRunner = new DreamerRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultDreamerValidator(), artifactStore: as },
      { owner: 'e2e-scribe-minimax', runtimeKind: 'pi-ai', pollIntervalMs: 100, timeoutMs: adapterConfig.timeoutMs },
    );

    philosopherRunner = new PhilosopherRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultPhilosopherValidator(), artifactStore: as },
      { owner: 'e2e-scribe-minimax', runtimeKind: 'pi-ai', pollIntervalMs: 100, timeoutMs: adapterConfig.timeoutMs },
    );

    scribeRunner = new ScribeRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultScribeValidator(), artifactStore: as },
      { owner: 'e2e-scribe-minimax', runtimeKind: 'pi-ai', pollIntervalMs: 100, timeoutMs: adapterConfig.timeoutMs },
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

  async function runDreamerPhilosopherChain(config: { timeoutMs: number }) {
    if (!stateManager || !dreamerRunner || !philosopherRunner) {
      throw new Error('Missing dependencies');
    }

    const dreamerTaskId = `dreamer-for-scribe-${Date.now()}`;
    await stateManager.createTask({
      taskId: dreamerTaskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 5,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    let dreamerResult = await dreamerRunner.run(dreamerTaskId);
    for (let retry = 0; retry < 3 && dreamerResult.status === 'retried'; retry++) {
      await new Promise(r => setTimeout(r, 3000));
      dreamerResult = await dreamerRunner.run(dreamerTaskId);
    }
    expect(dreamerResult.status).toBe('succeeded');
    console.log(`Dreamer succeeded: artifact=${dreamerResult.artifactId}`);

    const philosopherTaskId = `philosopher-for-scribe-${Date.now()}`;
    await stateManager.createTask({
      taskId: philosopherTaskId,
      taskKind: 'philosopher',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 5,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [dreamerTaskId],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    let philosopherResult = await philosopherRunner.run(philosopherTaskId);
    for (let retry = 0; retry < 3 && philosopherResult.status === 'retried'; retry++) {
      await new Promise(r => setTimeout(r, 3000));
      philosopherResult = await philosopherRunner.run(philosopherTaskId);
    }
    expect(philosopherResult.status).toBe('succeeded');
    console.log(`Philosopher succeeded: artifact=${philosopherResult.artifactId}`);

    return { dreamerTaskId, philosopherTaskId };
  }

  it('should succeed with valid ScribeOutput from real MiniMax LLM after Dreamer→Philosopher', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !scribeRunner) {
      expect(true).toBe(true);
      return;
    }

    const { philosopherTaskId } = await runDreamerPhilosopherChain(config);

    const scribeTaskId = `scribe-e2e-${Date.now()}`;
    await stateManager.createTask({
      taskId: scribeTaskId,
      taskKind: 'scribe',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 5,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [philosopherTaskId],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    let scribeResult = await scribeRunner.run(scribeTaskId);
    for (let retry = 0; retry < 3 && scribeResult.status === 'retried'; retry++) {
      await new Promise(r => setTimeout(r, 3000));
      scribeResult = await scribeRunner.run(scribeTaskId);
    }

    console.log('ScribeRunner result:', JSON.stringify({
      status: scribeResult.status,
      taskId: scribeResult.taskId,
      errorCategory: scribeResult.errorCategory,
      failureReason: scribeResult.failureReason,
      attemptCount: scribeResult.attemptCount,
    }, null, 2));

    expect(scribeResult.status).toBe('succeeded');
    expect(scribeResult.taskId).toBe(scribeTaskId);
    expect(scribeResult.artifactId).toBeDefined();
    expect(scribeResult.resultRef).toContain('scribe://');

    console.log(`✅ ScribeRunner succeeded with artifact: ${scribeResult.artifactId}`);
  }, 360_000);

  it('should validate ScribeOutputV1 schema with real LLM output', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !scribeRunner) {
      expect(true).toBe(true);
      return;
    }

    const { philosopherTaskId } = await runDreamerPhilosopherChain(config);

    const scribeTaskId = `scribe-schema-${Date.now()}`;
    await stateManager.createTask({
      taskId: scribeTaskId,
      taskKind: 'scribe',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 5,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [philosopherTaskId],
        channel: 'prompt',
        timeoutMs: config.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    let scribeResult = await scribeRunner.run(scribeTaskId);
    for (let retry = 0; retry < 3 && scribeResult.status === 'retried'; retry++) {
      await new Promise(r => setTimeout(r, 3000));
      scribeResult = await scribeRunner.run(scribeTaskId);
    }

    expect(scribeResult.status).toBe('succeeded');
    expect(scribeResult.output).toBeDefined();
    expect(scribeResult.output?.principleDraft).toBeDefined();
    expect(scribeResult.output?.principleDraft?.title).toBeDefined();
    expect(scribeResult.output?.principleDraft?.statement).toBeDefined();
    expect(scribeResult.output?.principleDraft?.rationale).toBeDefined();
    expect(Array.isArray(scribeResult.output?.principleDraft?.applicability)).toBe(true);
    expect(Array.isArray(scribeResult.output?.principleDraft?.antiPatterns)).toBe(true);
    expect(typeof scribeResult.output?.principleDraft?.confidence).toBe('number');
    expect(scribeResult.output?.sourceTrace?.philosopherArtifactId).toBeDefined();

    console.log(`✅ Scribe schema validation passed: title="${String(scribeResult.output?.principleDraft?.title).slice(0, 50)}"`);
  }, 360_000);
});

describe('ScribeRunner Real LLM E2E — Skip without API Key', () => {
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
