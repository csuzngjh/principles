import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

function safeRmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('Trajectory — correction_rejected pain event (Phase 2b)', () => {
  let workspaceDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-correction-pain-'));
    trajectory = new TrajectoryDatabase({ workspaceDir });
  });

  afterEach(() => {
    trajectory?.dispose();
    safeRmDir(workspaceDir);
  });

  it('emits a pain event when a correction sample is rejected', async () => {
    // Step 1: Create a session
    trajectory.recordSession({
      sessionId: 'test-session-001',
      startedAt: new Date().toISOString(),
    });

    // Step 2: Create an assistant turn (to be referenced)
    const assistantTurnId = trajectory.recordAssistantTurn({
      sessionId: 'test-session-001',
      turnIndex: 0,
      rawText: 'Here is some code I wrote',
      createdAt: new Date().toISOString(),
    });

    // Step 3: Create a user turn with correction_cue (triggers auto-creation)
    trajectory.recordUserTurn({
      sessionId: 'test-session-001',
      turnIndex: 1,
      rawText: 'This is wrong. Fix it properly.',
      correctionDetected: true,
      correctionCue: 'This is wrong. Fix it properly.',
      referencesAssistantTurnId: assistantTurnId,
      createdAt: new Date().toISOString(),
    });

    // Wait for async sample creation
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify sample was created as pending
    const pendingSamples = trajectory.listCorrectionSamples('pending');
    expect(pendingSamples.length).toBe(1);
    const sampleId = pendingSamples[0].sampleId;

    // Verify no pain events yet
    const painEventsBefore = trajectory.listPainEventsForSession('test-session-001');
    expect(painEventsBefore.length).toBe(0);

    // Step 4: Review as rejected
    trajectory.reviewCorrectionSample(sampleId, 'rejected', 'Does not match requirements');

    // Step 5: Verify pain event was created
    const painEventsAfter = trajectory.listPainEventsForSession('test-session-001');
    expect(painEventsAfter.length).toBe(1);

    const painEvent = painEventsAfter[0];
    expect(painEvent.source).toBe('correction_rejected');
    expect(painEvent.reason).toContain('Correction rejected');
    expect(painEvent.origin).toBe('system_infer');
  });

  it('does NOT emit a pain event when a correction sample is approved', async () => {
    // Setup: session + assistant turn + user correction turn
    trajectory.recordSession({
      sessionId: 'test-session-002',
      startedAt: new Date().toISOString(),
    });
    const assistantTurnId = trajectory.recordAssistantTurn({
      sessionId: 'test-session-002',
      turnIndex: 0,
      rawText: 'Here is some code',
      createdAt: new Date().toISOString(),
    });
    trajectory.recordUserTurn({
      sessionId: 'test-session-002',
      turnIndex: 1,
      rawText: 'This needs work',
      correctionDetected: true,
      correctionCue: 'This needs work',
      referencesAssistantTurnId: assistantTurnId,
      createdAt: new Date().toISOString(),
    });

    // Wait for async sample creation
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get pending sample
    const pendingSamples = trajectory.listCorrectionSamples('pending');
    expect(pendingSamples.length).toBe(1);
    const sampleId = pendingSamples[0].sampleId;

    // Review as approved - should NOT trigger pain event
    trajectory.reviewCorrectionSample(sampleId, 'approved', 'Looks good');

    // Verify NO pain event was created (approved != rejected)
    const painEvents = trajectory.listPainEventsForSession('test-session-002');
    expect(painEvents.length).toBe(0);
  });

  it('maps quality_score to pain_score correctly (0-100 range)', async () => {
    // Setup: with quality score components
    trajectory.recordSession({
      sessionId: 'test-session-003',
      startedAt: new Date().toISOString(),
    });
    const assistantTurnId = trajectory.recordAssistantTurn({
      sessionId: 'test-session-003',
      turnIndex: 0,
      rawText: 'Code here',
      createdAt: new Date().toISOString(),
    });

    // Create user turn with correction_cue (adds 20 points)
    trajectory.recordUserTurn({
      sessionId: 'test-session-003',
      turnIndex: 1,
      rawText: 'Wrong approach. Try a different algorithm.',
      correctionDetected: true,
      correctionCue: 'Wrong approach. Try a different algorithm.',
      referencesAssistantTurnId: assistantTurnId,
      createdAt: new Date().toISOString(),
    });

    // Add a failed tool call (adds 20 points)
    trajectory.recordToolCall({
      sessionId: 'test-session-003',
      turnIndex: 2,
      toolName: 'write',
      toolCallIndex: 0,
      paramsJson: { path: '/tmp/test.txt', content: 'test' },
      outcome: 'failure',
      errorMessage: 'Permission denied',
      errorType: 'PermissionError',
      createdAt: new Date().toISOString(),
    });

    // Add successful calls (adds 25 points)
    trajectory.recordToolCall({
      sessionId: 'test-session-003',
      turnIndex: 3,
      toolName: 'read',
      toolCallIndex: 1,
      paramsJson: { path: '/tmp/test.txt' },
      outcome: 'success',
      resultJson: { content: 'file content' },
      createdAt: new Date().toISOString(),
    });

    // Wait for async sample creation
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get pending sample (quality_score ~65: 20 + 20 + 25)
    const pendingSamples = trajectory.listCorrectionSamples('pending');
    expect(pendingSamples.length).toBe(1);
    const sampleId = pendingSamples[0].sampleId;

    // Review as rejected
    trajectory.reviewCorrectionSample(sampleId, 'rejected', 'Test rejection');

    // Verify pain score is clamped to 0-100
    const painEvents = trajectory.listPainEventsForSession('test-session-003');
    expect(painEvents.length).toBe(1);
    expect(painEvents[0].score).toBeGreaterThanOrEqual(0);
    expect(painEvents[0].score).toBeLessThanOrEqual(100);
  });
});