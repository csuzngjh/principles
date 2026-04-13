import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { NocturnalTrajectoryExtractor } from '../../src/core/nocturnal-trajectory-extractor.js';
import { detectViolation } from '../../src/core/nocturnal-compliance.js';

function safeRmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────
// Phase 4a: Correction rejected → pain event → nocturnal selection
// ─────────────────────────────────────────────────────────
describe('Phase 4a: Correction rejected integration', () => {
  let workspaceDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-correction-'));
    trajectory = new TrajectoryDatabase({ workspaceDir });
  });

  afterEach(() => {
    trajectory?.dispose();
    safeRmDir(workspaceDir);
  });

  it('rejected correction creates a pain event with source=correction_rejected', () => {
    // 1. Create session + correction sample
    trajectory.recordSession({ sessionId: 'corr-session', startedAt: new Date().toISOString() });
    const atId = trajectory.recordAssistantTurn({
      sessionId: 'corr-session', runId: 'run-1', provider: 'local', model: 'main',
      rawText: 'Here is my code', sanitizedText: 'Here is my code', usageJson: {}, empathySignalJson: {},
      createdAt: new Date().toISOString(),
    });
    trajectory.recordUserTurn({
      sessionId: 'corr-session', turnIndex: 1, rawText: 'This is wrong!',
      correctionDetected: true, correctionCue: '错了',
      referencesAssistantTurnId: atId, createdAt: new Date().toISOString(),
    });

    // Verify sample was created
    const samples = trajectory.listCorrectionSamples('pending');
    expect(samples.length).toBe(1);

    // 2. Reject the sample
    trajectory.reviewCorrectionSample(samples[0].sampleId, 'rejected', 'Bad approach');

    // 3. Verify pain event was created
    const painEvents = trajectory.listPainEventsForSession('corr-session');
    const correctionPain = painEvents.find(e => e.source === 'correction_rejected');
    expect(correctionPain).toBeDefined();
    expect(correctionPain!.score).toBeGreaterThanOrEqual(0);
    expect(correctionPain!.score).toBeLessThanOrEqual(100);
  });

  it('approved correction does NOT create a pain event', () => {
    trajectory.recordSession({ sessionId: 'approved-session', startedAt: new Date().toISOString() });
    const atId = trajectory.recordAssistantTurn({
      sessionId: 'approved-session', runId: 'run-2', provider: 'local', model: 'main',
      rawText: 'Good code', sanitizedText: 'Good code', usageJson: {}, empathySignalJson: {},
      createdAt: new Date().toISOString(),
    });
    trajectory.recordUserTurn({
      sessionId: 'approved-session', turnIndex: 1, rawText: 'Looks better',
      correctionDetected: true, correctionCue: '改进',
      referencesAssistantTurnId: atId, createdAt: new Date().toISOString(),
    });

    const samples = trajectory.listCorrectionSamples('pending');
    expect(samples.length).toBe(1);

    trajectory.reviewCorrectionSample(samples[0].sampleId, 'approved', 'Good');

    const painEvents = trajectory.listPainEventsForSession('approved-session');
    const correctionPain = painEvents.find(e => e.source === 'correction_rejected');
    expect(correctionPain).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────
// Phase 4b: Gate block + pain multi-signal test
// ─────────────────────────────────────────────────────────
describe('Phase 4b: Multi-signal session selection', () => {
  let workspaceDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-multisignal-'));
    trajectory = new TrajectoryDatabase({ workspaceDir });
  });

  afterEach(() => {
    trajectory?.dispose();
    safeRmDir(workspaceDir);
  });

  it('session with more failures has higher violation density', () => {
    // Create session A: just 1 failure
    trajectory.recordSession({ sessionId: 'session-a-pain-only', startedAt: new Date().toISOString() });
    const atIdA = trajectory.recordAssistantTurn({
      sessionId: 'session-a-pain-only', runId: 'run-a', provider: 'local', model: 'main',
      rawText: 'Code here', sanitizedText: 'Code here', usageJson: {}, empathySignalJson: {},
      createdAt: new Date().toISOString(),
    });
    trajectory.recordUserTurn({
      sessionId: 'session-a-pain-only', turnIndex: 1, rawText: '错了',
      correctionDetected: true, correctionCue: '错了',
      referencesAssistantTurnId: atIdA, createdAt: new Date().toISOString(),
    });
    trajectory.recordToolCall({
      sessionId: 'session-a-pain-only', toolName: 'write', outcome: 'failure',
      errorMessage: 'Write failed', errorType: 'Error', createdAt: new Date().toISOString(),
    });

    // Create session B: 2 failures
    trajectory.recordSession({ sessionId: 'session-b-multi', startedAt: new Date().toISOString() });
    const atIdB = trajectory.recordAssistantTurn({
      sessionId: 'session-b-multi', runId: 'run-b', provider: 'local', model: 'main',
      rawText: 'Code here', sanitizedText: 'Code here', usageJson: {}, empathySignalJson: {},
      createdAt: new Date().toISOString(),
    });
    trajectory.recordUserTurn({
      sessionId: 'session-b-multi', turnIndex: 1, rawText: '太复杂了',
      correctionDetected: true, correctionCue: '太复杂了',
      referencesAssistantTurnId: atIdB, createdAt: new Date().toISOString(),
    });
    trajectory.recordToolCall({
      sessionId: 'session-b-multi', toolName: 'edit', outcome: 'failure',
      errorMessage: 'Edit failed', errorType: 'Error', createdAt: new Date().toISOString(),
    });
    trajectory.recordToolCall({
      sessionId: 'session-b-multi', toolName: 'write', outcome: 'failure',
      errorMessage: 'Write failed too', errorType: 'Error', createdAt: new Date().toISOString(),
    });

    // Verify session B has more failure signals
    const extractor = new NocturnalTrajectoryExtractor(trajectory);
    const snapshotA = extractor.getNocturnalSessionSnapshot('session-a-pain-only');
    const snapshotB = extractor.getNocturnalSessionSnapshot('session-b-multi');

    expect(snapshotA).not.toBeNull();
    expect(snapshotB).not.toBeNull();

    // Session B should have more violation signals
    const densityA = (snapshotA!.stats.failureCount ?? 0) + (snapshotA!.stats.totalPainEvents ?? 0) * 0.5;
    const densityB = (snapshotB!.stats.failureCount ?? 0) + (snapshotB!.stats.totalPainEvents ?? 0) * 0.5;
    expect(densityB).toBeGreaterThan(densityA);
  });
});

// ─────────────────────────────────────────────────────────
// Phase 4c: Boundary value test matrix
// ─────────────────────────────────────────────────────────
describe('Phase 4c: Boundary value tests', () => {
  let workspaceDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-boundary-'));
    trajectory = new TrajectoryDatabase({ workspaceDir });
  });

  afterEach(() => {
    trajectory?.dispose();
    safeRmDir(workspaceDir);
  });

  it('session with correction cue is listed as candidate', () => {
    trajectory.recordSession({ sessionId: 'single-pain', startedAt: new Date().toISOString() });
    const atIdC = trajectory.recordAssistantTurn({
      sessionId: 'single-pain', runId: 'run-c', provider: 'local', model: 'main',
      rawText: 'Agent response', sanitizedText: 'Agent response', usageJson: {}, empathySignalJson: {},
      createdAt: new Date().toISOString(),
    });
    trajectory.recordUserTurn({
      sessionId: 'single-pain', turnIndex: 1, rawText: '错了',
      correctionDetected: true, correctionCue: '错了',
      referencesAssistantTurnId: atIdC, createdAt: new Date().toISOString(),
    });

    const extractor = new NocturnalTrajectoryExtractor(trajectory);
    const candidates = extractor.listRecentNocturnalCandidateSessions({ limit: 10, minToolCalls: 0 });

    const painCandidate = candidates.find(c => c.sessionId === 'single-pain');
    expect(painCandidate).toBeDefined();
  });

  it('detectViolation returns violated for P_* principles with tool failure', () => {
    trajectory.recordSession({ sessionId: 'violation-session', startedAt: new Date().toISOString() });
    trajectory.recordAssistantTurn({
      sessionId: 'violation-session', runId: 'run-d', provider: 'local', model: 'main',
      rawText: 'Code', sanitizedText: 'Code', usageJson: {}, empathySignalJson: {},
      createdAt: new Date().toISOString(),
    });
    trajectory.recordToolCall({
      sessionId: 'violation-session', toolName: 'write', outcome: 'failure',
      errorMessage: 'Failed', errorType: 'Error', createdAt: new Date().toISOString(),
    });

    const extractor = new NocturnalTrajectoryExtractor(trajectory);
    const snapshot = extractor.getNocturnalSessionSnapshot('violation-session');
    expect(snapshot).not.toBeNull();

    // P_* principles should be violated with any failure
    const violation = detectViolation('P_001', {
      sessionId: 'violation-session',
      toolCalls: snapshot!.toolCalls.map(tc => ({
        toolName: tc.toolName, outcome: tc.outcome as 'success' | 'failure' | 'blocked',
        errorMessage: tc.errorMessage ?? undefined,
      })),
      painSignals: snapshot!.painEvents.map(pe => ({
        source: pe.source, score: pe.score, severity: pe.severity as 'mild' | 'moderate' | 'severe' | undefined,
      })),
      gateBlocks: [],
      userCorrections: [],
      planApprovals: [],
    });

    expect(violation.violated).toBe(true);
  });
});
