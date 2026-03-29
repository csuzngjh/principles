import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  executeNocturnalReflection,
  executeNocturnalReflectionAsync,
  listApprovedNocturnalArtifacts,
} from '../../src/service/nocturnal-service.js';
import { createNocturnalTrajectoryExtractor } from '../../src/core/nocturnal-trajectory-extractor.js';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import {
  checkWorkspaceIdle,
  clearAllCooldowns,
  recordRunStart,
  recordRunEnd,
} from '../../src/service/nocturnal-runtime.js';
import { NocturnalPathResolver } from '../../src/core/nocturnal-paths.js';
import { seedSessionForTest, clearSession, listSessions } from '../../src/core/session-tracker.js';

/**
 * NocturnalService Integration Tests
 *
 * NOTE: These tests have complex setup due to:
 * 1. TrajectoryRegistry singleton - must use same instance as service
 * 2. Async cleanup on Windows - wrapped in try-catch
 * 3. Fire-and-forget cooldowns - use awaitClearAllCooldowns helper
 */
describe('NocturnalService', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    // Create a clean temp directory structure:
    // tmpDir/
    //   workspace/     ← workspaceDir
    //   state/         ← stateDir
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-service-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Initialize trajectory DB and prime the TrajectoryRegistry singleton.
    // The service uses createNocturnalTrajectoryExtractor which internally
    // calls TrajectoryRegistry.get(workspaceDir). We call it here so that
    // the service sees the SAME instance we seed with test data.
    trajectory = new TrajectoryDatabase({ workspaceDir });

    // Prime the singleton so the service gets our seeded instance
    const extractor = createNocturnalTrajectoryExtractor(workspaceDir);
    // extractor holds the same TrajectoryDatabase instance via singleton

    // Also clear any residual SessionTracker sessions from previous tests
    // (SessionTracker uses an in-memory Map that persists across tests)
    for (const session of listSessions()) {
      clearSession(session.sessionId);
    }
  });

  afterEach(() => {
    // Dispose in correct order: trajectory first, then registry.
    // On Windows, file handles may not be released immediately, so wrap in try-catch.
    try {
      trajectory.dispose();
    } catch {
      // Best effort
    }
    try {
      TrajectoryRegistry.dispose(workspaceDir);
    } catch {
      // Best effort
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // On Windows, some file handles may still be open
    }
  });

  // -------------------------------------------------------------------------
  // Helper: awaitable clear cooldowns (sync version writes directly)
  // -------------------------------------------------------------------------

  function clearCooldownsSync(): void {
    // Write empty cooldown state directly without async
    const runtimePath = path.join(stateDir, 'nocturnal-runtime.json');
    const defaultState = {
      principleCooldowns: {},
      recentRunTimestamps: [],
    };
    fs.writeFileSync(runtimePath, JSON.stringify(defaultState, null, 2), 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Helper: create a properly idle override (bypasses real idle check)
  // -------------------------------------------------------------------------

  function makeIdleResult(): ReturnType<typeof checkWorkspaceIdle> {
    return {
      isIdle: true,
      mostRecentActivityAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      idleForMs: 2 * 60 * 60 * 1000,
      activeSessionCount: 0,
      abandonedSessionIds: [],
      trajectoryGuardrailConfirmsIdle: true,
      reason: 'test override — workspace considered idle',
    };
  }

  // -------------------------------------------------------------------------
  // Helper: seed a minimal trajectory
  // -------------------------------------------------------------------------

  function seedSession(
    sessionId: string,
    startedAt: string,
    opts: {
      withToolCalls?: number;
      withPain?: boolean;
      withGateBlock?: boolean;
      outcome?: 'success' | 'failure';
    } = {}
  ): void {
    trajectory.recordSession({ sessionId, startedAt });
    const { withToolCalls = 1, withPain = false, withGateBlock = false, outcome = 'failure' } = opts;

    for (let i = 0; i < withToolCalls; i++) {
      trajectory.recordToolCall({
        sessionId,
        toolName: 'Bash',
        outcome,
        errorMessage: outcome === 'failure' ? 'Command failed: exit code 1' : null,
      });
    }

    if (withPain) {
      trajectory.recordPainEvent({
        sessionId,
        source: 'test',
        score: 50,
        reason: 'Test pain event',
      });
    }

    if (withGateBlock) {
      trajectory.recordGateBlock({
        sessionId,
        toolName: 'Edit',
        reason: 'Safety check: RISK_PATH modification requires PLAN.md',
        riskLevel: 'medium',
      });
    }

    // Also seed SessionTracker.sessions so checkWorkspaceIdle can see the session
    // (SessionTracker is separate from TrajectoryDatabase)
    const lastActivityAt = new Date(startedAt).getTime();
    seedSessionForTest(sessionId, workspaceDir, lastActivityAt);
  }

  // -------------------------------------------------------------------------
  // Helper: seed evaluable principles (T-08 for most tests)
  // -------------------------------------------------------------------------

  function seedPrinciples(): void {
    const trainingStatesPath = path.join(stateDir, 'principle_training_state.json');
    // T-01 has low compliance so T-08 wins selection (higher compliance = lower score priority)
    const data = {
      'T-01': {
        principleId: 'T-01',
        principleName: 'Map Before Territory',
        evaluability: 'deterministic',
        complianceRate: 0.3,
        violationTrend: 1,
        observedViolationCount: 3,
        applicableOpportunityCount: 10,
        generatedSampleCount: 1,
        cooldownUntil: null,
        internalizationStatus: 'internalized',
      },
      'T-08': {
        principleId: 'T-08',
        principleName: 'Pain as Signal',
        evaluability: 'deterministic',
        complianceRate: 0.8,
        violationTrend: 1,
        observedViolationCount: 5,
        applicableOpportunityCount: 8,
        generatedSampleCount: 0,
        cooldownUntil: null,
        internalizationStatus: 'internalized',
      },
    };
    fs.writeFileSync(trainingStatesPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Helper: force workspace to be "idle"
  // -------------------------------------------------------------------------

  function forceIdleWorkspace(): void {
    // Workspace is idle when there are no recent sessions or sessions are old
    // A session from 2+ hours ago will be considered abandoned
    const oldSessionId = 'session-old-abandoned';
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000).toISOString();
    seedSession(oldSessionId, twoHoursAgo, { withToolCalls: 0 });
  }

  // -------------------------------------------------------------------------
  // Tests: executeNocturnalReflection — successful run
  // -------------------------------------------------------------------------

  describe('executeNocturnalReflection — successful run', () => {
    it('produces an approved artifact when all conditions are met', () => {
      // Setup: idle workspace + evaluable principles + clear cooldowns + violating session
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      const recentSessionId = 'session-recent-violation';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, { idleCheckOverride: idleResult });

      expect(result.success).toBe(true);
      expect(result.artifact).toBeDefined();
      expect(result.artifact?.principleId).toBe('T-08');
      expect(result.artifact?.sessionId).toBe(recentSessionId);
      expect(result.artifact?.badDecision).toBeTruthy();
      expect(result.artifact?.betterDecision).toBeTruthy();
      expect(result.artifact?.rationale).toBeTruthy();
      expect(result.diagnostics.persisted).toBe(true);
      expect(result.diagnostics.persistedPath).toBeDefined();
    });

    it('persists artifact to the samples directory', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      const recentSessionId = 'session-recent-2';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 2, withPain: true, outcome: 'failure' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, { idleCheckOverride: idleResult });
      expect(result.success).toBe(true);
      expect(result.diagnostics.persistedPath).toBeDefined();

      // Verify file exists
      const persistedPath = result.diagnostics.persistedPath!;
      expect(fs.existsSync(persistedPath)).toBe(true);

      // Verify content
      const content = JSON.parse(fs.readFileSync(persistedPath, 'utf-8'));
      expect(content.status).toBe('approved');
      expect(content.artifactId).toBe(result.artifact?.artifactId);
      expect(content.boundedAction).toBeDefined();
    });

    it('returns a boundedAction in the artifact', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      const recentSessionId = 'session-recent-3';
      const now = new Date().toISOString();
      // Seed with pain=true so T-08 is violated (pain+failure needed for T-08)
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, { idleCheckOverride: idleResult });
      expect(result.success).toBe(true);
      expect(result.artifact?.boundedAction).toBeDefined();
      expect(result.artifact?.boundedAction?.verb).toBeTruthy();
      expect(result.artifact?.boundedAction?.target).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Tests: executeNocturnalReflection — skip conditions
  // -------------------------------------------------------------------------

  describe('executeNocturnalReflection — skip conditions', () => {
    it('skips when workspace is not idle', () => {
      // Setup: NO forceIdleWorkspace - workspace has a very recent session
      seedPrinciples();
      clearCooldownsSync();

      // Create a session that started JUST NOW (non-idle)
      const activeSessionId = 'session-active';
      const justNow = new Date().toISOString();
      seedSession(activeSessionId, justNow, { withToolCalls: 1 });

      const result = executeNocturnalReflection(workspaceDir, stateDir);

      // Workspace is NOT idle, so preflight should block
      expect(result.success).toBe(false);
      expect(result.noTargetSelected).toBe(false); // preflight blocked
    });

    it('skips when no evaluable principles exist', () => {
      forceIdleWorkspace();
      clearCooldownsSync();
      // Don't seed any principles

      const recentSessionId = 'session-recent';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, { idleCheckOverride: idleResult });
      expect(result.success).toBe(false);
      expect(result.noTargetSelected).toBe(true);
      expect(result.skipReason).toBe('no_evaluable_principles');
    });

    it('skips when no violating sessions found (only successful sessions)', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      // Only successful sessions (no violations)
      const sessionId = 'session-success-only';
      const now = new Date().toISOString();
      seedSession(sessionId, now, { withToolCalls: 3, outcome: 'success' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, { idleCheckOverride: idleResult });
      expect(result.success).toBe(false);
      expect(result.noTargetSelected).toBe(true);
      expect(result.skipReason).toBe('no_violating_sessions');
    });

    it('returns failure when snapshot extraction fails', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      // Create a session with no tool calls - will fail snapshot extraction
      const sessionId = 'session-no-toolcalls';
      const now = new Date().toISOString();
      seedSession(sessionId, now, { withToolCalls: 0, withPain: false, outcome: 'success' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, { idleCheckOverride: idleResult });
      // Session has no tool calls, so minToolCalls=1 filter removes it
      // No sessions available → selection skips with insufficient_snapshot_data
      expect(result.success).toBe(false);
      expect(result.noTargetSelected).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: executeNocturnalReflection — reflector override
  // -------------------------------------------------------------------------

  describe('executeNocturnalReflection — reflector override', () => {
    it('uses reflectorOutputOverride when skipReflector is true', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      const recentSessionId = 'session-override-test';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const overrideArtifact = {
        artifactId: '11111111-2222-4333-aaaa-bbbbbbbbbbbb',
        sessionId: recentSessionId,
        principleId: 'T-08',
        sourceSnapshotRef: 'snapshot-override',
        badDecision: 'Overridden bad decision',
        betterDecision: 'Read the error message before retrying the bash command',
        rationale: 'Overridden rationale for testing purposes',
        createdAt: new Date().toISOString(),
      };

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, {
        skipReflector: true,
        reflectorOutputOverride: JSON.stringify(overrideArtifact),
        idleCheckOverride: idleResult,
      });

      expect(result.success).toBe(true);
      expect(result.artifact?.artifactId).toBe('11111111-2222-4333-aaaa-bbbbbbbbbbbb');
      expect(result.artifact?.badDecision).toBe('Overridden bad decision');
    });

    it('fails if skipReflector is true but no override provided', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      // Seed a session so selector finds a target, then validation fails because no override
      const recentSessionId = 'session-no-override';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, {
        skipReflector: true,
        idleCheckOverride: idleResult,
        // no reflectorOutputOverride
      });

      expect(result.success).toBe(false);
      expect(result.validationFailed).toBe(true);
      expect(result.validationFailures.some(f => f.includes('reflectorOutputOverride'))).toBe(true);
    });

    it('rejects invalid JSON in reflectorOutputOverride', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      const recentSessionId = 'session-bad-override';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, {
        skipReflector: true,
        reflectorOutputOverride: 'not valid json',
        idleCheckOverride: idleResult,
      });

      expect(result.success).toBe(false);
      expect(result.validationFailed).toBe(true);
      expect(result.validationFailures.some(f => f.includes('parse'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: executeNocturnalReflection — arbiter/executability rejection
  // -------------------------------------------------------------------------

  describe('executeNocturnalReflection — validation rejection', () => {
    it('rejects artifact with vague verb in betterDecision', () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      const recentSessionId = 'session-vague';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const overrideArtifact = {
        artifactId: '22222222-3333-4444-aaaa-cccccccccccc',
        sessionId: recentSessionId,
        principleId: 'T-08',
        sourceSnapshotRef: 'snapshot-vague',
        badDecision: 'Made a bad decision',
        betterDecision: 'Understand the error first',
        rationale: 'Testing executability rejection for vague verbs',
        createdAt: new Date().toISOString(),
      };

      const idleResult = makeIdleResult();
      const result = executeNocturnalReflection(workspaceDir, stateDir, {
        skipReflector: true,
        reflectorOutputOverride: JSON.stringify(overrideArtifact),
        idleCheckOverride: idleResult,
      });

      expect(result.success).toBe(false);
      expect(result.validationFailed).toBe(true);
      expect(result.validationFailures.some(f => f.includes('vague verb'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: listApprovedNocturnalArtifacts
  // -------------------------------------------------------------------------

  describe('listApprovedNocturnalArtifacts', () => {
    it('returns empty array when no artifacts exist', () => {
      const artifacts = listApprovedNocturnalArtifacts(workspaceDir);
      expect(artifacts).toHaveLength(0);
    });

    it('returns approved artifacts sorted by createdAt descending', () => {
      // Create some sample artifacts
      const samples = [
        {
          artifactId: 'older-artifact',
          sessionId: 'session-1',
          principleId: 'T-08',
          sourceSnapshotRef: 'snap-1',
          badDecision: 'Bad decision 1',
          betterDecision: 'Better decision 1',
          rationale: 'Rationale 1',
          createdAt: '2026-03-27T10:00:00.000Z',
          persistedAt: '2026-03-27T10:00:00.000Z',
          status: 'approved',
        },
        {
          artifactId: 'newer-artifact',
          sessionId: 'session-2',
          principleId: 'T-08',
          sourceSnapshotRef: 'snap-2',
          badDecision: 'Bad decision 2',
          betterDecision: 'Better decision 2',
          rationale: 'Rationale 2',
          createdAt: '2026-03-27T12:00:00.000Z',
          persistedAt: '2026-03-27T12:00:00.000Z',
          status: 'approved',
        },
        {
          artifactId: 'rejected-artifact',
          sessionId: 'session-3',
          principleId: 'T-08',
          sourceSnapshotRef: 'snap-3',
          badDecision: 'Bad decision 3',
          betterDecision: 'Better decision 3',
          rationale: 'Rationale 3',
          createdAt: '2026-03-27T14:00:00.000Z',
          persistedAt: '2026-03-27T14:00:00.000Z',
          status: 'rejected', // Should be filtered out
        },
      ];

      for (const sample of samples) {
        const samplePath = NocturnalPathResolver.samplePath(workspaceDir, sample.artifactId);
        const sampleDir = path.dirname(samplePath);
        if (!fs.existsSync(sampleDir)) {
          fs.mkdirSync(sampleDir, { recursive: true });
        }
        fs.writeFileSync(samplePath, JSON.stringify(sample), 'utf-8');
      }

      const artifacts = listApprovedNocturnalArtifacts(workspaceDir);
      expect(artifacts).toHaveLength(2);
      // Should be sorted by createdAt descending (newer first)
      expect(artifacts[0].artifactId).toBe('newer-artifact');
      expect(artifacts[1].artifactId).toBe('older-artifact');
    });

    it('skips malformed JSON files', () => {
      const samplePath = NocturnalPathResolver.samplePath(workspaceDir, 'malformed');
      const sampleDir = path.dirname(samplePath);
      if (!fs.existsSync(sampleDir)) {
        fs.mkdirSync(sampleDir, { recursive: true });
      }
      fs.writeFileSync(samplePath, 'not valid json {{{', 'utf-8');

      const artifacts = listApprovedNocturnalArtifacts(workspaceDir);
      expect(artifacts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: executeNocturnalReflectionAsync
  // -------------------------------------------------------------------------

  describe('executeNocturnalReflectionAsync', () => {
    it('returns a Promise that resolves to the same result as sync version', async () => {
      forceIdleWorkspace();
      seedPrinciples();
      clearCooldownsSync();

      const recentSessionId = 'session-async-test';
      const now = new Date().toISOString();
      seedSession(recentSessionId, now, { withToolCalls: 3, withPain: true, outcome: 'failure' });

      const idleResult = makeIdleResult();
      const result = await executeNocturnalReflectionAsync(workspaceDir, stateDir, { idleCheckOverride: idleResult });
      expect(result.success).toBe(true);
      expect(result.artifact).toBeDefined();
    });
  });
});
