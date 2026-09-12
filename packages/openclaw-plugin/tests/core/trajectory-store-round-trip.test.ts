/**
 * PRI-753 regression guard: plugin writer → core reader path alignment.
 *
 * openclaw-plugin TrajectoryDatabase is the only production writer of the
 * workspace trajectory database (canonical location `.state/trajectory.db`,
 * plugin `core/paths.ts` PD_FILES.TRAJECTORY_DB). principles-core
 * trajectory-store / evolution-store are readers of the same file
 * (principles-core/src/trajectory-db.ts pins the relative path because core
 * cannot import from the plugin).
 *
 * This test drives the real production write path (public record* methods,
 * including correction-sample mining) and then reads the same records through
 * the core SDK primitives. If either side moves the database file, this test
 * fails — that drift is exactly what silently broke `pd samples-*` and
 * `pd evolution-tasks-*` before PRI-753 (they read a hidden
 * `.state/.trajectory.db` that no writer ever produced).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import {
  listCorrectionSamples,
  reviewCorrectionSample,
  TrajectoryDbUnavailableError,
} from '@principles/core/trajectory-store';
import { listEvolutionTasks, getEvolutionTask } from '@principles/core/evolution-store';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-roundtrip-'));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('trajectory writer→reader path alignment (PRI-753)', () => {
  it('core readers see records written through TrajectoryDatabase', () => {
    const workspaceDir = makeWorkspace();
    const sessionId = 'session-roundtrip';

    TrajectoryRegistry.use(workspaceDir, (db: TrajectoryDatabase) => {
      const assistantTurnId = db.recordAssistantTurn({
        sessionId,
        runId: 'run-roundtrip',
        provider: 'test-provider',
        model: 'test-model',
        rawText: 'assistant output that needs correction',
        sanitizedText: 'assistant output that needs correction',
        usageJson: {},
        empathySignalJson: {},
      });

      db.recordUserTurn({
        sessionId,
        turnIndex: 1,
        rawText: 'you broke the build, fix it',
        correctionDetected: true,
        correctionCue: 'you broke',
        referencesAssistantTurnId: assistantTurnId,
      });

      // A successful tool call triggers correction-sample mining
      // (TrajectoryDatabase.recordToolCall → maybeCreateCorrectionSample).
      db.recordToolCall({
        sessionId,
        toolName: 'edit_file',
        outcome: 'success',
      });

      db.recordEvolutionTask({
        taskId: 'task-roundtrip-001',
        traceId: 'trace-roundtrip-001',
        source: 'pain_signal',
        reason: 'High pain detected',
        score: 90,
        status: 'pending',
      });
    });

    const samples = listCorrectionSamples(workspaceDir);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.sessionId).toBe(sessionId);
    expect(samples[0]?.reviewStatus).toBe('pending');

    const reviewed = reviewCorrectionSample(samples[0]!.sampleId, 'approved', 'looks good', workspaceDir);
    expect(reviewed.reviewStatus).toBe('approved');
    expect(listCorrectionSamples(workspaceDir, 'approved')).toHaveLength(1);
    expect(listCorrectionSamples(workspaceDir, 'pending')).toHaveLength(0);

    const tasks = listEvolutionTasks(workspaceDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe('task-roundtrip-001');
    expect(tasks[0]?.traceId).toBe('trace-roundtrip-001');
    expect(tasks[0]?.score).toBe(90);

    const task = getEvolutionTask(workspaceDir, 'task-roundtrip-001');
    expect(task).not.toBeNull();
    expect(task?.source).toBe('pain_signal');
  });

  it('core readers fail loud when no workspace database exists (missing ≠ empty)', () => {
    const workspaceDir = makeWorkspace();
    // No TrajectoryDatabase was ever constructed: .state/trajectory.db absent.

    expect(() => listCorrectionSamples(workspaceDir)).toThrow(TrajectoryDbUnavailableError);
    expect(() => listEvolutionTasks(workspaceDir)).toThrow(TrajectoryDbUnavailableError);
    expect(() => getEvolutionTask(workspaceDir, 'task-roundtrip-001')).toThrow(TrajectoryDbUnavailableError);
    expect(() => reviewCorrectionSample('sample-x', 'approved', undefined, workspaceDir)).toThrow(
      TrajectoryDbUnavailableError
    );
  });

  it('a present-but-empty database is empty, not unavailable', () => {
    const workspaceDir = makeWorkspace();

    TrajectoryRegistry.use(workspaceDir, () => {
      // Schema initialized, zero rows recorded.
    });

    expect(listCorrectionSamples(workspaceDir)).toEqual([]);
    expect(listEvolutionTasks(workspaceDir)).toEqual([]);
    expect(getEvolutionTask(workspaceDir, 'task-roundtrip-001')).toBeNull();
  });
});
