/**
 * Unit tests for queue-io.ts — queue persistence layer.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    loadEvolutionQueue,
    saveEvolutionQueue,
    withQueueLock,
    acquireQueueLock,
    EVOLUTION_QUEUE_LOCK_SUFFIX,
    LOCK_MAX_RETRIES,
    LOCK_RETRY_DELAY_MS,
    LOCK_STALE_MS,
    readRecentPainContext,
} from '../../src/service/queue-io.js';
import { readPainFlagContract } from '../../src/core/pain.js';

// Mock readPainFlagContract for readRecentPainContext tests
vi.mock('../../src/core/pain.js', () => ({
    readPainFlagContract: vi.fn(),
}));

let tmpDir: string;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-io-test-'));
});
afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('constants', () => {
    it('exports EVOLUTION_QUEUE_LOCK_SUFFIX as .lock', () => {
        expect(EVOLUTION_QUEUE_LOCK_SUFFIX).toBe('.lock');
    });

    it('exports LOCK_MAX_RETRIES as 50', () => {
        expect(LOCK_MAX_RETRIES).toBe(50);
    });

    it('exports LOCK_RETRY_DELAY_MS as 50', () => {
        expect(LOCK_RETRY_DELAY_MS).toBe(50);
    });

    it('exports LOCK_STALE_MS as 30_000', () => {
        expect(LOCK_STALE_MS).toBe(30_000);
    });
});

describe('loadEvolutionQueue', () => {
    it('returns empty array when file does not exist', () => {
        const result = loadEvolutionQueue(path.join(tmpDir, 'nonexistent.json'));
        expect(result).toEqual([]);
    });

    it('migrates legacy queue items to V2 schema', () => {
        const legacyFile = path.join(tmpDir, 'legacy-queue.json');
        fs.writeFileSync(legacyFile, JSON.stringify([
            { id: 'item-1', score: 75, source: 'tool_failure', reason: 'test', timestamp: '2024-01-01T00:00:00Z' },
        ]));
        const result = loadEvolutionQueue(legacyFile);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('item-1');
        expect(result[0].taskKind).toBe('pain_diagnosis'); // migrated default
        expect(result[0].priority).toBe('medium');
        expect(result[0].retryCount).toBe(0);
    });

    it('returns V2 queue items unchanged', () => {
        const v2File = path.join(tmpDir, 'v2-queue.json');
        const v2Item = {
            id: 'item-2',
            taskKind: 'principle_generation',
            priority: 'high',
            source: 'correction_keyword',
            traceId: 'abc123',
            task: 'Generate a principle',
            score: 90,
            reason: 'test',
            timestamp: '2024-01-01T00:00:00Z',
            status: 'pending',
            resolution: undefined,
            session_id: 'sess-1',
            agent_id: 'agent-1',
            retryCount: 0,
            maxRetries: 3,
            lastError: undefined,
            resultRef: undefined,
        };
        fs.writeFileSync(v2File, JSON.stringify([v2Item]));
        const result = loadEvolutionQueue(v2File);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ id: 'item-2', taskKind: 'principle_generation', priority: 'high' });
    });

    it('recovers with empty array when file contains corrupted JSON', () => {
        const corruptFile = path.join(tmpDir, 'corrupt-queue.json');
        fs.writeFileSync(corruptFile, '{ invalid json }', 'utf8');
        const result = loadEvolutionQueue(corruptFile);
        // Should recover gracefully with empty array (warns but doesn't throw)
        expect(result).toEqual([]);
    });
});

describe('saveEvolutionQueue', () => {
    it('writes queue to file as formatted JSON', () => {
        const outFile = path.join(tmpDir, 'saved-queue.json');
        const queue = [
            { id: 'item-1', taskKind: 'pain_diagnosis', priority: 'medium', source: 'test', traceId: '', task: '', score: 50, reason: 'test', timestamp: '2024-01-01T00:00:00Z', status: 'pending', resolution: undefined, session_id: '', agent_id: '', retryCount: 0, maxRetries: 3, lastError: undefined, resultRef: undefined },
        ];
        saveEvolutionQueue(outFile, queue);
        const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe('item-1');
    });

    it('overwrites existing file', () => {
        const outFile = path.join(tmpDir, 'overwrite-queue.json');
        fs.writeFileSync(outFile, JSON.stringify([{ id: 'old' }]));
        saveEvolutionQueue(outFile, []);
        const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        expect(parsed).toHaveLength(0);
    });
});

describe('acquireQueueLock', () => {
    it('acquires and releases lock on temp file', async () => {
        const lockFile = path.join(tmpDir, 'test-lock-file');
        const release = await acquireQueueLock(lockFile, undefined, '.lock');
        expect(typeof release).toBe('function');

        // Release should not throw
        release();
    });

    it('acquired lock release function is callable multiple times (idempotent)', async () => {
        const lockFile = path.join(tmpDir, 'idempotent-release');
        const release = await acquireQueueLock(lockFile, undefined, '.lock');
        release();
        // Second release should not throw
        release();
    });
});

describe('withQueueLock RAII', () => {
    it('releases lock after fn completes normally', async () => {
        const lockFile = path.join(tmpDir, 'raii-normal');
        let executed = false;
        await withQueueLock(lockFile, undefined, 'test-scope', async () => {
            executed = true;
        });
        expect(executed).toBe(true);

        // Now re-acquire should succeed (lock was released)
        const release = await acquireQueueLock(lockFile, undefined, '.lock');
        release();
    });

    it('releases lock after fn throws', async () => {
        const lockFile = path.join(tmpDir, 'raii-throws');

        await expect(
            withQueueLock(lockFile, undefined, 'test-scope', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        // Lock should be released — re-acquire should succeed
        const release = await acquireQueueLock(lockFile, undefined, '.lock');
        release();
    });
});

describe('readRecentPainContext', () => {
  // readPainFlagContract is mocked via vi.mock above
  const mockWctx = { workspaceDir: '/fake/workspace' } as any;

  it('returns null context when contract status is not valid', () => {
    vi.mocked(readPainFlagContract).mockReturnValueOnce({
      status: 'missing',
      format: 'missing',
      data: {},
      missingFields: [],
    } as any);
    const result = readRecentPainContext(mockWctx);
    expect(result.mostRecent).toBeNull();
    expect(result.recentPainCount).toBe(0);
  });

  it('returns null context when score parses to 0', () => {
    vi.mocked(readPainFlagContract).mockReturnValueOnce({
      status: 'valid',
      format: 'kv',
      data: { score: '0', source: 'tool_failure', reason: 'err', time: '2026-04-14T00:00:00Z', session_id: 's1' },
      missingFields: [],
    } as any);
    const result = readRecentPainContext(mockWctx);
    expect(result.mostRecent).toBeNull();
  });

  it('returns mostRecent with valid score > 0', () => {
    vi.mocked(readPainFlagContract).mockReturnValueOnce({
      status: 'valid',
      format: 'kv',
      data: { score: '75', source: 'tool_failure', reason: 'File write failed', time: '2026-04-14T10:00:00Z', session_id: 'sess-001' },
      missingFields: [],
    } as any);
    const result = readRecentPainContext(mockWctx);
    expect(result.mostRecent).not.toBeNull();
    expect(result.mostRecent!.score).toBe(75);
    expect(result.mostRecent!.source).toBe('tool_failure');
    expect(result.recentPainCount).toBe(1);
    expect(result.recentMaxPainScore).toBe(75);
  });

  it('returns null context when contract data is empty object', () => {
    vi.mocked(readPainFlagContract).mockReturnValueOnce({
      status: 'valid',
      format: 'empty',
      data: {},
      missingFields: [],
    } as any);
    const result = readRecentPainContext(mockWctx);
    expect(result.mostRecent).toBeNull();
  });
});
