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
import { getLlmE2eConfig, runWithRetry } from './fixtures/index.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-scribe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

const config = getLlmE2eConfig();

describe.skipIf(!config)('ScribeRunner Real LLM E2E', () => {
  const cfg = config;
  if (!cfg) return;
  const adapterConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKeyEnv: cfg.apiKeyEnv,
    maxRetries: cfg.maxRetries,
    timeoutMs: cfg.timeoutMs,
    baseUrl: cfg.baseUrl,
    reasoning: cfg.reasoning,
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
    try {
      stateManager.close();
    } catch (err) {
      console.warn(`[afterEach] stateManager.close() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[afterEach] Failed to clean test dir ${testDir}: ${err instanceof Error ? err.message : String(err)}`);
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
        timeoutMs: adapterConfig.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId);
    expect(dreamerResult.status).toBe('succeeded');

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
        timeoutMs: adapterConfig.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId);
    expect(philosopherResult.status).toBe('succeeded');

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
        timeoutMs: adapterConfig.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const scribeResult = await runWithRetry(scribeRunner, scribeTaskId);

    expect(scribeResult.status).toBe('succeeded');
    expect(scribeResult.taskId).toBe(scribeTaskId);
    expect(scribeResult.artifactId).toBeDefined();
    expect(scribeResult.resultRef).toContain('scribe://');
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
        timeoutMs: adapterConfig.timeoutMs,
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
  }, 360_000);
});
