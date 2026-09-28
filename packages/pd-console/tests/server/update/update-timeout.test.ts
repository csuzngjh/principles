import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApplyFullTimeoutMs, resolveCheckTimeoutMs } from '../../../src/server/update-timeout.js';

const CASES = [
  { label: 'apply-full', envKey: 'PD_UPDATE_APPLY_FULL_TIMEOUT_MS', defaultMs: 180000, resolve: resolveApplyFullTimeoutMs },
  { label: 'check', envKey: 'PD_UPDATE_CHECK_TIMEOUT_MS', defaultMs: 30000, resolve: resolveCheckTimeoutMs },
] as const;

// Covers the resolver contract for BOTH knobs. Which budget a route actually
// gets is chosen in src/server/index.ts, whose request handler is not exported
// and whose module runs main() on import (index.ts:354, :706) — so no committed
// guard pins that wiring for either knob; a testability seam is tracked in PRI-925.
describe.each(CASES)('$label request timeout configuration', ({ envKey, defaultMs, resolve }) => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, '', '   '])('defaults silently for %j', (raw) => {
    vi.stubEnv(envKey, raw);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolve()).toBe(defaultMs);
    expect(error).not.toHaveBeenCalled();
  });

  it.each(['abc', 'NaN', 'Infinity', '0', '-1', '-0x10', '1.5', '2147483648', '3000000000', '1e3', '0x10', '0b1000', '0o17', '+5', '30_000', '30 000'])(
    'rejects %s with an observable fallback', (raw) => {
      vi.stubEnv(envKey, raw);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(resolve()).toBe(defaultMs);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(envKey));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(raw));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(String(defaultMs)));
      // The accepted grammar is part of the contract: Number() alone would read
      // '0x10' as 16 and collapse the budget in the harmful direction.
      expect(error).toHaveBeenCalledWith(expect.stringContaining('plain decimal integer'));
    },
  );

  it.each([
    ['1', 1],
    ['600000', 600000],
    ['2147483647', 2147483647],
    ['  45000  ', 45000],
  ])('accepts %s unchanged', (raw, expected) => {
    vi.stubEnv(envKey, raw);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolve()).toBe(expected);
    expect(error).not.toHaveBeenCalled();
  });
});
