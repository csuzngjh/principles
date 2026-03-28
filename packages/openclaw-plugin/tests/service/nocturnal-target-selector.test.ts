import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NocturnalTargetSelector,
  selectNocturnalTarget,
  type NocturnalSelectionResult,
  type SkipReason,
} from '../../src/service/nocturnal-target-selector.js';
import { NocturnalTrajectoryExtractor } from '../../src/core/nocturnal-trajectory-extractor.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import {
  saveStore,
  createDefaultPrincipleState,
  PRINCIPLE_TRAINING_FILE,
} from '../../src/core/principle-training-state.js';
import {
  initPersistence,
  trackToolRead,
  clearSession,
  getSession,
} from '../../src/core/session-tracker.js';
import { safeRmDir } from '../test-utils.js';
import {
  NOCTURNAL_RUNTIME_FILE,
  DEFAULT_IDLE_THRESHOLD_MS,
} from '../../src/service/nocturnal-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedSession(
  trajectory: TrajectoryDatabase,
  sessionId: string,
  startedAt?: string
): void {
  trajectory.recordSession({ sessionId, startedAt: startedAt ?? new Date().toISOString() });
}

function seedAssistantTurn(
  trajectory: TrajectoryDatabase,
  sessionId: string,
  sanitizedText: string,
  rawText: string
): void {
  trajectory.recordAssistantTurn({
    sessionId,
    runId: 'run-1',
    provider: 'openai',
    model: 'gpt-4',
    rawText,
    sanitizedText,
    usageJson: {},
    empathySignalJson: {},
  });
}

function seedToolCall(
  trajectory: TrajectoryDatabase,
  sessionId: string,
  toolName: string,
  outcome: 'success' | 'failure' | 'blocked',
  errorMessage?: string,
  filePath?: string
): void {
  trajectory.recordToolCall({
    sessionId,
    toolName,
    outcome,
    errorMessage: errorMessage ?? null,
    paramsJson: filePath ? { filePath } : undefined,
  });
}

function seedPainEvent(
  trajectory: TrajectoryDatabase,
  sessionId: string,
  score: number,
  source: string
): void {
  trajectory.recordPainEvent({ sessionId, source, score });
}

function seedGateBlock(
  trajectory: TrajectoryDatabase,
  sessionId: string,
  toolName: string,
  reason: string
): void {
  trajectory.recordGateBlock({ sessionId, toolName, reason });
}

function seedTrainingState(
  stateDir: string,
  principleId: string,
  overrides: Partial<ReturnType<typeof createDefaultPrincipleState>> = {}
): void {
  const store = { [principleId]: { ...createDefaultPrincipleState(principleId), ...overrides } };
  saveStore(stateDir, store);
}

function setRuntimeCooldown(
  stateDir: string,
  cooldownUntil: string
): void {
  const runtimePath = path.join(stateDir, NOCTURNAL_RUNTIME_FILE);
  fs.mkdirSync(stateDir, { recursive: true });
  // Set per-principle cooldown only (not global cooldown)
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({ principleCooldowns: { 'T-01': cooldownUntil }, recentRunTimestamps: [] }),
    'utf-8'
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NocturnalTargetSelector', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;
  let extractor: NocturnalTrajectoryExtractor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-target-sel-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(workspaceDir);
    fs.mkdirSync(stateDir, { recursive: true });

    // Initialize session tracker persistence
    initPersistence(stateDir);

    // Create trajectory and extractor
    trajectory = new TrajectoryDatabase({ workspaceDir });
    extractor = new NocturnalTrajectoryExtractor(trajectory);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    trajectory.dispose();
    clearSession('session-violating');
    clearSession('session-clean');
    clearSession('session-active-workspace-idle');
    safeRmDir(tempDir);
  });

  // -------------------------------------------------------------------------
  // Idle check integration
  // -------------------------------------------------------------------------

  describe('workspace idle check', () => {
    it('returns skip with workspace_not_idle when session is active', () => {
      // Create a recently active session
      trackToolRead('session-active', 'src/main.ts', workspaceDir);

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('workspace_not_idle');
      expect(result.diagnostics.idleCheckPassed).toBe(false);
    });

    it('passes idle check when no sessions exist', () => {
      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      // Will fail on cooldown or no_evaluable_principles next, not idle
      expect(result.diagnostics.idleCheckPassed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Evaluable principles filtering
  // -------------------------------------------------------------------------

  describe('evaluable principles filtering', () => {
    it('returns no_evaluable_principles when no training state exists', () => {
      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('no_evaluable_principles');
      expect(result.diagnostics.totalEvaluablePrinciples).toBe(0);
    });

    it('excludes manual_only principles from selection', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'manual_only',
        internalizationStatus: 'prompt_only',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('no_evaluable_principles');
      expect(result.diagnostics.totalEvaluablePrinciples).toBe(0);
    });

    it('includes deterministic evaluability principles', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      seedSession(trajectory, 'session-violating');
      seedToolCall(trajectory, 'session-violating', 'edit_file', 'success');
      seedToolCall(trajectory, 'session-violating', 'bash', 'failure', 'error');

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip'); // Will fail on no_violating_sessions (T-01 not violated)
      expect(result.diagnostics.totalEvaluablePrinciples).toBe(1);
      expect(result.diagnostics.passedPrinciples).toContain('T-01');
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown filtering
  // -------------------------------------------------------------------------

  describe('cooldown filtering', () => {
    it('returns all_targets_in_cooldown when all candidates are in cooldown', () => {
      // Set cooldown for T-01
      const cooldownUntil = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      setRuntimeCooldown(stateDir, cooldownUntil);

      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('all_targets_in_cooldown');
      expect(result.diagnostics.filteredByCooldown).toBe(1);
    });

    it('penalizes cooldown principles in scoring', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });
      seedTrainingState(stateDir, 'T-02', {
        evaluability: 'weak_heuristic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      // Set cooldown only for T-01
      const cooldownUntil = new Date(Date.now() + 3600000).toISOString();
      setRuntimeCooldown(stateDir, cooldownUntil);

      seedSession(trajectory, 'session-violating');
      seedToolCall(trajectory, 'session-violating', 'read_file', 'success');

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      // T-01 is in cooldown, T-02 should be selected
      expect(result.diagnostics.passedPrinciples).not.toContain('T-01');
      expect(result.diagnostics.passedPrinciples).toContain('T-02');
    });
  });

  // -------------------------------------------------------------------------
  // No violating sessions
  // -------------------------------------------------------------------------

  describe('no violating sessions', () => {
    it('returns no_violating_sessions when sessions exist but no violations for T-01', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      seedSession(trajectory, 'session-clean');
      seedToolCall(trajectory, 'session-clean', 'read_file', 'success');
      seedToolCall(trajectory, 'session-clean', 'read_file', 'success');

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('no_violating_sessions');
      expect(result.diagnostics.violatingSessionCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Successful selection
  // -------------------------------------------------------------------------

  describe('successful selection', () => {
    it('selects principle with violating session when conditions are met', () => {
      // Use T-08 (Pain as Signal) which triggers when pain + failure followed by immediate continuation
      seedTrainingState(stateDir, 'T-08', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      // T-08 violation: pain + failure, then immediate continued operation without read/reflect
      // Sequence: grep (success) → bash (failure) → edit (continues without reflect)
      seedSession(trajectory, 'session-violating');
      seedToolCall(trajectory, 'session-violating', 'grep', 'success');
      seedToolCall(trajectory, 'session-violating', 'bash', 'failure', 'command failed');
      seedToolCall(trajectory, 'session-violating', 'edit_file', 'success'); // continues immediately (not read)
      seedPainEvent(trajectory, 'session-violating', 50, 'tool_failure');

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('selected');
      expect(result.selectedPrincipleId).toBe('T-08');
      expect(result.selectedSessionId).toBe('session-violating');
      expect(result.diagnostics.idleCheckPassed).toBe(true);
    });

    it('records scoring breakdown in diagnostics', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
        generatedSampleCount: 0,
        violationTrend: 1,
      });

      seedSession(trajectory, 'session-violating');
      seedToolCall(trajectory, 'session-violating', 'edit_file', 'failure', 'error');

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.diagnostics.scoringBreakdown).toHaveProperty('T-01');
      expect(typeof result.diagnostics.scoringBreakdown['T-01']).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Quota and global cooldown
  // -------------------------------------------------------------------------

  describe('quota and global cooldown', () => {
    it('returns quota_exhausted when max runs reached', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      // Set quota to exhausted by having many recent run timestamps
      const runtimePath = path.join(stateDir, NOCTURNAL_RUNTIME_FILE);
      fs.mkdirSync(stateDir, { recursive: true });
      const now = new Date().toISOString();
      const recentTimestamps = Array(10).fill(now); // 10 runs, exceeding DEFAULT_MAX_RUNS_PER_WINDOW=3
      fs.writeFileSync(
        runtimePath,
        JSON.stringify({ principleCooldowns: {}, recentRunTimestamps: recentTimestamps }),
        'utf-8'
      );

      seedSession(trajectory, 'session-violating');
      seedToolCall(trajectory, 'session-violating', 'bash', 'failure', 'error');

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('quota_exhausted');
      expect(result.diagnostics.quotaCheckPassed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Convenience function
  // -------------------------------------------------------------------------

  describe('selectNocturnalTarget convenience function', () => {
    it('works as a standalone function', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
      });

      seedSession(trajectory, 'session-violating');
      seedToolCall(trajectory, 'session-violating', 'edit_file', 'success');
      seedToolCall(trajectory, 'session-violating', 'bash', 'failure', 'error');

      const result = selectNocturnalTarget(workspaceDir, stateDir, extractor);

      expect(result.decision).toBe('skip'); // Will fail on no_violating_sessions
      expect(result.diagnostics.totalEvaluablePrinciples).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Skip reason taxonomy
  // -------------------------------------------------------------------------

  describe('skip reason taxonomy', () => {
    it('no_evaluable_principles — when no training state exists', () => {
      // No seed needed - no evaluable principles
      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('no_evaluable_principles');
    });

    it('workspace_not_idle — when session is active', () => {
      // Create a recently active session
      trackToolRead('session-active-workspace-idle', 'src/main.ts', workspaceDir);

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('workspace_not_idle');
    });

    it('quota_exhausted — when max runs per window reached', () => {
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
      });

      const runtimePath = path.join(stateDir, NOCTURNAL_RUNTIME_FILE);
      const now = new Date().toISOString();
      fs.writeFileSync(
        runtimePath,
        JSON.stringify({ principleCooldowns: {}, recentRunTimestamps: Array(10).fill(now) }),
        'utf-8'
      );

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('quota_exhausted');
    });

    it('all_targets_in_cooldown — when all candidates are in per-principle cooldown', () => {
      const cooldownUntil = new Date(Date.now() + 3600000).toISOString();
      setRuntimeCooldown(stateDir, cooldownUntil);
      seedTrainingState(stateDir, 'T-01', {
        evaluability: 'deterministic',
        internalizationStatus: 'needs_training',
      });

      const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor);
      const result = selector.select();

      expect(result.decision).toBe('skip');
      expect(result.skipReason).toBe('all_targets_in_cooldown');
    });
  });
});
