/**
 * Unit tests for loadEvolutionQueue queue loading and migration.
 * Uses vi.useFakeTimers() per D-10.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEvolutionQueue, validateQueueEventPayload } from '../../src/service/evolution-worker.js';

describe('loadEvolutionQueue', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-queue-test-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads and migrates legacy queue from file', () => {
    // Write legacy v1 format (no taskKind, no priority)
    const legacyQueue = [
      {
        id: 'legacy-001',
        task: 'Diagnose tool_failure pain',
        score: 78,
        source: 'tool_failure',
        reason: 'Tool write failed',
        timestamp: '2026-04-10T08:30:00.000Z',
        enqueued_at: '2026-04-10T08:30:05.000Z',
        started_at: null,
        completed_at: null,
        assigned_session_key: null,
        trigger_text_preview: 'Tool write failed',
        status: 'pending',
        resolution: null,
        session_id: null,
        agent_id: null,
        traceId: 'trace-001',
      },
    ];
    const queuePath = path.join(tempDir, 'evolution_queue.json');
    fs.writeFileSync(queuePath, JSON.stringify(legacyQueue), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('legacy-001');
    expect(result[0].taskKind).toBe('pain_diagnosis'); // DEFAULT_TASK_KIND
    expect(result[0].priority).toBe('medium'); // DEFAULT_PRIORITY
    expect(result[0].retryCount).toBe(0);
    expect(result[0].maxRetries).toBe(3);
  });

  it('loads empty array when file does not exist', () => {
    const nonExistentPath = path.join(tempDir, 'does-not-exist.json');
    const result = loadEvolutionQueue(nonExistentPath);

    expect(result).toEqual([]);
  });

  it('loads existing V2 queue unchanged', () => {
    // Write V2 format with taskKind and priority
    const v2Queue = [
      {
        id: 'v2-001',
        taskKind: 'sleep_reflection',
        priority: 'high',
        score: 55,
        source: 'nocturnal',
        reason: 'Idle workspace',
        timestamp: '2026-04-13T00:00:00.000Z',
        enqueued_at: '2026-04-13T00:00:05.000Z',
        started_at: null,
        completed_at: null,
        assigned_session_key: null,
        trigger_text_preview: 'Idle workspace detected',
        status: 'pending',
        resolution: undefined,
        session_id: null,
        agent_id: null,
        traceId: 'trace-v2-001',
        retryCount: 0,
        maxRetries: 1,
        lastError: undefined,
        resultRef: undefined,
      },
    ];
    const queuePath = path.join(tempDir, 'evolution_queue_v2.json');
    fs.writeFileSync(queuePath, JSON.stringify(v2Queue), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('v2-001');
    expect(result[0].taskKind).toBe('sleep_reflection'); // unchanged
    expect(result[0].priority).toBe('high'); // unchanged
    expect(result[0].maxRetries).toBe(1); // unchanged
  });

  it('respects timestamp ordering in loaded queue', () => {
    const orderedQueue = [
      {
        id: 'first',
        taskKind: 'pain_diagnosis',
        priority: 'low',
        score: 30,
        source: 'tool_failure',
        reason: 'First task',
        timestamp: '2026-04-10T08:00:00.000Z',
        enqueued_at: '2026-04-10T08:00:00.000Z',
        started_at: null,
        completed_at: null,
        assigned_session_key: null,
        trigger_text_preview: 'First',
        status: 'pending',
        resolution: undefined,
        session_id: null,
        agent_id: null,
        traceId: 'trace-first',
        retryCount: 0,
        maxRetries: 3,
        lastError: undefined,
        resultRef: undefined,
      },
      {
        id: 'second',
        taskKind: 'pain_diagnosis',
        priority: 'medium',
        score: 60,
        source: 'tool_failure',
        reason: 'Second task',
        timestamp: '2026-04-11T08:00:00.000Z',
        enqueued_at: '2026-04-11T08:00:00.000Z',
        started_at: null,
        completed_at: null,
        assigned_session_key: null,
        trigger_text_preview: 'Second',
        status: 'pending',
        resolution: undefined,
        session_id: null,
        agent_id: null,
        traceId: 'trace-second',
        retryCount: 0,
        maxRetries: 3,
        lastError: undefined,
        resultRef: undefined,
      },
      {
        id: 'third',
        taskKind: 'pain_diagnosis',
        priority: 'high',
        score: 90,
        source: 'tool_failure',
        reason: 'Third task',
        timestamp: '2026-04-12T08:00:00.000Z',
        enqueued_at: '2026-04-12T08:00:00.000Z',
        started_at: null,
        completed_at: null,
        assigned_session_key: null,
        trigger_text_preview: 'Third',
        status: 'pending',
        resolution: undefined,
        session_id: null,
        agent_id: null,
        traceId: 'trace-third',
        retryCount: 0,
        maxRetries: 3,
        lastError: undefined,
        resultRef: undefined,
      },
    ];
    const queuePath = path.join(tempDir, 'ordered_queue.json');
    fs.writeFileSync(queuePath, JSON.stringify(orderedQueue), 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result[0].id).toBe('first');
    expect(result[1].id).toBe('second');
    expect(result[2].id).toBe('third');
  });

  it('handles file with trailing newline', () => {
    const queueWithNewline = [
      {
        id: 'newline-test',
        taskKind: 'pain_diagnosis',
        priority: 'medium',
        score: 50,
        source: 'tool_failure',
        reason: 'Trailing newline test',
        timestamp: '2026-04-10T10:00:00.000Z',
        enqueued_at: '2026-04-10T10:00:00.000Z',
        started_at: null,
        completed_at: null,
        assigned_session_key: null,
        trigger_text_preview: 'Trailing newline',
        status: 'pending',
        resolution: undefined,
        session_id: null,
        agent_id: null,
        traceId: 'trace-newline',
        retryCount: 0,
        maxRetries: 3,
        lastError: undefined,
        resultRef: undefined,
      },
    ];
    const queuePath = path.join(tempDir, 'newline_queue.json');
    fs.writeFileSync(queuePath, JSON.stringify(queueWithNewline) + '\n', 'utf8');

    const result = loadEvolutionQueue(queuePath);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('newline-test');
  });

  it('round-trip: load returns same data that was written', () => {
    // Write a V2-format queue, load it, verify data integrity
    const originalQueue = [
      {
        id: 'roundtrip-001',
        taskKind: 'sleep_reflection',
        priority: 'high',
        score: 88,
        source: 'nocturnal',
        reason: 'Round-trip test',
        timestamp: '2026-04-14T02:00:00.000Z',
        enqueued_at: '2026-04-14T02:00:00.000Z',
        started_at: null,
        completed_at: null,
        assigned_session_key: null,
        trigger_text_preview: 'Round-trip',
        status: 'pending',
        resolution: undefined,
        session_id: null,
        agent_id: null,
        traceId: 'trace-roundtrip',
        retryCount: 0,
        maxRetries: 1,
        lastError: undefined,
        resultRef: undefined,
      },
    ];
    const queuePath = path.join(tempDir, 'roundtrip_queue.json');
    fs.writeFileSync(queuePath, JSON.stringify(originalQueue), 'utf8');

    const loaded = loadEvolutionQueue(queuePath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(originalQueue[0].id);
    expect(loaded[0].taskKind).toBe(originalQueue[0].taskKind);
    expect(loaded[0].priority).toBe(originalQueue[0].priority);
    expect(loaded[0].score).toBe(originalQueue[0].score);
    expect(loaded[0].source).toBe(originalQueue[0].source);
    expect(loaded[0].status).toBe(originalQueue[0].status);
  });
});

describe('validateQueueEventPayload', () => {
  it('returns empty object for null/undefined', () => {
    expect(validateQueueEventPayload(null)).toEqual({});
    expect(validateQueueEventPayload(undefined)).toEqual({});
  });

  it('throws for non-string input', () => {
    expect(() => (validateQueueEventPayload as any)(123)).toThrow('must be a string');
    expect(() => (validateQueueEventPayload as any)({})).toThrow('must be a string');
  });

  it('throws for JSON that is not an object', () => {
    // Primitive JSON values pass typeof check but fail the object/null guard
    expect(() => validateQueueEventPayload('"string"')).toThrow('must be a JSON object');
    // Arrays pass typeof === 'object' check so they reach required fields check first
    expect(() => validateQueueEventPayload('[1,2,3]')).toThrow('missing required fields');
  });

  it('throws for object missing required fields', () => {
    expect(() => validateQueueEventPayload('{"type":"x"}')).toThrow('missing required fields');
    expect(() => validateQueueEventPayload('{"workspaceId":"x"}')).toThrow('missing required fields');
  });

  it('returns parsed object for valid payload', () => {
    const valid = '{"type":"test","workspaceId":"ws-001"}';
    expect(validateQueueEventPayload(valid)).toEqual({ type: 'test', workspaceId: 'ws-001' });
  });

  it('throws wrapped SyntaxError for invalid JSON', () => {
    expect(() => validateQueueEventPayload('not json')).toThrow('Invalid JSON');
  });
});
