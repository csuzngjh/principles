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
import type { MiniMaxTestConfig } from './fixtures/llm-e2e-config.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-scribe-${process.pid}`);
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

describe.skipIf(!hasApiKey)('ScribeRunner Real LLM E2E (MiniMax)', () => {
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
  let scribeRunner = null as unknown as ScribeRunner;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `scribe-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const sm = new RuntimeStateManager({ workspaceDir: testDir });
    await sm.initialize();
    stateManager = sm;

    const as = new MemoryPIArtifactStore();
    _artifactStore = as;

    const ee = new StoreEventEmitter();
    const ra = new PiAiRuntimeAdapter(adapterConfig);

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
    stateManager.close();
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function runDreamerPhilosopherChain() {
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

    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId);
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

    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId);
    expect(philosopherResult.status).toBe('succeeded');
    console.log(`Philosopher succeeded: artifact=${philosopherResult.artifactId}`);

    return { dreamerTaskId, philosopherTaskId };
  }

  it('should succeed with valid ScribeOutput from real MiniMax LLM after Dreamer→Philosopher', async () => {
    const { philosopherTaskId } = await runDreamerPhilosopherChain();

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

    const scribeResult = await runWithRetry(scribeRunner, scribeTaskId);

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
    const { philosopherTaskId } = await runDreamerPhilosopherChain();

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

    const scribeResult = await runWithRetry(scribeRunner, scribeTaskId);

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
