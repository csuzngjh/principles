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
import Database from 'better-sqlite3';

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
    });

    const samples = listCorrectionSamples(workspaceDir);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.sessionId).toBe(sessionId);
    expect(samples[0]?.reviewStatus).toBe('pending');

    const reviewed = reviewCorrectionSample(samples[0]!.sampleId, 'approved', 'looks good', workspaceDir);
    expect(reviewed.reviewStatus).toBe('approved');
    expect(listCorrectionSamples(workspaceDir, 'approved')).toHaveLength(1);
    expect(listCorrectionSamples(workspaceDir, 'pending')).toHaveLength(0);

    // PRI-770: fresh workspaces no longer create the evolution tables — the
    // core readers degrade to empty results instead of throwing.
    expect(listEvolutionTasks(workspaceDir)).toEqual([]);
    expect(getEvolutionTask(workspaceDir, 'task-roundtrip-001')).toBeNull();

    // Historical workspaces keep their tables and rows. Simulate one by
    // creating the legacy table directly (single-line DDL mirrors
    // trajectory.test.ts fixtures), then verify the core readers still serve
    // it — the write path itself was retired with the evolution worker.
    const raw = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      raw.exec(`CREATE TABLE evolution_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT UNIQUE NOT NULL, trace_id TEXT NOT NULL, source TEXT NOT NULL, reason TEXT, score INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', enqueued_at TEXT, started_at TEXT, completed_at TEXT, resolution TEXT, task_kind TEXT, priority TEXT, retry_count INTEGER, max_retries INTEGER, last_error TEXT, result_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      raw.prepare(`INSERT INTO evolution_tasks (task_id, trace_id, source, reason, score, status, created_at, updated_at, task_kind, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'task-roundtrip-001',
        'trace-roundtrip-001',
        'pain_signal',
        'High pain detected',
        90,
        'pending',
        '2026-09-12T00:00:00.000Z',
        '2026-09-12T00:00:00.000Z',
        'pain_diagnosis',
        'medium',
      );
    } finally {
      raw.close();
    }

    const tasks = listEvolutionTasks(workspaceDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe('task-roundtrip-001');
    expect(tasks[0]?.traceId).toBe('trace-roundtrip-001');
    expect(tasks[0]?.score).toBe(90);
    expect(tasks[0]?.taskKind).toBe('pain_diagnosis');
    expect(tasks[0]?.priority).toBe('medium');

    const task = getEvolutionTask(workspaceDir, 'task-roundtrip-001');
    expect(task).not.toBeNull();
    expect(task?.source).toBe('pain_signal');
    expect(task?.taskKind).toBe('pain_diagnosis');
    expect(task?.priority).toBe('medium');
  });

  it('rejecting a sample through the core store records the correction_rejected pain event', () => {
    const workspaceDir = makeWorkspace();
    const sessionId = 'session-reject';

    TrajectoryRegistry.use(workspaceDir, (db: TrajectoryDatabase) => {
      const assistantTurnId = db.recordAssistantTurn({
        sessionId,
        runId: 'run-reject',
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
        rawText: 'this is wrong, fix it',
        correctionDetected: true,
        correctionCue: 'this is wrong',
        referencesAssistantTurnId: assistantTurnId,
      });

      db.recordToolCall({ sessionId, toolName: 'edit_file', outcome: 'success' });
    });

    const [sample] = listCorrectionSamples(workspaceDir);
    expect(sample).toBeDefined();

    const rejected = reviewCorrectionSample(sample!.sampleId, 'rejected', 'bad fix', workspaceDir);
    expect(rejected.reviewStatus).toBe('rejected');

    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const pain = db
        .prepare("SELECT source, session_id, host_kind FROM pain_events WHERE source = 'correction_rejected'")
        .all() as Array<{ source: string; session_id: string; host_kind: string | null }>;
      expect(pain).toHaveLength(1);
      expect(pain[0]?.session_id).toBe(sessionId);
      expect(pain[0]?.host_kind).toBe('openclaw');
    } finally {
      db.close();
    }
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
