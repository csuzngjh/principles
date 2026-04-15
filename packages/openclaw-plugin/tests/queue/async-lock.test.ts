/**
 * Unit tests for asyncLockQueues concurrency with Promise.all race detection.
 * Tests file-level async lock serialization and Map state cleanup per D-05.
 * Uses vi.useFakeTimers() in beforeEach/afterEach per D-10,
 * but concurrency tests run with real timers to avoid Promise.all + fake timer issues.
 * Uses os.tmpdir() per D-11.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withAsyncLock, asyncLockQueues } from '../../src/utils/file-lock.js';

describe('asyncLockQueues', () => {
  let tempDir: string;

  beforeEach(() => {
    // D-10: Use fake timers in beforeEach (afterEach restores real timers)
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-async-lock-test-'));
    // D-05: clear Map state between tests
    asyncLockQueues.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent operations on same file (Promise.all race detection)', async () => {
    const filePath = path.join(tempDir, 'serialized-test.json');
    fs.writeFileSync(filePath, '{}', 'utf8');

    const results: number[] = [];

    // Use real timers for this test (fake timers + Promise.all + setTimeout don't mix well)
    vi.useRealTimers();

    const promises = [
      withAsyncLock(filePath, async () => {
        results.push(1);
        await new Promise(r => setTimeout(r, 50));
        results.push(2);
      }),
      withAsyncLock(filePath, async () => {
        results.push(3);
        await new Promise(r => setTimeout(r, 50));
        results.push(4);
      }),
    ];

    await Promise.all(promises);

    // Both operations completed
    expect(results).toHaveLength(4);

    // Non-interleaved: first operation completes before second starts
    // [1, 2, 3, 4] means first ran fully, then second ran fully
    // [3, 4, 1, 2] means second ran fully, then first ran fully
    // [1, 3, 2, 4] would mean interleaving (bad) — but lock prevents this
    const isNonInterleaved =
      (results[0] === 1 && results[1] === 2) ||
      (results[0] === 3 && results[1] === 4);

    expect(isNonInterleaved).toBe(true);

    // Restore fake timers for afterEach cleanup
    vi.useFakeTimers();
  });

  it('allows concurrent operations on different files', async () => {
    const fileA = path.join(tempDir, 'file-a.json');
    const fileB = path.join(tempDir, 'file-b.json');
    fs.writeFileSync(fileA, '{}', 'utf8');
    fs.writeFileSync(fileB, '{}', 'utf8');

    const results: string[] = [];

    // Use real timers for this test
    vi.useRealTimers();

    const promiseA = withAsyncLock(fileA, async () => {
      results.push('A-start');
      await new Promise(r => setTimeout(r, 20));
      results.push('A-end');
    });

    const promiseB = withAsyncLock(fileB, async () => {
      results.push('B-start');
      await new Promise(r => setTimeout(r, 20));
      results.push('B-end');
    });

    await Promise.all([promiseA, promiseB]);

    // Both operations completed
    expect(results).toHaveLength(4);
    // Operations on different files should interleave (both run concurrently)
    expect(results).toContain('A-start');
    expect(results).toContain('A-end');
    expect(results).toContain('B-start');
    expect(results).toContain('B-end');

    // Restore fake timers for afterEach cleanup
    vi.useFakeTimers();
  });

  it('clears Map state between tests (beforeEach clearing)', async () => {
    // Verify Map is empty at start of test (beforeEach cleared it)
    expect(asyncLockQueues.size).toBe(0);

    const filePath = path.join(tempDir, 'map-state-test.json');
    fs.writeFileSync(filePath, '{}', 'utf8');

    // Use real timers
    vi.useRealTimers();

    // Add entries to the Map via withAsyncLock (starts operations but doesn't wait)
    const p1 = withAsyncLock(filePath, async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    // Wait a bit for the operation to start
    await new Promise(r => setTimeout(r, 10));

    // Map should have entries (lock for filePath is queued)
    expect(asyncLockQueues.size).toBeGreaterThanOrEqual(1);

    // Wait for operation to complete to avoid affecting other tests
    await p1;

    // Restore fake timers for afterEach cleanup
    vi.useFakeTimers();
  });

  it('releases lock after function throws', async () => {
    const filePath = path.join(tempDir, 'error-test.json');
    fs.writeFileSync(filePath, '{}', 'utf8');

    // Use real timers
    vi.useRealTimers();

    // First call throws
    await expect(
      withAsyncLock(filePath, async () => {
        throw new Error('intentional failure');
      })
    ).rejects.toThrow('intentional failure');

    // Second call should succeed (lock was released)
    const result = await withAsyncLock(filePath, async () => 'success-after-error');

    expect(result).toBe('success-after-error');

    // Restore fake timers for afterEach cleanup
    vi.useFakeTimers();
  });

  it('returns correct value from withAsyncLock', async () => {
    const filePath = path.join(tempDir, 'return-value-test.json');
    fs.writeFileSync(filePath, '{}', 'utf8');

    // Use real timers
    vi.useRealTimers();

    const result = await withAsyncLock(filePath, async () => {
      return { success: true, value: 42 };
    });

    expect(result).toEqual({ success: true, value: 42 });

    // Restore fake timers for afterEach cleanup
    vi.useFakeTimers();
  });

  it('handles multiple sequential operations on same file', async () => {
    const filePath = path.join(tempDir, 'sequential-test.json');
    fs.writeFileSync(filePath, '{}', 'utf8');

    // Use real timers
    vi.useRealTimers();

    const results: number[] = [];

    for (let i = 0; i < 3; i++) {
      const idx = i;
      await withAsyncLock(filePath, async () => {
        results.push(idx);
        await new Promise(r => setTimeout(r, 10));
      });
    }

    // All three sequential operations completed
    expect(results).toEqual([0, 1, 2]);

    // Restore fake timers for afterEach cleanup
    vi.useFakeTimers();
  });
});
