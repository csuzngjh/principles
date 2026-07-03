/**
 * PRI-504 regression tests: SystemLogger must key its cache by workspaceDir
 * to prevent cross-workspace log leakage in multi-workspace processes.
 *
 * Reference pattern: evolution-logger.test.ts uses `disposeAllEvolutionLoggers()`
 * in afterEach to clear caches between tests. We mirror that here with
 * `disposeAllSystemLoggers()`.
 *
 * ERR-092: Module-level cache leaks across workspace instances when not keyed
 * by workspaceDir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SystemLogger, disposeSystemLogger, disposeAllSystemLoggers } from '../../src/core/system-logger.js';

describe('SystemLogger workspace isolation (PRI-504)', () => {
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(() => {
    workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-syslog-A-'));
    workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-syslog-B-'));
  });

  afterEach(() => {
    disposeAllSystemLoggers();
    for (const dir of [workspaceA, workspaceB]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows file lock issue - ignore
      }
    }
  });

  /**
   * Helper: wait for fire-and-forget async fs.appendFile to complete.
   * SystemLogger uses fire-and-forget (no await/return promise), so we
   * give the event loop a tick to flush.
   */
  function flushAsyncWrites(ms = 50): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
  }

  /**
   * Helper: read today's SYSTEM log for a workspace. Returns empty string
   * if the file does not exist (so callers can use toContain assertions).
   */
  function readTodayLog(workspaceDir: string): string {
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(workspaceDir, 'memory', 'logs', `SYSTEM_${today}.log`);
    if (!fs.existsSync(logPath)) return '';
    return fs.readFileSync(logPath, 'utf-8');
  }

  it('SL-01: two workspaces write to separate log files (no cross-contamination)', async () => {
    // Reproduce the original ERR-092 bug: prior to the fix, the FIRST workspace
    // to call log() would pin the log file path, and all subsequent workspaces
    // would write into that same file. After the fix, each workspace must write
    // into its own <workspace>/memory/logs/SYSTEM_YYYY-MM-DD.log.
    SystemLogger.log(workspaceA, 'TEST_EVENT', 'message-from-A');
    SystemLogger.log(workspaceB, 'TEST_EVENT', 'message-from-B');

    await flushAsyncWrites();

    const contentA = readTodayLog(workspaceA);
    const contentB = readTodayLog(workspaceB);

    expect(contentA).toContain('message-from-A');
    expect(contentA).not.toContain('message-from-B');
    expect(contentB).toContain('message-from-B');
    expect(contentB).not.toContain('message-from-A');
  });

  it('SL-02: same workspace reuses cached log file path (no repeated mkdirSync)', async () => {
    // Cache reuse: the second log() call for the same workspace should hit
    // the cache and NOT call fs.mkdirSync again. We spy on mkdirSync to verify.
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');

    SystemLogger.log(workspaceA, 'EVENT1', 'first');
    SystemLogger.log(workspaceA, 'EVENT2', 'second');
    SystemLogger.log(workspaceA, 'EVENT3', 'third');

    await flushAsyncWrites();

    // mkdirSync should be called at most once for this workspace's log dir
    const mkdirCallsForA = mkdirSpy.mock.calls.filter(
      (call) => call[0]?.toString().includes(workspaceA),
    );
    expect(mkdirCallsForA.length).toBeLessThanOrEqual(1);

    // All three messages should land in the same log file
    const content = readTodayLog(workspaceA);
    expect(content).toContain('first');
    expect(content).toContain('second');
    expect(content).toContain('third');

    mkdirSpy.mockRestore();
  });

  it('SL-03: disposeAllSystemLoggers clears cache; subsequent log() rebuilds path', async () => {
    // Verify that after disposing all caches, a subsequent log() call still
    // works correctly (rebuilds the cached log file path) and does NOT throw.
    // This mirrors the "date change invalidates cache" code path, since both
    // paths delete the cached log file entry and recompute on next log().
    SystemLogger.log(workspaceA, 'EVENT', 'before-dispose');

    await flushAsyncWrites();

    disposeAllSystemLoggers();

    SystemLogger.log(workspaceA, 'EVENT', 'after-dispose');

    await flushAsyncWrites();

    const content = readTodayLog(workspaceA);
    expect(content).toContain('before-dispose');
    expect(content).toContain('after-dispose');
  });

  it('SL-04: disposeSystemLogger clears cache for one workspace only', async () => {
    // disposeSystemLogger(workspaceA) must NOT affect workspace B's cache.
    // After disposing A, logging to A again should rebuild A's cache; B's
    // cache and log file must remain intact.
    SystemLogger.log(workspaceA, 'EVENT', 'from-A-1');
    SystemLogger.log(workspaceB, 'EVENT', 'from-B-1');

    await flushAsyncWrites();

    disposeSystemLogger(workspaceA);

    // Logging to A again should rebuild cache and write to the same file
    SystemLogger.log(workspaceA, 'EVENT', 'from-A-2');
    // Logging to B should still use B's existing cache
    SystemLogger.log(workspaceB, 'EVENT', 'from-B-2');

    await flushAsyncWrites();

    const contentA = readTodayLog(workspaceA);
    const contentB = readTodayLog(workspaceB);

    expect(contentA).toContain('from-A-1');
    expect(contentA).toContain('from-A-2');
    expect(contentA).not.toContain('from-B');

    expect(contentB).toContain('from-B-1');
    expect(contentB).toContain('from-B-2');
    expect(contentB).not.toContain('from-A');
  });
});
