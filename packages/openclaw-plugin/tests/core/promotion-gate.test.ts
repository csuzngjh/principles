/**
 * Tests for Promotion Gate
 * ========================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  evaluatePromotionGate,
  advancePromotion,
  getPromotionState,
  getPromotionRecord,
  listPromotionsByState,
  rejectCheckpoint,
  DEFAULT_BASELINE_METRICS,
  DEFAULT_MIN_DELTA,
  DEFAULT_ALLOWED_MARGIN,
  type PromotionState,
} from '../../src/core/promotion-gate.js';
import {
  registerTrainingRun,
  registerCheckpoint,
  attachEvalSummary,
  getFullRegistry as getTrainingRegistry,
} from '../../src/core/model-training-registry.js';

describe('promotion-gate', () => {
  // -------------------------------------------------------------------------
  // Test setup
  // -------------------------------------------------------------------------

  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-promotion-test-'));
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
  // Helper to create a checkpoint with eval
  // -------------------------------------------------------------------------

  function createCheckpointWithEval(params: {
    delta?: number;
    verdict?: 'pass' | 'fail' | 'compare_only';
    candidateScore?: number;
  }): { checkpointId: string; evalId: string } {
    const {
      delta = 0.1,
      verdict = 'pass',
      candidateScore = 0.8,
    } = params;

    // Register training run
    const run = registerTrainingRun(stateDir, {
      targetModelFamily: 'qwen2.5-7b-reader',
      datasetFingerprint: 'fp-dataset-abc',
      exportId: 'export-123',
      sampleCount: 100,
      configFingerprint: 'fp-config-xyz',
    });

    // Register checkpoint
    const checkpoint = registerCheckpoint(stateDir, {
      trainRunId: run.trainRunId,
      targetModelFamily: 'qwen2.5-7b-reader',
      artifactPath: path.join(tempDir, 'checkpoints', 'ckpt-001'),
    });

    // Attach eval
    const evalId = `eval-${Date.now()}`;
    attachEvalSummary(stateDir, checkpoint.checkpointId, {
      evalId,
      checkpointId: checkpoint.checkpointId,
      benchmarkId: 'benchmark-001',
      targetModelFamily: 'qwen2.5-7b-reader',
      mode: 'reduced_prompt',
      baselineScore: 0.7,
      candidateScore,
      delta,
      verdict,
    });

    return { checkpointId: checkpoint.checkpointId, evalId };
  }

  // -------------------------------------------------------------------------
  // DEFAULT_BASELINE_METRICS
  // -------------------------------------------------------------------------

  describe('DEFAULT_BASELINE_METRICS', () => {
    it('should have sensible Phase 7 defaults', () => {
      expect(DEFAULT_BASELINE_METRICS.arbiterRejectRate).toBe(0.15);
      expect(DEFAULT_BASELINE_METRICS.executabilityRejectRate).toBe(0.10);
      expect(DEFAULT_BASELINE_METRICS.reviewedSubsetQuality).toBe(0.70);
    });
  });

  describe('DEFAULT_MIN_DELTA', () => {
    it('should be 0.05', () => {
      expect(DEFAULT_MIN_DELTA).toBe(0.05);
    });
  });

  describe('DEFAULT_ALLOWED_MARGIN', () => {
    it('should be 0.05', () => {
      expect(DEFAULT_ALLOWED_MARGIN).toBe(0.05);
    });
  });

  // -------------------------------------------------------------------------
  // evaluatePromotionGate
  // -------------------------------------------------------------------------

  describe('evaluatePromotionGate', () => {
    it('should fail when checkpoint does not exist', () => {
      const result = evaluatePromotionGate(stateDir, {
        checkpointId: 'nonexistent',
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(result.passes).toBe(false);
      expect(result.blockers).toContainEqual(
        expect.stringContaining('not found')
      );
    });

    it('should fail when no eval is attached', () => {
      // Register run and checkpoint without eval
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
        artifactPath: path.join(tempDir, 'checkpoints', 'ckpt-001'),
      });

      const result = evaluatePromotionGate(stateDir, {
        checkpointId: checkpoint.checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(result.passes).toBe(false);
      expect(result.blockers).toContainEqual(
        expect.stringContaining('no eval summary')
      );
    });

    it('should fail when delta is below threshold', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.01, // Below 0.05 threshold
        verdict: 'compare_only',
      });

      const result = evaluatePromotionGate(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(result.passes).toBe(false);
      expect(result.deltaCheck.passed).toBe(false);
      expect(result.blockers).toContainEqual(
        expect.stringContaining('below threshold')
      );
    });

    it('should pass when delta is above threshold', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.1, // Above 0.05 threshold
        verdict: 'pass',
        candidateScore: 0.8,
      });

      const result = evaluatePromotionGate(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(result.passes).toBe(true);
      expect(result.suggestedState).toBeDefined();
    });

    it('should pass for any profile when checkpoint quality is good', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.1,
        verdict: 'pass',
      });

      // Promotion gate evaluates checkpoint quality, not rollout policy.
      // Profile-specific rollout constraints are handled at the rollout decision level,
      // not at the gate evaluation level.
      const result = evaluatePromotionGate(stateDir, {
        checkpointId,
        targetProfile: 'local-editor',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(result.passes).toBe(true);
      expect(result.suggestedState).toBeDefined();
    });

    it('should suggest shadow_ready for strong delta', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.15, // Above 2x threshold
        verdict: 'pass',
        candidateScore: 0.85,
      });

      const result = evaluatePromotionGate(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(result.passes).toBe(true);
      expect(result.suggestedState).toBe('shadow_ready');
    });

    it('should return constraint check details', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.1,
        verdict: 'pass',
        candidateScore: 0.75,
      });

      const result = evaluatePromotionGate(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(result.constraintChecks.length).toBeGreaterThan(0);
      expect(result.deltaCheck).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // advancePromotion
  // -------------------------------------------------------------------------

  describe('advancePromotion', () => {
    it('should create promotion record with rejected state when gate fails', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.01, // Below threshold
        verdict: 'compare_only',
      });

      const promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(promotion.state).toBe('rejected');
      expect(promotion.promotionId).toBeDefined();
      expect(promotion.checkpointId).toBe(checkpointId);
    });

    it('should create promotion record with candidate_only when gate passes but no review', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.08,
        verdict: 'pass',
      });

      const promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      expect(promotion.state).toBe('candidate_only');
      expect(promotion.orchestratorReviewPassed).toBe(false);
    });

    it('should create promotion record with shadow_ready when gate passes with review', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.15, // Strong delta
        verdict: 'pass',
        candidateScore: 0.85,
      });

      const promotion = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
        reviewNote: 'Looks good, proceed with shadow rollout',
      });

      expect(promotion.state).toBe('shadow_ready');
      expect(promotion.orchestratorReviewPassed).toBe(true);
      expect(promotion.shadowStartedAt).toBeDefined();
    });

    it('should update existing promotion record', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.08,
        verdict: 'pass',
      });

      // First advancement
      const promotion1 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });
      expect(promotion1.state).toBe('candidate_only');

      // Second advancement with orchestrator review
      const promotion2 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(promotion2.state).toBe('shadow_ready');
      expect(promotion2.promotionId).toBe(promotion1.promotionId);
    });

    it('preserves original shadowStartedAt on repeated advancePromotion calls', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.15,
        verdict: 'pass',
        candidateScore: 0.85,
      });

      // First advance: candidate_only → shadow_ready (sets shadowStartedAt)
      const p1 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(p1.state).toBe('shadow_ready');
      expect(p1.shadowStartedAt).toBeDefined();
      const originalShadowStartedAt = p1.shadowStartedAt;

      // Advance again: shadow_ready → shadow_ready (shadow window not elapsed)
      // This MUST NOT reset shadowStartedAt
      const p2 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(p2.state).toBe('shadow_ready');
      expect(p2.shadowStartedAt).toBe(originalShadowStartedAt);
    });

    it('resets shadowStartedAt when re-entering shadow after demotion to candidate_only', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.15,
        verdict: 'pass',
        candidateScore: 0.85,
      });

      // 1. Advance to shadow_ready — sets shadowStartedAt
      const p1 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(p1.state).toBe('shadow_ready');
      expect(p1.shadowStartedAt).toBeDefined();
      const originalShadowStartedAt = p1.shadowStartedAt;

      // 2. Demote: advance WITHOUT review → candidate_only
      const p2 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        // No orchestratorReviewPassed → gate passes but stays candidate_only
      });
      expect(p2.state).toBe('candidate_only');

      // 3. Re-enter shadow: advance WITH review → shadow_ready
      const p3 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(p3.state).toBe('shadow_ready');
      // MUST reset shadowStartedAt — the checkpoint left the shadow path
      expect(p3.shadowStartedAt).toBeDefined();
      expect(p3.shadowStartedAt).not.toBe(originalShadowStartedAt);
    });

    it('resets shadowStartedAt when re-entering shadow after rejection', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.15,
        verdict: 'pass',
        candidateScore: 0.85,
      });

      // 1. Advance to shadow_ready
      const p1 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(p1.state).toBe('shadow_ready');
      const originalShadowStartedAt = p1.shadowStartedAt;

      // 2. Reject
      const p2 = rejectCheckpoint(stateDir, checkpointId, 'Shadow metrics regressed');
      expect(p2.state).toBe('rejected');

      // 3. Re-enter shadow: advance with review → shadow_ready
      const p3 = advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        orchestratorReviewPassed: true,
      });
      expect(p3.state).toBe('shadow_ready');
      // MUST reset — checkpoint was rejected, this is a fresh shadow entry
      expect(p3.shadowStartedAt).toBeDefined();
      expect(p3.shadowStartedAt).not.toBe(originalShadowStartedAt);
    });
  });

  // -------------------------------------------------------------------------
  // getPromotionState
  // -------------------------------------------------------------------------

  describe('getPromotionState', () => {
    it('should return null for unknown checkpoint', () => {
      const state = getPromotionState(stateDir, 'nonexistent');
      expect(state).toBeNull();
    });

    it('should return current state for known checkpoint', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.08, // Below minDelta * 2 (0.1), so stays candidate_only
        verdict: 'pass',
      });

      advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      const state = getPromotionState(stateDir, checkpointId);
      expect(state).toBe('candidate_only');
    });
  });

  // -------------------------------------------------------------------------
  // getPromotionRecord
  // -------------------------------------------------------------------------

  describe('getPromotionRecord', () => {
    it('should return null for unknown checkpoint', () => {
      const record = getPromotionRecord(stateDir, 'nonexistent');
      expect(record).toBeNull();
    });

    it('should return full record for known checkpoint', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.08,
        verdict: 'pass',
      });

      advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        reviewNote: 'Initial review',
      });

      const record = getPromotionRecord(stateDir, checkpointId);
      expect(record).not.toBeNull();
      expect(record!.checkpointId).toBe(checkpointId);
      expect(record!.state).toBe('candidate_only');
      expect(record!.reviewNote).toBe('Initial review');
    });
  });

  // -------------------------------------------------------------------------
  // listPromotionsByState
  // -------------------------------------------------------------------------

  describe('listPromotionsByState', () => {
    it('should return empty array when no promotions in state', () => {
      const promotions = listPromotionsByState(stateDir, 'shadow_ready');
      expect(promotions).toHaveLength(0);
    });

    it('should return promotions in specified state', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.08,
        verdict: 'pass',
      });

      advancePromotion(stateDir, {
        checkpointId,
        targetProfile: 'local-reader',
        baselineMetrics: DEFAULT_BASELINE_METRICS,
      });

      const candidates = listPromotionsByState(stateDir, 'candidate_only');
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].state).toBe('candidate_only');
    });
  });

  // -------------------------------------------------------------------------
  // rejectCheckpoint
  // -------------------------------------------------------------------------

  describe('rejectCheckpoint', () => {
    it('should create rejected promotion record', () => {
      const { checkpointId } = createCheckpointWithEval({
        delta: 0.1,
        verdict: 'pass',
      });

      const promotion = rejectCheckpoint(
        stateDir,
        checkpointId,
        'Orchestrator review rejected this checkpoint'
      );

      expect(promotion.state).toBe('rejected');
      expect(promotion.reviewNote).toBe('Orchestrator review rejected this checkpoint');
    });
  });
});
