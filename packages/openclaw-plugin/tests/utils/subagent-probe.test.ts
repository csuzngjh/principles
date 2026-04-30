import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  getSubagentRuntimeAvailability,
  isSubagentRuntimeAvailable,
  getAvailableSubagentRuntime,
} from '../../src/utils/subagent-probe.js';

describe('subagent-probe', () => {
  it('treats any callable run entrypoint as available', () => {
    const runtime = {
      run() {
        return Promise.resolve({ runId: 'run-1' });
      },
    };

    expect(getSubagentRuntimeAvailability(runtime)).toEqual({
      available: true,
      reason: 'callable',
    });
    expect(isSubagentRuntimeAvailable(runtime)).toBe(true);
  });

  it('reports missing runtime and missing run distinctly', () => {
    expect(getSubagentRuntimeAvailability(undefined)).toEqual({
      available: false,
      reason: 'missing_runtime',
    });
    expect(getSubagentRuntimeAvailability({})).toEqual({
      available: false,
      reason: 'missing_run',
    });
  });
});

describe('getAvailableSubagentRuntime', () => {
  const validRuntime = { run: () => Promise.resolve({ runId: 'run-1' }) };

  it('returns the passed subagent when it is available', () => {
    expect(getAvailableSubagentRuntime(validRuntime)).toBe(validRuntime);
  });

  it('returns undefined when passed undefined and no global gateway exists', () => {
    expect(getAvailableSubagentRuntime(undefined)).toBeUndefined();
  });

  it('returns undefined when passed unavailable subagent and no global gateway', () => {
    expect(getAvailableSubagentRuntime({} as any)).toBeUndefined();
  });

  describe('with global gateway fallback', () => {
    const symbol = Symbol.for('openclaw.plugin.gatewaySubagentRuntime');

    beforeEach(() => {
      (globalThis as any)[symbol] = { subagent: validRuntime };
    });

    afterEach(() => {
      delete (globalThis as any)[symbol];
    });

    it('falls back to global gateway when passed subagent is unavailable', () => {
      expect(getAvailableSubagentRuntime(undefined)).toBe(validRuntime);
    });

    it('falls back to global gateway when passed subagent has no run', () => {
      expect(getAvailableSubagentRuntime({} as any)).toBe(validRuntime);
    });

    it('prefers passed subagent over global gateway when both available', () => {
      const localRuntime = { run: () => Promise.resolve({ runId: 'local' }) };
      expect(getAvailableSubagentRuntime(localRuntime)).toBe(localRuntime);
    });
  });
});
