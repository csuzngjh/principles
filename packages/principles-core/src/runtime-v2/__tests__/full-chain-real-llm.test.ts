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
import { getLlmE2eConfig, runWithRetry } from './fixtures/index.js';

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-full-chain-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

const config = getLlmE2eConfig();

describe.skipIf(!config)('Full Internalization Chain Real LLM E2E', () => {
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
  let artificerRunner = null as unknown as ArtificerRunner;
  let evaluatorRunner = null as unknown as EvaluatorRunner;
  let rolloutReviewerRunner = null as unknown as RolloutReviewerRunner;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `chain-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const sm = new RuntimeStateManager({ workspaceDir: testDir });
    await sm.initialize();
    stateManager = sm;

    const as = new MemoryPIArtifactStore();
    _artifactStore = as;

    const ee = new StoreEventEmitter();
    const ra = new PiAiRuntimeAdapter(adapterConfig);

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

  const retryOpts = { maxRetries: 5, delayMs: 5000 };

  async function createTask(taskKind: string, depTaskIds: string[]) {
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
        timeoutMs: adapterConfig.timeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    return taskId;
  }

  it('should complete full Dreamer→Philosopher→Scribe→Artificer→Evaluator→RolloutReviewer chain', async () => {
    const dreamerTaskId = await createTask('dreamer', []);
    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId, retryOpts);
    expect(dreamerResult.status).toBe('succeeded');

    const philosopherTaskId = await createTask('philosopher', [dreamerTaskId]);
    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId, retryOpts);
    expect(philosopherResult.status).toBe('succeeded');

    const scribeTaskId = await createTask('scribe', [philosopherTaskId]);
    const scribeResult = await runWithRetry(scribeRunner, scribeTaskId, retryOpts);
    expect(scribeResult.status).toBe('succeeded');

    const artificerTaskId = await createTask('artificer', [scribeTaskId]);
    const artificerResult = await runWithRetry(artificerRunner, artificerTaskId, retryOpts);
    expect(artificerResult.status).toBe('succeeded');

    const evaluatorTaskId = await createTask('evaluator', [artificerTaskId]);
    const evaluatorResult = await runWithRetry(evaluatorRunner, evaluatorTaskId, retryOpts);
    expect(evaluatorResult.status).toBe('succeeded');

    const rolloutTaskId = await createTask('rollout_reviewer', [evaluatorTaskId]);
    const rolloutResult = await runWithRetry(rolloutReviewerRunner, rolloutTaskId, retryOpts);
    expect(rolloutResult.status).toBe('succeeded');
  }, 720_000);

  it('should validate output schemas at each chain step', async () => {
    const dreamerTaskId = await createTask('dreamer', []);
    const dreamerResult = await runWithRetry(dreamerRunner, dreamerTaskId, retryOpts);
    expect(dreamerResult.status).toBe('succeeded');
    expect(dreamerResult.output?.valid).toBe(true);
    expect(Array.isArray(dreamerResult.output?.candidates)).toBe(true);

    const philosopherTaskId = await createTask('philosopher', [dreamerTaskId]);
    const philosopherResult = await runWithRetry(philosopherRunner, philosopherTaskId, retryOpts);
    expect(philosopherResult.status).toBe('succeeded');
    expect(philosopherResult.output?.thesis).toBeDefined();
    expect(philosopherResult.output?.principleCandidate?.title).toBeDefined();

    const scribeTaskId = await createTask('scribe', [philosopherTaskId]);
    const scribeResult = await runWithRetry(scribeRunner, scribeTaskId, retryOpts);
    expect(scribeResult.status).toBe('succeeded');
    expect(scribeResult.output?.principleDraft?.title).toBeDefined();
    expect(scribeResult.output?.principleDraft?.statement).toBeDefined();

    const artificerTaskId = await createTask('artificer', [scribeTaskId]);
    const artificerResult = await runWithRetry(artificerRunner, artificerTaskId, retryOpts);
    expect(artificerResult.status).toBe('succeeded');
    expect(artificerResult.output?.implementationPlan?.summary).toBeDefined();
    expect(artificerResult.output?.implementationPlan?.targetSurface).toBeDefined();

    const evaluatorTaskId = await createTask('evaluator', [artificerTaskId]);
    const evaluatorResult = await runWithRetry(evaluatorRunner, evaluatorTaskId, retryOpts);
    expect(evaluatorResult.status).toBe('succeeded');
    expect(evaluatorResult.output?.evaluation?.decision).toMatch(/^(approved|needs_revision|rejected)$/);
    expect(typeof evaluatorResult.output?.evaluation?.score).toBe('number');

    const rolloutTaskId = await createTask('rollout_reviewer', [evaluatorTaskId]);
    const rolloutResult = await runWithRetry(rolloutReviewerRunner, rolloutTaskId, retryOpts);
    expect(rolloutResult.status).toBe('succeeded');
    expect(rolloutResult.output?.review?.decision).toMatch(/^(approve_rollout|needs_revision|reject)$/);
    expect(typeof rolloutResult.output?.review?.confidence).toBe('number');
  }, 720_000);
});
