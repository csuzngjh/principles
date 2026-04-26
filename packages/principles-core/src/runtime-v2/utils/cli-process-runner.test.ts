/**
 * CliProcessRunner unit tests.
 *
 * Covers: success (exit 0), non-zero exit, timeout, and ENOENT cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCliProcess } from './cli-process-runner.js';

describe('runCliProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('success case (exit code 0)', () => {
    it('resolves with stdout, exitCode 0, timedOut false, durationMs >= 0', async () => {
      const result = await runCliProcess({
        command: 'node',
        args: ['-e', 'console.log("hello")'],
      });
      expect(result.stdout).toBe('hello\n');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('non-zero exit case', () => {
    it('captures non-zero exit code in result', async () => {
      const result = await runCliProcess({
        command: 'node',
        args: ['-e', 'process.exit(42)'],
      });
      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);
    });
  });

  describe('timeout case', () => {
    it('sets timedOut=true and exitCode=null when process is killed on timeout', async () => {
      const runPromise = runCliProcess({
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        timeoutMs: 100,
        killGracePeriodMs: 50,
      });

      // Advance time past the timeout threshold
      await vi.advanceTimersByTimeAsync(200);
      const result = await runPromise;

      expect(result.timedOut).toBe(true);
      // exitCode is null because the process was killed, not exited normally
      expect(result.exitCode).toBeNull();
    });
  });

  describe('ENOENT case (binary not found)', () => {
    it('resolves with exitCode null and empty stdout when command does not exist', async () => {
      const result = await runCliProcess({
        command: 'nonexistent-binary-xyz123',
      });
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe('');
    });
  });

  describe.skip('Windows command resolution', () => {
    it('on Windows, resolves openclaw to openclaw.cmd via where.exe', async () => {
      if (process.platform !== 'win32') {
        return;
      }
      const result = await runCliProcess({
        command: 'openclaw',
        args: ['--version'],
      });
      // Should succeed (not ENOENT) if Windows resolution works
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('OpenClaw');
    });

    it('on Windows, spawn uses resolved command path', async () => {
      if (process.platform !== 'win32') {
        return;
      }
      const result = await runCliProcess({
        command: 'node',
        args: ['--version'],
      });
      expect(result.exitCode).toBe(0);
    });

    it('on non-Windows, command is passed through unchanged', async () => {
      if (process.platform === 'win32') {
        return;
      }
      // On Unix, 'node' should work directly without where.exe resolution
      const result = await runCliProcess({
        command: 'node',
        args: ['--version'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('v');
    });
  });

  describe('validation', () => {
    it('throws TypeError when command is an empty string', async () => {
      await expect(
        runCliProcess({ command: '' }),
      ).rejects.toThrow(TypeError);
    });

    it('throws TypeError when command is whitespace-only', async () => {
      await expect(
        runCliProcess({ command: '   ' }),
      ).rejects.toThrow(TypeError);
    });

    it('throws TypeError when command is not a string', async () => {
      // @ts-expect-error — intentionally passing invalid type to test runtime validation
      await expect(runCliProcess({ command: 123 })).rejects.toThrow(TypeError);
    });
  });
});
