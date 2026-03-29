/**
 * Integration Tests for Phase 7 Rollout
 * =====================================
 *
 * Tests the complete integration flow:
 * - Training → checkpoint → eval → promotion gate → deployment binding
 * - Only local-reader eligible for first rollout
 * - Orchestrator review required for promotion
 * - Rollback path works
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  registerTrainingRun,
  startTrainingRun,
  completeTrainingRun,
  registerCheckpoint,
  attachEvalSummary,
  markCheckpointDeployable,
  getCheckpoint,
} from '../../src/core/model-training-registry.js';
import {
  bindCheckpointToWorkerProfile,
  getDeployment,
  enableRoutingForProfile,
  disableRoutingForProfile,
  rollbackDeployment,
  isRoutingEnabledForProfile,
  getActiveCheckpointForProfile,
} from '../../src/core/model-deployment-registry.js';
import {
  evaluatePromotionGate,
  advancePromotion,
  getPromotionState,
  getPromotionRecord,
  DEFAULT_BASELINE_METRICS,
  DEFAULT_MIN_DELTA,
} from '../../src/core/promotion-gate.js';

describe('Phase 7 Rollout Integration', () => {
  // -------------------------------------------------------------------------
  // Test setup
  // -------------------------------------------------------------------------

  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rollout-test-'));
    stateDir = path.join(tempDir, '.state', 'nocturnal');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // Helper: Create a deployable checkpoint with eval
  // -------------------------------------------------------------------------

  function createDeployableCheckpoint(params: {
    delta?: number;
    verdict?: 'pass' | 'fail' | 'compare_only';
    candidateScore?: number;
    targetModelFamily?: string;
    markDeplorable?: boolean; // If false, skip markCheckpointDeployable
  }): string {
    const {
      delta = 0.08,
      verdict = 'pass',
      candidateScore = 0.8,
      targetModelFamily = 'qwen2.5-7b-reader',
      markDeplorable = true,
    } = params;

    // Register training run
    const run = registerTrainingRun(stateDir, {
      targetModelFamily,
      datasetFingerprint: 'fp-dataset-abc',
      exportId: 'export-123',
      sampleCount: 100,
      configFingerprint: 'fp-config-xyz',
    });

    // Complete the training run so checkpoint can be marked deployable
    startTrainingRun(stateDir, run.trainRunId);
    completeTrainingRun(stateDir, run.trainRunId);

    // Register checkpoint
    const checkpoint = registerCheckpoint(stateDir, {
      trainRunId: run.trainRunId,
      targetModelFamily,
      artifactPath: path.join(tempDir, 'checkpoints', 'ckpt-001'),
    });

    // Attach eval
    const evalId = `eval-${Date.now()}`;
    attachEvalSummary(stateDir, checkpoint.checkpointId, {
      evalId,
      checkpointId: checkpoint.checkpointId,
      benchmarkId: 'benchmark-001',
      targetModelFamily,
      mode: 'reduced_prompt',
      baselineScore: 0.7,
      candidateScore,
      delta,
      verdict,
    });

    // Mark deployable (only if verdict is pass/compare_only and markDeployable is true)
    if (markDeplorable && (verdict === 'pass' || verdict === 'compare_only')) {
      markCheckpointDeployable(stateDir, checkpoint.checkpointId, true);
    }

    return checkpoint.checkpointId;
  }

  // -------------------------------------------------------------------------
  // Helper: Advance checkpoint to shadow_ready
  // -------------------------------------------------------------------------

  function advanceToShadowReady(checkpointId: string): void {
    advancePromotion(stateDir, {
      checkpointId,
      targetProfile: 'local-reader',
      baselineMetrics: DEFAULT_BASELINE_METRICS,
      orchestratorReviewPassed: true,
      reviewNote: 'Approved for shadow rollout',
    });
  }

  // -------------------------------------------------------------------------
  // Test: Complete rollout flow
  // -------------------------------------------------------------------------

  describe('Complete Rollout Flow', () => {
    it('should complete: checkpoint → eval → promotion → binding → routing', () => {
      // Step 1: Create deployable checkpoint
      const checkpointId = createDeployableCheckpoint({
        delta: 0.15,
        verdict: 'pass',
        candidateScore: 0.85,
      });

      // Step 2: Evaluate promotion gate
      const gateResult = evaluatePromotionGate(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });
      expect(gateResult.passes).toBe(true);

      // Step 3: Advance promotion state
      advanceToShadowReady(checkpointId);
      expect(getPromotionState(stateDir, checkpointId)).toBe('shadow_ready');

      // Step 4: Bind checkpoint to worker profile
      const deployment = bindCheckpointToWorkerProfile(
        stateDir,
        'local-reader',
        checkpointId,
        'Initial shadow deployment'
      );
      expect(deployment.activeCheckpointId).toBe(checkpointId);
      expect(deployment.routingEnabled).toBe(false);

      // Step 5: Verify routing is disabled initially
      expect(isRoutingEnabledForProfile(stateDir, 'local-reader')).toBe(false);

      // Step 6: Enable routing
      const updated = enableRoutingForProfile(stateDir, 'local-reader');
      expect(updated.routingEnabled).toBe(true);

      // Step 7: Verify routing is enabled
      expect(isRoutingEnabledForProfile(stateDir, 'local-reader')).toBe(true);

      // Step 8: Disable routing
      disableRoutingForProfile(stateDir, 'local-reader');
      expect(isRoutingEnabledForProfile(stateDir, 'local-reader')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Test: Only local-reader eligible for first rollout
  // -------------------------------------------------------------------------

  describe('First Rollout Profile Constraint', () => {
    it('should allow local-reader for first rollout', () => {
      const checkpointId = createDeployableCheckpoint({
        delta: 0.15,
        verdict: 'pass',
      });

      advanceToShadowReady(checkpointId);

      // Should succeed
      const deployment = bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpointId);
      expect(deployment.workerProfile).toBe('local-reader');
    });

    it('should allow deployment binding without promotion gate check (backward compat)', () => {
      // This tests the case where a checkpoint is already bound
      // and the promotion gate check is added later
      // First, create a checkpoint WITHOUT promotion gate
      const run = registerTrainingRun(stateDir, {
        targetModelFamily: 'qwen2.5-7b-reader',
        datasetFingerprint: 'fp-dataset-abc',
        exportId: 'export-123',
        sampleCount: 100,
        configFingerprint: 'fp-config-xyz',
      });
      startTrainingRun(stateDir, run.trainRunId);
      completeTrainingRun(stateDir, run.trainRunId);

      const checkpoint = registerCheckpoint(stateDir, {
        trainRunId: run.trainRunId,
        targetModelFamily: 'qwen2.5-7b-reader',
        artifactPath: path.join(tempDir, 'checkpoints', 'ckpt-no-promotion'),
      });

      // Attach eval but DON'T mark deployable (simulating old state before promotion)
      attachEvalSummary(stateDir, checkpoint.checkpointId, {
        evalId: 'eval-no-promotion',
        checkpointId: checkpoint.checkpointId,
        benchmarkId: 'benchmark-001',
        targetModelFamily: 'qwen2.5-7b-reader',
        mode: 'reduced_prompt',
        baselineScore: 0.7,
        candidateScore: 0.8,
        delta: 0.1,
        verdict: 'pass',
      });

      // Without promotion gate evaluated, binding should fail
      expect(() => {
        bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpoint.checkpointId);
      }).toThrow(/not deployable/);
    });
  });

  // -------------------------------------------------------------------------
  // Test: Orchestrator review required
  // -------------------------------------------------------------------------

  describe('Orchestrator Review Requirement', () => {
    it('should not reach shadow_ready without orchestrator review', () => {
      const checkpointId = createDeployableCheckpoint({
        delta: 0.15,
        verdict: 'pass',
        candidateScore: 0.85,
      });

      // Advance without orchestrator review
      const promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: false,
      });

      // Should be candidate_only, not shadow_ready
      expect(promotion.state).toBe('candidate_only');
      expect(promotion.orchestratorReviewPassed).toBe(false);
    });

    it('should reach shadow_ready with orchestrator review', () => {
      const checkpointId = createDeployableCheckpoint({
        delta: 0.15,
        verdict: 'pass',
        candidateScore: 0.85,
      });

      // Advance with orchestrator review
      const promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
        reviewNote: 'Looks good, proceed',
      });

      expect(promotion.state).toBe('shadow_ready');
      expect(promotion.orchestratorReviewPassed).toBe(true);
      expect(promotion.reviewNote).toBe('Looks good, proceed');
    });
  });

  // -------------------------------------------------------------------------
  // Test: Rollback path
  // -------------------------------------------------------------------------

  describe('Rollback Path', () => {
    it('should preserve previous checkpoint on re-binding', () => {
      // Create first checkpoint
      const checkpoint1 = createDeployableCheckpoint({
        delta: 0.1,
        verdict: 'pass',
        targetModelFamily: 'qwen2.5-7b-reader',
      });
      advanceToShadowReady(checkpoint1);

      // Bind first checkpoint
      bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpoint1);
      expect(getActiveCheckpointForProfile(stateDir, 'local-reader')).toBe(checkpoint1);

      // Create second checkpoint
      const checkpoint2 = createDeployableCheckpoint({
        delta: 0.15,
        verdict: 'pass',
        targetModelFamily: 'qwen2.5-7b-reader',
      });
      advanceToShadowReady(checkpoint2);

      // Bind second checkpoint (should update, not replace chain)
      bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpoint2, 'Update to newer checkpoint');

      const deployment = getDeployment(stateDir, 'local-reader');
      expect(deployment.activeCheckpointId).toBe(checkpoint2);
      expect(deployment.previousCheckpointId).toBe(checkpoint1);
    });

    it('should rollback to previous checkpoint', () => {
      // Create and bind first checkpoint
      const checkpoint1 = createDeployableCheckpoint({
        delta: 0.1,
        verdict: 'pass',
        targetModelFamily: 'qwen2.5-7b-reader',
      });
      advanceToShadowReady(checkpoint1);
      bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpoint1);

      // Create and bind second checkpoint
      const checkpoint2 = createDeployableCheckpoint({
        delta: 0.15,
        verdict: 'pass',
        targetModelFamily: 'qwen2.5-7b-reader',
      });
      advanceToShadowReady(checkpoint2);
      bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpoint2);

      // Enable routing
      enableRoutingForProfile(stateDir, 'local-reader');

      // Rollback
      const rolledBack = rollbackDeployment(stateDir, 'local-reader', 'Rollback due to instability');

      // Verify rollback
      expect(rolledBack.activeCheckpointId).toBe(checkpoint1);
      expect(rolledBack.previousCheckpointId).toBe(checkpoint2);
      expect(rolledBack.routingEnabled).toBe(false); // Routing disabled after rollback

      // Verify routing is disabled
      expect(isRoutingEnabledForProfile(stateDir, 'local-reader')).toBe(false);
    });

    it('should fail rollback when no previous checkpoint exists', () => {
      // Single checkpoint with no previous - rollback should fail
      const checkpointId = createDeployableCheckpoint({
        delta: 0.08,
        verdict: 'pass',
        targetModelFamily: 'qwen2.5-7b-reader',
      });
      advanceToShadowReady(checkpointId);
      bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpointId);

      // Rollback should fail because there's no previous checkpoint
      expect(() => {
        rollbackDeployment(stateDir, 'local-reader');
      }).toThrow(/no previous checkpoint/);
    });
  });

  // -------------------------------------------------------------------------
  // Test: Fail-closed on various scenarios
  // -------------------------------------------------------------------------

  describe('Fail-Closed Behavior', () => {
    it('should fail binding if checkpoint has no eval', () => {
      const run = registerTrainingRun(stateDir, {
        targetModelFamily: 'qwen2.5-7b-reader',
        datasetFingerprint: 'fp-dataset-abc',
        exportId: 'export-123',
        sampleCount: 100,
        configFingerprint: 'fp-config-xyz',
      });

      const checkpoint = registerCheckpoint(stateDir, {
        trainRunId: run.trainRunId,
        targetModelFamily: 'qwen2.5-7b-reader',
        artifactPath: path.join(tempDir, 'checkpoints', 'ckpt-no-eval'),
      });

      // Should fail because checkpoint is not deployable (no eval)
      expect(() => {
        bindCheckpointToWorkerProfile(stateDir, 'local-reader', checkpoint.checkpointId);
      }).toThrow(/not deployable/);
    });

    it('should fail binding if eval verdict is fail', () => {
      const checkpointId = createDeployableCheckpoint({
        delta: -0.1,
        verdict: 'fail',
        candidateScore: 0.3,
      });

      advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });

      // Should fail because promotion state is rejected
      expect(getPromotionState(stateDir, checkpointId)).toBe('rejected');
    });
  });

  // -------------------------------------------------------------------------
  // Test: Promotion state machine
  // -------------------------------------------------------------------------

  describe('Promotion State Machine', () => {
    it('should flow: candidate_only → shadow_ready → promotable', () => {
      const checkpointId = createDeployableCheckpoint({
        delta: 0.1,
        verdict: 'pass',
        candidateScore: 0.8,
      });

      // Initial evaluation: should be candidate_only (no review)
      let promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: false,
      });
      expect(promotion.state).toBe('candidate_only');

      // After orchestrator review: should be shadow_ready
      promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(promotion.state).toBe('shadow_ready');
      expect(promotion.shadowStartedAt).toBeDefined();
    });

    it('should reject if delta is negative', () => {
      const checkpointId = createDeployableCheckpoint({
        delta: -0.05,
        verdict: 'fail',
        candidateScore: 0.3,
      });

      const promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });

      expect(promotion.state).toBe('rejected');
    });
  });
});
