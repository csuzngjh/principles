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
import { ArtificerRunner } from '../internalization/artificer-runner.js';
import { DefaultArtificerValidator } from '../internalization/artificer-output.js';
import { EvaluatorRunner } from '../internalization/evaluator-runner.js';
import { DefaultEvaluatorValidator } from '../internalization/evaluator-output.js';
import { RolloutReviewerRunner } from '../internalization/rollout-reviewer-runner.js';
import { DefaultRolloutReviewerValidator } from '../internalization/rollout-reviewer-output.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import { PiAiRuntimeAdapter } from '../adapter/pi-ai-runtime-adapter.js';
import { StoreEventEmitter } from '../store/event-emitter.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import { getMiniMaxConfig } from './fixtures/llm-e2e-config.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-full-chain-${process.pid}`);

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

async function runWithRetry<T extends { status: string }>(
  runner: { run(id: string): Promise<T> },
  taskId: string,
  maxRetries = 5,
): Promise<T> {
  let result = await runner.run(taskId);
  for (let retry = 0; retry < maxRetries && result.status === 'retried'; retry++) {
    await new Promise(r => setTimeout(r, 5000));
    result = await runner.run(taskId);
  }
  return result;
}

describe('Full Internalization Chain Real LLM E2E (MiniMax)', () => {
  let testDir = '';
  let stateManager: RuntimeStateManager | null = null;
  let _artifactStore: PIArtifactStore | null = null;
  let _eventEmitter: StoreEventEmitter | null = null;
  let _runtimeAdapter: PiAiRuntimeAdapter | null = null;
  let dreamerRunner: DreamerRunner | null = null;
  let philosopherRunner: PhilosopherRunner | null = null;
  let scribeRunner: ScribeRunner | null = null;
  let artificerRunner: ArtificerRunner | null = null;
  let evaluatorRunner: EvaluatorRunner | null = null;
  let rolloutReviewerRunner: RolloutReviewerRunner | null = null;

  beforeEach(async () => {
    const adapterConfig = makeAdapterConfig();
    if (!adapterConfig) {
      return;
    }

    testDir = path.join(TMP_ROOT, `chain-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

    const owner = 'e2e-chain-minimax';
    const opts = { owner, runtimeKind: 'pi-ai' as const, pollIntervalMs: 100, timeoutMs: adapterConfig.timeoutMs };

    dreamerRunner = new DreamerRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultDreamerValidator(), artifactStore: as }, opts,
    );
    philosopherRunner = new PhilosopherRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultPhilosopherValidator(), artifactStore: as }, opts,
    );
    scribeRunner = new ScribeRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultScribeValidator(), artifactStore: as }, opts,
    );
    artificerRunner = new ArtificerRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultArtificerValidator(), artifactStore: as }, opts,
    );
    evaluatorRunner = new EvaluatorRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultEvaluatorValidator(), artifactStore: as }, opts,
    );
    rolloutReviewerRunner = new RolloutReviewerRunner(
      { stateManager: sm, runtimeAdapter: ra, eventEmitter: ee, validator: new DefaultRolloutReviewerValidator(), artifactStore: as }, opts,
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

  async function createTask(taskKind: string, depTaskIds: string[], timeoutMs: number) {
    if (!stateManager) throw new Error('No stateManager');
    const taskId = `${taskKind}-e2e-${Date.now()}`;
    await stateManager.createTask({
      taskId,
      taskKind,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 5,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: depTaskIds,
        channel: 'prompt',
        timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    return taskId;
  }

  it('should complete full Dreamer→Philosopher→Scribe→Artificer→Evaluator→RolloutReviewer chain', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !dreamerRunner || !philosopherRunner || !scribeRunner || !artificerRunner || !evaluatorRunner || !rolloutReviewerRunner) {
      expect(true).toBe(true);
      return;
    }

    const {timeoutMs} = config;

    const dreamerTaskId = await createTask('dreamer', [], timeoutMs);
    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId);
    if (dreamerResult.status !== 'succeeded') {
      console.error('Dreamer failed:', JSON.stringify(dreamerResult, null, 2));
    }
    expect(dreamerResult.status).toBe('succeeded');
    console.log(`✅ Step 1/6 Dreamer: ${dreamerResult.artifactId}`);

    const philosopherTaskId = await createTask('philosopher', [dreamerTaskId], timeoutMs);
    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId);
    expect(philosopherResult.status).toBe('succeeded');
    console.log(`✅ Step 2/6 Philosopher: ${philosopherResult.artifactId}`);

    const scribeTaskId = await createTask('scribe', [philosopherTaskId], timeoutMs);
    const scribeResult = await runWithRetry(scribeRunner, scribeTaskId);
    expect(scribeResult.status).toBe('succeeded');
    console.log(`✅ Step 3/6 Scribe: ${scribeResult.artifactId}`);

    const artificerTaskId = await createTask('artificer', [scribeTaskId], timeoutMs);
    const artificerResult = await runWithRetry(artificerRunner, artificerTaskId);
    expect(artificerResult.status).toBe('succeeded');
    console.log(`✅ Step 4/6 Artificer: ${artificerResult.artifactId}`);

    const evaluatorTaskId = await createTask('evaluator', [artificerTaskId], timeoutMs);
    const evaluatorResult = await runWithRetry(evaluatorRunner, evaluatorTaskId);
    if (evaluatorResult.status !== 'succeeded') {
      console.error('Evaluator failed:', JSON.stringify(evaluatorResult, null, 2));
    }
    expect(evaluatorResult.status).toBe('succeeded');
    console.log(`✅ Step 5/6 Evaluator: ${evaluatorResult.artifactId}`);

    const rolloutTaskId = await createTask('rollout_reviewer', [evaluatorTaskId], timeoutMs);
    const rolloutResult = await runWithRetry(rolloutReviewerRunner, rolloutTaskId);
    if (rolloutResult.status !== 'succeeded') {
      console.error('RolloutReviewer failed:', JSON.stringify(rolloutResult, null, 2));
    }
    expect(rolloutResult.status).toBe('succeeded');
    console.log(`✅ Step 6/6 RolloutReviewer: ${rolloutResult.artifactId}`);

    console.log('🎉 Full internalization chain completed successfully!');
  }, 720_000);

  it('should validate output schemas at each chain step', async () => {
    const config = getMiniMaxConfig();
    if (!config || !stateManager || !dreamerRunner || !philosopherRunner || !scribeRunner || !artificerRunner || !evaluatorRunner || !rolloutReviewerRunner) {
      expect(true).toBe(true);
      return;
    }

    const {timeoutMs} = config;

    const dreamerTaskId = await createTask('dreamer', [], timeoutMs);
    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId);
    expect(dreamerResult.status).toBe('succeeded');
    expect(dreamerResult.output?.valid).toBe(true);
    expect(Array.isArray(dreamerResult.output?.candidates)).toBe(true);

    const philosopherTaskId = await createTask('philosopher', [dreamerTaskId], timeoutMs);
    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId);
    expect(philosopherResult.status).toBe('succeeded');
    expect(philosopherResult.output?.thesis).toBeDefined();
    expect(philosopherResult.output?.principleCandidate?.title).toBeDefined();

    const scribeTaskId = await createTask('scribe', [philosopherTaskId], timeoutMs);
    const scribeResult = await runWithRetry(scribeRunner, scribeTaskId);
    expect(scribeResult.status).toBe('succeeded');
    expect(scribeResult.output?.principleDraft?.title).toBeDefined();
    expect(scribeResult.output?.principleDraft?.statement).toBeDefined();

    const artificerTaskId = await createTask('artificer', [scribeTaskId], timeoutMs);
    const artificerResult = await runWithRetry(artificerRunner, artificerTaskId);
    expect(artificerResult.status).toBe('succeeded');
    expect(artificerResult.output?.implementationPlan?.summary).toBeDefined();
    expect(artificerResult.output?.implementationPlan?.targetSurface).toBeDefined();

    const evaluatorTaskId = await createTask('evaluator', [artificerTaskId], timeoutMs);
    const evaluatorResult = await runWithRetry(evaluatorRunner, evaluatorTaskId);
    if (evaluatorResult.status !== 'succeeded') {
      console.error('Evaluator (schema test) failed:', JSON.stringify(evaluatorResult, null, 2));
    }
    expect(evaluatorResult.status).toBe('succeeded');
    expect(evaluatorResult.output?.evaluation?.decision).toMatch(/^(approved|needs_revision|rejected)$/);
    expect(typeof evaluatorResult.output?.evaluation?.score).toBe('number');

    const rolloutTaskId = await createTask('rollout_reviewer', [evaluatorTaskId], timeoutMs);
    const rolloutResult = await runWithRetry(rolloutReviewerRunner, rolloutTaskId);
    if (rolloutResult.status !== 'succeeded') {
      console.error('RolloutReviewer (schema test) failed:', JSON.stringify(rolloutResult, null, 2));
    }
    expect(rolloutResult.status).toBe('succeeded');
    expect(rolloutResult.output?.review?.decision).toMatch(/^(approve_rollout|needs_revision|reject)$/);
    expect(typeof rolloutResult.output?.review?.confidence).toBe('number');

    console.log('🎉 All output schemas validated across 6-step chain!');
  }, 720_000);
});

describe('Full Chain E2E — Skip without API Key', () => {
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
