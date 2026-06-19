/**
 * PRI-432: Tests for shared CLI output module.
 *
 * Extracts common output patterns from:
 *   - runtime-features.ts (JSON/text emit + exit code)
 *   - runtime-recovery.ts (dry-run/confirm conflict + JSON/text emit)
 *   - runtime-internalization-integrity-repair.ts (conflict + error catch + JSON/text emit)
 *
 * TDD flow: these tests are RED until cli-output.ts is implemented.
 *
 * ERR refs:
 * - ERR-001 (no any): all types explicit
 * - ERR-005 (no as bypass): no type casts
 * - ERR-009 (fail-loud): emitError returns exit code, does not swallow
 * - ERR-002 (graceful degradation with reason): all error paths include reason + nextAction
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { emitResult, emitFlagConflict, emitError } = await import('../cli-output.js');

describe('cli-output module (PRI-432)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  // ── emitResult ──────────────────────────────────────────────────────────

  describe('emitResult', () => {
    it('emits JSON to stdout when json=true', () => {
      const output = { status: 'ok', count: 5 };
      const formatText = (o: typeof output) => `Status: ${o.status}`;

      emitResult(output, { json: true, formatText });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const emitted = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(emitted).toEqual(output);
    });

    it('emits text to stdout when json=false', () => {
      const output = { status: 'ok', count: 5 };
      const formatText = (o: typeof output) => `Status: ${o.status}`;

      emitResult(output, { json: false, formatText });

      expect(consoleLogSpy).toHaveBeenCalledWith('Status: ok');
    });

    it('uses formatText callback for text output', () => {
      const output = { status: 'failed', reason: 'bad config' };
      const formatText = (o: typeof output) => `ERROR: ${o.reason}`;

      emitResult(output, { json: false, formatText });

      expect(consoleLogSpy).toHaveBeenCalledWith('ERROR: bad config');
    });
  });

  // ── emitFlagConflict ────────────────────────────────────────────────────

  describe('emitFlagConflict', () => {
    it('emits JSON error to stdout when json=true', () => {
      const exitCode = emitFlagConflict({ json: true });

      expect(exitCode).toBe(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const emitted = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(emitted.ok).toBe(false);
      expect(emitted.reason).toContain('mutually exclusive');
      expect(emitted.nextAction).toContain('--dry-run');
    });

    it('emits text error to stderr when json=false', () => {
      const exitCode = emitFlagConflict({ json: false });

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const msg = consoleErrorSpy.mock.calls[0][0] as string;
      expect(msg).toContain('mutually exclusive');
    });

    it('always returns exit code 1', () => {
      expect(emitFlagConflict({ json: true })).toBe(1);
      expect(emitFlagConflict({ json: false })).toBe(1);
    });
  });

  // ── emitError ───────────────────────────────────────────────────────────

  describe('emitError', () => {
    it('emits JSON error to stdout when json=true', () => {
      const err = new Error('DB connection failed');
      const exitCode = emitError(err, { json: true, nextAction: 'Check DB connectivity' });

      expect(exitCode).toBe(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const emitted = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(emitted.ok).toBe(false);
      expect(emitted.reason).toBe('DB connection failed');
      expect(emitted.nextAction).toBe('Check DB connectivity');
    });

    it('emits text error to stderr when json=false', () => {
      const err = new Error('DB connection failed');
      const exitCode = emitError(err, { json: false, nextAction: 'Check DB connectivity' });

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: DB connection failed');
    });

    it('handles non-Error throwables via String()', () => {
      const exitCode = emitError('string error', { json: true, nextAction: 'retry' });

      expect(exitCode).toBe(1);
      const emitted = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(emitted.reason).toBe('string error');
    });

    it('always returns exit code 1', () => {
      expect(emitError(new Error('x'), { json: true, nextAction: 'y' })).toBe(1);
      expect(emitError(new Error('x'), { json: false, nextAction: 'y' })).toBe(1);
    });
  });
});
