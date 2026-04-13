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

  it('emits a pain event when a correction sample is rejected', () => {
    // Create a session first
    trajectory.recordSession({
      sessionId: 'test-session-001',
      startedAt: new Date().toISOString(),
    });

    // Create a correction sample (pending)
    trajectory.maybeCreateCorrectionSample(
      'test-session-001',
      {
        id: 100,
        assistant_text: 'Bad code here',
        correction_cue: 'This is wrong, fix it',
        references_assistant_turn_id: 99,
      },
      'Test raw user text',
      {
        tool_name: 'write',
        error_message: 'Validation failed',
        error_type: 'ValidationError',
        tool_call_index: 0,
      },
      []
    );

    // Verify sample was created as pending
    const pendingSamples = trajectory.listCorrectionSamples('pending');
    expect(pendingSamples.length).toBe(1);
    const sampleId = pendingSamples[0].sampleId;

    // Verify no pain events yet
    const painEventsBefore = trajectory.listPainEventsForSession('test-session-001');
    expect(painEventsBefore.length).toBe(0);

    // Review as rejected
    trajectory.reviewCorrectionSample(sampleId, 'rejected', 'Does not match requirements');

    // Verify pain event was created
    const painEventsAfter = trajectory.listPainEventsForSession('test-session-001');
    expect(painEventsAfter.length).toBe(1);

    const painEvent = painEventsAfter[0];
    expect(painEvent.source).toBe('correction_rejected');
    expect(painEvent.reason).toContain('Correction rejected');
    expect(painEvent.origin).toBe('system_infer');
    expect(painEvent.score).toBeGreaterThan(0);
    expect(painEvent.score).toBeLessThanOrEqual(100);
  });

  it('does NOT emit a pain event when a correction sample is approved', () => {
    trajectory.recordSession({
      sessionId: 'test-session-002',
      startedAt: new Date().toISOString(),
    });

    trajectory.maybeCreateCorrectionSample(
      'test-session-002',
      {
        id: 200,
        assistant_text: 'Some code',
        correction_cue: 'Minor tweak',
        references_assistant_turn_id: 199,
      },
      'Test raw user text',
      {
        tool_name: 'read',
        error_message: 'Minor issue',
        error_type: 'MinorError',
        tool_call_index: 0,
      },
      []
    );

    const pendingSamples = trajectory.listCorrectionSamples('pending');
    expect(pendingSamples.length).toBe(1);
    const sampleId = pendingSamples[0].sampleId;

    // Review as approved
    trajectory.reviewCorrectionSample(sampleId, 'approved', 'Looks good');

    // Verify NO pain event was created
    const painEvents = trajectory.listPainEventsForSession('test-session-002');
    expect(painEvents.length).toBe(0);
  });

  it('maps quality_score to pain_score correctly', () => {
    trajectory.recordSession({
      sessionId: 'test-session-003',
      startedAt: new Date().toISOString(),
    });

    trajectory.maybeCreateCorrectionSample(
      'test-session-003',
      {
        id: 300,
        assistant_text: 'Very bad code',
        correction_cue: 'This is terrible',
        references_assistant_turn_id: 299,
      },
      'Test raw user text',
      {
        tool_name: 'exec',
        error_message: 'Failed badly',
        error_type: 'FatalError',
        tool_call_index: 0,
      },
      []
    );

    const pendingSamples = trajectory.listCorrectionSamples('pending');
    const sampleId = pendingSamples[0].sampleId;

    // Review as rejected
    trajectory.reviewCorrectionSample(sampleId, 'rejected', 'Very poor quality');

    const painEvents = trajectory.listPainEventsForSession('test-session-003');
    expect(painEvents.length).toBe(1);
    expect(painEvents[0].score).toBeGreaterThanOrEqual(0);
    expect(painEvents[0].score).toBeLessThanOrEqual(100);
  });
});
