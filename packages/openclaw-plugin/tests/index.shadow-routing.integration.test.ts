import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import plugin from '../src/index.js';
import {
  registerTrainingRun,
  startTrainingRun,
  completeTrainingRun,
  registerCheckpoint,
  attachEvalSummary,
  markCheckpointDeployable,
} from '../src/core/model-training-registry.js';
import { advancePromotion, DEFAULT_BASELINE_METRICS } from '../src/core/promotion-gate.js';
import { bindCheckpointToWorkerProfile, enableRoutingForProfile } from '../src/core/model-deployment-registry.js';
import { computeShadowStats } from '../src/core/shadow-observation-registry.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-hook-test-'));
}

function rmdir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup errors
  }
}

function setupShadowReadyReaderCheckpoint(stateDir: string): string {
  const run = registerTrainingRun(stateDir, {
    targetModelFamily: 'qwen2.5-7b-reader',
    datasetFingerprint: 'fp-dataset',
    exportId: 'export-1',
    sampleCount: 10,
    configFingerprint: 'fp-config',
  });
  startTrainingRun(stateDir, run.trainRunId);
  completeTrainingRun(stateDir, run.trainRunId);

  const checkpoint = registerCheckpoint(stateDir, {
    trainRunId: run.trainRunId,
    targetModelFamily: 'qwen2.5-7b-reader',
    artifactPath: path.join(stateDir, 'checkpoints', 'ckpt-reader'),
  });

  attachEvalSummary(stateDir, checkpoint.checkpointId, {
    evalId: 'eval-1',
    checkpointId: checkpoint.checkpointId,
    benchmarkId: 'bench-1',
    targetModelFamily: 'qwen2.5-7b-reader',
    mode: 'reduced_prompt',
    baselineScore: 0.5,
    candidateScore: 0.7,
    delta: 0.2,
    verdict: 'pass',
  });
  markCheckpointDeployable(stateDir, checkpoint.checkpointId, true);
  advancePromotion(stateDir, {
    checkpointId: checkpoint.checkpointId,
    targetProfile: 'local-reader',
    baselineMetrics: DEFAULT_BASELINE_METRICS,
    orchestratorReviewPassed: true,
    reviewNote: 'shadow ready for test',
  });
  bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpoint.checkpointId);
  enableRoutingForProfile(stateDir, 'local-reader');
  return checkpoint.checkpointId;
}

describe('plugin shadow routing integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('records and completes shadow observations from runtime subagent hooks', async () => {
    const checkpointId = setupShadowReadyReaderCheckpoint(tmpDir);
    const hooks = new Map<string, Function>();

    const api: any = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      pluginConfig: { language: 'en' },
      rootDir: tmpDir,
      resolvePath: (p: string) => (p === '.' ? tmpDir : path.join(tmpDir, p)),
      registerHttpRoute() {},
      on(name: string, handler: Function) {
        hooks.set(name, handler);
      },
      registerService() {},
      registerCommand() {},
      registerTool() {},
    };

    plugin.register(api);

    const spawning = hooks.get('subagent_spawning');
    const ended = hooks.get('subagent_ended');
    expect(spawning).toBeTypeOf('function');
    expect(ended).toBeTypeOf('function');

    for (let i = 0; i < 5; i++) {
      const sessionKey = `agent:local-reader:test-child-${i}`;
      spawning!(
        {
          childSessionKey: sessionKey,
          agentId: 'local-reader',
          mode: 'run',
          threadRequested: false,
          label: 'shadow-test',
        },
        { workspaceDir: tmpDir }
      );

      ended!(
        {
          targetSessionKey: sessionKey,
          targetKind: 'subagent',
          reason: 'completed',
          outcome: 'ok',
        },
        { workspaceDir: tmpDir }
      );
    }

    const stats = computeShadowStats(tmpDir, { checkpointId, windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(stats).not.toBeNull();
    expect(stats!.totalCount).toBe(5);
    expect(stats!.acceptedCount).toBe(5);
    expect(stats!.rejectRate).toBe(0);
    expect(stats!.isStatisticallySignificant).toBe(true);
  });
});
