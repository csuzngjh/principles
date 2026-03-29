/**
 * Model Deployment Registry — Tests
 * ==================================
 *
 * Tests for worker profile → checkpoint binding, routing enable/disable,
 * and rollback operations.
 *
 * Prerequisites: Many tests set up a training run + checkpoint in the
 * training registry before exercising deployment registry operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  bindCheckpointToWorkerProfile,
  getDeployment,
  listDeployments,
  enableRoutingForProfile,
  disableRoutingForProfile,
  rollbackDeployment,
  isRoutingEnabledForProfile,
  getActiveCheckpointForProfile,
  getDeploymentLineage,
  getFullDeploymentRegistry,
  getDeploymentRegistryStats,
  assertSupportedProfile,
  SUPPORTED_PROFILES,
  type WorkerProfile,
} from '../../src/core/model-deployment-registry.js';
import {
  registerTrainingRun,
  startTrainingRun,
  completeTrainingRun,
  registerCheckpoint,
  attachEvalSummary,
  markCheckpointDeployable,
} from '../../src/core/model-training-registry.js';
import {
  advancePromotion,
  DEFAULT_BASELINE_METRICS,
} from '../../src/core/promotion-gate.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-deployment-registry-test-'));
}

function rmdir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
}

/**
 * Create a fully deployable reader-family checkpoint.
 * Family keyword "reader" → satisfies local-reader profile constraint.
 */
function setupDeployableReaderCheckpoint(tmpDir: string): { runId: string; checkpointId: string } {
  const run = registerTrainingRun(tmpDir, {
    targetModelFamily: 'claude-reader-latest',
    datasetFingerprint: 'sha256-reader-001',
    exportId: 'export-reader',
    sampleCount: 30,
    configFingerprint: 'cfg-v1',
  });
  const ck = registerCheckpoint(tmpDir, {
    trainRunId: run.trainRunId,
    targetModelFamily: 'claude-reader-latest',
    artifactPath: '/checkpoints/reader-ck-001.safetensors',
  });
  attachEvalSummary(tmpDir, ck.checkpointId, {
    evalId: 'eval-reader-001',
    checkpointId: ck.checkpointId,
    targetModelFamily: 'claude-reader-latest',
    benchmarkId: 'bench-reader-001',
    mode: 'reduced_prompt',
    baselineScore: 0.5,
    candidateScore: 0.65,
    delta: 0.15,
    verdict: 'pass',
  });
  startTrainingRun(tmpDir, run.trainRunId);
  completeTrainingRun(tmpDir, run.trainRunId);
  markCheckpointDeployable(tmpDir, ck.checkpointId, true);
  // Advance through promotion gate (Phase 7: only local-reader is allowed)
  advancePromotion(tmpDir, {
    checkpointId: ck.checkpointId,
    targetProfile: 'local-reader',
    baselineMetrics: DEFAULT_BASELINE_METRICS,
    orchestratorReviewPassed: true,
    reviewNote: 'Test approval',
  });
  return { runId: run.trainRunId, checkpointId: ck.checkpointId };
}

/**
 * Create a fully deployable editor-family checkpoint.
 * Family keyword "editor" → satisfies local-editor profile constraint.
 */
function setupDeployableEditorCheckpoint(tmpDir: string): { runId: string; checkpointId: string } {
  const run = registerTrainingRun(tmpDir, {
    targetModelFamily: 'gpt-editor-v4',
    datasetFingerprint: 'sha256-editor-001',
    exportId: 'export-editor',
    sampleCount: 30,
    configFingerprint: 'cfg-v1',
  });
  const ck = registerCheckpoint(tmpDir, {
    trainRunId: run.trainRunId,
    targetModelFamily: 'gpt-editor-v4',
    artifactPath: '/checkpoints/editor-ck-001.safetensors',
  });
  attachEvalSummary(tmpDir, ck.checkpointId, {
    evalId: 'eval-editor-001',
    checkpointId: ck.checkpointId,
    targetModelFamily: 'gpt-editor-v4',
    benchmarkId: 'bench-editor-001',
    mode: 'reduced_prompt',
    baselineScore: 0.5,
    candidateScore: 0.7,
    delta: 0.2,
    verdict: 'pass',
  });
  startTrainingRun(tmpDir, run.trainRunId);
  completeTrainingRun(tmpDir, run.trainRunId);
  markCheckpointDeployable(tmpDir, ck.checkpointId, true);
  // Advance through promotion gate
  advancePromotion(tmpDir, {
    checkpointId: ck.checkpointId,
    targetProfile: 'local-editor',
    baselineMetrics: DEFAULT_BASELINE_METRICS,
    orchestratorReviewPassed: true,
    reviewNote: 'Test approval',
  });
  return { runId: run.trainRunId, checkpointId: ck.checkpointId };
}

/**
 * Create a non-deployable checkpoint (no eval attached).
 */
function setupNonDeployableCheckpoint(tmpDir: string): { runId: string; checkpointId: string } {
  const run = registerTrainingRun(tmpDir, {
    targetModelFamily: 'claude-reader-latest',
    datasetFingerprint: 'sha256-abc',
    exportId: 'export-abc',
    sampleCount: 10,
    configFingerprint: 'cfg-v1',
  });
  const ck = registerCheckpoint(tmpDir, {
    trainRunId: run.trainRunId,
    targetModelFamily: 'claude-reader-latest',
    artifactPath: '/checkpoints/nondeployable.safetensors',
  });
  return { runId: run.trainRunId, checkpointId: ck.checkpointId };
}

// ---------------------------------------------------------------------------
// Tests: assertSupportedProfile
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry assertSupportedProfile', () => {
  it('accepts local-reader', () => {
    expect(() => assertSupportedProfile('local-reader')).not.toThrow();
  });

  it('accepts local-editor', () => {
    expect(() => assertSupportedProfile('local-editor')).not.toThrow();
  });

  it('rejects unknown profile', () => {
    expect(() => assertSupportedProfile('local-architect')).toThrow('Unsupported worker profile');
  });

  it('rejects arbitrary strings', () => {
    expect(() => assertSupportedProfile('gpt-5')).toThrow('Unsupported worker profile');
  });
});

// ---------------------------------------------------------------------------
// Tests: bindCheckpointToWorkerProfile
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry bindCheckpointToWorkerProfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('binds a deployable reader checkpoint to local-reader', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);

    const deployment = bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    expect(deployment.workerProfile).toBe('local-reader');
    expect(deployment.activeCheckpointId).toBe(checkpointId);
    expect(deployment.previousCheckpointId).toBeNull();
    expect(deployment.routingEnabled).toBe(false);
    expect(deployment.targetModelFamily).toBe('claude-reader-latest');
    expect(deployment.deploymentId).toBeDefined();
    expect(deployment.deployedAt).toBeDefined();
    expect(deployment.updatedAt).toBeDefined();
  });

  it('binds a deployable editor checkpoint to local-editor', () => {
    const { checkpointId } = setupDeployableEditorCheckpoint(tmpDir);

    const deployment = bindCheckpointToWorkerProfile(tmpDir, 'local-editor', checkpointId);

    expect(deployment.workerProfile).toBe('local-editor');
    expect(deployment.activeCheckpointId).toBe(checkpointId);
    expect(deployment.routingEnabled).toBe(false);
    expect(deployment.targetModelFamily).toBe('gpt-editor-v4');
  });

  it('persists the deployment to disk', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);

    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    const retrieved = getDeployment(tmpDir, 'local-reader');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.activeCheckpointId).toBe(checkpointId);
  });

  it('rejects binding to a non-deployable checkpoint', () => {
    const { checkpointId } = setupNonDeployableCheckpoint(tmpDir);

    expect(() =>
      bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId)
    ).toThrow('not deployable');
  });

  it('rejects binding to a nonexistent checkpoint', () => {
    expect(() =>
      bindCheckpointToWorkerProfile(tmpDir, 'local-reader', 'nonexistent-ck-id')
    ).toThrow('not found');
  });

  it('rejects local-reader binding to an editor-family checkpoint', () => {
    const { checkpointId } = setupDeployableEditorCheckpoint(tmpDir); // gpt-editor-v4

    expect(() =>
      bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId)
    ).toThrow('Family constraint violated');
  });

  it('rejects local-editor binding to a reader-family checkpoint', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir); // claude-reader-latest

    expect(() =>
      bindCheckpointToWorkerProfile(tmpDir, 'local-editor', checkpointId)
    ).toThrow('Family constraint violated');
  });

  it('rejects unsupported profile', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);

    expect(() =>
      // @ts-expect-error — intentionally passing invalid profile
      bindCheckpointToWorkerProfile(tmpDir, 'local-architect', checkpointId)
    ).toThrow('Unsupported worker profile');
  });

  it('updating binding to a new checkpoint preserves previousCheckpointId', () => {
    const { checkpointId: ck1 } = setupDeployableReaderCheckpoint(tmpDir);

    // Set up a second reader checkpoint
    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'claude-reader-latest',
      datasetFingerprint: 'sha256-reader-002',
      exportId: 'export-reader-2',
      sampleCount: 30,
      configFingerprint: 'cfg-v1',
    });
    const ck2 = registerCheckpoint(tmpDir, {
      trainRunId: run2.trainRunId,
      targetModelFamily: 'claude-reader-latest',
      artifactPath: '/checkpoints/reader-ck-002.safetensors',
    });
    attachEvalSummary(tmpDir, ck2.checkpointId, {
      evalId: 'eval-reader-002',
      checkpointId: ck2.checkpointId,
      targetModelFamily: 'claude-reader-latest',
      benchmarkId: 'bench-reader-002',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, run2.trainRunId);
    completeTrainingRun(tmpDir, run2.trainRunId);
    markCheckpointDeployable(tmpDir, ck2.checkpointId, true);
    advancePromotion(tmpDir, {
      checkpointId: ck2.checkpointId,
      targetProfile: 'local-reader',
      baselineMetrics: DEFAULT_BASELINE_METRICS,
      orchestratorReviewPassed: true,
      reviewNote: 'Test approval',
    });

    // First bind
    const d1 = bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck1);
    expect(d1.activeCheckpointId).toBe(ck1);
    expect(d1.previousCheckpointId).toBeNull();

    // Update bind to new checkpoint
    const d2 = bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck2.checkpointId);
    expect(d2.activeCheckpointId).toBe(ck2.checkpointId);
    expect(d2.previousCheckpointId).toBe(ck1);
    expect(d2.routingEnabled).toBe(false); // Reset to false on re-bind
    expect(d2.deploymentId).toBe(d1.deploymentId); // Same deployment record
  });

  it('accepts a note on bind', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);

    const deployment = bindCheckpointToWorkerProfile(
      tmpDir,
      'local-reader',
      checkpointId,
      'Initial production deployment'
    );

    expect(deployment.note).toBe('Initial production deployment');
  });
});

// ---------------------------------------------------------------------------
// Tests: getDeployment / listDeployments
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry getDeployment / listDeployments', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('returns null for a profile with no deployment', () => {
    const deployment = getDeployment(tmpDir, 'local-reader');
    expect(deployment).toBeNull();
  });

  it('getDeployment returns the bound deployment', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    const deployment = getDeployment(tmpDir, 'local-reader');
    expect(deployment).not.toBeNull();
    expect(deployment!.workerProfile).toBe('local-reader');
  });

  it('listDeployments returns all deployments sorted by updatedAt desc', () => {
    const { checkpointId: ckReader } = setupDeployableReaderCheckpoint(tmpDir);
    const { checkpointId: ckEditor } = setupDeployableEditorCheckpoint(tmpDir);

    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ckReader);
    bindCheckpointToWorkerProfile(tmpDir, 'local-editor', ckEditor);

    const deployments = listDeployments(tmpDir);
    expect(deployments).toHaveLength(2);
    // Most recently updated is last in the list (sorted asc by updatedAt in memory)
    expect(deployments[0].workerProfile).toBe('local-editor'); // bound second
  });

  it('listDeployments filters by workerProfile', () => {
    const { checkpointId: ckReader } = setupDeployableReaderCheckpoint(tmpDir);
    const { checkpointId: ckEditor } = setupDeployableEditorCheckpoint(tmpDir);

    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ckReader);
    bindCheckpointToWorkerProfile(tmpDir, 'local-editor', ckEditor);

    const readerDeployments = listDeployments(tmpDir, { workerProfile: 'local-reader' });
    expect(readerDeployments).toHaveLength(1);
    expect(readerDeployments[0].workerProfile).toBe('local-reader');
  });

  it('listDeployments filters by routingEnabled', () => {
    const { checkpointId: ckReader } = setupDeployableReaderCheckpoint(tmpDir);
    const { checkpointId: ckEditor } = setupDeployableEditorCheckpoint(tmpDir);

    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ckReader);
    bindCheckpointToWorkerProfile(tmpDir, 'local-editor', ckEditor);

    enableRoutingForProfile(tmpDir, 'local-editor');

    const enabled = listDeployments(tmpDir, { routingEnabled: true });
    const disabled = listDeployments(tmpDir, { routingEnabled: false });

    expect(enabled).toHaveLength(1);
    expect(enabled[0].workerProfile).toBe('local-editor');
    expect(disabled).toHaveLength(1);
    expect(disabled[0].workerProfile).toBe('local-reader');
  });
});

// ---------------------------------------------------------------------------
// Tests: enableRoutingForProfile / disableRoutingForProfile
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry routing enable/disable', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('routingEnabled starts false after bind', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    const deployment = getDeployment(tmpDir, 'local-reader');
    expect(deployment!.routingEnabled).toBe(false);
  });

  it('enableRoutingForProfile sets routingEnabled to true', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    const deployment = enableRoutingForProfile(tmpDir, 'local-reader');

    expect(deployment.routingEnabled).toBe(true);
    expect(isRoutingEnabledForProfile(tmpDir, 'local-reader')).toBe(true);
  });

  it('disableRoutingForProfile sets routingEnabled to false', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);
    enableRoutingForProfile(tmpDir, 'local-reader');

    const deployment = disableRoutingForProfile(tmpDir, 'local-reader');

    expect(deployment.routingEnabled).toBe(false);
    expect(isRoutingEnabledForProfile(tmpDir, 'local-reader')).toBe(false);
  });

  it('enableRoutingForProfile fails if no deployment exists', () => {
    expect(() => enableRoutingForProfile(tmpDir, 'local-reader')).toThrow(
      'no deployment found'
    );
  });

  it('enableRoutingForProfile fails if active checkpoint was rolled back to null', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);
    // Manually set activeCheckpointId to null via direct registry manipulation
    // to simulate a profile bound to a checkpoint that was subsequently revoked
    // (an out-of-scope Phase 5 operation would normally do this).
    // This tests the guard in enableRoutingForProfile that checks activeCheckpointId.
    const registryPath = path.join(tmpDir, '.state', 'nocturnal', 'deployment-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    registry.deployments[0].activeCheckpointId = null;
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    expect(() => enableRoutingForProfile(tmpDir, 'local-reader')).toThrow(
      'no active checkpoint'
    );
  });

  it('isRoutingEnabledForProfile returns false for unknown profile', () => {
    expect(isRoutingEnabledForProfile(tmpDir, 'local-reader')).toBe(false);
  });

  it('isRoutingEnabledForProfile returns false when active checkpoint is revoked', () => {
    // Set up a bound and enabled deployment
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);
    enableRoutingForProfile(tmpDir, 'local-reader');

    // Confirm routing is enabled
    expect(isRoutingEnabledForProfile(tmpDir, 'local-reader')).toBe(true);

    // Revoke the checkpoint (simulates re-evaluation failure or deprecation)
    markCheckpointDeployable(tmpDir, checkpointId, false);

    // GOVERNANCE: isRoutingEnabledForProfile must return false after revocation
    // even though the routingEnabled toggle is still true in the deployment registry
    expect(isRoutingEnabledForProfile(tmpDir, 'local-reader')).toBe(false);
  });

  it('getActiveCheckpointForProfile returns checkpoint ID when bound', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    expect(getActiveCheckpointForProfile(tmpDir, 'local-reader')).toBe(checkpointId);
  });

  it('getActiveCheckpointForProfile returns null when no deployment', () => {
    expect(getActiveCheckpointForProfile(tmpDir, 'local-reader')).toBeNull();
  });

  it('enable/disable does not change activeCheckpointId', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);
    enableRoutingForProfile(tmpDir, 'local-reader');
    disableRoutingForProfile(tmpDir, 'local-reader');

    expect(getActiveCheckpointForProfile(tmpDir, 'local-reader')).toBe(checkpointId);
  });
});

// ---------------------------------------------------------------------------
// Tests: rollbackDeployment
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry rollbackDeployment', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('rollback fails when there is no previous checkpoint', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    expect(() => rollbackDeployment(tmpDir, 'local-reader')).toThrow(
      'no previous checkpoint available'
    );
  });

  it('rollback fails when no deployment exists', () => {
    expect(() => rollbackDeployment(tmpDir, 'local-reader')).toThrow(
      'no deployment found'
    );
  });

  it('rollback to previous checkpoint succeeds and disables routing', () => {
    // Set up ck1
    const { checkpointId: ck1 } = setupDeployableReaderCheckpoint(tmpDir);

    // Set up ck2
    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'claude-reader-latest',
      datasetFingerprint: 'sha256-reader-002',
      exportId: 'export-reader-2',
      sampleCount: 30,
      configFingerprint: 'cfg-v1',
    });
    const ck2 = registerCheckpoint(tmpDir, {
      trainRunId: run2.trainRunId,
      targetModelFamily: 'claude-reader-latest',
      artifactPath: '/checkpoints/reader-ck-002.safetensors',
    });
    attachEvalSummary(tmpDir, ck2.checkpointId, {
      evalId: 'eval-reader-002',
      checkpointId: ck2.checkpointId,
      targetModelFamily: 'claude-reader-latest',
      benchmarkId: 'bench-reader-002',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, run2.trainRunId);
    completeTrainingRun(tmpDir, run2.trainRunId);
    markCheckpointDeployable(tmpDir, ck2.checkpointId, true);
    advancePromotion(tmpDir, {
      checkpointId: ck2.checkpointId,
      targetProfile: 'local-reader',
      baselineMetrics: DEFAULT_BASELINE_METRICS,
      orchestratorReviewPassed: true,
      reviewNote: 'Test approval',
    });

    // Bind ck1, then update to ck2
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck1);
    enableRoutingForProfile(tmpDir, 'local-reader');
    // Note: re-binding resets routingEnabled to false — must re-enable
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck2.checkpointId, 'promoted ck2');
    enableRoutingForProfile(tmpDir, 'local-reader');

    // Verify ck2 is active and routing is enabled
    expect(getActiveCheckpointForProfile(tmpDir, 'local-reader')).toBe(ck2.checkpointId);
    expect(isRoutingEnabledForProfile(tmpDir, 'local-reader')).toBe(true);

    // Roll back
    const rolledBack = rollbackDeployment(tmpDir, 'local-reader', 'rolled back to ck1');

    expect(rolledBack.activeCheckpointId).toBe(ck1);
    expect(rolledBack.previousCheckpointId).toBe(ck2.checkpointId); // ck2 becomes previous
    expect(rolledBack.routingEnabled).toBe(false); // Always reset
    expect(rolledBack.note).toBe('rolled back to ck1');
  });

  it('rollback fails when previous checkpoint no longer exists', () => {
    const { checkpointId: ck1 } = setupDeployableReaderCheckpoint(tmpDir);

    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'claude-reader-latest',
      datasetFingerprint: 'sha256-reader-002',
      exportId: 'export-reader-2',
      sampleCount: 30,
      configFingerprint: 'cfg-v1',
    });
    const ck2 = registerCheckpoint(tmpDir, {
      trainRunId: run2.trainRunId,
      targetModelFamily: 'claude-reader-latest',
      artifactPath: '/checkpoints/reader-ck-002.safetensors',
    });
    attachEvalSummary(tmpDir, ck2.checkpointId, {
      evalId: 'eval-reader-002',
      checkpointId: ck2.checkpointId,
      targetModelFamily: 'claude-reader-latest',
      benchmarkId: 'bench-reader-002',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, run2.trainRunId);
    completeTrainingRun(tmpDir, run2.trainRunId);
    markCheckpointDeployable(tmpDir, ck2.checkpointId, true);
    advancePromotion(tmpDir, {
      checkpointId: ck2.checkpointId,
      targetProfile: 'local-reader',
      baselineMetrics: DEFAULT_BASELINE_METRICS,
      orchestratorReviewPassed: true,
      reviewNote: 'Test approval',
    });

    // Bind ck1, then ck2 on top — previousCheckpointId = ck1
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck1);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck2.checkpointId);

    // Simulate ck1 being deleted from the training registry (outside Phase 5 scope)
    // by directly editing the training-registry.json
    const trainingRegistryPath = path.join(tmpDir, '.state', 'nocturnal', 'training-registry.json');
    const trainingRegistry = JSON.parse(fs.readFileSync(trainingRegistryPath, 'utf-8'));
    trainingRegistry.checkpoints = trainingRegistry.checkpoints.filter(
      (ck: { checkpointId: string }) => ck.checkpointId !== ck1
    );
    fs.writeFileSync(trainingRegistryPath, JSON.stringify(trainingRegistry, null, 2));

    // Now rollbackDeployment must fail because ck1 no longer exists
    expect(() => rollbackDeployment(tmpDir, 'local-reader')).toThrow(
      `no longer exists in the training registry`
    );
  });

  it('can roll back twice (ck1 → ck2 → ck1)', () => {
    const { checkpointId: ck1 } = setupDeployableReaderCheckpoint(tmpDir);

    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'claude-reader-latest',
      datasetFingerprint: 'sha256-reader-002',
      exportId: 'export-reader-2',
      sampleCount: 30,
      configFingerprint: 'cfg-v1',
    });
    const ck2 = registerCheckpoint(tmpDir, {
      trainRunId: run2.trainRunId,
      targetModelFamily: 'claude-reader-latest',
      artifactPath: '/checkpoints/reader-ck-002.safetensors',
    });
    attachEvalSummary(tmpDir, ck2.checkpointId, {
      evalId: 'eval-reader-002',
      checkpointId: ck2.checkpointId,
      targetModelFamily: 'claude-reader-latest',
      benchmarkId: 'bench-reader-002',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, run2.trainRunId);
    completeTrainingRun(tmpDir, run2.trainRunId);
    markCheckpointDeployable(tmpDir, ck2.checkpointId, true);
    advancePromotion(tmpDir, {
      checkpointId: ck2.checkpointId,
      targetProfile: 'local-reader',
      baselineMetrics: DEFAULT_BASELINE_METRICS,
      orchestratorReviewPassed: true,
      reviewNote: 'Test approval',
    });

    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck1);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck2.checkpointId); // ck1 is now previous
    const r1 = rollbackDeployment(tmpDir, 'local-reader'); // back to ck1, ck2 is now previous
    expect(r1.activeCheckpointId).toBe(ck1);

    // Enable routing, then roll back again to ck2
    enableRoutingForProfile(tmpDir, 'local-reader');
    const r2 = rollbackDeployment(tmpDir, 'local-reader'); // back to ck2
    expect(r2.activeCheckpointId).toBe(ck2.checkpointId);
    expect(r2.previousCheckpointId).toBe(ck1); // ck1 is still tracked
    expect(r2.routingEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Lineage Queries
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry lineage queries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('getDeploymentLineage returns deployment and active checkpoint', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId, 'reader v1');

    const lineage = getDeploymentLineage(tmpDir, 'local-reader');

    expect(lineage).not.toBeNull();
    expect(lineage!.deployment.workerProfile).toBe('local-reader');
    expect(lineage!.deployment.note).toBe('reader v1');
    expect(lineage!.activeCheckpoint).not.toBeNull();
    expect(lineage!.activeCheckpoint!.checkpointId).toBe(checkpointId);
  });

  it('getDeploymentLineage returns null for unknown profile', () => {
    const lineage = getDeploymentLineage(tmpDir, 'local-reader');
    expect(lineage).toBeNull();
  });

  it('rollback exhausts history when only one checkpoint exists (no previous to roll back to)', () => {
    // Bind a single checkpoint — there is no previous to roll back to
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    // Attempting to roll back should fail because previousCheckpointId is null
    expect(() => rollbackDeployment(tmpDir, 'local-reader')).toThrow(
      'no previous checkpoint available'
    );

    // The active checkpoint is still set (rollback didn't happen)
    expect(getActiveCheckpointForProfile(tmpDir, 'local-reader')).toBe(checkpointId);
  });
});

// ---------------------------------------------------------------------------
// Tests: Stats
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry stats', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('returns zeros for empty registry', () => {
    const stats = getDeploymentRegistryStats(tmpDir);
    expect(stats.totalDeployments).toBe(0);
    expect(stats.activeDeployments).toBe(0);
    expect(stats.profilesWithBindings).toBe(0);
    expect(stats.profilesWithRoutingEnabled).toBe(0);
  });

  it('counts profiles with bindings and routing enabled', () => {
    const { checkpointId: ckReader } = setupDeployableReaderCheckpoint(tmpDir);
    const { checkpointId: ckEditor } = setupDeployableEditorCheckpoint(tmpDir);

    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ckReader);
    bindCheckpointToWorkerProfile(tmpDir, 'local-editor', ckEditor);
    enableRoutingForProfile(tmpDir, 'local-editor');

    const stats = getDeploymentRegistryStats(tmpDir);
    expect(stats.totalDeployments).toBe(2);
    expect(stats.profilesWithBindings).toBe(2);
    expect(stats.activeDeployments).toBe(1);
    expect(stats.profilesWithRoutingEnabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Registry Persistence
// ---------------------------------------------------------------------------

describe('ModelDeploymentRegistry persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('getFullDeploymentRegistry returns all deployment records', () => {
    const { checkpointId: ckReader } = setupDeployableReaderCheckpoint(tmpDir);
    const { checkpointId: ckEditor } = setupDeployableEditorCheckpoint(tmpDir);

    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ckReader);
    bindCheckpointToWorkerProfile(tmpDir, 'local-editor', ckEditor);

    const registry = getFullDeploymentRegistry(tmpDir);
    expect(registry.deployments).toHaveLength(2);
  });

  it('registry persists to disk as JSON', () => {
    const { checkpointId } = setupDeployableReaderCheckpoint(tmpDir);
    bindCheckpointToWorkerProfile(tmpDir, 'local-reader', checkpointId);

    const registryPath = path.join(tmpDir, '.state', 'nocturnal', 'deployment-registry.json');
    expect(fs.existsSync(registryPath)).toBe(true);

    const raw = fs.readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.deployments).toHaveLength(1);
    expect(parsed.deployments[0].workerProfile).toBe('local-reader');
  });
});
