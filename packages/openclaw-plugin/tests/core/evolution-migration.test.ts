import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyEvolutionData } from '../../src/core/evolution-migration.js';
import {
  migrateToV2,
  isLegacyQueueItem,
  migrateQueueToV2,
  loadEvolutionQueue,
} from '../../src/service/evolution-worker.js';
import type { LegacyEvolutionQueueItem, EvolutionQueueItem } from '../../src/service/evolution-worker.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-migration-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migrateLegacyEvolutionData', () => {
  it('imports legacy files into evolution stream as legacy_import events', () => {
    const workspace = makeTempDir();
    fs.mkdirSync(path.join(workspace, '.principles'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'memory', 'ISSUE_LOG.md'), 'Issue A\nIssue B\n');
    fs.writeFileSync(path.join(workspace, '.principles', 'PRINCIPLES.md'), '# P\nRule A\n');

    const result = migrateLegacyEvolutionData(workspace);

    expect(result.importedEvents).toBe(2);
    const streamPath = path.join(workspace, 'memory', 'evolution.jsonl');
    const events = fs.readFileSync(streamPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events.every(event => event.type === 'legacy_import')).toBe(true);
  });

  it('is idempotent when migration runs multiple times', () => {
    const workspace = makeTempDir();
    fs.mkdirSync(path.join(workspace, '.principles'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'memory', 'ISSUE_LOG.md'), 'Issue A\n');

    const first = migrateLegacyEvolutionData(workspace);
    const second = migrateLegacyEvolutionData(workspace);

    expect(first.importedEvents).toBe(1);
    expect(second.importedEvents).toBe(0);
  });
});

// ===== migrateToV2 integration tests =====

describe('migrateToV2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('legacy item without taskKind gets DEFAULT_TASK_KIND (pain_diagnosis)', () => {
    const legacyItem: LegacyEvolutionQueueItem = {
      id: 'test-legacy-001',
      score: 75,
      source: 'tool_failure',
      reason: 'Tool failed',
      timestamp: '2026-04-10T00:00:00.000Z',
    };

    const migrated = migrateToV2(legacyItem);

    expect(migrated.taskKind).toBe('pain_diagnosis');
    expect(migrated.priority).toBe('medium');
    expect(migrated.retryCount).toBe(0);
    expect(migrated.maxRetries).toBe(3);
  });

  it('legacy item without priority gets DEFAULT_PRIORITY (medium)', () => {
    const legacyItem: LegacyEvolutionQueueItem = {
      id: 'test-legacy-002',
      score: 50,
      source: 'gate_block',
      reason: 'Gate blocked',
      timestamp: '2026-04-11T00:00:00.000Z',
    };

    const migrated = migrateToV2(legacyItem);

    expect(migrated.priority).toBe('medium');
  });

  it('migrateToV2 preserves all original fields', () => {
    const legacyItem: LegacyEvolutionQueueItem = {
      id: 'test-legacy-003',
      task: 'Diagnose pain',
      score: 88,
      source: 'runtime_unavailable',
      reason: 'Session timeout',
      timestamp: '2026-04-12T00:00:00.000Z',
      enqueued_at: '2026-04-12T00:00:05.000Z',
      started_at: '2026-04-12T00:01:00.000Z',
      completed_at: '2026-04-12T00:05:00.000Z',
      assigned_session_key: 'session-key-xyz',
      trigger_text_preview: 'Session timed out',
      status: 'completed',
      resolution: 'auto_completed_timeout',
      session_id: 'session-xyz',
      agent_id: 'main',
      traceId: 'trace-xyz',
      resultRef: 'result-xyz',
    };

    const migrated = migrateToV2(legacyItem);

    expect(migrated.id).toBe('test-legacy-003');
    expect(migrated.task).toBe('Diagnose pain');
    expect(migrated.score).toBe(88);
    expect(migrated.source).toBe('runtime_unavailable');
    expect(migrated.reason).toBe('Session timeout');
    expect(migrated.timestamp).toBe('2026-04-12T00:00:00.000Z');
    expect(migrated.enqueued_at).toBe('2026-04-12T00:00:05.000Z');
    expect(migrated.started_at).toBe('2026-04-12T00:01:00.000Z');
    expect(migrated.completed_at).toBe('2026-04-12T00:05:00.000Z');
    expect(migrated.assigned_session_key).toBe('session-key-xyz');
    expect(migrated.trigger_text_preview).toBe('Session timed out');
    expect(migrated.status).toBe('completed');
    expect(migrated.resolution).toBe('auto_completed_timeout');
    expect(migrated.session_id).toBe('session-xyz');
    expect(migrated.agent_id).toBe('main');
    expect(migrated.traceId).toBe('trace-xyz');
    expect(migrated.resultRef).toBe('result-xyz');
  });

  it('migrateQueueToV2 migrates legacy items and passes through V2 items unchanged', () => {
    const mixedQueue = [
      // Legacy item (no taskKind) - should be migrated
      {
        id: 'legacy-001',
        score: 70,
        source: 'tool_failure',
        reason: 'Legacy reason',
        timestamp: '2026-04-10T00:00:00.000Z',
      } as LegacyEvolutionQueueItem,
      // V2 item (has taskKind) - should be passed through
      {
        id: 'v2-001',
        taskKind: 'sleep_reflection' as const,
        priority: 'high' as const,
        score: 60,
        source: 'nocturnal',
        reason: 'V2 reason',
        timestamp: '2026-04-11T00:00:00.000Z',
        status: 'pending' as const,
        retryCount: 0,
        maxRetries: 3,
      } as EvolutionQueueItem,
    ];

    const result = migrateQueueToV2(mixedQueue as any);

    expect(result).toHaveLength(2);
    // Legacy item should be migrated
    expect(result[0].id).toBe('legacy-001');
    expect((result[0] as EvolutionQueueItem).taskKind).toBe('pain_diagnosis');
    expect((result[0] as EvolutionQueueItem).priority).toBe('medium');
    // V2 item should be passed through unchanged
    expect(result[1].id).toBe('v2-001');
    expect((result[1] as EvolutionQueueItem).taskKind).toBe('sleep_reflection');
    expect((result[1] as EvolutionQueueItem).priority).toBe('high');
  });

  it('isLegacyQueueItem returns true only when taskKind is absent', () => {
    const legacyItem = { id: 'test', score: 50, source: 'x', reason: 'y', timestamp: '2026-01-01T00:00:00Z' };
    const v2Item = { id: 'test', taskKind: 'sleep_reflection', score: 50, source: 'x', reason: 'y', timestamp: '2026-01-01T00:00:00Z', priority: 'medium', status: 'pending', retryCount: 0, maxRetries: 3 };

    expect(isLegacyQueueItem(legacyItem)).toBe(true);
    expect(isLegacyQueueItem(v2Item)).toBe(false);
  });
});

// ===== Queue state transition tests =====

describe('Queue migration state transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pending legacy item migrates to V2 with pending status', () => {
    const tempDir = makeTempDir();
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    const legacyPending = {
      id: 'pending-001',
      score: 72,
      source: 'tool_failure',
      reason: 'Write tool failed',
      timestamp: '2026-04-10T08:00:00.000Z',
      enqueued_at: '2026-04-10T08:00:05.000Z',
      started_at: null,
      completed_at: null,
      assigned_session_key: null,
      trigger_text_preview: 'Write failed',
      status: 'pending',
      resolution: null,
      session_id: null,
      agent_id: null,
      traceId: 'trace-pending',
    };
    fs.writeFileSync(queuePath, JSON.stringify([legacyPending]), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('pending-001');
    expect(result[0].status).toBe('pending');
    expect(result[0].taskKind).toBe('pain_diagnosis');
    expect(result[0].priority).toBe('medium');
  });

  it('in_progress legacy item migrates to V2 with in_progress status', () => {
    const tempDir = makeTempDir();
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    const legacyInProgress = {
      id: 'inprogress-001',
      score: 65,
      source: 'runtime_unavailable',
      reason: 'Session timeout',
      timestamp: '2026-04-11T14:00:00.000Z',
      enqueued_at: '2026-04-11T14:00:10.000Z',
      started_at: '2026-04-11T14:05:00.000Z',
      completed_at: null,
      assigned_session_key: 'session-key-abc',
      trigger_text_preview: 'Session timeout',
      status: 'in_progress',
      resolution: null,
      session_id: 'session-abc',
      agent_id: 'main',
      traceId: 'trace-inprogress',
    };
    fs.writeFileSync(queuePath, JSON.stringify([legacyInProgress]), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('inprogress-001');
    expect(result[0].status).toBe('in_progress');
  });

  it('completed legacy item migrates to V2 with completed status', () => {
    const tempDir = makeTempDir();
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    const legacyCompleted = {
      id: 'completed-001',
      score: 90,
      source: 'gate_block',
      reason: 'Principle score below threshold',
      timestamp: '2026-04-12T09:00:00.000Z',
      enqueued_at: '2026-04-12T09:00:30.000Z',
      started_at: '2026-04-12T09:01:00.000Z',
      completed_at: '2026-04-12T09:05:00.000Z',
      assigned_session_key: 'session-key-def',
      trigger_text_preview: 'Score below threshold',
      status: 'completed',
      resolution: 'late_marker_no_principle',
      session_id: 'session-def',
      agent_id: 'main',
      traceId: 'trace-completed',
    };
    fs.writeFileSync(queuePath, JSON.stringify([legacyCompleted]), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('completed-001');
    expect(result[0].status).toBe('completed');
    expect(result[0].resolution).toBe('late_marker_no_principle');
  });

  it('failed legacy item migrates to V2 with failed status', () => {
    const tempDir = makeTempDir();
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    const legacyFailed = {
      id: 'failed-001',
      score: 55,
      source: 'thin_violation',
      reason: 'Rule scoring bias',
      timestamp: '2026-04-13T16:00:00.000Z',
      enqueued_at: '2026-04-13T16:00:15.000Z',
      started_at: '2026-04-13T16:01:00.000Z',
      completed_at: '2026-04-13T16:05:00.000Z',
      assigned_session_key: 'session-key-ghi',
      trigger_text_preview: 'Rule scoring bias',
      status: 'failed',
      resolution: 'failed_max_retries',
      session_id: 'session-ghi',
      agent_id: 'main',
      traceId: 'trace-failed',
    };
    fs.writeFileSync(queuePath, JSON.stringify([legacyFailed]), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('failed-001');
    expect(result[0].status).toBe('failed');
    expect(result[0].resolution).toBe('failed_max_retries');
  });

  it('legacy item with missing optional fields retains undefined values', () => {
    const tempDir = makeTempDir();
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    // Minimal legacy item - only required fields
    const minimalLegacy = {
      id: 'minimal-001',
      score: 40,
      source: 'minimal_source',
      reason: 'Minimal test item',
      timestamp: '2026-04-14T00:00:00.000Z',
    };
    fs.writeFileSync(queuePath, JSON.stringify([minimalLegacy]), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('minimal-001');
    expect(result[0].enqueued_at).toBeUndefined();
    expect(result[0].started_at).toBeUndefined();
    expect(result[0].completed_at).toBeUndefined();
    expect(result[0].assigned_session_key).toBeUndefined();
    expect(result[0].trigger_text_preview).toBeUndefined();
    expect(result[0].session_id).toBeUndefined();
    expect(result[0].agent_id).toBeUndefined();
    expect(result[0].traceId).toBeUndefined();
    expect(result[0].resultRef).toBeUndefined();
    // But defaults are applied for V2-required fields
    expect(result[0].taskKind).toBe('pain_diagnosis');
    expect(result[0].priority).toBe('medium');
    expect(result[0].retryCount).toBe(0);
    expect(result[0].maxRetries).toBe(3);
    expect(result[0].status).toBe('pending'); // default status
  });

  it('empty queue file returns empty array', () => {
    const tempDir = makeTempDir();
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    fs.writeFileSync(queuePath, JSON.stringify([]), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(0);
  });

  it('corrupted JSON file returns empty array', () => {
    const tempDir = makeTempDir();
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    fs.writeFileSync(queuePath, 'not valid json{ ', 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(0);
  });
});
