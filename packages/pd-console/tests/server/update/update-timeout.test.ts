import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApplyFullTimeoutMs, resolveCheckTimeoutMs } from '../../../src/server/update-timeout.js';

const CASES = [
  { label: 'apply-full', envKey: 'PD_UPDATE_APPLY_FULL_TIMEOUT_MS', defaultMs: 180000, resolve: resolveApplyFullTimeoutMs },
  { label: 'check', envKey: 'PD_UPDATE_CHECK_TIMEOUT_MS', defaultMs: 30000, resolve: resolveCheckTimeoutMs },
] as const;

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

  it.each(['abc', 'NaN', 'Infinity', '0', '-1', '1.5', '2147483648', '3000000000'])(
    'rejects %s with an observable fallback', (raw) => {
      vi.stubEnv(envKey, raw);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(resolve()).toBe(defaultMs);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(envKey));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(raw));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(String(defaultMs)));
    },
  );

  it.each([
    ['1', 1],
    ['600000', 600000],
    ['2147483647', 2147483647],
    ['1e3', 1000],
  ])('accepts %s unchanged', (raw, expected) => {
    vi.stubEnv(envKey, raw);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolve()).toBe(expected);
    expect(error).not.toHaveBeenCalled();
  });
});
